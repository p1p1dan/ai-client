#!/usr/bin/env bash
# Decision 189, thinking-replay A/B: request-prefix-probe S1 (P1-CHAIN: signed,
# empty-signed and redacted thinking on every step) with the fake gateway
# answering under the requested model id (match) and under another one
# (mismatch, as a gateway alias or rewrite does), captures kept and counted by
# thinking-replay-check.mjs. Windows / Git Bash, through win-shim.mjs.
#   run-thinking-ab.sh <out-dir>
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
HOST="$ROOT/src/dsh-host"
SHIM="$(cygpath -m "$HERE/win-shim.mjs")"
CHECK="$(cygpath -m "$HERE/thinking-replay-check.mjs")"
OUT="$1"
mkdir -p "$OUT"
WOUT="$(cygpath -m "$OUT")"
# request-prefix-probe keeps its scratch under /var/tmp, i.e. <drive>:\var\tmp.
SCRATCH_PARENT="$(cygpath -u "$(cygpath -m "$HOST" | cut -c1-2)/var/tmp")"
for variant in match mismatch; do
  if [ "$variant" = mismatch ]; then export SHIM_GATEWAY_MODEL_ID=fake-1-20260929; else unset SHIM_GATEWAY_MODEL_ID; fi
  before=$(ls -d "$SCRATCH_PARENT"/aiclient-dsh-issue9-* 2>/dev/null | sort)
  ( cd "$HOST" && timeout 900 node "$SHIM" tools/request-prefix-probe.ts --only S1 --keep \
      --out "$WOUT/prefix-$variant.json" ) > "$OUT/prefix-$variant.log" 2>&1
  code=$?
  after=$(ls -d "$SCRATCH_PARENT"/aiclient-dsh-issue9-* 2>/dev/null | sort)
  scratch=$(comm -13 <(echo "$before") <(echo "$after") | tail -1)
  echo "$variant exit=$code scratch=$scratch" | tee -a "$OUT/exit-codes.txt"
  if [ -n "$scratch" ] && [ -d "$scratch/capture" ]; then
    rm -rf "$OUT/capture-$variant"
    cp -r "$scratch/capture" "$OUT/capture-$variant"
    node "$CHECK" "$WOUT/capture-$variant" --json "$WOUT/thinking-$variant.json" > "$OUT/thinking-$variant.txt" 2>&1
    cat "$OUT/thinking-$variant.txt"
    rm -rf "$scratch"
  fi
done
unset SHIM_GATEWAY_MODEL_ID
