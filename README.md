# tg-router

Quota-aware model router for [Oh My Pi](https://github.com/oh-my-pi). It picks
which model answers each turn across every subscription and paid endpoint you
own, so the pool gets used well instead of one favourite model getting drained.

The router has exactly two user-facing states:

- **auto** — rules decide the capability floor; Jev (TypeSafe's System One
  model) refines it when a key is present; quota and money pick the cheapest
  qualified route. The status line always shows which one decided:
  `route auto · jev · astra` or `route auto · rules · astra`.
- **pin** — your model, no classification, no spend.

## How a turn is routed

```
user turn / child spawn / handoff
        │
        ▼
 rules classifier  ──►  capability floor (mechanical … premium) + phase
        │
        ▼
 Jev (optional)    ──►  phase clarification, floor raise. Never lowers.
        │
        ▼
 admission         ──►  authenticated, context fits, tools/images, Go validation,
                        known-exhausted windows, paid-fallback authorization
        │
        ▼
 allocation        ──►  among qualified candidates, prefer the one that spends
                        the least scarce window; subscription before cash
        │
        ▼
 exact model + effort + transport (9Router / native / guarded OpenRouter)
```

Classification happens only at a safe boundary: a new user task, a spawned
child, an explicit handoff, or a provider failure. Never mid tool-loop.

## Principles

- **Floor, not pick.** The task sets the minimum capability. The pool decides
  which qualified model. Allocation is lexicographic: cost class first (worker
  < mid < premium < paid), then headroom within the class, then a reviewed
  preference order. A premium model is never given work a cheaper qualified
  model can do; premium slack is not a reason to spend premium.
- **Accounts are alternatives.** Two Claude subscriptions are compared, never
  summed and never intersected. Fable's weekly sub-window is its own axis.
- **Money is a window too.** Paid endpoints get a headroom like any
  subscription (`cap − spent` over time left), inside hard daily/monthly caps
  enforced by an atomic SQLite ledger.
- **Fail closed, stay visible.** Missing key, timeout, budget, malformed
  answer: the classifier steps aside, rules continue, the status line says
  `rules`. Nothing optional may ever break extension load.
- **Secrets never touch settings or history.** The TypeSafe key is read from
  1Password into omp's own credential store by `/route key`. It is never a
  command argument, because omp persists slash commands to `history.db`.

## Commands

| Command | Effect |
|---|---|
| `/route` | status JSON |
| `/route auto` | automatic routing (rules + Jev if keyed) |
| `/route off` | manual; keep whatever model is selected |
| `/route pin <provider/model>` | fix a model for this session |
| `/route key` | import the TypeSafe key from 1Password (`AgentKit - Typesafe`) into omp's credential store. `status` / `clear` |
| `/route why` | one deterministic sentence explaining the last decision |
| `/route feedback fail\|success` | record a quality outcome; two failures escalate the tier |
| `/route handoff` | mark work state safe to leave the current model/family |
| `/route high-value` | allow spending soft reserves; disables headroom swaps |
| `/route roster` | review catalog findings, probe candidates, vet them |
| `/route usage` / `refresh` / `reconcile` | 9Router telemetry and paid-ledger reconciliation |

## Install

```sh
bun install
bun run link        # symlinks this checkout to ~/.omp/agent/extensions/personal-router
```

omp follows symlinked extension directories, so the checkout is live. Runtime
state (ledger, quota cache, decision log, session corpus) lives in
`~/.omp/agent/personal-router/`, never in this repo.

## Verify

```sh
bun test            # 96 tests; policy, quota, ledger, classifier contract, load safety
bun run typecheck   # strict, owned modules
```

## Layout

| File | Owns |
|---|---|
| `index.ts` | omp hooks, session state, commands, decision epochs |
| `policy.ts` | pure routing policy: classification, admission, allocation, semantic resolution |
| `jev-questions.ts` | the seven typed questions sent to Jev; the only place rubric text lives |
| `jev-client.ts` | dependency-free native TypeSafe client; one attempt, hard deadline, strict validation |
| `routing-context.ts` | bounded, redacted task state; HMAC cache keys |
| `assessment-cache.ts` | TTL + single-flight cache of assessments |
| `budget.ts` | atomic cash ledger with purpose sub-caps |
| `roster-monitor.ts` | catalog comparison; emits proposals, never edits |
| `roster-probe.ts` | capability probe; five real calls, stops before harming a provider |
| `roster-ui.ts` | `/route roster` review screen: findings, probe, vet |
| `ninerouter-usage.ts` | 9Router telemetry, per-account windows, exhaustion tombstones |
| `accounts.ts` | account priority steering |
| `quota.ts` / `meridian.ts` | native and Meridian quota adapters |
| `guarded-openrouter.ts` | paid transport guard; rejects unbudgeted calls |
| `ninerouter.ts` | **generated bundle** of the 9Router transport + model catalog; do not hand-edit |

## Data

`~/.omp/agent/personal-router/session-corpus.jsonl` is a redacted extract of
real omp sessions (one row per substantive user turn: prompt, model that
answered, outcome). It is the ground truth for tuning and is regenerated by
`scripts/mine-sessions.ts`, then labelled by `scripts/relabel.ts`. Gitignored.

### Outcome labels, not model choices

"You used a cheap model here" is not evidence that cheap was enough: in the
corpus cheap models did the same work worse (2x tool calls, 3x error turns).
Labels are therefore by outcome:

| label | meaning |
|---|---|
| `cheap-clean` | cheap model, no errors, no switch away, tool calls within the premium p75 (37). Cheap was sufficient. |
| `cheap-struggled` | cheap model that errored, was switched away from, or needed more than premium p90 (68) tool calls. Under-routing evidence. |
| `premium-clean` | premium model finished cleanly. Cannot say whether cheap would have. |

Any classification change is replayed against these. The invariant that
gates shipping: **0 `cheap-struggled` turns may move down**.

### Session signals

Two measured signals are computed from the session at decision time and act
as deterministic downgrade guards, independent of anything Jev says:

| signal | measured struggle rate | effect |
|---|---|---|
| previous assistant turn errored | 15% vs 4% after a clean turn | blocks downgrade |
| first user turn of a session | 25% vs ~4% later | blocks downgrade |

They are also sent to Jev as structured `observations` fields, never as prose.
The previous turn's tool-call count is carried for traces; on its own it did
not separate outcomes.

### Rules derived from the corpus

The old classifier sent 69% of turns to `complex` through its no-keyword
default. Two rules now fire before that default, each backed by a measurement:

- **Session/repository operations** (deploy, commit, push, merge, reconcile,
  close the worktree, move the issue) are `bounded`. Among no-keyword prompts
  these had the highest cheap-clean share (20% vs 13% base) and a below-base
  cheap-struggled share (5% vs 8%). Verbs only: a delegation brief that merely
  says "work in this worktree" is excluded — the replay caught five of those
  being pushed down.
- **Pasted stack traces / code blocks** are `complex` investigation. 14% of
  cheap-struggled turns carried pasted code against 1% of cheap-clean. This is
  the strongest under-routing signal in the corpus.

Replay on 1,799 labelled turns: 18 cheap-clean and 63 premium-clean moved
down (median 10 tool calls — light work), **0 cheap-struggled moved down**.

## Roster monitor

The reviewed roster lives in `policy.ts` and only a human changes it. A
scheduled check compares it against structured catalogs (models.dev and
OpenRouter's pricing API, not scraped HTML) and prints proposals:

- **stale** — a roster model no longer exists at its provider (this is how
  Union would have been caught when its free window closed)
- **repriced** — a paid price moved by 25% or more
- **candidate** — a free model at a provider you already subscribe to, or a
  recent one with enough context

```sh
bun run roster-check          # new findings since last run
bun run roster-check --all    # everything current
```

### Vetting a candidate

Reading a catalog row does not tell you whether a model survives a tool loop,
so `/route roster` inside omp turns a finding into evidence. It lists findings,
probes a candidate on demand with five real gateway calls, prints per-check
results, and only then offers to write the `goValidated` entry that makes a Go
model routable for tool work.

| Check | Gate it earns |
|---|---|
| `instruction` | follows an exact-output instruction |
| `tools` | emits a well-formed tool call — `validated.tools` |
| `reasoning` | solves a trick arithmetic prompt — `validated.reasoning` |
| `longContext` | finds a needle at ~42k tokens; proves declared context is usable |
| `effortHint` | informational: whether the upstream accepts `reasoning_effort` |

Two rules the probe learned the hard way, both now regression-tested:

- **It stops on the first account-level error.** Probing a model the gateway
  does not serve makes the upstream reject the whole account, and 9Router then
  401s every model on it for a cooldown. Candidates are filtered to what the
  9Router catalog actually serves, and any auth or rejected-body response ends
  the run instead of degrading a live provider.
- **It never measures its own request shape.** `reasoning_effort` is sent only
  in the informational check, because a Go upstream 400s on it; and every check
  allows 512 completion tokens, because reasoning models emit
  `reasoning_content` first and a tight budget truncates the real answer to
  empty. A truncated response reports `inconclusive`, not a failure.

Catalog presence is never qualification. Tier qualification stays a reviewed
decision in `policy.ts`; the probe only unlocks the transport-level gate.

`scripts/com.thalys.tg-router.roster-check.plist` runs it every 48h via
launchd; findings and price history live in `~/.omp/agent/personal-router/`.
It never edits policy. Catalog presence is not qualification.

## Calibration result: no semantic downgrades

`bun run calibrate` scores two labelled classes from `session-corpus.jsonl`
against the live model: turns where a cheap worker was demonstrably enough, and
turns on a premium model where the deterministic rules independently agreed.

Run on 2026-09-18 over 160 turns, **Jev does not separate them**. 41% of
premium-warranted turns were judged `bounded`; 63% of cheap-sufficient turns
were judged `execution` or higher. No confidence or probability-mass threshold
admits meaningful cheap work — fully open it still admitted 5 of 80.

The cause is visible in the prompts and is not a model defect: real turns are
conversational continuations whose difficulty lives in the accumulated session,
not the sentence ("align the text of the right block to the right"). Jev reads
the text correctly; the text understates the work.

So downgrades stay off. `calibrated` mode is unreachable from the user surface
and, even in settings, requires
`semanticRouter.acknowledgeUncalibratedDowngrades: true`. Jev's demonstrated
value is phase clarification and resolving short follow-ups against a
persistent task goal — both of which only raise or clarify.

The 69%-of-turns-are-`complex` problem is the deterministic classifier's, and
is fixable there with the same corpus.

## Not yet

- Money is not yet a window in the allocator: paid routes are a lower cost
  class, but their remaining daily cap does not contribute headroom.
- Jev's tier is used as a floor raise only.
- The no-keyword default still lands on `complex` when there is no prior
  phase. More corpus-backed rules can chip at it; each must pass the
  0-struggled-moved-down replay.
- Structured session signals reach Jev but move its answers only slightly
  (reasoning depth 1.9 → 2.4 as difficulty stacks). Their real value is in
  the deterministic guard, not the classifier.
