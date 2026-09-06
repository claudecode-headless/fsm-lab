// store.mjs — the state anchor: a versioned JSON state + journal-rotation log
// on a dedicated git branch, written via plumbing (no checkout, no worktree).
//
// WHY GIT-AS-STATE-ANCHOR (the Task-43 decision, argued in ARCHITECTURE.md):
//  - CAS for free: push to an existing branch refuses non-FF -> optimistic
//    concurrency; retry = re-read + re-apply + re-push (dedup keys make the
//    re-apply idempotent). Survived the 5-writer wave in the prior track.
//  - History for free: every commit carries the FULL materialized state ->
//    corruption recovery = find the last parseable state.json in git log.
//  - Bounded growth by construction: state.json is OVERWRITTEN (never
//    appended); the journal rotates (N generations, pruned via commits).
//  - No TTL: branches don't expire (unlike artifacts, 90d) and are writable
//    from ephemeral runners with job-scoped credentials.
//
// THE PLUMBING WRITE (atomic per commit):
//   git read-tree <remote head>            (into a TEMP index — the runner's
//                                           main checkout is never touched)
//   git hash-object -w <file>              (new blobs)
//   git update-index --cacheinfo/--force-remove
//   tree   = git write-tree
//   commit = git commit-tree tree -p <head> -m "..."
//   git push origin commit:refs/heads/fsm-state    (non-FF = CAS failure)

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IDENTITY = {
  name: 'fsm-lab-bot',
  email: 'fsm-bot@fsm-lab.invalid', // RFC-2606: never maps to a real account
};

