// watchdog/scan.mjs — the chain-health backstop.
//
// The watchdog NEVER writes state (single-writer discipline: the conductor
// group owns state). Its powers are READ + DISPATCH + ALERT-ISSUE only:
//   1. read state (via git fetch of the fsm-state branch — read-only)
//   2. if halted/paused -> exit (chain stopped on purpose)
//   3. staleness = now - chain.last_tick > stale_after
//   4. if stale AND no conductor run started recently (in-flight check) ->
//      re-prime: dispatch fsm-tick (reason: watchdog-reprime)
//   5. circuit breaker: >= maxReprimes re-primes within the window AND still
//      stale -> STOP re-priming, open ONE alert issue (dedup: search open
//      issues for the alert marker first)
//   6. if state.json is corrupt -> alert issue (the conductor self-heals on
//      its next tick via findLastGoodState; if the chain is dead, the
//      re-prime dispatch triggers that recovery path)
//
// Cadence: schedule (intermittent) + manual dispatch. The conductor chain is
// the primary driver; this is the safety net that catches dead links.

import { Store } from '../lib/store.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const PAT = process.env.LAB_PAT;
const TOKEN = process.env.GH_TOKEN || PAT; // X1a: job token first, PAT fallback
const STALE_AFTER_MS = parseInt(process.env.STALE_AFTER_MIN || '4', 10) * 60_000;
const REPRIME_WINDOW_MIN = 30;
const MAX_REPRIMES = 3;

async function api(path, method = 'GET', body = null) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-watchdog',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  return { status: r.status, data };
}

async function findAlertIssue() {
  const r = await api(`/repos/${REPO}/issues?state=open&labels=fsm-watchdog-alert&per_page=10`);
  return (r.data || [])[0] || null;
}

async function openAlertIssue(body) {
  const existing = await findAlertIssue();
  if (existing) {
    // T44 rate-limit: comment only if the last marker comment is older than
    // 24h — a corrupt-state chain firing every ~2h scan was commenting the
    // same alert 12x/day (the alert issue itself is already deduped to ONE).
    // 44-h P2: prefix-match '[fsm-watchdog]' (covers the CIRCUIT-BREAKER
    // variant too) + DESC order (per_page returns the OLDEST by default —
    // the newest marker was invisible once the issue exceeded 20 comments).
    const r = await api(`/repos/${REPO}/issues/${existing.number}/comments?per_page=1&sort=created&direction=desc`, 'GET');
    const last = (r.data || []).find(c => (c.body || '').includes('[fsm-watchdog]'));
    if (last && Date.now() - Date.parse(last.created_at) < 24 * 3600_000) {
      console.log(`WATCHDOG-ALERT-SKIP (recent marker <24h on issue #${existing.number})`);
      return existing.number;
    }
    await api(`/repos/${REPO}/issues/${existing.number}/comments`, 'POST', { body });
    return existing.number;
  }
  const r = await api(`/repos/${REPO}/issues`, 'POST', {
    title: 'WATCHDOG: chain dead — manual intervention required',
    labels: ['fsm-watchdog-alert'],
    body,
  });
  return r.data?.number || null;
}

async function conductorRunsSince(minutes) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const r = await api(`/repos/${REPO}/actions/workflows/conductor.yml/runs?created=>=${since}&per_page=100`);
  return r.data?.workflow_runs || [];
}

async function main() {
  const store = new Store({ cwd: process.cwd() });
  store.fetch();
  const { state, corrupt } = store.readState();

  if (!state) {
    console.log(`state.json unreadable (corrupt=${!!corrupt}) — the conductor's recovery path handles it; alerting if chain is also stale`);
    const body = `**[fsm-watchdog]** state.json is UNREADABLE on ${store.branch}. The conductor self-heals via git-history recovery on its next tick.`;
    // still check chain liveness below with a null state — but we cannot know
    // halted/paused. Conservative: alert, no re-prime (avoid thrashing a
    // corrupt-state loop).
    await openAlertIssue(body);
    console.log('WATCHDOG-DONE mode=corrupt-state alert=opened no-reprime');
    return;
  }

  if (state.chain.halted) { console.log('WATCHDOG-DONE mode=halted (project complete or halted)'); return; }
  if (state.chain.paused) { console.log('WATCHDOG-DONE mode=paused (operator hold)'); return; }

  const age = Date.now() - Date.parse(state.chain.last_tick);
  const stale = age > STALE_AFTER_MS;
  console.log(`WATCHDOG-SCAN seq=${state.chain.seq} last_tick=${state.chain.last_tick} age=${Math.round(age / 1000)}s stale=${stale} done=${state.stats.done}/${Object.keys(state.tasks).length}`);

  if (!stale) { console.log('WATCHDOG-DONE mode=healthy'); return; }

  // stale: is a conductor run already in flight? (queue latency, slow tick)
  // T44: lookback 6min < the conductor job timeout (10min) but benign: the
  // conductor group is cancel-in-progress:false — an extra re-prime QUEUES
  // behind the live run rather than cancelling it; worst case it feeds the
  // breaker count one benign duplicate.
  const recent = await conductorRunsSince(6);
  const active = recent.filter(r => ['queued', 'in_progress'].includes(r.status));
  if (active.length > 0) {
    console.log(`WATCHDOG-DONE mode=stale-but-inflight (${active.length} run(s) queued/running) — waiting`);
    return;
  }

  // circuit breaker: count my re-primes in the window (run-name carries the
  // reason; runs dispatched by the watchdog are named via client_payload)
  const windowRuns = await conductorRunsSince(REPRIME_WINDOW_MIN);
  const reprimes = windowRuns.filter(r => (r.name || '').includes('watchdog-reprime'));
  if (reprimes.length >= MAX_REPRIMES) {
    const body = `**[fsm-watchdog CIRCUIT-BREAKER]** the chain has been re-primed ${reprimes.length}× in ${REPRIME_WINDOW_MIN}min and is STILL stale (seq=${state.chain.seq}, last_tick=${state.chain.last_tick}).\n\n`
      + `Re-priming is now DISABLED. Manual intervention required:\n`
      + `1. read the last conductor run's log (Actions tab)\n`
      + `2. fix the root cause\n`
      + `3. re-arm: POST /repos/${REPO}/dispatches {"event_type":"fsm-tick","client_payload":{"reason":"manual"}}`;
    const n = await openAlertIssue(body);
    console.log(`WATCHDOG-DONE mode=breaker-open alert=${n} reprimes=${reprimes.length}`);
    return;
  }

  // re-prime (with one retry — a single transient 5xx must not lose it)
  let r = await api(`/repos/${REPO}/dispatches`, 'POST', {
    event_type: 'fsm-tick',
    client_payload: { reason: 'watchdog-reprime', stale_seq: state.chain.seq },
  });
  if (r.status !== 204) {
    await new Promise(res => setTimeout(res, 2000));
    r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: 'fsm-tick',
      client_payload: { reason: 'watchdog-reprime', stale_seq: state.chain.seq },
    });
  }
  console.log(`WATCHDOG-REPRIME dispatch=${r.status} (reprime ${reprimes.length + 1}/${MAX_REPRIMES} in window)`);
  console.log('WATCHDOG-DONE mode=reprime');
}

main().catch(e => {
  console.error('WATCHDOG-FAILED:', e.message);
  process.exitCode = 1;
});
