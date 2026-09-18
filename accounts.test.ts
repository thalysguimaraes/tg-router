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

const recordingSession = (calls: Array<{ path: string; body: string }>, fail = false): Session => ({
  request: async (path: string, init?: RequestInit) => {
    if (fail) throw new Error('boom');
    calls.push({ path, body: String(init?.body) });
    return {};
  },
});

describe('applyPrioritySwap', () => {
  test('two PUTs, promote first', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const ok = await applyPrioritySwap(recordingSession(calls), { promote: 'b', demote: 'a', from: 2, to: 1 });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { path: '/api/providers/b', body: '{"priority":1}' },
      { path: '/api/providers/a', body: '{"priority":2}' },
    ]);
  });

  test('request failure → applied false', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const ok = await applyPrioritySwap(recordingSession(calls, true), { promote: 'b', demote: 'a', from: 2, to: 1 });
    expect(ok).toBe(false);
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

  test('plan applied → account-priority log with applied true, two PUTs', async () => {
    const calls: Array<{ path: string; body: string }> = [];
    const events: Array<{ event: string; data: unknown }> = [];
    await steerAccounts({
      provider: 'opencode-go',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => recordingSession(calls),
      log: (event, data) => events.push({ event, data }),
    });
    expect(calls.map((c) => c.path)).toEqual(['/api/providers/b', '/api/providers/a']);
    expect(events[0]?.event).toBe('account-priority');
    expect((events[0]?.data as { provider: string; from: string; to: string; applied: boolean }).provider).toBe('opencode-go');
    expect((events[0]?.data as { from: string }).from).toBe('a');
    expect((events[0]?.data as { to: string }).to).toBe('b');
    expect((events[0]?.data as { applied: boolean }).applied).toBe(true);
  });

  test('failing request → applied false in log', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    await steerAccounts({
      provider: 'claude',
      snapshot: snapshot([account('a', 1, 0.005), account('b', 2, 0.012)]),
      session: async () => recordingSession([], true),
      log: (event, data) => events.push({ event, data }),
    });
    expect(events[0]?.event).toBe('account-priority');
    expect((events[0]?.data as { applied: boolean }).applied).toBe(false);
  });
});
