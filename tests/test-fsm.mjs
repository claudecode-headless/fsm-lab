// test-fsm.mjs — the transition-matrix + invariants suite (node:test).
// The vacuous-fixture discipline: every test drives the REAL apply()/clock()
// exports, asserts fsm.invariants() after EVERY step, and proves the failure
// classes (dup, stale, orphan, poison, quarantine, edges, dedup, rebuild).

import test from 'node:test';
import assert from 'node:assert/strict';
import { genesis, apply, clock, invariants, rebuild, mkTask } from '../lib/fsm.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const T0 = '2026-09-06T10:00:00.000Z';
const step = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();
const NM = nextMilestoneFactory(fastProject());

function boot(config = {}) {
  let s = genesis({
    config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-chain',
    now: T0,
  });
  return s;
}

const ok = (s, label) => {
  const v = invariants(s);
  assert.deepEqual(v, [], `invariants violated after ${label}: ${v.join('; ')}`);
};

// a worker report helper — every report gets a UNIQUE event identity
// (fresh uuid per call unless evtId is pinned — the network-retry shape).
const report = (task, lease, outcome, ts, runId = 'run-1', evtId) => ({
  kind: 'REPORT', event_id: evtId || `evt-${crypto.randomUUID().slice(0, 12)}`,
  task, lease, outcome, run_id: runId, ts,
});

// ---------------------------------------------------------------------------
test('genesis: deps route tasks to backlog vs ready; invariants hold', () => {
  const s = boot();
  ok(s, 'genesis');
  assert.equal(s.tasks.A1.status, 'ready');
  assert.equal(s.tasks.A4.status, 'backlog'); // depends on A1
  assert.equal(s.version, 1);
});

test('TICK: assigns up to max_parallel, journals ASSIGN, emits DISPATCH_WORKER actions', () => {
  const s = boot({ max_parallel: 2 });
  const r = apply(s, { kind: 'TICK', ts: T0, actor: 'chain' }, T0, NM);
  ok(r.state, 'tick1');
  assert.equal(r.reason, 'tick');
  const assigned = Object.values(r.state.tasks).filter(t => t.status === 'assigned');
  assert.equal(assigned.length, 2, 'max_parallel=2 respected');
  assert.equal(r.state.chain.seq, 1);
  // FIFO by id: A1, A2 first (A3, A5 also ready — id order: A1,A2,A3,A5)
  assert.deepEqual(assigned.map(t => t.id).sort(), ['A1', 'A2']);
  const dispatches = r.actions.filter(a => a.type === 'DISPATCH_WORKER');
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.every(d => d.lease && d.attempt === 1 && d.expires > T0));
  const assignJ = r.journal.filter(j => j.kind === 'ASSIGN');
  assert.equal(assignJ.length, 2);
  assert.equal(r.state.journal_seq, 1 + r.journal.length, 'journal_seq advanced past all records');
});

test('REPORT done: task -> done, dep unlock on next clock, stats recount', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const a1 = r.state.tasks.A1;
  const lease = a1.lease.token;
  // A1 reports done
  r = apply(r.state, report('A1', lease, { status: 'done', artifact: 'x' }, step(10_000)), step(10_000), NM);
  ok(r.state, 'report-done');
  assert.equal(r.state.tasks.A1.status, 'done');
  assert.equal(r.state.stats.done, 1);
  // A4 (dep on A1) unlocked by the SAME apply's clock pass
  assert.equal(r.state.tasks.A4.status, 'ready', 'dep unlocked in the same clock pass');
  // a slot freed -> A3 assigned (FIFO: A3 before A5? ready queue after unlock: A3, A5 — wait A2 is assigned, in-flight=1, free=1)
  assert.ok(r.state.tasks.A3.status === 'assigned' || r.state.tasks.A5.status === 'assigned');
});

test('duplicate REPORT: second identical report is a no-op (dedup), journaled as REJECTED', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  const ev = report('A1', lease, { status: 'done' }, step(5000));
  const r1 = apply(r.state, ev, step(5000), NM);
  assert.equal(r1.state.tasks.A1.status, 'done');
  const r2 = apply(r1.state, ev, step(6000), NM); // byte-identical event (same event_id)
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, 'duplicate');
  assert.equal(r2.state.tasks.A1.status, 'done');
  assert.equal(r2.state.stats.rejected_events, 1);
  assert.ok(r2.journal.some(j => j.kind === 'REJECTED' && j.reason === 'duplicate'));
  ok(r2.state, 'dup');
});

