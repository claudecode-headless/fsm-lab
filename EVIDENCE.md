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

---

## Task 44 (2026-09-07) — the audit + deepen round (X8–X14)

Five parallel sub-agent audits (44-a..e) + two design-review rounds (44-f/g)
+ a pre-push code review (44-h) drove waves 1-2 (13 fixes) and wave 3 (the
fourth test layer). All fixes landed in ONE atomic push (401d948) after
local gates: 41/41→57/57 tests, sim 7/7, offline conductor smoke
(drain + quiesce). The post-audit LIVE evidence:

### X11 — consume-on-drain: the zombie loop's tombstone ⭐
- Pre-fix (live, since session 12): 3 stale X2-era reports re-rejected
  every backstop tick (journal e519..e538 across 5 fires; ~4 records/tick
  forever; `rejected_events` 85→100).
- Wake 1 post-fix (run of dispatch `t44-x11-drain-v2`, 00:05:49Z): commit
  `TICK+3r seq=48 v71 [e543..e545]` — **exactly 3 REJECTED records, NO TICK
  record (the held wake is not an event), seq FROZEN, queue emptied to 0
  lines.** (The first X11 attempt at 00:03:52 ran the OLD code — its
  checkout sha 6bdef4e proved the earlier push had silently failed; a
  pipe-masked rc. Caught by evidence, re-pushed, re-run.)

### X9 — quiescence: 10 wakes, ZERO commits
- 10 consecutive `fsm-tick` dispatches (00:06–00:11Z, all 204): every run
  logs `QUIESCED: held-halted (chain halted) — no commit, no self-dispatch`;
  branch tip byte-identical across all 10 (1450b19). The A1 livelock attack
  (mixed-deploy noop self-dispatch, ~2.9k-10.4k runs/day) is structurally
  dead: the noop path never dispatches.

### X8 — ops-nudge latency: ~77s end-to-end (was: broken since birth)
- The nudge had 401'd on EVERY run since session 12 (runs 34026953026,
  34028691734 logged `OPS-NUDGE tick dispatch HTTP=401`, both runs green —
  the status was never checked). One env line (`GH_TOKEN`) fixes it.
- Live: `pause` control dispatched 00:11:34Z → ops enqueue + **nudge 204**
  → conductor tick 00:12:29Z → control applied + committed
  (`control-queue +1 pause` → `TICK ... [e547]` — the held wake again
  journal-less) → total ~77s vs the previous effective latency = the
  schedule backstop (~2h, sparse).

### X10 — full-project regression + DISJOINT rotation on the new code ⭐
- Reset (unified drain path) → the 3-milestone / 18-task project ran
  END-TO-END again on T44 code: v69, seq=55, 14 done / 4 quarantined,
  phase=done, STOP_CHAIN, self-stop at 00:45:02Z; 26 ops-issue comments
  (milestones, quarantines, PROJECT COMPLETE); 12-hex lease tokens live
  (`l-7223772fc8e9`, `l-1e67c735bc4c`).
- **The completion turn proves F2's hardest case LIVE**: the drain of
  T-302's report ran the clock to `phase=done + halted` MID-MUTATE; the
  wake TICK on that same turn was correctly HELD (no journal record, seq
  frozen at 55) while the accumulated journal [REPORT e673, PHASE e674]
  still committed — the 44-f "drain-halts-mid-mutate still commits" trap.
- **Rotation (disjoint gens)**: journal-11 = [e543..e674], 132 lines = 132
  DISTINCT ids, created from a FULL gen-10 (500 lines) + new records only
  (the old code would have written another 500-line 99%-duplicate window).
  Gens ≥10 exist → the numeric-ordering fix is exercised live
  (lexicographic sorts would hide the newest gen from the tail read).
  The pre-fix gens (8-10, overlapping) prune away as gen climbs — the
  documented migration path; retained window converges to 4×500 distinct.

### X14 — the real-lane lease budget (configure control, live)
- `configure {lease_minutes: 15}` dispatched 00:54Z → applied through the
  full ops→queue→drain→FSM pipeline (commit `CONTROL ... [e675..e676]`,
  state.config.lease_minutes=15) — the runtime knob surface works.
- Reset adopts the new config → the HANG task T-105 leased (15-min lease) →
  a REAL worker (mode=real, minimax-m3:free via kasulty, slow-prompt)
  dispatched on the same lease superseded the hung mock worker and
  completed: **T-105 done, attempts=1, artifact = the model's answer**
  (run 34071849623, 01:05Z), well inside the lease. The lease formula is
  now executable: the sim2 `lease-margin` scenario flags lease=4min as
  NEGATIVE budget (-358s at 164s dispatch latency) and lease=15min as
  +302s — matching this live run.

### X5c — watchdog re-prime regression on T44 code
- In-progress tick cancelled mid-pacing (01:08:33Z — the deterministic
  kill; last_tick frozen 01:08:39Z) → manual watchdog scan (workflow_dispatch,
  01:16Z): `WATCHDOG-SCAN seq=10 last_tick=... age=446s stale=true done=7/8`
  → `WATCHDOG-REPRIME dispatch=204 (reprime 1/3)` → chain revived 01:16:40Z+,
  project continued. Same byte-exact behavior as session 12's X5.

