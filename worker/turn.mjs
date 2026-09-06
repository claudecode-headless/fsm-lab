// worker/turn.mjs — ONE task execution (the agent seat).
//
// Mock mode (the stress-test lane): the behavior profile IS the agent —
// deterministic, free, fast. Real mode (the seam proof): one OpenRouter
// completion stands in for the CC turn (X7).
//
// The worker NEVER writes state — it reports through a CAS-appended line on
// the state branch's report queue (data flows through git; dispatches are
// the wake mechanism only — the concurrency-group depth-1 discovery made
// run-per-report lossy: pending runs in a group are newest-wins-cancelled).
// The tick drains the queue atomically. Report semantics: at-least-once
// enqueue, exactly-once apply (event_id dedup on the conductor side).

import { mockWork } from '../lib/mock.mjs';
import { Store } from '../lib/store.mjs';

const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
// T44: LAB_PAT dropped — the worker NEVER dispatches (reports ride git via
// CAS-append; the report enqueue uses the checkout's git credentials, and
// the state branch accepts the ephemeral job token). Zero PAT surface here.
const CP = JSON.parse(process.env.EVENT || '{}').client_payload || {};
const MODE = CP.mode || 'mock';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function enqueue(report) {
  const store = new Store({ cwd: process.cwd() });
  return store.enqueueReport(report);
}

async function realWork() {
  // X7: the non-deterministic-agent seam. One free-model OpenRouter
  // completion stands in for a CC turn. Proves: a real LLM call inside the
  // deterministic FSM wrapper, reported through the same lease contract.
  const key = process.env.OPENROUTER_API_KEY;
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'minimax/minimax-m3:free',
      messages: [
        { role: 'system', content: 'You are a task worker. Reply with a one-line result summary.' },
        { role: 'user', content: `Task ${CP.task}: ${CP.prompt || 'compute a one-line status report for this unit of work.'}` },
      ],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(150_000),  // bounded: the lease is the semantic backstop, not the hang
  });
  const d = await r.json().catch(() => ({}));
  const content = d?.choices?.[0]?.message?.content || null;
  return {
    status: r.status === 200 && content ? 'done' : 'failed',
    artifact: content ? String(content).slice(0, 200) : null,
    error: r.status !== 200 ? `openrouter-${r.status}` : (content ? null : 'empty-completion'),
    duration_ms: Date.now() - t0,
  };
}

async function main() {
  console.log(`WORKER-START task=${CP.task} behavior=${CP.behavior} attempt=${CP.attempt} mode=${MODE} run=${RUN_ID}`);
  const t0 = Date.now();

  let outcome;
  if (MODE === 'real') {
    outcome = await realWork();
  } else {
    const w = mockWork(CP.behavior, { task: CP.task, attempt: CP.attempt, workMs: CP.work_ms ?? 5000 });
    // bound the sleep: job timeout-minutes kills anything longer anyway;
    // for 'hang'/'slow' the KILL is the point (lease timeout handles it).
    const sleepMs = Math.min(w.sleepMs, 20 * 60_000);
    await sleep(sleepMs);
    outcome = w.outcome ? { ...w.outcome, duration_ms: Date.now() - t0 } : null;
    if (!outcome) {
      // hang / no-report: deliberately never report. Log the intent, exit 0
      // (the run itself succeeding while the WORK goes unreported is exactly
      // the failure class the lease deadline exists for).
      console.log(`WORKER-SILENT task=${CP.task} behavior=${CP.behavior} (no report by design — lease ${CP.expires} is the handler)`);
      return;
    }
    if (w.repeatReport) {
      // the duplicate-report class: same event_id enqueued twice — the
      // conductor's drain must dedup the second
      const payload = {
        event_id: `rep-${RUN_ID}`, task: CP.task, lease: CP.lease,
        outcome, run_id: RUN_ID,
      };
      const r1 = await enqueue(payload);
      await sleep(1500);
      const r2 = await enqueue(payload);
      console.log(`WORKER-REPORT-DUP first=${r1.ok} second=${r2.ok} (second must be deduped by the drain)`);
      return;
    }
  }

  const payload = {
    event_id: `rep-${RUN_ID}`, task: CP.task, lease: CP.lease,
    outcome, run_id: RUN_ID,
  };
  const r = await enqueue(payload);
  console.log(`WORKER-DONE task=${CP.task} outcome=${outcome.status} enqueue=${r.ok ? 'ok' : 'FAILED:' + r.err} (${Date.now() - t0}ms)`);
  if (!r.ok) process.exitCode = 2;
}

main().catch(e => {
  console.error('WORKER-FAILED:', e.message);
  // exit non-zero: the run shows failed (L0 visibility); the lease deadline
  // is the semantic handler either way.
  process.exitCode = 1;
});
