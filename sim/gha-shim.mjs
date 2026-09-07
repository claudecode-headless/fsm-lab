// gha-shim.mjs — the GitHub-Actions SEMANTICS shim (T44/F16).
//
// run-sim.mjs mocks GHA away ENTIRELY — which is exactly why the five
// live-caught bug classes were invisible locally: the substrate's physics
// (concurrency-group newest-wins cancellation, dispatch->run latency,
// payload shapes) are the failure surface. This shim models the three
// load-bearing GHA semantics the lab actually depends on:
//
//   ConcurrencyGroup — the workflow `concurrency:` block:
//     depth-1 pending + newest-wins-cancel + ~24s cancel propagation
//     (the live observation). Models the lossiness that killed run-per-
//     report and direct-control dispatches (live bugs #2/#4).
//
//   DispatchLane — the repository_dispatch POST -> run-start latency
//     (live-measured 2m44s = 164s, X5), optional drop probability, and
//     the 403-without-Retry-After fail-fast shape (the F6 ladder's inputs).
//
// All classes run on an injected virtual clock ({ now(), advance(ms),
// get ms }) — the sim never sleeps; wall-clock time is only measured.
//
// Determinism: DispatchLane's jitter and drop use an injectable rng
// (default Math.random; sim scenarios inject mulberry32(seed) for
// byte-reproducible runs).

// --- deterministic rng (seeded; scenarios pin it for repro) ---------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// ConcurrencyGroup — the workflow concurrency block, live-configured as
//   concurrency: { group: fsm-conductor, cancel-in-progress: false }
//
// MODEL (documented semantics, matching the live physics):
//   - ONE running run + ONE pending (queued) run — depth-1 pending.
//   - newest-wins: a submit while a run is pending EVICTS the pending run
//     (the loss is decided at submit: an evicted run can never start);
//     the OFFICIAL cancel lands on tick() after cancelPropagationMs (the
//     live ~24s lag between decision and the run showing "cancelled").
//   - submit while something is running: the new run is queued -> 'queued'.
//   - submit to an empty group: the run starts now -> 'started'.
//   - cancelInProgress=true: a new submit ALSO cancels a RUNNING run (marked
//     at submit, effective after the propagation delay on tick(); if the
//     run completes first, the cancel missed — the race is real).
//   - runs are { id, name, startedAt, runsAt, durationMs, ...runSpec } —
//     the caller's runSpec fields ride along (the sim stores its wake
//     event there). durationMs (default 60s) is the run's wall duration:
//     completion fires on tick() at startedAt + durationMs.
//
// tick() returns the transitions that just became effective:
//   [{ type: 'started', run } | { type: 'completed', run }
//    | { type: 'cancelled', run, why }]  — the driver's event loop food.
export class ConcurrencyGroup {
  constructor({ name = 'fsm-conductor', cancelInProgress = false, cancelPropagationMs = 24_000, clock } = {}) {
    if (!clock) throw new Error('ConcurrencyGroup: a virtual clock is required ({ now, advance, ms })');
    this.name = name;
    this.cancelInProgress = cancelInProgress;        // live conductor.yml: false
    this.cancelPropagationMs = cancelPropagationMs;  // live-observed ~24s
    this.clock = clock;
    this.running = null;   // the in-flight run
    this.pending = null;   // the single queued run (depth-1)
    this.doomed = [];      // evicted runs awaiting their official cancel
    this.cancelled = [];   // officially cancelled (audit)
    this.completed = [];   // finished normally (audit)
    this.submitted = [];   // every submit ever (audit)
    this._events = [];     // submit-time transitions, drained by tick()
  }

  submit(runSpec) {
    const run = {
      id: runSpec.id ?? `run-${this.submitted.length + 1}`,
      name: runSpec.name ?? 'run',
      startedAt: null,   // set when the run actually starts
      runsAt: null,      // same as startedAt (kept for the documented shape)
      durationMs: runSpec.durationMs ?? 60_000,
      ...runSpec,
    };
    this.submitted.push(run);
    if (this.pending) {
      // newest-wins: the eviction is decided NOW; the official cancel lands
      // on tick() after the propagation delay
      this.pending.cancelAt = this.clock.ms + this.cancelPropagationMs;
      this.pending.cancelWhy = 'superseded';
      this.doomed.push(this.pending);
      this.pending = run;
      this._markRunningForCancel();
      return 'superseded';
    }
    if (this.running) {
      this.pending = run;
      this._markRunningForCancel();
      return 'queued';
    }
    run.startedAt = this.clock.ms;
    run.runsAt = run.startedAt;
    this.running = run;
    // an immediately-started run reports its transition through the same
    // tick() channel as promotions (one uniform event stream for the driver)
    this._events.push({ type: 'started', run });
    return 'started';
  }

