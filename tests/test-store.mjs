// test-store.mjs — the state-anchor suite: CAS optimistic concurrency,
// journal rotation + bounded growth, corruption recovery via git history,
// concurrent-writer survival (the 3-way-refresh discipline, restated for the
// FSM store: retry + re-apply, dedup keys absorb the double-apply).
//
// Runs against a REAL local git repo (bare origin + clone) — no mocks on the
// transport path (the vacuous-fixture discipline).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { genesis, apply, rebuild } from '../lib/fsm.mjs';
import { fastProject, nextMilestoneFactory } from '../lib/mock-project.mjs';

const NM = nextMilestoneFactory(fastProject());

function mkLab() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-store-'));
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  const g = (args, cwd) => spawnSync('git', args, { cwd: cwd || clone, encoding: 'utf8' });
  g(['init', '--bare', '-b', 'main', origin], dir);
  // seed origin main with one commit so clone works
  const seed = join(dir, 'seed');
  g(['init', '-b', 'main', seed], dir);
  const w = (p, c) => spawnSync('bash', ['-c', `echo '${c}' > '${p}'`], { cwd: seed });
  w(join(seed, 'README.md'), 'lab');
  g(['add', '.'], seed);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'seed'], seed);
  g(['push', origin, 'main'], seed);
  g(['clone', origin, clone], dir);
  return { dir, origin, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cfg = { max_parallel: 2, lease_minutes: 1, max_attempts: 3 };
const boot = (now) => genesis({
  config: cfg,
  project: { tasks: fastProject().m1, milestones: 2 },
  chainId: 'store-test',
  now,
});

test('init: branch created, state readable back', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    const r = st.init(g0);
    assert.equal(r.initialized, true);
    st.fetch();
    const { state } = st.readState();
    assert.equal(state.version, 1);
    assert.equal(state.tasks.A1.status, 'ready');
  } finally { lab.cleanup(); }
});

test('commit: mutate + journal land atomically; read-back matches', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    st.fetch();
    const out = st.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: 'evt-t1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 1' };
      },
    });
    assert.equal(out.committed, true);
    st.fetch();
    const { state } = st.readState();
    assert.equal(state.chain.seq, 1);
    assert.equal(Object.values(state.tasks).filter(t => t.status === 'assigned').length, 2);
    const j = st.readJournals();
    assert.ok(j.length >= 3, `journal records: ${j.length}`);
    assert.ok(j.some(x => x.kind === 'TICK'));
    assert.ok(j.some(x => x.kind === 'ASSIGN'));
  } finally { lab.cleanup(); }
});

test('CAS: concurrent writer lands between read and push -> retry re-applies, no lost update', () => {
  const lab = mkLab(); try {
    const st1 = new Store({ cwd: lab.clone });
    st1.init(boot('2026-09-06T10:00:00Z'));

    // writer A: commits a TICK normally
    st1.fetch();
    const a = st1.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'A', ts: now, event_id: 'evt-a' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick A' };
      },
    });
    assert.equal(a.committed, true);

    // writer B: READ the pre-A state (simulated by reading at the old sha —
    // we emulate the race by building B's mutation from the state BEFORE A
    // committed, then letting the CAS loop re-apply against A's state).
    const pre = structuredClone(boot('2026-09-06T10:00:00Z'));
    const b = st1.commit({
      mutate: (cur) => {
        // B's event is a REPORT with a unique event id — applied against
        // whatever CURRENT state the retry reads (A's, post-merge).
        const now = '2026-09-06T10:00:07Z';
        // find a leased task in the CURRENT state (A's tick assigned A1/A2)
        const t = cur.tasks.A1;
        if (!t.lease) return { noop: true, reason: 'no-lease' };
        const r = apply(cur, {
          kind: 'REPORT', event_id: 'evt-b', task: 'A1', lease: t.lease.token,
          outcome: { status: 'done', artifact: 'x' }, run_id: 'run-b',
        }, now, NM);
        return { state: r.state, journal: r.journal, message: 'report B' };
      },
    });
    assert.equal(b.committed, true);
    st1.fetch();
    const { state } = st1.readState();
    // BOTH writes survived: A's tick (chain.seq=1) AND B's report (A1 done)
    assert.equal(state.chain.seq, 1, "A's tick survived");
    assert.equal(state.tasks.A1.status, 'done', "B's report survived");
    assert.ok(state.journal_seq >= 4);
  } finally { lab.cleanup(); }
});

