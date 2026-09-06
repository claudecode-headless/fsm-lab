// conductor/turn.mjs — ONE turn of the FSM conductor.
//
// Wake shapes (all consumed here, serialized by the workflow's concurrency
// group — single state writer by construction):
//   repository_dispatch fsm-tick    {client_payload: {reason, seq}}
//   repository_dispatch fsm-report  {client_payload: {event_id, task, lease, outcome, run_id}}
//   repository_dispatch fsm-control {client_payload: {command}}
//   workflow_dispatch (manual tick) / schedule (backstop tick)
//
// Turn algorithm (fail-safe ordering — commit BEFORE act):
//   1. read state (corruption -> findLastGoodState recovery)
//   2. apply(applyEvent + clock)  [pure]
//   3. commit via CAS             [state is truth]
//   4. execute actions: dispatch workers (PAT), post alerts (PAT)
//   5. self-dispatch next tick (PAT) — the chain continuation, unless
//      STOP_CHAIN/HOLD_CHAIN. A failed dispatch is retried in-turn; if the
//      self-dispatch itself dies, the WATCHDOG re-primes the chain.
//
// Ordering rationale: if we crash between 3 and 4, the lease deadline
// re-covers the un-dispatched task (timeout -> retry). If we crash between
// 4 and 5, the watchdog re-primes. Every failure state has a handler.

import { Store } from '../lib/store.mjs';
import { genesis, apply, invariants } from '../lib/fsm.mjs';
import { mockProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const PAT = process.env.LAB_PAT;
// X1a finding applied: same-repo dispatches ride the EPHEMERAL job token
// (repository_dispatch is a documented exception to the anti-recursion rule
// — probe-proven run 34025596219). The PAT stays as the fallback lane.
const TOKEN = process.env.GH_TOKEN || PAT;
const EVENT = JSON.parse(process.env.EVENT || '{}');
const OPS_ISSUE = parseInt(process.env.OPS_ISSUE || '1', 10);

const NM = nextMilestoneFactory(mockProject());
const now = () => new Date().toISOString();

async function api(path, method = 'GET', body = null, token = TOKEN) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-conductor',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  return { status: r.status, data };
}

async function dispatchRetry(eventType, clientPayload, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: eventType, client_payload: clientPayload,
    });
    if (r.status === 204) return { ok: true };
    last = r;
    await new Promise(res => setTimeout(res, 2000 * (i + 1)));
  }
  return { ok: false, status: last?.status, body: last?.data };
}

async function postIssueComment(body) {
  const r = await api(`/repos/${REPO}/issues/${OPS_ISSUE}/comments`, 'POST', { body });
  return r.status === 201;
}

// ---------------------------------------------------------------------------

function buildEvent() {
  // repository_dispatch carries its type in `action` (event_name does NOT
  // exist on dispatch payloads — live bug #5 of the payload-shape family;
  // the ops ingest had it too). schedule/workflow_dispatch have no action.
  const cp = EVENT.client_payload || {};
  const kind = EVENT.action || '';
  if (kind === 'fsm-report') {
    return {
      kind: 'REPORT', event_id: cp.event_id, task: cp.task, lease: cp.lease,
      outcome: cp.outcome, run_id: cp.run_id, ts: now(),
    };
  }
  if (kind === 'fsm-control') {
    return { kind: 'CONTROL', command: cp.command, event_id: `ctl-direct-${cp.command}-${Date.now()}`, ts: now() };
  }
  // fsm-tick / schedule / workflow_dispatch
  const reason = cp.reason || (EVENT.schedule ? 'schedule-backstop' : 'manual');
  return { kind: 'TICK', actor: reason, event_id: `tick-${reason}-${Date.now()}`, ts: now() };
}