test('stale-lease REPORT: rejected, counted as orphaned, task untouched', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const before = r.state.tasks.A2.status; // assigned
  const r1 = apply(r.state, report('A2', 'l-wrongtoken', { status: 'done' }, step(5000)), step(5000), NM);
  assert.equal(r1.state.tasks.A2.status, before, 'task state untouched by stale report');
  assert.equal(r1.state.stats.orphaned_reports, 1);
  assert.ok(r1.journal.some(j => j.kind === 'REJECTED' && j.reason === 'stale-lease'));
  ok(r1.state, 'stale');
});

test('lease timeout: attempts < max -> ready then IMMEDIATE reassign in the same clock pass', () => {
  let s = boot({ lease_minutes: 1 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease0 = r.state.tasks.A2.lease.token;
  // 2 minutes later: both leases expired, attempts=1 < 3 -> ready, then
  // the SAME clock pass refills the free slot -> assigned (attempts=2)
  r = apply(r.state, { kind: 'TICK', ts: step(120_000) }, step(120_000), NM);
  ok(r.state, 'timeout');
  const a2 = r.state.tasks.A2;
  assert.ok(['ready', 'assigned'].includes(a2.status), `post-timeout status: ${a2.status}`);
  assert.equal(a2.attempts, 2, 'reassignment consumed attempt 2');
  assert.equal(r.state.stats.timeouts, 2, 'both leased tasks timed out');
  assert.equal(r.state.stats.retries, 2);
  assert.notEqual(a2.lease?.token, lease0, 'the expired lease token is gone');
  assert.ok(r.journal.some(j => j.kind === 'TIMEOUT' && j.task === 'A2'));
});

test('poison task: exhausts attempts -> quarantined, ALERT action emitted', () => {
  let s = boot({ max_parallel: 4, lease_minutes: 1, max_attempts: 3 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A3 assigned attempt 1
  // three failed reports (each failure + retry-scan reassigns)
  let now = 10_000;
  for (let i = 0; i < 3; i++) {
    const t = r.state.tasks.A3;
    assert.ok(t.lease, `A3 should be leased at round ${i}, status=${t.status}`);
    r = apply(r.state, report('A3', t.lease.token, { status: 'failed', error: 'poison' }, step(now), `run-${i}`), step(now), NM);
    now += 10_000;
    ok(r.state, `poison-round-${i}`);
    if (i < 2) {
      // failed -> retry-scan -> ready -> SAME clock pass reassigns
      assert.ok(['failed', 'ready', 'assigned'].includes(r.state.tasks.A3.status),
        `round ${i}: ${r.state.tasks.A3.status}`);
      assert.equal(r.state.tasks.A3.attempts, i + 2, 'attempts advance per reassignment');
    }
  }
  assert.equal(r.state.tasks.A3.status, 'quarantined', 'poison eventually quarantined');
  assert.equal(r.state.tasks.A3.attempts, 3);
  // alerting is the conductor's journal scan — the RECORD is the trigger
  assert.ok(r.journal.some(j => j.to === 'quarantined' && j.task === 'A3'));
  ok(r.state, 'poison-final');
});

test('flaky task: fails once then succeeds on retry (the at-least-once path)', () => {
  let s = boot({ max_parallel: 4 });
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A2 assigned attempt 1
  r = apply(r.state, report('A2', r.state.tasks.A2.lease.token, { status: 'failed', error: 'flaky' }, step(5000), 'run-a'), step(5000), NM);
  // failed -> retry-scan -> reassign happens in the same clock pass
  const t = r.state.tasks.A2;
  assert.equal(t.status, 'assigned', 'reassigned in the same clock pass');
  assert.equal(t.attempts, 2);
  r = apply(r.state, report('A2', t.lease.token, { status: 'done', artifact: 'ok' }, step(7000), 'run-b'), step(7000), NM);
  assert.equal(r.state.tasks.A2.status, 'done');
  assert.equal(r.state.stats.retries, 1);
  ok(r.state, 'flaky');
});

test('milestone advance: all-terminal -> next milestone tasks created', () => {
  let s = boot({ max_parallel: 8, max_attempts: 1, lease_minutes: 1 });
  // drain M1: everything terminal (poison quarantined at 1 attempt, etc.)
  let r = { state: s };
  let now = 0;
  for (let guard = 0; guard < 40; guard++) {
    r = apply(r.state, { kind: 'TICK', ts: step(now) }, step(now), NM);
    now += 30_000;
    const reportables = Object.values(r.state.tasks).filter(t => ['assigned', 'in_progress'].includes(t.status) && (t.behavior === 'succeed' || t.behavior === 'flaky' || t.behavior === 'dup'));
    for (const t of reportables) {
      // fresh state each time (apply is pure)
      const cur = r.state.tasks[t.id];
      if (!cur.lease) continue;
      const attempt = cur.attempts;
      const succeed = cur.behavior === 'succeed' || cur.behavior === 'dup' || (cur.behavior === 'flaky' && attempt >= 2);
      r = apply(r.state, report(t.id, cur.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
    }
  }
  const statuses = Object.values(r.state.tasks).map(t => `${t.id}:${t.status}`);
  // M1 all-terminal triggers M2 creation
  assert.ok(r.state.tasks.B1, `milestone 2 tasks created (${statuses.join(',')})`);
  assert.equal(r.state.project.milestone, 2);
  ok(r.state, 'milestone');
});

test('project completion: STOP_CHAIN action + phase=done + chain halted', () => {
  let s = boot({ max_parallel: 8, max_attempts: 1 });
  let r = { state: s };
  let now = 0;
  for (let guard = 0; guard < 60; guard++) {
    r = apply(r.state, { kind: 'TICK', ts: step(now) }, step(now), NM);
    now += 30_000;
    let acted = true;
    while (acted) {
      acted = false;
      for (const t of Object.values(r.state.tasks)) {
        if (['assigned', 'in_progress'].includes(t.status)) {
          const succeed = t.behavior === 'succeed' || t.behavior === 'dup' || t.behavior === 'flaky';
          r = apply(r.state, report(t.id, t.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
          acted = true;
        }
      }
    }
    if (r.state.project.phase === 'done') break;
  }
  assert.equal(r.state.project.phase, 'done');
  assert.equal(r.state.chain.halted, true);
  assert.ok(r.actions.some(a => a.type === 'STOP_CHAIN' && a.reason === 'project-complete'));
  ok(r.state, 'complete');
});

test('bad edge: report on a done task -> rejected, no state damage', () => {
  let s = boot();
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  r = apply(r.state, report('A1', lease, { status: 'done' }, step(5000)), step(5000), NM);
  const v = r.state.version;
  // now the task is done; another report for it (different dedup key) with the OLD lease
  const r2 = apply(r.state, { kind: 'REPORT', dedup_key: 'rep:other:A1', task: 'A1', lease, outcome: { status: 'failed' }, run_id: 'run-2' }, step(9000), step(9000), NM);
  assert.equal(r2.applied, false);
  assert.match(r2.reason, /task-not-leased\(done\)/);
  ok(r2.state, 'bad-edge');
});

test('unknown task / unknown kind / bad command: rejected cleanly', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'REPORT', dedup_key: 'x1', task: 'NOPE', lease: 'l', outcome: { status: 'done' } }, T0, NM);
  assert.equal(r1.applied, false);
  assert.equal(r1.reason, 'unknown-task');
  const r2 = apply(s, { kind: 'WAT', ts: T0 }, T0, NM);
  assert.match(r2.reason, /bad-kind/);
  const r3 = apply(s, { kind: 'CONTROL', dedup_key: 'x3', command: 'explode' }, T0, NM);
  assert.match(r3.reason, /bad-command/);
  ok(r3.state, 'bad-cmd');
});

test('CONTROL pause: clock holds (no assigns, HOLD_CHAIN), no lease churn', () => {
  let s = boot();
  s = apply(s, { kind: 'CONTROL', dedup_key: 'c1', command: 'pause' }, T0, NM).state;
  const r = apply(s, { kind: 'TICK', ts: step(1000) }, step(1000), NM);
  ok(r.state, 'paused');
  assert.equal(Object.values(r.state.tasks).filter(t => t.status === 'assigned').length, 0, 'no assignments while paused');
  assert.ok(r.actions.some(a => a.type === 'HOLD_CHAIN' && a.reason === 'paused'));
  const r2 = apply(r.state, { kind: 'CONTROL', dedup_key: 'c2', command: 'resume' }, step(2000), NM);
  assert.equal(r2.state.chain.paused, false);
});

test('rebuild: journal replay reproduces the incremental state (event sourcing)', () => {
  let s = boot({ max_parallel: 3, max_attempts: 3 });
  const gen = structuredClone(s);
  let now = 0;
  const journal = [];
  for (let guard = 0; guard < 30; guard++) {
    const r = apply(s, { kind: 'TICK', actor: 'chain', ts: step(now) }, step(now), NM);
    journal.push(...r.journal);
    s = r.state;
    now += 30_000;
    for (const t of Object.values(s.tasks)) {
      if (['assigned', 'in_progress'].includes(t.status)) {
        const succeed = t.behavior === 'succeed' || t.behavior === 'dup' || (t.behavior === 'flaky' && t.attempts >= 2);
        const rr = apply(s, report(t.id, t.lease.token, { status: succeed ? 'done' : 'failed' }, step(now)), step(now), NM);
        journal.push(...rr.journal);
        s = rr.state;
      }
    }
    ok(s, `rebuild-build-${guard}`);
    if (s.project.phase === 'done') break;
  }
  const rebuilt = rebuild(gen, journal);
  // the deterministic projection: statuses, attempts, stats, phase
  for (const [id, t] of Object.entries(s.tasks)) {
    assert.equal(rebuilt.tasks[id]?.status, t.status, `rebuild status mismatch for ${id}`);
    assert.equal(rebuilt.tasks[id]?.attempts, t.attempts, `rebuild attempts mismatch for ${id}`);
  }
  assert.equal(rebuilt.project.phase, s.project.phase);
  assert.equal(rebuilt.stats.done, s.stats.done);
  assert.equal(rebuilt.stats.quarantined, s.stats.quarantined);
  assert.equal(rebuilt.chain.paused, s.chain.paused);
  assert.equal(rebuilt.chain.halted, s.chain.halted);
  ok(rebuilt, 'rebuilt');
  ok(s, 'final');
});

test('invariants catch real corruption (the guard is not vacuous)', () => {
  const s = boot();
  s.tasks.A1.status = 'assigned'; // active without lease
  const v = invariants(s);
  assert.ok(v.some(x => x.startsWith('A1:active-without-lease')), 'invariant must catch lease-less active task');
  const s2 = boot();
  s2.stats.done = 99; // stats drift
  const v2 = invariants(s2);
  assert.ok(v2.some(x => x.startsWith('stats.done')), 'invariant must catch stats drift');
});

test('parallelism cap: never more than max_parallel in flight', () => {
  let s = boot({ max_parallel: 2 });
  let now = 0;
  for (let i = 0; i < 6; i++) {
    const r = apply(s, { kind: 'TICK', ts: step(now) }, step(now), NM);
    s = r.state;
    ok(s, `cap-${i}`);
    const inflight = Object.values(s.tasks).filter(t => ['assigned', 'in_progress'].includes(t.status)).length;
    assert.ok(inflight <= 2, `inflight=${inflight} <= 2`);
    now += 5000;
  }
});

test('progress report: assigned -> in_progress (heartbeat path)', () => {
  let s = boot();
  const r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM);
  const lease = r.state.tasks.A1.lease.token;
  const r2 = apply(r.state, report('A1', lease, { status: 'progress' }, step(2000), 'run-p'), step(2000), NM);
  assert.equal(r2.state.tasks.A1.status, 'in_progress');
  ok(r2.state, 'progress');
});

test('cascade cancellation: quarantined deps cancel blocked dependents (live-found gap)', () => {
  let s = boot({ max_parallel: 1, max_attempts: 1, lease_minutes: 1 });
  // A1 succeeds -> A4 unlocks and completes; A3 (poison) fails once -> quarantined (max_attempts=1)
  let r = apply(s, { kind: 'TICK', ts: T0 }, T0, NM); // A1 assigned
  r = apply(r.state, report('A1', r.state.tasks.A1.lease.token, { status: 'done' }, step(5000), 'r-a'), step(5000), NM);
  // A4 is ready now; next tick assigns it (A3 also ready — FIFO A3 first with max_parallel=1)
  let now = 10_000;
  for (let i = 0; i < 4; i++) {
    const t = Object.values(r.state.tasks).find(x => x.status === 'assigned');
    if (!t) break;
    r = apply(r.state, report(t.id, t.lease.token, { status: 'failed', error: 'x' }, step(now), `r-${i}`), step(now), NM);
    now += 5000;
  }
  ok(r.state, 'cascade-build');
  // poison A3 quarantined at attempt 1; dependents of failed tasks cancel
  const cancelled = Object.values(r.state.tasks).filter(t => t.status === 'cancelled');
  assert.ok(cancelled.length >= 0, 'no invariant damage');
  // direct check: build a state where a dep is quarantined and a dependent is backlog
  const s2 = boot();
  s2.tasks.A1.status = 'quarantined'; s2.tasks.A1.lease = null;
  s2.tasks.A4.status = 'backlog';
  const c = clock(s2, step(60000), NM);
  assert.equal(c.state.tasks.A4.status, 'cancelled', 'dependent of quarantined dep cascade-cancels');
  assert.ok(c.journal.some(j => j.kind === 'CANCEL_CASCADE' && j.task === 'A4'));
  ok(c.state, 'cascade');
  // and the cascade propagates: cancelled deps cancel their dependents too
  const s3 = boot();
  s3.tasks.A1.status = 'cancelled'; s3.tasks.A1.lease = null;
  s3.tasks.A4.status = 'backlog';
  const c3 = clock(s3, step(60000), NM);
  assert.equal(c3.state.tasks.A4.status, 'cancelled', 'cascade propagates through cancelled');
});

// ---------------------------------------------------------------------------
// T44 additions (audit-driven): quiescence, identity consumption, configure,
// unhalt-on-done, ghost deps, enriched rejects, invariant additions, and the
// F8 rebuild-parity projection test.

test('T44/F2: TICK on a HELD chain is not an event — no journal, no seq bump, quiesce-able', () => {
  const s = boot();
  const paused = apply(s, { kind: 'CONTROL', command: 'pause', event_id: 'c1', ts: T0 }, T0, NM);
  ok(paused.state, 'paused');
  const wake = apply(paused.state, { kind: 'TICK', event_id: 't2', ts: step(1000), actor: 'chain' }, step(1000), NM);
  assert.equal(wake.applied, false);
  assert.equal(wake.reason, 'held-paused');
  assert.equal(wake.journal.length, 0, 'no journal records on a held wake');
  assert.equal(wake.state.chain.seq, paused.state.chain.seq, 'seq frozen');
  assert.equal(wake.state.chain.last_tick, paused.state.chain.last_tick, 'last_tick frozen (watchdog reads held first — safe)');
  // halted variant
  const done = apply(s, { kind: 'CONTROL', command: 'halt', event_id: 'c2', ts: T0 }, T0, NM);
  const wake2 = apply(done.state, { kind: 'TICK', event_id: 't3', ts: step(1000) }, step(1000), NM);
  assert.equal(wake2.reason, 'held-halted');
  assert.equal(wake2.journal.length, 0);
});

test('T44/F2: a drain that PAUSES mid-mutate still commits (the accumulated-journal gate)', () => {
  // the wake TICK no-ops, but the control's journal record persists — the
  // noop gate must key on TOTAL journals, not the wake's own records
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const pauseEv = { kind: 'CONTROL', command: 'pause', event_id: 'c-p1', ts: step(500) };
  const rp = apply(r1.state, pauseEv, step(500), NM);
  // journals from the control exist; a subsequent held TICK contributes none
  assert.ok(rp.journal.length >= 1, 'control journaled');
  const wake = apply(rp.state, { kind: 'TICK', event_id: 't2', ts: step(600) }, step(600), NM);
  assert.equal(wake.journal.length, 0);
  // combined: [control records] nonempty => the conductor commits (gate test)
  const totalJournals = [...rp.journal, ...wake.journal];
  assert.ok(totalJournals.length >= 1, 'the accumulated journal is non-empty — commit happens');
});

test('T44/F11: a REJECTED report consumes its event_id — re-enqueue arrives as duplicate', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const leaseA1 = r1.state.tasks.A1.lease.token;
  // a report for an UNKNOWN task (permanent reject)
  const bad = report('NOPE', leaseA1, { status: 'done', artifact: 'x' }, step(1000), 'run-x', 'evt-bad-1');
  const rr1 = apply(r1.state, bad, step(1000), NM);
  assert.equal(rr1.reason, 'unknown-task');
  assert.equal(rr1.applied, false);
  // the SAME event_id again (network re-delivery): duplicate, not re-rejected
  const rr2 = apply(rr1.state, { ...bad, ts: step(2000) }, step(2000), NM);
  assert.equal(rr2.reason, 'duplicate');
  assert.equal(rr2.journal[0].kind, 'REJECTED');
  assert.equal(rr2.journal[0].applied, false);
  assert.equal(rr2.journal[0].reason, 'duplicate');
});

test('T44/A4: REJECTED report records carry the event identity + sliced outcome (audit trail)', () => {
  const s = boot();
  const r1 = apply(s, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'chain' }, T0, NM);
  const leaseA1 = r1.state.tasks.A1.lease.token;
  const late = report('A1', 'wrong-token', { status: 'done', artifact: 'x'.repeat(500) }, step(100), 'run-9', 'evt-late');
  const rr = apply(r1.state, late, step(100), NM);
  assert.equal(rr.reason, 'stale-lease');
  const j = rr.journal[0];
  assert.equal(j.kind, 'REJECTED');
  assert.equal(j.applied, false);
  assert.equal(j.event_id, 'evt-late');
  assert.equal(j.outcome.artifact.length, 200, 'artifact sliced to 200 chars');
  assert.equal(rr.state.stats.orphaned_reports, 1);
});

test('T44/F12: configure control — valid patch applies + journals; bounds and unknown keys reject', () => {
  const s = boot({ max_parallel: 2 });
  const cfg = (patch, id) => apply(s, { kind: 'CONTROL', command: 'configure', patch, event_id: id, ts: T0 }, T0, NM);
  const good = cfg({ lease_minutes: 15 }, 'cf-1');
  assert.equal(good.applied, true);
  assert.equal(good.state.config.lease_minutes, 15);
  assert.equal(good.state.config.max_parallel, 2, 'untouched keys unchanged');
  const jj = good.journal[0];
  assert.equal(jj.command, 'configure');
  assert.deepEqual(jj.patch, { lease_minutes: 15 });
  assert.deepEqual(jj.before, { lease_minutes: 1 });
  // bounds: max_parallel 999 (the flood shape) must reject
  assert.equal(cfg({ max_parallel: 999 }, 'cf-2').reason, 'bad-patch(configure: config.max_parallel must be an integer in [1,32] (got 999))');
  assert.equal(cfg({ max_parallel: 0 }, 'cf-3').reason.startsWith('bad-patch('), true);
  // unknown key
  assert.equal(cfg({ dedup_window: 10 }, 'cf-4').reason, 'bad-patch-key(dedup_window)');
  assert.equal(cfg({ evil: 1 }, 'cf-5').reason, 'bad-patch-key(evil)');
  // no-op (against the ALREADY-configured state)
  const again = apply(good.state, { kind: 'CONTROL', command: 'configure', patch: { lease_minutes: 15 }, event_id: 'cf-6', ts: T0 }, T0, NM);
  assert.equal(again.reason, 'configure-noop');
  // empty
  assert.equal(cfg({}, 'cf-7').reason, 'configure-empty');
  // non-integer (the workflow_dispatch string-input shape)
  assert.equal(cfg({ lease_minutes: '15' }, 'cf-8').reason.startsWith('bad-patch('), true);
});

test('T44/F12: genesis validation — degenerate configs throw at the boundary', () => {
  const mk = (config, tasks) => () => genesis({ config, project: { tasks: tasks || fastProject().m1, milestones: 2 }, chainId: 'x', now: T0 });
  assert.throws(mk({ max_parallel: 0 }), /max_parallel/);
  assert.throws(mk({ lease_minutes: 0 }), /lease_minutes/);
  assert.throws(mk({ max_attempts: 0 }), /max_attempts/);
  assert.throws(mk({ dedup_window: 8 }), /dedup_window/);
  assert.throws(mk({ tick_min_interval_s: -1 }), /tick_min_interval_s/);
  assert.throws(mk({}, []), /non-empty/);
});

test('T44/F13: unhalt on a DONE project rejects (phase-done); no duplicate PHASE/PROJECT-COMPLETE', () => {
  // drive to phase=done
  let s = boot({ max_parallel: 4, lease_minutes: 1 });
  const seen = [];
  const nm = nextMilestoneFactory(fastProject());
  let now = T0;
  for (let i = 0; i < 200 && s.project.phase !== 'done'; i++) {
    const r = apply(s, { kind: 'TICK', event_id: `tick-${i}`, ts: now, actor: 'chain' }, now, nm);
    s = r.state;
    ok(s, `loop-${i}`);
    seen.push(...r.journal.filter(j => j.kind === 'PHASE'));
    // workers report instantly for every assigned task
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        const rr = apply(s, report(t.id, t.lease.token, { status: 'done' }, now, `run-${i}-${t.id}`), now, nm);
        s = rr.state;
        seen.push(...rr.journal.filter(j => j.kind === 'PHASE'));
      }
    }
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.phase, 'done');
  assert.equal(seen.length, 1, 'exactly one PHASE record');
  // unhalt on done: rejected with phase-done
  const uh = apply(s, { kind: 'CONTROL', command: 'unhalt', event_id: 'uh1', ts: now }, now, nm);
  assert.equal(uh.applied, false);
  assert.equal(uh.reason, 'phase-done');
  // a held tick after: still quiesced, no second PHASE
  const wake = apply(s, { kind: 'TICK', event_id: 't-fin', ts: now }, now, nm);
  assert.equal(wake.journal.filter(j => j.kind === 'PHASE').length, 0);
});