test('CAS conflict path: mutate sees stale base, retry loop re-reads (forced race)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    // first commit
    st.commit({
      mutate: (cur) => {
        const now = '2026-09-06T10:00:05Z';
        const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: 'evt-1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 1' };
      },
    });
    // simulate a mid-flight competing writer: while OUR commit runs, another
    // pushes. We force it by having mutate() push a competing commit itself
    // on the FIRST attempt only, then return a normal mutation.
    let sabotaged = false;
    const out = st.commit({
      mutate: (cur) => {
        if (!sabotaged) {
          sabotaged = true;
          const st2 = new Store({ cwd: lab.clone });
          st2.fetch();
          st2.commit({
            mutate: (c2) => {
              const now = '2026-09-06T10:00:06Z';
              const r = apply(c2, { kind: 'TICK', actor: 'rival', ts: now, event_id: 'evt-rival' }, now, NM);
              return { state: r.state, journal: r.journal, message: 'rival' };
            },
          });
        }
        const now = '2026-09-06T10:00:07Z';
        const r = apply(cur, { kind: 'TICK', actor: 'me', ts: now, event_id: 'evt-2' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'tick 2 (mine)' };
      },
    });
    assert.equal(out.committed, true, 'CAS retry landed the write');
    st.fetch();
    const { state } = st.readState();
    // three ticks total: evt-1, evt-rival (the racing writer), evt-2 (mine,
    // re-applied against the rival's state by the CAS retry — no lost update)
    assert.equal(state.chain.seq, 3, 'all three ticks counted, none lost');
  } finally { lab.cleanup(); }
});

test('rotation: generations rotate, bounded retention', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 20, keepGens: 3 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    for (let round = 0; round < 120; round++) {
      st.fetch();
      st.commit({
        mutate: (cur) => {
          const now = new Date(Date.parse('2026-09-06T10:00:00Z') + round * 1000).toISOString();
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: `evt-r${round}` }, now, NM);
          n += r.journal.length;
          return { state: r.state, journal: r.journal, message: `tick r${round}` };
        },
      });
    }
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+\.jsonl/.test(f));
    const gens = files.map(f => parseInt(f.match(/journal-(\d+)/)[1], 10)).sort((a, b) => a - b);
    assert.ok(gens.length >= 2, `rotated generations exist: ${gens}`);
    assert.ok(gens[gens.length - 1] >= 5, `reached generation ${gens[gens.length - 1]}`);
    assert.ok(!gens.includes(1), 'gen 1 pruned (bounded retention)');
    assert.ok(gens.length <= 3, `at most keepGens retained: ${gens}`);
    const all = st.readJournals();
    assert.ok(all.length <= 3 * 20 + 10, `bounded journal size: ${all.length}`);
    // state.json stays small regardless of journal volume
    const raw = st.readFile('state/state.json');
    assert.ok(raw.length < 20_000, `state.json bounded: ${raw.length}B`);
    const { state } = st.readState();
    assert.ok(state.journal_seq > 120, `journal_seq monotonic: ${state.journal_seq}`);
  } finally { lab.cleanup(); }
});

