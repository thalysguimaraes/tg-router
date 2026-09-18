import { describe, expect, test } from 'bun:test';
import { PRIORITY_SWAP_RATIO, planPrioritySwap, applyPrioritySwap, steerAccounts, type Session } from './accounts';
import type { QuotaAccount, QuotaSnapshot } from './policy';

const account = (connectionId: string, priority: number, pressure: number, extra: Partial<QuotaAccount> = {}): QuotaAccount =>
  ({ connectionId, priority, state: 'healthy', pressure, locked: false, ...extra });

const snapshot = (accounts: QuotaAccount[]): QuotaSnapshot => ({ observedAt: 0, accounts });

describe('planPrioritySwap', () => {
  test('exported ratio', () => {
    expect(PRIORITY_SWAP_RATIO).toBe(2);
  });

  test('current already best → undefined', () => {
    expect(planPrioritySwap([account('a', 1, 0.032), account('b', 2, 0.0069)])).toBeUndefined();
  });

  test('best much cheaper → swap plan', () => {
    expect(planPrioritySwap([account('a', 1, 0.005), account('b', 2, 0.012)])).toEqual({
      promote: 'b', demote: 'a', from: 2, to: 1,
    });
  });

  test('ratio below threshold → undefined', () => {
    expect(planPrioritySwap([account('a', 1, 0.005), account('b', 2, 0.009)])).toBeUndefined();
  });

  test('locked best → undefined', () => {
    expect(planPrioritySwap([account('a', 1, 0.005), account('b', 2, 0.05, { locked: true })])).toBeUndefined();
  });

  test('depleted current still swappable', () => {
    expect(planPrioritySwap([account('a', 1, 0.005, { state: 'depleted' }), account('b', 2, 0.001)])).toEqual({
      promote: 'b', demote: 'a', from: 2, to: 1,
    });
  });
});

const recordingSession = (calls: Array<{ path: string; body: string }>, fail: boolean | 'second' = false): Session => ({
  request: async (path: string, init?: RequestInit) => {
    if (fail === true || (fail === 'second' && calls.length === 1)) throw new Error('boom');
    calls.push({ path, body: String(init?.body) });
    return {};
  },
});

/** Fake 9router: GET /api/providers reads priorities, PUT writes them. */
const serverSession = (priorities: Record<string, number>, calls: Array<{ path: string; body: string }> = [], failPut = false): Session => ({
  request: async (path: string, init?: RequestInit) => {
    if (path === '/api/providers') return Object.entries(priorities).map(([id, priority]) => ({ id, priority }));
    if (failPut) throw new Error('boom');
    calls.push({ path, body: String(init?.body) });
    priorities[decodeURIComponent(path.slice('/api/providers/'.length))] = JSON.parse(String(init?.body)).priority;
    return {};
  },
});

describe('applyPrioritySwap', () => {
  test('two PUTs, promote first', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const outcome = await applyPrioritySwap(recordingSession(calls), { promote: 'b', demote: 'a', from: 2, to: 1 });
    expect(outcome).toBe('applied');
    expect(calls).toEqual([
      { path: '/api/providers/b', body: '{"priority":1}' },
      { path: '/api/providers/a', body: '{"priority":2}' },
    ]);
  });

  test('a failed promote leaves nothing applied', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const outcome = await applyPrioritySwap(recordingSession(calls, true), { promote: 'b', demote: 'a', from: 2, to: 1 });
    expect(outcome).toBe('failed');
    expect(calls).toEqual([]);
  });

  test('a failed demote is reported as partial, not as a clean failure', async () => {
    // Both accounts now hold priority 1; the caller must be able to see that.
    const calls: Array<{ path: string; body: string }> = [];
    const outcome = await applyPrioritySwap(recordingSession(calls, 'second'), { promote: 'b', demote: 'a', from: 2, to: 1 });
    expect(outcome).toBe('partial');
    expect(calls.map(c => c.path)).toEqual(['/api/providers/b']);
  });

  test('priorities changed since the plan was made are not overwritten', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const outcome = await applyPrioritySwap(recordingSession(calls), { promote: 'b', demote: 'a', from: 2, to: 1 }, [
      { connectionId: 'a', priority: 1 },
      { connectionId: 'b', priority: 3 },
    ]);
    expect(outcome).toBe('stale');
    expect(calls).toEqual([]);
  });
});

