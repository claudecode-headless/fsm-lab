# X22 Status Report

This proof covers the X22 worker-turn execution on the `fsm-state` chain (c-1789457940180, seq 168, halted — the T46 drill epoch, 2026-09-15). The turn was dispatched under the worker-turn contract (T46/W-B) with a `mock`-mode envelope, and the outcome was recorded as a `work_failed` class report: the work was attempted and failed, burning one attempt against the task's budget. The report id is attempt-scoped (`rep-<run>-a<attempt>`) so it is not dedup-swallowed on any re-run, and the write-back door confined all artifacts to declared paths.

## Next steps

1. Re-dispatch X22 with a fresh attempt (attempt-scoped report id) and inspect the failure signature to distinguish a lane/infra issue from a genuine work failure.
2. Verify the lease was not expired at the time of the burn — if the clock reaped it, reset the lease before retrying rather than re-running blind.
3. Confirm the chain is still halted and that any re-run is gated through the `fsm-control` ops lane (`pause|resume|halt|unhalt|reset|configure`) so the watchdog backstop remains engaged.