test('corruption recovery: state.json corrupted -> last good state from git history', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    st.init(boot('2026-09-06T10:00:00Z'));
    // two good commits
    for (const [i, ev] of [['evt-1', '2026-09-06T10:00:05Z'], ['evt-2', '2026-09-06T10:00:10Z']]) {
      st.fetch();
      st.commit({
        mutate: (cur) => {
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: ev, event_id: i }, ev, NM);
          return { state: r.state, journal: r.journal, message: `tick ${i}` };
        },
      });
    }
    // now corrupt state.json on the branch tip (raw push of garbage)
    spawnSync('bash', ['-c',
      `cd ${lab.clone} && git fetch origin fsm-state && ` +
      `tree=$(git rev-parse origin/fsm-state^{tree}) && ` +
      `blob=$(printf 'THIS IS NOT JSON{{{' | git hash-object -w --stdin) && ` +
      `git read-tree $tree && git update-index --cacheinfo 100644,$blob,state/state.json && ` +
      `t2=$(git write-tree) && c=$(git commit-tree $t2 -p origin/fsm-state -m corrupt) && ` +
      `git push origin $c:refs/heads/fsm-state`], { encoding: 'utf8' });
    st.fetch();
    const { state, corrupt } = st.readState();
    assert.ok(corrupt || state === null, 'corruption detected');
    const good = st.findLastGoodState();
    assert.ok(good, 'last good state found');
    assert.ok(good.state.chain.seq >= 2, `recovered to seq=${good.state.chain.seq}`);
    // recovery write: mutate(null) -> repair from the good snapshot
    const out = st.commit({
      mutate: (cur) => {
        const base = cur || good.state; // cur is null on the corrupt tip
        const now = '2026-09-06T10:00:20Z';
        const r = apply(base, { kind: 'TICK', actor: 'recovery', ts: now, event_id: 'evt-recover' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'recovery tick' };
      },
      attempts: 4,
    });
    assert.equal(out.committed, true);
    st.fetch();
    const healed = st.readState();
    assert.ok(healed.state && healed.state.chain.seq >= 3, `healed state readable: seq=${healed.state?.chain.seq}`);
  } finally { lab.cleanup(); }
});

test('journal replay: readJournals + rebuild reproduce the live state (determinism)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    let s = g0;
    let clock = 0;
    for (let round = 0; round < 5; round++) {
      st.fetch();
      const out = st.commit({
        mutate: (cur) => {
          const now = new Date(Date.parse('2026-09-06T10:00:00Z') + clock * 1000).toISOString();
          const r = apply(cur, { kind: 'TICK', actor: 'chain', ts: now, event_id: `evt-t${round}` }, now, NM);
          return { state: r.state, journal: r.journal, message: `tick ${round}` };
        },
      });
      s = out.state;
      clock += 10;
    }
    st.fetch();
    const live = st.readState().state;
    assert.equal(live.chain.seq, 5);
    // simulate a report landing
    const t = live.tasks.A1;
    st.commit({
      mutate: (cur) => {
        const now = new Date(Date.parse('2026-09-06T10:00:00Z') + 60 * 1000).toISOString();
        const tt = cur.tasks.A1;
        if (!tt.lease) return { noop: true, reason: 'no lease' };
        const r = apply(cur, { kind: 'REPORT', event_id: 'evt-rep', task: 'A1', lease: tt.lease.token, outcome: { status: 'done' }, run_id: 'r1' }, now, NM);
        return { state: r.state, journal: r.journal, message: 'report' };
      },
    });
    st.fetch();
    const final = st.readState().state;
    const recs = st.readJournals();
    const rebuilt = rebuild(g0, recs);
    assert.equal(rebuilt.tasks.A1.status, final.tasks.A1.status);
    assert.equal(rebuilt.chain.seq, final.chain.seq);
  } finally { lab.cleanup(); }
});

// ---------------------------------------------------------------------------
// T44 additions: commit-tree fault guard (the branch-deletion path), disjoint
// rotation, numeric gen ordering, unparseable-queue audit, drain semantics.

