#!/usr/bin/env node
// sim/run-sim2.mjs — the SHIM-DRIVEN regression suite (T44/F17).
//
// The same lib/conductor-core.mjs the GHA workflows run, driven through the
// GHA-semantics shim (sim/gha-shim.mjs: ConcurrencyGroup newest-wins
// physics + DispatchLane latency + the strict lib/event-ingest.mjs router)
// against a local git origin. run-sim.mjs mocks GHA away ENTIRELY — which
// is exactly why the five live-caught bug classes were invisible to it;
// this layer models the substrate physics AND drives the real integration
// logic (the conductor-core drain), so the classes can't hide:
//
//   actions-drop   — the sim consumes out.actions to schedule workers (the
//                    live bug #1: actions lost in the commit — invisible to
//                    run-sim, which found workers by scanning state.tasks).
//                    Parameterized sabotage lane: the scenario ASSERTS the
//                    sabotage run fails (a test that proves the test).
//   queue-cancel   — run-per-report physics loses reports (live bugs
//                    #2/#4: depth-1 newest-wins cancellation); the
//                    data-through-git architecture loses none.
//   dep-deadlock   — the REAL 18-task mockProject to completion (the
//                    cascade coverage run-sim never had).
//   control-cancel — a control enqueued mid-hot-chain + ops-nudge applies
//                    within K ticks (rides git, never the group).
//   payload-shape  — the frozen live github.event fixtures through the
//                    STRICT event-ingest router (live bug #5).
//   lease-margin   — the X14 lease-vs-dispatch-latency formula as an
//                    executable assertion (164s latency vs lease 4 vs 15).
//   scale-200      — 200 generated tasks through conductor-core; wall
//                    time, commits, state bytes measured.
//
// Determinism: virtual clock + seeded lane rng (mulberry32) — the scenario
// VERDICT lines are byte-reproducible run-to-run (lease tokens are
// uuid-random but feed no decisions; scale-200's wall= is a physical
// measurement and varies).
//
// Usage: node sim/run-sim2.mjs [scenario]  (default: all)

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../lib/store.mjs';
import { genesis, TERMINAL } from '../lib/fsm.mjs';
import { conductorTick } from '../lib/conductor-core.mjs';
import { buildEvent } from '../lib/event-ingest.mjs';
import { mockProject, nextMilestoneFactory, fastProject } from '../lib/mock-project.mjs';
import { mockWork } from '../lib/mock.mjs';
import { ConcurrencyGroup, DispatchLane, mulberry32 } from './gha-shim.mjs';