function summaryMd(state, applied, reason, actions) {
  const tasks = Object.values(state.tasks);
  const by = (s) => tasks.filter(t => t.status === s).length;
  return [
    `## conductor turn — ${new Date().toISOString()}`,
    `applied=${applied} reason=${reason} version=v${state.version} chain.seq=${state.chain.seq} phase=${state.project.phase} milestone=M${state.project.milestone}`,
    '',
    `| done | failed | quarantined | cancelled | active | ready | backlog | retries | timeouts | orphaned | dispatched |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
    `| ${by('done')} | ${by('failed')} | ${by('quarantined')} | ${by('cancelled')} | ${by('assigned') + by('in_progress')} | ${by('ready')} | ${by('backlog')} | ${state.stats.retries} | ${state.stats.timeouts} | ${state.stats.orphaned_reports} | ${state.stats.dispatched} |`,
    '',
    `actions: ${actions.map(a => a.type + (a.task ? `(${a.task})` : '')).join(', ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const store = new Store({ cwd: process.cwd() });
  const ev = buildEvent();
  const t0 = Date.now();

  // 1-3. read + drain reports + apply + CAS commit — ONE atomic commit:
  // the queue drain, the event application, and the clock pass land together.
  // (The depth-1 concurrency-queue discovery: report events must NOT ride
  // workflow runs — they'd be newest-wins-cancelled. Data flows through git.)
  const out = await Promise.resolve(store.commit({
    mutate: (cur, journalTail, queue, controlQueue) => {
      let base = cur;
      if (!base) {
        const good = store.findLastGoodState();
        if (!good) {
          base = genesis({
            config: { max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
            project: { tasks: mockProject().m1, milestones: 3 },
            chainId: `c-${Date.now()}`,
            now: now(),
          });
          console.log('BOOTSTRAP: genesis state created');
        } else {
          base = good.state;
          console.log(`RECOVERY: rebuilt from git-history snapshot (seq=${base.chain.seq})`);
        }
      }
      // DRAIN (atomic, one commit): control queue FIRST (pause/resume/reset
      // must gate the rest), then report queue, then the wake event + clock.
      let s = base;
      let journals = [];
      const actionsAll = [];
      const survivingCtl = [];
      const surviving = [];
      let drained = 0, ctlDrained = 0;
      for (const c of controlQueue) {
        if (c.cmd === 'reset') {
          // reset: fresh project instance, journal continues
          const g = genesis({
            config: { max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
            project: { tasks: mockProject().m1, milestones: 3 },
            chainId: `c-${Date.now()}`,
            now: now(),
          });
          g.journal_seq = (s?.journal_seq || 1);
          const rec = { id: `e${g.journal_seq}`, ts: now(), kind: 'CONTROL', command: 'reset', applied: true };
          g.journal_seq += 1;
          console.log(`RESET (queued control): new chain ${g.chain.id}`);
          s = g;
          journals.push(rec);
          ctlDrained++;
          continue;
        }
        const cev = { kind: 'CONTROL', command: c.cmd, event_id: c.id, ts: c.ts };
        const cr = apply(s, cev, now(), NM);
        s = cr.state;
        journals.push(...cr.journal);
        actionsAll.push(...cr.actions);
        if (cr.applied || cr.reason === 'duplicate') ctlDrained++;
        else survivingCtl.push(c);
      }
      // a queued RESET replaces everything: reports/tick apply on the fresh state
      if (ev.kind === 'CONTROL' && ev.command === 'reset') {
        // direct dispatch path (works when the chain is idle)
        const g = genesis({
          config: { max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 },
          project: { tasks: mockProject().m1, milestones: 3 },
          chainId: `c-${Date.now()}`,
          now: now(),
        });
        g.journal_seq = (s?.journal_seq || 1);
        const rec = { id: `e${g.journal_seq}`, ts: now(), kind: 'CONTROL', command: 'reset', applied: true };
        g.journal_seq += 1;
        console.log(`RESET (direct): new chain ${g.chain.id}`);
        return { state: g, journal: [...journals, rec], actions: actionsAll, queue: surviving, controlQueue: [], message: `RESET chain=${g.chain.id}` };
      }
      const queueRemaining = s.chain.halted || s.chain.paused ? controlQueue.filter(c => c.cmd === 'reset') : [];
      void queueRemaining;
      for (const q of queue) {
        const rev = { kind: 'REPORT', event_id: q.event_id, task: q.task, lease: q.lease, outcome: q.outcome, run_id: q.run_id };
        const rr = apply(s, rev, now(), NM);
        s = rr.state;
        journals.push(...rr.journal);
        actionsAll.push(...rr.actions);
        if (rr.applied || rr.reason === 'duplicate') drained++; // consumed either way
        else surviving.push(q); // unparseable/unknown-task reports stay parked
      }
      const r = apply(s, ev, now(), NM);
      const viol = invariants(r.state);
      if (viol.length) throw new Error(`INVARIANT VIOLATION: ${viol.join('; ')}`);
      journals.push(...r.journal);
      actionsAll.push(...r.actions);
      if (journals.length === 0 && !r.applied) {
        return { noop: true, reason: r.reason };
      }
      return {
        state: r.state, journal: journals, actions: actionsAll,
        queue: surviving, controlQueue: survivingCtl,
        message: `${ev.kind}${drained ? `+${drained}r` : ''}${ctlDrained ? `+${ctlDrained}c` : ''} seq=${r.state.chain.seq} v${r.state.version} done=${r.state.stats.done} [${journals[0]?.id}..${journals[journals.length - 1]?.id}]`,
      };
    },
  }));

  if (!out.committed) {
    console.log(`NOOP: ${out.reason} — chain continues`);
    await dispatchRetry('fsm-tick', { reason: 'chain', seq: (out.state?.chain?.seq ?? 0) + 1 });
    return;
  }
  const state = out.state;

  // 4. execute actions (workers first — parallelism starts ASAP)
  let dispatchFailures = 0;
  const actionList = out.actions || [];
  for (const a of actionList) {
    if (a.type === 'DISPATCH_WORKER') {
      const d = await dispatchRetry('fsm-task', {
        task: a.task, lease: a.lease, behavior: a.behavior,
        attempt: a.attempt, work_ms: a.work_ms, expires: a.expires,
        chain: state.chain.id,
      });
      if (!d.ok) dispatchFailures++;
    }
  }

  // alertable journal records -> ops issue comments (bounded: quarantine is
  // terminal per task; PHASE/MILESTONE fire once each)
  for (const j of out.journal || []) {
    if (j.kind === 'REPORT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED (attempts exhausted) — journal ${j.id}`);
    }
    if (j.kind === 'TIMEOUT' && j.to === 'quarantined') {
      await postIssueComment(`**[fsm-alert]** task ${j.task} QUARANTINED via lease timeout — journal ${j.id}`);
    }
    if (j.kind === 'MILESTONE') {
      await postIssueComment(`**[fsm]** milestone M${j.milestone} STARTED (${j.tasks.length} tasks)`);
    }
    if (j.kind === 'PHASE' && j.to === 'done') {
      await postIssueComment(`**[fsm]** PROJECT COMPLETE — stats ${JSON.stringify(state.stats)}`);
    }
  }

  // 5. chain continuation — with cadence pacing (config.tick_min_interval_s):
  // a fast chain (sub-10s turns) burns run records for nothing; the pace
  // sleep keeps the job occupied (free on public repos) and throttles ticks.
  const stop = actionList.some(a => a.type === 'STOP_CHAIN' || a.type === 'HOLD_CHAIN');
  let chain = { ok: true };
  if (!stop) {
    const intervalMs = (state.config.tick_min_interval_s || 0) * 1000;
    const elapsed = Date.now() - t0;
    if (intervalMs > elapsed) {
      await new Promise(res => setTimeout(res, Math.min(intervalMs - elapsed, 240_000)));
    }
    chain = await dispatchRetry('fsm-tick', { reason: 'chain', seq: state.chain.seq + 1 });
  }
  // summary + compact log line
  const fs = await import('node:fs');
  const appliedReason = `${out.reason || 'ok'}${dispatchFailures ? ` dispatchFailures=${dispatchFailures}` : ''}`;
  fs.default.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null',
    summaryMd(state, true, appliedReason, actionList) + '\n');
  console.log(`TURN-COMPLETE applied=true reason=${appliedReason} v=${state.version} seq=${state.chain.seq} `
    + `done=${state.stats.done}/${Object.keys(state.tasks).length} phase=${state.project.phase} `
    + `actions=${actionList.length} chain=${stop ? "stopped" : chain.ok ? "ok" : "DISPATCH-FAILED(watchdog will re-prime)"}`);

  if (!chain.ok) {
    console.error(`self-dispatch failed: HTTP ${chain.status}`);
    process.exitCode = 3;
  }
}

main().catch(e => {
  console.error('CONDUCTOR-FAILED:', e.message);
  process.exitCode = 1;
});
