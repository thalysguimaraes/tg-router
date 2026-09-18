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
bun test            # 84 tests; policy, quota, ledger, classifier contract, load safety
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
`scripts/mine-sessions.ts`. It is gitignored.

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

## Not yet

- Money is not yet a window in the allocator: paid routes are a lower cost
  class, but their remaining daily cap does not contribute headroom.
- Jev's tier is used as a floor raise only. Using its full distribution to
  pick within a class is unexplored.
