// fsm.mjs — the pure transition core of the fsm-lab.
//
// DESIGN CONTRACT (Task 43):
//  - NO I/O. Pure functions. state in -> {state', journal[], actions[]} out.
//  - Event-sourced: the JOURNAL (applied events) is the source of truth;
//    state.json is a materialized view. rebuild(genesis, journal) ≈ state.
//  - Idempotent by event.dedup_key (bounded dedup window in state).
//  - Deterministic given (state, event, now). `now` is ALWAYS an argument.
//
// The failure model is first-class: every rejected/stale/duplicate event is
// JOURNALED (applied=false, with a reason) — never silently dropped. The
// journal is the audit trail; stats count the waste (orphaned reports,
// rejected events) so the operator can see it.
//
// Journal record shapes (each carries everything rebuild() needs):
//   {id, ts, kind, applied, ...} where kind ∈
//   TICK           {seq, actor}                      (applied:false when held — F2: no record at all)
//   REPORT         {task, lease, to, run_id}
//   TASK_CREATED   {task, spec}
//   TIMEOUT        {task, from, to}
//   UNLOCK         {task, from, to}
//   RETRY          {task, from, to}
//   ASSIGN         {task, from, to, lease, expires, attempt, behavior}
//   MILESTONE      {milestone, tasks: [specs]}
//   PHASE          {from, to}
//   REJECTED       {origKind, reason, event_id, outcome?}   (applied:false — audit only)
//   CONTROL        {command, patch?, before?, genesisSpec?} (configure/reset carry their payloads)
//   RECOVERY       {reason}                              (conductor-emitted epoch marker; rebuild-skippable)

export const TASK_STATUSES = [
  'backlog', 'ready', 'assigned', 'in_progress',
  'done', 'failed', 'quarantined', 'cancelled',
];
export const TERMINAL = new Set(['done', 'failed', 'quarantined', 'cancelled']);
const TERMINAL_CANCEL = new Set(['quarantined', 'cancelled']);
export const ACTIVE_LEASE = new Set(['assigned', 'in_progress']);

// Allowed directed edges of the task FSM. Anything else is a rejected event.
const EDGES = new Set([
  'backlog>ready', 'ready>assigned',
  'assigned>in_progress',
  'assigned>done', 'assigned>failed', 'assigned>ready', 'assigned>quarantined',
  'in_progress>done', 'in_progress>failed', 'in_progress>ready', 'in_progress>quarantined',
  'failed>ready', 'failed>quarantined',
  'ready>cancelled', 'backlog>cancelled', 'assigned>cancelled', 'in_progress>cancelled',
  'failed>cancelled', 'quarantined>cancelled',
]);

// F12/A3: config bounds — genesis and `configure` both validate through this.
// Upper bounds exist because max_parallel=999 would emit 999 dispatch actions
// with invariants clean (red-team probe D) — a flood class, not a correctness class.
export const CONFIG_BOUNDS = {
  max_parallel: [1, 32],
  lease_minutes: [1, 120],
  max_attempts: [1, 9],
  tick_min_interval_s: [0, 600],
};

export function validateConfig(cfg, where) {
  for (const [k, [lo, hi]] of Object.entries(CONFIG_BOUNDS)) {
    const v = cfg[k];
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`${where}: config.${k} must be an integer in [${lo},${hi}] (got ${v})`);
    }
  }
  if (!Number.isInteger(cfg.dedup_window) || cfg.dedup_window < 16) {
    throw new Error(`${where}: config.dedup_window must be an integer >= 16`);
  }
}

export function genesis({ config, project, chainId, now }) {
  const cfg = {
    max_parallel: 4,
    lease_minutes: 10,
    max_attempts: 3,
    tick_min_interval_s: 0,
    dedup_window: 300,
    ...config,
  };
  validateConfig(cfg, 'genesis');
  if (!(project.tasks || []).length) throw new Error('genesis: project.tasks must be non-empty');
  const tasks = {};
  for (const t of project.tasks || []) tasks[t.id] = mkTask(t, now);
  return {
    schema: 1,
    version: 1,          // strictly increasing; bumped per state-changing commit
    journal_seq: 1,
    chain: { id: chainId, seq: 0, last_tick: now, primed_by: 'genesis', halted: false, paused: false },
    project: { phase: 'executing', milestone: 1, milestones_total: (project.milestones || 1) },
    config: cfg,
    tasks,
    stats: { done: 0, failed: 0, quarantined: 0, cancelled: 0, retries: 0, orphaned_reports: 0, rejected_events: 0, timeouts: 0, dispatched: 0 },
    dedup: [],
  };
}

