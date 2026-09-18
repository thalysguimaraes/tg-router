import { describe, expect, test } from 'bun:test';
import { BudgetLedger } from './budget';
import { buildRoutingContext, redactText, assessmentCacheKey } from './routing-context';
import { AssessmentCache, cacheKeyFor, type TaskAssessment } from './assessment-cache';
import type { JevResult } from './jev-client';
import type { RoutingContext } from './routing-context';
import { readFileSync } from 'node:fs';

const NOW = Date.UTC(2026, 8, 17, 12);

describe('purpose-scoped ledger subcaps', () => {
  const fresh = () => new BudgetLedger(':memory:', { dailyCapUsd: 10, monthlyCapUsd: 30 });

  test('classifier reserve inside subcaps succeeds and counts toward global caps', () => {
    const ledger = fresh();
    const first = ledger.reserve('c1', 0.05, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    expect(first.ok).toBe(true);
    const second = ledger.reserve('c2', 0.05, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    expect(second.ok).toBe(true);
    const third = ledger.reserve('c3', 0.01, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('daily-cap');
    const snapshot = ledger.snapshot(NOW);
    expect(snapshot.dailyCommittedUsd).toBeCloseTo(0.10);
    ledger.close();
  });

  test('subcap rejection does not leak into execution purpose capacity', () => {
    const ledger = fresh();
    for (const id of ['c1', 'c2']) {
      ledger.reserve(id, 0.05, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    }
    const execution = ledger.reserve('e1', 2.0, NOW);
    expect(execution.ok).toBe(true);
    ledger.close();
  });

  test('global cap still bounds classifier spend inside subcaps', () => {
    const ledger = fresh();
    const result = ledger.reserve('big', 5.0, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 10, monthlyCapUsd: 10 } });
    expect(result.ok).toBe(true);
    const next = ledger.reserve('big2', 5.01, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 10, monthlyCapUsd: 10 } });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toBe('daily-cap');
    ledger.close();
  });

  test('settled classifier actual cost replenishes subcap only by released liability', () => {
    const ledger = fresh();
    ledger.reserve('c1', 0.10, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    ledger.markDispatched('c1', NOW);
    const blocked = ledger.reserve('c2', 0.01, NOW, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    expect(blocked.ok).toBe(false);
    ledger.settle('c1', 0.002, NOW + 1000);
    const after = ledger.reserve('c2', 0.09, NOW + 2000, { purpose: 'classifier', subcaps: { dailyCapUsd: 0.10, monthlyCapUsd: 1.00 } });
    expect(after.ok).toBe(true);
    ledger.close();
  });
});

describe('routing context redaction and bounding', () => {
  test('secrets, keys, and home paths are redacted', () => {
    const text = redactText('use api_key: sk-abc123def456ghi789 with token "hunter2" at /Users/guimaraes/secrets/prod.env');
    expect(text).not.toContain('sk-abc123def456ghi789');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('/Users/guimaraes');
    expect(text).toContain('[PATH]');
  });

  test('oversized context is truncated and marked', () => {
    const context = buildRoutingContext({
      taskGoal: 'x'.repeat(60_000),
      currentUserRequest: 'do the thing',
      boundary: 'user',
      hasImages: false,
      toolsRequired: true,
      confirmedQualityFailures: 0,
    });
    expect(context.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(24_576);
  });

  test('small clean context is not marked truncated', () => {
    const context = buildRoutingContext({
      taskGoal: 'alphabetize exports',
      currentUserRequest: 'alphabetize the exports in src/index.ts',
      boundary: 'user',
      hasImages: false,
      toolsRequired: false,
      confirmedQualityFailures: 0,
    });
    expect(context.truncated).toBe(false);
  });
});

describe('assessment cache', () => {
  const baseAssessment: TaskAssessment = {
    source: 'jev',
    schemaVersion: 1 as const,
    questionSetVersion: 'jev-questions-1',
    inputHmac: 'h',
    evaluatedAt: 0,
    phase: { selected: 'implementation', probabilities: { implementation: 1 } },
    tier: { selected: 'bounded', probabilities: { bounded: 0.9 } },
    boundedProbability: 0.9,
    highImpactProbability: 0.1,
    underspecifiedProbability: 0.05,
    reasoningDepth: { score: 2, probabilities: { '0': 0.1, '1': 0.2, '2': 0.4, '3': 0.2, '4': 0.1 } },
    jobFamily: { selected: 'implementation' },
    truncated: false,
    usable: true,
  };

  test('usable entries honor TTL; failed entries expire quickly', () => {
    const cache = new AssessmentCache(1000);
    cache.put('k', { ...baseAssessment }, 0);
    expect(cache.get('k', 900)).toBeDefined();
    expect(cache.get('k', 1001)).toBeUndefined();
    cache.put('bad', { ...baseAssessment, usable: false, unusableReason: 'transport' }, 0);
    expect(cache.get('bad', 29_999)).toBeDefined();
    expect(cache.get('bad', 30_001)).toBeUndefined();
  });

  test('cache hits are re-sourced as cache', () => {
    const cache = new AssessmentCache(1000);
    cache.put('k', { ...baseAssessment }, 0);
    expect(cache.get('k', 1)?.source).toBe('cache');
  });

  test('dedupe collapses concurrent identical assessments', async () => {
    const cache = new AssessmentCache();
    let calls = 0;
    const run = () => cache.dedupe('same', () => (async () => { calls++; return { ...baseAssessment }; })());
    await Promise.all([run(), run(), run()]);
    expect(calls).toBe(1);
  });
  test('epoch and quality failures invalidate the cache key', () => {
    const state: RoutingContext = buildRoutingContext({
      taskGoal: 't', currentUserRequest: 'r', boundary: 'user',
      hasImages: false, toolsRequired: true, confirmedQualityFailures: 0,
    });
    const key = (failures: number, epoch: string) => cacheKeyFor(
      { ...state, observations: { ...state.observations, confirmedQualityFailures: failures } },
      assessmentCacheKey({ state, schemaVersion: 1, questionSetVersion: 'q1', classifierModel: 'm', hmacKey: 'k' }),
      'q1', 'm', epoch,
    );
    expect(key(0, 'e1')).not.toBe(key(1, 'e1'));
    expect(key(0, 'e1')).not.toBe(key(0, 'e2'));
  });
});

describe('classifier load safety', () => {
  // Regression: a static `ai` SDK import made the optional, default-off
  // classifier a load-time dependency. When its `zod` peer failed to resolve,
  // the whole extension aborted and every 9Router model vanished from new
  // sessions. The native client talks HTTP directly and has no such dep.
  test('jev-client declares no third-party runtime dependency', () => {
    const source = readFileSync(new URL('./jev-client.ts', import.meta.url), 'utf8');
    const externalImports = source
      .split('\n')
      .filter(line => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line))
      .filter(line => !/from\s+'\.\//.test(line));
    expect(externalImports).toEqual([]);
  });

  test('classifier posts to the documented native endpoint', () => {
    const source = readFileSync(new URL('./jev-client.ts', import.meta.url), 'utf8');
    expect(source).toContain('https://api.typesafe.ai/v1/systemone');
  });

  test('a missing key disables the classifier without any request', async () => {
    const { createJevClient } = await import('./jev-client');
    let calls = 0;
    const client = createJevClient({
      deadlineMs: 50,
      inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch,
    });
    const state = buildRoutingContext({
      taskGoal: 'x', currentUserRequest: 'y', boundary: 'user',
      hasImages: false, toolsRequired: false, confirmedQualityFailures: 0,
    });
    const result = await client.assess(state, 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-key');
    expect(calls).toBe(0);
  });

  test('the key is resolved per call so a later export is picked up', async () => {
    const { createJevClient } = await import('./jev-client');
    let key: string | undefined;
    const client = createJevClient({
      deadlineMs: 50,
      apiKey: () => key,
      inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    });
    const state = buildRoutingContext({
      taskGoal: 'x', currentUserRequest: 'y', boundary: 'user',
      hasImages: false, toolsRequired: false, confirmedQualityFailures: 0,
    });
    const before = await client.assess(state, 'hmac');
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.reason).toBe('no-key');
    key = 'apikey_now-present';
    const after = await client.assess(state, 'hmac');
    // Key accepted: it got as far as parsing the (deliberately bad) response.
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('invalid-schema');
  });

  test('budget refusal prevents any classifier dispatch', async () => {
    const { createJevClient } = await import('./jev-client');
    let admitCalls = 0;
    const client = createJevClient({
      deadlineMs: 50,
      apiKey: 'k',
      inputUsdPerMillion: 0.042,
      admit: () => { admitCalls++; return { ok: false, reason: 'daily-cap' }; },
    });
    const state = buildRoutingContext({
      taskGoal: 'x', currentUserRequest: 'y', boundary: 'user',
      hasImages: false, toolsRequired: false, confirmedQualityFailures: 0,
    });
    const result = await client.assess(state, 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('budget');
      expect(result.detail).toBe('daily-cap');
    }
    expect(admitCalls).toBe(1);
  });

  test('a missing rate card disables the classifier before admission', async () => {
    const { createJevClient } = await import('./jev-client');
    let admitCalls = 0;
    const client = createJevClient({
      deadlineMs: 50,
      apiKey: 'k',
      admit: () => { admitCalls++; return { ok: true }; },
    });
    const state = buildRoutingContext({
      taskGoal: 'x', currentUserRequest: 'y', boundary: 'user',
      hasImages: false, toolsRequired: false, confirmedQualityFailures: 0,
    });
    const result = await client.assess(state, 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-rate-card');
    expect(admitCalls).toBe(0);
  });
});

describe('native TypeSafe protocol', () => {
  // Shapes below mirror a real recorded response from POST /v1/systemone
  // (jev-1.13.0): noul answers carry `noul`, choice/score carry inline
  // `confidence`, and usage uses snake_case `input_tokens`.
  const nativeAnswers = () => ({
    phase: { type: 'choice', choice: 'implementation', confidence: 0.71, probabilities: { lightweight: 0.02, implementation: 0.7, review: 0.03, investigation: 0.1, planning: 0.1, unknown: 0.05 } },
    capability: { type: 'choice', choice: 'bounded', confidence: 0.88, probabilities: { mechanical: 0.05, bounded: 0.93, execution: 0.01, complex: 0.005, premium: 0.003, unknown: 0.002 } },
    bounded: { type: 'noul', noul: 0.95 },
    highImpact: { type: 'noul', noul: 0.03 },
    underspecified: { type: 'noul', noul: 0.02 },
    reasoningDepth: { type: 'score', score: 1.33, confidence: 0.6, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: { '0': 0.1, '1': 0.6, '2': 0.2, '3': 0.07, '4': 0.03 } },
    jobFamily: { type: 'choice', choice: 'implementation', confidence: 0.9, probabilities: { clerical: 0.05, implementation: 0.9, review: 0.01, architecture: 0.01, investigation: 0.01, visual: 0.01, other: 0.01 } },
  });

  const state = () => buildRoutingContext({
    taskGoal: 'add the helper described in the contract',
    currentUserRequest: 'add the helper',
    boundary: 'user', hasImages: false, toolsRequired: true, confirmedQualityFailures: 0,
  });

  test('sends the documented request shape and normalizes a native response', async () => {
    const { createJevClient } = await import('./jev-client');
    let seenUrl = ''; let seenAuth = ''; let seenBody: Record<string, unknown> = {};
    const client = createJevClient({
      deadlineMs: 500, apiKey: 'apikey_test', inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenAuth = String((init.headers as Record<string, string>).authorization);
        seenBody = JSON.parse(String(init.body));
        return Response.json({ model: 'jev-1.13.0', answers: nativeAnswers(), usage: { input_tokens: 475, output_tokens: 85 } });
      }) as unknown as typeof fetch,
    });
    const result = await client.assess(state(), 'hmac');
    expect(seenUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seenAuth).toBe('Bearer apikey_test');
    expect(seenBody.model).toBe('jev-latest');
    expect(Object.keys(seenBody.questions as object).sort()).toEqual(
      ['bounded', 'capability', 'highImpact', 'jobFamily', 'phase', 'reasoningDepth', 'underspecified'],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const a = result.assessment;
      expect(a.tier.selected).toBe('bounded');
      expect(a.tier.confidence).toBe(0.88);
      expect(a.phase.selected).toBe('implementation');
      expect(a.highImpactProbability).toBe(0.03);
      expect(a.boundedProbability).toBe(0.95);
      expect(a.reasoningDepth.score).toBe(1.33);
      expect(a.classifierInputTokens).toBe(475);
      // An alias can move; record which version actually answered.
      expect(a.resolvedModel).toBe('jev-1.13.0');
      expect(a.usable).toBe(true);
    }
  });

  test('a gateway-shaped boolean answer is rejected, not silently accepted', async () => {
    const { createJevClient } = await import('./jev-client');
    const answers = { ...nativeAnswers(), highImpact: { type: 'boolean', probability: 0.03 } };
    const client = createJevClient({
      deadlineMs: 500, apiKey: 'k', inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async () => Response.json({ model: 'jev-1.13.0', answers })) as unknown as typeof fetch,
    });
    const result = await client.assess(state(), 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-schema');
  });

  test('a choice whose selection is not the argmax is rejected', async () => {
    const { createJevClient } = await import('./jev-client');
    const answers = nativeAnswers();
    answers.capability = { type: 'choice', choice: 'mechanical', confidence: 0.9, probabilities: { mechanical: 0.05, bounded: 0.93, execution: 0.01, complex: 0.005, premium: 0.003, unknown: 0.002 } };
    const client = createJevClient({
      deadlineMs: 500, apiKey: 'k', inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async () => Response.json({ model: 'jev-1.13.0', answers })) as unknown as typeof fetch,
    });
    const result = await client.assess(state(), 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-schema');
  });

  test('documented HTTP failures map to distinct typed reasons', async () => {
    const { createJevClient } = await import('./jev-client');
    const cases: Array<[number, Extract<JevResult, { ok: false }>['reason']]> = [[401, 'auth'], [422, 'invalid-request'], [429, 'rate-limited'], [529, 'overloaded'], [500, 'transport']];
    for (const [status, expected] of cases) {
      const client = createJevClient({
        deadlineMs: 500, apiKey: 'k', inputUsdPerMillion: 0.042,
        admit: () => ({ ok: true }),
        fetchImpl: (async () => new Response('{"error":"x"}', { status, headers: status === 429 ? { 'retry-after': '7' } : undefined })) as unknown as typeof fetch,
      });
      const result = await client.assess(state(), 'hmac');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(expected);
        if (status === 429) expect(result.retryAfterSeconds).toBe(7);
      }
    }
  });

  test('rate limiting is never reported as a model quality failure', async () => {
    const { createJevClient } = await import('./jev-client');
    const client = createJevClient({
      deadlineMs: 500, apiKey: 'k', inputUsdPerMillion: 0.042,
      admit: () => ({ ok: true }),
      fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
    });
    const result = await client.assess(state(), 'hmac');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe('invalid-schema');
  });
});

describe('downgrade guards calibrated against observed jev-1.13 output', () => {
  // Probabilities below are real values recorded from api.typesafe.ai on
  // 2026-09-17 with the shipped question set, not invented figures.
  const assess = (overrides: Record<string, unknown> = {}) => ({
    usable: true,
    tier: { selected: 'bounded', probabilities: { bounded: 0.95, mechanical: 0.04, execution: 0.01 }, confidence: 0.92 },
    phase: { selected: 'implementation' },
    highImpactProbability: 0.03,
    underspecifiedProbability: 0.1,
    truncated: false,
    ...overrides,
  });
  const call = async (assessment: Record<string, unknown>, rules: { tier: string; phase: string }) => {
    const { resolveClassification } = await import('./policy');
    return resolveClassification({
      assessment: assessment as never,
      rulesClassification: rules as never,
      mode: 'calibrated',
    });
  };

  test('review of consequential work never downgrades, even below the 0.5 impact gate', async () => {
    // Observed: payment double-charge review => highImpact 0.30, because a
    // review does not itself move money. Must still not be downgraded.
    const result = await call(
      assess({ phase: { selected: 'review' }, highImpactProbability: 0.30, underspecifiedProbability: 0.1 }),
      { tier: 'execution', phase: 'review' },
    );
    expect(result.tier).toBe('execution');
    expect(result.source).toBe('rules');
    expect(result.reason).toContain('review work never downgrades');
  });

  test('a real mutation is blocked decisively by the impact gate', async () => {
    // Observed: deleting production rows => 0.98; live key rotation => 0.94.
    const result = await call(
      assess({ highImpactProbability: 0.98 }),
      { tier: 'execution', phase: 'implementation' },
    );
    expect(result.tier).toBe('execution');
    expect(result.reason).toContain('high-impact');
  });

  test('documentation about a risky topic is allowed to downgrade', async () => {
    // Observed: README typo about authentication => highImpact 0.03,
    // tier mechanical, confidence 0.90. This is the keyword false positive
    // the semantic router exists to correct.
    const result = await call(
      assess({
        tier: { selected: 'mechanical', probabilities: { mechanical: 0.99, bounded: 0.01 }, confidence: 0.90 },
        phase: { selected: 'lightweight' },
        highImpactProbability: 0.03,
        underspecifiedProbability: 0.2,
      }),
      { tier: 'complex', phase: 'investigation' },
    );
    expect(result.tier).toBe('mechanical');
    expect(result.source).toBe('semantic-downgrade');
  });
  test('even a low-impact review keeps the rules tier, honoring the review restriction', async () => {
    const result = await call(
      assess({ phase: { selected: 'review' }, highImpactProbability: 0.05 }),
      { tier: 'execution', phase: 'review' },
    );
    // Automatic review routing is Fable/Astra only; a downgrade here would
    // hand review work to a model that is not approved for it.
    expect(result.tier).toBe('execution');
    expect(result.source).toBe('rules');
  });
});
