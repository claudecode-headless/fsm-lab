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
