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

## §4 Teardown + isolation — and the same-repo vs disposable-repo decision

### 4.1 The happy-path teardown is ALREADY the X-series teardown

The drill epoch ends the way every epoch ends: PHASE done → **halt**
(`STOP_CHAIN` at completion) → the next wake QUIESCES (no commit, no
self-dispatch — T44/F2, `conductor/turn.mjs:333-359`) → the tip freezes. That
IS halted-clean — the exact resting shape the live repo is in right now (§0.3)
and the exact shape the gate requires for tomorrow. **No reset is needed on the
happy path.** The teardown job's whole job:

1. Assert the halt held (read the frozen tip twice, the local drill's
   HALT-QUIESCE phase pattern, `e2e/drill.mjs:440-469`).
2. Close the drill issue (arms the reopen cycle, §1.6).
3. Post the marker comment / RED page (§3.3–3.4) + upload the artifact.
4. On GREEN: auto-close stale `fsm-staged-red` issues (the self-cleaning alert
   budget).

What the system does to clean up after itself, BY EXISTING MECHANISM (nothing
new to build, everything cited):

| Residue | Mechanism that bounds it |
|---|---|
| `tasks[T-STG-*]` entries in `state.json` | task pruning: terminal tasks prune after `prune_tasks_after_ticks:20` (live config, §0.3) — the live state shows the last epoch's tasks already `pruned:true` |
| Journal records (~40–60/night) | journal rotation at 500 records/generation (`store.mjs:41`, `rotateAt`) — 16 generations live; ~2–3 weeks of drill-only traffic per full rotation |
| `stats` counters | zeroed at every genesis (the rollover/reset mints a fresh project, `conductor-core.mjs:719-733`) |
| Comments on ops issue #1 (~3/night: MILESTONE started, PROJECT COMPLETE, one QUARANTINED-via-timeout alert) | the alert lane's own one-comment-per-decision discipline (`conductor/turn.mjs:490-529` — "ONE comment per decision — never per tick", `ops/console.mjs:218-221`); the QUARANTINED comment is REAL signal (the recovery path fired), not noise to suppress |
| The drill issue's own thread (epoch-started + digest + marker, 3/night) | the pinned-issue design (§1.6) — ONE issue forever, the streak IS the audit trail |
| Worker runs / run records | GitHub's own 90-day retention; no action |
| `tasks/T-STG-*` branches, PRs | **none are created** — mock epochs skip the write-back lane (`task-pr.mjs:25,43`); zero repo-tree pollution by design |

### 4.2 The stuck-drill recovery arm (the only teardown that writes anything)

If the `run` job's monitor times out (no halt within 55 min) or the verify job
finds a non-terminal state, the teardown dispatches ONE control:

```
POST /repos/claudecode-headless/fsm-lab/dispatches
  { "event_type": "fsm-control", "client_payload": { "command": "reset", "note": "staged-drill teardown <date>" } }
```