describe('steerAccounts', () => {
  test('no plan → no session, no log', async () => {
    let logCount = 0;
    await steerAccounts({ provider: 'claude', snapshot: snapshot([account('a', 1, 0.032), account('b', 2, 0.0069)]), session: async () => { throw new Error('should not be called'); }, log: () => { logCount++; } });
    expect(logCount).toBe(0);
  });

  test('no session → skipped log', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    await steerAccounts({ provider: 'codex', snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]), session: async () => undefined, log: (event, data) => events.push({ event, data }) });
    expect(events).toEqual([{ event: 'account-priority-skipped', data: { provider: 'codex', reason: 'no-session' } }]);
  });

  test('plan applied → account-priority log with applied true, read, two PUTs, read-back', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const priorities = { a: 1, b: 2 };
    await steerAccounts({
      provider: 'opencode-go',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => serverSession(priorities, calls),
      log: (event, data) => events.push({ event, data }),
    });
    expect(calls.map((c) => c.path)).toEqual(['/api/providers/b', '/api/providers/a']);
    expect(priorities).toEqual({ a: 2, b: 1 });
    expect(events[0]?.event).toBe('account-priority');
    expect((events[0]?.data as { provider: string; from: string; to: string; applied: boolean }).provider).toBe('opencode-go');
    expect((events[0]?.data as { from: string }).from).toBe('a');
    expect((events[0]?.data as { to: string }).to).toBe('b');
    expect((events[0]?.data as { applied: boolean }).applied).toBe(true);
  });

  test('server priority changed after the snapshot → replanned on current values, never overwritten', async () => {
    // Snapshot says b=2; server already moved b to 3. The stale plan (from=2)
    // must not be written; the plan is recomputed against observed priorities.
    const calls: Array<{ path: string; body: string }> = [];
    const priorities = { a: 1, b: 3 };
    await steerAccounts({
      provider: 'claude',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => serverSession(priorities, calls),
      log: () => {},
    });
    expect(calls.map(c => JSON.parse(c.body).priority)).toEqual([1, 3]);
    expect(priorities).toEqual({ a: 3, b: 1 });
  });

  test('no observation → skipped, nothing written', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const calls: Array<{ path: string; body: string }> = [];
    await steerAccounts({
      provider: 'claude',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => recordingSession(calls, true),
      log: (event, data) => events.push({ event, data }),
    });
    expect(calls).toEqual([]);
    expect(events).toEqual([{ event: 'account-priority-skipped', data: { provider: 'claude', reason: 'no-observation' } }]);
  });

  test('failing PUT → applied false in log', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    await steerAccounts({
      provider: 'claude',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => serverSession({ a: 1, b: 2 }, [], true),
      log: (event, data) => events.push({ event, data }),
    });
    expect(events[0]?.event).toBe('account-priority');
    expect((events[0]?.data as { applied: boolean }).applied).toBe(false);
    expect((events[0]?.data as { outcome: string }).outcome).toBe('failed');
  });

  test('concurrent steering attempts are serialized, not interleaved', async () => {
    // Each session blocks on a gate the test opens, so ordering is observed
    // rather than timed: interleaving would show up as two starts in a row.
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const gatedSession = (label: string): Session => ({
      request: async (path: string) => {
        if (path === '/api/providers') return [{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }];
        order.push(`${label}-start`);
        const { promise, resolve } = Promise.withResolvers<void>();
        gates.push(resolve);
        await promise;
        order.push(`${label}-end`);
        return {};
      },
    });
    const snap = snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]);
    const both = Promise.all([
      steerAccounts({ provider: 'claude', snapshot: snap, session: async () => gatedSession('first'), log: () => {} }),
      steerAccounts({ provider: 'claude', snapshot: snap, session: async () => gatedSession('second'), log: () => {} }),
    ]);
    // Release gates as they appear; four PUTs total (two per swap).
    for (let released = 0; released < 4; released++) {
      while (!gates.length) await Promise.resolve();
      gates.shift()!();
      await Promise.resolve();
    }
    await both;
    expect(order.slice(0, 4)).toEqual(['first-start', 'first-end', 'first-start', 'first-end']);
  });
});