export function mkTask(t, now) {
  return {
    id: t.id,
    title: t.title || t.id,
    status: t.deps && t.deps.length ? 'backlog' : 'ready',
    behavior: t.behavior || 'succeed',
    work_ms: t.work_ms ?? 6000,
    deps: t.deps || [],
    attempts: 0,
    lease: null, // {token, expires, issued_at}
    created: now,
    updated: now,
    history: [{ at: now, status: t.deps && t.deps.length ? 'backlog' : 'ready', why: 'created' }],
    last_result: null,
  };
}

// ---------------------------------------------------------------------------
// applyEvent — one incoming event against state.
// ---------------------------------------------------------------------------

export function applyEvent(state, ev, now) {
  const s = structuredClone(state);
  // Dedup = EVENT IDENTITY. A real worker generates a fresh event_id per
  // report POST; a network-retry of the same POST reuses it (that is the
  // duplicate the guard exists for). (run,task) identity would be WRONG:
  // progress-then-done from one run are two legitimate events.
  const dedupKey = ev.event_id || ev.dedup_key || `${ev.kind}:${ev.command || ''}:${ev.ts}:${ev.actor || ''}`;
  if (s.dedup.includes(dedupKey)) {
    s.stats.rejected_events += 1;
    return { state: s, applied: false, reason: 'duplicate', eventOut: jrec(s, { kind: 'REJECTED', origKind: ev.kind, task: ev.task || null, event_id: ev.event_id || null, reason: 'duplicate' }, now, false) };
  }
  // F11: event identity is consumed by the drain pipeline exactly once,
  // regardless of outcome — a re-enqueued rejected id arrives as 'duplicate'.
  // This is the consume-on-drain safety net (the queue is emptied each tick;
  // dedup bounds the journal noise of any re-delivery).
  pushDedup(s, dedupKey);
  switch (ev.kind) {
    case 'TICK': {
      // F2: a wake on a HELD chain is not an event — no journal record, no
      // seq bump, no state change. The conductor's noop path quiesces (no
      // commit, no self-dispatch). last_tick staleness is safe to leave: the
      // watchdog checks halted/paused BEFORE staleness (scan.mjs).
      if (s.chain.paused || s.chain.halted) {
        return { state: s, applied: false, reason: s.chain.paused ? 'held-paused' : 'held-halted' };
      }
      s.chain.seq += 1;
      s.chain.last_tick = now;
      s.chain.primed_by = ev.actor || 'chain';
      return { state: s, applied: true, reason: 'tick', eventOut: jrec(s, { kind: 'TICK', seq: s.chain.seq, actor: ev.actor || 'chain' }, now) };
    }
    case 'REPORT': {
      const t = s.tasks[ev.task];
      if (!t) return reject(s, ev, now, 'unknown-task');
      if (!ACTIVE_LEASE.has(t.status) || !t.lease) return reject(s, ev, now, `task-not-leased(${t.status})`);
      if (t.lease.token !== ev.lease) {
        s.stats.orphaned_reports += 1;
        return reject(s, ev, now, 'stale-lease');
      }
      const outcome = ev.outcome || {};
      if (outcome.status === 'progress') {
        return transition(s, t, 'in_progress', now, 'worker-progress', ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'in_progress', run_id: ev.run_id },
          { last_result: { status: 'progress', run_id: ev.run_id } });
      }
      if (outcome.status === 'done') {
        return transition(s, t, 'done', now, 'worker-done', ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: 'done', run_id: ev.run_id },
          { last_result: { status: 'done', run_id: ev.run_id, artifact: outcome.artifact || null, duration_ms: outcome.duration_ms || null } });
      }
      if (outcome.status === 'failed') {
        const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'failed';
        return transition(s, t, dest, now, `worker-failed(attempts=${t.attempts})`, ev,
          { kind: 'REPORT', task: t.id, lease: ev.lease, to: dest, run_id: ev.run_id },
          { last_result: { status: 'failed', run_id: ev.run_id, error: outcome.error || null } });
      }
      return reject(s, ev, now, `bad-outcome(${outcome.status})`);
    }
    case 'TASK_CREATED': {
      if (!ev.task || !ev.task.id || s.tasks[ev.task.id]) return reject(s, ev, now, 'task-exists-or-bad');
      // F9: a ghost dep bricks the chain fail-closed downstream (never
      // unlocks, never cascade-cancels, invariant flags it, conductor
      // throws). Reject at the event boundary where it's recoverable.
      const missing = (ev.task.deps || []).filter(d => !s.tasks[d]);
      if (missing.length) return reject(s, ev, now, `unknown-dep(${missing.join(',')})`);
      s.tasks[ev.task.id] = mkTask(ev.task, now);
      bumpVersion(s);
      return { state: s, applied: true, reason: 'task-created', eventOut: jrec(s, { kind: 'TASK_CREATED', task: ev.task.id, spec: ev.task }, now) };
    }
    case 'CONTROL': {
      const cmd = ev.command;
      if (!['pause', 'resume', 'halt', 'unhalt', 'configure'].includes(cmd)) return reject(s, ev, now, `bad-command(${cmd})`);
      if (cmd === 'configure') {
        // F12: validated, bounded config patch — the runtime knob surface.
        const patch = ev.patch || {};
        const keys = Object.keys(patch);
        if (!keys.length) return reject(s, ev, now, 'configure-empty');
        const bad = keys.filter(k => !(k in CONFIG_BOUNDS));
        if (bad.length) return reject(s, ev, now, `bad-patch-key(${bad.join(',')})`);
        const next = { ...s.config };
        for (const k of keys) next[k] = patch[k];
        try { validateConfig(next, 'configure'); } catch (e) { return reject(s, ev, now, `bad-patch(${String(e.message).slice(0, 120)})`); }
        const changed = keys.filter(k => next[k] !== s.config[k]);
        if (!changed.length) return reject(s, ev, now, 'configure-noop');
        const before = {}, after = {};
        for (const k of changed) { before[k] = s.config[k]; after[k] = next[k]; }
        s.config = next;
        bumpVersion(s);
        return { state: s, applied: true, reason: 'control:configure', eventOut: jrec(s, { kind: 'CONTROL', command: 'configure', patch: after, before }, now) };
      }
      // F13: unhalt on a completed project would restart a done chain with
      // nothing to do — the reset control is the way to restart.
      if (cmd === 'unhalt' && s.project.phase === 'done') return reject(s, ev, now, 'phase-done');
      if (cmd === 'pause') s.chain.paused = true;
      else if (cmd === 'resume') s.chain.paused = false;
      else if (cmd === 'halt') s.chain.halted = true;
      else s.chain.halted = false;
      bumpVersion(s);
      return { state: s, applied: true, reason: `control:${cmd}`, eventOut: jrec(s, { kind: 'CONTROL', command: cmd }, now) };
    }
    default:
      return reject(s, ev, now, `bad-kind(${ev.kind})`);
  }
}

