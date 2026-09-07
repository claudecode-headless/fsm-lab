// test-conductor-core.mjs — the conductor-turn algorithm suite (node:test).
// Drives the REAL lib/conductor-core.mjs conductorTick (the F15 extraction
// of conductor/turn.mjs's mutate closure) with injected closures — no git,
// no API — and regression-tests every trap door the 44-f review demanded be
// preserved verbatim:
//   - the noop gate on the ACCUMULATED journal (probe 2c: a wake-journal-only
//     gate stalls project completion forever)
//   - the unified reset path (direct reset = prepended control; queued
//     reports drain AFTER the reset, journaled, never silently dropped)
//   - control-first drain ordering; consume-everything semantics
//   - repair-forces-commit (A2) + BOOTSTRAP/RECOVERY notices
//   - invariants() fail-closed pre-commit
//   - the slim genesisSpec on reset records
//   - unparseable-line REJECTED records with the stats counter

import test from 'node:test';
import assert from 'node:assert/strict';
import { genesis, apply, invariants, TERMINAL } from '../lib/fsm.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const T0 = Date.parse('2026-09-06T10:00:00.000Z');
const NM = nextMilestoneFactory(fastProject());
const CFG = { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };

// multi-ts clock: each now() call advances 1ms — the conductor stamps
// SEVERAL ts values per commit (the F15 contract: never collapse to one)
function makeNow(startMs = T0) {
  let t = startMs;
  return { now: () => new Date((t += 1)).toISOString(), get ms() { return t; } };
}
const iso = (ms) => new Date(ms).toISOString();

function boot(config = {}) {
  return genesis({
    config: { ...CFG, ...config },
    project: { tasks: fastProject().m1, milestones: 2 },
    chainId: 'test-cc', now: iso(T0),
  });
}
// the injected makeGenesis: returns {state, spec} like the adapter's
function makeGenesisFor(mp = fastProject()) {
  let n = 0;
  return ({ config } = {}) => {
    const cfg = config || { ...CFG };
    const chainId = `c-test-${++n}`;
    const g = genesis({
      config: cfg, project: { tasks: mp.m1, milestones: mp.milestones ?? 2 },
      chainId, now: iso(T0 + n),
    });
    return { state: g, spec: { tasks: mp.m1, milestones: mp.milestones ?? 2, chainId } };
  };
}
const makeGenesis = makeGenesisFor();
const noRecover = () => null;
const tickEv = (reason = 'chain') => ({ kind: 'TICK', actor: reason, event_id: `tick-${reason}`, ts: iso(T0) });
const ctlEv = (command, extra = {}) => ({ kind: 'CONTROL', command, event_id: `ctl-direct-${command}`, ts: iso(T0), ...extra });

// one task, one milestone — the minimal project for drain-completion tests
const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: 1 }] };
function bootOne() {
  return genesis({ config: CFG, project: { tasks: ONE.m1, milestones: 1 }, chainId: 'test-one', now: iso(T0) });
}
function assignOne() {
  // tick the one-task project once: X becomes assigned with a lease
  const s = bootOne();
  const r = apply(s, tickEv('seed'), iso(T0), nextMilestoneFactory(ONE));
  assert.equal(r.state.tasks.X.status, 'assigned');
  return r.state;
}
const reportFor = (state, id, outcome = { status: 'done', artifact: 'a' }) => ({
  kind: 'REPORT', event_id: id, task: 'X', lease: state.tasks.X.lease.token, outcome, run_id: 'run-1',
});

const ok = (s, label) => {
  const v = invariants(s);
  assert.deepEqual(v, [], `invariants after ${label}: ${v.join('; ')}`);
};

// ---------------------------------------------------------------------------

test('held-tick quiesce: paused/halted + empty queues => noop (no journal, no commit material)', () => {
  const clock = makeNow();
  let s = boot();
  s = apply(s, ctlEv('pause'), iso(T0), NM).state;
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.noop, true);
  assert.equal(out.reason, 'held-paused');
  assert.equal(out.journal, undefined, 'a held wake journals NOTHING');
  // halted variant
  let h = boot();
  h = apply(h, ctlEv('halt'), iso(T0), NM).state;
  const out2 = conductorTick({
    cur: structuredClone(h), queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out2.noop, true);
  assert.equal(out2.reason, 'held-halted');
});