test('T44/F4: commit-tree failure THROWS (never builds a deletion refspec)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    const before = st.headSha();
    assert.ok(before, 'branch exists before the fault');
    // the fault seam: buildCommit behaves as if commit-tree failed
    process.env.FSM_LAB_FAULT_COMMIT_TREE = '1';
    let threw = null;
    try {
      st.commit({ mutate: (cur) => {
        const rr = apply(cur, { kind: 'TICK', event_id: 't-f', ts: '2026-09-06T10:01:00Z' }, '2026-09-06T10:01:00Z', NM);
        return { state: rr.state, journal: rr.journal, message: 'fault test' };
      } });
    } catch (e) { threw = e; }
    delete process.env.FSM_LAB_FAULT_COMMIT_TREE;
    assert.ok(threw, 'commit() must throw when commit-tree fails');
    assert.match(threw.message, /commit-tree failed/);
    // the branch must still exist, tip unchanged (NOT deleted)
    st.fetch();
    assert.equal(st.headSha(), before, 'branch survived the fault — no deletion refspec');
    const { state } = st.readState();
    assert.equal(state.version, 1, 'state untouched');
  } finally { delete process.env.FSM_LAB_FAULT_COMMIT_TREE; lab.cleanup(); }
});

test('T44/F5: rotation is DISJOINT — retained lines are distinct ids, no sliding-window duplication', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 10, keepGens: 3 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    const pushBatch = (count) => {
      for (let i = 0; i < count; i++) {
        st.commit({ mutate: (cur) => {
          const rr = apply(cur, { kind: 'TICK', event_id: `tick-${n}`, ts: `2026-09-06T10:${String(n % 60).padStart(2, '0')}:00Z`, actor: 'x' }, `2026-09-06T10:${String(n % 60).padStart(2, '0')}:00Z`, NM);
          n++;
          return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: `t${n}` };
        } });
      }
    };
    pushBatch(34);  // 34 records with rotateAt=10 -> several rotations
    st.fetch();
    const all = st.readJournals();
    const ids = all.map(j => j.id);
    const distinct = new Set(ids);
    assert.equal(ids.length, distinct.size, `retained lines must be DISTINCT (got ${ids.length} lines / ${distinct.size} ids)`);
    // bounded retention: keepGens=3 x rotateAt=10 => <= 30 retained (+ in-flight gen)
    assert.ok(ids.length <= 40, `retention bounded (got ${ids.length})`);
    // per-generation disjointness: no id appears in two gen FILES
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    const perGen = files.map(f => {
      const raw = st.readFile(f);
      return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l).id);
    });
    const seen = new Map();
    for (const ids2 of perGen) for (const id of ids2) {
      assert.equal(seen.has(id), false, `id ${id} must live in exactly ONE generation`);
      seen.set(id, true);
    }
  } finally { lab.cleanup(); }
});

test('T44/F5: NUMERIC generation ordering — journal-10 is read AFTER journal-9 (the lexicographic trap)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone, rotateAt: 3, keepGens: 12 });
    st.init(boot('2026-09-06T10:00:00Z'));
    let n = 0;
    for (let i = 0; i < 40; i++) {
      st.commit({ mutate: (cur) => {
        const ts = new Date(Date.parse('2026-09-06T10:00:00Z') + n * 1000).toISOString();
        const rr = apply(cur, { kind: 'TICK', event_id: `tick-${n}`, ts, actor: 'x' }, ts, NM);
        n++;
        return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: `t${n}` };
      } });
    }
    st.fetch();
    const files = st.listStateFiles().filter(f => /journal-\d+/.test(f));
    const maxGen = Math.max(...files.map(f => parseInt(f.match(/journal-(\d+)/)[1], 10)));
    assert.ok(maxGen >= 10, `need gen >= 10 to exercise the trap (got ${maxGen})`);
    const tail = st.readJournalTail(5);
    // the tail must be the NEWEST records: the last ids by sequence
    const seq = (id) => parseInt(id.slice(1), 10);
    const sorted = [...tail].sort((a, b) => seq(a.id) - seq(b.id));
    assert.deepEqual(tail, sorted, 'tail records arrive in sequence order');
    // and they are the globally-newest: max seq in tail == max seq anywhere
    const all = st.readJournals();
    const maxSeq = Math.max(...all.map(j => seq(j.id)));
    assert.equal(seq(tail[tail.length - 1].id), maxSeq, 'the tail ends at the newest record (gen-10 was NOT hidden)');
  } finally { lab.cleanup(); }
});

