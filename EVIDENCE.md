# EVIDENCE — live experiment ledger (fsm-lab, Task 43)

Every claim carries its run ID / log line. Nothing here is aspiration.
Timestamps UTC. Session: 2026-09-06.

## X1 — chain physics (the continuity substrate) — COMPLETE

### X1a: GITHUB_TOKEN self-dispatch STARTS workflows ⭐

- Probe run **34025596219** (`hop 0 · github-token`, 09:46:38Z): dispatch with
  the job token → `HTTP=204` → log: `VERDICT: GITHUB-TOKEN-WOKE — 1 run(s) fired`.
- Follow-up run **34025603333** (`hop 1 · verify`): `event=repository_dispatch`,
  `triggering_actor=github-actions[bot]`, created 10s after the dispatch.

**Architectural consequence:** same-repo orchestration (conductor self-chain,
worker dispatches, watchdog re-prime, ops nudges) needs **zero PAT** — the
job-scoped ephemeral token suffices (`repository_dispatch`/`workflow_dispatch`
are the documented exceptions to the anti-recursion rule; `issue_comment`
and content events are NOT — that part of E7 stands). Cross-repo dispatch
still needs a PAT — why the prior track never saw this. The lab keeps
`LAB_PAT` wired as a fallback lane.

### X1b: PAT chain — 15 hops, 9.2s avg cadence, 129s span, all success

Runs `hop 1..15 · pat` (09:51:21Z→09:53:30Z).

### X1c: GITHUB_TOKEN chain — 15 hops, 8.9s avg cadence, all success ⭐

Solo epoch (10:24Z→10:26Z). Actor sequence: `zikomolapoutl` (PAT-seeded
hop 1) → `github-actions[bot]` for all 14 subsequent hops. **A zero-secret
infinite chain.**

**Measurement gotcha:** two chains sharing one `concurrency` group
interleave-cancel (newest-wins) — the dual-launch gh-chain "stopped" at 1
hop until re-run solo.

## X2 — conductor live loop — COMPLETE (two epochs)