test('NOOP GATE on the ACCUMULATED journal (probe 2c): a drain that completes+halts the chain mid-mutate STILL commits', () => {
  // X is in flight; the queued report finishes the project (PHASE done +
  // STOP_CHAIN). The wake TICK lands AFTER the drain — on the now-halted
  // chain it journals nothing. Gating on the WAKE journal alone would noop
  // and the PHASE/STOP records would never commit (the completion stall).
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-final')], controlQueue: [],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.noop, undefined, 'the accumulated journal must force the commit');
  assert.ok(out.journal.some(j => j.kind === 'REPORT' && j.task === 'X' && j.to === 'done'));
  assert.ok(out.journal.some(j => j.kind === 'PHASE' && j.to === 'done'), 'the completion record lands');
  assert.equal(out.state.project.phase, 'done');
  assert.equal(out.state.chain.halted, true);
  assert.deepEqual(out.queue, [], 'consume-everything: the drained report is gone');
  ok(out.state, 'drain-completes');
});

test('unified reset (direct dispatch): queued reports drain AFTER the reset — journaled rejects, nothing silently dropped', () => {
  // the pre-T44 direct-reset path returned BEFORE the report drain and
  // deleted the queue files unjournaled (44-b P3 hole / F1a amendment)
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const zombies = [0, 1, 2].map(i => ({
    event_id: `rep-zombie-${i}`, task: `GHOST-${i}`, lease: 'tok', outcome: { status: 'done' }, run_id: `r${i}`,
  }));
  const out = conductorTick({
    cur: structuredClone(s), queue: zombies, controlQueue: [],
    ev: ctlEv('reset'), now: clock.now, nextMilestone: NM, recover: noRecover,
    makeGenesis: makeGenesisFor(fastProject()),
  });
  assert.ok(out.message.startsWith('reset'), `message leads with the reset: ${out.message}`);
  const resetRec = out.journal[0];
  assert.equal(resetRec.kind, 'CONTROL');
  assert.equal(resetRec.command, 'reset');
  // the SLIM genesis spec (rebuild() replays it)
  const spec = resetRec.genesisSpec;
  assert.deepEqual(Object.keys(spec).sort(), ['chainId', 'config', 'journal_seq', 'milestones', 'now', 'tasks']);
  assert.deepEqual(spec.tasks, fastProject().m1);
  assert.equal(spec.milestones, 2);
  assert.equal(spec.journal_seq, s.journal_seq);
  assert.equal(spec.chainId, out.state.chain.id, 'the spec chainId is the new chain');
  // the queued zombies drained AFTER the reset: journaled unknown-task rejects
  const rej = out.journal.filter(j => j.kind === 'REJECTED' && j.reason === 'unknown-task');
  assert.equal(rej.length, 3, 'every queued report is journaled (none silently dropped)');
  assert.deepEqual(rej.map(j => j.event_id), zombies.map(z => z.event_id));
  // journal_seq continuity across the epoch boundary: the reset record starts
  // at the OLD seq and the ids run monotonically to the new state's seq
  const ids = out.journal.map(j => parseInt(j.id.slice(1), 10));
  assert.equal(ids[0], s.journal_seq, 'the reset record id continues the old journal');
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ids are strictly increasing across the epoch');
  assert.equal(ids[ids.length - 1] + 1, out.state.journal_seq);
  assert.notEqual(out.state.chain.id, s.chain.id, 'fresh chain after reset');
  // consume-everything semantics
  assert.deepEqual(out.queue, []);
  assert.deepEqual(out.controlQueue, []);
  ok(out.state, 'reset-drain');
});

test('unified reset via the QUEUE (ops path): prepended control, reset record, journal_seq continuity', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [{ cmd: 'reset', id: 'ctl-q-1', ts: iso(T0 + 1000), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM, recover: noRecover,
    makeGenesis: makeGenesisFor(fastProject()),
  });
  assert.ok(out.journal.some(j => j.kind === 'CONTROL' && j.command === 'reset'));
  // a QUEUED reset does NOT skip the wake: the tick applies on the fresh chain
  assert.ok(out.journal.some(j => j.kind === 'TICK'));
  assert.equal(out.state.chain.seq, 1, 'the wake tick applied on the new chain');
  assert.notEqual(out.state.chain.id, s.chain.id);
  ok(out.state, 'queued-reset');
});

test('reset ADOPTS the current config (F12 — no hardcoded reset config)', () => {
  const s = boot({ lease_minutes: 9, tick_min_interval_s: 40 });
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [],
    ev: ctlEv('reset'), now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.journal[0].genesisSpec.config.lease_minutes, 9, 'adopted');
  assert.equal(out.journal[0].genesisSpec.config.tick_min_interval_s, 40, 'adopted (>= the 25s floor)');
  assert.equal(out.state.config.lease_minutes, 9);
  ok(out.state, 'reset-config-adopt');
});

