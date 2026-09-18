// Derive downgrade gates from real sessions instead of guessing them.
//
// Ground truth: turns where you deliberately used a cheap worker model are
// labelled "a cheap model was sufficient"; turns on a premium model where the
// rules ALSO said premium are labelled "premium was warranted". Jev scores
// both sets, and we report the separation its distribution actually achieves.
//
//   bun run calibrate            # 80 turns per class
//   bun run calibrate 200        # bigger sample (costs ~$0.00005/turn)
//
// Writes ~/.omp/agent/personal-router/calibration.json
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildRoutingContext } from '../routing-context';
import { JEV_QUESTIONS } from '../jev-questions';
import { decideRoute, MODELS, type RouteModel } from '../policy';

const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
mkdirSync(root, { recursive: true, mode: 0o700 });
const perClass = Number(process.argv[2] ?? 80);

const key = process.env.TYPESAFE_API_KEY
  ?? execSync('op item get "AgentKit - Typesafe" --vault Personal --fields password --reveal').toString().trim();

interface Row { prompt: string; modelAnswered: string; continuation: boolean; child: boolean; promptLen: number }
const rows: Row[] = readFileSync(join(root, 'session-corpus.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

const CHEAP = new Set<string>([
  MODELS.deepseek, MODELS.glm, MODELS.luna,
  'openrouter/z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash',
]);
const PREMIUM = new Set<string>([MODELS.astra, MODELS.opus, MODELS.fable, 'anthropic/claude-fable-5']);

const model = (ref: string): RouteModel => ({
  ref, canonicalRef: ref, authenticated: true, contextWindow: 1_000_000,
  supportsTools: true, supportsImages: true, validated: { tools: true, vision: true, reasoning: true },
  quota: { observedAt: Date.now(), state: 'healthy', windows: [] },
});
const roster = Object.values(MODELS).map(model);

// Only turns with enough text to be a task at all, and never continuations.
const usable = rows.filter(r => !r.continuation && !r.child && r.promptLen >= 40);
const sample = <T,>(list: T[], n: number): T[] => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy.slice(0, n);
};

// "cheapWasEnough": you chose a worker. "premiumWarranted": you chose premium
// AND the deterministic rules independently agreed it was complex/premium.
const cheapWasEnough = sample(usable.filter(r => CHEAP.has(r.modelAnswered)), perClass);
const premiumWarranted = sample(usable.filter(r => {
  if (!PREMIUM.has(r.modelAnswered)) return false;
  const tier = decideRoute({ prompt: r.prompt, now: Date.now(), models: roster, contextTokens: 10_000, needsTools: true, boundary: 'user' }).tier;
  return tier === 'complex' || tier === 'premium';
}), perClass);

console.log(`scoring ${cheapWasEnough.length} cheap-sufficient and ${premiumWarranted.length} premium-warranted turns`);

interface Scored { label: 'cheap' | 'premium'; tier: string; confidence: number; topP: number; higherMass: number; highImpact: number; underspecified: number; prompt: string }

async function score(row: Row, label: Scored['label']): Promise<Scored | undefined> {
  const state = buildRoutingContext({
    taskGoal: row.prompt.slice(0, 2000), currentUserRequest: row.prompt,
    boundary: 'user', hasImages: false, toolsRequired: true, confirmedQualityFailures: 0,
  });
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions: JEV_QUESTIONS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }> };
    const cap = body.answers?.capability;
    if (!cap?.choice || !cap.probabilities) return undefined;
    const ORDER = ['mechanical', 'bounded', 'execution', 'complex', 'premium'];
    const rank = ORDER.indexOf(cap.choice);
    const higherMass = rank < 0 ? 1 : ORDER.slice(rank + 1).reduce((sum, t) => sum + (cap.probabilities![t] ?? 0), 0);
    return {
      label, tier: cap.choice, confidence: cap.confidence ?? 0,
      topP: cap.probabilities[cap.choice] ?? 0, higherMass,
      highImpact: body.answers?.highImpact?.noul ?? 0,
      underspecified: body.answers?.underspecified?.noul ?? 0,
      prompt: row.prompt.slice(0, 80).replace(/\s+/g, ' '),
    };
  } catch { return undefined; }
}

// Bounded concurrency: Jev's rate limit is generous but be polite.
const scored: Scored[] = [];
const queue: Array<[Row, Scored['label']]> = [
  ...cheapWasEnough.map(r => [r, 'cheap'] as [Row, Scored['label']]),
  ...premiumWarranted.map(r => [r, 'premium'] as [Row, Scored['label']]),
];
const workers = Array.from({ length: 6 }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const result = await score(next[0], next[1]);
    if (result) scored.push(result);
  }
});
await Promise.all(workers);

const cheap = scored.filter(s => s.label === 'cheap');
const premium = scored.filter(s => s.label === 'premium');
const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a';
const CHEAP_TIERS = new Set(['mechanical', 'bounded']);

console.log(`\nscored ${scored.length} turns (${cheap.length} cheap, ${premium.length} premium)`);
console.log('\n=== Does Jev put cheap-sufficient work in a cheap tier?');
console.log(`  cheap-sufficient judged mechanical/bounded: ${pct(cheap.filter(s => CHEAP_TIERS.has(s.tier)).length, cheap.length)}`);
console.log(`  premium-warranted judged mechanical/bounded: ${pct(premium.filter(s => CHEAP_TIERS.has(s.tier)).length, premium.length)}  <- must stay low`);

// A gate is only useful if it admits cheap work while excluding premium work.
console.log('\n=== Gate sweep: of turns Jev calls mechanical/bounded, how many pass?');
console.log('  higherMass  conf   admits cheap   admits premium (false downgrades)');
for (const mass of [0.01, 0.05, 0.10, 0.20, 0.35, 1.0]) {
  for (const conf of [0.5, 0.6, 0.7, 0.8]) {
    const passes = (s: Scored) => CHEAP_TIERS.has(s.tier) && s.higherMass <= mass && s.confidence >= conf && s.highImpact < 0.5 && s.underspecified < 0.5;
    const c = cheap.filter(passes).length, p = premium.filter(passes).length;
    if (c === 0 && p === 0) continue;
    console.log(`  ${String(mass).padEnd(11)} ${String(conf).padEnd(6)} ${String(c).padStart(3)}/${cheap.length} (${pct(c, cheap.length).padStart(4)})   ${String(p).padStart(3)}/${premium.length} (${pct(p, premium.length)})`);
  }
}

const falseDowngrades = premium.filter(s => CHEAP_TIERS.has(s.tier));
if (falseDowngrades.length) {
  console.log('\n=== Premium-warranted turns Jev judged cheap (inspect these):');
  for (const s of falseDowngrades.slice(0, 8)) console.log(`  ${s.tier}/${s.confidence.toFixed(2)} mass=${s.higherMass.toFixed(3)} | ${s.prompt}`);
}

const out = join(root, 'calibration.json');
writeFileSync(out, JSON.stringify({ calibratedAt: new Date().toISOString(), perClass, scored }, null, 2) + '\n', { mode: 0o600 });
console.log(`\nraw scores: ${out}`);
