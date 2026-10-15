#!/usr/bin/env bash
# Captures the exact model request Claude Code sends for one prompt, without a
# real model: the installed Claude Code binary runs headless (-p) against the
# local fake gateway (--capture), with a throwaway CLAUDE_CONFIG_DIR, HOME and
# a fake API key, so no user setting, credential or memory takes part and no
# request leaves 127.0.0.1. The capture holds Claude Code's prompt text, which
# is Anthropic's copyrighted material: keep it in the scratch directory and
# summarize it with compare-captures.mjs; never commit it.
#
#   capture-claude-code-request.sh <claude executable> [effort] [model]
#
# Windows (Git Bash): the executable is e.g. $CLAUDE_CODE_EXECPATH inside a
# Claude Code session; CLAUDE_CODE_GIT_BASH_PATH must point to bash.exe.
set -euo pipefail

CLAUDE_BIN=${1:?claude executable}
EFFORT=${2:-high}
MODEL=${3:-claude-opus-5-5}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../../../../.." && pwd)
S=$(mktemp -d "${TMPDIR:-/tmp}/cc-capture-XXXXXX")
mkdir -p "$S/capture" "$S/config" "$S/home" "$S/tmp" "$S/ws/src"

node "$REPO/src/dsh-host/tools/fake-gateway.mjs" --port 0 --plan text --reset \
  --state "$S/state.json" --log "$S/gateway.jsonl" --capture "$S/capture" > "$S/gw.out" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q 'listening on' "$S/gw.out" 2>/dev/null && break; sleep 0.2; done
PORT=$(grep -o '127.0.0.1:[0-9]*' "$S/gw.out" | head -1 | cut -d: -f2)

# The same workspace as capture-pilab-request.ts, as a git repository.
printf '# Project rules\n\nUse TypeScript strict mode.\n' > "$S/ws/CLAUDE.md"
printf 'export const x = 1;\n' > "$S/ws/src/index.ts"
(cd "$S/ws" && git init -q && git add -A && git -c user.email=capture@example.invalid -c user.name=capture commit -qm init)

SR=${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}
(cd "$S/ws" && env -i PATH="$PATH" SystemRoot="$SR" SYSTEMROOT="$SR" windir="$SR" \
  ComSpec="${COMSPEC:-}" PATHEXT="${PATHEXT:-}" SystemDrive="${SYSTEMDRIVE:-C:}" \
  ProgramFiles="${PROGRAMFILES:-}" ProgramData="${PROGRAMDATA:-}" \
  USERPROFILE="$S/home" HOME="$S/home" APPDATA="$S/home/AppData/Roaming" LOCALAPPDATA="$S/home/AppData/Local" \
  TEMP="$S/tmp" TMP="$S/tmp" TMPDIR="$S/tmp" CLAUDE_CODE_GIT_BASH_PATH="${CLAUDE_CODE_GIT_BASH_PATH:-}" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY="sk-ant-api03-fake-capture" \
  CLAUDE_CONFIG_DIR="$S/config" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$CLAUDE_BIN" -p "List the workspace files." --model "$MODEL" --effort "$EFFORT" > "$S/claude.out" 2>&1 || true)

echo "captures: $S/capture"