function reject(s, ev, now, reason) {
  s.stats.rejected_events += 1;
  // A4: REJECTED records carry the event identity + (for reports) a sliced
  // outcome — consumed rejects keep their audit trail (F1 deletes the queue
  // line; the journal is the only record of what the worker said).
  const out = { kind: 'REJECTED', origKind: ev.kind, task: ev.task || null, event_id: ev.event_id || null, reason };
  if (ev.kind === 'REPORT' && ev.outcome && typeof ev.outcome === 'object') {
    out.outcome = {
      status: ev.outcome.status ?? null,
      error: ev.outcome.error != null ? String(ev.outcome.error).slice(0, 200) : null,
      artifact: ev.outcome.artifact != null ? String(ev.outcome.artifact).slice(0, 200) : null,
    };
  }
  return { state: s, applied: false, reason, eventOut: jrec(s, out, now, false) };
}

function transition(s, t, dest, now, why, ev, journalFields, extra = {}) {
  const edge = `${t.status}>${dest}`;
  if (!EDGES.has(edge)) return reject(s, ev, now, `bad-edge(${edge})`);
  const from = t.status;
  t.status = dest;
  t.updated = now;
  t.history.push({ at: now, status: dest, why });
  Object.assign(t, extra);
  if (TERMINAL.has(dest)) t.lease = null;
  bumpVersion(s);
  recount(s);
  return { state: s, applied: true, reason: `task:${edge}`, eventOut: jrec(s, { ...journalFields, from }, now) };
}

