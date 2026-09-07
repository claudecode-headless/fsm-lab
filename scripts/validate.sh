#!/usr/bin/env bash
# validate.sh — the local pre-push stack (the gate-matrix discipline):
#   1. YAML parse of every workflow
#   2. node --check of every mjs
#   3. the full test suites (fsm + store + conductor-core)
#   4. the offline simulations (run-sim.mjs 7 scenarios + run-sim2.mjs — the
#      T44 wave-3 shim-driven suite)
#   5. the conductor smoke (REAL adapter against a local bare origin) —
#      OPT-IN via FSM_SMOKE=1 (it shells git + node heavily; keep CI-like
#      environments on the fast paths by default)
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== YAML =="
python3 - <<'EOF' || fail=1
import yaml, glob, sys
for f in sorted(glob.glob('.github/workflows/*.yml')):
    try:
        doc = yaml.safe_load(open(f))
        assert doc.get('jobs'), f"{f}: no jobs"
        print(f"OK {f}")
    except Exception as e:
        print(f"FAIL {f}: {e}"); sys.exit(1)
EOF

echo "== node --check =="
for f in lib/*.mjs conductor/*.mjs worker/*.mjs watchdog/*.mjs probe/*.mjs sim/*.mjs tests/*.mjs; do
  node --check "$f" && echo "OK $f" || { echo "FAIL $f"; fail=1; }
done

echo "== unit tests =="
node --test tests/*.mjs 2>&1 | tail -4
[ "${PIPESTATUS[0]}" -ne 0 ] && fail=1

echo "== simulation (core) =="
node sim/run-sim.mjs || fail=1

echo "== simulation (shim-driven, T44 wave 3) =="
node sim/run-sim2.mjs || fail=1

if [ "${FSM_SMOKE:-0}" = "1" ]; then
  echo "== conductor smoke (FSM_SMOKE=1) =="
  bash scripts/smoke-conductor.sh || fail=1
else
  echo "== conductor smoke: SKIPPED (opt in with FSM_SMOKE=1) =="
fi

echo "== verdict =="
if [ "$fail" -eq 0 ]; then echo "VALIDATE-OK"; else echo "VALIDATE-FAIL"; exit 1; fi
