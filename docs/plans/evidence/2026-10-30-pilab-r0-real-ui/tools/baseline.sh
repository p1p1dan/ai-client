#!/usr/bin/env bash
# R0 real-UI baseline batch: F01–F05 + FAIL states, light/dark, wide/narrow.
# Prerequisite (see ../README.md): app launched, `enter` and `provider` done.
#   bash baseline.sh light|dark|narrow
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../../.." && pwd)
E=$(dirname "$here")
D="$here/pilab-r0-ui.mjs"
GUI="$repo/docs/plantree/plans/dsh-rebase/evidence/p1-7d-gui-2026-09-30/tools/p1-7d-gui.mjs"
export P17D_SCRATCH=${P17D_SCRATCH:-/tmp/pilab-r0}
mkdir -p "$E/results"
cd "$repo"

run() { # name F cut texts...
  local name=$1 f=$2 cut=$3
  shift 3
  {
    echo '{"inject":'
    timeout 90 node "$D" inject "$f" $cut
    echo ',"measure":'
    timeout 60 node "$D" measure "$@"
    echo '}'
  } >"$E/results/$name.json"
  timeout 60 node "$D" shot "$name" >/dev/null
  node -e '
    const r = require(process.argv[1]); const m = r.measure;
    console.log([process.argv[2], r.inject.status, `perm=${r.inject.pendingPermissions} q=${r.inject.pendingQuestions}`,
      `details=${m.details}/${m.detailsOpen}`, JSON.stringify(m.summaries), `status=${JSON.stringify(m.statusIcons)}`,
      `qp=${m.questionPrompt} fc=${m.failureContinue} hov=${m.horizontalOverflow} ${m.viewport.w}x${m.viewport.h} ${m.theme}`,
      m.texts.map((t) => `${t.text.slice(0, 8)}:${t.visible}/${t.inDom}`).join(" ")].join(" "));
  ' "$E/results/$name.json" "$name"
}

mode=${1:-light}
case "$mode" in
  light | dark)
    timeout 60 node "$GUI" theme "$mode" >/dev/null
    run "f01-running-$mode" F01 running '正文 A' '正文 B' '核对参数与结果'
    run "f01-ended-$mode" F01 '' '正文 A' '正文 B' '核对参数与结果' '2 passed'
    run "f02-running-$mode" F02 running '阶段正文 1' '阶段正文 4' '第 1 段脱敏思考'
    run "f02-ended-$mode" F02 '' '阶段正文 1' '阶段正文 8' '第 42 段脱敏思考'
    run "f03-pending-$mode" F03 pending '选择脱敏验证环境' 'pnpm deploy:demo'
    run "f03-resolved-$mode" F03 '' '选择脱敏验证环境' 'pnpm deploy:demo'
    run "fail-$mode" FAIL '' '正文 A' '正文 B' '503'
    run "f04-recovered-$mode" F04 '' '好好' '好' 'run:repeat-1' 'run:repeat-2'
    run "f05-stage-$mode" F05 stage '本阶段回复已给出' '同名代理'
    run "f05-late-$mode" F05 '' '本阶段回复已给出' '新任务正文' '旧后台任务的新发现'
    ;;
  narrow)
    timeout 60 node "$GUI" theme light >/dev/null
    timeout 60 node "$GUI" bounds 720 760 >/dev/null
    run f01-running-narrow F01 running '正文 A' '正文 B'
    run f02-ended-narrow F02 '' '阶段正文 1' '阶段正文 8'
    run f03-pending-narrow F03 pending 'pnpm deploy:demo'
    run fail-narrow FAIL '' '正文 A' '503'
    ;;
  *)
    echo "usage: baseline.sh light|dark|narrow" >&2
    exit 2
    ;;
esac