const results = [];
function record(scenario, pass, detail) {
  results.push({ scenario, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${scenario}  ${detail}`);
}

// Virtual clock (like run-sim's, plus advanceTo for the event loop)
function makeClock(startMs = Date.parse('2026-09-06T14:00:00Z')) {
  let t = startMs;
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
    advanceTo: (ms) => { if (ms > t) t = ms; },
    get ms() { return t; },
  };
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-sim2-'));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { cwd: dir });
  const seed = join(dir, 'seed');
  spawnSync('git', ['init', '-b', 'main', seed], { cwd: dir });
  spawnSync('bash', ['-c', `echo sim2 > ${seed}/README.md && cd ${seed} && git add . && git -c user.name=s -c user.email=s@s.invalid commit -qm seed && git push -q ${origin} main`]);
  spawnSync('git', ['clone', '-q', origin, clone], { cwd: dir });
  return { dir, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// SimDriver — the conductor's world on a virtual clock:
//   * every wake (self-tick / backstop / report / nudge) is a run in the
//     ConcurrencyGroup (one 30s "turn" run each — the group serializes all
//     conductor wakes, exactly like the workflow's concurrency block)
//   * the turn EXECUTES at run start (commit + worker dispatches —
//     "parallelism starts ASAP"); the SELF-dispatch fires at run end
//     (the adapter's pacing-then-dispatch tail; tick_min_interval_s=0 in sim)
//   * DISPATCH_WORKER actions -> DispatchLane.send -> a virtual worker that
//     starts at willRunAt, runs mockWork, and delivers its report through
//     the configured lane: 'git' (the real architecture: CAS-append to
//     state/reports-queue.jsonl) or 'dispatch' (the OLD run-per-report
//     architecture: a repository_dispatch wake through the group)
//   * a noop turn (F2 held chain) never self-dispatches (A1 discipline)
// ---------------------------------------------------------------------------

const RUN_MS = 30_000;          // one conductor turn ≈ 30s of runner time
const BACKSTOP_MS = 600_000;    // compressed schedule backstop (live: ~2h sparse)

class SimDriver {
  constructor({ clock, store, project, config, group, lane, opts = {} }) {
    this.label = opts.label || 'sim2';
    this.clock = clock;
    this.store = store;
    this.project = project;
    this.nm = nextMilestoneFactory(project);
    this.group = group;
    this.lane = lane;
    this.tickFn = opts.tickFn || conductorTick;   // the sabotage seam (actions-drop)
    this.reportMode = opts.reportMode || 'git';   // 'git' | 'dispatch'
    this.runMs = opts.runMs ?? RUN_MS;
    this.backstopMs = opts.backstopMs ?? BACKSTOP_MS;
    this.maxCycles = opts.maxCycles ?? 400;
    this.genesisConfig = config || { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 };

    this.arrivals = [];       // { at, fn } — the virtual event queue
    this.runSeq = 0;
    this.turnCount = 0;       // group runs that EXECUTED a turn
    this.commitCount = 0;
    this.quiescedCount = 0;
    this.state = null;
    this.turns = [];          // { n, committed, wake, journal, reason }
    this.dispatchLog = [];    // every ok DispatchLane.send('fsm-task') — (task, lease)
    this.dispatchFailures = 0;
    this.lostReports = 0;     // report wakes cancelled in the group (lane-1 physics)
    this.lostTicks = 0;       // tick wakes cancelled in the group
    this.reportEnqueues = []; // git-lane report delivery audit
    this.notices = { bootstrap: 0, recovery: 0, milestone: 0, stop: 0, hold: 0 };
    this.stopped = false;
    this.repSeq = 0;
    this.chainSeq = 0;

    // the injected closures (F15 contract — store I/O stays out of the core)
    this.makeGenesis = ({ config } = {}) => {
      const cfg = config || this.genesisConfig;
      const chainId = `${this.label}-${++this.chainSeq}`;
      const g = genesis({
        config: cfg,
        project: { tasks: this.project.m1, milestones: this.project.milestones },
        chainId, now: this.clock.now(),
      });
      return { state: g, spec: { tasks: this.project.m1, milestones: this.project.milestones, chainId } };
    };
    this.recover = () => null; // the sim never corrupts state (store tests cover it)
    // now is a FUNCTION — multiple ts per commit, each call +1 virtual ms
    this.now = () => { this.clock.advance(1); return this.clock.now(); };
  }

  schedule(at, fn) {
    this.arrivals.push({ at, fn });
    this.arrivals.sort((a, b) => a.at - b.at);
  }

  // ---- wake plumbing -----------------------------------------------------
  submitWake(ev) {
    this.runSeq++;
    return this.group.submit({ id: `${this.label}-run-${this.runSeq}`, name: 'conductor', durationMs: this.runMs, wake: ev });
  }

  dispatchTick(reason) {
    // the turn's chain continuation (self-dispatch / ops-nudge): one lane
    // send, the wake ARRIVES at willRunAt and enters the group
    const seq = (this.state?.chain?.seq ?? 0) + 1;
    const d = this.lane.send('fsm-tick', { reason, seq });
    if (!d.ok) { this.lostTicks++; return d; }
    this.schedule(d.willRunAt, () => {
      this.submitWake(buildEvent({ action: 'fsm-tick', client_payload: { reason, seq } }, { now: this.now }));
    });
    return d;
  }

  scheduleBackstop(at) {
    this.schedule(at, () => {
      this.submitWake(buildEvent({ schedule: 'sim2-backstop' }, { now: this.now }));
      if (!this.stopped) this.scheduleBackstop(this.clock.ms + this.backstopMs);
    });
  }

  // ---- the turn (runs when its group-run starts) -------------------------
  executeTurn(run) {
    const ev = run.wake;
    this.turnCount++;
    const out = this.store.commit({
      mutate: (cur, queue, controlQueue, queueBad, ctlBad) => this.tickFn({
        cur, queue, controlQueue, queueBad, ctlBad, ev, now: this.now,
        nextMilestone: this.nm, recover: this.recover, makeGenesis: this.makeGenesis,
      }),
    });
    if (!out.committed) {
      // F2/A1: QUIESCED — no commit, no self-dispatch, ever
      this.quiescedCount++;
      run.stopped = true;
      this.state = out.state || this.state;
      this.turns.push({ n: this.turnCount, committed: false, wake: ev.kind, reason: out.reason, journal: [] });
      return;
    }
    this.commitCount++;
    this.state = out.state;
    this.turns.push({ n: this.turnCount, committed: true, wake: ev.kind, reason: out.reason, journal: out.journal || [] });
    this.resolveReportFates(out.journal || []);

    const actions = out.actions || [];
    run.stopped = actions.some(a => a.type === 'STOP_CHAIN' || a.type === 'HOLD_CHAIN');
    for (const a of actions) {
      if (a.type === 'DISPATCH_WORKER') {
        // THE consumer fix: workers are scheduled ONLY from out.actions —
        // if the commit loses them, no worker ever runs (live bug #1)
        const d = this.lane.send('fsm-task', {
          task: a.task, lease: a.lease, behavior: a.behavior,
          attempt: a.attempt, work_ms: a.work_ms, expires: a.expires,
        });
        if (d.ok) {
          this.dispatchLog.push({ task: a.task, lease: a.lease, attempt: a.attempt, willRunAt: d.willRunAt });
          this.schedule(d.willRunAt, () => this.runWorker(a));
        } else {
          this.dispatchFailures++;
        }
      } else if (a.type === 'BOOTSTRAP_NOTICE') this.notices.bootstrap++;
      else if (a.type === 'RECOVERY_NOTICE') this.notices.recovery++;
      else if (a.type === 'MILESTONE_STARTED') this.notices.milestone++;
      else if (a.type === 'STOP_CHAIN') this.notices.stop++;
      else if (a.type === 'HOLD_CHAIN') this.notices.hold++;
    }
    if (out.state.project.phase === 'done') this.stopped = true;
  }

  runWorker(a) {
    const w = mockWork(a.behavior, { task: a.task, attempt: a.attempt, workMs: a.work_ms });
    const doneAt = this.clock.ms + Math.min(w.sleepMs, 20 * 60_000);
    this.schedule(doneAt, () => this.workerReports(a, w));
  }

  workerReports(a, w) {
    if (!w.outcome) return;  // hang / no-report: the lease deadline is the handler
    const outcome = { ...w.outcome, duration_ms: w.sleepMs };
    const event_id = `rep-${a.task}-${a.attempt}-${++this.repSeq}`;
    const rec = { event_id, task: a.task, lease: a.lease, outcome, run_id: `sim2-${a.task}-${a.attempt}` };
    if (this.reportMode === 'dispatch') {
      // the OLD architecture: the report rides a repository_dispatch wake —
      // into the SAME depth-1 group as the tick chain (the lossy physics)
      const d = this.lane.send('fsm-report', rec);
      if (!d.ok) { this.lostReports++; return; }
      this.schedule(d.willRunAt, () => {
        this.submitWake(buildEvent({ action: 'fsm-report', client_payload: rec }, { now: this.now }));
      });
    } else {
      // the REAL architecture: data flows through git (CAS-append; the tick
      // drain consumes it atomically)
      const r = this.store.enqueueReport(rec);
      this.reportEnqueues.push({ ...rec, enqueuedAtTurn: this.turnCount, fate: null, fateAtTurn: null, ok: r.ok });
      if (!r.ok) throw new Error(`report enqueue failed for ${rec.event_id}: ${r.err}`);
    }
    if (w.repeatReport) {
      // the dup behavior: the SAME event_id delivered twice (network-retry)
      if (this.reportMode === 'dispatch') {
        this.schedule(this.clock.ms + 1500, () => {
          const d = this.lane.send('fsm-report', rec);
          if (!d.ok) { this.lostReports++; return; }
          this.schedule(d.willRunAt, () => {
            this.submitWake(buildEvent({ action: 'fsm-report', client_payload: rec }, { now: this.now }));
          });
        });
      } else {
        this.schedule(this.clock.ms + 1500, () => {
          this.store.enqueueReport(rec);
          this.reportEnqueues.push({ ...rec, enqueuedAtTurn: this.turnCount, fate: null, fateAtTurn: null, ok: true, dupRetry: true });
        });
      }
    }
  }

  // the delivery audit: every enqueued report reaches applied | duplicate
  resolveReportFates(journal) {
    for (const r of this.reportEnqueues) {
      if (r.fate) continue;
      for (const j of journal) {
        // REJECTED-by-event_id is checked FIRST (the duplicate carries the
        // same (task, lease) as the applied record — identity disambiguates)
        if (j.kind === 'REJECTED' && j.event_id === r.event_id) { r.fate = `rejected:${j.reason}`; r.fateAtTurn = this.turnCount; break; }
        if (j.kind === 'REPORT' && j.task === r.task && j.lease === r.lease) { r.fate = 'applied'; r.fateAtTurn = this.turnCount; break; }
      }
    }
  }

  // ---- the event loop ----------------------------------------------------
  nextEventTime() {
    const a = this.arrivals.length ? this.arrivals[0].at : null;
    const g = this.group.nextTickAt();
    if (a == null) return g;
    if (g == null) return a;
    return Math.min(a, g);
  }

  run() {
    const debug = process.env.SIM2_DEBUG === '1';
    this.schedule(this.clock.ms, () => this.submitWake(buildEvent({ action: 'fsm-tick', client_payload: { reason: 'cold-start' } }, { now: this.now })));
    this.scheduleBackstop(this.clock.ms + this.backstopMs);
    while (this.turnCount < this.maxCycles && !this.stopped) {
      const t = this.nextEventTime();
      if (t == null) break;
      this.clock.advanceTo(t);
      const due = this.arrivals.filter(x => x.at <= this.clock.ms);
      this.arrivals = this.arrivals.filter(x => x.at > this.clock.ms);
      for (const x of due) x.fn();
      for (const e of this.group.tick()) {
        if (e.type === 'started') this.executeTurn(e.run);
        else if (e.type === 'completed') {
          // chain continuation fires at run END (after the adapter's pacing)
          if (!e.run.stopped) this.dispatchTick('chain');
        } else if (e.type === 'cancelled') {
          if (e.run.wake?.kind === 'REPORT') this.lostReports++;
          else this.lostTicks++;
        }
      }
      if (debug) {
        console.log(`[sim2] t=${Math.round((this.clock.ms - Date.parse('2026-09-06T14:00:00Z')) / 1000)}s turns=${this.turnCount} commits=${this.commitCount} `
          + `arrivals=${this.arrivals.length} group=${this.group.running ? 'R' : '-'}${this.group.pending ? 'P' : '-'}${this.group.doomed.length ? 'D' + this.group.doomed.length : ''} `
          + `phase=${this.state?.project?.phase} done=${this.state?.stats?.done} lost=${this.lostReports + this.lostTicks}`);
      }
    }
    return this;
  }
}

// a standard fastProject driver (most scenarios)
function fastDriver({ lab, config, opts = {} }) {
  const clock = makeClock();
  const store = new Store({ cwd: lab.clone, ...(opts.storeOpts || {}) });
  const group = new ConcurrencyGroup({ clock, name: 'fsm-conductor', cancelInProgress: false });
  const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: opts.jitter ?? 0, rng: mulberry32(opts.seed ?? 7) });
  return new SimDriver({
    clock, store, project: fastProject(), config, group, lane,
    opts: { label: opts.label || 's', ...opts },
  });
}

// ---------------------------------------------------------------------------
// 1. actions-drop — the consumer schedules workers from out.actions; if the
// commit loses the actions (live bug #1), every ASSIGN has no dispatch.
// Sabotage lane: wrap conductorTick's output and ASSERT the run fails.
// ---------------------------------------------------------------------------

function scenarioActionsDrop() {
  const runLane = (sabotage) => {
    const lab = setupRepo();
    try {
      const tickFn = sabotage
        ? (args) => { const out = conductorTick(args); out.actions = []; return out; }  // live bug #1 shape
        : conductorTick;
      const d = fastDriver({ lab, config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 }, opts: { label: sabotage ? 's1bad' : 's1ok', tickFn, maxCycles: 120 } });
      d.run();
      // the assertion under test: EVERY ASSIGN journal record has a matching
      // dispatch record (the consumer's dispatch log, fed by out.actions)
      const assigns = d.turns.flatMap(t => t.journal.filter(j => j.kind === 'ASSIGN'));
      const missing = assigns.filter(j => !d.dispatchLog.some(x => x.task === j.task && x.lease === j.lease));
      return { d, assigns: assigns.length, missing: missing.length, phase: d.state?.project?.phase, commits: d.commitCount };
    } finally { lab.cleanup(); }
  };
  const clean = runLane(false);
  const sabotaged = runLane(true);
  const pass = clean.missing === 0 && clean.phase === 'done'
    && sabotaged.missing > 0;   // the sabotage run FAILS the assertion — proof the test catches the bug
  record('actions-drop', pass,
    `clean: assigns=${clean.assigns} missingDispatch=${clean.missing} phase=${clean.phase} commits=${clean.commits} | `
    + `sabotaged: assigns=${sabotaged.assigns} missingDispatch=${sabotaged.missing} phase=${sabotaged.phase} `
    + `(sabotage ${sabotaged.missing > 0 ? 'CAUGHT' : 'MISSED'} — the run-per-action consumer detects the actions-drop bug class)`);
}

// ---------------------------------------------------------------------------
// 2. queue-cancel — lane 1: reports ride dispatch wakes into the depth-1
// group (run-per-report physics) => newest-wins-cancelled => LOST. lane 2:
// reports ride the git queue => every enqueued report reaches
// applied|duplicate within K=3 ticks. Lane-1 timing note: workers complete
// together (parallel batch), their report wakes arrive together, and only
// the newest survives the depth-1 pending slot.
// ---------------------------------------------------------------------------

function scenarioQueueCancel() {
  const K = 3;
  const lane1 = (() => {
    const lab = setupRepo();
    try {
      const d = fastDriver({
        lab,
        config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 },
        opts: { label: 's2lane1', reportMode: 'dispatch', jitter: 0, maxCycles: 200 },
      });
      d.run();
      return { lost: d.lostReports, phase: d.state?.project?.phase, turns: d.turnCount, lostTicks: d.lostTicks, orphaned: d.state?.stats?.orphaned_reports };
    } finally { lab.cleanup(); }
  })();
  const lane2 = (() => {
    const lab = setupRepo();
    try {
      const d = fastDriver({
        lab,
        config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 },
        opts: { label: 's2lane2', reportMode: 'git', jitter: 0.2, seed: 11, maxCycles: 200 },
      });
      d.run();
      const unres = d.reportEnqueues.filter(r => !r.fate);
      const late = d.reportEnqueues.filter(r => r.fate && (r.fateAtTurn - r.enqueuedAtTurn) > K);
      const bad = d.reportEnqueues.filter(r => r.fate && r.fate !== 'applied' && r.fate !== 'rejected:duplicate');
      return { enq: d.reportEnqueues.length, lost: d.lostReports, unres: unres.length, late: late.length, bad: bad.length, phase: d.state?.project?.phase, turns: d.turnCount };
    } finally { lab.cleanup(); }
  })();
  const pass = lane1.lost >= 1
    && lane2.lost === 0 && lane2.unres === 0 && lane2.late === 0 && lane2.bad === 0 && lane2.phase === 'done';
  record('queue-cancel', pass,
    `lane1 run-per-report: reportsLost=${lane1.lost} (ticksLost=${lane1.lostTicks}, orphaned=${lane1.orphaned}, phase=${lane1.phase}, turns=${lane1.turns}) — the depth-1 newest-wins group EATS reports | `
    + `lane2 data-through-git: enqueued=${lane2.enq} lost=0 unresolved=${lane2.unres} late>${K}=${lane2.late} non-applied=${lane2.bad} phase=${lane2.phase} — every report reaches applied|duplicate within ${K} ticks`);
}

// ---------------------------------------------------------------------------
// 3. dep-deadlock — the REAL 18-task / 3-milestone mockProject (hang,
// no-report, slow, poison, flaky, dup + the M1 DAG) to completion through
// conductor-core: zero non-terminal tasks, zero backlog-with-quarantined-deps.
// ---------------------------------------------------------------------------

function scenarioDepDeadlock() {
  const lab = setupRepo();
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    const group = new ConcurrencyGroup({ clock });
    const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0.2, rng: mulberry32(23) });
    const d = new SimDriver({
      clock, store, project: mockProject(),
      config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 },
      group, lane, opts: { label: 's3', reportMode: 'git', maxCycles: 400 },
    });
    d.run();
    const s = d.state;
    const tasks = Object.values(s?.tasks || {});
    const nonTerminal = tasks.filter(t => !TERMINAL.has(t.status));
    const quarantinedDeps = tasks.filter(t =>
      !TERMINAL.has(t.status) && t.deps.some(dep => s.tasks[dep] && ['quarantined', 'cancelled'].includes(s.tasks[dep].status)));
    const total = tasks.length;
    const pass = s?.project?.phase === 'done' && nonTerminal.length === 0 && quarantinedDeps.length === 0
      && (s.stats.done + s.stats.quarantined + s.stats.cancelled) === total;
    record('dep-deadlock', pass,
      `phase=${s?.project?.phase} tasks=${total} done=${s?.stats.done} quarantined=${s?.stats.quarantined} cancelled=${s?.stats.cancelled} `
      + `nonTerminal=${nonTerminal.length} backlogWithQuarantinedDeps=${quarantinedDeps.length} orphaned=${s?.stats.orphaned_reports} timeouts=${s?.stats.timeouts} `
      + `commits=${d.commitCount} turns=${d.turnCount} (the 18-task mockProject completes; cascade coverage holds)`);
  } finally { lab.cleanup(); }
}

// ---------------------------------------------------------------------------
// 4. control-cancel — pause + resume controls enqueued MID-hot-chain (group
// contention: the ops-nudge wake itself may be superseded) — the control
// rides the git queue, so it applies within K=3 ticks either way.
// ---------------------------------------------------------------------------

function scenarioControlCancel() {
  const K = 3;
  const lab = setupRepo();
  try {
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    const group = new ConcurrencyGroup({ clock });
    const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0.2, rng: mulberry32(31) });
    const d = new SimDriver({
      clock, store, project: fastProject(),
      config: { max_parallel: 4, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 },
      group, lane, opts: { label: 's4', reportMode: 'git', maxCycles: 200 },
    });
    const marks = {};
    const intervene = (cmd, atMs) => {
      d.schedule(d.clock.ms + atMs, () => {
        marks[cmd] = { enqueueTurn: d.turnCount };
        store.enqueueControl({ cmd, id: `ctl-${cmd}-1`, ts: d.clock.now(), note: 'scenario 4' });
        d.dispatchTick('ops-nudge');
      });
    };
    intervene('pause', 3 * 200_000);   // ~3 chain cycles in: the chain is HOT (self-ticking)
    intervene('resume', 12 * 200_000); // while paused: only the nudge/backstop can wake it
    d.run();
    const appliedTurn = (cmd) => {
      const t = d.turns.find(x => x.journal.some(j => j.kind === 'CONTROL' && j.command === cmd));
      return t ? t.n : null;
    };
    const pauseTurn = appliedTurn('pause');
    const resumeTurn = appliedTurn('resume');
    const pauseDelta = pauseTurn != null && marks.pause ? pauseTurn - marks.pause.enqueueTurn : null;
    const resumeDelta = resumeTurn != null && marks.resume ? resumeTurn - marks.resume.enqueueTurn : null;
    const s = d.state;
    const pass = pauseDelta != null && pauseDelta <= K && resumeDelta != null && resumeDelta <= K
      && s?.chain?.paused === false && s?.project?.phase === 'done';
    record('control-cancel', pass,
      `pauseAppliedIn=${pauseDelta}ticks resumeAppliedIn=${resumeDelta}ticks (K=${K}) paused=${s?.chain?.paused} phase=${s?.project?.phase} `
      + `quiescedWakes=${d.quiescedCount} turns=${d.turnCount} (controls ride git: group contention cannot lose them)`);
  } finally { lab.cleanup(); }
}

// ---------------------------------------------------------------------------
// 5. payload-shape — the frozen live github.event fixtures through the
// STRICT event-ingest router; the event_name trap (and the action-less
// dispatch) must THROW.
// ---------------------------------------------------------------------------

function scenarioPayloadShape() {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/github-events.json', import.meta.url), 'utf8'));
  const now = () => '2026-09-06T12:00:00.000Z';
  const checks = [];
  const expect = (name, fn) => {
    try { checks.push({ name, ok: fn() }); } catch (e) { checks.push({ name, ok: false, err: e.message }); }
  };
  expect('tick-dispatch routes TICK/chain', () => {
    const ev = buildEvent(fixtures['tick-dispatch'], { now });
    return ev.kind === 'TICK' && ev.actor === 'chain' && typeof ev.event_id === 'string';
  });
  expect('report-dispatch routes REPORT with passthrough', () => {
    const ev = buildEvent(fixtures['report-dispatch'], { now });
    return ev.kind === 'REPORT' && ev.event_id === 'rep-34029518935' && ev.task === 'T-101'
      && ev.lease === 'l-8f3a1b2c4d5e' && ev.outcome.status === 'done' && ev.run_id === '34029518935';
  });
  expect('control-reset routes CONTROL reset', () => {
    const ev = buildEvent(fixtures['control-reset'], { now });
    return ev.kind === 'CONTROL' && ev.command === 'reset' && ev.event_id.startsWith('ctl-direct-reset-');
  });
  expect('control-configure passes the patch through', () => {
    const ev = buildEvent(fixtures['control-configure'], { now });
    return ev.kind === 'CONTROL' && ev.command === 'configure' && ev.patch?.lease_minutes === 15;
  });
  expect('schedule routes TICK/schedule-backstop', () => {
    const ev = buildEvent(fixtures['schedule'], { now });
    return ev.kind === 'TICK' && ev.actor === 'schedule-backstop';
  });
  expect('workflow-dispatch routes TICK/manual', () => {
    const ev = buildEvent(fixtures['workflow-dispatch'], { now });
    return ev.kind === 'TICK' && ev.actor === 'manual';
  });
  expect('the event_name trap payload THROWS (live bug #5)', () => {
    try { buildEvent(fixtures['trap-event-name-only'], { now }); return false; } catch (e) { return /malformed/.test(e.message); }
  });
  expect('a dispatch WITHOUT action THROWS', () => {
    try { buildEvent(fixtures['trap-dispatch-without-action'], { now }); return false; } catch (e) { return /malformed/.test(e.message); }
  });
  expect('an UNKNOWN non-empty action THROWS (strict)', () => {
    try { buildEvent({ action: 'banana', client_payload: {} }, { now }); return false; } catch (e) { return /unknown repository_dispatch action/.test(e.message); }
  });
  const bad = checks.filter(c => !c.ok);
  record('payload-shape', bad.length === 0,
    `${checks.length - bad.length}/${checks.length} fixture checks ok${bad.length ? ' — FAILED: ' + bad.map(b => b.name).join(', ') : ''} `
    + '(frozen live shapes route correctly; the event_name/action-less/unknown traps throw — the pause-instead-of-reset class is dead)');
}

// ---------------------------------------------------------------------------
// 6. lease-margin — the X14 formula as an executable assertion: a worker's
// effective work budget (lease issued at dispatch time minus the
// dispatch->run latency, work, and the report-drain margin) must be
// POSITIVE. lease_minutes=4 @ 164s latency: NEGATIVE (flagged — the live
// incoherence); lease_minutes=15: positive. Driven through the real lane.
// ---------------------------------------------------------------------------

function scenarioLeaseMargin() {
  const WORK_MS = 240_000;            // a representative real-LLM turn (the X14 lane)
  const DRAIN_MARGIN_MS = 194_000;    // worst-case report drain wait: the next tick (run 30s + latency 164s)
  const mk = (leaseMinutes) => {
    const clock = makeClock();
    const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0 });  // deterministic: exact latency
    const assignAt = clock.ms;        // the lease is issued at dispatch time (the conductor commit)
    const leaseMs = leaseMinutes * 60_000;
    const d = lane.send('fsm-task', { task: 'T-101' });
    const budget = assignAt + leaseMs - d.willRunAt - WORK_MS - DRAIN_MARGIN_MS;
    return { budget, willRunAt: d.willRunAt, leaseExpires: assignAt + leaseMs };
  };
  const short = mk(4);
  const long = mk(15);
  // behavioral confirmation: drive the one-task project both ways (a real-shaped
  // slow task whose report structurally lands after a 4min lease was timed out
  // by an intervening tick — under lease=4 the task can NEVER complete)
  const drive = (leaseMinutes) => {
    const lab = setupRepo();
    try {
      const clock = makeClock();
      const store = new Store({ cwd: lab.clone });
      const group = new ConcurrencyGroup({ clock });
      const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0 });
      const ONE = { milestones: 1, m1: [{ id: 'X', title: 'x', behavior: 'succeed', work_ms: WORK_MS }] };
      const d = new SimDriver({
        clock, store, project: ONE,
        config: { max_parallel: 1, lease_minutes: leaseMinutes, max_attempts: 3, tick_min_interval_s: 0 },
        group, lane, opts: { label: `s6-${leaseMinutes}`, reportMode: 'git', maxCycles: 60 },
      });
      d.run();
      return { status: d.state?.tasks?.X?.status, orphaned: d.state?.stats?.orphaned_reports, phase: d.state?.project?.phase };
    } finally { lab.cleanup(); }
  };
  const shortRun = drive(4);
  const longRun = drive(15);
  const pass = short.budget < 0 && shortRun.orphaned >= 1
    && long.budget > 0 && longRun.orphaned === 0 && longRun.status === 'done';
  record('lease-margin', pass,
    `lease=4min: budget=${(short.budget / 1000).toFixed(0)}s (NEGATIVE — flagged; worker starts at +${((short.willRunAt - Date.parse('2026-09-06T14:00:00Z')) / 1000).toFixed(0)}s, lease expires +240s) `
    + `behavior: X=${shortRun.status} orphaned=${shortRun.orphaned} | lease=15min: budget=+${(long.budget / 1000).toFixed(0)}s, X=${longRun.status} orphaned=${longRun.orphaned} `
    + '(X14: lease >= dispatchLatency + work + drainMargin — 164s latency makes 4min incoherent)');
}

// ---------------------------------------------------------------------------
// 7. scale-200 — 200 generated tasks (4 milestone batches of 50 deps-free
// tasks) through conductor-core: completion + the scale envelope measured.
// ---------------------------------------------------------------------------

function genScaleProject(n = 200, batch = 50) {
  const p = { milestones: n / batch };
  for (let b = 0; b < n / batch; b++) {
    p[`m${b + 1}`] = Array.from({ length: batch }, (_, i) => ({
      id: `S${b + 1}-${String(i + 1).padStart(2, '0')}`,
      title: `scale task ${b + 1}.${i + 1}`,
      behavior: 'succeed', work_ms: 1,
    }));
  }
  return p;
}

function scenarioScale200() {
  const lab = setupRepo();
  try {
    const t0 = Date.now();
    const clock = makeClock();
    const store = new Store({ cwd: lab.clone });
    const group = new ConcurrencyGroup({ clock });
    const lane = new DispatchLane({ clock, latencyMs: 164_000, jitter: 0.2, rng: mulberry32(97) });
    const d = new SimDriver({
      clock, store, project: genScaleProject(200, 50),
      config: { max_parallel: 32, lease_minutes: 15, max_attempts: 3, tick_min_interval_s: 0 },
      group, lane, opts: { label: 's7', reportMode: 'git', maxCycles: 300 },
    });
    d.run();
    const wallMs = Date.now() - t0;
    store.fetch();
    const raw = store.readFile('state/state.json') || '';
    const s = d.state;
    const pass = s?.project?.phase === 'done' && s?.stats?.done === 200;
    record('scale-200', pass,
      `phase=${s?.project?.phase} done=${s?.stats?.done}/200 wall=${(wallMs / 1000).toFixed(1)}s commits=${d.commitCount} turns=${d.turnCount} `
      + `stateBytes=${raw.length} journalSeq=${s?.journal_seq} reportEnqueues=${d.reportEnqueues.length} dispatches=${d.dispatchLog.length} `
      + `(probe-D envelope: ~0.77KB/task, conductor-core at 200 tasks)`);
  } finally { lab.cleanup(); }
}

// ---------------------------------------------------------------------------

const which = process.argv[2] || 'all';
const scenarios = {
  'actions-drop': scenarioActionsDrop,
  'queue-cancel': scenarioQueueCancel,
  'dep-deadlock': scenarioDepDeadlock,
  'control-cancel': scenarioControlCancel,
  'payload-shape': scenarioPayloadShape,
  'lease-margin': scenarioLeaseMargin,
  'scale-200': scenarioScale200,
};
const toRun = which === 'all' ? Object.keys(scenarios) : [which];
for (const name of toRun) {
  if (!scenarios[name]) { console.error(`unknown scenario: ${name}`); process.exit(1); }
  scenarios[name]();
}
const failed = results.filter(r => !r.pass).length;
console.log(`\nSIM2-RESULT ${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