export class Store {
  // opts: {cwd, branch='fsm-state', remote='origin', repoName, rotateAt, keepGens}
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.branch = opts.branch || 'fsm-state';
    this.remote = opts.remote || 'origin';
    this.repoName = opts.repoName || 'fsm-lab';
    this.rotateAt = opts.rotateAt || 500;
    this.keepGens = opts.keepGens || 4;
    this.remoteRef = `refs/remotes/${this.remote}/${this.branch}`;
    this.pushRef = `refs/heads/${this.branch}`;
  }

  git(args, { acceptCodes = [] } = {}) {
    const r = spawnSync('git', args, {
      cwd: this.cwd, encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      },
    });
    if (r.status !== 0 && !acceptCodes.includes(r.status)) {
      throw new Error(`git ${args.join(' ')} failed rc=${r.status}: ${r.stderr?.slice(0, 400)}`);
    }
    return r;
  }

  refExists() {
    const r = this.git(['ls-remote', this.remote, `refs/heads/${this.branch}`], { acceptCodes: [128] });
    return (r.stdout || '').trim().length > 0;
  }

  fetch() {
    // Tolerate transient fetch failures — the remote-tracking ref can race
    // when multiple processes share one clone (X3 burst finding: 'cannot
    // lock ref'); the CAS loop's push (FF-only) is the correctness backstop,
    // so a failed fetch just means a stale view that the next push reject
    // will catch. Missing branch (bootstrap) is also acceptable.
    this.git(['fetch', this.remote, `+refs/heads/${this.branch}:${this.remoteRef}`], { acceptCodes: [1, 128] });
  }

  headSha() {
    const r = this.git(['rev-parse', '--verify', this.remoteRef], { acceptCodes: [128] });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  readFile(path) {
    const r = this.git(['show', `${this.remoteRef}:${path}`], { acceptCodes: [128] });
    return r.status === 0 ? r.stdout : null;
  }

  listStateFiles() {
    const r = this.git(['ls-tree', '--name-only', this.remoteRef, 'state/'], { acceptCodes: [128] });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map(x => x.trim()).filter(Boolean);
  }

  readState() {
    const raw = this.readFile('state/state.json');
    if (!raw) return { state: null, sha: this.headSha() };
    try {
      return { state: JSON.parse(raw), sha: this.headSha() };
    } catch {
      return { state: null, sha: this.headSha(), corrupt: true };
    }
  }

  readJournals() {
    const files = this.listStateFiles().filter(f => /^state\/journal-\d+\.jsonl$/.test(f));
    const out = [];
    for (const f of files.sort()) {
      const raw = this.readFile(f);
      if (!raw) continue;
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* torn tail line: skip */ }
      }
    }
    return out;
  }

  // init(genesisState): create the branch if absent.
  init(genesisState) {
    if (this.refExists()) return { initialized: false };
    this.fetch();
    const dir = mkdtempSync(join(tmpdir(), 'fsm-init-'));
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify(genesisState, null, 1) + '\n');
      const commit = this.buildCommit(
        [[join(dir, 'state.json'), 'state/state.json']],
        [], null, 'genesis v=1');
      this.git(['push', this.remote, `${commit}:${this.pushRef}`]);
      return { initialized: true, sha: commit };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // buildCommit(tmpDirs, mappings, parent, message)
  //   mappings: array of [srcAbsPath, branchPath] to add
  //   removes: array of branchPaths to remove (rotation pruning)
  //   parent: sha or null
  // Uses a TEMP index so the checked-out worktree is untouched.
  buildCommit(mappings, removes, parent, message) {
    const idx = mkdtempSync(join(tmpdir(), 'fsm-idx-'));
    const idxFile = join(idx, 'index');
    try {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: idxFile,
        GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      };
      const run = (args) => {
        const r = spawnSync('git', args, { cwd: this.cwd, encoding: 'utf8', env });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} rc=${r.status}: ${r.stderr?.slice(0, 300)}`);
        return r.stdout;
      };
      // start from the parent's tree (or an empty index for genesis)
      if (parent) run(['read-tree', parent]);
      else run(['read-tree', '--empty']);
      for (const [src, dest] of mappings) {
        const sha = run(['hash-object', '-w', src]).trim();
        run(['update-index', '--add', '--cacheinfo', `100644,${sha},${dest}`]);
      }
      for (const p of removes) {
        run(['update-index', '--force-remove', p]);
      }
      const tree = run(['write-tree']).trim();
      const pargs = parent ? ['-p', parent] : [];
      return spawnSync('git', ['commit-tree', tree, ...pargs, '-m', message], {
        cwd: this.cwd, encoding: 'utf8', env,
      }).stdout.trim();
    } finally {
      rmSync(idx, { recursive: true, force: true });
    }
  }

  // commit({mutate, message}) — CAS loop:
  //   mutate(currentState, journals) -> {state, journalRecords, message}
  // Retries up to attempts times on non-FF push (concurrent writer landed).
  commit({ mutate, message, attempts = 4 }) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      this.fetch();
      const head = this.headSha();
      const { state } = this.readState();
      // NOTE: state=null (corrupt/missing) is NOT fatal — mutate(null) is the
      // recovery path: the caller repairs from findLastGoodState()/journal.
      const out = mutate(state ? structuredClone(state) : null, this.readJournalTail(), this.readQueue(), this.readControlQueue());
      if (out.noop) return { committed: false, reason: out.reason, state, actions: out.actions || [] };
      const journalRecords = out.journal || [];
      const dir = mkdtempSync(join(tmpdir(), 'fsm-c-'));
      try {
        // rotation: current gen file + overflow into the next gen
        const rot = this.rotatePlan(journalRecords);
        const mappings = [];
        const removes = [];
        writeFileSync(join(dir, 'state.json'), JSON.stringify(out.state, null, 1) + '\n');
        mappings.push([join(dir, 'state.json'), 'state/state.json']);
        writeFileSync(join(dir, 'journal.jsonl'), rot.currentBlock.map(l => JSON.stringify(l)).join('\n') + '\n');
        mappings.push([join(dir, 'journal.jsonl'), `state/journal-${rot.gen}.jsonl`]);
        // the report queue: mutate may carry the SURVIVING queue lines
        // (drained tick) or an APPEND (worker) — out.queue drives the file
        if (Array.isArray(out.queue)) {
          if (out.queue.length > 0) {
            writeFileSync(join(dir, 'queue.jsonl'), out.queue.map(l => JSON.stringify(l)).join('\n') + '\n');
            mappings.push([join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']);
          } else {
            removes.push('state/reports-queue.jsonl');
          }
        } else if (out.queueAppend) {
          const merged = [...this.readQueue(), ...out.queueAppend];
          writeFileSync(join(dir, 'queue.jsonl'), merged.map(l => JSON.stringify(l)).join('\n') + '\n');
          mappings.push([join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']);
        }
        // control queue: same discipline (drained tick writes survivors)
        if (Array.isArray(out.controlQueue)) {
          if (out.controlQueue.length > 0) {
            writeFileSync(join(dir, 'ctl.jsonl'), out.controlQueue.map(l => JSON.stringify(l)).join('\n') + '\n');
            mappings.push([join(dir, 'ctl.jsonl'), 'state/control-queue.jsonl']);
          } else {
            removes.push('state/control-queue.jsonl');
          }
        }
        for (const dead of rot.remove) removes.push(dead);
        const commit = this.buildCommit(mappings, removes, head, out.message || message);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) {
          // carry the caller's extra fields (actions!) — the conductor
          // executes them AFTER the commit; losing them here would assign
          // leases that no worker ever serves (the live-caught bug)
          return { committed: true, sha: commit, state: out.state, journal: journalRecords, actions: out.actions || [], message: out.message };
        }
        lastErr = new Error(`CAS conflict (attempt ${i + 1}): ${(push.stderr || '').split('\n').filter(l => l.includes('!') || l.includes('rejected')).join(' ').slice(0, 200)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    throw lastErr || new Error('commit failed');
  }

  // The last `n` journal records currently on the branch (the active tail —
  // enough for dedup keys and rotation bookkeeping without full replay).
  // The report queue: workers CAS-append lines; the tick drains atomically.
  // Data flows through git; dispatches stay the WAKE mechanism only (the
  // concurrency-group depth-1 discovery made run-per-report lossy).
  readQueue() {
    const raw = this.readFile('state/reports-queue.jsonl');
    if (!raw) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* torn tail: skip */ }
    }
    return out;
  }

  // enqueueControl(rec) — the OPS side: CAS-append one line to the control
  // queue. The conductor's tick drains controls atomically (external
  // dispatches into the hot conductor group get newest-wins-cancelled —
  // the live discovery; controls ride git instead).
  enqueueControl(rec, { attempts = 5 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      this.fetch();
      const head = this.headSha();
      const cur = this.readControlQueue();
      const dir = mkdtempSync(join(tmpdir(), 'fsm-ctl-'));
      try {
        const merged = [...cur, rec];
        writeFileSync(join(dir, 'ctl.jsonl'), merged.map(l => JSON.stringify(l)).join('\n') + '\n');
        const commit = this.buildCommit(
          [[join(dir, 'ctl.jsonl'), 'state/control-queue.jsonl']], [], head,
          `control-queue +1 ${rec.cmd} ${rec.id}`);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) return { ok: true };
        lastErr = new Error(`control CAS conflict (attempt ${i + 1})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: false, err: String(lastErr) };
  }

  readControlQueue() {
    const raw = this.readFile('state/control-queue.jsonl');
    if (!raw) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { }
    }
    return out;
  }

  // enqueueReport(report) — the WORKER side: CAS-append one line.
  enqueueReport(report, { attempts = 5 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      this.fetch();
      const head = this.headSha();
      const cur = this.readQueue();
      const dir = mkdtempSync(join(tmpdir(), 'fsm-q-'));
      try {
        const merged = [...cur, report];
        writeFileSync(join(dir, 'queue.jsonl'), merged.map(l => JSON.stringify(l)).join('\n') + '\n');
        const commit = this.buildCommit(
          [[join(dir, 'queue.jsonl'), 'state/reports-queue.jsonl']], [], head,
          `report-queue +1 ${report.task} ${report.event_id}`);
        const push = this.git(['push', this.remote, `${commit}:${this.pushRef}`], { acceptCodes: [1, 128] });
        if (push.status === 0) return { ok: true };
        lastErr = new Error(`queue CAS conflict (attempt ${i + 1})`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: false, err: String(lastErr) };
  }

  // The last `n` journal records currently on the branch (the active tail —
  // enough for dedup keys and rotation bookkeeping without full replay).
  readJournalTail(n = 64) {
    const files = this.listStateFiles().filter(f => /^state\/journal-\d+\.jsonl$/.test(f)).sort();
    const out = [];
    for (const f of files.reverse()) {
      const raw = this.readFile(f);
      if (!raw) continue;
      const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
      for (const line of lines.reverse()) {
        try { out.push(JSON.parse(line)); } catch { }
        if (out.length >= n) break;
      }
      if (out.length >= n) break;
    }
    return out.reverse();
  }

  // Rotation plan: rotate_at records per generation, keep_gens retained.
  rotatePlan(newRecords) {
    const files = this.listStateFiles().filter(f => /^state\/journal-(\d+)\.jsonl$/.test(f));
    let gen = 1, tailLines = [];
    if (files.length > 0) {
      const gens = files.map(f => parseInt(f.match(/journal-(\d+)\.jsonl/)[1], 10)).sort((a, b) => a - b);
      gen = gens[gens.length - 1];
      const raw = this.readFile(`state/journal-${gen}.jsonl`);
      if (raw) tailLines = raw.split('\n').map(s => s.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    const ROTATE_AT = this.rotateAt;
    const merged = [...tailLines, ...newRecords];
    if (merged.length <= ROTATE_AT) {
      return { gen, currentBlock: merged, remove: [] };
    }
    // rotate: new generation gets the overflow; prune beyond keepGens
    gen += 1;
    const currentBlock = merged.slice(merged.length - Math.min(merged.length, ROTATE_AT));
    const keep = this.keepGens;
    const allGens = [...files.map(f => parseInt(f.match(/journal-(\d+)\.jsonl/)[1], 10)), gen].sort((a, b) => a - b);
    const remove = allGens.filter(g => g <= gen - keep).map(g => `state/journal-${g}.jsonl`);
    return { gen, currentBlock, remove };
  }

  // findLastGoodState(): walk git log of the branch for the most recent
  // commit whose state/state.json parses. Returns {state, sha} | null.
  findLastGoodState() {
    let sha = this.headSha();
    for (let i = 0; i < 200 && sha; i++) {
      const r = this.git(['show', `${sha}:state/state.json`], { acceptCodes: [128] });
      if (r.status === 0) {
        try {
          return { state: JSON.parse(r.stdout), sha };
        } catch { /* keep walking */ }
      }
      const p = this.git(['rev-parse', `${sha}^`], { acceptCodes: [128] });
      sha = p.status === 0 ? p.stdout.trim() : null;
    }
    return null;
  }

  // journalRecordsAfter(sha): all journal records from commits strictly after
  // the given sha (for the corruption-recovery replay path).
  journalRecordsAfter(sha) {
    // collect every journal line ever (bounded by rotation window) — sufficient
    // because recovery replay only needs the recent window; older generations
    // were already folded into the snapshot at that sha.
    return this.readJournals();
  }
}