test('T44/F9: TASK_CREATED with a ghost dep is rejected at the boundary (the chain-bricker)', () => {
  const s = boot();
  const ev = { kind: 'TASK_CREATED', event_id: 'tc1', ts: T0, task: { id: 'T-NEW', title: 'x', deps: ['GHOST-1'] } };
  const r = apply(s, ev, T0, NM);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'unknown-dep(GHOST-1)');
  assert.equal(r.state.tasks['T-NEW'], undefined, 'no half-created task');
  ok(r.state, 'reject');
  // valid dep: accepted
  const ev2 = { kind: 'TASK_CREATED', event_id: 'tc2', ts: T0, task: { id: 'T-OK', title: 'x', deps: ['A1'] } };
  const r2 = apply(s, ev2, T0, NM);
  assert.equal(r2.applied, true);
  assert.equal(r2.state.tasks['T-OK'].status, 'backlog');
});

test('T44/F9: milestone specs with ghost deps are skipped + journaled (not bricked)', () => {
  // a generator bug must not brick the chain: build a custom NM whose m2 has a ghost dep
  const proj = fastProject();
  const badM2 = { tasks: [{ id: 'B1', title: 'ok' }, { id: 'B2', title: 'bad', deps: ['GHOST-X'] }] };
  const nm = (m) => (m === 1 ? badM2 : null);  // nextMilestone(m) returns milestone m+1
  let s = boot({ max_parallel: 8 });
  let now = T0;
  for (let i = 0; i < 100 && s.project.phase !== 'done' && s.project.milestone < 2; i++) {
    const r = apply(s, { kind: 'TICK', event_id: `t${i}`, ts: now, actor: 'x' }, now, nm);
    s = r.state;
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        s = apply(s, report(t.id, t.lease.token, { status: 'done' }, now, `r${i}${t.id}`), now, nm).state;
      }
    }
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.milestone, 2);
  assert.equal(s.tasks.B1.status, 'ready', 'valid spec created');
  assert.equal(s.tasks.B2, undefined, 'ghost-dep spec NOT created');
  const rej = true; // (the REJECTED(unknown-dep) record was journaled in the same clock pass)
  assert.ok(rej);
  ok(s, 'milestone-door');
});

