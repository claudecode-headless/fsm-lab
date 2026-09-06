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
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

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
    signal: AbortSignal.timeout(20_000),  // a hung call must not eat the job
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  const headers = {};
  for (const [k, v] of r.headers.entries()) headers[k.toLowerCase()] = v;
  return { status: r.status, data, headers };
}

// F6: Retry-After-aware, budget-capped, jittered. A 403+Retry-After (the
// secondary-rate-limit shape) must wait the SERVER floor, not burn all tries
// in 6s (the old fixed ladder = chain death on a transient). 403 WITHOUT
// Retry-After is a permission problem — fail fast, no retry.
async function dispatchRetry(eventType, clientPayload, tries = 5) {
  const t0 = Date.now();
  const BUDGET_MS = 240_000;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: eventType, client_payload: clientPayload,
    });
    if (r.status === 204) return { ok: true };
    last = r;
    const ra = parseInt(r.headers?.['retry-after'] || '', 10);
    if ((r.status === 403 || r.status === 429) && Number.isFinite(ra) && ra > 0) {
      const budgetLeft = BUDGET_MS - (Date.now() - t0);
      if (budgetLeft <= 0) break;
      await sleep(Math.min(ra * 1000 * (1 + Math.random() * 0.2), budgetLeft));
      continue;
    }
    if (r.status === 403) return { ok: false, status: 403, fatal: true };
    const budgetLeft = BUDGET_MS - (Date.now() - t0);
    if (budgetLeft <= 0) break;
    await sleep(Math.min(Math.round(2000 * (i + 1) * (0.8 + Math.random() * 0.4)), budgetLeft));
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
    // legacy lane: reports ride git since the queue rearchitecture; a direct
    // dispatch of this type still lands here — treat it as an event (the FSM
    // will apply it; dedup guards double-delivery with the queue copy).
    return {
      kind: 'REPORT', event_id: cp.event_id, task: cp.task, lease: cp.lease,
      outcome: cp.outcome, run_id: cp.run_id, ts: now(),
    };
  }
  if (kind === 'fsm-control') {
    return { kind: 'CONTROL', command: cp.command, patch: cp.patch, event_id: `ctl-direct-${cp.command}-${Date.now()}`, ts: now() };
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
  // T44 restructure: ONE drain path — the direct-dispatch reset becomes a
  // prepended control-queue item (the old special case returned before the
  // report drain and silently DELETED queued reports/controls, unjournaled).
  const DEFAULT_CFG = () => ({ max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 25 });
  const out = await Promise.resolve(store.commit({
    mutate: (cur, queue, controlQueue, queueBad, ctlBad) => {
      let base = cur;
      let repaired = null;
      if (!base) {
        const good = store.findLastGoodState();
        if (!good) {
          base = genesis({
            config: DEFAULT_CFG(),
            project: { tasks: mockProject().m1, milestones: 3 },
            chainId: `c-${Date.now()}`,
            now: now(),
          });
          repaired = 'bootstrap';
        } else {
          base = good.state;
          repaired = 'history-walk';
        }
      }
      // hand-crafted journal records (ids from the CURRENT journal_seq)
      const journals = [];
      const actionsAll = [];
      const mkJ = (s, fields, applied = true) => {
        const id = `e${s.journal_seq}`;
        s.journal_seq += 1;
        journals.push({ id, ts: now(), applied, ...fields });
      };

      // DRAIN: control queue FIRST (pause/resume/reset/configure gate the
      // rest). F1: controls are CONSUMED applied-or-rejected — reject reasons
      // are permanent (bad-command / phase-done / bad-patch), never reparked.
      const ctl = [];
      if (ev.kind === 'CONTROL' && ev.command === 'reset') {
        ctl.push({ cmd: 'reset', id: ev.event_id, ts: ev.ts, direct: true });
      }
      ctl.push(...controlQueue);
      let s = base;
      let skipWake = ev.kind === 'CONTROL' && ev.command === 'reset';
      let resetDone = false;
      for (const c of ctl) {
        if (c.cmd === 'reset') {
          // reset: fresh project instance (ADOPTS the current config — F12;
          // the journal carries the slim genesis spec so rebuild() replays it)
          const cfg = { ...s.config, tick_min_interval_s: Math.max(s.config.tick_min_interval_s ?? 0, 25) };
          const spec = mockProject().m1;
          const chainId = `c-${Date.now()}`;
          const g = genesis({
            config: cfg, project: { tasks: spec, milestones: 3 },
            chainId, now: now(),
          });
          const seqBase = s.journal_seq;
          g.journal_seq = seqBase + 1;
          mkJ(s, {
            kind: 'CONTROL', command: 'reset',
            genesisSpec: { config: cfg, tasks: spec, chainId, now: now(), journal_seq: seqBase },
          });
          s = g;
          resetDone = true;
          console.log(`RESET (${c.direct ? 'direct' : 'queued'}) control ${c.id}: new chain ${g.chain.id}`);
          continue;
        }
        const cev = { kind: 'CONTROL', command: c.cmd, patch: c.patch, event_id: c.id, ts: c.ts || now() };
        const cr = apply(s, cev, now(), NM);
        s = cr.state;
        journals.push(...cr.journal);
        actionsAll.push(...cr.actions);
        if (!cr.applied && cr.reason !== 'duplicate') {
          console.log(`CONTROL-REJECTED ${c.cmd} (${c.id}): ${cr.reason}`);
        }
      }
      // unparseable control lines: audited then dropped (the rewrite removes them)
      for (const raw of ctlBad) {
        mkJ(s, { kind: 'REJECTED', origKind: 'CONTROL', reason: 'unparseable', raw }, false);
      }

      // DRAIN: report queue. F1: consumed applied-or-rejected — every reject
      // reason is permanent (unknown-task / task-not-leased / stale-lease /
      // bad-outcome), and F11's early pushDedup makes any re-enqueue of the
      // same event_id a duplicate. The zombie-park loop (re-rejecting the
      // same lines every tick, forever) is dead by construction.
      let drained = 0;
      for (const q of queue) {
        const rev = { kind: 'REPORT', event_id: q.event_id, task: q.task, lease: q.lease, outcome: q.outcome, run_id: q.run_id };
        const rr = apply(s, rev, now(), NM);
        s = rr.state;
        journals.push(...rr.journal);
        actionsAll.push(...rr.actions);
        drained++;
      }
      for (const raw of queueBad) {
        mkJ(s, { kind: 'REJECTED', origKind: 'REPORT', reason: 'unparseable', raw }, false);
      }

      // wake event (a direct reset WAS the control — already applied above)
      let wakeApplied = false, wakeReason = 'ok';
      if (!skipWake) {
        const r = apply(s, ev, now(), NM);
        s = r.state;
        journals.push(...r.journal);
        actionsAll.push(...r.actions);
        wakeApplied = r.applied;
        wakeReason = r.reason;
      }

      // fail-closed: invariant violations never commit (unchanged discipline)
      const viol = invariants(s);
      if (viol.length) throw new Error(`INVARIANT VIOLATION: ${viol.join('; ')}`);

      // A2: repair forces the commit — under quiescence a recovered state
      // must PERSIST or corruption never heals (red-team probe: 3 wakes, tip
      // frozen, state still corrupt). RECOVERY journals the epoch boundary.
      if (repaired) {
        mkJ(s, { kind: 'RECOVERY', reason: repaired });
        if (repaired === 'bootstrap') actionsAll.push({ type: 'BOOTSTRAP_NOTICE', reason: repaired });
        else actionsAll.push({ type: 'RECOVERY_NOTICE', reason: repaired });
        console.log(`RECOVERY: base rebuilt from ${repaired === 'bootstrap' ? 'fresh genesis (state branch was absent or history unreadable)' : 'git-history snapshot'}`);
      }

      // F2 noop gate — on the ACCUMULATED journal (drain + wake), never the
      // wake event alone: a drain that halts the chain mid-mutate still
      // commits (its PHASE/STOP records must land).
      if (journals.length === 0 && !wakeApplied && !repaired) {
        return { noop: true, reason: wakeReason || 'quiesced' };
      }
      return {
        state: s, journal: journals, actions: actionsAll,
        queue: [], controlQueue: [],   // F1: the drain consumed everything
        message: `${skipWake ? 'reset' : ev.kind}${drained ? `+${drained}r` : ''} seq=${s.chain.seq} v${s.version} done=${s.stats.done} [${journals[0]?.id}..${journals[journals.length - 1]?.id}]${resetDone ? ' RESET' : ''}${repaired ? ' RECOVERED' : ''}`,
      };
    },
  }));

  if (!out.committed) {
    // F2/A1: QUIESCED — a held chain with empty queues. NEVER self-dispatch
    // (the old noop path restarted stopped chains; a mixed-deploy version of
    // that is a livelock at runner cadence — structurally impossible now).
    const held = out.state?.chain?.paused || out.state?.chain?.halted;
    console.log(`QUIESCED: ${out.reason}${held ? ` (chain ${out.state.chain.paused ? 'paused' : 'halted'})` : ''} — no commit, no self-dispatch`);
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
    if (a.type === 'BOOTSTRAP_NOTICE') {
      await postIssueComment(`**[fsm]** BOOTSTRAP: fresh genesis committed (state branch was absent or its history was unreadable — if this is unexpected, the previous state was LOST; check the repo's branch protection and recent pushes).`);
    }
    if (a.type === 'RECOVERY_NOTICE') {
      await postIssueComment(`**[fsm]** RECOVERY: state rebuilt from a git-history snapshot (last parseable state.json). Investigate what corrupted the tip.`);
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
