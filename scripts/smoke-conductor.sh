#!/usr/bin/env bash
# smoke-conductor.sh — local end-to-end smoke of the REAL conductor adapter
# (conductor/turn.mjs -> lib/conductor-core.mjs -> lib/store.mjs) against a
# local bare origin. Adapted from the T44 pre-push smoke (44-h probe 4) with
# three more cases (T44 wave 3):
#   1. halted chain + zombie reports  -> ONE drain commit, then QUIESCED
#   2. RUNNING chain wake             -> drain + ASSIGNs + dispatch-fail
#                                        TOLERATED (commit-before-act: the
#                                        dispatch layer can die; state is
#                                        truth; rc!=0 expected + tolerated)
#   3. corrupt state.json on the tip  -> RECOVERY record + commit (history
#                                        walk heals the branch)
#   4. direct control pause + QUEUED resume control -> applied + resumed
#                                        (control-first drain, one commit)
#
# Offline dispatch failures: NODE_USE_ENV_PROXY=1 + a dead proxy port makes
# every api.github.com call fail in ~12ms (ECONNREFUSED) — without it a bogus
# token gets a real 401 and the Retry-After ladder sleeps ~20s per dispatch.
# If NODE_USE_ENV_PROXY is unsupported (node < 24), the smoke still works but
# dispatch-failing wakes take minutes. No token, no network dependency for
# the ASSERTIONS (git state only).
#
# Usage: bash scripts/smoke-conductor.sh   (from the repo root or anywhere)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d /tmp/fsm-smoke-XXXXXX)
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9
export GITHUB_REPOSITORY=local/test GH_TOKEN=bogus OPS_ISSUE=1
PASS=0; FAIL=0
ok()   { echo "SMOKE-OK   $1"; PASS=$((PASS+1)); }
bad()  { echo "SMOKE-FAIL $1"; FAIL=$((FAIL+1)); }
trap 'rm -rf "$WORK"' EXIT

mkclone() { # mkclone <name> -> echoes the clone dir
  local name=$1
  git init --bare -b main "$WORK/$name-origin.git" -q
  git init -b main "$WORK/$name-seed" -q
  ( cd "$WORK/$name-seed" && echo x > README.md && git add . \
    && git -c user.name=t -c user.email=t@t.invalid commit -qm seed \
    && git push -q "$WORK/$name-origin.git" main )
  git clone -q "$WORK/$name-origin.git" "$WORK/$name-clone"
  cp -r "$ROOT/lib" "$ROOT/conductor" "$WORK/$name-clone/"
  echo "$WORK/$name-clone"
}
tip() { git -C "$1" ls-remote origin refs/heads/fsm-state | cut -f1; }

# node helper: run a snippet inside a clone (cwd = clone, repo modules in .)
nodein() { ( cd "$1" && node --input-type=module -e "$2" ); }

