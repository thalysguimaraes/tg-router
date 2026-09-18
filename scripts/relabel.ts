// Relabel the session corpus by verified OUTCOME, not by which model was chosen.
//
// The first calibration compared Jev against "you used a cheap model here" and
// found no separation. That label was wrong: cheap models in the corpus did the
// same work worse (2x tool calls, 3x error turns), so having picked one was
// never evidence that cheap was enough.
//
// The second version fixed the class but kept a weak definition of success: a
// missing or aborted terminal state counted as clean as long as it was not
// literally `error`, and tool-call volume was read as correctness. Effort is
// not correctness, and "did not crash" is not "was accepted".
//
// Four mutually exclusive outcomes:
//
//   accepted        the task finished (`stop`) AND the next user turn accepts
//                   it or moves on to different work. The strongest in-session
//                   acceptance evidence that exists.
//   quality-failed  the task finished, but the next user turn sends it back
//                   (a correction, a complaint, a repeat of the same ask), or
//                   the user manually switched model right after. Attributable
//                   to the generated work.
//   infra-failed    a provider/transport error turn, or an automatic fallback.
//                   Says nothing about model quality and must never train it.
//   interrupted     aborted, cancelled, truncated, or no terminal state, or the
//                   task is the last turn of the session so no acceptance
//                   evidence exists. NOT a success and NOT a failure.
//
// `effort` (tool calls, assistant turns, models used) is recorded alongside the
// outcome and never substituted for it.
//
// Writes `outcome` and `effort` into each corpus row in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'), 'personal-router');
const file = join(root, 'session-corpus.jsonl');

interface Row {
  modelAnswered: string;
  modelsUsed?: string[];
  toolCalls: number;
  assistantTurns: number;
  errorTurns: number;
  userSwitchedModelAfter: boolean;
  automaticFallbackAfter?: boolean;
  lastStop?: string;
  nextUserText?: string;
  continuation: boolean;
  child: boolean;
  outcome?: string;
  effort?: { toolCalls: number; assistantTurns: number; modelsUsed: number };
}
const rows: Row[] = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

/**
 * The next user turn sends the work back. Deliberately narrow: a vague "hmm" is
 * not a rejection, and a new unrelated task is not one either. Portuguese and
 * English, since the corpus is both. Bare "de novo" / "again" are excluded:
 * they read as rejection about as often as they mean "one more, please".
 */
const REJECTION = /\b(still (?:broken|failing|wrong|doesn'?t)|isn'?t working|did ?n[o']?t work|not what i|that'?s wrong|wrong|revert|undo|you (?:broke|missed|forgot)|try again|same (?:error|problem|issue)|ainda (?:quebrado|falha|n[ãa]o)|n[ãa]o funciona|n[ãa]o era isso|est[áa] errado|errado|desfaz|reverte|voc[êe] (?:quebrou|esqueceu))\b/i;
const counts: Record<string, number> = {};
for (const r of rows) {
  delete r.outcome;
  delete r.effort;
  if (r.continuation || r.child) continue;

  r.effort = { toolCalls: r.toolCalls, assistantTurns: r.assistantTurns, modelsUsed: r.modelsUsed?.length ?? 1 };

  // Infrastructure first: a transport failure is not a quality signal, whatever
  // the user said next.
  if (r.errorTurns > 0 || r.lastStop === 'error' || r.automaticFallbackAfter === true) {
    r.outcome = 'infra-failed';
  } else if (r.lastStop !== 'stop') {
    // Aborted, truncated (`length`), still in a tool loop, or no terminal state
    // recorded at all. No defensible completion judgement.
    r.outcome = 'interrupted';
  } else if (r.nextUserText === undefined) {
    // Last task of the session: finished, but never accepted by anyone.
    r.outcome = 'interrupted';
  } else if (r.userSwitchedModelAfter || REJECTION.test(r.nextUserText)) {
    r.outcome = 'quality-failed';
  } else {
    r.outcome = 'accepted';
  }
  counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
}
writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify(counts));