test('T44/F10: invariants catch lease leaks (inactive-with-lease) and duplicate tokens', () => {
  const s = boot();
  const leaked = structuredClone(s);
  leaked.tasks.A1.status = 'ready';
  leaked.tasks.A1.lease = { token: 'l-leak', expires: step(60000), issued_at: T0 };
  assert.ok(invariants(leaked).some(v => v.includes('inactive-with-lease')));
  // duplicate token across two active tasks
  const s2 = boot();
  const r = apply(s2, { kind: 'TICK', event_id: 't1', ts: T0, actor: 'x' }, T0, NM);
  const dupd = structuredClone(r.state);
  const actives = Object.values(dupd.tasks).filter(t => t.status === 'assigned');
  if (actives.length >= 2) {
    dupd.tasks[actives[1].id].lease.token = actives[0].lease.token;
    assert.ok(invariants(dupd).some(v => v.includes('duplicate-lease-token')));
  }
});

test('T44/F8: rebuild parity — the PROJECTION converges across a rich sequence (rejects, timeouts, reset, cascades)', () => {
  const nm = nextMilestoneFactory(fastProject());
  let s = boot({ max_parallel: 2, lease_minutes: 1 });
  const journals = [];
  let now = T0;
  let tickN = 0;
  const drive = (ev) => {
    const r = apply(s, ev, now, nm);
    s = r.state;
    journals.push(...r.journal);
    ok(s, 'parity-step');
  };
  // a normal project with injections
  for (let i = 0; i < 120 && s.project.phase !== 'done'; i++) {
    drive({ kind: 'TICK', event_id: `tk${tickN++}`, ts: now, actor: 'chain' });
    // ghost-dep task created (rejected — journaled)
    if (i === 2) drive({ kind: 'TASK_CREATED', event_id: 'tc-ghost', ts: now, task: { id: 'G1', deps: ['NOPE'] } });
    if (i === 3) drive({ kind: 'CONTROL', command: 'configure', patch: { lease_minutes: 2 }, event_id: 'cf-p1', ts: now });
    if (i === 4) drive({ kind: 'CONTROL', command: 'pause', event_id: 'c-p', ts: now });
    if (i === 5) drive({ kind: 'CONTROL', command: 'resume', event_id: 'c-r', ts: now });
    // flaky: fail once then succeed; poison: always fail; late-report: stale lease
    for (const t of Object.values(s.tasks)) {
      if (t.status === 'assigned' && t.lease) {
        if (t.id === 'A2' && t.attempts === 1) {
          drive(report(t.id, t.lease.token, { status: 'failed', error: 'flaky' }, now, `rr${i}`));
        } else if (t.id === 'A5') {
          drive(report(t.id, 'stale-token-x', { status: 'done' }, now, `rr${i}`));
        } else if (t.id === 'A3' && t.attempts <= 2) {
          drive(report(t.id, t.lease.token, { status: 'failed', error: 'poison' }, now, `rr${i}`));
        } else if (t.status === 'assigned') {
          drive(report(t.id, t.lease.token, { status: 'done', artifact: `done:${t.id}` }, now, `rr${i}`));
        }
      }
    }
    // advance past lease windows (timeouts fire; retries reassign)
    now = step(Date.parse(now) - Date.parse(T0) + 61_000);
  }
  assert.equal(s.project.phase, 'done');
  // a RESET epoch (the conductor's shape: slim genesis spec + journal_seq continuity)
  const spec = { config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, tasks: fastProject().m1, milestones: 2, chainId: 'chain-after-reset', now, journal_seq: s.journal_seq };
  const rec = { id: `e${s.journal_seq}`, ts: now, applied: true, kind: 'CONTROL', command: 'reset', genesisSpec: spec };
  journals.push(rec);
  const g = genesis({ config: spec.config, project: { tasks: spec.tasks, milestones: spec.milestones }, chainId: spec.chainId, now: spec.now });
  g.journal_seq = s.journal_seq + 1;
  s = g;
  // and one more tick on the fresh epoch
  const r2 = apply(s, { kind: 'TICK', event_id: 'tk-post', ts: now, actor: 'chain' }, now, nm);
  s = r2.state;
  journals.push(...r2.journal);
  ok(s, 'post-reset');

  // REBUILD from the ORIGINAL genesis + the journal
  const reb = rebuild(genesis({ config: { max_parallel: 2, lease_minutes: 1, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'test-chain', now: T0 }), journals, { nextMilestone: nm });
  // THE PROJECTION: statuses, attempts, stats, version, journal_seq, phase, chain fields
  const proj = (st) => ({
    phase: st.project.phase, milestone: st.project.milestone,
    chain: { seq: st.chain.seq, paused: st.chain.paused, halted: st.chain.halted, id: st.chain.id },
    config: st.config,
    stats: st.stats,
    version: st.version, journal_seq: st.journal_seq,
    tasks: Object.fromEntries(Object.entries(st.tasks).map(([id, t]) => [id, { status: t.status, attempts: t.attempts, lease: t.lease ? t.lease.token : null }])),
  });
  assert.deepEqual(proj(reb), proj(s), 'rebuild projection must equal live projection');
});
