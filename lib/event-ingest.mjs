// event-ingest.mjs — the conductor's wake-event router, extracted from
// conductor/turn.mjs's buildEvent (T44/F15/F16) so the strict-routing
// contract is testable outside a workflow run (the live payload-shape bug
// bit TWICE in production and zero local layers saw it).
//
// github.event shapes (the ONLY three wake sources — the triggers are
// pinned in conductor.yml: repository_dispatch [fsm-tick, fsm-control] /
// workflow_dispatch / schedule):
//   repository_dispatch  { action: 'fsm-tick' | 'fsm-control' | 'fsm-report',
//                          client_payload: {...} }
//   workflow_dispatch    { inputs: {...}, ref, ... }        (no `action`)
//   schedule             { schedule: '<cron>' }             (no `action`)
//
// STRICT routing (the live-bug #5 lesson):
//   - repository_dispatch carries its type in `action` — `event_name` does
//     NOT exist on dispatch payloads. A github.event carrying `event_name`,
//     or a `client_payload` WITHOUT `action`, is a MALFORMED dispatch:
//     THROW. (The old fallback silently routed such payloads to a tick —
//     the pause-instead-of-reset live bug: the ops ingest read `event_name`
//     where the field was `action`.) A real repository_dispatch ALWAYS
//     carries `action`; schedule/workflow_dispatch wakes NEVER carry
//     `client_payload`.
//   - an UNKNOWN non-empty action is a typo or sabotage: THROW.
//   - an EMPTY action is legitimate only for schedule / manual wakes
//     (and the bare local default `{}` -> manual tick).
//
// The same event_id minting as the pre-extraction buildEvent:
//   TICK    -> `tick-${reason}-${Date.now()}`
//   CONTROL -> `ctl-direct-${command}-${Date.now()}`

export function buildEvent(githubEvent, { now = () => new Date().toISOString() } = {}) {
  const gh = githubEvent || {};
  const cp = gh.client_payload || {};
  const action = typeof gh.action === 'string' ? gh.action : '';
  if (action === 'fsm-report') {
    // legacy lane: reports ride git since the queue rearchitecture; a direct
    // dispatch of this type still lands here — treat it as an event (the FSM
    // will apply it; dedup guards double-delivery with the queue copy).
    return {
      kind: 'REPORT', event_id: cp.event_id, task: cp.task, lease: cp.lease,
      outcome: cp.outcome, run_id: cp.run_id, ts: now(),
    };
  }
  if (action === 'fsm-control') {
    return { kind: 'CONTROL', command: cp.command, patch: cp.patch, event_id: `ctl-direct-${cp.command}-${Date.now()}`, ts: now() };
  }
  if (action === 'fsm-tick' || action === '') {
    // an action-less dispatch SHAPE is the trap: repository_dispatch always
    // carries action; schedule/manual wakes never carry client_payload.
    if (action === '' && (gh.event_name !== undefined || gh.client_payload !== undefined)) {
      throw new Error(
        `buildEvent: malformed repository_dispatch payload (no action${gh.event_name !== undefined ? `, event_name=${JSON.stringify(gh.event_name)}` : ''}) — `
        + 'a real dispatch ALWAYS carries action; event_name does not exist on dispatch payloads (live bug #5)');
    }
    const reason = cp.reason || (gh.schedule ? 'schedule-backstop' : 'manual');
    return { kind: 'TICK', actor: reason, event_id: `tick-${reason}-${Date.now()}`, ts: now() };
  }
  throw new Error(`buildEvent: unknown repository_dispatch action "${action}" (expected fsm-tick | fsm-control | fsm-report)`);
}
