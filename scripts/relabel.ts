// Relabel the session corpus by OUTCOME, not by which model was chosen.
//
// The first calibration compared Jev against "you used a cheap model here" and
// found no separation. That label was wrong: cheap models in the corpus did
// the same work worse (2x tool calls, 3x error turns), so having picked one
// was never evidence that cheap was enough. A cheap turn is only evidence of
// sufficiency when the model FINISHED CLEANLY in a normal amount of work.
//
// Labels (mutually exclusive, everything else is unlabelled):
//   cheap-clean       cheap model, no errors, no model switch afterwards,
//                     tool calls <= premium p75 (37). Cheap was sufficient.
//   cheap-struggled   cheap model, but errored / was switched away from / or
//                     needed > premium p90 (68) tool calls. Cheap was NOT
//                     sufficient; this is under-routing evidence.
//   premium-clean     premium model, no errors, finished. Cannot tell whether
//                     cheap would have done; do not treat as premium-required.
//
// Writes label into each corpus row in place (field `outcome`).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
const file = join(root, 'session-corpus.jsonl');

interface Row {
  modelAnswered: string; toolCalls: number; errorTurns: number; userSwitchedModelAfter: boolean;
  lastStop?: string; continuation: boolean; child: boolean; outcome?: string;
}
const rows: Row[] = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const CHEAP = /glm|deepseek|luna/;
const PREMIUM = /fable|opus|astra/;
// Measured from the premium class itself: p75 = 37, p90 = 68 tool calls.
const NORMAL_WORK = 37;
const HEAVY_WORK = 68;

const counts: Record<string, number> = {};
for (const r of rows) {
  delete r.outcome;
  if (r.continuation || r.child) continue;
  const clean = r.errorTurns === 0 && !r.userSwitchedModelAfter && r.lastStop !== 'error';
  if (CHEAP.test(r.modelAnswered)) {
    r.outcome = clean && r.toolCalls <= NORMAL_WORK ? 'cheap-clean'
      : (!clean || r.toolCalls > HEAVY_WORK) ? 'cheap-struggled'
      : undefined;
  } else if (PREMIUM.test(r.modelAnswered) && clean) {
    r.outcome = 'premium-clean';
  }
  if (r.outcome) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
}
writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify(counts));
