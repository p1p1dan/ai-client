#!/usr/bin/env bash
# Decision 189: records every bridge-record scenario on its own (Windows, Git
# Bash, through win-shim.mjs), keeping the normalized recordings and the
# differences against the golden samples, so two DSH versions can be compared
# scenario by scenario with compare-recordings.mjs. Never --update.
#   run-record.sh <out-dir> [scenario ...]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
SHIM="$(cygpath -m "$HERE/win-shim.mjs")"
OUT="$1"; shift
mkdir -p "$OUT"
SCENARIOS=("$@")
if [ ${#SCENARIOS[@]} -eq 0 ]; then
  SCENARIOS=(stream tool fail stop-stream stop-tool compact crash-resume rewind fork think usage
    job-notice steer fail-retry perm-card perm-grants perm-deny perm-plan perm-gear perm-stop
    perm-restart perm-subagent perm-search image file-attach question plan-review plan-dismiss
    jobs-kill sub-cont steer-withdraw auto-compact auto-compact-fail overflow-compact
    compact-instructions compact-cancel)
fi
for s in "${SCENARIOS[@]}"; do
  start=$(date +%s)
  dir="$OUT/$s"
  mkdir -p "$dir"
  ( cd "$ROOT" && timeout 600 node "$SHIM" src/dsh-host/tools/bridge-record.ts --check --only "$s" \
      --artifacts "$(cygpath -m "$dir")" ) > "$dir/console.log" 2>&1
  code=$?
  aborted=$(grep -c "recording failed" "$dir/console.log")
  echo "$s exit=$code aborted=$aborted seconds=$(( $(date +%s) - start ))" | tee -a "$OUT/exit-codes.txt"
done
