# research/s22-staged-mode.md — THE STAGED MODE (the nightly real-repo mock epoch)

**Task 22-staged · DESIGN-ONLY · branch `t46/s22-staged` (from `t46/s21-int` @ 644ded6).**
Status: DRAFT — sections land incrementally; see the commit trail.

The design a BUILD agent implements next session without re-deriving anything:
a scheduled, self-verifying, self-cleaning nightly epoch that runs the REAL
five-workflow composition (conductor + worker + watchdog + intake + ops) on
REAL GitHub runners against the REAL `fsm-state` CAS, with **mock economics**
(`EPOCH_MODE=mock` → deterministic harness-shim workers, zero paid API spend,
zero real CC turns).

---

## §0 Scope, prior art, and the demand list

- [x] §0 — what staged mode is; the truth ladder; the local drill's NOT-MODELED list as the demand list
- [ ] §1 — the trigger + gating (the new `staged-drill.yml`; the safety gates; the lock)
- [ ] §2 — the drill epoch shape (the spec; the scenario mix; the wall-time budget)
- [ ] §3 — the verification pass (the post-drain assert job; RED/GREEN behavior)
- [ ] §4 — teardown + isolation (same-repo vs disposable-repo; the RECOMMENDATION)
- [ ] §5 — cadence + budget (runner minutes; the alert budget)
- [ ] §6 — the rollout ladder (manual → weekly → nightly; promotion criteria)
- [ ] §7 — failure modes, honestly
- [ ] §8 — the build items (B-0/B-1/B-2) with exact seams
- [ ] §9 — open questions for the orchestrator

(placeholder — content lands in the following commits)
