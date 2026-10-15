#!/usr/bin/env bash
# Decision 189: runs the source-checkout DSH probes one at a time on Windows
# (Git Bash), through win-shim.mjs, and records each exit code.
#   run-probes.sh <out-dir> [probe ...]     probes: smoke goal prefix loop p06-latency p06-crash
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
HOST="$ROOT/src/dsh-host"
SHIM="$(cygpath -m "$HERE/win-shim.mjs")"
OUT="$1"; shift
mkdir -p "$OUT"
WOUT="$(cygpath -m "$OUT")"
PROBES=("$@")
[ ${#PROBES[@]} -eq 0 ] && PROBES=(smoke goal prefix loop p06-latency p06-crash)

run() {
  local name="$1"; shift
  local start; start=$(date +%s)
  ( cd "$HOST" && timeout 1500 "$@" ) > "$OUT/$name.log" 2>&1
  local code=$?
  echo "$name exit=$code seconds=$(( $(date +%s) - start ))" | tee -a "$OUT/exit-codes.txt"
}

for p in "${PROBES[@]}"; do
  case "$p" in
    smoke)       run smoke node "$SHIM" tools/bridge-smoke.ts --out "$WOUT/smoke.json" ;;
    goal)        run goal node "$SHIM" tools/goal-probe.ts --out "$WOUT/goal.json" ;;
    prefix)      run prefix node "$SHIM" tools/request-prefix-probe.ts --out "$WOUT/prefix.json" ;;
    loop)        run loop node "$SHIM" tools/loop-guard-smoke.ts --out "$WOUT/loop.json" ;;
    p06-latency) run p06-latency node "$SHIM" tools/p0-6-probe.ts latency --runs 1 --levels 1,2,4 --out "$WOUT/p06-latency.json" ;;
    p06-crash)   run p06-crash node "$SHIM" tools/p0-6-probe.ts crash --runs 1 --out "$WOUT/p06-crash.json" ;;
    *) echo "unknown probe $p" | tee -a "$OUT/exit-codes.txt" ;;
  esac
done
