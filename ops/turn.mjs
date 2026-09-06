// ops/turn.mjs — the OPERATOR command ingest. Runs in its OWN workflow with
// its OWN concurrency group (no contention with the hot conductor chain —
// the live discovery: external dispatches into the conductor group get
// newest-wins-cancelled by the next self-tick). This appends the command to
// the control queue on the state branch; the next tick drains it atomically.
//
// Wake: repository_dispatch fsm-control {command, note} | workflow_dispatch.

import { Store } from '../lib/store.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const EVENT = JSON.parse(process.env.EVENT || '{}');

function command() {
  if (EVENT.event_name === 'fsm-control') return EVENT.client_payload || {};
  const inputs = EVENT.inputs || {};
  return { command: inputs.command || 'pause', note: inputs.note || '' };
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
  if (!r.ok) process.exitCode = 1;
}

main().catch(e => { console.error('OPS-FAILED:', e.message); process.exitCode = 1; });