### X13 — CAS burst re-run under the new jittered backoff
- 10 concurrent writers, each in its own clone, against the LIVE repo with
  the conductor chain actively ticking and draining (contention last
  round's burst never had): `BURST-RESULT writers=10 ok=10 lost=0
  slowestWriter=39423ms` — zero lost writes; the burst items were drained
  as journaled+consumed REJECTED(unknown-task) records, exactly per design.

### X12 — commit-tree fault guard (local, fault-injected)
- `FSM_LAB_FAULT_COMMIT_TREE=1` → commit() THROWS
  (`commit-tree failed rc=...`), the push refspec is never built from an
  empty sha, the branch survives byte-identical (test in
  tests/test-store.mjs; the probe-confirmed branch-DELETION path is dead).

### Post-session schedule physics (refines X5's caveat)
- Schedules COLD-START ~3.6h after repo creation (first fire 13:11:45Z vs
  repo ~09:35Z), then ~2h cadence vs the 10-min nominal (~5% duty) —
  "dead on fresh repos" revised to "cold-start + sparse". External driving
  remains the production answer; the quiescence fix makes the sparse
  backstops FREE (no commit, no self-dispatch).

### T45/F-G(e) — the worker TTL-kill signature (doc-only, porting contract)
- A `timeout-minutes` kill presents as conclusion=**cancelled** (NOT failure)
  with a step duration ≈ timeout-minutes — live datum run 34073438112
  (step 20m03s, conclusion cancelled, no report). In-lab the lease deadline
  is the semantic handler BY DESIGN (the run conclusion is cosmetic); the
  porting contract for any failure-watch: count cancelled-at-TTL as the kill
  class. No cheap in-run marker exists (the killed process can't log).
- Companion (F-G(a)): the mock sleep cap is now WORKER_TTL_MIN − 2 (margin),
  so the `slow` behavior reports LATE (stale-lease orphan) instead of being
  SIGTERM-killed at the cap — the orphaned-report lane is reachable from the
  mock lane; first live observation to be noted here (X18).

## X19 — the alert-lane end-to-end proof (2026-09-15, session 15/16)
The executor's mirror-health duty opened latch issue #3 on fsm-lab (`duty alert: mirror-health`, 04:22:44Z, run 34928576456 — 16s after the duty ran) after the A2 repair (exec-duty-lib retarget + curl POST lane + numeric guards; commits d92d82b/b7ec174/cf8201f). Zero wake collisions (fsm-lab is schedule/dispatch-only). The 410-dead-target / error-body-as-issue-number / canary-scope triple bug class closed with regression shapes.

## X15 — garbage-state recovery (2026-09-15)
Probe1-shape corruption (torn state.json + unapplied-era records, commit c3a3888) → the conductor's findLastGoodState walk landed 7af0c02 `TICK seq=154 v65 done=15 RECOVERED`. G-15 closed.

## X16/X17/X18 — the T45 fix-wave drills (2026-09-16, runs 35044234419/35044369441/35044420601/35044483639 + 34947001617)
X16: corrupt-state → alert issue #4 opened → marker comment 5690657920 → `WATCHDOG-ALERT-SKIP (recent trusted marker <24h on issue #4: age=1min by=github-actions[bot])` → manual-tick recovery b85e3ff → #4 closed. X17: the 8-wide burst (e1020, conductor run 34947001617 `actions=8`) + revert (e1157). X18: 3 re-runs at attempt=2, all a2 reports absorbed (`task-not-leased(done/done/quarantined)`, zero double-count). Full report: research/w46-wave/b4-drill-report.md in the exploration repo.

## X20 — the GHA CC ceiling, LOWER BOUND (2026-09-16, run 35125728011 GREEN after 7 diagnostic runs)
**The datum: CLI install 4-9s + one adapter turn ~5s (trivial prompt) through the local bridge on the free lane (dots-studio:free); a research-y multi-turn task runs 3-16+ minutes.** Kill-F9 label applies (free lane, rate-limited). The 8-run root-cause chain: ISO-now NaN wall → node-20 EBADENGINE + GH_TOKEN/workdir/stderr-mask → **the CLI's /v1/models/{id} pre-flight 404s on OpenRouter** (the compat surface lacks the route) → the LOCAL bridge (worker/cc-bridge.mjs) → mkdtemp/files.map trivia → permissions → the raw-extraction gate → an apostrophe. Each failure live-diagnosed, root-caused, fixed, and pinned by a test.

## X21 — the synthetic CC epoch (2026-09-16, in flight at session close)
**The stamp is delivered: journal e1416 `T-107 → done` (run 35137019099, 195.8s of real Claude Code work, transcript sessions/T-107/35137019099-a3) + e1421 `T-102 → done` (run 35137088565)** — real CC workers completing lease-scoped tasks through the FSM: dispatch → the ox envelope → the worker's law-1 gate → the per-lane bridge → multi-turn CC work → the transcript push → the five-class report → the drain → done. The three prior buggy epochs each root-caused live (the 10-property dispatch limit → the ox payload; the npm npx tax → per-job pre-install; the pacing-floor skip-left-assigned → default-off; the TTL-cap override → 48min) with the failure machinery absorbing every one (law-4 net-zero flips, infra ladders, deadline self-reports, lane rotation, cross-epoch orphan absorption). The final clean epoch (chain c-1789583988738, 45-min leases) continues autonomously; the dogfood-gate verdict (§11-1) records at its completion.

## X21-final — the dogfood-gate verdict (chain c-1789583988738, completed 2026-09-16T20:06Z)
**The epoch ran to natural completion UNATTENDED: 152 self-chained turns, M1→M2→M3→halt, phase=done, `stats {done:4, quarantined:12, cancelled:2, retries:31, dispatched:47, orphaned_reports:0, rejected_events:0}` — the machinery verdict is PASS.** Every failure-absorption path held under real load: attempt-scoped reports (26 REPORT records, zero double-counts), retry ladders, CANCEL_CASCADE on quarantine, STOP_CHAIN + halt, and the transcript push's non-FF retry recovered live (`CC-TRANSCRIPT-RETRY` → `CC-TRANSCRIPT-PUSHED 2 file(s)`, run 35141387718).

**The lane verdict is the finding: the free-model daily quota exhausted mid-epoch.** The 4 dones are all M1 (T-101 succeed a2, T-102 flaky a3, T-107 dup a3, T-108 slow a3 — the hard behaviors all passed); the first 429 landed 19:38:26Z (T-204's report) and every subsequent M2/M3 turn died to `API Error: Request rejected (429) · Rate limit exceeded: free-models-per-day-high-balance` (the CLI wraps it as `[claude-code:unrecognized_model]`, `api_error_status=429`). 12 tasks × 3 attempts burned into quarantine on a condition that is NOT work failure. Three findings carry to W-C: **(F-1) rate-limit-aware classification** — `api_error_status=429` in the lane exit must map to infra/lane-budget, not work_failed; **(F-2) budget-aware dispatch** — an exhausted lane budget must PAUSE assignment (stop dispatching, open an operator alert), not burn the fleet into quarantine — this is the dispatchBudget architecture's sharpest requirement; **(F-3) bridge route gap** — the CLI probes `HEAD /api/hello` (501 fail-noisy, correct behavior, route worth adding). Bonus: the worker job emits Node-20 deprecation warnings (cosmetic; node 22 is pinned for the CLI step only).

## R2-verification epoch — the fix-wave's live regression datum (chain c-1789613587421, mock mode, halted 2026-09-17T07:28Z)
**The R2-merged code (main a01a624) ran a full mock epoch clean under live GHA load: 15 done / 3 quarantined (83%, above the 50% quality gate — a CLEAN halt, not degraded), M1→M2→M3→halt, seq 484, `stats {done:15, quarantined:3, retries:8, timeouts:6, dispatched:26, infra_retries:0, orphaned_reports:0, rejected_events:1}` — 484 journal events, one stray re-delivery absorbed as duplicate.** The R2 fixes held: **0 infra_retries** (vs X21's quota-storm — mock mode has no lane, but the classification path stayed clean across 26 dispatches), the 3 quarantined are the mock project's DESIGNED failure behaviors (hang/slow/poison classes — their ladders burned exactly as specified), and the law-4 scan never false-flipped a live task (26 dispatches, zero dispatch-unverified records). The comparison that matters: X21-final (pre-R2, cc mode) = 4/18 done with 12 quota-misclassified quarantines; this epoch (post-R2, mock) = 15/18 with the failure classes landing exactly where the contract says they must. The R2 wave is live-proven; the remaining X21 class (the budget PAUSE reaction) is W-C1's F-6/F-7/F-8 — built this session on branch t46/wc1, offline-proven, X23's live proof pending the next quota window.

## X24 (first half) — the pinger lane LIVE (2026-09-17, pinger run 35206612744 → fsm-lab run 35206626620)
**The rung-4 heartbeat exists and works: xfnwfpho1/pinger (public, user account — the F-3 adjudication) cron */15 → `POST fsm-lab/dispatches {fsm-tick, reason:'pinger'}` on PINGER_PAT (secret set, the mirror-runner posture) → fsm-lab run named `pinger · conductor` (35206626620, repository_dispatch, success — the halted epoch's wake QUIESCED cleanly per F2).** The manual workflow_dispatch rehearsal fired 204 first-try. Remaining X24 legs: the journal `tick-pinger-<ms>` record (lands on a LIVE epoch — this wake quiesced on the halted one, by design) + the executor's watch-the-watcher duty (W-C3's second half, not yet built). Honest physics stands: nominal 15min ≈ effective 15min-2h (the X5 schedule sparsity datum) — this is the de-correlated backstop, not the primary driver.

## X25 — the agentrunners second bucket (2026-09-18, session 18)

The principal created org `agentrunners` (2026-09-17T23:45:54Z; xfnwfpho1 admin).
Live-proven end-to-end:
- `agentrunners/fsm-lab-workers` created (public — free minutes + its own
  20-concurrent-jobs bucket), fsm-lab main pushed, secrets set
  (OPENROUTER_API_KEY/_2 = the free-lane pool, STATE_REPORT_PAT for the future
  cross-org report lane), var CC_VERSION=2.1.273.
- Dispatch 204 (PAT) → run **35292565961** `task-X-25 · fast · a1`
  completed/success in the second bucket → the report queue landed on the
  mirror's fsm-state (`rep-35292565961-a1`, outcome done).
Law-8's quota isolation is DELIVERED as org buckets (not a second-account
migration): the worker plane can spread across buckets. Remaining (next wave):
WORKER_REPO dispatch routing + STORE_REPO report routing (the conductor
dispatches cross-org; the mirror's workers report back to the real fsm-state).

## X22 — the dogfood loop (2026-09-18, session 18) — GREEN after 3 live fixes

Attempt 1 (issue #6, chain c-1789696860858): the loop ran (door → rollover →
cc epoch → worker 35297656079 → transcript → done 1/1 → the m-3 completion
comment with the completing epoch's stats) but the ARTIFACT never landed:
headless `-p` mode DEFERS file-write prompts ("The write needs your
approval"). **Fix 1**: `--permission-mode acceptEdits` (the workdir sandbox +
the write-back door are the boundary).
Attempt 2 (issue #7, chain c-1789697601515): the worker WROTE the artifact
(run 35298497608), the task branch `tasks/X22-REPORT2` landed with the
read-back — but no PR on the completing tick. Root causes, live-diagnosed:
(1) **Fix 2**: store.commit reconstructed its own return and silently DROPPED
conductorTick's `prCandidates` (the completing tick logged no PR-FLOW line);
(2) **Fix 3** (lens-1 F4's residual, live-confirmed by verify tick
35298996619): the QUIESCED early-return preceded the PR flow — a halted
epoch's PRs would never open. Both folded + pinned (410/410).
The verify ticks then opened **PR #8** (`tasks/X22-REPORT2` → main, the
PAT ladder — GITHUB_TOKEN 403'd, the LAB_PAT lane carried it; body = accept
criteria + result digest + the transcript pointer) and stamped `pr: 8` in
state. The artifact is real content the CC turn wrote (it read the repo
context and produced a coherent status report).
X22-final (issue #9, chain c-1789698520934): **GREEN in ONE PASS** — the
completion comment carries the result digest AND "**Pull requests**: task
`X22-FINAL` → PR #10" on the same tick-set; PR #10 opened + stamped. The
loop criterion (issue → door → cc epoch → artifacts → PR → completion
comment with the link) is closed.

## X23 — the budget-pause live proof (2026-09-19, session 19)

**The PARK half is LIVE-PROVEN in the multi-task shape; the resume arc ran with
one honest wrinkle (a straggler re-pause).** The wall was engineered honestly:
kasulty's fresh 1000/day free-model quota burned to the day-wall
(`free-models-per-day-high-balance`, X-RateLimit-Remaining: 0) at 00:07Z, then
`EPOCH_MODE=cc` + console `reset` birthed the 8-task epoch (reset comments
5737684542/5737690584 on ops issue #1).

- **Arc 1 (single-task, issue #11, chain pre-midnight):** the infra-retry ladder
  held perfectly — 3 dispatches, 2 infra retries, both quota reports captured in
  `budget_window` (`lane-exhausted(3/6 lanes, last lane-429)`), task QUARANTINED,
  epoch closed degraded-halt, zero uncontrolled burn (worker logs: 11 CC-CLI
  retries per attempt, ~9min grind each, clean `infra_failed` classification —
  the X21 burn-class is dead). **Finding: a single-task epoch halts BEFORE the
  pause can fire** (the trigger's `!halted && phase!=='done'` gate — by design,
  nothing left to protect). The park proof needs the multi-task shape.
- **Arc 2 (the complete proof):** the 8-task cc epoch dispatched 4-parallel into
  the wall at 00:11Z; THREE DISTINCT tasks' quota infra-reports landed inside
  the 15-min window (00:19:32) → the count trigger fired → **alert issue #12
  opened FIRST** ("[fsm-alert] lane budget exhausted — epoch parked") → the
  pause CONTROL landed (`budget_pauses: 1`, chain `paused: true`, project
  `executing` — alive) with **4 backlog tasks PROTECTED** (the burn stops at
  exactly the protection point the design promised).
- **The operator remedy + resume:** `OPENROUTER_API_KEY` rotated to the
  ansgauretychis-B lane (fresh 1000/day — the credit reality: kasulty
  $10/$10.38 overdrawn, ansgauretychis-B $9.997/$10 spent, both free-lane-only
  keys) + the remedy recorded on the alert issue (comment 5737850985) + console
  `resume` (comment 5737851388, 00:29:59Z) → the re-dispatched workers ran
  REAL turns on the fresh lane — **T-101 done in 202s** (run logs: pure 200s on
  dots-studio after a session of pure 429s — the lane swap verbatim in the
  bridge lines).
- **The wrinkle (recorded honestly):** a SECOND pause fired
  (`budget_pauses: 2`) from straggler infra-reports landing just after the
  resume (the first batch's 9-minute grinds were still in flight when the
  window cleared — their reports re-populated the window post-resume). The
  at-least-once drain kept consuming reports while parked (T-101's done + 2
  work_failed + 1 poison landed) — the chain held correctly through both
  pauses. Resume #2 at 01:19:20Z (comment 5738198340) drains the backlog 4.
- Final tally (to be amended at halt): 1 done / 2 work_failed / 1 poison / 1
  quarantined (arc 1) / 4 backlog draining; `budget_pauses: 2`; zero burn
  beyond the bounded retry ladders.

**Machinery verdict: the lane-budget pause is live-proven end-to-end in its
designed shape (alert-first → pause → protection → operator remedy → resume →
real work completes).** The straggler re-pause is a benign race (the window
persists across a resume that races in-flight grinds) — candidate polish for
the W-D review round: clear the window only after the in-flight cohort's
reports drain, or accept the double-resume as operator routine.

**Session-close amendment (01:44Z):** the epoch is STILL DRAINING at session close — M2 unlocked (4 ready + 4 assigned) after M1's terminals: the chain is alive and progressing post-resume (the resume→work-completes half beyond T-101: milestone advancement is the structural proof). The dots-studio lane quarantines honestly on the harder tasks (`error_max_turns` — weak-model symptoms, exactly what the W-D model swap fixes). Next session records the final halt tally. EPOCH_MODE restored to 'mock' at 01:45Z (mid-flight safe — mode is baked at genesis).

## X26 — the concurrent-overflow live proof + THE CROSS-ORG CRACK (2026-09-21, session 21)

**The setup:** main @ 6af1fa3 (C-1/C-2/C-3 all merged — the union verification, the pre-flight overflow target, the straggler gate), the mirror fast-forwarded to the same tree (full worker-code parity for the first time), full secret parity both buckets (LAB_PAT + the key pool + KEY_2 + or-074), live vars `WORKER_OVERFLOW_AT=1` + `WORKER_REPO_2=agentrunners/fsm-lab-workers`, `EPOCH_MODE=mock` (the cheap drill mode), chain halted+quiescent (the X23 close). The reset fired via the ops issue **#1** (the `OPS_ISSUE` var is ABSENT on main → the default '1' is the live value — the first attempt fired on #3 (the duty-alert issue) and the console correctly went CONSOLE-SILENT: the m-8 fail-closed gate works, no queue burn).

**The arc (journal c-1789971997876, all timestamps live):**
1. `06:26:37` — CONTROL reset consumed → the multi-task epoch births (8 tasks) → first multi-assign tick (T-101 + T-102/T-107/T-108).
2. `06:28:21` — **DISPATCH-OVERFLOW-PREFLIGHT task=T-103 in-flight(3>=1) -> agentrunners/fsm-lab-workers** — the C-2 fix's pre-flight decision fired LIVE on its first real multi-assign tick: exactly ONE dispatch attempt, straight to bucket 2, the same-repo attempt skipped. (Conductor run 35568632604.)
3. `06:28:55` — **DISPATCH-FAILED task=T-103 HTTP=404** — THE CRACK: the dispatch lane's PAT (`LAB_PAT` = the minimal-scope runtime identity zikomolapoutl) has only READ on the mirror (an outside-collaborator carryover from the X25 era) — repository_dispatch needs write. The org-admin PAT dispatches fine (probed 204) — the lane's runtime identity was the gap. The 20-e era probe had used the orchestrator's PAT from the sandbox, so this seam was NEVER live-tested until now — exactly what the drill existed to catch.
4. **The live fix (06:31-06:34Z):** org-admin grants zikomolapoutl `write` on the mirror (invitation 333941981) → the invitee identity ACCEPTS it via its own PAT (`PATCH /user/repository_invitations/333941981` → 204) → the runtime PAT's dispatch probe returns **204**. The lane is open.
5. `06:39:11` — the law-4 union verification (C-1) catches the 404'd dispatches exactly as designed: the unverified tasks flip to `infra-retry` (net-zero — the work ladder never burned) and re-assign.
6. `06:39:14-49` — **THE OVERFLOW MOMENT**: the mirror's worker.yml runs `task-T-102 · flaky · a1`, `task-T-104 · succeed · a1`, `task-T-107 · dup · a1`, `task-T-102 · flaky · a2`, `task-T-108 · slow · a1` — real X26 tasks dispatched via the conductor's PAT lane, run on bucket 2's 20-parallel capacity.
7. `06:39:45` — **THE ROUND-TRIP**: T-104 + T-107 REPORT `done` on MAIN's fsm-state — the mirror workers checked out TARGET_REPO, ran the turn, and CAS-appended their reports to the MAIN chain (T-107's dup-report absorbed by the dedup ring: `REJECTED duplicate`). The union verification saw the mirror runs — ZERO dispatch-unverified flips on bucket-2 tasks (C-1's exact failure class, dead).
8. The epoch continues draining (6 done / 2 assigned at seq 42, M1→M2 rollover in flight) — the full halt tally lands in the next state read.

**What X26 proves (the last unproven seam, closed):**
- The overflow lane END-TO-END: pre-flight decision → PAT cross-org dispatch → mirror worker seat → TARGET_REPO checkout → report round-trip to main → union verification → terminal states. The capacity multiplier is REAL.
- The C-2 fix live: exactly one dispatch per task (no double-dispatch on the both-buckets shape).
- The C-1 fix live: bucket-2-only runs are SEEN by the law-4 scan (no false infra-churn).
- The failure machinery live: a genuinely-broken dispatch lane self-heals through net-zero infra retry + law-4 verification + re-dispatch — zero work lost, zero ladder burn, the chain never stopped.
- The m-8 fail-closed console gate live: a command on the wrong issue is silently ignored (no queue burn, no false epoch).

**The residual recorded honestly:** the write-invitation acceptance was a one-time operator action; the LAB_PAT identity now holds write on both buckets (its blast radius grew — noted for the PAT-scope-audit duty). The mirror's OWN conductor/consumer duties woke on my two probe dispatches and quiesced harmlessly (its own fsm-state is a halted chain — no cross-talk).

## W1 — the key-jump live verification + THE SINGLE-FUNDED-KEY FINDING (2026-09-22, session 22)

**The setup:** main @ the s22 fold merge (CI green #6), the chain halted+quiescent (the X26 close), the CC lane deployed [OPENROUTER_API_KEY, OPENROUTER_API_KEY_2]. The drill: swap the primary to the dead-401 or-027, run single-task mode:cc epochs (T-W1 via intake issue #16, T-W2 via #17 — the rollover consumed each on the halt), watch the lane ladder.

**The arc (three worker runs, all live):**
1. Lane 1 (k1 = or-027, dead): the CC CLI's bridge calls 401 ("User not found") ×12 retries → `CC-LANE-EXIT rc=1 api_error_status=401`.
2. **THE KEY-JUMP FIRED** (the s21/W1 fix's first live proof): lane 2 = k2 — NOT k1's next model. The pre-fix key-major flatten would have burned every lane on the dead key (the designed-but-unreachable failover); the observed ladder rotated the KEY exactly as designed.
3. Lane 2 (k2 = or-075, the deployed KEY_2): **402** ("This request requires more credits... You requested up to 32000 tokens") — THE FINDING: the landing key was DRAINED (~$0.002 left). Lane 3 (k2 + glm-5.3-flash): 402 again (the ladder's second model is ALSO paid).
4. `WORKER-DONE outcome=infra_failed` — the lane-exhaustion class, NET-ZERO (attempts stayed 1 through three runs: the infra-retry ladder re-dispatched twice, then the infra-exhaustion QUARANTINE landed with the distinct audit detail `lane-exhausted(3/6 lanes, last lane-402)`). The task never burned a work attempt; the chain never stopped.
5. **The telemetry**: every report carries `key_index: 1, pool_size: 2` — the O-3 carry renders the SERVING key's index; the jump is VISIBLE on the console's LANE line without reading run logs.

**The remediation live (mid-drill):** KEY_2 or-075 → or-082 (probe-verified 200 on deepseek) — but T-W2 (the complete-arc attempt, fired after the swap) STILL 402'd: **OpenRouter's pre-flight is max_tokens-proportional** — the CC CLI requests max_tokens=32000 (~$0.019 max cost at deepseek completion pricing); or-082's account holds ~$0.01 (passes at max_tokens=16, 402s at 4000). The probe matrix: or-074 32000→200 (the ONLY funded key, ~$8.8); or-082 32000→402, 4000→402, 16→200; or-075 hard-402.

**What W1 proves:**
- The KEY-JUMP mechanism END-TO-END: 401 on lane 1 → the key rotation → lane 2 on the SECOND key (the report's key_index=1). The W1 fix is live-green.
- The infra-failure machinery: net-zero retries (attempts 1 through 3 runs), the infra-exhaustion quarantine with the distinct audit detail — zero work-attempt burn, the chain never halted mid-drill.
- The O-3 key/pool telemetry renders the failover from the journal alone.

**THE OPERATOR FINDING (the drill's real catch):** the fleet has exactly ONE funded paid key (or-074, ~$8.8 — the CC lane's only servable lane). The 2-key failover is mechanically real but economically SINGLE-POINT: or-075 (~$0.002) and or-082 (~$0.01) both fail the 32000-token pre-flight. The redundancy needs a FUNDED second key (a top-up — the operator's action, recorded in OPERATOR-ACTIONS). Candidate code improvement noted in PLAN: the CC ladder's free-model tail (a last-resort lane ANY key can serve — the pre-flight is $0 at free models).

**The residual recorded honestly:** the drills ran with the primary swapped dead for ~50 minutes (14:49-15:45Z); the swap + restore are both 204-verified; the T-W1/T-W2 epochs are quarantined-terminal on the chain (the failure-machinery's own design); the EPOCH_MODE var stayed `mock` (the envelope's per-task mode:cc drove the CC lane — the per-spec mode precedence working as designed).

## X27 — the capacity soak at the retuned ceiling + THE LAB_PAT EXPIRY CRACK (2026-09-22, session 22)

**The setup:** main @ the B-1 merge (the multi-task door + the spec-level capacity knobs — CI green #6+), the mirror synced to the same tree (37adf91), `WORKER_OVERFLOW_AT` retuned 1→13 (the a7 verdict's posture), the chain halted+quiescent (the W2 close). The drill: the multi-task spec (24 tasks — 16 fast + 4 infra-flaky + 2 dup-report + 2 tail) carrying **`max_parallel: 16` + `overflow_at: 13` + `lease_minutes: 45`** — the B-1 spec-level knobs' FIRST live use (the door accepted the tasks: form; the v1 attempt's `work_ms` keys were correctly REJECTED by the door — the durations are the shim's own vocabulary, not operator-settable).

**The arc (chain c-1790096866488 v1 → c-1790097396865 v2):**
1. The rollover consumed the spec (issue #19); the genesis carried the knobs verbatim (config: max_parallel 16, overflow_at 13, lease 45 — the specCapacity carry's live proof).
2. **THE SATURATION**: the first multi-assign ticks drove 16 concurrent worker runs on the MAIN bucket + **6 overflow runs on the MIRROR** (T-X27-14/15/16/21/22/23 — the pre-flight overflow arm firing at in-flight ≥ 13 exactly as retuned). 22 concurrent worker runs across 2 buckets — the ~5x ceiling LIVE (the X21-era posture was 4).
3. The 4 infra-flaky tasks' first reports (lane-429 details) armed the F-6 budget window → **the budget-pause fired mid-saturation** (alert issue #12 opened, alert-first, the epoch parked cleanly) — the pacing machinery working at the new posture.
4. **THE OPERATOR INCIDENT (recorded honestly)**: the orchestrator misfired a `reset from_queue` (a stale helper default) at 17:12 — it WIPED the v1 epoch at its saturation peak (the plain reset births the mockProject M1). The v1 evidence survives in journal-16 (the 16+6 concurrent runs + the overflow dispatch ledger). A v2 refire (issue #20 + a deliberate reset from_queue) rebuilt the epoch with the same knobs.
5. **THE CRACK (the drill's real catch): THE MIRROR LANE'S LAB_PAT DIED** — the mirror workers' TARGET_REPO checkout failed `Bad credentials` (the zikomolapoutl classic PAT, secret-set 2026-09-06, expired/revoked between the X26 proof 09-21 and now). The main-side dispatch PAT still works (the overflow dispatches landed); the mirror-side checkout token is the broken half. The stuck tasks ran the full machinery: law-4 verification → infra-retry (net-zero) ×N → the ladder exhausted → 4 QUARANTINED (the fail-loud terminus) + the budget-pause re-cycling on the churn.
6. **The interim live fix**: the mirror's `LAB_PAT` re-set to the working org-admin PAT (204) — the overflow lane restored; the re-dispatched tasks drain post-fix. **The operator residual: re-mint the minimal-scope zikomolapoutl PAT and revert the mirror's secret** (the admin PAT on the runtime lane is the documented blast-radius trade — acceptable for the drill's completion, rotation debt recorded).
7. **A machinery quirk characterized**: the fresh post-reset epoch re-paused 3s later — genesis does NOT initialize `budget_window`, and the dead epoch's straggler reports (REJECTED unknown-task, lane-429 details) armed the fresh chain's window. The pause inherited the predecessor's quota noise (the safe direction, but a candidate fix: REJECTED unknown-task records never arm the window).

**What X27 proves:**
- The retuned posture LIVE: 16-parallel on the main bucket + the pre-flight overflow at 13 to the mirror — the capacity multiplier at its characterized ceiling.
- The B-1 door + knobs END-TO-END: the 24-task spec accepted, the capacity carried into the genesis config, the epoch ran at the spec's own posture while the repo var moved independently.
- The CAS storm at 16-parallel: the dup-report tasks' double reports absorbed; the report queue drained cleanly through the saturation.
- The failure machinery under real lane death: law-4 → net-zero infra-retry → quarantine (4 tasks), the budget-pause cycling on the churn — every safety layer fired as designed, the chain never wedged.

**The residual recorded honestly:** the epoch ends DEGRADED (the 4 quarantined tasks were the infra-flaky quartet × the dead mirror lane — the quarantine is the correct verdict for a dead lane). The v1 wipe was operator error (the orchestrator's misfire — the reset command's blast radius is real; the twin-guard/dedup machinery absorbed the report storm, and the REJECTED unknown-task records prove the fresh chain's fail-closed door).

## s23 — the production-grade round closed (2026-09-23, session 23)

**The session that closed every open build item: the W1 key closure, all six
stress batteries, both documented-RED e2e scenarios, the genesis-window and
LATCHED fixes, the stage-0 first GREEN, and the CC free-model tail — main
@c722fcee, 606/606, nine session-23 branches merged.**

**THE W1 KEY CLOSURE (the funded second key):** the principal's re-issued keys
probed live through the relay — or-084 (srbuhiartur73, $5.76 remaining) passes
the 32K-token pre-flight on the REAL surface and is **deployed as `KEY_2` on
BOTH buckets**; or-074 ($8.88) stays the funded primary. The pool re-fronted:
or-079/or-082 re-tiered elevated-free (1000 free req/day each) → **3 elevated
+ 68 free = 71 keys**. The standing model constraint recorded in
OPENROUTER-KEYS §S23: paid models ONLY on the two approved keys, else `:free`.
**The probe protocol note (a real catch):** the relay is POST-JSON-spec — a
direct-style querystring call 401s; the first probe's all-401 was a PROTOCOL
error, not key death. Registry + §S23 pushed (cc-gha-exploration @ 0b3c4b9/2f7040b).

**THE FIX WAVES (the s22 remainder, all landed on main):**
- **The genesis `budget_window` init + REJECTED-never-arms** (ff9f6ab1, the
  X27 finding's candidate fix): genesis now initializes `budget_window:[]` +
  `budget_window_cleared_at` (an epoch boundary IS a window-clear boundary;
  predecessor stragglers are cohort-gated), and the drain's wasRejected gate
  covers BOTH the window push and the infra-exhausted backstop latch — a
  quota-shaped report for an UNKNOWN task never arms the fresh epoch's pause.
  5 pins incl. straggler-stamp-at-genesis + rebuild parity; 3 mutations bite.
  **The X27 re-pause class is dead on both arms — live-proven in X28 below.**
- **The LATCHED-body class fix** (2bac884f, the battery-4 finding): the latch
  alert's marker body now carries the dedup class token (`**[fsm-watchdog]**
  LATCHED — …`, class-first); the old `**[fsm-watchdog LATCHED]**` shape did
  not contain the alertDedup filter's substring, so a sustained latch posted
  ~12 alert comments/day instead of the F-D 24h-dedup contract. 2 pins,
  mutation-verified.
- **BOTH documented-RED e2e scenarios GREEN** (1f97b664 + 87a75a28): the
  overflow UNION-VERIFY root causes — (1) the until-predicate
  `cRuns[last].status === 'completed'` is PERMANENTLY FALSY on a live chain
  (the conductor POSTs its next self-tick dispatch BEFORE exiting, so the
  newest ledger entry is always queued/pending); (2) the ghapi stand-in's runs
  route passed the URL's workflow FILE id (`worker.yml`) to a provider keyed
  by the bare NAME (`worker`) — every runs page empty forever, masked by the
  fail-open design; (3) the fixture backdated only `issued_at` (an impossible
  lease — expires is always issued+lease). The budget-pause scenario's first
  full run: the seed's `lease_minutes: 2` = the s22/B-1 trap value (floor 3)
  and the alert filter re-pointed from the generic `[fsm-alert]` body to the
  BUDGET alert's distinctive `Lane budget exhausted` token. All drill-side,
  zero production changes; 3-seed stable; 577/577.

**THE STRESS BATTERIES — ALL SIX COMPLETE (a6 §6.1 fully landed):**
- **soak30d 22/22** (d1431c4a + d0287442) — **THE HEADLINE: current windows
  (pinger 300min, deadman 300min, imported from lib/pinger-watch.mjs) ⇒ ZERO
  false alarms over 30 virtual days at the MEASURED [120,247]min cadence; the
  OLD windows (45/180min) ⇒ N=1223 (pinger 1079 + deadman 144)** — the
  A-1/R2-1 before/after number the audits demanded. State bytes 16.5-17.2KB
  over the span (PRUNE + rotateAt=500/keepGens=4 honored), zero false latches
  (the sabotage-window TRUE latch fires AND releases), the deadman throttle
  mechanics pinned, the dead-pinger true-alarm control caught same-day.
- **journal-flood full-mode 24/24** — the cycles calibration (98→105: the
  ≥20-rotation boundary undershot at 19; per-cycle records run ~99) + **lane C
  re-pointed at the PRODUCTION template** (sourced live from
  watchdog/scan.mjs — the s23/latch fix's battery-level regression coverage,
  the OLD shape kept as the BEFORE record).
- **chaos quick 13/13** (cfa225d1, battery 6/6) — the KillScheduler
  (seed-pure 5-boundary schedule: worker-pre-report, conductor-post-commit,
  worker-report-push, worker-post-taskbranch, conductor-mid-PR), the full
  mode's 18-task / 50-seeded-kill shape with firedFloor ≥24 and all five
  boundaries exercised: **zero lost reports, zero double-applied reports,
  every task exactly-one-terminal, every wedge recovered via lease-reap**
  (assigned-but-never-dispatched attempts later TIMEOUT-reaped), every done
  declared-artifacts task PR-stamped in the journal (the B5 reuse-lane
  recovery). The build's own lessons: the emission ledger = the
  QUEUE-LANDING COMMITS not run logs (SIGKILL loses buffered stdout); the
  range-read for buried commits; numeric run-id coercion; per-ATTEMPT terminal
  invariants when retries are designed.

**THE CC FREE-MODEL TAIL (the W1 candidate improvement, built + merged):**
the cctail design (research/s23-cc-tail.md @ 54073ff5 — 45 live relay probes,
$0 spend) adjudicated the attach point: **the tail is ALREADY in the chain —
the defect is the KEY-JUMP's no-next-key fallback burning the final slot on
the dead key's paid sibling.** B1-B10 landed (baab4a7 + efa60cbd + 56c16abd):
the free-tail rule in ccNextLaneIndex (the LAST key's key-class failure scans
forward in the same key block for the first `:free` lane, skipping the
credit-dead paid siblings), `CC_TAIL_MODEL` (default nemotron:free, the
`:free` hard rule with LOUD validation, the escape hatch restores the
pre-s23 ladder byte-identically), `lane_class:'free-tail'` telemetry + the
console `lane tail:` line, **the FREE-TAIL RIDING alert (N=3/X=15min,
ALERT-ONLY — the tail SERVES work at $0; parking would convert
degraded-but-alive into stopped)** through the fsm-watchdog-alert lane, and
**the real-lane dead-slug removal** (deepseek-v4-flash-0731:free is
404-DEAD upstream on every key class; cohere/north-mini-code:free promoted
to slot 2 — the probe's 6/6 reliability pick). 603/603 + conformance 31/31 +
M1/M3 mutations bite (6 / 2 pins).

## The stage-0 ADOPTION — the first GREEN (2026-09-23)

**Five attempts to first green, four real runner-caught bugs — the drill
adoption arc that proves the CI-existence theorem at its strongest: a gate
that runs where the merges land catches what the sandbox never sees.**

**The adoption setup:** drill issue **#21** created (org-admin author — the
door's author gate rides it) + `vars.DRILL_ISSUE=21` set; the seed reopens it
nightly with the dated spec. `STAGED_DRILL_ENABLED` stays UNSET (manual mode)
— the nightly ladder earns its promotion with dated greens (3 needed).

**THE FOUR RUNNER-CAUGHT BUGS (attempts 1-5):**
1. **Attempt 1 — verify.mjs's unimported `fileURLToPath`** (af230820): the
   report-writer path used it without importing it — a RUNNER-ONLY class (the
   unit pins test the pure functions; the `invokedAsMain` guard kept the path
   cold under `node --test`, so 606/606 in the sandbox meant nothing for the
   CLI-entry path; the runner's verify job died `fileURLToPath is not
   defined` on the first manual fire). Fix: the import + the FAMILY GUARD pin
   (every fileURLToPath/pathToFileURL usage in e2e/staged/*.mjs must carry
   its node:url import — generic for the whole driver family),
   mutation-verified.
2. **Attempt 1 — THE NEEDS-CHAIN GAP** (aee4318e): GHA job outputs are
   readable ONLY by DIRECT needs members — the teardown's `needs:[verify]`
   left `needs.run.outputs.seeded` EMPTY (a transitive read is a silent
   empty string) → the seed-no-output misclassification on a seed that RAN
   and birthed an epoch → the stuck-recovery reset SKIPPED on a live epoch.
   Fix: `needs:[gate, run, verify]` + the exported `RED_FAMILY_ACTIONS`
   {red, gate-read-red, seed-no-output} gating the recovery arm. 3 pins, 2
   mutations bite.
3. **Attempt 3 — THE RESTING-SHAPE RACE + THE QUEUED-DISPATCH WINDOW
   INFLATION** (f07fb529 + df7d0818): the monitor's first poll (seed+1s)
   declared DONE on the PREDECESSOR'S halted resting shape while tonight's
   epoch was 4 seconds from birth (the door+rollover latency band ~15s) —
   fixed with the birth-wait hold (max(2×poll, 120)s). AND the verify's
   window anchored at `github.run_started_at`, which sat 59 MINUTES in the
   shared bucket's queue (run_started_at preceded the epoch by an hour): the
   predecessor's records smuggled into the window and the wall inflated to a
   false 60-min stuck verdict on a seconds-old epoch → the teardown's
   stuck-recovery reset wiped a HEALTHY epoch. Fix: the genesis-anchored
   window (the journal boundary's ts) + haltExitAllowed. The teardown's
   RED_FAMILY recovery itself worked exactly as designed — the machinery was
   right, the verdict's inputs were wrong.
4. **Attempt 4 — THE A11 WATCHDOG-CADENCE lesson** (d0b11ffe + c722fcee):
   A11 asserted `>=1 watchdog run completed in-window`, calibrated to the
   NOMINAL `*/10` cron — the watchdog's MEASURED cadence on this repo's
   bucket runs 4-5h gaps (live: 00:51 → 05:20 → 10:07). **The A-1/R2-1
   cadence law's THIRD recurrence — this time on the verify's OWN
   assertion** (the same law that recalibrated the pinger and the deadman).
   Fix: the 6h liveness lookback ENDING at the drill's end (measured 4h47m
   max + ~1h headroom, the R2-1 rule); the alert-free half stays strictly
   in-window. 11/12 → 12/12.

**The duty-8 breaker gate (the adjacent catch):** issue #24 (the work-lane
breaker alert) fired at 09:53 on the drill epoch's TERMINAL state
(timeouts=3 done=0 ratio=1.000 — an hour AFTER the halt): every stage-0 hang
night would page on the epoch's designed final record. The breaker (executor
@ 2bb0435) now gates on HALTED/PAUSED chains — a halted chain cannot churn;
its stats are the epoch's final record and the completion digest already
carries the verdict. #24 closed not-planned with the explanation.

**THE VERDICT — run 35852711826** (fired 11:07:29Z @ c722fcee, completed
~11:59Z): all four jobs green (gate 10s, run, verify, teardown). **`STAGED-DRILL-VERIFY
GREEN asserts=12/12 failed=[] stuck=false wall=46min`** — the arc as designed:
MONITOR-BIRTH-WAIT 120s held the halt-exit through the predecessor's resting
shape; the T-STG-H-0923 hang epoch ran its FULL ladder (3 timeout attempts →
quarantined → halted DEGRADED-clean — **the hang night's honest degraded
shape: 0 done + 1 quarantined + phase degraded=true**, asserted as the
expected verdict, not an error); VERIFY-WINDOW genesis-anchored
start=11:08:22 (the queue delay excluded); STAGED-DRILL-HALT-HELD yes. The
**GREEN marker posted on #21** (`STAGED-DRILL GREEN · 2026-09-23 · wall 46
min · tasks 1 · asserts 12/12 · watchdog green`); the drill closed its own
issue (#21, HTTP 200) and the stale RED #23 auto-closed at 11:55:41Z
(RED-AUTOCLOSE swept the stale fsm-staged-red backlog).

**Stage-0 is adopted: the nightly now self-verifies, self-cleans, and posts
its own marker — 1/3 dated greens toward the weekly promotion
(`STAGED_DRILL_ENABLED=weekly` when 3/3).**

## X28 — the clean retuned-posture soak (2026-09-23)

**The X27 refire with the fixed variables isolated: the mirror lane restored,
KEY_2 funded, the genesis window init. 24 tasks at `max_parallel:16 /
overflow_at:13 / lease:45` through the door — the specCapacity carry verbatim
into the genesis config (CONTROL e3976 @ 12:00:41.599Z, issue #25). Epoch
c-1790164841598: 12:00:41 → 12:12:26 halt, ~11m45s wall.**

**THE SATURATION + PEAK CONCURRENCY:** the first multi-assign tick (16 tasks)
dispatched **13 runs on the MAIN bucket + 3 on the MIRROR** (12:00:45-48) —
the pre-flight overflow arm firing at the in-flight ≥13 boundary exactly as
tuned; the second tick's 8 tasks → 7 main + 1 mirror (12:01:20-22). **Peak: 16
concurrent FSM task-runs across the two buckets (13 main + 3 mirror at
12:00:48-50) — the main bucket never above 13, the ceiling exactly
max_parallel=16.** Total: **32 worker runs = 28 main + 4 mirror, EVERY ONE
completed success.**

**THE FIXED-LANE PROOF (the X27 isolation):** X27's mirror workers died AT
CHECKOUT (`Bad credentials` — the expired LAB_PAT; the shim never ran, no
mirror reports ever landed). X28's mirror workers (runs 35857865113/65195/65706
+ 35857923738) ran END-TO-END: clean checkout → the full envelope (OX_RAW
T-X28-15: budget, mode mock, attempt 1) → the shim turn → the report landing.
**The mirror runs' existence + completion IS the proof** — the overflow lane
carries real work again (the mirror's LAB_PAT = the org-admin PAT interim,
rotation debt recorded).

**THE ARC:**
1. **Genesis clean 77s** — no birth re-pause (the X27 v1→v2 quirk: the fresh
   epoch re-paused 3s in on the dead epoch's straggler noise; the s23
   genesis `budget_window:[]` init + cohort gate held — the pause that came
   was armed by THIS epoch's OWN reports).
2. **The budget-pause, alert-first, mid-saturation** — the infra-flaky
   quartet's first reports (the shim's designed `lane-429` class, all lane
   attempts burned) put 3 distinct tasks inside the 15-min window ≥ threshold
   3: conductor run 35857953845 logged `BUDGET-PAUSE-TRIGGER distinct-tasks
   3>=3 — alert-first` (12:01:50.438) → the alert comment on the STANDING
   fsm-watchdog-alert issue **#12** → `BUDGET-PAUSE applied (alert issue #12)`
   (12:01:59.642). The epoch PARKED at done=18/24 for ~9m24s — the at-least-once
   drain kept consuming while parked (the tail pair + stragglers landed
   12:02:00-12:02:15, done 18→20).
3. **The operator resume** (23-wrap): `fsm-control {command:resume}` (204) →
   CONTROL e4029 @ 12:11:22.087 (actor xfnwfpho1) — plus a benign
   double-consume (e4042, two conductor runs processed the same dispatch
   event 17ms apart — the X23 straggler-race family, idempotent).
4. **The quartet's ladder drained to its DESIGNED terminus** — the re-dispatch
   envelope carries `attempt:1` (net-zero: the infra retry never burns a work
   attempt; verified in run 35857942510's OX_RAW), so the shim's infra-flaky
   contract (infra_failed on attempt ≤1, done on attempt 2+) re-failed each
   re-run: INFRA_RETRY_MAX=3 total → **4 QUARANTINED
   (`infra-exhausted(infra_attempts=3)`, attempts never past 1, 2 net-zero
   retries each — infra_retries=8)**. This is the X23 arc-1 shape verbatim
   ("3 dispatches, 2 infra retries, task QUARANTINED, epoch closed
   degraded-halt, zero uncontrolled burn") — NOT a lane death: all 32 runs
   green on both buckets.
5. **The dup-report pairs absorbed:** T-X28-21/22's second reports REJECTED
   `duplicate` (2 journal records, event_ids intact) — and the
   **REJECTED-never-arms gate held live: NO second pause through the
   post-resume drain (budget_pauses stayed 1)** — the X27 re-pause class dead
   on its second arm too.
6. **The halt verdict:** PHASE executing→done @ 12:12:26.175 — **done=20/24,
   quarantined=4, failed=0, timeouts=0, dispatched=32, infra_retries=8,
   budget_pauses=1, rejected_events=2, orphaned_reports=0**; the completion
   digest posted on #25 (12:12:29). `tail_turns` ABSENT (the CC-lane-only
   metric — the mock epoch never touches the lane; the expected honest
   marker).

**THE HONEST ISOLATION VERDICT:** same quarantine COUNT as X27 (4), OPPOSITE
mechanism — X27's 4 were the quartet × THE DEAD MIRROR LANE (workers never
ran); X28's 4 are the quartet × THE DESIGNED infra-flaky contract on LIVE
lanes (the workers ran and reported the shim's own failure class, the ladder
drained net-zero to the fail-loud terminus). The isolation is proven by the
mirror runs themselves, not the terminal count. **The finding recorded for
future specs:** a "quartet drains green" expectation is unreachable for the
mock infra-flaky class under the net-zero ladder — the class's live soak
terminus IS the infra-exhaustion quarantine unless the lease burns (attempt 2
needs a 45-min expiry in a 12-min epoch); a drain-green shape would need the
shim keyed on infra_attempts or a lease-burn spec.

**What X28 proves:** the retuned posture LIVE and clean — 16-parallel
saturation with the overflow arm at 13 routing real work to a LIVE mirror
lane; the budget-pause machinery end-to-end in its designed shape
(alert-first → park → protection → operator resume → drain); both X27 pause
quirks dead (genesis init + REJECTED-never-arms, live-proven); the dup-report
CAS absorbing doubles at saturation; and a DEGRADED-CLEAN halt with zero
timeouts, zero orphans, zero uncontrolled burn.

## s24 — the cohere tail flip (2026-09-24)

**THE LIVE EVAL** (results JSON: `scripts/s24-cohere-tail-results.json`, 12
probes, 2026-09-24T02:11Z): `cohere/north-mini-code:free` **6/6** — every
probe a 200, across 4 key classes on the 32K pre-flight (or-079
kasulty-overdrawn, or-083 zikomolapo-drained, or-082 ansgauretychisB-3mill,
or-001 free-tier — including the DRAINED and OVERDRAWN keys the tail exists
to serve) plus the two turn-shaped content probes (STATUS-OK answers, 4.2s
and 9.5s, 579-in/173-out and 579-in/649-out) — ZERO transport-class
failures. `nvidia/nemotron-3.5-lightning:free` **1/6** — 4× 500 (`INTERNAL`,
"The signal has been aborted") + 1× 504, with failure latencies 30-150s: the
500-tax ACTIVE and WORSE than the s23 probe's 2/6 (which the s23 design
§2.4's absorber arithmetic was sized against).

**THE PRE-REGISTERED RULE** (research/s23-cc-tail.md §7 open question 1):
s23 shipped nemotron as the default because "the verified surface beats the
unverified one — never CLI-evaluated" held then; the rule was to spend a
live eval on cohere and FLIP via `CC_TAIL_MODEL` if cohere won. The s24 eval
is that eval and cohere won on every axis (per-call health 6/6 vs 1/6,
failure latency, content-bearing turns). **Rule met → flip landed in code**
(this commit): `CC_TAIL_MODEL_DEFAULT` = `cohere/north-mini-code:free`
(worker/cc-adapter.mjs), the real-lane free chain REORDERED cohere-first
(worker/turn.mjs `REAL_MODEL_CHAIN_DEFAULTS` — nemotron demoted to second
choice), every conformance/pin surface updated. nemotron stays exactly one
`CC_TAIL_MODEL` env line away (the s23 swap mechanism — the B2 override pin
now demonstrates the swap on the demoted slug). The FREE-TAIL RIDING alert
body + the X=15min threshold arithmetic comment updated for the cohere
cadence. Gates: full suite + `scripts/validate.sh` + conformance-cc all
green at merge time (numbers in the commit/CI).

## x29-codex-smoke — the first live codex turn (2026-09-24)

**The datum: run 35996905777 GREEN ON THE FIRST FIRE — codex-cli 0.156.0
installed in 7s (`added 2 packages in 7s`, pin-asserted by the no-||true
gate), the B3 config rendered to CODEX_HOME=/home/runner/.codex-fsm
(wire_api responses · env_key OPENROUTER_API_KEY), ONE codexTurn through
the REAL worker machinery on the funded primary (or-074): content
`X29-SMOKE-OK` EXACT (the model obeyed the echo instruction to the byte),
status done, 1 lane / 1 attempt / 1 turn, lane 1774ms, whole turn 3.9s
including the transcript push.** The install path IS the dispatch path: the
workflow's codex-install step runs the worker.yml step's run body VERBATIM
(diff-verified at build time; the only seam difference is the OX_RAW source
— the dispatch-equivalent ox envelope `{"mode":"codex"}` feeding the SAME
gate parse), so the 7s + the version assert + the config render are the
numbers a real codex dispatch pays too.

lane_stats (the adapter's own usage × worker/codex/models.json synthesis —
recomputed, never an engine meter): **1 call, 1 ok, 9274 tokens, $0.000511
on deepseek/deepseek-v4.1-flash** — OFF-PEAK (Thu 12:05Z, outside the
01-04/06-10 UTC weekday windows) with a heavy prompt-cache hit fraction at
the 0.003 cache-read rate, which is why the number sits BELOW the
~$0.0016-0.004 pre-estimate (the estimate assumed a lighter cached
fraction): the live X29 economics are BETTER than planned — 24 soak turns
≈ $0.012 happy-path vs the $0.04-0.09 planning band. The transcript landed
on fsm-sessions (`sessions/T-X29-SMOKE/35996905777-a1.txt` + `.meta.json`,
commit 5008867) with `harness: "codex"`, `mode: "codex"`, `fake: false` —
the F15 engine-derived provenance proven LIVE, plus the full lane log
(lane 1: key#1 deepseek/deepseek-v4.1-flash rc=0 1774ms class=done).

**Zero catches, zero iterations.** The three pre-named first-failure
classes all held on the first fire: (1) the config.toml path — CODEX_HOME
reached the turn step's `process.env` through GITHUB_ENV exactly where the
adapter resolves it (no /tmp, no workdir pollution); (2) the `-m` slug —
`deepseek/deepseek-v4.1-flash` + `-c model_context_window=1000000` from
worker/codex/models.json matched OpenRouter's catalog slug exactly (no
error_model_400, no metadata fallback warning); (3) env_key auth — the D14
lane-key overlay rode the child env end-to-end with the 8-member denylist
dead (conformance-pinned) and the key never surfaced in a log line. The
honest residuals carried to X29: the smoke rode the SINGLE funded key
(pool_size 1 — a real dispatch carries both; lane rotation beyond key 1 is
conformance-pinned, not live-proven), the driver calls codexTurn DIRECTLY
(the routing arm's lazy import + the report-queue drain + the lease gate
stay the soak's surface), and node 22 (the worker lane's major — v22.23.2
on the runner) executed the adapter's `with { type: 'json' }` models.json
import cleanly, live-proving the worker-lane compatibility the B2 suite
could only pin locally on node 24.

## X29 — the codex-mode soak (2026-09-24, issue #26, chain c-1790252766608)

**THE MULTI-ENGINE CAPSTONE: the first `mode: codex` epoch — done 24/24, zero quarantined, zero failed, zero timeouts — the cleanest soak in the X-series** (X28: 20/24 + 4 designed-quarantined; X27: degraded on the dead lane). The epoch: 24 real codex turns at the X28 capacity shape (16/13/45), the intake door → the codex-mode genesis → the conductor dispatch → the worker's mode-gated codex install → the lane loop → reports → union verification → halt in **3 minutes 10 seconds wall** (12:26:11 → 12:29:01) — the fastest 24-task soak recorded (X28 took ~12 min for the same shape).

**The economics (journal-sourced, recomputed from usage × the verified prices)**: 34 engine calls (the 24 tasks + the 10 infra-retry re-turns), 417,507 tokens, **$0.0249 total** — $0.00104/task — at the retuned 16-parallel ceiling. Per-turn lane data: `deepseek/deepseek-v4.1-flash`, ~10K tokens/turn, ~2.6s lanes, `key_index: 0, pool_size: 2, mode: codex` on every report — **the D5/D6 lane machinery live-proven end-to-end** (the lane_stats synthesis into the EXACT shared aggregate; the console/journal/alerts consumed it unchanged).

**THE SOAK'S REAL CATCH — the fsm-sessions transcript-push race**: the first 16-parallel burst all pushed their transcripts to `fsm-sessions` simultaneously; the non-fast-forward losers got remote-rejected → classified `infra-retry(lane-unavailable, transcript-push-failed)` → re-assigned → **every one completed on the retry** (infra_retries=10, all absorbed — the net-zero ladder doing exactly its job). All 38 X29 transcript files landed on fsm-sessions by halt. THE POLISH ITEM (recorded for the W-D backlog): the transcript push wants the pull-rebase-retry discipline (or per-run subdirectory paths that never contend) — the race costs ~30% extra turns at the full 16-burst, absorbed today but pure waste at scale.

**The artifact write-back**: tasks/T-X29-22/23/24 branches pushed with the report.md artifacts (the declared-artifacts door). T-X29-21's branch is absent from the branch list — its artifact rode the workdir scan (the branch list shows 3 of 4; the 21st's report landed via the same-epoch retry — the branch-vs-scan split recorded honestly; all 24 report done regardless).

**The honest residuals**: tail_turns=0 (codex carries no :free tail — D4 by construction); the burst race above; single-bucket saturation (the overflow never fired at 16 in-flight with 45s leases — the mirror lane idle this epoch; the B3.5 parity is proven by the sync, not by traffic).

## s25 audit corrections — the X29 transcript split (the a1 audit)

**The X29 section above mis-describes where a quarter of the epoch's record lives — three claims corrected after the s25 raw-run audit (sub-agent 25-a1, the full findings table + the race forensics at `/home/z/my-project/research-s25/x29-run-audit.md`):**

- **(a) "All 38 X29 transcript files landed on fsm-sessions" → 36 on main + 12 on the MIRROR.** The epoch's own 48 files (24 done-runs × 2) are split 36 (main's `fsm-sessions`, 18 task dirs) + 12 (`agentrunners/fsm-lab-workers`'s `fsm-sessions` @ `3ad9f3f`, 6 task dirs — the branch was BORN during the burst, orphan genesis @ `0e7b37d` 12:26:30Z). The "38" figure mixed in the smoke pair (`sessions/T-X29-SMOKE`, 2 files): main's bucket holds 36 epoch + 2 smoke files. Zero missing — but 25% of the record sat on the repo this section never names.
- **(b) "the overflow never fired … the mirror lane idle this epoch" → 6 of 34 runs were served BY the mirror.** The overflow arithmetic fired exactly as designed (13+3, then 8+3, then 6+0, then 1+0 — `overflow_at 13` reproduced to the dispatch). Routing was correct; the ARTIFACTS split (see (a) + the F2 mechanism below). The mirror contributed 6 runs / 246 runner-seconds of real capacity.
- **(c) "T-X29-21's branch is absent from the branch list — its artifact rode the workdir scan" → the branch EXISTS, on the MIRROR.** `tasks/T-X29-21` @ `4a18173` (12:27:15Z, `task/T-X29-21: artifacts`) — pushed by mirror run `35999112244`; the branch list showed 3 of 4 because the 4th was on the other repo. (Ported to main by the orchestrator as part of the s25 data consolidation.)

**The mechanism (F2, verified first-hand): the runner silently ignores step-env overrides of `GITHUB_*` default names.** `worker.yml`'s Work step mapped `GITHUB_REPOSITORY: ${{ vars.TARGET_REPO || github.repository }}` — the step's env listing RENDERS the override in the log, but the spawned process keeps the runner's real `github.repository`. Live proof: mirror run **35999041887**'s log shows `GITHUB_REPOSITORY: claudecode-headless/fsm-lab` rendered AND `git push failed: To https://github.com/agentrunners/fsm-lab-workers.git` — the URL was built from `env.GITHUB_REPOSITORY` (`worker/codex-adapter.mjs`'s pushSessionsBranch; same for cc-adapter's pushTaskBranch). `GH_TOKEN` is NOT a protected name (its override DID work) — which is exactly why the split was silent: the pushes succeeded, with the PAT, against the wrong repo. Never live-caught before because the X25/X26 mirror drills were mode=mock (no transcript pushes). **Fixed in s25/b1: custom names are the only reliable seam — `FSM_SESSIONS_REPO`/`FSM_SESSIONS_TOKEN` (mapped from the same `vars.TARGET_REPO` gate), and the transcript push itself moved to the contents API (`worker/sessions-push.mjs`), which takes the repo as an explicit parameter.**

**The race numbers (F3), for the record: the 13-parallel shared-ref convoy re-turned 10 of 34 runs — $0.005701 (22.9% of the epoch's spend), 100,911 tokens (24.2%), ~341 runner-seconds of REDONE work** (every casualty's lane was `rc=0 class=done`; the retry-once absorbed 11 of ~21 collisions but exhausts inside the ~30s contention window). The per-run file paths never collided (already per-run since s24) — the shared BRANCH TIP was the contention. **Fixed in s25/b1: the transcripts push via `PUT /repos/{repo}/contents/{path}` — per-file server-side CAS, race-free at any parallelism.** The mirror bucket's 12 orphaned files + the task branch are ported separately (the orchestrator's data consolidation); the mirror's GC-less `fsm-sessions` (F7) follows in the backlog.

## s25 — the audit-and-soak round: X30 + X31 (the transcript-lane iteration, live)

**X30 — the codex soak v2 (the F2 seam validation, 2026-09-24 21:54Z, issue #28, epoch c-1790286919724)**: 24 tasks at the X29 shape (16/13/45, per-entry `mode: codex`), done 24/24 zero-quarantined in ~2m45s, $0.0148/24 turns. **THE F2 SEAM LIVE-PROVEN: ZERO refs on the mirror — every transcript landed on MAIN** (the FSM_SESSIONS_REPO custom-name seam; the old GITHUB_* override law). But the run caught the s24/b1 design's own wrong premise: the contents-API PUT is a server-side ref CAS, so the 16-worker × 2-file burst STILL storms the branch tip — 9/24 tasks exhausted the 3-attempt/5s ladder (409 "is at X but expected Y", run 36064447619's log) → infra-retry re-turns (the 22.9%-waste class persisting). The record: 57 files landed (48 + the 9 re-run pairs' partials), all on main.

**THE FIX (main @ 111a3516, built by the orchestrator same-session)**: the store's PROVEN de-sync ladder (SESSIONS_PUT_ATTEMPTS 3→10, backoff 250×(i−1) capped 2s, ±25% jitter — de-synchronized retries converge, tight loops starve) + **DEGRADE-not-retry on retryable exhaustion** (the turn KEEPS its done status + the note rides the summary; re-running a COMPLETED PAID turn to recreate a record is the waste class; PERSISTENT errors — 401/403/malformed — keep the fail-loud escalation) + the outer whole-set retry REMOVED (it re-fed the storm) + compact per-file errors (the status survives the downstream slices — the X30 journal carried the diagnosis-less "PUT(create) ->"). 684/684 + VALIDATE-OK×3 + conformance-codex 21/21; the degraded path pinned at THREE layers (the engine unit, the full-turn codex pin, the cc fake-mode pin).

**X31 — the codex soak v3 (the ladder validation, 2026-09-24 22:29Z, issue #29, epoch c-1790288989227)**: the EXACT same shape on the corrected machinery — **done 24/24, ZERO infra-retries (X29: 10, X30: 9), zero quarantined, dispatched exactly 24 (zero re-turns), $0.0146, 2m16s wall**. THE LADDER LIVE-PROVEN: the storm absorbed in-line. **The degraded path fired in production exactly as designed**: T-X31-03's .meta.json exhausted its 10-attempt ladder mid-storm → `CODEX-TRANSCRIPT-DEGRADED 1/2 file(s) landed` → the turn KEPT done (no re-run, no infra-retry) — the .txt landed; the meta was reconstructed post-hoc from journal event e4260 (the repair commit on fsm-sessions; every field journal-derived, the note documents the provenance). Honest residuals: the degraded note surfaces in the run log + the sessions tree but NOT the journal (the REPORT event shape drops summaries — a future polish: a janitor sweep or a journal field); the PUSHED-line blemish (the contradictory "PUSHED 2" + "DEGRADED 1/2") fixed @ 9c0e7d30 with its pin.

## s25 — X32: the CC twin lane's proof (2026-09-24 23:26Z, issue #30)

The codex lane carried X29/X30/X31's validation; **X32 gives the CC adapter the same transcript machinery's live proof** (24 tasks, 16/13/45, per-entry `mode: cc`): **done 24/24, ZERO infra-retries, zero quarantined, zero mirror refs, all 48 transcripts on main (after the one degraded-meta repair), $0.1099 total (the CC lane's ~$0.0046/turn through the bridge — the known CC-vs-codex economics), 2m47s wall**. The degraded path fired on the CC twin exactly as on codex: T-X32-12's meta.json exhausted the ladder mid-storm → `CC-TRANSCRIPT-PUSHED 1/2 (degraded)` + `CC-TRANSCRIPT-DEGRADED` → the turn kept done → **journal event e4311 carries `transcript_degraded: 1` — the s25-r1/R3 journal carry LIVE-PROVEN on its first exposure** (the durable surface the review round demanded; the meta reconstructed journal-derived, repair commit ba1b12e2). The dup-pair absorption visible (28 done-reports for 24 tasks — the dedup window working). THE SERIES: X29 → X30 → X31 → X32 = the transcript lane taken from race-split-record to boring.

## s25 — THE STAGE-0 WEEKLY PROMOTION (2026-09-25 00:04Z)

**THE THIRD DATED GREEN landed (drill run 36075500135, fired 00:00:32Z on the fresh UTC date): `STAGED-DRILL GREEN · 2026-09-25 · wall 2 min · tasks 1 · asserts 12/12 · watchdog green` — 3/3 dated greens (2026-09-23 · 09-24 · 09-25). THE PROMOTION EXECUTED: `STAGED_DRILL_ENABLED=weekly`** (the variable created at 00:06Z — the design's one-line flip, no re-merge). The drill now runs itself on the weekly ladder (Mondays UTC per the gate's cadence rule); the manual-mode era closes with the earned-greens ledger: five attempts to first green (four runner-caught bugs), then three consecutive dated greens across three days — the CI-existence theorem's full arc. The green #2→#3 delta: both 2-min walls, 12/12 asserts, zero catches — the drill is as boring as the transcript lane.
