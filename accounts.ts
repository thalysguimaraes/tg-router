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

/** Thin executor. Promote first; any non-2xx or throw marks the whole swap failed. */
export async function applyPrioritySwap(session: Session, plan: PrioritySwapPlan): Promise<boolean> {
  try {
    await session.request(`/api/providers/${encodeURIComponent(plan.promote)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: plan.to }),
    });
    await session.request(`/api/providers/${encodeURIComponent(plan.demote)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: plan.from }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function steerAccounts(opts: {
  provider: 'claude' | 'codex' | 'opencode-go';
  snapshot: QuotaSnapshot;
  session: () => Promise<Session | undefined>;
  log: (event: string, data: unknown) => void;
}): Promise<void> {
  const plan = planPrioritySwap(opts.snapshot.accounts ?? []);
  if (!plan) return;
  const session = await opts.session();
  if (!session) {
    opts.log('account-priority-skipped', { provider: opts.provider, reason: 'no-session' });
    return;
  }
  const all = opts.snapshot.accounts ?? [];
  const applied = await applyPrioritySwap(session, plan);
  opts.log('account-priority', {
    provider: opts.provider,
    from: plan.demote,
    to: plan.promote,
    pressures: {
      [plan.demote]: all.find((a) => a.connectionId === plan.demote)?.pressure,
      [plan.promote]: all.find((a) => a.connectionId === plan.promote)?.pressure,
    },
    applied,
  });
}
