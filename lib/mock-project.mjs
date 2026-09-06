// mock-project.mjs — the mock software-project workload generator.
//
// The "project" the FSM orchestrates: 3 milestones of tasks with a DAG and
// deliberate failure profiles baked in (the failure-injection matrix as
// workload, not as external tooling — the lab exercises its own failure
// handling by construction):
//   - flaky tasks (fail once, then succeed)      -> retry path
//   - poison task  (always fail)                 -> quarantine path
//   - hang task    (never reports; job timeout)  -> lease timeout path
//   - slow task    (reports after lease expiry)  -> orphaned-report path
//   - dup task     (reports twice)               -> dedup path
//   - no-report    (work, dispatch dies)         -> lease timeout path
// Everything else: fast succeeds (throughput + parallelism measurement).
//
// nextMilestone(m) is the generator hook the conductor passes into the FSM.

export function mockProject() {
  return {
    milestones: 3,
    // M1 — the seed round: research → parallel implement → review (DAG)
    m1: [
      { id: 'T-101', title: 'research: state-anchor options', behavior: 'succeed', work_ms: 4000 },
      { id: 'T-102', title: 'research: continuity mechanics', behavior: 'flaky', work_ms: 3000 },
      { id: 'T-103', title: 'impl: state store CAS', behavior: 'succeed', work_ms: 5000, deps: ['T-101'] },
      { id: 'T-104', title: 'impl: conductor loop', behavior: 'succeed', work_ms: 5000, deps: ['T-101'] },
      { id: 'T-105', title: 'impl: watchdog', behavior: 'hang', work_ms: 900000, deps: ['T-102'] },
      { id: 'T-106', title: 'review: M1', behavior: 'succeed', work_ms: 3000, deps: ['T-103', 'T-104'] },
      { id: 'T-107', title: 'edge: duplicate report', behavior: 'dup', work_ms: 3000 },
      { id: 'T-108', title: 'edge: late report (orphan)', behavior: 'slow', work_ms: 900000 },
    ],
    // M2 — parallel batch (throughput + contention)
    m2: [
      { id: 'T-201', title: 'impl: parallel a', behavior: 'succeed', work_ms: 4000 },
      { id: 'T-202', title: 'impl: parallel b', behavior: 'succeed', work_ms: 4000 },
      { id: 'T-203', title: 'impl: parallel c', behavior: 'flaky', work_ms: 4000 },
      { id: 'T-204', title: 'impl: parallel d', behavior: 'succeed', work_ms: 4000 },
      { id: 'T-205', title: 'impl: parallel e', behavior: 'no-report', work_ms: 3000 },
      { id: 'T-206', title: 'impl: parallel f', behavior: 'succeed', work_ms: 4000 },
      { id: 'T-207', title: 'impl: poison path', behavior: 'poison', work_ms: 2000 },
      { id: 'T-208', title: 'impl: parallel g', behavior: 'succeed', work_ms: 4000 },
    ],
    // M3 — integration + close (chain STOP at completion)
    m3: [
      { id: 'T-301', title: 'impl: integration', behavior: 'succeed', work_ms: 4000, deps: [] },
      { id: 'T-302', title: 'review: final', behavior: 'succeed', work_ms: 3000, deps: ['T-301'] },
    ],
  };
}

// The generator hook: milestone number -> {tasks} | null (null = project done).
export function nextMilestoneFactory(spec) {
  return (m) => {
    const key = `m${m + 1}`; // project.milestone is 1-based; next is m+1
    const tasks = spec[key];
    return tasks ? { tasks } : null;
  };
}

// A FAST project for the pure-FSM unit tests (no wall-clock waits; the
// failures ride tiny work_ms values — behaviors matter, durations don't).
export function fastProject() {
  return {
    milestones: 2,
    m1: [
      { id: 'A1', title: 'a1', behavior: 'succeed', work_ms: 1 },
      { id: 'A2', title: 'a2', behavior: 'flaky', work_ms: 1 },
      { id: 'A3', title: 'a3', behavior: 'poison', work_ms: 1 },
      { id: 'A4', title: 'a4', behavior: 'succeed', work_ms: 1, deps: ['A1'] },
      { id: 'A5', title: 'a5', behavior: 'dup', work_ms: 1 },
    ],
    m2: [
      { id: 'B1', title: 'b1', behavior: 'succeed', work_ms: 1, deps: [] },
    ],
  };
}