**Polluted epoch (09:52–10:20):** bootstrap 34025876490; chain live at ~10s/tick.
Five live-caught defects, each absorbed by the failure model or fixed
in-session (the list below is the session's core yield):

1. **store.commit dropped `actions`** — leases assigned, no worker dispatched
   (silent livelock; `v=5 seq=1 actions=0` was the tell). Fixed: commit
   carries mutate's actions/journal.
2. **GHA concurrency groups are depth-1, newest-wins — NOT FIFO queues.**
   Four report runs (09:57:12Z, runs 34026063838/4081/4542/5711) CANCELLED by
   the next self-tick. Architectural fix: reports CAS-append to
   `state/reports-queue.jsonl`; each tick drains atomically in the SAME state
   commit (`TICK+2r`/`TICK+3r` commits observed live). Data flows through
   git; dispatches are wake-only.
3. **Quarantined deps deadlocked blocked dependents** (T-103..106 forever in
   backlog). Fixed: CANCEL_CASCADE (live at 10:05Z: cascade + `M2 STARTED`).
4. **External dispatches into the hot conductor group get newest-wins-cancelled**
   (the reset control run 34026571647 died at 10:08:09Z). Fixed: controls ride
   git — fsm-ops workflow (own group) enqueues `control-queue.jsonl`; ticks
   drain controls atomically (+ ops-nudge wakes a stopped chain).
5. **Payload-shape family (×2):** repository_dispatch carries its type in
   `action`, NOT `event_name` — ops silently enqueued `pause` for a dispatched
   `reset` (10:13:55Z, state pause observed at 10:14Z); conductor buildEvent
   misrouted direct fsm-control to a tick. Both fixed, both caught live.

**Clean epoch (10:20–10:53):** reset via ops queue → full mock project
END-TO-END: `phase=done M3`, stats `{done:14, quarantined:4, retries:10,
orphaned_reports:4(injected), rejected_events:21, timeouts:9, dispatched:28}`,
STOP_CHAIN fired, ops issue carries milestone/quarantine/completion comments.

## X3 — parallel workers + burst contention — COMPLETE

- Organic: 4-parallel workers across M2 (interleaved `report-queue +1` commits
  + `TICK+Nr` drains under the live chain).
- Synthetic burst: **10 concurrent writers, each in its own clone** (the
  production shape): `BURST-RESULT writers=10 ok=10 lost=0
  slowestWriter=31100ms` — every contention resolved by CAS retries; zero
  lost writes (run from the operator sandbox, 10:56Z).
- **Live-found bug #6:** 10 writers sharing ONE clone race the local
  tracking ref (`cannot lock ref`); fetch() treated it as fatal. Fixed:
  fetch tolerates transient ref-lock races (the FF-only push remains the
  correctness backstop — a stale local view can only be rejected, never
  corrupt).

## X4 — failure-injection matrix — COMPLETE

| Class | Injection | Live evidence |
|---|---|---|
| duplicate report | `dup` behavior (identical event_id enqueued twice) | `rejected_events` +1; task done once (clean epoch) |
| stale/orphan report | operator-injected wrong-lease reports (10:54Z) | `orphaned_reports: 2`, task untouched |
| flaky | behavior (fail → retry → succeed) | T-102 done at attempts=2 |
| poison | behavior (always fail) | T-207 quarantined at attempts=3 + alert comment |
| hang | behavior (worker silent past lease) | T-105 quarantined via lease timeouts (polluted epoch); SUPERSeded by the real worker (X7) |
| slow (late report) | behavior | quarantined via lease timeouts — live discovery: per-task supersession CANCELS the late worker before it can report (the orphan path narrows to the reassignment race window; operator injection keeps it proven) |
| no-report | behavior (report dropped) | T-205 burned 3 lease cycles → quarantined |
| lease timeout / retry | all of the above | `timeouts: 9`, `retries: 10` (clean epoch totals) |
| CAS races | burst + rival writers | zero lost updates (X3) |
| corruption | store suite (git-history walk) + sim | local 7/7; never corrupted live |

## X5 — watchdog re-prime — COMPLETE (with a caveat)

- Deterministic chain kill: caught a QUEUED tick (run 34028133963) and
  cancelled it before start — no self-dispatch fires (10:41:43Z).
- Watchdog scan (manually dispatched, 10:47Z, run 34028385812) — byte-exact
  log: `WATCHDOG-SCAN seq=38 last_tick=10:41:16 age=367s stale=true done=12/16`
  → `WATCHDOG-REPRIME dispatch=204 (reprime 1/3 in window)` → the chain
  revived (ticks at 10:47:58Z+).
- First kill attempt (10:32Z) missed: the cancel API is ~24s slow to
  propagate and the turn finished + self-dispatched first — the 3m18s "gap"
  was a **dispatch-to-run latency of ~2m44s** (accepted 204, delayed run
  creation). Known class from the prior track, now measured.
- **Caveat (live datum):** on this ~1h-old public repo, NEITHER cron has
  fired ONCE (watchdog :03/:13/… and conductor backstop :08/:18/… both
  dead all session) — the prior track's "native schedule is intermittent,
  external dispatch is primary" reconfirmed on fresh repos. The watchdog
  scan was driven manually (workflow_dispatch). Production shape: the org
  executor's external scheduler drives it (the t1 pattern).
- Circuit breaker (X5b): kill ×3 → re-prime ×3 → 4th scan trips the breaker
  (no re-prime + one alert issue). See the trace below.

### X5b trace (breaker test, 10:59Z–11:34Z) — PASS

Cycles: kill-queued-tick → 4.5-min staleness → watchdog scan (manual
dispatch). The scan at 11:16:20Z (run 34029759397) counted **3 re-prime
runs in the 30-min window** (10:47 X5 + 11:04 + 11:10) → **BREAKER OPENED**:
no re-prime, alert issue **#2** created 11:16:31Z with the runbook body
("Re-priming is now DISABLED. Manual intervention required: …re-arm: POST
…/dispatches"). The chain stayed dead 11:11:46Z→11:33Z awaiting the
operator.

**Operator loop closed (11:31Z):** manual re-arm tick (the exact action the
alert prescribed) + issue #2 commented and closed. The chain revived
(11:33:39Z+) and the project resumed completing itself — the full
dead→detect→alert→human→re-arm→revive cycle, end to end.

Bonus datum: the cycle-3 re-prime dispatch (11:16:20Z) was
accepted-but-never-fired (the drop class) — masked by the breaker opening
the same second; the system's response was correct either way (dead chain
+ breaker + alert, not a loop).

One test-harness note: the script's cycle-4 "kill" cancelled the first
re-arm tick as collateral (its queued-run hunter was still live) —
terminated, re-armed again cleanly. The breaker itself tripped one cycle
earlier than the script expected because the X5 re-prime legitimately
counted inside the 30-min window — correct window semantics, slightly
off test expectation.

## X6 — state growth — VERIFIED LIVE (incl. ROTATION)

- Mid-run (357 events): state.json 8.3KB, journal gen-1 43KB.
- At completion (~2,000+ journal ids across epochs): **journal-1 (498
  lines) + journal-2/3/4 (500 lines each) — the rotation fired exactly at
  the 500-record threshold, 4 generations retained, ~250KB hard ceiling.**
  state.json 19KB (18 tasks with attempt-bounded history + dedup window;
  scales with task count, not event count). 286 branch commits — each
  carrying the full materialized state (the recovery substrate).
- Residual: 3 late reports parked in the queue after the project halted
  (stragglers from superseded slow workers) — 522B, harmless; the next
  drain would consume them as not-leased rejections.
- Scaling note (honest): per-task `history` is attempt-bounded (≤ max_attempts
  entries) so state.json grows with TASK COUNT, not time; for 1000+-task
  projects, trim task history to a rolling window (the journal retains the
  full audit regardless).

## X2 final closing datum — the post-recovery epoch

After the X5b breaker cycle (3 kills → breaker → alert → operator re-arm),
the system **completed the entire remaining project autonomously**:
`phase=done M3 halted=true`, stats `{done:15, quarantined:3, retries:11,
timeouts:9, dispatched:29}`, 19 ops-issue comments, STOP_CHAIN fired, journal
at e518. Kill the chain three times, trip the breaker, re-arm with ONE
dispatch — and the work finishes itself. That is the resilience thesis,
closed end-to-end.

## X7 — the real-LLM seam — COMPLETE ⭐

- Reset epoch: the hung mock worker `task-T-105 · hang · a1` (run 34028775261)
  was CANCELLED by the real worker's dispatch (per-task supersession).
- Real worker run **34028833818** (`task-T-105 · real · a1`, 10:57:07Z):
  one OpenRouter completion (minimax/minimax-m3:free via the kasulty key)
  → reported through the lease contract → drained → **T-105 `done`,
  attempts=1, artifact = the model's actual answer** ("…viable long-term
  only with external persistent state, durable idempotent steps, and
  aggressive…" — the model independently describing the architecture it was
  running inside).
- The seam is proven: a non-deterministic agent inside the deterministic
  FSM, same lease/dedup/orphan machinery, zero special-casing. The next step
  (a full CC turn via the agent-turn composite action) drops into
  `worker/turn.mjs`'s real path unchanged.
