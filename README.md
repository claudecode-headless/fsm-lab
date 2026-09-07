# fsm-lab — FSM-Anchored Long-Running Agent Orchestration on GitHub Actions

**Track-1 Task 43 lab.** The de-risking question: can a single, local,
continuously-running agent harness (like Claude Code) be converted into a
**distributed system of short-lived GHA jobs that is collectively continuous** —
stateful, parallel, watched, and bounded — using only GitHub-native constructs?

```
stateless today                          stateful here
─────────────────                        ───────────────────────────────
trigger ─▶ one agent turn ─▶ reply       conductor ─▶ FSM(state) ─▶ dispatch workers ─┐
(HTTP request/response)                  ▲   ▲            │ lease + event report      │
                                         │   │            ▼                           │
                              chain ─────┘   └── watchdog (re-prime, breaker)        │
                              (GITHUB_TOKEN self-dispatch: finite jobs, infinite loop) ◀──────┘
```

## The architecture in one page

| Concern | Mechanism | Where |
|---|---|---|
| **State anchor** | versioned `state.json` + rotating `journal-*.jsonl` on the `fsm-state` git branch; CAS = FF-only push; corruption recovery = git-history walk; event-sourced rebuild = journal replay | `lib/store.mjs` |
| **The process (FSM)** | pure transition core: `applyEvent` + `clock` (timeouts, dep unlocks, retries, scheduling, milestone advance). Invariants machine-checked after every commit (fail-closed: violations throw pre-commit) | `lib/fsm.mjs` |
| **Continuity** | every conductor turn self-dispatches the next `fsm-tick` via the job-scoped `GITHUB_TOKEN` (X1a: `repository_dispatch` IS the documented anti-recursion exception — probe 34025596219; 15-hop zero-secret chain, X1c). `LAB_PAT` is the fallback lane only. The loop is finite jobs chained into an unbounded sequence | `conductor/turn.mjs` |
| **Parallelism** | `max_parallel` leases; worker runs are concurrent (per-task concurrency groups), state writes serialize through ONE conductor queue (single writer) | `worker/turn.mjs` |
| **Task units** | issues are the human surface (ops console = issue #1); the machine surface is the state file + run names | workflows |
| **Failure model** | every failure class has a handler: lease deadlines (hangs), retry + quarantine (poison), dedup (dup reports), orphan rejection (stale leases), CAS retry (races), git-history recovery (corruption), watchdog re-prime + circuit breaker (dead chains) | everything |
| **Testability** | FOUR layers, all driving the SAME lib code: FSM unit matrix (30), store suite (12, real git transport: CAS races, disjoint rotation, corruption recovery, fault-injected commit-tree), offline simulation (7 scenarios, virtual clock), and the T44 fourth layer — `lib/conductor-core.mjs` (the turn algorithm as a lib function) driven by the GHA-semantics shim (`sim/gha-shim.mjs`: ConcurrencyGroup newest-wins-cancel, DispatchLane latency/drop) + frozen live event fixtures (`lib/event-ingest.mjs`, strict) + 7 shim-driven regression scenarios incl. sabotage-proves-the-test + a 15-test conductor-core suite (57 total) | `tests/`, `sim/`, `lib/conductor-core.mjs` |

## The state-anchor decision (argued, not assumed)

**Chosen: structured JSON on a dedicated git branch** (with event journal).

- **Projects v2** — rejected as the anchor: no wake surface (proven:
  `projects_v2_item` is an invalid trigger), needs `project`-scope tokens,
  GraphQL schema drift, no compare-and-swap, no history you can replay, no
  complex data. It stays a candidate MIRROR (dashboard) — mirror-only, as in
  the swarm.
- **Markdown in the repo** — rejected as the anchor: append-only growth (the
  stated problem), hostile merges, no schema, no machine-checkable
  invariants. Markdown is for HUMANS: the ops issue + step summaries render
  the state; they never store it.
- **Git branch + JSON** — chosen because: durable (no 90-day artifact TTL),
  CAS for free (non-FF push = conflict signal), full history for free (every
  commit carries the materialized state), bounded by construction (state is
  overwritten; journal rotates), writable from ephemeral runners with
  job-scoped tokens, and the 5-writer survival of the prior track's
  `agent-sessions` branch already proved the concurrent-writer mechanics.

## The failure matrix (every state has a handler)

| Failure class | Detection | Handler | Proven in |
|---|---|---|---|
| Worker run dies (CI) | run conclusion=failure | lease deadline → retry/quarantine | sim `dropev`/`crash`; live X4 |
| Worker hangs | no report by lease expiry | same | sim; live X4 (hang behavior) |
| Report dispatch dropped | no report by lease expiry | same | sim `dropev`; live X4 |
| Duplicate report | event_id dedup | second is a no-op, journaled | unit `duplicate`; sim `dup`; live X4 |
| Stale report (task reassigned) | lease token mismatch | rejected as orphan, counted | unit `stale-lease`; sim `stale`; live X4 |
| Poison task | attempts ≥ max | quarantined + alert comment | unit `poison`; sim; live X4 |
| Concurrent state writers | non-FF push reject | CAS retry: re-read + re-apply (dedup absorbs double-apply) | store `CAS` tests; live X3 |
| state.json corrupted | JSON parse fail | git-history walk → last good snapshot → RECOVERY record forces the commit (quiescence can't suppress repair) → continue | store `corruption` + fault injection; live never corrupted |
| Conductor dies mid-turn | chain staleness | watchdog re-prime (dispatch tick) | sim `crash`; live X5 |
| Chain keeps dying | re-prime counter | circuit breaker → alert issue, stop re-priming | live X5 |
| Runaway chain | (rate cap knob) | tick_min_interval_s + STOP_CHAIN at completion | config |
| Everything gone | branch deleted | bootstrap genesis + alert | conductor bootstrap path |

## Repo layout

```
lib/fsm.mjs           the pure FSM core (transitions, invariants, rebuild)
lib/store.mjs         the git-branch state store (CAS, rotation, recovery)
lib/mock.mjs          deterministic agent behaviors (the failure matrix as workload)
lib/mock-project.mjs  the mock project: 3 milestones, DAG + failure profiles
conductor/turn.mjs    one orchestration turn (read → apply → commit → act → chain)
worker/turn.mjs       one task attempt (mock or real LLM seam)
watchdog/scan.mjs     chain health: staleness, re-prime, circuit breaker
probe/hop.mjs         X1: self-dispatch chain physics probe
sim/run-sim.mjs       the offline simulation (virtual clock, failure injections)
tests/                24 unit/store tests (node:test)
.github/workflows/    conductor.yml, worker.yml, watchdog.yml, chain-probe.yml
```

## Operating the lab

```bash
# bootstrap / kick the chain (needs a PAT with repo+workflow):
curl -s -X POST -H "Authorization: token $LAB_PAT" \
  https://api.github.com/repos/claudecode-headless/fsm-lab/dispatches \
  -d '{"event_type":"fsm-tick","client_payload":{"reason":"manual"}}'

# pause / resume / halt / reset / configure:
#   dispatch event_type=fsm-control, client_payload={"command":"pause"|"resume"|"halt"|"unhalt"|"reset"| "configure", "patch": {"lease_minutes": 15}}

# watch: the fsm-state branch (git log), the Actions run names
#   ("chain · conductor", "report:T-101 · conductor", "task-T-101 · flaky · a2"),
#   and ops issue #1 (milestones, quarantines, completion).
```

## Honest scope

- The mock workers are NOT agents — they are deterministic failure profiles.
  The LLM seam (worker `mode: real`, one OpenRouter free-model completion)
  proves the wrapping works; the full CC-turn integration is the NEXT step
  (the swarm's agent-turn composite action drops into `worker/turn.mjs`).
- The public repo holds mock content only; secrets follow the executor
  security contract (dispatch/schedule triggers only — never
  `issue_comment`/`pull_request`/`workflow_run` on a repo holding a PAT).
- Live experiment evidence (run IDs, measured cadence, drop rates) lands in
  `EVIDENCE.md` as the experiments complete.
