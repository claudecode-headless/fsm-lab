# research/s22-staged-mode.md — THE STAGED MODE (the nightly real-repo mock epoch)

**Task 22-staged · DESIGN-ONLY · branch `t46/s22-staged` (from `t46/s21-int` @ 644ded6).**
Status: DRAFT — sections land incrementally; see the commit trail.

Sections: §0 context/truth-ladder ✓ · §1 trigger+gating ✓ · §2 epoch shape ·
§3 verification · §4 teardown+isolation+RECOMMENDATION · §5 cadence+budget ·
§6 rollout ladder · §7 failure modes · §8 build items · §9 open questions.

The design a BUILD agent implements next session without re-deriving anything:
a scheduled, self-verifying, self-cleaning nightly epoch that runs the REAL
five-workflow composition (conductor + worker + watchdog + intake + ops) on
REAL GitHub runners against the REAL `fsm-state` CAS, with **mock economics**
(`EPOCH_MODE=mock` → deterministic harness-shim workers, zero paid API spend,
zero real CC turns).

---

## §0 Scope, prior art, and the demand list

### 0.1 What "staged mode" is (the truth ladder)

The s21 test-matrix audit already drew the boundary (`research/s21-audit/lab-s21-audit-a6.md:99-112`):

| Truth | local (e2e/drill.mjs, landed s21) | **staged (this design)** | live (the X-series) |
|---|---|---|---|
| CAS/git state, queues, journal | REAL (local bare origin) | **REAL (the production `fsm-state` branch)** | REAL |
| Adapter I/O composition (the five turn-files) | REAL (child procs) | **REAL (real runner checkouts)** | REAL |
| Worker behavior | harness-shim (`EPOCH_MODE=mock`) | **harness-shim (same, on real runners)** | real/cc |
| GH API surface (issues/comments/runs/pulls) | ghapi stand-in | **REAL** | REAL |
| Dispatch→run latency, concurrency physics | modeled (mini-GHA, 164 s compressed) | **REAL** | REAL |
| PAT-comment trigger law, 5-parallel cap, minute quota, runner cold-start, pagination | NOT | **REAL** | REAL |
| Paid-LLM lane | NOT | **NOT (mock economics — the whole point)** | real |