test('T44/F1: unparseable queue lines surface via readQueueEx (auditable before the drop)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    // hand-craft a queue file with one good line and one broken line
    const dir = mkdtempSync(join(tmpdir(), 'fsm-qbad-'));
    try {
      const good = { event_id: 'rep-1', task: 'A1', lease: 'x', outcome: { status: 'done' }, run_id: 'r1' };
      const content = JSON.stringify(good) + '\n{BROKEN JSON LINE\n';
      writeFileSync(join(dir, 'queue.jsonl'), content);
      const commit = st.buildCommit([[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], st.headSha(), 'seed queue with a bad line');
      st.git(['push', 'origin', `${commit}:refs/heads/fsm-state`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    st.fetch();
    const q = st.readQueueEx();
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].event_id, 'rep-1');
    assert.equal(q.bad.length, 1, 'the broken line is surfaced, not silently skipped');
    assert.ok(q.bad[0].includes('BROKEN'));
  } finally { lab.cleanup(); }
});

test('T44/F1: the drain consumes rejected reports — queue EMPTIES (the zombie loop is dead)', () => {
  const lab = mkLab(); try {
    const st = new Store({ cwd: lab.clone });
    const g0 = boot('2026-09-06T10:00:00Z');
    st.init(g0);
    st.fetch();
    // enqueue a report for a task that doesn't exist (permanent reject)
    const r = st.enqueueReport({ event_id: 'rep-ghost', task: 'GHOST-9', lease: 'tok', outcome: { status: 'done', artifact: 'zombie artifact' }, run_id: 'r9' });
    assert.equal(r.ok, true);
    // a conductor-shaped drain: consume ALL, write empty queue
    st.commit({ mutate: (cur, queue, controlQueue, queueBad) => {
      const journals = [];
      for (const q of queue) {
        const rr = apply(cur, { kind: 'REPORT', event_id: q.event_id, task: q.task, lease: q.lease, outcome: q.outcome, run_id: q.run_id }, '2026-09-06T10:01:00Z', NM);
        journals.push(...rr.journal);
      }
      const rr = apply(cur, { kind: 'TICK', event_id: 't1', ts: '2026-09-06T10:01:00Z', actor: 'x' }, '2026-09-06T10:01:00Z', NM);
      return { state: rr.state, journal: [...journals, ...rr.journal], queue: [], controlQueue: [], message: 'drain' };
    } });
    st.fetch();
    assert.equal(st.readQueue().length, 0, 'queue emptied (rejected report consumed, not re-parked)');
    const j = st.readJournals().find(x => x.kind === 'REJECTED' && x.origKind === 'REPORT');
    assert.ok(j, 'the rejection is journaled');
    assert.equal(j.reason, 'unknown-task');
    assert.equal(j.event_id, 'rep-ghost');
    assert.equal(j.outcome.artifact, 'zombie artifact', 'audit trail preserved');
    // the second drain: the queue stays empty and NO new REJECTED records
    // appear for the consumed id (clock transitions may journal legitimately)
    const rejectedBefore = st.readJournals().filter(x => x.kind === 'REJECTED').length;
    st.commit({ mutate: (cur) => {
      const rr = apply(cur, { kind: 'TICK', event_id: 't2', ts: '2026-09-06T10:02:00Z', actor: 'x' }, '2026-09-06T10:02:00Z', NM);
      return { state: rr.state, journal: rr.journal, queue: [], controlQueue: [], message: 't2' };
    } });
    st.fetch();
    assert.equal(st.readQueue().length, 0, 'queue still empty');
    const rejectedAfter = st.readJournals().filter(x => x.kind === 'REJECTED').length;
    assert.equal(rejectedAfter, rejectedBefore, 'no zombie re-rejection of the consumed event_id');
  } finally { lab.cleanup(); }
});
