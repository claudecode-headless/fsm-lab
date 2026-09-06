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
//   TICK           {seq, actor}
//   REPORT         {task, lease, to, run_id}
//   TASK_CREATED   {task, spec}
//   TIMEOUT        {task, from, to}
//   UNLOCK         {task, from, to}
//   RETRY          {task, from, to}
//   ASSIGN         {task, from, to, lease, expires, attempt, behavior}
//   MILESTONE      {milestone, tasks: [specs]}
//   PHASE          {from, to}
//   REJECTED       {origKind, reason}   (applied:false — audit only)

export const TASK_STATUSES = [
  'backlog', 'ready', 'assigned', 'in_progress',
  'done', 'failed', 'quarantined', 'cancelled',
];
export const TERMINAL = new Set(['done', 'failed', 'quarantined', 'cancelled']);
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

export function genesis({ config, project, chainId, now }) {
  const cfg = {
    max_parallel: 4,
    lease_minutes: 10,
    max_attempts: 3,
    tick_min_interval_s: 0,
    dedup_window: 300,
    ...config,
  };
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
  const dedupKey = ev.event_id || ev.dedup_key || `${ev.kind}:${ev.ts}:${ev.actor || ''}`;
  if (s.dedup.includes(dedupKey)) {
    s.stats.rejected_events += 1;
    return { state: s, applied: false, reason: 'duplicate', eventOut: jrec(s, { kind: 'REJECTED', origKind: ev.kind, reason: 'duplicate' }, now) };
  }
  switch (ev.kind) {
    case 'TICK': {
      s.chain.seq += 1;
      s.chain.last_tick = now;
      s.chain.primed_by = ev.actor || 'chain';
      pushDedup(s, dedupKey);
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
      pushDedup(s, dedupKey);
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
      pushDedup(s, dedupKey);
      s.tasks[ev.task.id] = mkTask(ev.task, now);
      bumpVersion(s);
      return { state: s, applied: true, reason: 'task-created', eventOut: jrec(s, { kind: 'TASK_CREATED', task: ev.task.id, spec: ev.task }, now) };
    }
    case 'CONTROL': {
      const cmd = ev.command;
      if (!['pause', 'resume', 'halt', 'unhalt'].includes(cmd)) return reject(s, ev, now, `bad-command(${cmd})`);
      pushDedup(s, dedupKey);
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
  return { state: s, applied: false, reason, eventOut: jrec(s, { kind: 'REJECTED', origKind: ev.kind, task: ev.task || null, reason }, now) };
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

function jrec(s, fields, now) {
  const id = `e${s.journal_seq}`;
  s.journal_seq += 1;
  return { id, ts: now, ...fields };
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
  const J = (fields) => { const r = jrec(s, fields, now); journal.push(r); return r; };

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
    const token = `l-${crypto.randomUUID().slice(0, 8)}`;
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

  // 5) phase advance — all tasks terminal?
  const tasksArr = Object.values(s.tasks);
  const allTerminal = tasksArr.length > 0 && tasksArr.every(t => TERMINAL.has(t.status));
  if (allTerminal) {
    const next = nextMilestone ? nextMilestone(s.project.milestone) : null;
    if (next && next.tasks && next.tasks.length) {
      for (const spec of next.tasks) s.tasks[spec.id] = mkTask(spec, now);
      s.project.milestone += 1;
      s.project.phase = 'executing';
      bumpVersion(s);
      J({ kind: 'MILESTONE', milestone: s.project.milestone, tasks: next.tasks });
      actions.push({ type: 'MILESTONE_STARTED', milestone: s.project.milestone, tasks: next.tasks.length });
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
  for (const [id, t] of Object.entries(state.tasks)) {
    if (!TASK_STATUSES.includes(t.status)) v.push(`${id}:bad-status(${t.status})`);
    if (ACTIVE_LEASE.has(t.status) && !t.lease) v.push(`${id}:active-without-lease`);
    if (TERMINAL.has(t.status) && t.lease) v.push(`${id}:terminal-with-lease`);
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
    if (j.applied === false) { s.stats.rejected_events += 1; s.journal_seq += 1; continue; }
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
        }
        break;
      }
      case 'UNLOCK': case 'RETRY': {
        const t = s.tasks[j.task];
        if (t && t.status === j.from) {
          t.status = j.to; t.updated = ts;
          t.history.push({ at: ts, status: j.to, why: `replay:${j.kind}` });
          if (j.to === 'ready') s.stats.retries += 1;
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
        if (j.command === 'pause') s.chain.paused = true;
        else if (j.command === 'resume') s.chain.paused = false;
        else if (j.command === 'halt') s.chain.halted = true;
        else if (j.command === 'unhalt') s.chain.halted = false;
        break;
      }
      default: break;
    }
    recount(s);
    s.version += 1;
    s.journal_seq = Math.max(s.journal_seq, (parseInt((j.id || 'e0').slice(1), 10) || 0) + 1);
  }
  return s;
}