The a6 verdict names the cadence: "staged nightly + pre-release (~20 min, mock
epoch = $0 LLM)" (`lab-s21-audit-a6.md:112`). This design productizes it: the
X-series drills were operator-manual (a7 ARCH-5: "all drills manual,
single-operator", `lab-s21-audit-a7.md:39`); the staged mode makes the live
drill **scheduled, self-verifying, self-cleaning, zero-operator**.

### 0.2 The demand list (what the local drill admits it does NOT prove)

The local drill's honest NOT-MODELED list (`e2e/drill.mjs:806-816`) is exactly
the staged mode's reason to exist. The items only real GHA can close:

1. **PAT-comment trigger law** — live GHA wakes workflows only on real-user
   events; the scheduler delivers every accepted dispatch (`e2e/drill.mjs:807`).
2. **Secondary rate limits** — the 403/429+Retry-After ladder shapes are
   unit/sim-pinned only (`e2e/drill.mjs:808`).
3. **Runner cold-start, minute quotas, cross-repo contention** beyond the
   modeled repo-wide ParallelCap(5) (`e2e/drill.mjs:809`).
4. **Real authn/authz** — the stand-in trusts its minted tokens
   (`e2e/drill.mjs:810`).
5. **The real `fsm-state` branch** — the local drill runs a scratch bare origin;
   the production branch's real contention history, real rotation state
   (live today: `journal-16.jsonl`, `journal_seq` 3160), and real concurrent
   readers (watchdog + console + pinger markers) are not in the loop.

The staged nightly closes 1–4 on every run and 5 by construction (§4: it runs
ON the production branch).

### 0.3 What is already true on the live repo (read-only probes, 2026-09-21)

Design grounded in today's live configuration (GET-only, no writes):

- Repo variables: `EPOCH_MODE=mock`, `WORKER_REPO_2=agentrunners/fsm-lab-workers`,
  `WORKER_OVERFLOW_AT=1` (set 2026-09-19 — **the X26 test posture is live**;
  see §9 open question), `CC_VERSION=2.1.273`, `CC_MODEL=deepseek/deepseek-v4.1-flash`.
- The mirror bucket (`agentrunners/fsm-lab-workers`) has `TARGET_REPO=claudecode-headless/fsm-lab`
  — its workers check out the MAIN repo and report to the MAIN `fsm-state`
  (the ar 20-e redirect, `worker.yml:69-82`).
- The live `state/state.json` @ `fsm-state`: `chain.halted=true`,
  `chain.paused=false`, `project.phase=done`, `mode=mock`, all tasks terminal
  and `pruned:true`; config `{max_parallel:4, lease_minutes:45, max_attempts:3,
  tick_min_interval_s:25, prune_tasks_after_ticks:20}`. **This is the
  "halted-clean" resting shape the gate in §1 checks for — the live repo is in
  it right now, between epochs.**
- Both repos are PUBLIC (the executor's "PUBLIC repo discipline",
  `conductor.yml:12-15`): ubuntu-latest runner minutes are free; the real
  budget is the org's shared 20-concurrent-jobs bucket and wall clock (§5).

---

## §1 The trigger + gating

### 1.1 Where the nightly fires: a NEW workflow, `staged-drill.yml`

Not the ops-console cron, not a schedule on an existing workflow:

- **ops-console.yml must NOT gain a schedule.** Its security contract is
  `issue_comment[created]` ONLY — GITHUB_TOKEN-authored comments never fire
  workflows, which is what makes it anti-recursion BY CONSTRUCTION (F-13,
  `ops-console.yml:4-14,31-33`). A schedule trigger on that workflow breaks
  the documented per-workflow security shape for zero benefit.
- **conductor.yml / watchdog.yml schedules are already load-bearing** (the
  10-min backstop tick `conductor.yml:34-42`; the ~6/hour watchdog scan
  `watchdog.yml:13-15`). Neither can carry scenario logic: the conductor turn
  is a generic FSM turn (`conductor/turn.mjs:1-9`); the watchdog is
  read+dispatch+alert only, never a semantic state writer
  (`watchdog/scan.mjs:1-7`).
- **A new workflow is the honest shape**: it is a DRIVER, not a machine-plane
  member. It follows the F-2 per-workflow form for PAT-holding workflows —
  **dispatch/schedule/manual triggers ONLY, never hostile-input surfaces**
  (`README.md:113-116`), because it reads `secrets.LAB_PAT` (§1.4).

The YAML shape (a build item, §8 B-0):

```yaml
name: fsm-staged-drill
on:
  workflow_dispatch:        # stage 0: the ONLY way it fires
    inputs: { note: { description: 'manual drill reason (logged only)', required: false, default: '' } }
  schedule:
    - cron: "37 1 * * *"    # nightly 01:37 UTC — off the :00/:30 high-load
                            # hotspot (the conductor.yml:41 discipline) and
                            # ~90 min after the OpenRouter free-tier ~UTC-midnight
                            # rollover, so a late real epoch has drained first
concurrency:
  group: fsm-staged-drill   # OWN group — never contends with the hot conductor
  cancel-in-progress: false # chain (the live discovery, ops.yml:1-4)
permissions:
  contents: write   # checkout + read-only fsm-state fetch + the reset/nudge dispatch POSTs (X1a, conductor.yml:48-49)
  issues: write     # the drill issue PATCH/reopen/close, the marker, the RED page
  actions: read     # the bucket-2 runs query + the watchdog-runs assert (law-4 pattern, conductor.yml:51)
jobs:
  gate:      { ... }  # §1.2 — read-only state check; refuses unless halted-clean
  run:       { ... }  # §2  — seeds (PAT) + monitors to halt; timeout-minutes: 55
  verify:    { ... }  # §3  — the assertion pass; needs: run; if: always()
  teardown:  { ... }  # §4  — cleanup + marker + stuck-recovery; needs: verify; if: always()
```

### 1.2 The cadence knob: promotion is a repo variable, not a re-merge

The rollout ladder (§6) lives in ONE repo variable the gate job reads
(the `vars.OPS_ISSUE || '1'` mapping pattern, `ops-console.yml:60-63`):

- `vars.STAGED_DRILL_ENABLED` = `manual` (default, ships unset → manual) —
  schedule events SKIP; only `workflow_dispatch` proceeds.
- `weekly` — the nightly cron fires but the gate proceeds only on Mondays (UTC).
- `nightly` — every fire proceeds.

Promotion/demotion is an operator's one-line variable flip — no code change, no
re-merge, and the drill can be silenced instantly without touching the machine
plane (the same reasoning that made `EPOCH_MODE` a repo variable,
`conductor.yml:73-76`).

### 1.3 The safety gates — when the drill REFUSES

The gate job (read-only: checkout + `Store.fetch()` + `readState()` + the queue
readers — the watchdog's own read pattern, `watchdog/scan.mjs:8,39-44` and
`lib/store.mjs:67,113,403-404,428-429`) exits **green with a SKIP marker**
(a log line + nothing else) unless ALL hold:

| # | Check | Refuses when | Why (cite) |
|---|---|---|---|
| G1 | `chain.halted === true` | a LIVE or PAUSED chain | one state, one epoch: a reset/rollover on a live chain would destroy the real epoch's state (`conductor-core.mjs:492-533` replaces `s` wholesale) |
| G2 | `chain.paused === false` | a budget-pause hold | the pause is the X23-class quota protection; a drill epoch through it wipes the hold (`conductor-core.mjs:473-476`) |
| G3 | `project.phase === 'done'` and every `tasks[*].status` terminal (`done`/`quarantined`/`cancelled`) — or zero tasks | a mid-flight epoch | the halted-clean resting shape; the LIVE state is exactly this today (§0.3) |
| G4 | report queue, control queue, AND intake queue all EMPTY | a queued spec (real or drill) | the rollover consumes the queue HEAD (`conductor-core.mjs:502,719`) — a queued real spec means the real system is WAITING to run and must not be jumped, and a queued drill line means last night never drained (§7.4) |
| G5 | `github.event_name === 'workflow_dispatch'` OR the cadence var admits today | cadence not yet promoted | §1.2 |
| G6 | no in-progress `fsm-worker`/`fsm-conductor` runs on either bucket (WARN-only on agentrunners; hard on main) | straggler runs from a real epoch | G3 normally implies this; the check catches an orphaned mirror run still grinding (≤50 min, `worker.yml:67`) before the drill adds load to the shared 20-slot org bucket |

A SKIP is **green** (exit 0, one log line `STAGED-DRILL-SKIP <reason>`): a busy
real epoch is healthy behavior, not a drill failure. The next scheduled fire
retries. Only a gate that CANNOT READ the state (API/git failure after 3
attempts) goes RED — unreadable state is the operator's problem, and it pages
(§3.4).

### 1.4 The lock: why a nightly epoch cannot collide with a real epoch

There is no mutex primitive in the substrate, and the design does not add one
(a lock file on `fsm-state` would make the driver a semantic state writer and
contend the conductor's CAS lane — the single-writer discipline the whole
system is built on, `conductor.yml:1-3`). Instead the lock is three-layered:

1. **Pre-check (G1–G4)** — the drill only seeds a halted-clean chain. The seed
   (issue reopen → door enqueue → nudge) follows within seconds.
2. **Structural mutex** — the epoch itself is the lock. Once the drill's
   rollover births its genesis, the state's single chain IS the drill epoch; a
   real intake issue arriving mid-drill merely queues behind it and gets the
   position comment ("Queued behind the active epoch", `intake/turn.mjs:153-157`).
   It is consumed by the NEXT rollover after the drill halts — the exact
   parked-queue semantics the reset contract guarantees ("the intake queue
   PARKS through a plain reset", `conductor-core.mjs:494-496`).
3. **Post-hoc detection** — the verify job's FIRST assertion is ownership
   (§3.2 A1). The one residual race — a real issue landing in the seconds
   between gate-pass and the drill's enqueue, winning the queue HEAD — results
   in the ROLLOVER BIRTHING THE REAL EPOCH instead of the drill's. The verify
   job sees a foreign epoch (`project.issue` ≠ the drill issue) and takes the
   **DRILL-DEFERRED** path: green exit, zero teardown, zero page — the real
   epoch is healthy and runs to completion; the drill retries next night. The
   drill never halts, resets, or otherwise touches an epoch it does not own.

The reverse overlap (drill live, real issue arrives) needs no handling beyond
(2): queue order is FIFO by CAS-append (`store.enqueueIntake`, `intake/turn.mjs:130-145`),
and one epoch at a time is enforced by the state shape itself.

### 1.5 How EPOCH_MODE rides (and why the drill never touches it)

`EPOCH_MODE` is a repo variable mapped into the conductor's env
(`conductor.yml:76`, `EPOCH_MODE: ${{ vars.EPOCH_MODE || 'mock' }}`) and feeds
`makeGenesis` for cold-start/reset genesis (`conductor/turn.mjs:193`). For an
intake-born epoch the SPEC's own `mode` key wins — door-validated against
`GENESIS_MODES` (`conductor/turn.mjs:196-198`, `lib/intake.mjs:307-311`) — and
the mode then rides every dispatch envelope to the workers
(`assembleDispatchPayload(..., { mode: epochMode })`, `conductor/turn.mjs:404-409`).

**Design: the drill spec pins `mode: mock` explicitly.** The drill epoch is
mock even if the operator flips `vars.EPOCH_MODE` to `cc` for a real epoch the
same week — the drill never reads, never writes, and never depends on the repo
variable. (The live value is `mock` today anyway, §0.3.) This is the same
isolation discipline the spec's `lease_minutes` already has: the spec knob
overrides the adopted config at the rollover (`conductor-core.mjs:504-510`).

### 1.6 The seed mechanics (why a PAT, and why a pinned issue)

The epoch's genesis is the REAL intake door: `issues: [opened, reopened]`
(`intake.yml:23-24`). Two platform facts force the shape:

- **A GITHUB_TOKEN-authored issue event fires no workflows** (the anti-recursion
  law — the same law the console relies on, `ops-console.yml:8-14`). The seed
  job therefore reopens the drill issue with **`secrets.LAB_PAT`** (a real-user
  token) so the door actually wakes.
- **The door gates the ISSUE's author, not the reopen actor** — `it.user.login`
  (`intake/turn.mjs:84`) is the issue's original creator, whose permission is
  checked (`intake/turn.mjs:96-106`). The drill issue is created ONCE by the
  operator (write-class); every nightly reopen passes the gate on the author's
  standing permission, whoever performs the reopen.

The pinned-issue cycle (one issue, forever — not a new issue per night):

1. The teardown job CLOSES the drill issue each night (§4).
2. The seed job PATCHes the body with tonight's dated spec block (PAT —
   `issues: edited` fires nothing: `intake.yml` triggers only
   opened/reopened), then REOPENS it (PAT — `issues: reopened` wakes the door).
3. The door parses the fenced `fsm-task` block, enqueues
   (`intake/turn.mjs:130-151`), and nudges the conductor
   (`intake/turn.mjs:159-165`); the nudge's tick performs the rollover within
   seconds-to-a-minute.
4. The dated body means a fresh `body_sha8` each night, so the door's dedup
   (`matches: issue + body_sha8`, `intake/turn.mjs:143-145`) never suppresses
   the nightly enqueue — while an accidental double-reopen in one night IS
   suppressed (same body, same sha8). Idempotence by existing mechanism.

The drill issue number is a repo variable (`vars.DRILL_ISSUE`, mapped like
`OPS_ISSUE`, `ops-console.yml:60-63`) — the m-8 load-bearing-variable pattern:
if the drill issue ever moves, the variable moves, the workflow does not.

---

## §2 The drill epoch shape

### 2.1 The scenario mix (4 tasks, one epoch, one issue reopen)

One intake issue → one spec → one rollover → **one multi-task epoch**. The mix
covers the recovery paths the brief names, WITHOUT the flaky ones:

| Task | Behavior | Lease | Expected arc | The pin it proves nightly |
|---|---|---|---|---|
| `T-STG-A-<MMDD>` | `fast` | 5 min | a1 → done, ~4 min | the happy X22 shape: door → rollover → dispatch → real-runner turn → report → drain (the one-pass loop, mock-economics edition) |
| `T-STG-B-<MMDD>` | `fast` | 5 min | a1 → done, ~4 min, **on the mirror bucket** | the X26 pin: PRE-FLIGHT overflow → exactly ONE dispatch (C-2) → the mirror run in `agentrunners/fsm-lab-workers` → the report CAS-append routes back to the MAIN `fsm-state` (the TARGET_REPO geometry) |
| `T-STG-C-<MMDD>` | `infra-flaky` | 5 min | a1 `infra_failed lane-429` → a2 done | the infra-retry ladder: a real infra report drains as a retry, not a quarantine; `stats.infra_retries ≥ 1`, NO budget-pause (1 distinct task < threshold 3, `conductor-core.mjs:667`) |
| `T-STG-H-<MMDD>` | `hang` | 15 min | a1 silent → lease expiry → TIMEOUT → a2 silent → TIMEOUT → **quarantined** | the lease-expiry recovery: the reaper (not the scan, not the TTL) is the handler BY DESIGN (`worker.yml:29-32`); plus the C-1 union-scan pin (below) |

The `<MMDD>` date suffix (baked into the issue body by the seed job) keeps task
ids unique per night: the journal's task attribution is unambiguous, and the
law-4 id-reuse hazard ("prior-epoch id reuse suppressed the flip",
`conductor/turn.mjs:252-258`) cannot arise at all — the time-correlated scan
keys are the belt-and-suspenders on top.

**Why the overflow works with zero configuration**: `vars.WORKER_OVERFLOW_AT=1`
is ALREADY live on the repo (§0.3). The pre-flight arm decides per dispatch:
`overflowPreFlight({ inFlightNow: priorInFlight + dispatchIndex − 1, ... })`
(`conductor/turn.mjs:425-427`) — with the 4 tasks assigned in the genesis tick
(`max_parallel:4` adopted from live config, §0.3), dispatch #1 (in-flight 0)
takes the MAIN lane and dispatches #2–4 (in-flight ≥ 1) go STRAIGHT to
`agentrunners/fsm-lab-workers` on the LAB_PAT lane, one dispatch per task
(`conductor/turn.mjs:410-440` — the C-2 fix: the same-repo attempt is SKIPPED).
The mirror workers check out `TARGET_REPO=claudecode-headless/fsm-lab`
(`worker.yml:77-82`) and their report CAS-append follows the checkout's origin
(`worker.yml:69-75`) — the report lands on the MAIN `fsm-state`, the exact
production geometry X25 proved live.

**Why `hang` is cheap on real runners**: the shim's hang marker returns
"the caller reports NOTHING, exit 0" (`sim/harness-shim.mjs:213-222`) — the
worker run itself is ~40 s (checkout + node + silent exit), NOT a
lease-length runner grind. The lease stays outstanding with no runner burning
minutes; the runner slot frees itself immediately. The lease-expiry WAIT is
wall-clock on the conductor's ticks, not runner occupancy.

**Why `hang`'s lease is 15 min (the C-1 arithmetic)**: the law-4 verify scan
arms at the 360 s pre-window (`VERIFY_WINDOW_MS/2`,
`conductor/turn.mjs:275`, `conductor-core.mjs:188`) and flips a task
`dispatch-unverified` at 720 s if its run is invisible to the scan
(`conductor-core.mjs:233-243`, the a1 C-1 shape). With lease 15 min:
the scan fires at ~6 min (fetching BOTH buckets — the UNION,
`verifyScanRepoList(REPO, WORKER_REPO_2, PAT)`, `conductor/turn.mjs:288`), sees
T-STG-H's mirror run (key `${taskId}#a${n}` against the run-name
`task-<id> · <behavior> · a<attempt>`, `worker.yml:47`), and does NOT flip;
the lease then expires at 15 min and the reaper takes over. A main-only scan
WOULD have flipped at 720 s — so the assert "zero `dispatch-unverified` records
for T-STG-H" (§3.2) is a REAL proof the union scan saw the mirror run, not a
vacuous pass. (The local drill had to BACKDATE the lease to fake this window —
`e2e/drill.mjs:660-674`, the NOT-MODELED admission at `e2e/drill.mjs:812` — the
staged nightly gets it in real wall time, which is the entire point.)

