#!/usr/bin/env bash
# T1, Claude Code side: the same tiny prompt as t1-pilab-real-gateway.ts, sent
# through the same REAL gateway by the installed Claude Code (-p, JSON output),
# one fresh throwaway config per run so no user setting, credential, memory or
# session takes part. The URL and key come only from this process's
# environment and are not written anywhere.
#
#   T1_BASE_URL=<gateway root> T1_API_KEY=<key> \
#   bash t1-claude-code-real-gateway.sh <claude executable> [runs] [model] [effort]
#
# Output: one JSON line per run with the billed usage, then a summary.
set -euo pipefail

CLAUDE_BIN=${1:?claude executable}
RUNS=${2:-10}
MODEL=${3:-claude-opus-5-5}
EFFORT=${4:-low}
: "${T1_BASE_URL:?set T1_BASE_URL}"
: "${T1_API_KEY:?set T1_API_KEY}"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/t1-cc-XXXXXX")
SR=${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}

for RUN in $(seq 1 "$RUNS"); do
  S="$ROOT/run-$RUN"
  mkdir -p "$S/config" "$S/home" "$S/tmp" "$S/ws"
  (cd "$S/ws" && env -i PATH="$PATH" SystemRoot="$SR" SYSTEMROOT="$SR" windir="$SR" \
    ComSpec="${COMSPEC:-}" PATHEXT="${PATHEXT:-}" SystemDrive="${SYSTEMDRIVE:-C:}" \
    ProgramFiles="${PROGRAMFILES:-}" ProgramData="${PROGRAMDATA:-}" \
    HTTPS_PROXY="${HTTPS_PROXY:-}" HTTP_PROXY="${HTTP_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
    USERPROFILE="$S/home" HOME="$S/home" APPDATA="$S/home/AppData/Roaming" LOCALAPPDATA="$S/home/AppData/Local" \
    TEMP="$S/tmp" TMP="$S/tmp" TMPDIR="$S/tmp" CLAUDE_CODE_GIT_BASH_PATH="${CLAUDE_CODE_GIT_BASH_PATH:-}" \
    ANTHROPIC_BASE_URL="$T1_BASE_URL" ANTHROPIC_API_KEY="$T1_API_KEY" \
    CLAUDE_CONFIG_DIR="$S/config" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    "$CLAUDE_BIN" -p "Reply with exactly: OK" --model "$MODEL" --effort "$EFFORT" --output-format json \
    > "$S/result.json" 2> "$S/stderr.txt" || true)
  node -e '
    const fs = require("fs");
    const run = Number(process.argv[2]);
    let r;
    try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log(JSON.stringify({ run, error: "no JSON result" })); process.exit(0); }
    const u = r.usage || {};
    const billed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    console.log(JSON.stringify({ run, billedPrompt: billed, input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0, isError: !!r.is_error }));
  ' "$S/result.json" "$RUN" | tee -a "$ROOT/rows.jsonl"
done

node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((r) => !r.error);
  const billed = rows.map((r) => r.billedPrompt).sort((a, b) => a - b);
  console.log(JSON.stringify({ side: "claude-code", runs: rows.length, billedPromptMin: billed[0], billedPromptMedian: billed[Math.floor(billed.length / 2)], billedPromptMax: billed[billed.length - 1] }));
' "$ROOT/rows.jsonl"
