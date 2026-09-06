// ops/turn.mjs — the OPERATOR command ingest. Runs in its OWN workflow with
// its OWN concurrency group (no contention with the hot conductor chain —
// the live discovery: external dispatches into the conductor group get
// newest-wins-cancelled by the next self-tick). This appends the command to
// the control queue on the state branch; the next tick drains it atomically.
//
// Wake: repository_dispatch fsm-control {command, patch?, note} | workflow_dispatch.
// Commands: pause | resume | halt | unhalt | reset | configure
//   configure: {patch: {max_parallel?, lease_minutes?, max_attempts?,
//             tick_min_interval_s?}} — validated by the FSM (bounded 1..32 /
//             1..120 / 1..9 / 0..600); the runtime knob surface (F12).

import { Store } from '../lib/store.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const TOKEN = process.env.GH_TOKEN;  // T44/F3: the job token (was undefined —
// every ops-nudge 401'd since birth, live runs 34026953026/34028691734)
const EVENT = JSON.parse(process.env.EVENT || '{}');

const COMMANDS = ['pause', 'resume', 'halt', 'unhalt', 'reset', 'configure'];

function command() {
  // repository_dispatch carries its type in `action` (NOT event_name — the
  // live bug: the field doesn't exist on dispatch payloads and the fallback
  // silently enqueued `pause` instead of `reset`)
  if (EVENT.action === 'fsm-control') return EVENT.client_payload || {};
  const inputs = EVENT.inputs || {};
  const out = { command: inputs.command, note: inputs.note || '' };
  // workflow_dispatch inputs are STRINGS — the patch arrives as JSON text
  if (inputs.patch) {
    try {
      out.patch = JSON.parse(inputs.patch);
    } catch (e) {
      out.patch = { __error: `patch is not valid JSON: ${e.message}` };
    }
  }
  return out;
}

async function nudgeTick(reason) {
  // wake the conductor to drain the control immediately (a paused/stopped
  // chain has no self-tick; the schedule backstop covers it at ~2h cadence
  // post-cold-start — this makes control response immediate). If the chain
  // is hot, the nudge may be superseded (newest-wins) — the next self-tick
  // drains the queue anyway, so the command is never lost.
  const post = async () => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'fsm-lab-ops',
      },
      body: JSON.stringify({ event_type: 'fsm-tick', client_payload: { reason } }),
      signal: AbortSignal.timeout(20_000),
    });
    return r.status;
  };
  let status = await post();
  if (status !== 204) {
    await new Promise(res => setTimeout(res, 2000));
    status = await post();
  }
  return status;
}

async function main() {
  const cp = command();
  const store = new Store({ cwd: process.cwd() });
  const rec = {
    cmd: cp.command,
    patch: cp.patch,
    note: cp.note || '',
    ts: new Date().toISOString(),
    id: `ctl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (!COMMANDS.includes(rec.cmd)) {
    console.error(`OPS-REJECTED unknown command: ${rec.cmd} (known: ${COMMANDS.join(', ')})`);
    process.exitCode = 2;
    return;
  }
  if (rec.cmd === 'configure' && (!rec.patch || rec.patch.__error || typeof rec.patch !== 'object')) {
    console.error(`OPS-REJECTED configure needs a patch object (got: ${JSON.stringify(rec.patch)?.slice(0, 120)})`);
    process.exitCode = 2;
    return;
  }
  const r = store.enqueueControl(rec);
  console.log(`OPS-ENQUEUED ${rec.cmd} (${rec.id}) -> ${r.ok ? 'ok (next tick drains it)' : 'FAILED: ' + r.err}`);
  if (!r.ok) { process.exitCode = 1; return; }
  // every control changes behavior — nudge so it applies within seconds
  const status = await nudgeTick('ops-nudge');
  console.log(`OPS-NUDGE tick dispatch HTTP=${status}`);
  if (status !== 204) {
    console.error('OPS-NUDGE failed (control is queued; the next tick/backstop still drains it)');
    process.exitCode = 3;  // T44/F3: a broken nudge must be VISIBLE, not a logged 401 on a green run
  }
}

main().catch(e => { console.error('OPS-FAILED:', e.message); process.exitCode = 1; });