test('repair-forces-commit (A2): a recovered PAUSED state with nothing to do still commits the RECOVERY record', () => {
  // under quiescence a history-walked state must PERSIST or corruption
  // never heals — without repair this turn is a noop (held-paused, no
  // journals) and the healed state.json never lands (red-team probe)
  let good = boot();
  good = apply(good, ctlEv('pause'), iso(T0), NM).state;
  const clock = makeNow(T0 + 5_000);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('backstop'),
    now: clock.now, nextMilestone: NM,
    recover: () => ({ state: structuredClone(good), reason: 'history-walk' }),
    makeGenesis,
  });
  assert.equal(out.noop, undefined, 'repair forces the commit');
  assert.ok(out.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'history-walk'));
  assert.ok(out.actions.some(a => a.type === 'RECOVERY_NOTICE'));
  assert.equal(out.state.chain.paused, true, 'the recovered state is preserved');
  ok(out.state, 'repair-commit');
});

test('bootstrap: no state, no history => fresh genesis + BOOTSTRAP_NOTICE + RECOVERY(bootstrap)', () => {
  const clock = makeNow(T0);
  const out = conductorTick({
    cur: null, queue: [], controlQueue: [], ev: tickEv('chain'),
    now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  assert.equal(out.noop, undefined);
  assert.ok(out.journal.some(j => j.kind === 'RECOVERY' && j.reason === 'bootstrap'));
  assert.ok(out.actions.some(a => a.type === 'BOOTSTRAP_NOTICE'));
  assert.equal(out.state.chain.seq, 1, 'the wake tick applied on the fresh chain');
  assert.ok(out.journal.some(j => j.kind === 'ASSIGN'), 'the bootstrap turn assigns');
  ok(out.state, 'bootstrap');
});

test('control-first ordering + reports are NOT pause-gated: a queued pause lands BEFORE the report drain, and the report still applies', () => {
  // at-least-once drain: a HELD chain still consumes its report queue; only
  // the wake TICK is a non-event on a held chain
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: [reportFor(s, 'rep-under-pause')],
    controlQueue: [{ cmd: 'pause', id: 'ctl-p-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.journal[0].kind, 'CONTROL', 'control queue drains FIRST');
  assert.equal(out.journal[0].command, 'pause');
  assert.equal(out.state.tasks.X.status, 'done', 'the report applied despite the pause');
  assert.equal(out.state.chain.paused, true);
  assert.equal(out.noop, undefined, 'journals exist — this is a real commit');
  ok(out.state, 'pause-report-drain');
});

test('queued resume unpauses BEFORE the wake applies: the tick is a real event again (F2 unpaused-tick case)', () => {
  let s = assignOne();
  s = apply(s, ctlEv('pause'), iso(T0), nextMilestoneFactory(ONE)).state;
  assert.equal(s.chain.paused, true);
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [], controlQueue: [{ cmd: 'resume', id: 'ctl-r-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.journal[0].kind, 'CONTROL');
  assert.equal(out.journal[0].command, 'resume');
  assert.ok(out.journal.some(j => j.kind === 'TICK'), 'the wake tick applied (state was unpaused when apply ran)');
  assert.equal(out.state.chain.paused, false);
  assert.equal(out.state.chain.seq, 2);
  ok(out.state, 'resume-then-tick');
});

test('configure patch passthrough: a queued configure applies + journals patch/before; a bad patch is a consumed reject', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [],
    controlQueue: [{ cmd: 'configure', patch: { max_attempts: 5 }, id: 'ctl-c-1', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(out.state.config.max_attempts, 5);
  const rec = out.journal.find(j => j.kind === 'CONTROL' && j.command === 'configure');
  assert.deepEqual(rec.patch, { max_attempts: 5 }, 'the patch round-trips');
  assert.deepEqual(rec.before, { max_attempts: 3 }, 'before captured (was 3 in CFG)');
  ok(out.state, 'configure');

  // invalid patch: rejected AND consumed (never re-parked)
  const out2 = conductorTick({
    cur: structuredClone(assignOne()), queue: [],
    controlQueue: [{ cmd: 'configure', patch: { max_parallel: 999 }, id: 'ctl-c-2', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.ok(out2.journal.some(j => j.kind === 'REJECTED' && j.reason.startsWith('bad-patch')));
  assert.deepEqual(out2.controlQueue, [], 'the rejected control is consumed, not re-parked');
  assert.equal(out2.state.config.max_parallel, CFG.max_parallel, 'config untouched by the bad patch');
});

test('unparseable queue/control lines: journaled REJECTED(unparseable) + counted, then dropped by the rewrite', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s),
    queue: [], queueBad: ['{"event_id": "torn line', '###not json at all'],
    controlQueue: [], ctlBad: ['%%%garbage%%%'],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  const rej = out.journal.filter(j => j.kind === 'REJECTED' && j.reason === 'unparseable');
  assert.equal(rej.length, 3, 'queue AND control unparseables journaled');
  assert.deepEqual(rej.map(j => j.origKind).sort(), ['CONTROL', 'REPORT', 'REPORT']);
  assert.ok(rej.every(j => j.applied === false && typeof j.raw === 'string'));
  assert.equal(out.state.stats.rejected_events, 3, 'the stats counter increments (44-h P2c)');
  ok(out.state, 'unparseables');
});

test('invariants fail-closed: a corrupted base state makes the turn THROW pre-commit (never lands)', () => {
  const s = assignOne();
  const bad = structuredClone(s);
  bad.tasks.X.lease = null;            // active-without-lease — a real violation
  bad.tasks.X.status = 'in_progress';
  const clock = makeNow(T0 + 60_000);
  assert.throws(
    () => conductorTick({
      cur: bad, queue: [], controlQueue: [], ev: tickEv('chain'),
      now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
      recover: noRecover, makeGenesis: makeGenesisFor(ONE),
    }),
    /INVARIANT VIOLATION: .*active-without-lease/,
  );
});

test('duplicate wake control is consumed as a duplicate (identity consumed once — F11 discipline)', () => {
  // pause applied earlier in the same chain; the SAME event_id re-delivered
  // through the control queue lands as REJECTED(duplicate), consumed
  let s = boot();
  s = apply(s, ctlEv('pause'), iso(T0), NM).state;
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [],
    controlQueue: [{ cmd: 'pause', id: 'ctl-direct-pause', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: NM, recover: noRecover, makeGenesis,
  });
  // 'ctl-direct-pause' was consumed by the earlier apply() (same event identity)
  const rej = out.journal.find(j => j.kind === 'REJECTED' && j.event_id === 'ctl-direct-pause');
  assert.equal(rej?.reason, 'duplicate');
  assert.deepEqual(out.controlQueue, [], 'the duplicate control is consumed, not re-parked');
  ok(out.state, 'dup-control');
});

test('drain halt with a duplicate report still commits (accumulated-journal gate, reject variant)', () => {
  // second copy of the report that already finished X: the drain journals a
  // REJECTED(duplicate) — accumulated journal non-empty => commit, even
  // though the wake tick is held (chain halted by the FIRST drain... here X
  // is already done so the wake applies normally; the gate check is the
  // reject-record path). Structural guard: journals.length > 0.
  const s = assignOne();
  const first = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-1')], controlQueue: [],
    ev: tickEv('chain'), now: makeNow(T0 + 60_000).now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  assert.equal(first.state.project.phase, 'done');
  const clock = makeNow(T0 + 120_000);
  const out = conductorTick({
    cur: structuredClone(first.state), queue: [reportFor(s, 'rep-1')], controlQueue: [],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  // held-halted wake + a duplicate reject in the drain => still a commit
  assert.equal(out.noop, undefined);
  assert.ok(out.journal.some(j => j.kind === 'REJECTED' && j.reason === 'duplicate'));
  assert.deepEqual(out.queue, []);
  ok(out.state, 'dup-report-drain');
});

test('now is stamped per-value (multiple ts per commit — the extraction contract)', () => {
  const s = assignOne();
  const clock = makeNow(T0 + 60_000);
  const out = conductorTick({
    cur: structuredClone(s), queue: [reportFor(s, 'rep-ts')],
    controlQueue: [{ cmd: 'configure', patch: { max_attempts: 5 }, id: 'ctl-ts', ts: iso(T0 + 500), note: '' }],
    ev: tickEv('chain'), now: clock.now, nextMilestone: nextMilestoneFactory(ONE),
    recover: noRecover, makeGenesis: makeGenesisFor(ONE),
  });
  const ts = out.journal.map(j => j.ts);
  assert.ok(new Set(ts).size >= 2, `journal carries multiple distinct ts values (${new Set(ts).size})`);
  // strictly increasing: each mkJ/apply stamped a fresh now()
  assert.deepEqual(ts, [...ts].sort(), 'ts values are monotonic');
});
