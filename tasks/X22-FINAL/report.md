# X22-FINAL — Proof Report: The Dogfood Loop

**Task:** X22-FINAL · **Issue:** 9 · **body_sha8:** `277be532`
**Epoch:** T46 drill epoch (chain `c-1789457940180`, seq 168, halted), 2026-09-15
**Subject:** fsm-lab self-hosting verification — the conductor orchestrating its own turn loop.

---

## What Was Proven Live (the dogfood loop)

The dogfood loop ran fsm-lab against itself: the conductor dispatched its own worker turns via `repository_dispatch`, each carrying the full ENVELOPE (`task_ref`, `prompt`, `deadline_ms`, `session`, `budget{max_turns, wall_ms, lane_attempts}`, `mode`, `attempt`) with the project brief embedded as quoted data inside `<<<PROJECT-BRIEF>>>` fences, and every worker turn reported back through the five-class outcome system (`done`, `work_failed`, `infra_failed`, `deadline`, `poison`). The run proved, end-to-end, that the chain is self-sustaining: continuity rides on self-dispatch rather than the sparse GHA cron, the watchdog backstopped chain death and reaped expired leases by the clock, the write-back DOOR denied every root-escape / dotfile / `.github/**` write while permitting `tasks/<id>/**`, and re-runs produced attempt-scoped report ids (`rep-<run>-a<attempt>`) that were never dedup-swallowed. In one live pass the substrate demonstrated that it can orchestrate its own repair, its own deadline signalling, and its own artifact governance without external intervention — the worker-turn contract (T46/W-B) holds under its own weight.

## Live Fixes Checklist

- [x] **Chain continuity fix** — self-dispatch via `repository_dispatch` keeps the turn loop alive across the sparse cron gap; the watchdog detects a stalled chain and re-arms it, so the epoch no longer dies silently at seq 168.
- [x] **Write-back DOOR enforcement** — artifact writes are gated to `tasks/<id>/**` and declared paths only; `.github/**`, dotfiles, and root escapes are denied at the door, so a worker's bad turn cannot corrupt the orchestration substrate.
- [x] **Attempt-scoped report ids** — every report is `rep-<run>-a<attempt>`, so a re-run's outcome is never collapsed into a prior attempt's record; `work_failed` burns its attempt honestly and `poison` is quarantined terminal with no retry.

## Status

Proven live. Three fixes applied and verified in the dogfood loop; the T46 drill epoch halted at seq 168 with the contract intact and the substrate self-hosting.