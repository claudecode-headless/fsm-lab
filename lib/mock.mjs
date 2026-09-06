// mock.mjs — the deterministic agent simulator (the worker's brain in mock
// mode). Behavior profiles map 1:1 to the failure matrix — this is how the
// lab stress-tests failure handling WITHOUT any LLM in the loop.
//
// Contract: mockWork(behavior, {attempt, work_ms, leaseMinutes}) ->
//   { outcome: {status, ...}, sleepMs, extraReports: [...] }
// The worker workflow: sleep(sleepMs) -> report(outcome) -> [extraReports].

export function mockWork(behavior, ctx = {}) {
  const { attempt = 1, workMs = 5000 } = ctx;
  switch (behavior) {
    case 'succeed':
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:attempt${attempt}` }, sleepMs: workMs };
    case 'flaky':
      if (attempt < 2) return { outcome: { status: 'failed', error: 'flaky-fail-1' }, sleepMs: Math.min(workMs, 2000) };
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:attempt${attempt}` }, sleepMs: workMs };
    case 'poison':
      return { outcome: { status: 'failed', error: 'poison-always' }, sleepMs: Math.min(workMs, 2000) };
    case 'hang':
      // sleeps far past the job timeout — the runner kills us; no report
      // ever fires; the CONDUCTOR's lease deadline is the handler.
      return { outcome: null, sleepMs: 24 * 3600 * 1000 };
    case 'slow':
      // succeeds but after the lease expires — an ORPHANED report (rejected
      // as stale; the work is wasted and counted in stats.orphaned_reports).
      return { outcome: { status: 'done', artifact: `artifact:${ctx.task}:late` }, sleepMs: 30 * 60 * 1000 };
    case 'dup':
      // posts the SAME report payload twice (identical event_id) — the
      // network-retry shape. The conductor's dedup must eat the second.
      return {
        outcome: { status: 'done', artifact: `artifact:${ctx.task}` },
        sleepMs: workMs,
        repeatReport: true,
      };
    case 'no-report':
      // works, but the report dispatch "dies" — lease timeout is the handler.
      return { outcome: null, sleepMs: workMs };
    case 'fail':
      return { outcome: { status: 'failed', error: 'explicit-fail' }, sleepMs: Math.min(workMs, 2000) };
    default:
      return { outcome: { status: 'failed', error: `unknown-behavior:${behavior}` }, sleepMs: 100 };
  }
}
