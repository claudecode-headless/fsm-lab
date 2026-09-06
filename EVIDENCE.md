# EVIDENCE — live experiment ledger (fsm-lab)

Every claim carries its run ID / probe log. Nothing here is aspiration.

## X1 — chain physics (the continuity substrate)

### X1a: GITHUB_TOKEN self-dispatch — THE LAW IS PARTIALLY INVERTED ⭐

**Claim proven:** a workflow CAN re-trigger itself using its own ephemeral
`GITHUB_TOKEN` via `repository_dispatch` — no PAT needed for same-repo chains.

- Probe: run **34025596219** (`hop 0 · github-token`, fired 2026-09-06T09:46:38Z)
  - dispatch with job token: `HTTP=204`
  - log line: `VERDICT: GITHUB-TOKEN-WOKE — 1 run(s) fired from a GITHUB_TOKEN dispatch (names: hop 1 · verify)`
- Follow-up run: **34025603333** (`hop 1 · verify`), `event=repository_dispatch`, `triggering_actor=github-actions[bot]`, created 09:46:48Z (≈10s after dispatch)

**Why this matters architecturally:** the documented anti-recursion rule
("events created with GITHUB_TOKEN never start workflow runs") has TWO
documented exceptions — `workflow_dispatch` and `repository_dispatch`. The
prior track never hit this because its dispatches were CROSS-repo (executor →
private repo), which genuinely requires a PAT. Consequences:

1. Same-repo orchestration (conductor self-chain, worker dispatches, report
   dispatches, watchdog re-prime) can ride the job-scoped `GITHUB_TOKEN`
   entirely — **zero PAT secrets needed for the control plane**.
2. The PAT remains required only for: cross-repo dispatch, and comments that
   must WAKE comment-triggered workflows (the A2A conversational surface —
   bot comments never fire `issue_comment`; that part of E7 stands).
3. Security: the job token dies with the job; a public-repo lab could run
   PAT-less. (The lab keeps `LAB_PAT` wired as a FALLBACK lane to prove both.)

**Guardrail (unchanged):** `GITHUB_TOKEN`-authored COMMENTS still never fire
`issue_comment` workflows (E7, prior track) — the exception is exactly and
only the dispatch family.

### X1b: PAT chain (12 hops) — *pending*

### X1c: GITHUB_TOKEN chain (12 hops) — *pending*

## X2 — conductor live loop — *pending*

## X3 — parallel workers — *pending*

## X4 — failure-injection matrix — *pending*

## X5 — watchdog re-prime + breaker — *pending*

## X6 — state growth — *pending*

## X7 — real-LLM seam — *pending*