**Why NO quota-wall task** (the brief's "one quota-wall task?"):
1. The alert-spam budget (§5.3): a nightly budget-pause arc opens/comments the
   `fsm-watchdog-alert` lane BY DESIGN (`conductor/turn.mjs:127-157`) — that is
   nightly paging, exactly what §5 forbids.
2. The arc is timing-dependent across ticks even in the deterministic local
   drill — its own honest note: "the post-resume grind … is REAL but
   timing-dependent across ticks" (`e2e/drill.mjs:592-595`).
3. It is already pinned at two lower layers (sim4/test-budget + the local
   `budget-pause` scenario, `e2e/drill.mjs:488-596`); the staged mode's job is
   SUBSTRATE truth, and the pause decision logic needs no substrate proof.
The `infra-flaky` task covers the infra-report recovery WITHOUT the pause
trigger (1 distinct task < threshold 3).

**What the mix deliberately does NOT cover** (honest scope): the PR/task-branch
write-back lane is CC-epoch-only (`task-pr.mjs:43` — "cc epochs only";
`task-pr.mjs:25` — "Mock epochs skip"), so a mock nightly opens no PRs — that
lane stays on the X-series live cadence (see §9 open question Q3). The mock
epoch still exercises the operator-visible human plane: the epoch-started
comment and the completion digest land on the drill issue regardless of mode
(the m-3 arms, `conductor/turn.mjs:530-538` and `:553-567` — the digest's PR
links are simply absent).

### 2.2 The spec block (what the seed job writes into the issue body)

Today's door parses a SINGLE-task spec — `id/title/accept|behavior/deps/
artifacts/lease_minutes/milestone/mode`, unknown keys rejected
(`lib/intake.mjs:186,315`), `lease_minutes` bounded `[3,120]`
(`lib/intake.mjs:283-292`), and the genesis from a spec carries
`milestones_total=1` — "the task IS the project" (`conductor/turn.mjs:205-211`).
A 4-task epoch therefore requires the planned W-D multi-task extension
(`conductor/turn.mjs:210-211` — "the spec's `milestone` key stays door-validated
metadata for W-D's multi-task epochs (inert here)"): **build item B-1 (§8)** —
the spec gains an optional `tasks:` list; each entry validated with the SAME
per-task rules; `makeGenesis` maps it over `specToTask`
(`conductor/turn.mjs:199-219` is the seam); `milestones_total = tasks.length`.

Tonight's body (the seed job's template, date substituted):

````
```fsm-task
mode: mock
tasks:
  - { id: T-STG-A-1031, behavior: fast, lease_minutes: 5, title: staged nightly A (happy path) }
  - { id: T-STG-B-1031, behavior: fast, lease_minutes: 5, title: staged nightly B (mirror overflow) }
  - { id: T-STG-C-1031, behavior: infra-flaky, lease_minutes: 5, title: staged nightly C (infra retry) }
  - { id: T-STG-H-1031, behavior: hang, lease_minutes: 15, title: staged nightly H (lease expiry) }
```
````

(B-1's parser accepts the bracketed one-line-per-task form — the SAME
list-literal convention the door already normalizes for `deps`/`artifacts`,
`lib/intake.mjs:136-141` — so no new indentation grammar is needed.)

**Stage 0 fallback with ZERO door changes** (§6): the single-task spec
alternates by weekday — Mon/Thu `fast`, Tue `infra-flaky`, Wed `hang`
(lease 15, ~35 min arc), Fri `fast`… Each night is one one-pass epoch covering
door/rollover/turn/drain/halt/quiesce/watchdog plus ONE recovery arc. The
overflow pair is the only pin that structurally needs multi-task (the pre-flight
arm needs in-flight ≥ 1, and a single-task epoch never has it — the first
dispatch of a tick computes in-flight 0), so B-1 is what unlocks the X26 pin
nightly; stage 0 proves everything else.

### 2.3 The wall-time budget per night

Grounded numbers (live-measured where possible):

- Dispatch→run-start latency: **~164 s** live-measured (X5; modeled at
  `e2e/lib/scheduler.mjs:17-18`).
- Conductor tick cadence: **≥ 25 s** (the rollover floor,
  `conductor-core.mjs:503`), each tick one runner run of ~45–75 s
  (checkout + turn + the in-run pacing sleep, `conductor/turn.mjs:625-646`).
- Fast tasks: ~4 min each (164 s latency + ~40 s run + a drain tick).
- `infra-flaky`: ~8 min (a1 infra + reassign + a2).
- `hang` × 2 attempts: 2 × (15 min lease + a reaper tick) ≈ **32 min** — the
  epoch's critical path (the lease-expiry wait is irreducible: you cannot prove
  a lease expired faster than a lease).
- Genesis + MILESTONE + dispatches: ~3 min. Drain→halt + PHASE-done digest: ~2 min.

**Epoch wall ≈ 35–40 min. Full nightly wall (gate+seed+monitor+verify+teardown)
≈ 50–60 min.** The `run` job's `timeout-minutes: 55` is the alarm line (§7.2).

Runner-minutes per night (public repos → **$0**; the honest accounting anyway):
~35–45 conductor ticks × ~1 min + ~8 worker runs × ~1.5 min + 1 door + the
staged workflow's own 4 jobs (~12 min) + the monitor's idle poll (~40 min of
mostly-sleeping runner) ≈ **~110 runner-min/night ≈ 3.5 h/month**. The monitor
idle is the same accepted class as the conductor's pacing sleep ("free on
public repos", `conductor/turn.mjs:626-628`). §5.1 has the private-repo
contingency.

---

## §3 The verification pass

### 3.1 Where it lives and how it reads

A `verify` job in `staged-drill.yml` (`needs: [run]`, `if: always()` — it must
run on a stuck drill too, because it is also the stuck-detector). It reads:

- **`fsm-state`** through the REAL `Store` (the watchdog's read-only pattern:
  checkout + `store.fetch()` + `readState()` + `readJournalTail()`,
  `watchdog/scan.mjs:8,39-44`, `lib/store.mjs:67,113,534`) — git reads, zero
  API cost, byte-identical to what every machine-plane reader sees.
- **The journal's epoch segment** — records AFTER the newest applied
  `CONTROL reset` boundary, the same walk `epochSpend` uses
  (`ops/console.mjs:87-104`). This scopes the asserts to tonight's epoch even
  with 16 generations of prior history on the branch (§0.3).
- **Both buckets' run ledgers** — `GET /repos/{repo}/actions/workflows/worker.yml/runs`
  for main and `agentrunners/fsm-lab-workers` (the PAT lane for the cross-repo
  one — the same call the conductor's union scan makes,
  `conductor/turn.mjs:288-292`).
- **The watchdog's own runs** — `GET .../workflows/watchdog.yml/runs` within
  the window, plus a search for `fsm-watchdog-alert` issues created in-window
  (the `findAlertIssue` query shape, `watchdog/scan.mjs:76-79`).

### 3.2 The assertion table (the invariants, each with its evidence)

| # | Invariant | Evidence | Expected |
|---|---|---|---|
| A1 | **the epoch is OURS** (the lock check) | `state.project.issue === vars.DRILL_ISSUE` and every task id matches `^T-STG-.*-<MMDD>$` | else → **DRILL-DEFERRED** (§1.4): green exit, no teardown, no page |
| A2 | all tasks terminal | `tasks[*].status` | `done×3` (A, B, C) + `quarantined×1` (H); zero `assigned/in_progress/ready/backlog` |
| A3 | halt reached, non-degraded | `chain.halted && project.phase==='done'` + the PHASE journal record `degraded !== true` (the R2 quality gate, `conductor/turn.mjs:539-552`) | done 3/4 = 75% ≥ 50% → "PROJECT COMPLETE", not the degraded alert |
| A4 | **zero double-applied** | the epoch journal segment: no two APPLIED `REPORT` records share `(task, event_id)`; a re-delivered id only ever lands as `REJECTED reason:'duplicate'` (`lib/fsm.mjs:195-206` — the dedup ring journals the reject, never a second apply) | 0 double-applies |
| A5 | attempts ladder | `tasks[*].attempts` + REPORT/TIMEOUT records | A=1, B=1, C=2 (one `infra_failed lane-429` REPORT then done), H=2 (two TIMEOUT records, the last `to:'quarantined'`, `conductor/turn.mjs:499-501`) |
| A6 | **overflow actually overflowed** | the mirror bucket's runs: a run named `task-T-STG-B-<MMDD> · fast · a1` (and C's/H's) in `agentrunners/fsm-lab-workers` + ≥1 main-repo worker run (A's) | ≥2 mirror runs, ≥1 main run — the X26 evidence |
| A7 | **the union scan protected the mirror work** (C-1) | zero `dispatch-unverified` REPORT records for T-STG-H in the journal (the flip shape, `conductor-core.mjs:233-243`) | 0 — meaningful BECAUSE H's lease (15 min) outlives the 720 s flip window (§2.1) |
| A8 | exactly ONE dispatch per task (C-2) | mirror + main run ledgers: one run per (task, attempt) | no duplicate runs (the pre-flight arm's contract, `conductor/turn.mjs:410-427`) |
| A9 | stats sane | `state.stats` | `infra_retries ≥ 1`, `timeouts ≥ 2`, `budget_pauses === 0`, `orphaned_reports === 0` |
| A10 | the human plane closed | comments on the drill issue | the epoch-started note (`conductor/turn.mjs:530-538`) + the completion digest (`:553-567`) |
| A11 | **watchdog stayed green** | ≥1 watchdog run completed in-window with success conclusion; zero `fsm-watchdog-alert` issues created in-window | both hold (a live self-ticking chain is fresh by construction — `chain.last_tick` advances every tick) |
| A12 | the rollover record | journal `CONTROL reset, note intake-rollover issue #N` with `genesisSpec.tasks.length === 4, mode:'mock'` (minted at `conductor-core.mjs:719-733`; the local drill pins the same shape at `e2e/drill.mjs:366-369`) | present |

The full assert list ships in the run's step summary + the drill report
artifact (`actions/upload-artifact`), shaped like the local DRILL-REPORT
(per-phase PASS/FAIL + timings, `e2e/drill.mjs:819-837`) so both modes report
alike.

### 3.3 On GREEN

- **One marker comment on the drill issue** — the operator's at-a-glance
  streak surface: `STAGED-DRILL GREEN · <iso-date> · wall <N> min · tasks 4 ·
  asserts <n>/<n> · watchdog green`. Posted with the JOB token (fires no
  workflows — the anti-recursion law, `ops-console.yml:8-14`), so it cannot
  wake the machine plane.
- Close the drill issue (arms tomorrow's reopen, §1.6).
- Upload the report artifact. Nothing else — no state write, no dispatch.

### 3.4 On RED

- **Open ONE duty-alert issue, label `fsm-staged-red`** (NOT
  `fsm-watchdog-alert`): the machine's alert lanes search
  `state=open&labels=fsm-watchdog-alert` and take the first hit
  (`watchdog/scan.mjs:76-79`; the budget lane likewise, `conductor/turn.mjs:146-156`)
  — an open drill-RED issue with that label would ABSORB the next REAL
  watchdog alert's comments into a drill thread, mixing lanes. A distinct
  label keeps the machine's lanes untouched; the title still reads
  `[fsm-staged] NIGHTLY DRILL RED — <date>` so it sits visually in the alert
  stream the operator already watches.
- The page body: the failed asserts (A-table refs), the recovery state of the
  system (halted-clean? mid-epoch? foreign epoch?), and the fix-forward note.
- **Page ONCE per incident**: the next GREEN run auto-closes every open
  `fsm-staged-red` issue (self-cleaning alert budget, §5.3). No nightly
  re-paging while an incident is open — the drill report artifact + the issue
  thread carry the detail.
- Distinguish **assertion-RED** (a real invariant break — investigate) from
  **read-RED** (the verify job could not read state/runs after 3 attempts —
  likely API flake; the page says so and suggests re-running the verify job).
  Both page once; neither is silently green (law 5).
- The teardown's stuck-recovery arm runs ONLY on a stuck drill (§4.3) — an
  assertion-RED on a halted-clean chain leaves the system alone: the state is
  a valid resting state, just not the one we wanted; the next night retries.

---
