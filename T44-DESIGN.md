# Task 44 — Fix Design (audit-driven refinement of Task 43)

**Round:** Task 44 (session 13), the audit + deepen round.
**Inputs:** five parallel sub-agent audits (44-a FSM core, 44-b store, 44-c GHA glue, 44-d sim/coverage, 44-e docs-vs-reality), all findings re-verified by the main agent against the code and live repo state.
**Live state at design time:** project `phase=done halted=true` v71 seq47; 3 zombie reports parked in `state/reports-queue.jsonl` re-rejected every backstop tick; journal seq 539; backstops fire ~2h apart (schedule cold-start + sparse); watchdog no-ops on halted 5/5.

The design is three waves. Wave 1 = live-burning correctness. Wave 2 = core hardening (rebuild parity, event-boundary validation, invariants). Wave 3 = the fourth test layer (conductor-core extraction + GHA-semantics shim). Each wave: implement → local suites extended → push → live-verified.

---

## Wave 1 — live-burning fixes

### F1. Consume-on-drain (the zombie-report loop) — P1 ×3 auditors
**Where:** `conductor/turn.mjs` drain loop (report + control queues).
**Defect:** every non-applied, non-duplicate queue item is re-parked (`surviving.push(q)`) and re-rejected on every tick forever. Reject reasons are all permanent (`unknown-task`, `task-not-leased`, `stale-lease`, `bad-outcome`, `bad-command`), so nothing ever re-validates. Live: 3 reports × ~4 journal records/tick, forever.
**Fix:** drain consumes EVERY item — applied, duplicate, or rejected (each rejection is already journaled once with its reason). Remove the `surviving`/`survivingCtl` arrays; always write the emptied queue. Safety argument: re-enqueue of a rejected event_id is caught by dedup (F11 moves pushDedup before outcome validation), so journal noise per id is bounded at one REJECTED + one REJECTED(duplicate) in the dedup window.
**Observed-live proof plan:** after the fix, the first wake commits one drain (3 REJECTED records + queue emptied); every subsequent wake is a no-op (F2). Branch tip SHA freezes.

### F2. Quiescent wakes (halted/paused + empty queues ⇒ no commit, no self-dispatch) — P1/P2 ×3
**Where:** `lib/fsm.mjs` TICK case + `conductor/turn.mjs` noop path.
**Defect:** (a) TICK always journals (≥1 record) even on a held chain ⇒ the conductor's `journals.length===0` noop gate is unreachable ⇒ every backstop commits (v70→71, journal 518→539 across 5 fires). (b) The noop path self-dispatches unconditionally (`turn.mjs:215-218`) — latent chain-restart on a stopped chain.
**Fix (FSM level, cleaner than a conductor-side gate):**
```js
case 'TICK': {
  if (s.chain.paused || s.chain.halted) {
    return { state: s, applied: false, reason: s.chain.paused ? 'held-paused' : 'held-halted' };
  }
  // … existing seq/last_tick/primed_by/journal code …
}
```
A wake on a held chain is not an event. No journal record, no seq bump, no last_tick update (safe: the watchdog checks `halted`/`paused` BEFORE staleness — `scan.mjs:87-88`). A tick that DRAINS something (queue items ⇒ journals) still commits — the drain is real work. A tick that unpauses via a drained control applies normally (state was already unpaused when `apply(ev)` runs).
**Conductor noop path:** no self-dispatch on noop, ever — the only reachable noop reasons are `held-paused`/`held-halted`. Log `QUIESCED <reason>`. Wake sources (backstop, watchdog, ops-nudge) remain the revival paths; the watchdog treats paused/halted as intentional.
**Proof plan:** halted project + 10 manual wakes ⇒ exactly 0 new commits after the drain-commit lands.

### F3. ops-nudge 401 (token never passed) — P1, live-confirmed
**Where:** `.github/workflows/ops.yml` ingest env + `ops/turn.mjs`.
**Defect:** env carries only `GITHUB_REPOSITORY`/`EVENT`; `TOKEN = GH_TOKEN || PAT` = undefined ⇒ `Authorization: token undefined` ⇒ **401 on every nudge since birth** (live: HTTP=401 in runs 34026953026, 34028691734; both runs "success" — the status was logged, never checked). Control latency silently degraded to the backstop cadence (~2h).
**Fix:** add `GH_TOKEN: ${{ github.token }}` to the ops env (`contents: write` is already granted; X1a makes the job token sufficient). Non-204 ⇒ one retry after 2s ⇒ non-204 ⇒ `process.exitCode = 3` (visible failure). 
**Proof plan (X8):** dispatch a control on the halted project ⇒ applied within ~seconds (dispatch→run latency), not ~2h.