(the README's documented operator surface, `README.md:97-98`). What the reset
actually does, and why it is safe here:

- The dispatch wakes BOTH `conductor.yml` and `ops.yml` (both register
  `fsm-control` — the fan-out, `conductor.yml:26-27`, `ops.yml:13`): the
  conductor drains the DIRECT reset (prepended, `conductor-core.mjs:435-440`)
  and the ops lane's queued twin is REJECTED `reset-duplicate` by the same-drain
  twin-guard (`conductor-core.mjs:446-491`, M-A2 note normalization) — exactly
  one reset applies, and the REJECTED twin produces NO comment (s22/M-1,
  `conductor/turn.mjs:513-521`).
- The reset replaces the stuck drill epoch with a FRESH mock genesis
  (`conductor-core.mjs:492-533`), adopting the live config (lease 45) — a
  plain `mockProject()` epoch (3 milestones, the built-in failure matrix,
  `lib/mock-project.mjs:17-48`) which **self-completes in ~2.5–3 h and halts**.
  The system heals itself back to halted-clean overnight; if it has not
  finished by the next night, the gate simply SKIPs that night (G1/G3).
- Straggler drill workers still grinding (≤50 min, `worker.yml:67`) report
  AFTER the reset and are absorbed as unknown-task rejects — "reports drain
  AFTER the reset (rejected as unknown-task against the fresh genesis,
  journaled" (`conductor-core.mjs:48-50`).
- A plain reset PARKS the intake queue (`conductor-core.mjs:494-496`) — any
  real spec that queued behind the stuck drill is NOT dropped; it rolls over
  when the recovery epoch completes. The teardown never uses
  `reset drop_queue` (it would destroy real specs).

**Why not `halt` instead?** A halt on a mid-flight epoch leaves `phase != done`
with a held chain — the next REAL intake issue would queue forever behind a
half-done epoch (the rollover requires `phase === 'done' && !chain.paused`,
`conductor-core.mjs:693`), requiring an operator reset anyway. The reset
is the only single-action recovery that returns the system to a
self-completing state. (The ~3 h unattended mock epoch it spawns is the same
epoch the live repo runs on every operator reset today — the live state in
§0.3 is exactly its tombstone.)

### 4.3 Same-repo vs disposable-repo — the honest comparison

**Option S (RECOMMENDED): same-repo with a `T-STG-*` namespace** — the drill
epoch runs ON `claudecode-headless/fsm-lab`'s real `fsm-state`, exactly as the
manual X-series did (X22 ran a live cc epoch on this repo's real state,
worklog 18-main; the current halted-clean state IS the residue of a real
mock epoch that completed 2026-09-21).

**Option D: a disposable drill repo** (a third repo, e.g.
`agentrunners/fsm-lab-drill`, tree + workflows pushed nightly or once) — the
a6 sketch: "template-push a private throwaway repo from main@<commit>; set
vars/secrets incl. deliberately-dead keys for quota shapes"
(`lab-s21-audit-a6.md:130`), and a7 ARCH-5's "against a disposable mirror".

| Dimension | S: same-repo + namespace | D: disposable repo |
|---|---|---|
| **Blast radius on the real system** | the drill epoch IS the state for ~40 min; gated to halted-clean start + natural halt end (§1.3, §4.1). Residue: §4.1's table, all bounded by existing mechanisms. | zero state pollution of the real `fsm-state` — the drill repo has its own |
| **CAS contention** | none possible with a real epoch (the §1 lock); contention with the watchdog's marker write + console reads exists ALREADY for every real epoch (the single-writer group serializes writers, `conductor.yml:44-46`) | zero |
| **Fidelity** | **MAXIMAL**: the real branch, real vars, real secrets, real OPS_ISSUE anchor, real watchdog + pinger + alert lanes, real mirror bucket — the thing the principal asked to prove ("REAL GitHub runners, REAL workflow composition, REAL fsm-state CAS") | a COPY: real runners + real composition, but a fresh `fsm-state`, a fresh ops anchor, no pinger, no contention history — proves the loop, not THE system |
| **Mirror/overflow (X26)** | works bit-for-bit with ZERO new infra: the real `agentrunners/fsm-lab-workers` already has `TARGET_REPO=claudecode-headless/fsm-lab` (§0.3) and `LAB_PAT` (X25) — the drill's overflow dispatches ride the production lane and the reports route home | **the fatal flaw**: the real mirror bucket's `TARGET_REPO` points at the REAL repo — its workers would report to the REAL `fsm-state`. D must either (a) flip the production bucket's `TARGET_REPO` nightly (mutating production config — strictly worse pollution than S's residue, with a wedge if the flip-back fails), or (b) mint a FOURTH repo (drill mirror) with its own vars + `LAB_PAT` secret — doubling the setup surface |
| **Setup cost** | **zero**: everything exists; one pinned issue + two repo vars (`DRILL_ISSUE`, `STAGED_DRILL_ENABLED`) | per-run or per-refresh: push the tree, set vars (`OPS_ISSUE`, `EPOCH_MODE`, `WORKER_REPO_2`, `WORKER_OVERFLOW_AT`, `TARGET_REPO`…), set secrets (the secrets API needs an org-admin PAT — a NEW secret on the driver repo, chicken-and-egg), and tear it down after |
| **New failure modes** | the ones in §7 — all analyzed, all with handlers | the setup job itself (half-minted repos, leaked repos, wrong var sets, the PAT-minting pipeline) — a whole new wedge class the a6 sketch never costed |
| **Schedule reliability** | irrelevant — the drill drives via dispatch; the repo's schedules are already warm | live datum: "schedules COLD-START ~3.6h after repo creation and then fire sparsely" (`conductor.yml:37-41`) — a nightly-minted repo's OWN watchdog/conductor schedules do not fire reliably the first night; the driver must dispatch watchdog scans manually |
| **Teardown** | natural halt + §4.1's bounded residue | delete or reset the repo — trivially clean |
| **The stuck case** | one reset + a ~3 h self-completing recovery epoch (§4.2) | delete the repo — cleaner, but the stuck CAUSE is on the real substrate only S can reveal |

**RECOMMENDATION: Option S — same-repo with the `T-STG-*` namespace.** The
deciding arguments, ranked:

1. **The X26 mirror geometry is only honest in S.** The drill's whole point
   includes the pre-flight overflow pin, and the production mirror bucket
   cannot serve a disposable repo without either mutating production config
   nightly or minting a second mirror. S exercises the REAL two-bucket
   topology — dispatch on the PAT lane, checkout redirect, report routing —
   with zero new infrastructure.
2. **The principal's yardstick demands the real thing.** "The loop proven ON
   the real infrastructure … REAL fsm-state CAS" (the brief's context) — the
   real branch with its real rotation state (16 generations), real concurrent
   readers, and real watchdog/pinger plane. A disposable repo proves a loop
   LIKE this one, on a copy.
3. **The stuck-drill deadman is inherited for free.** In S the drill chain is
   watched by the REAL watchdog (re-prime → 3-strike latch → one deduped alert,
   `watchdog/scan.mjs:19-25,76-105`) and the REAL pinger/deadman duty
   (`lib/pinger-watch.mjs:1-33`). In D the drill must build its own watch plane
   — or run unwatched.
4. **The residue is bounded by mechanisms that already exist and are cited**
   (§4.1's table). The X-series already left exactly this class of residue
   (issue #9, PR #10, the T-10x epoch in the live state) and the operator's
   mental model already includes it.
5. **D's setup pipeline is its own unpriced risk** — a nightly repo-minting
   path holding an org-admin PAT, with half-configured states on failure. The
   a6 sketch priced the "throwaway repo" at one line; the honest price is a
   new production system.

D's one real advantage — zero state pollution — is bought at the price of the
X26 pin, the fidelity, and a new failure class. If the drill's residue ever
becomes objectionable (e.g. the ops-issue comment rate), the mitigation is
cheaper than D: tighten §4.1's bounds (skip the QUARANTINED alert comment for
`T-STG-*` tasks — a one-line conductor filter) rather than fork the substrate.

---

## §5 Cadence + budget

### 5.1 The cadence: nightly (stage 2), 01:37 UTC

- **Nightly, not 2×/week**: the drill's value is the STREAK — regression
  detection latency is one day. The wall budget (~50–60 min, §2.3) fits any
  night; the operator-visible surface is one marker comment + at most one page.
- **01:37 UTC**: after the OpenRouter free-tier ~UTC-midnight reset (so a late
  real cc epoch has drained and the quota window is fresh — irrelevant for
  mock spend, but it keeps the drill from sharing the window with real-epoch
  traffic), off the `:00`/`:30` scheduled-workflow hotspot
  (the `conductor.yml:41` discipline), and done ~02:30 UTC before any human
  plane opens.
- **Schedule sparsity is tolerated**: GHA scheduled workflows fire late or skip
  (the live T44 datum, `conductor.yml:37-41`). A skipped night is a NO-OP —
  nothing degrades, nothing pages; the marker dates make gaps visible.

### 5.2 The runner-minutes budget

- **Both repos are public** (§0.3): ubuntu-latest minutes are FREE and
  unmetered; the real costs are the org's shared **20-concurrent-jobs bucket**
  (the drill's peak: 1 conductor + ≤4 workers + 1 staged job ≈ 6 of 20) and
  wall clock. ~110 runner-min/night (§2.3) ≈ 3.5 h/month of occupancy.
- **Private-repo contingency** (if the org ever flips either repo private):
  ~3,450 min/month exceeds the 2,000 free private minutes → the ladder drops
  to weekly (§6: ~800 min/month) or the monitor job's idle poll is replaced by
  a cheaper external poll (the executor's scheduler, see §9 Q5). Stated now so
  nobody rediscovers it under pressure.
- **API budget**: ~40–80 REST calls/night (gate reads are git; the verify
  queries 2 run-lists + 1 issue search; the seed 2 writes) — far under any
  5k/hr class concern.

### 5.3 The alert budget: page once, never nightly-spam

- **GREEN**: one marker comment/night on the drill issue — no issue, no page.
- **RED**: ONE `fsm-staged-red` issue per incident; the next GREEN auto-closes
  open ones (§3.4). A persistent fault pages on the FIRST night, then sits
  quietly open with the nightly report artifacts attached — no re-page while
  open.
- **The machine's own lanes stay untouched**: drill REDs never carry
  `fsm-watchdog-alert` (§3.4's lane-mixing rationale). The one machine-lane
  comment the drill DOES produce nightly is the QUARANTINED-via-timeout alert
  on ops #1 (`conductor/turn.mjs:499-501`) — real signal, one line, the
  recovery path's own voice.
- **A stuck drill may ALSO get the real watchdog's page** (stale chain →
  latch → `fsm-watchdog-alert`). That is correct, not double-paging: a stuck
  chain IS a system-level event; the two issues describe the two planes
  (drill-assert RED vs chain-health alert).

---

## §6 The rollout ladder

| Stage | Trigger | Scenario | Promotion criteria (ALL) | Demotion |
|---|---|---|---|---|
| **0 — manual** | `workflow_dispatch` only (`vars.STAGED_DRILL_ENABLED` unset/`manual`: schedule SKIPs, §1.2) | single-task one-pass (the §2.2 stage-0 weekday rotation; no door changes) | **3 consecutive manual greens on 3 different dates** — proves the reopen-cycle + dated-spec idempotence across days, not just within one | any unexplained RED → stay at 0, investigate |
| **1 — weekly** | var = `weekly` (Monday 01:37 UTC effective) | the full 4-task mix — **requires B-1** (the multi-task door, §8) landed + green in manual runs first | **4 consecutive weekly greens** (a month) with the X26 pair (A6/A7/A8) green each time | 2 REDs in a month → back to weekly-manual (var `manual`) until explained |
| **2 — nightly** | var = `nightly` | the full mix, nightly | the stage-1 month green + one deliberately-observed stuck-drill recovery (the §4.2 arm exercised at least once — manually wedged once, watched the reset heal) | any unexplained RED → drop one stage (operator flips the var; the RED page carries the instruction) |

Promotion/demotion is ALWAYS the operator's one-line var flip (§1.2) — the
drill never self-promotes and never self-mutates repo config (the same
operator-ownership discipline as the spend ceiling: "the burn decision —
pause/halt — stays the operator's", `ops/console.mjs:58-60`).

---

## §7 Failure modes, honestly

| # | Failure | What happens | Why it is bounded (cite) |
|---|---|---|---|
| F1 | **Nightly epoch overlaps a REAL epoch** | See §1.4: pre-check gate (G1–G4) + the structural epoch mutex + ownership detection (A1). The residual race (a real issue wins the queue head in the seconds between gate and enqueue) → the REAL epoch runs; the drill DEFERS (green, no teardown, no page). Reverse: a real issue mid-drill queues behind (position comment) and runs at the next rollover | `conductor-core.mjs:502,719` (head-first rollover); `intake/turn.mjs:153-157` |
| F2 | **Stuck drill (no halt in 55 min)** | The monitor job times out → RED page; the teardown dispatches the plain `reset`; a fresh mock epoch self-completes (~3 h) and halts; tomorrow's gate re-checks halted-clean. Meanwhile the REAL watchdog independently re-primes (≤3, then latches + one deduped alert) — the drill cannot out-live its watchdog window: the watchdog watches the SAME chain with `STALE_AFTER_MIN:4` (`watchdog.yml:38`) at ~6 scans/hour (`watchdog.yml:13-15`) | §4.2; `watchdog/scan.mjs:19-25`; the deadman: `lib/pinger-watch.mjs:25-33` (3 h marker staleness → the executor-hosted duty pages) |
| F3 | **GH API flakiness (403/000/5xx)** | Seed writes (PATCH/reopen): 2 attempts + backoff (the door's own nudge-retry pattern, `intake/turn.mjs:70-75`); a failed reopen = no epoch = green SKIP-with-log (retry next night — the queue was never touched). Dispatches: the conductor's own Retry-After-aware ladder (`conductor/turn.mjs:106-115`). Verify reads: 3 attempts, then read-RED (distinct from assertion-RED, §3.4) | the ladder is budget-capped + 403-without-RA fails fast (`conductor-core.mjs` dispatchLadder, `conductor/turn.mjs:108-112`) |
| F4 | **Runner queue delay (5–30 min on the shared bucket)** | The envelope deadline is ABSOLUTE, minted at dispatch — queue-delay-proof (`conductor/turn.mjs:400-401`); a worker that starts past its deadline reports one `infra_failed late-start` and exits 0 without burning the lease (`worker.yml:18-20`) → the FSM's normal retry ladder absorbs it. Leases (5/15 min) tolerate ~3 min of latency + queue; a 10+ min delay on the fast tasks stretches the night, a 30 min delay trips F2 (and is itself worth paging — a 30-min queue delay on the org bucket is a real capacity problem) | the START-GATE contract, `worker.yml:18-20`; the lease floor 3 + envelope margin (s22/B-1) |
| F5 | **Schedule sparsity / cold-start** | The 01:37 cron fires late or not at all → a missing night is a no-op (nothing pages; the marker gap is visible). No catch-up run: the next night's dated spec is a fresh epoch anyway | `conductor.yml:37-41` (the live datum) |
| F6 | **Mid-drill deploy (a push to main while the epoch is live)** | Workers/conductor check out the CURRENT main per run → one mixed-version night. Not a new class: the system runs mixed-deploy windows by design (the F2 livelock note, `conductor/turn.mjs:334-337`); the drill's asserts are version-independent invariants | the invariants (A-table) hold across versions |
| F7 | **The drill's own issue wedge** (door enqueued but the rollover never consumed it — nudge + backstop + pinger ALL dead for 24 h) | Next night's gate REFUSES (G4: intake queue non-empty). The stale line is eventually consumed by ANY live tick's rollover → ONE unattended mock drill epoch (~40 min) self-completes and halts; real specs parked behind it are untouched (plain-queue parking). Note: this wedge requires the whole machine plane to be dead for a day — which the watchdog latch + deadman duty page about independently | G4; `conductor-core.mjs:494-496`; the latch `watchdog/scan.mjs:19-25` |
| F8 | **The reset twin (the teardown's own reset double-fires)** | The fsm-control fan-out wakes conductor + ops (both register the type); the direct reset applies, the queued twin is REJECTED `reset-duplicate` (<30 s, note match) with NO comment — the F-1 guard's exact purpose | `conductor-core.mjs:446-491`; `conductor/turn.mjs:513-521` |
| F9 | **Drill RED is actually a REAL regression** (the drill caught a merge) | That is the product working. The RED page cites the failed A-asserts; the drill report artifact carries timings; the local drill (`e2e/drill.mjs --scenario …`) reproduces offline for bisection | the whole §3 design |

**Explicitly NOT handled (out of scope, stated honestly):** the paid-LLM lane
stays unproven by the nightly (mock economics is the point — the cc lane keeps
its X-series manual cadence, §9 Q3); concurrent real+drill epochs are
STRUCTURALLY impossible (one state, one epoch — F1), not merely gated.

---
