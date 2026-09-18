import type { QuotaAccount, QuotaSnapshot } from './policy';

export const PRIORITY_SWAP_RATIO = 2;

/** Authenticated 9router request helper (cookie-bound), from nineRouterSession(). */
export interface Session {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}

export interface PrioritySwapPlan {
  promote: string;
  demote: string;
  /** Old priority of the promoted account before the swap. */
  from: number;
  /** New priority of the promoted account after the swap. */
  to: number;
}

/** Pure. Fill-first: promote only when another account has far more headroom,
 * or when the current priority-1 account cannot serve (locked or depleted). */
export function planPrioritySwap(accounts: QuotaAccount[]): PrioritySwapPlan | undefined {
  const best = accounts.filter((a) => !a.locked && a.state !== 'depleted' && a.pressure >= 0)
    .reduce<QuotaAccount | undefined>((max, a) => (!max || a.pressure > max.pressure ? a : max), undefined);
  // The account 9router will pick first, regardless of whether it can serve.
  const current = accounts.reduce<QuotaAccount | undefined>((min, a) => (!min || a.priority < min.priority ? a : min), undefined);
  if (!current || !best || best.connectionId === current.connectionId) return undefined;
  const unusable = current.locked || current.state === 'depleted' || current.pressure < 0;
  const swap = unusable || best.pressure > PRIORITY_SWAP_RATIO * current.pressure;
  if (!swap) return undefined;
  // Swap priority numbers: the promoted account takes the current priority-1 slot
  // (to) and demotes current to the promoted account's old priority (from).
  return { promote: best.connectionId, demote: current.connectionId, from: best.priority, to: current.priority };
}

/** Outcome of a swap attempt. `partial` means one account moved and the other did not. */
export type SwapOutcome = 'applied' | 'partial' | 'failed' | 'stale';

/** Priorities as 9router currently holds them, from a fresh GET /api/providers. */
export async function readPriorities(session: Session): Promise<Array<{ connectionId: string; priority: number }> | undefined> {
  try {
    const body: any = await session.request('/api/providers');
    const rows = Array.isArray(body) ? body : Array.isArray(body?.connections) ? body.connections : undefined;
    if (!rows) return undefined;
    return rows
      .filter((row: any) => row && (typeof row.id === 'string' || typeof row.id === 'number') && Number.isFinite(Number(row.priority)))
      .map((row: any) => ({ connectionId: String(row.id), priority: Number(row.priority) }));
  } catch {
    return undefined;
  }
}

/**
 * Thin executor. Two independent PUTs cannot be atomic, so the result must
 * distinguish "nothing happened" from "half happened": a failed demote leaves
 * both accounts on the same priority, which changes 9router's fill-first choice
 * in a way the caller has to see. `observed` must be an independent read taken
 * after the plan was made, so a concurrent external change is reported as
 * `stale` instead of overwritten. ponytail: no server-side conditional PUT, so
 * a writer racing between the read and the PUT can still win; the read-back
 * in steerAccounts reports that instead of claiming atomicity.
 */
export async function applyPrioritySwap(session: Session, plan: PrioritySwapPlan, observed?: Array<{ connectionId: string; priority: number }>): Promise<SwapOutcome> {
  if (observed) {
    const promote = observed.find(a => a.connectionId === plan.promote);
    const demote = observed.find(a => a.connectionId === plan.demote);
    if (!promote || !demote || promote.priority !== plan.from || demote.priority !== plan.to) return 'stale';
  }
  try {
    await session.request(`/api/providers/${encodeURIComponent(plan.promote)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: plan.to }),
    });
  } catch {
    return 'failed';
  }
  try {
    await session.request(`/api/providers/${encodeURIComponent(plan.demote)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: plan.from }),
    });
  } catch {
    // The promote landed: both accounts now hold `plan.to`. Report it; do not
    // blindly undo, since the promote may already be serving requests.
    return 'partial';
  }
  return 'applied';
}

/** Serializes this process's steering attempts: two concurrent local sessions must not race the same swap. */
let steering: Promise<unknown> = Promise.resolve();

export async function steerAccounts(opts: {
  provider: 'claude' | 'codex' | 'opencode-go';
  snapshot: QuotaSnapshot;
  session: () => Promise<Session | undefined>;
  log: (event: string, data: unknown) => void;
}): Promise<void> {
  const run = steering.then(async () => {
    const all = opts.snapshot.accounts ?? [];
    if (!planPrioritySwap(all)) return;
    const session = await opts.session();
    if (!session) {
      opts.log('account-priority-skipped', { provider: opts.provider, reason: 'no-session' });
      return;
    }
    // Independent observation inside the coordination boundary: replan on
    // current priorities, never on the snapshot the caller planned from.
    const observed = await readPriorities(session);
    if (!observed) {
      opts.log('account-priority-skipped', { provider: opts.provider, reason: 'no-observation' });
      return;
    }
    const current = all.map(a => ({ ...a, priority: observed.find(o => o.connectionId === a.connectionId)?.priority ?? a.priority }));
    const plan = planPrioritySwap(current);
    if (!plan) { opts.log('account-priority-skipped', { provider: opts.provider, reason: 'stale-plan' }); return; }
    let outcome = await applyPrioritySwap(session, plan, observed);
    if (outcome === 'applied' || outcome === 'partial') {
      const after = await readPriorities(session);
      const landed = after?.find(a => a.connectionId === plan.promote)?.priority === plan.to
        && after?.find(a => a.connectionId === plan.demote)?.priority === plan.from;
      if (!landed) outcome = after ? 'partial' : 'failed';
    }
    opts.log('account-priority', {
      provider: opts.provider,
      from: plan.demote,
      to: plan.promote,
      pressures: {
        [plan.demote]: all.find((a) => a.connectionId === plan.demote)?.pressure,
        [plan.promote]: all.find((a) => a.connectionId === plan.promote)?.pressure,
      },
      outcome,
      applied: outcome === 'applied',
    });
  });
  steering = run.catch(() => {});
  return run;
}