### F4. commit-tree rc guard (branch-deletion path) — P0-class, probe-confirmed
**Where:** `lib/store.mjs` `buildCommit`.
**Defect:** `commit-tree` result taken via `.stdout.trim()` with NO status check (every other plumbing call checks). A failing commit-tree yields an empty sha ⇒ the push refspec becomes `:refs/heads/fsm-state` ⇒ **the state branch is DELETED and commit() reports success** (probe D2 reproduced this).
**Fix:** check `spawnSync` status; throw on rc≠0; belt-and-braces assert the returned sha matches `/^[0-9a-f]{40,64}$/` before any push builds a refspec from it.

### F5. Rotation: disjoint generations + numeric ordering — P1/P2
**Where:** `lib/store.mjs` `rotatePlan`, `readJournals`, `readJournalTail`.
**Defects:**
1. On overflow, the new generation is seeded with `merged.slice(-500)` — the previous gen's ~500 lines PLUS the new records ⇒ each gen is a ~99% duplicate of its predecessor (live: 2000 lines, 512 distinct ids). Retention semantics are actually "≈500 distinct", not "4×500".
2. Readers sort journal files **lexicographically** (`files.sort()`) while the rotator sorts numerically ⇒ at gen ≥ 10, `journal-10` sorts before `journal-9` ⇒ the dedup-window tail reads the WRONG generation (oldest, not newest).
**Fix:** on rotation, the new gen carries **only the new records** (the previous gen file is left untouched on the branch — its content is already persisted). Numeric sort in both readers (parse the gen number). Oversized batches (new records > rotateAt in one commit) land in one big gen and rotate again next commit — bounded, documented.
**Note on live migration:** the current live branch has overlapping gens 6–9; after the fix, the next rotation writes gen-10 with only new records, and old gens prune away as gen climbs. No migration commit needed.
**Proof plan:** store test asserting distinct-id count ≈ keepGens × rotateAt after driving > 2×rotateAt records through; a gen≥10 ordering test (name files journal-2..journal-10, assert tail reads gen-10 first).

### F6. Retry-After awareness + jittered CAS backoff — P2 ×2
**Where:** `conductor/turn.mjs` `api()/dispatchRetry`, `watchdog/scan.mjs` re-prime, `lib/store.mjs` CAS ladders.
**Defects:** a 403 with `Retry-After: 60` burns all 3 fixed-backoff tries in 6s ⇒ chain death (watchdog latency ~2h live). The store CAS ladder has NO sleep between attempts (tight re-read loop — 44-b measured 15/36 starved writers at attempts=4). The watchdog re-prime has no retry at all.
**Fix:** `api()` returns response headers; `dispatchRetry` sleeps `max(Retry-After×1000, base×attempt)` on 403/429 (with ±20% jitter), attempts 3→5. Watchdog re-prime: one retry after 2s. Store ladders: 250ms×attempt×jitter(0.8–1.2) between attempts; `commit` attempts 4→6, enqueues 5→8.