echo "== CASE 1: halted chain + 3 zombie reports (drain commit, then quiesce) =="
C1=$(mkclone c1)
nodein "$C1" "
import { genesis } from './lib/fsm.mjs';
import { fastProject } from './lib/mock-project.mjs';
const g = genesis({ config: { max_parallel: 4, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-smoke1', now: '2026-09-06T11:00:00Z' });
g.chain.halted = true; g.project.phase = 'done';
for (const t of Object.values(g.tasks)) { t.status = 'done'; }
g.stats.done = Object.keys(g.tasks).length;
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() });
st.init(g); st.fetch();
for (let i = 0; i < 3; i++) st.enqueueReport({ event_id: 'rep-zombie-' + i, task: 'GHOST-' + i, lease: 'tok', outcome: { status: 'done', artifact: 'z' + i }, run_id: 'r' + i });
console.log('SETUP: halted state + 3 zombie reports enqueued');
" || bad "c1 setup"
T0=$(tip "$C1" c1-origin.git)
( cd "$C1" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s1-w1 node conductor/turn.mjs; echo "wake1 rc=$?" )
T1=$(tip "$C1" c1-origin.git)
[ "$T1" != "$T0" ] && ok "c1 wake1: drain COMMIT (tip advanced — zombies consumed)" || bad "c1 wake1: no commit"
QL=$(git -C "$C1" ls-tree origin/fsm-state --name-only 2>/dev/null | grep -c reports-queue || true)
git -C "$C1" fetch -q c1-origin.git fsm-state 2>/dev/null || git -C "$C1" fetch -q origin fsm-state
( cd "$C1" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const bad = st.readQueueEx();
const tail = st.readJournalTail(30);
const rej = tail.filter(j => j.kind === 'REJECTED' && j.reason === 'unknown-task').length;
console.log(JSON.stringify({ queueItems: bad.items.length, rejected: rej }));
" ) > "$WORK/c1-check.json"
grep -q '"queueItems":0' "$WORK/c1-check.json" && grep -q '"rejected":3' "$WORK/c1-check.json" \
  && ok "c1 wake1: queue EMPTIED + 3 journaled rejects" || bad "c1 wake1: queue/journal wrong ($(cat "$WORK/c1-check.json"))"
( cd "$C1" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s1-w2 node conductor/turn.mjs; echo "wake2 rc=$?" )
T2=$(tip "$C1" c1-origin.git)
[ "$T2" = "$T1" ] && ok "c1 wake2: QUIESCED (tip frozen — no commit, no self-dispatch)" || bad "c1 wake2: tip moved"

echo
echo "== CASE 2: RUNNING chain wake (assign + report drain + dispatch-fail tolerated) =="
C2=$(mkclone c2)
T0=$(tip "$C2" c2-origin.git)
( cd "$C2" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s2-w1 node conductor/turn.mjs; echo "wakeA rc=$? (dispatch death post-commit: TOLERATED)" )
T1=$(tip "$C2" c2-origin.git)
[ "$T1" != "$T0" ] && ok "c2 wakeA: bootstrap+tick COMMIT (tip advanced despite the dispatch crash)" || bad "c2 wakeA: no commit"
( cd "$C2" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const { state } = st.readState();
const assigned = Object.values(state.tasks).filter(t => t.status === 'assigned');
if (!assigned.length) { console.error('no assigned task'); process.exit(1); }
const t = assigned[0];
const r = st.enqueueReport({ event_id: 'rep-smoke-2', task: t.id, lease: t.lease.token, outcome: { status: 'done', artifact: 'a' }, run_id: 'smoke-2' });
console.log('SETUP: report enqueued for', t.id, r.ok);
" ) || bad "c2 report enqueue"
( cd "$C2" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s2-w2 node conductor/turn.mjs; echo "wakeB rc=$? (TOLERATED)" )
( cd "$C2" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const { state } = st.readState();
const tail = st.readJournalTail(30);
console.log(JSON.stringify({ done: state.stats.done, assigned: Object.values(state.tasks).filter(t => t.status === 'assigned').length, reportRecs: tail.filter(j => j.kind === 'REPORT').length, assignRecs: tail.filter(j => j.kind === 'ASSIGN').length }));
" ) > "$WORK/c2-check.json"
grep -q '"done":1' "$WORK/c2-check.json" && grep -q '"reportRecs":[1-9]' "$WORK/c2-check.json" \
  && ok "c2 wakeB: queued report DRAINED + applied (journal REPORT record, done=1)" || bad "c2 wakeB: $(cat "$WORK/c2-check.json")"
T2=$(tip "$C2" c2-origin.git)
[ "$T2" != "$T1" ] && ok "c2 wakeB: drain COMMIT (tip advanced)" || bad "c2 wakeB: no commit"

echo
echo "== CASE 3: corrupt state.json tip -> RECOVERY record + healing commit =="
C3=$(mkclone c3)
nodein "$C3" "
import { genesis } from './lib/fsm.mjs';
import { fastProject } from './lib/mock-project.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const g = genesis({ config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-smoke3', now: '2026-09-06T11:00:00Z' });
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() });
st.init(g); st.fetch();
// corrupt the tip's state.json via a direct plumbing commit (the F4-class damage)
const head = st.headSha();
const dir = mkdtempSync(join(tmpdir(), 'fsm-corrupt-'));
try {
  writeFileSync(join(dir, 'state.json'), 'THIS IS NOT JSON');
  const c = st.buildCommit([[join(dir, 'state.json'), 'state/state.json']], [], head, 'corrupt the tip');
  st.git(['push', 'origin', c + ':refs/heads/fsm-state']);
  console.log('SETUP: tip corrupted');
} finally { rmSync(dir, { recursive: true, force: true }); }
" || bad "c3 setup"
T0=$(tip "$C3" c3-origin.git)
( cd "$C3" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s3-w1 node conductor/turn.mjs; echo "wake rc=$? (TOLERATED)" )
T1=$(tip "$C3" c3-origin.git)
[ "$T1" != "$T0" ] && ok "c3: RECOVERY commit (tip advanced — repair forced)" || bad "c3: no commit"
( cd "$C3" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const { state, corrupt } = st.readState();
const tail = st.readJournalTail(30);
console.log(JSON.stringify({ corrupt: !!corrupt, hasState: !!state, recovery: tail.filter(j => j.kind === 'RECOVERY').map(j => j.reason) }));
" ) > "$WORK/c3-check.json"
grep -q '"corrupt":false' "$WORK/c3-check.json" && grep -q '"hasState":true' "$WORK/c3-check.json" && grep -q '"recovery":\["history-walk"\]' "$WORK/c3-check.json" \
  && ok "c3: state.json HEALED + RECOVERY(history-walk) journaled" || bad "c3: $(cat "$WORK/c3-check.json")"

echo
echo "== CASE 4: direct control pause + QUEUED resume control -> applied + resumed =="
C4=$(mkclone c4)
nodein "$C4" "
import { genesis } from './lib/fsm.mjs';
import { fastProject } from './lib/mock-project.mjs';
const g = genesis({ config: { max_parallel: 2, lease_minutes: 4, max_attempts: 3, tick_min_interval_s: 0, dedup_window: 300 }, project: { tasks: fastProject().m1, milestones: 2 }, chainId: 'c-smoke4', now: '2026-09-06T11:00:00Z' });
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() });
st.init(g);
console.log('SETUP: running genesis');
" || bad "c4 setup"
T0=$(tip "$C4" c4-origin.git)
( cd "$C4" && EVENT='{"action":"fsm-control","client_payload":{"command":"pause"}}' GITHUB_RUN_ID=s4-w1 node conductor/turn.mjs; echo "pause rc=$?" )
( cd "$C4" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const { state } = st.readState();
console.log('paused=' + state.chain.paused);
" ) | grep -q 'paused=true' && ok "c4: direct CONTROL pause applied (chain held)" || bad "c4: pause not applied"
( cd "$C4" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const r = st.enqueueControl({ cmd: 'resume', id: 'ctl-resume-smoke', ts: new Date().toISOString(), note: 'smoke' });
console.log('SETUP: resume control queued', r.ok);
" ) || bad "c4 resume enqueue"
T1=$(tip "$C4" c4-origin.git)
( cd "$C4" && EVENT='{"schedule":"* * * * *"}' GITHUB_RUN_ID=s4-w2 node conductor/turn.mjs; echo "resume wake rc=$? (TOLERATED)" )
T2=$(tip "$C4" c4-origin.git)
[ "$T2" != "$T1" ] && ok "c4: resume-wake COMMIT (tip advanced)" || bad "c4: no commit"
( cd "$C4" && node --input-type=module -e "
const { Store } = await import('./lib/store.mjs');
const st = new Store({ cwd: process.cwd() }); st.fetch();
const { state } = st.readState();
const tail = st.readJournalTail(30);
const ctl = tail.find(j => j.kind === 'CONTROL' && j.command === 'resume');
const tick = tail.find(j => j.kind === 'TICK');
console.log(JSON.stringify({ paused: state.chain.paused, resumeRec: !!ctl, tickRec: !!tick, first: tail[0]?.kind }));
" ) > "$WORK/c4-check.json"
grep -q '"paused":false' "$WORK/c4-check.json" && grep -q '"resumeRec":true' "$WORK/c4-check.json" && grep -q '"tickRec":true' "$WORK/c4-check.json" \
  && ok "c4: queued RESUME applied (control-first) + the wake TICK applied (resumed)" || bad "c4: $(cat "$WORK/c4-check.json")"

echo
echo "== SMOKE-RESULT: $PASS ok, $FAIL fail =="
[ "$FAIL" -eq 0 ] && echo "SMOKE-PASS" || { echo "SMOKE-FAIL"; exit 1; }
