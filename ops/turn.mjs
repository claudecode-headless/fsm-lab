// ops/turn.mjs — the OPERATOR command ingest. Runs in its OWN workflow with
// its OWN concurrency group (no contention with the hot conductor chain —
// the live discovery: external dispatches into the conductor group get
// newest-wins-cancelled by the next self-tick). This appends the command to
// the control queue on the state branch; the next tick drains it atomically.
//
// Wake: repository_dispatch fsm-control {command, note} | workflow_dispatch.

import { Store } from '../lib/store.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const PAT = process.env.LAB_PAT;
const TOKEN = process.env.GH_TOKEN || PAT;
const EVENT = JSON.parse(process.env.EVENT || '{}');

function command() {
  // repository_dispatch carries the type in `action` (NOT event_name — the
  // live bug: the field doesn't exist on dispatch payloads and the fallback
  // silently enqueued `pause` instead of `reset`)
  if (EVENT.action === 'fsm-control') return EVENT.client_payload || {};
  const inputs = EVENT.inputs || {};
  return { command: inputs.command, note: inputs.note || '' };
}

async function nudgeTick(reason) {
  // wake the conductor to drain the control immediately (a paused/stopped
  // chain has no self-tick; the schedule backstop covers it at <=10min —
  // this makes control response immediate). If the chain is hot, the nudge
  // may be superseded (newest-wins) — the next self-tick drains the queue
  // anyway, so the command is never lost.
  const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-ops',
    },
    body: JSON.stringify({ event_type: 'fsm-tick', client_payload: { reason } }),
  });
  return r.status;
}

async function main() {
  const cp = command();
  const store = new Store({ cwd: process.cwd() });
  const rec = {
    cmd: cp.command,
    note: cp.note || '',
    ts: new Date().toISOString(),
    id: `ctl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (!['pause', 'resume', 'halt', 'unhalt', 'reset'].includes(rec.cmd)) {
    console.error(`OPS-REJECTED unknown command: ${rec.cmd}`);
    process.exitCode = 2;
    return;
  }
  const r = store.enqueueControl(rec);
  console.log(`OPS-ENQUEUED ${rec.cmd} (${rec.id}) -> ${r.ok ? 'ok (next tick drains it)' : 'FAILED: ' + r.err}`);
  if (!r.ok) { process.exitCode = 1; return; }
  if (['resume', 'unhalt', 'reset', 'pause', 'halt'].includes(rec.cmd)) {
    const status = await nudgeTick('ops-nudge');
    console.log(`OPS-NUDGE tick dispatch HTTP=${status}`);
  }
}

main().catch(e => { console.error('OPS-FAILED:', e.message); process.exitCode = 1; });
