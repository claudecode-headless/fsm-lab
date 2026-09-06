# EVIDENCE — live experiment ledger (fsm-lab)

Every claim carries its run ID / probe log. Nothing here is aspiration.

## X1 — chain physics (the continuity substrate) — COMPLETE

### X1a: GITHUB_TOKEN self-dispatch STARTS workflows ⭐ (the law partially inverted)

- Probe run **34025596219** (`hop 0 · github-token`, 2026-09-06T09:46:38Z): dispatch
  with the job token → `HTTP=204` → log: `VERDICT: GITHUB-TOKEN-WOKE — 1 run(s) fired`.
- Follow-up run **34025603333** (`hop 1 · verify`): `event=repository_dispatch`,
  `triggering_actor=github-actions[bot]`, created 10s after the dispatch.

**Architectural consequence:** same-repo orchestration (conductor self-chain,
worker dispatches, watchdog re-prime, ops nudges) needs **zero PAT** — the
job-scoped ephemeral token suffices (`repository_dispatch` and
`workflow_dispatch` are the documented exceptions to the anti-recursion rule;
`issue_comment` and content events are NOT — that part of E7 stands). The
lab keeps `LAB_PAT` wired as a fallback lane. Cross-repo dispatch still
needs a PAT (why the prior track never saw this).

### X1b: PAT chain — 15 hops, 9.2s avg cadence, 129s span, all success

Runs `hop 1..15 · pat` (09:51:21Z→09:53:30Z). Continuity via PAT
self-dispatch works at ~9s/hop.

### X1c: GITHUB_TOKEN chain — 15 hops, 8.9s avg cadence, all success ⭐

Runs `hop 1..15 · gh-chain` (solo epoch, 10:24Z→10:26Z). Actor sequence:
`zikomolapoutl` (PAT-seeded hop 1) → `github-actions[bot]` for every
subsequent hop — the ephemeral job token chained the whole way. **A
zero-secret infinite chain.**

**Gotcha (measurement):** two chains sharing one `concurrency` group
interleave-cancel (newest-wins) — the first dual launch showed gh-chain
"stopping" at 1 hop (cancelled by PAT-chain hops). Solo re-run settled it.

## X2 — conductor live loop — IN PROGRESS (clean epoch)

- Bootstrap run 34025876490 (09:52:51Z): genesis created, chain live at ~10s/tick.
- **Live-caught integration bugs (the failure model absorbed every one):**
  1. **store.commit dropped `actions`** → leases assigned with no worker
     dispatched (silent livelock; v=5 seq=1 with `actions=0` was the tell).
     Fixed: commit carries mutate's actions/journal (commit 6e3a9a2-era).
  2. **GHA concurrency groups are depth-1, newest-wins — NOT FIFO queues.**
     4 report runs (09:57:12Z–14Z, runs 34026063838/...65711) were CANCELLED
     by the next self-tick. Consequence: run-per-report is lossy under a hot
     chain. FIXED ARCHITECTURALLY: reports CAS-append to
     `state/reports-queue.jsonl`; each tick drains the queue atomically in
     the same state commit (`TICK+2r` / `TICK+3r` commits observed). Data
     flows through git; dispatches are wake-only.
  3. **Quarantined deps deadlocked blocked dependents** (T-103..106 stuck in
     backlog forever). Fixed: CANCEL_CASCADE (dependents of
     quarantined/cancelled tasks cancel; project continues) — live-observed
     at 10:05Z (cascade + M2 STARTED).
  4. **External dispatches into the hot conductor group get
     newest-wins-cancelled** (the reset control run 34026571647 died at
     10:08:09Z). Fixed: controls ride git — the fsm-ops workflow (own
     concurrency group) enqueues `state/control-queue.jsonl`; ticks drain
     controls atomically (+ the ops-nudge tick wakes a stopped chain).
  5. **Payload-shape family (twice):** repository_dispatch carries its type
     in `action`, NOT `event_name` — ops/turn.mjs silently enqueued `pause`
     for a dispatched `reset`, and conductor buildEvent misrouted direct
     fsm-control to a tick. Both fixed; both caught live within minutes.
- Clean epoch (post-reset, chain `c-1788689969158`, 10:20Z+): M1 executing
  with queue-based reports: `TICK+3r` atomic drains, dup-report deduped
  (rejected_events=1), flaky retry (T-102 a2), hang-task correctly gated on
  its dep, workers superseding via per-task cancel-in-progress.

## X3 — parallel workers — IN PROGRESS (inherent in X2: max_parallel=4,
   M2's 8-task batch; CAS contention observable in report-queue commits)

## X4 — failure-injection matrix — PARTIAL (behaviors live: dup ✓ deduped,
   flaky ✓ retried, poison → quarantine observed in the polluted epoch;
   hang/slow/no-report pending in the clean epoch; manual cancel injection
   pending)

## X5 — watchdog re-prime + circuit breaker — PENDING (schedule armed :03/:13/...)

## X6 — state growth — PENDING (rotation proven in sim; live journal at
   ~e200+)

## X7 — real-LLM seam — PENDING