  _markRunningForCancel() {
    if (this.cancelInProgress && this.running && this.running.cancelAt == null) {
      this.running.cancelAt = this.clock.ms + this.cancelPropagationMs;
      this.running.cancelWhy = 'cancel-in-progress';
    }
  }

  tick() {
    const t = this.clock.ms;
    const events = this._events;
    this._events = [];
    // the running run: cancel (wins ties — checked first) or complete
    if (this.running && this.running.cancelAt != null && t >= this.running.cancelAt) {
      this.cancelled.push(this.running);
      events.push({ type: 'cancelled', run: this.running, why: this.running.cancelWhy });
      this.running = null;
    } else if (this.running && this.running.cancelAt == null && t >= this.running.startedAt + this.running.durationMs) {
      this.completed.push(this.running);
      events.push({ type: 'completed', run: this.running });
      this.running = null;
    }
    // evicted pendings: their cancel becomes official
    this.doomed = this.doomed.filter(d => {
      if (t >= d.cancelAt) {
        this.cancelled.push(d);
        events.push({ type: 'cancelled', run: d, why: d.cancelWhy });
        return false;
      }
      return true;
    });
    // promote the pending run (evicted runs are out of the slot already —
    // they can never be promoted; that IS the loss being modeled)
    if (!this.running && this.pending) {
      const r = this.pending;
      this.pending = null;
      r.startedAt = t;
      r.runsAt = t;
      this.running = r;
      events.push({ type: 'started', run: r });
    }
    return events;
  }

  // the earliest virtual time at which tick() would do something (the
  // driver's event loop advances here); null = nothing pending in time
  nextTickAt() {
    const cands = [];
    if (this.running && this.running.cancelAt != null) cands.push(this.running.cancelAt);
    else if (this.running) cands.push(this.running.startedAt + this.running.durationMs);
    for (const d of this.doomed) cands.push(d.cancelAt);
    return cands.length ? Math.min(...cands) : null;
  }
}

// ---------------------------------------------------------------------------
// DispatchLane — the POST /repos/:repo/dispatches -> run-start physics.
//
//   send(eventType, clientPayload) -> { ok: true, willRunAt, eventType }
//                                   | { ok: false, status: 403, fatal: true }   (403-no-Retry-After)
//                                   | { ok: false, status: 0, dropped: true }   (transport loss)
//
//   latencyMs   dispatch->run-start (default 164s: the live 2m44s X5 datum)
//   jitter      ± fraction on the latency (default 0.2 — the live spread)
//   dropP       probability the dispatch POST is lost entirely
//   forbidden   every send fails with the 403-no-Retry-After shape (the
//               permission-problem class: dispatchRetry fails fast on it)
//   rng         injectable (mulberry32(seed)) for determinism
//
// willRunAt is the virtual time at which the dispatched workflow run would
// START — the driver schedules the wake arrival there. NOTE: the lane
// models ONE dispatch attempt; the retry LADDER is the conductor's
// dispatchRetry (live code) — the two compose.
export class DispatchLane {
  constructor({ clock, latencyMs = 164_000, dropP = 0, jitter = 0.2, rng = Math.random, forbidden = false } = {}) {
    if (!clock) throw new Error('DispatchLane: a virtual clock is required ({ now, advance, ms })');
    this.clock = clock;
    this.latencyMs = latencyMs;
    this.dropP = dropP;
    this.jitter = jitter;
    this.rng = rng;
    this.forbidden = forbidden;
    this.sent = [];   // audit: every send
  }

  send(eventType, clientPayload) {
    // the 403-no-Retry-After class: a permission problem — fail fast, no
    // retry (dispatchRetry's fatal lane)
    if (this.forbidden) {
      return { ok: false, status: 403, fatal: true, retryAfter: null, eventType };
    }
    // transport loss: the dispatch POST vanishes (no run ever starts)
    if (this.dropP > 0 && this.rng() < this.dropP) {
      return { ok: false, status: 0, dropped: true, eventType };
    }
    const lat = this.latencyMs * (1 + (this.rng() * 2 - 1) * this.jitter);
    const willRunAt = this.clock.ms + Math.max(0, Math.round(lat));
    this.sent.push({ eventType, at: this.clock.ms, willRunAt, clientPayload });
    return { ok: true, willRunAt, eventType };
  }
}