### F7. ops-nudge/wake on branch deletion + bootstrap notice — P2
**Where:** `conductor/turn.mjs` bootstrap branch.
**Defect:** silent genesis re-bootstrap when the fsm-state branch is missing — the watchdog then sees a healthy fresh chain (README even documents an alert that isn't implemented).
**Fix:** the mutate output gains `{type:'BOOTSTRAP_NOTICE'}` in actions when genesis ran; the conductor's action loop posts one ops-issue comment (`**[fsm]** BOOTSTRAP: fresh genesis (state branch was absent — previous state lost?)`). Also alerts if `chain.id` CHANGED between read and mutate base (a reset by a rival writer) — no, keep scope: only the bootstrap notice.

---

## Wave 2 — core hardening

### F8. Rebuild parity (the event-sourcing proof made honest) — P1
**Where:** `lib/fsm.mjs` `jrec/reject/clock-J/rebuild`.
**Defects:** journal records never carry `applied` (the `j.applied === false` skip in rebuild is dead code); rebuild's counter semantics diverge from live (retries on TIMEOUT→ready not mirrored; UNLOCK wrongly counts as retry; orphaned_reports not counted; version bumps per record instead of per state-change); no RESET replay (reset records are hand-crafted by the conductor and invisible to rebuild).
**Fix:**
1. `jrec(s, fields, now, applied = true)`; `reject()` passes `applied:false`. Every record now carries the flag.
2. rebuild: skip `applied === false` (now real); count `rejected_events` on skip; `orphaned_reports += 1` when `j.reason === 'stale-lease'`; TIMEOUT case mirrors `if (j.to === 'ready') retries++`; UNLOCK does NOT count as retry; version bumps only for applied non-TICK records (mirroring live's bumpVersion call sites).
3. RESET: the conductor's reset journal record carries the new genesis state (`{kind:'CONTROL', command:'reset', applied:true, genesis:<state>}`); rebuild's CONTROL case for `reset` clones `j.genesis` (with journal_seq continuity). A reset IS a new epoch — snapshot-in-journal is the honest representation.
4. Test: full-parity rebuild test — drive a rich sequence (assigns, reports, rejects, timeouts, cascades, a reset, milestone, phase-done) through live apply, then rebuild from the journal, assert **deep-equal state** (modulo nothing). This is the strengthened event-sourcing proof.

### F9. Event-boundary validation: ghost deps — P2 (P0-adjacent once issue-ingestion lands)
**Where:** `lib/fsm.mjs` TASK_CREATED.
**Defect:** a task with deps referencing task ids that don't exist never unlocks, never cascade-cancels (cascade only fires on quarantined/cancelled deps), the invariant flags it, the conductor throws on invariant violation ⇒ every subsequent commit refused ⇒ chain bricks fail-closed.
**Fix:** TASK_CREATED with a dep not in `s.tasks` ⇒ reject (`unknown-dep(<d>)`), journaled, consumed. The ingester's contract: create deps first (or dep-less). Preserves fail-closed at the EVENT boundary where it's recoverable, instead of bricking the clock.

### F10. Invariant additions — P2
**Where:** `lib/fsm.mjs` `invariants()`.
**Fix:** (a) `inactive-with-lease` — any non-ACTIVE, non-TERMINAL status carrying a lease (leak detector: ready/backlog/failed with a lease); (b) lease-token uniqueness — two ACTIVE tasks sharing one token (double-assignment detector).

### F11. Dedup discipline: pushDedup before outcome validation — P3→included (it's the F1 safety net)
**Where:** `lib/fsm.mjs` REPORT case.
**Fix:** move `pushDedup(s, dedupKey)` to immediately after the duplicate check (before task/lease/outcome validation). Event identity is consumed exactly once by the drain pipeline regardless of outcome; a re-enqueued rejected id becomes `duplicate` (bounded journal noise). This is the F1 safety net. Note the semantic change: a "corrected retry reusing the same event_id" is now a duplicate — the doctrine is the id IS the identity (workers mint fresh ids per POST; X4's injection and X7's real worker both comply).

### F12. `configure` control + genesis validation — P2 + closes a doc lie
**Where:** `lib/fsm.mjs` CONTROL case + genesis, `ops/turn.mjs` whitelist, `conductor/turn.mjs` control drain.
**Defects:** FSM-ORCHESTRATION.md claims knobs "change with a control" — no such control exists (reset hardcodes config). Genesis validates nothing (44-a: `max_parallel=0` livelocks; empty task set never completes).
**Fix:**
1. `genesis()` throws on: `max_parallel<1`, `lease_minutes<1`, `max_attempts<1`, `tick_min_interval_s<0`, `dedup_window<16`, empty `project.tasks`.
2. New CONTROL `configure` with a patch object `{max_parallel?, lease_minutes?, max_attempts?, tick_min_interval_s?}` — same validation, applied + journaled (`{kind:'CONTROL', command:'configure', patch, from, to}`); rejected if no fields change or any value invalid. Ops whitelist + `configure` (payload carries `patch`).
3. This is ALSO the real-lane lease fix: `lease_minutes` 4→15 before real-LLM/CC turns (X14), with the lease-budget formula documented (lease ≥ dispatch latency + work + report margin; worker `timeout-minutes` ≥ lease + 2min).

### F13. `unhalt` on a done project — P3 (but prevents a live double-comment + wasteful loop)
**Where:** `lib/fsm.mjs` CONTROL case + clock completion branch.
**Defect:** unhalt after completion ⇒ clock re-runs the completion branch ⇒ second PHASE record + duplicate PROJECT-COMPLETE comment; and an unhalt on phase=done leaves a live ticking chain with nothing to do.
**Fix:** (a) clock's completion branch gated on `s.project.phase !== 'done'`; (b) CONTROL `unhalt` rejected with `phase-done` when `project.phase === 'done'` (the reset control is the way to restart).

### F14. Doc/comment truth pass (in-repo) — P0-doc + the 44-e edit list
`conductor.yml:5-8`, `chain-probe.yml:3-4,27-28`, `README.md` (the inverted anti-recursion law; test counts 18+7=25; ops.yml in the layout; `reset` in the ops command list; corruption-row "live X4" claim; bootstrap-alert wording; invariants wording "after every commit"), `worker.yml` header comment (reports ride git, not dispatches), `EVIDENCE.md` (X1c timestamps 10:21:35→10:23:40; cascade 10:08:55Z; X6 sliding-window truth + falsified "consume" residual + post-session schedule physics), `FSM-ORCHESTRATION.md` (schedule verdict "cold-start ~4h then ~2h sparse"; knob wording; bounded-state addendum; invariants wording) — the full list is in the 44-e worklog section.

---

## Wave 3 — the fourth test layer (deepening)

### F15. conductor-core extraction (`lib/conductor-core.mjs`)
Move the conductor's mutate (drain ordering, bootstrap/recovery closure injection, event application, noop logic) into a pure-ish lib function:
```js
conductorTick({ cur, queue, controlQueue, ev, now, nextMilestone, recover, makeGenesis })
  → { state, journal, actions, queue: [], controlQueue: [], noop?, reason, message }
```
`recover()` and `makeGenesis()` are injected closures (store I/O / mock project). The YAML conductor becomes a thin adapter. All three test layers + the shim drive the SAME code — closing the "integration logic lives in turn-files" gap that let 5 bugs escape.

### F16. GHA-semantics shim (`sim/gha-shim.mjs`)
- `ConcurrencyGroup` — depth-1 pending, newest-wins-cancel, ~24s cancel propagation; models run-per-event lossiness (would have caught live bugs #2/#4).
- `DispatchLane` — dispatch latency (default 164s — the live 2m44s observation), drop probability, 403+Retry-After shape, 3-try retry semantics (would have caught the lease-budget class).
- `lib/event-ingest.mjs` — extracted `buildEvent` that THROWS on unknown payload shapes; frozen live `github.event` fixtures (tick/report/control/schedule/workflow_dispatch) with the `action`-vs-`event_name` trap encoded (would have caught live bug #5).

### F17. Shim-driven regression scenarios
The five escaped-bug classes as permanent sim scenarios: actions-drop (every ASSIGN ⇒ a dispatch record, else FAIL), queue-cancel (every enqueued report ⇒ applied‖duplicate within K ticks under newest-wins), dep-deadlock (the 18-task mockProject to completion — zero non-terminal, zero backlog-with-failed-deps), control-cancel (control applied within K ticks on a hot chain), payload-shape (fixtures through event-ingest, unknown ⇒ throw). Plus: lease-margin (no worker starts after its lease would expire under configured dispatch latency) and a 200-task scale run.

---

## Deliberate non-fixes (recorded decisions)
- **Dedup window semantics** (300 slots vs 300 seconds): keep slots, keep the name, document — the consume-on-drain + early pushDedup are the real guards; a rename breaks live state compat for zero correctness gain.
- **Snapshot-rollback regression window on corruption** (44-b): the window is one commit; corruption on-branch is near-impossible (atomic git commits); recovery convergence is covered by lease self-healing + queue re-drain. Document honestly, don't build journal-ahead replay.
- **`node --test tests/` breakage on Node 24**: use the glob form (`node --test "tests/*.mjs"`) in validate.sh (already the case) — directory-arg behavior is a Node quirk, not our bug.
- **state.json size at 1000+ tasks** (0.77KB/task, O(N²) byte traffic per event at scale): task-history pruning / archival is deferred to the issue-ingestion round where real task volume exists. The scale envelope (200 tasks, 15s) is measured and documented.

## Live experiment plan (post-wave-1 push)
- **X11 (free, immediate):** the first backstop/manual wake post-fix ⇒ ONE drain commit (3 REJECTED + queue emptied), then branch tip freezes. The zombie loop's tombstone.
- **X9:** 10 manual wakes on the halted project ⇒ 0 commits (assert tip SHA equality).
- **X8:** ops control dispatch ⇒ applied in ~seconds (nudge 204, no 401).
- **X13:** 10-writer CAS burst re-run with jittered backoff (compare: 0 lost, faster convergence, fewer starved writers).
- **X10 (via reset):** fresh project run to completion ⇒ rotation disjointness verified live (distinct-id count).
- **X14 (real lane):** `configure lease_minutes=15`, real-LLM worker with a slow prompt ⇒ completes without supersession.
- **X5c (regression):** kill/re-prime once more post-fix ⇒ watchdog still correct under the new quiescence semantics.
