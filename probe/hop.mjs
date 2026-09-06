// probe/hop.mjs — X1: the chain-physics probe (the load-bearing uncertainty
// of the whole continuity design, settled EMPIRICALLY before the conductor
// ever runs).
//
// Law under test: "events created with GITHUB_TOKEN never start workflows"
//   -> a run cannot re-trigger itself with its own job token; the chain
//      MUST ride a PAT (repository_dispatch authored by a real user token).
//
// Probe shape:
//   variant=github-token: dispatch chain-probe-next {variant:'verify'} with
//     the JOB token, then WAIT 45s and query the run list — if no new run
//     appeared, the law HOLDS (GITHUB_TOKEN dispatch 204s but fires nothing).
//   variant=pat: dispatch chain-probe-next with LAB_PAT; the next hop run
//     continues (n+1 up to max). Hop latency is measured externally from
//     run timestamps.
//   variant=verify: only reachable if the law is BROKEN (a GITHUB_TOKEN
//     dispatch fired a run) — logs it loudly as a FINDING.
//
// Self-verifying: the 45s wait + run-list query means the probe's own log
// carries the verdict — no external interpretation needed.

const REPO = process.env.GITHUB_REPOSITORY || 'claudecode-headless/fsm-lab';
const PAT = process.env.LAB_PAT;
const GH_TOKEN = process.env.GH_TOKEN;
const N = parseInt(process.env.N || '0', 10);
const MAX = parseInt(process.env.MAX || '10', 10);
const VARIANT = process.env.VARIANT || 'pat';

async function api(path, method = 'GET', body = null, token = PAT) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fsm-lab-probe',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  return { status: r.status, data };
}

async function main() {
  const t = new Date().toISOString();
  console.log(`HOP n=${N} variant=${VARIANT} max=${MAX} at=${t}`);

  if (VARIANT === 'verify') {
    console.log('*** FINDING: GITHUB-TOKEN-WOKE — a GITHUB_TOKEN-authored repository_dispatch STARTED a workflow run. The anti-recursion law is BROKEN (this would change the continuity design: no PAT needed for self-chains). ***');
    return;
  }

  if (VARIANT === 'github-token') {
    // 1) attempt the self-dispatch with the JOB token
    const dispatchedAt = new Date().toISOString();
    const r = await api(`/repos/${REPO}/dispatches`, 'POST',
      { event_type: 'chain-probe-next', client_payload: { n: N + 1, max: MAX, variant: 'verify' } }, GH_TOKEN);
    console.log(`GITHUB-TOKEN dispatch HTTP=${r.status} (204 = accepted by the API; the question is whether a run FIRES)`);
    // 2) wait and observe
    await new Promise(res => setTimeout(res, 45_000));
    const runs = await api(`/repos/${REPO}/actions/workflows/chain-probe.yml/runs?per_page=10`);
    const fired = (runs.data?.workflow_runs || []).filter(run =>
      run.created_at >= dispatchedAt && run.id !== parseInt(process.env.GITHUB_RUN_ID || '0', 10));
    if (fired.length === 0) {
      console.log('VERDICT: GITHUB-TOKEN-NO-WAKE — dispatch accepted (204) but NO workflow run fired. Anti-recursion law CONFIRMED. Self-chains MUST use a PAT.');
    } else {
      console.log(`VERDICT: GITHUB-TOKEN-WOKE — ${fired.length} run(s) fired from a GITHUB_TOKEN dispatch (names: ${fired.map(x => x.name).join('; ')}) — see the verify-hop log.`);
    }
    return;
  }

  if (VARIANT === 'gh-chain') {
    // chain using the EPHEMERAL job token (the X1a finding applied: same-repo
    // self-chains need no PAT)
    if (N >= MAX) {
      console.log(`CHAIN-COMPLETE (gh-token) reached max=${MAX} hops — continuity via GITHUB_TOKEN self-dispatch WORKS at this scale.`);
      return;
    }
    const r = await api(`/repos/${REPO}/dispatches`, 'POST', {
      event_type: 'chain-probe-next',
      client_payload: { n: N + 1, max: MAX, variant: 'gh-chain' },
    }, GH_TOKEN);
    console.log(`GH-TOKEN dispatch (n=${N + 1}) HTTP=${r.status}`);
    if (r.status !== 204) process.exitCode = 2;
    return;
  }

  // variant=pat: chain until max
  if (N >= MAX) {
    console.log(`CHAIN-COMPLETE reached max=${MAX} hops — continuity via PAT self-dispatch WORKS at this scale.`);
    return;
  }
  const r = await api(`/repos/${REPO}/dispatches`, 'POST', {
    event_type: 'chain-probe-next',
    client_payload: { n: N + 1, max: MAX, variant: 'pat' },
  });
  console.log(`PAT dispatch (n=${N + 1}) HTTP=${r.status}`);
  if (r.status !== 204) process.exitCode = 2;
}

main().catch(e => { console.error('HOP-FAILED:', e.message); process.exitCode = 1; });