function pushDedup(s, key) {
  s.dedup.push(key);
  if (s.dedup.length > s.config.dedup_window) s.dedup.splice(0, s.dedup.length - s.config.dedup_window);
}

function bumpVersion(s) { s.version += 1; }

export function recount(s) {
  let done = 0, failed = 0, quarantined = 0, cancelled = 0;
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'done') done++;
    else if (t.status === 'failed') failed++;
    else if (t.status === 'quarantined') quarantined++;
    else if (t.status === 'cancelled') cancelled++;
  }
  s.stats.done = done; s.stats.failed = failed;
  s.stats.quarantined = quarantined; s.stats.cancelled = cancelled;
}

function jrec(s, fields, now, applied = true) {
  const id = `e${s.journal_seq}`;
  s.journal_seq += 1;
  return { id, ts: now, applied, ...fields };
}

// ---------------------------------------------------------------------------
// clock — the scheduling/timeout/phase pass. Deterministic on (state, now).
// nextMilestone(m) -> {tasks:[...]} | null  (the project generator hook).
// ---------------------------------------------------------------------------

const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

export function clock(state, now, nextMilestone) {
  const nowMs = toMs(now);
  const s = structuredClone(state);
  const journal = [];
  const actions = [];
  const J = (fields, applied = true) => { const r = jrec(s, fields, now, applied); journal.push(r); return r; };

  if (s.chain.paused || s.chain.halted) {
    return { state: s, journal, actions: [{ type: 'HOLD_CHAIN', reason: s.chain.paused ? 'paused' : 'halted' }] };
  }

  // 1) lease timeouts
  for (const t of Object.values(s.tasks)) {
    if (ACTIVE_LEASE.has(t.status) && t.lease && toMs(t.lease.expires) <= nowMs) {
      const from = t.status;
      const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'ready';
      t.status = dest; t.updated = now; t.lease = null;
      t.history.push({ at: now, status: dest, why: `lease-timeout(attempts=${t.attempts})` });
      s.stats.timeouts += 1;
      if (dest === 'ready') s.stats.retries += 1;
      bumpVersion(s);
      J({ kind: 'TIMEOUT', task: t.id, from, to: dest });
      // NOTE: alerting is a CONDUCTOR concern — it scans the commit's
      // journal for records with to:'quarantined' / PHASE:done and posts.
      // The FSM stays pure transitions + journal (single responsibility).
    }
  }

  // 2) dependency unlock
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'backlog' && t.deps.length && t.deps.every(d => s.tasks[d] && s.tasks[d].status === 'done')) {
      t.status = 'ready'; t.updated = now;
      t.history.push({ at: now, status: 'ready', why: 'deps-satisfied' });
      bumpVersion(s);
      J({ kind: 'UNLOCK', task: t.id, from: 'backlog', to: 'ready' });
    }
  }

  // 2.5) CASCADE cancellation (live-found design gap): a backlog task whose
  // deps include a quarantined/cancelled task can NEVER unlock — without this
  // the project deadlocks silently in 'executing' forever. The honest state
  // is cascade-cancelled (the feature cannot complete because its dependency
  // failed) — terminal, visible, counted.
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'backlog' && t.deps.some(d => s.tasks[d] && TERMINAL_CANCEL.has(s.tasks[d].status))) {
      t.status = 'cancelled'; t.updated = now;
      t.history.push({ at: now, status: 'cancelled', why: 'dep-failed-cascade' });
      bumpVersion(s);
      J({ kind: 'CANCEL_CASCADE', task: t.id, from: 'backlog', to: 'cancelled', reason: t.deps.find(d => s.tasks[d] && TERMINAL_CANCEL.has(s.tasks[d].status)) });
    }
  }

  // 3) retry pass: failed tasks -> ready (retries left) or quarantined
  for (const t of Object.values(s.tasks)) {
    if (t.status === 'failed') {
      const dest = t.attempts >= s.config.max_attempts ? 'quarantined' : 'ready';
      t.status = dest; t.updated = now;
      t.history.push({ at: now, status: dest, why: `retry-scan(attempts=${t.attempts})` });
      if (dest === 'ready') s.stats.retries += 1;
      bumpVersion(s);
      J({ kind: 'RETRY', task: t.id, from: 'failed', to: dest });
    }
  }

  recount(s);

  // 4) schedule: fill free slots from the ready queue (FIFO by id)
  const inFlight = Object.values(s.tasks).filter(t => ACTIVE_LEASE.has(t.status)).length;
  let free = s.config.max_parallel - inFlight;
  const ready = Object.values(s.tasks).filter(t => t.status === 'ready').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const t of ready) {
    if (free <= 0) break;
    // 12-hex tokens: 8 hex had ~1e-4 birthday-collision odds at 1000 tasks —
    // and a token collision is a false-positive lease theft (bricks fail-closed).
    const token = `l-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const expires = new Date(nowMs + s.config.lease_minutes * 60_000).toISOString();
    const from = t.status;
    t.status = 'assigned'; t.updated = now; t.attempts += 1;
    t.lease = { token, expires, issued_at: new Date(now).toISOString() };
    t.history.push({ at: now, status: 'assigned', why: `assigned(attempt=${t.attempts})` });
    s.stats.dispatched += 1;
    free -= 1;
    bumpVersion(s);
    J({ kind: 'ASSIGN', task: t.id, from, to: 'assigned', lease: token, expires, attempt: t.attempts, behavior: t.behavior });
    actions.push({ type: 'DISPATCH_WORKER', task: t.id, lease: token, behavior: t.behavior, attempt: t.attempts, work_ms: t.work_ms, expires });
  }

  // 5) phase advance — all tasks terminal? (F13: gated on phase !== 'done' —
  // an unhalt-then-tick on a completed project must not re-fire PHASE/STOP)
  const tasksArr = Object.values(s.tasks);
  const allTerminal = tasksArr.length > 0 && tasksArr.every(t => TERMINAL.has(t.status));
  if (allTerminal && s.project.phase !== 'done') {
    const next = nextMilestone ? nextMilestone(s.project.milestone) : null;
    if (next && next.tasks && next.tasks.length) {
      // F9: the milestone door gets the same dep validation as the event
      // boundary — a generator bug must not brick the chain.
      const valid = next.tasks.filter(spec =>
        (spec.deps || []).every(d => s.tasks[d] || next.tasks.some(x => x.id === d)));
      for (const spec of next.tasks) {
        if (!valid.includes(spec)) {
          J({ kind: 'REJECTED', origKind: 'MILESTONE', task: spec.id, reason: 'unknown-dep' }, false);
        }
      }
      if (!valid.length) {
        J({ kind: 'REJECTED', origKind: 'MILESTONE', reason: 'all-specs-invalid' }, false);
        s.project.phase = 'done';
        s.chain.halted = true;
        actions.push({ type: 'STOP_CHAIN', reason: 'milestone-unusable' });
        return { state: s, journal, actions };
      }
      for (const spec of valid) s.tasks[spec.id] = mkTask(spec, now);
      s.project.milestone += 1;
      s.project.phase = 'executing';
      bumpVersion(s);
      J({ kind: 'MILESTONE', milestone: s.project.milestone, tasks: valid });
      actions.push({ type: 'MILESTONE_STARTED', milestone: s.project.milestone, tasks: valid.length });
    } else {
      s.project.phase = 'done';
      s.chain.halted = true;
      bumpVersion(s);
      J({ kind: 'PHASE', from: s.project.phase, to: 'done' });
      actions.push({ type: 'STOP_CHAIN', reason: 'project-complete' });
    }
  }

  return { state: s, journal, actions };
}

// ---------------------------------------------------------------------------
// apply — the composite entry point the conductor calls:
// applyEvent(ev) then clock(). Journal = [event record, ...clock records].
// ---------------------------------------------------------------------------

export function apply(state, ev, now, nextMilestone) {
  const r1 = applyEvent(state, ev, now);
  const c = clock(r1.state, now, nextMilestone);
  return {
    state: c.state,
    journal: r1.eventOut ? [r1.eventOut, ...c.journal] : c.journal,
    actions: c.actions,
    applied: r1.applied,
    reason: r1.reason,
  };
}

// ---------------------------------------------------------------------------
// invariants — machine-checkable after every transition (tests + runtime).
// ---------------------------------------------------------------------------

export function invariants(state) {
  const v = [];
  if (typeof state.version !== 'number' || state.version < 1) v.push('version-bad');
  const leaseOwners = new Map();
  for (const [id, t] of Object.entries(state.tasks)) {
    if (!TASK_STATUSES.includes(t.status)) v.push(`${id}:bad-status(${t.status})`);
    if (ACTIVE_LEASE.has(t.status) && !t.lease) v.push(`${id}:active-without-lease`);
    if (TERMINAL.has(t.status) && t.lease) v.push(`${id}:terminal-with-lease`);
    // F10: a lease on a non-active, non-terminal task is a LEAK (the
    // timeout/retry/terminal paths all clear leases — this catches regressions).
    if (!ACTIVE_LEASE.has(t.status) && !TERMINAL.has(t.status) && t.lease) v.push(`${id}:inactive-with-lease`);
    if (ACTIVE_LEASE.has(t.status) && t.lease) {
      if (leaseOwners.has(t.lease.token)) v.push(`${leaseOwners.get(t.lease.token)}:${id}:duplicate-lease-token`);
      else leaseOwners.set(t.lease.token, id);
    }
    if (t.attempts < 0) v.push(`${id}:attempts-negative`);
    for (const d of t.deps) {
      if (!state.tasks[d]) v.push(`${id}:missing-dep(${d})`);
      else if (ACTIVE_LEASE.has(t.status) && state.tasks[d].status !== 'done') v.push(`${id}:dep-not-done(${d})`);
    }
  }
  const cnt = { done: 0, failed: 0, quarantined: 0, cancelled: 0 };
  for (const t of Object.values(state.tasks)) if (t.status in cnt) cnt[t.status]++;
  for (const k of Object.keys(cnt)) {
    if (state.stats[k] !== cnt[k]) v.push(`stats.${k}=${state.stats[k]}!=${cnt[k]}`);
  }
  const inFlight = Object.values(state.tasks).filter(t => ACTIVE_LEASE.has(t.status)).length;
  if (inFlight > state.config.max_parallel) v.push(`parallel-exceeded(${inFlight}>${state.config.max_parallel})`);
  if (state.dedup.length > state.config.dedup_window) v.push('dedup-window-overflow');
  return v;
}

// ---------------------------------------------------------------------------
// rebuild — event-sourced recovery: replay journal records into state.
// Records with applied:false are audit-only (skipped). The replay is
// edge-guarded: each record only fires if the task is in the recorded `from`
// state (or a compatible state for idempotent skips) — replaying a journal
// twice, or against a partially stale view, is safe by construction.
// ---------------------------------------------------------------------------

export function rebuild(genesisState, journalRecords, { nextMilestone } = {}) {
  let s = structuredClone(genesisState);
  for (const j of journalRecords) {
    // F8: applied:false records are real now (every jrec carries the flag).
    // Mirror the live counter semantics exactly: rejected_events on every
    // reject, orphaned_reports on stale-lease rejects.
    if (j.applied === false) {
      s.stats.rejected_events += 1;
      if (j.origKind === 'REPORT' && j.reason === 'stale-lease') s.stats.orphaned_reports += 1;
      s.journal_seq = Math.max(s.journal_seq, (parseInt((j.id || 'e0').slice(1), 10) || 0) + 1);
      continue;
    }
    const ts = j.ts;
    switch (j.kind) {
      case 'TICK': s.chain.seq = Math.max(s.chain.seq, j.seq || 0); s.chain.last_tick = ts; s.chain.primed_by = j.actor || 'chain'; break;
      case 'REPORT': {
        const t = s.tasks[j.task];
        if (t && ACTIVE_LEASE.has(t.status) && t.lease && t.lease.token === j.lease) {
          if (TASK_STATUSES.includes(j.to)) {
            t.status = j.to; t.updated = ts;
            t.history.push({ at: ts, status: j.to, why: 'replay:REPORT' });
            if (TERMINAL.has(j.to)) t.lease = null;
          }
        }
        break;
      }
      case 'TASK_CREATED': {
        if (j.spec && j.spec.id && !s.tasks[j.spec.id]) s.tasks[j.spec.id] = mkTask(j.spec, ts);
        break;
      }
      case 'TIMEOUT': {
        const t = s.tasks[j.task];
        if (t && (t.status === j.from || ACTIVE_LEASE.has(t.status))) {
          t.status = j.to; t.updated = ts; t.lease = null;
          t.history.push({ at: ts, status: j.to, why: 'replay:TIMEOUT' });
          s.stats.timeouts += 1;
          if (j.to === 'ready') s.stats.retries += 1;   // F8: mirror live
        }
        break;
      }
      case 'UNLOCK': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:UNLOCK' });
          // NOT a retry — live's UNLOCK pass touches no stat
        }
        break;
      }
      case 'RETRY': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:RETRY' });
          if (j.to === 'ready') s.stats.retries += 1;
        }
        break;
      }
      case 'CANCEL_CASCADE': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: 'replay:CANCEL_CASCADE' });
        }
        break;
      }
      case 'ASSIGN': {
        const t = s.tasks[j.task];
        if (t && t.status === 'ready') {
          t.status = 'assigned'; t.updated = ts; t.attempts += 1;
          t.lease = { token: j.lease, expires: j.expires, issued_at: ts };
          t.history.push({ at: ts, status: 'assigned', why: `replay:ASSIGN(attempt=${t.attempts})` });
          s.stats.dispatched += 1;
        }
        break;
      }
      case 'MILESTONE': {
        for (const spec of j.tasks || []) if (!s.tasks[spec.id]) s.tasks[spec.id] = mkTask(spec, ts);
        s.project.milestone = j.milestone;
        s.project.phase = 'executing';
        break;
      }
      case 'PHASE': {
        s.project.phase = j.to;
        if (j.to === 'done') s.chain.halted = true;
        break;
      }
      case 'CONTROL': {
        // F8: reset replays from the journaled slim genesis spec (a reset IS
        // a new epoch; the snapshot-in-journal is the honest representation).
        if (j.command === 'reset' && j.genesisSpec) {
          const sp = j.genesisSpec;
          const g = genesis({
            config: sp.config,
            project: { tasks: sp.tasks, milestones: sp.milestones ?? 1 },
            chainId: sp.chainId,
            now: sp.now || ts,
          });
          g.journal_seq = s.journal_seq;
          s = g;
        } else if (j.command === 'configure' && j.patch) {
          for (const [k, v] of Object.entries(j.patch)) s.config[k] = v;
        } else if (j.command === 'pause') s.chain.paused = true;
        else if (j.command === 'resume') s.chain.paused = false;
        else if (j.command === 'halt') s.chain.halted = true;
        else if (j.command === 'unhalt') s.chain.halted = false;
        break;
      }
      case 'RECOVERY': break;  // epoch marker only — no state change
      default: break;
    }
    recount(s);
    // F8: mirror live's version discipline — one bump per APPLIED non-TICK,
    // non-RECOVERY record (live: bumpVersion at transition/TASK_CREATED/
    // CONTROL/clock-transition sites; never on TICK or rejections). The RESET
    // record does NOT bump: it wholesale-replaces the state (genesis v=1).
    if (!(j.kind === 'TICK' || j.kind === 'RECOVERY' || (j.kind === 'CONTROL' && j.command === 'reset'))) s.version += 1;
    s.journal_seq = Math.max(s.journal_seq, (parseInt((j.id || 'e0').slice(1), 10) || 0) + 1);
  }
  return s;
}
