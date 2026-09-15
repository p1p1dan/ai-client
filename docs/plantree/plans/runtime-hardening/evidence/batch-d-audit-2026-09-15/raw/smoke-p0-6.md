# 区域审查：P0-6 冒烟通道（runOnce / assertions / cases） — 任务 T030

区域：smoke-p0-6 · 任务：T030（批次 D，审计覆盖补全）· HEAD：`ebc82f16` · 日期：2026-09-15

## 总评

`src/runtime/smoke/runOnce.ts` 与 `assertions.ts` 这条冒烟通道本身是干净的：两条 lane（`--offline` 用 pi-ai 自带的 `fauxProvider` 顶替网络、`--model` 打真实端点）各自指向一份独立的用例 JSON，六项断言（`must_succeed`、`must_call_tools`、`must_not_call_tools`、`turns`、`min_output_chars`/`exact_output`、`max_latency_ms`）逐条都在检查真实信号，没有发现恒真或名不副实的断言。`runOnce.ts` 对 `createRuntime` 的调用没有传 `tools`，因此不会撞上决策 012 之后「有 tools 必须有 permissions.approve」的强制检查；`bootstrap.ts`、`contracts.ts`、`host/config.ts` 的导出在 T009/T025/T036 之后都还在，静态读下来这条链路可以正常解析和运行。

真正的问题不在这条通道的实现上，而在两处「说了但没兑现」：一是审计当时依赖的证据文件本身已经严重过期（相差 227～228 个提交，横跨了 P6 退役旧引擎、T028 解冻 `config_version` 两次大改），archived 的 trace 里还写着已经不存在的 `"backend":"legacy"`；二是 `assertions.ts` 的文档注释明确写「Kept separate from the runner so P1..P3 can reuse it」，但实际读 P1 的四个探针文件，没有一个 import 过 `runOnce.ts` 或 `assertions.ts`，P1 自己另起了一套手写的布尔断言表。这两条都不影响冒烟通道当前能不能跑，但都会让人在不读代码的情况下对「P0-6 完成」这句话产生错误的信心。

## 优点

- 六项断言各自读真实信号：`turns` 读的是 `collected.turns.length`（`src/runtime/plugins/agent-loop/index.ts:645`），不是写死的常量；`must_not_call_tools:["*"]` 专门处理了「零工具调用」这个 P0 的核心契约，而不是简单地检查某个工具名。
- `--offline`/`--model` 两条 lane 用两份独立用例文件（`p0-single-turn-offline.json` / `p0-single-turn.json`），差异符合各自的物理限制（offline 用 `exact_output` 因为响应是脚本化的，live 用更宽松的 `min_output_chars` 因为不同供应商可能带换行符），是有意的设计差异，不是缺陷。
- `createRuntime` 调用不传 `tools`，天然绕开了决策 012 引入的「tools 存在则必须有 permissions.approve」强制检查（`bootstrap.ts:222-227`），T036 退役 extensionUi 整链之后这条冒烟仍然能解析和跑通，没有被撞坏。
- `@earendil-works/pi-ai/providers/faux` 的 `fauxProvider`/`fauxAssistantMessage` 在 `src/runtime/node_modules` 里确实存在且签名匹配，`RuntimeConfigError`、`RuntimeModelRef`、`standaloneHost`、`evaluateCase`、`SmokeCase` 等导入全部能在当前源码里找到对应的 `export`，没有 T009/T025/T028/T036 遗留的悬空导入。

## 弱点

- P0-6 唯一的两份存档证据（`offline-smoke-trace.jsonl`、`live-smoke.md`）都停留在 2026-09-08、HEAD 落后 227～228 个提交的状态，横跨了 P6 退役旧引擎（`legacy` 后端已被整体删除）与 T028 解冻 `config_version` 两次改变可比性基线的大改，没有任何后续重跑证据。
- `assertions.ts` 声称的「P1..P3 可复用」在 P1 侧没有兑现：P1 的宿主工具探针（`p1-host-tools.ts`）另起了一套跟 `ExpectedAssertions`/`evaluateCase` 完全不共享类型的手写断言对象，也没有任何文件 import `runOnce.ts`。

## 节点判定

| 节点 | 判定 | 依据 |
|---|---|---|
| P0-6 | complete-with-gaps | 冒烟通道实现本身可用、断言非恒真、两条 lane 用例区分合理（smoke-01 SCENARIO 之外无代码级缺陷）；但 smoke-01（证据陈旧到覆盖了一次引擎退役）与 smoke-02（复用承诺未兑现）两条残留缺口说明「完成」这句话目前缺少现行证据支撑，且注释与实现有一处不一致 |

## 发现

### [smoke-01] low test-gap | P0-6 | docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl:1 | P0-6 存档冒烟证据落后 HEAD 227～228 个提交，跨过了一整次引擎退役

DESC: `offline-smoke-trace.jsonl` 与 `live-smoke.md` 采集于 2026-09-08（提交 `3ce9702e`/`8a71c843`），当时 `src/runtime` 仍处于 P0 阶段，trace 里 `version_stamp.backend` 记的是 `"legacy"`。现在 `flags.backend` 已经被 P6 硬编码为字面量 `'native'`（`src/runtime/flags.ts:43`），`config_version` 也已从冻结的 `runtime_p3_complete_v1` 解冻到 `runtime_p6_hardening_v1`（`src/runtime/bootstrap.ts:132`，T028 落地）。也就是说，存档证据描述的是一个已经不存在的运行时形态；而两次大改（P6 整体退役旧引擎、T028 解冻可比性基线）之后，没有任何一次重跑 `--offline`/`--model` 冒烟的存档记录。另外，`offline-smoke-trace.jsonl` 本身是 `TracePlugin.begin()`/`end()` 写出的原始 `runs.jsonl` 记录（字段为 `run_id/timestamp/input/model/provider/config_version/steps/final_output/usage/latency_ms/success/version_stamp`，比对 `src/runtime/trace.ts:125-135` 确认字段吻合），并不包含 `AssertionReport` 里的 `outcomes`/`passed` 字段——上一轮审计（`area-assessments.md` P0-6 行）称「6 项离线断言的记录可查」，但实际这份文件里读不到任何一条断言的名字或通过与否，只有原始运行数据。
EVIDENCE:
```
// docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl
{"run_id":"run_53b3ec7a-...","config_version":"runtime_p0_v1",...,
 "version_stamp":{"config_version":"runtime_p0_v1","git_commit":"3ce9702e...",
   ...,"backend":"legacy","single_turn":"true"}}
```
```
// src/runtime/flags.ts:43
  backend: 'native';
```
SCENARIO: 有人把 P0-6 的「完成」当作现行结论去做下一步决策（例如批次 D 之后的验收签收），但唯一能查到的存档证据描述的是一个已经不存在的 `legacy` 后端；如果当前代码在 P6/T028 之后的某处悄悄破坏了 offline lane（比如 `permissions.approve` 必填检查、`RUNTIME_CONFIG_VERSION` 改名影响了别处读取逻辑），现有证据完全无法发现，因为它比这些改动还早。
FIX: 在开发机上重跑 `node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline`（不需要凭据、不需要真实模型），把新的 `runs.jsonl`/`report` 一并存档并标注新的提交号，同时在 `live-smoke.md` 补一次现行版本戳的 `--model` 重跑说明，或在文档里明确写清楚现有记录仅是历史存档、不代表现行代码状态；顺带把「断言逐条 pass/fail」的报告（`report.outcomes`，即 `runOnce.ts` `--json` 模式下打印的内容）与 trace 一起存档，让下一次审计不用重新推导这份记录到底覆盖了哪六项断言。

### [smoke-02] low docs | P0-6 | src/runtime/smoke/assertions.ts:10 | 注释承诺「P1..P3 可复用」断言层，但 P1 的探针没有复用它

DESC: `assertions.ts` 顶部注释写道：「Kept separate from the runner so P1..P3 can reuse it: a case file's `expected_assertions` block is the same shape whatever phase produced the run.」但全仓 grep `evaluateCase`/`ExpectedAssertions`/`SmokeCase` 只有 `assertions.ts` 自身与 `runOnce.ts` 两处命中。P1 的宿主工具探针 `smoke/p1-host-tools.ts`（晚于 `assertions.ts` 落地，`git log` 显示其创建提交 `27ff2020` 在 `assertions.ts` 的创建提交 `8a71c843` 之后）自己手写了一个 `{read, edit, bash, glob, grep, trace}` 布尔映射表并用 `Object.values(assertions).every(Boolean)` 判断通过与否，完全没有引用 `ExpectedAssertions`/`evaluateCase`；`p1-bundled-node.ts`、`p1-standalone.ts`、`p1-utility-worker.ts` 三个探针也都只 import `p1-host-tools.ts` 里的 `runHostToolsProbe`，没有一个文件 import `runOnce.ts`。
EVIDENCE:
```
// src/runtime/smoke/assertions.ts:10-12
 * Kept separate from the runner so P1..P3 can reuse it: a case file's
 * `expected_assertions` block is the same shape whatever phase produced the
 * run.
```
```
// src/runtime/smoke/p1-host-tools.ts:43-53
    const assertions = {
      read: read === 'amber\n',
      edit: edited === 'azure\n',
      bash: bash.includes('host-ok') && bash.includes('exit=0'),
      glob: glob.includes('probe.txt'),
      grep: grep.includes('azure'),
      trace: run.trace.version_stamp.carrier === host.carrier && !run.trace.persistence_error,
    };
    return {
      passed: Object.values(assertions).every(Boolean),
```
SCENARIO: 下一个要写 P2/P3 冒烟探针的人读到 `assertions.ts` 的注释，会以为只要把用例写成 `expected_assertions` 形状就能直接接上 `evaluateCase`；但看 P1 的先例会发现实际做法是另起一套跟共享类型完全不兼容的手写断言，于是要么被迫重新发明一遍，要么误以为自己抄的是「标准做法」而实际抄的是唯一没有复用共享层的反例。断言输出的形态也不统一：`evaluateCase` 产出的是带 `name/passed/expected/actual/tag` 的结构化 `AssertionOutcome[]`，P1 产出的是裸布尔映射，两者不能被同一个报告聚合或对比。
FIX: 二选一即可收口——要么把 `p1-host-tools.ts` 的断言改写成 `ExpectedAssertions`/`evaluateCase` 的形状（把 `read`/`edit`/`bash`/`glob`/`grep`/`trace` 五个工具动作的期望值编成一份 `SmokeCase`，复用共享的 `AssertionOutcome` 结构），要么把 `assertions.ts` 的注释改成准确反映现状（例如「设计为 P0 专用，P1 的宿主工具探针出于历史原因走了独立的手写断言，尚未合并」），避免注释继续给后来者一个没有兑现的复用承诺。

## 测试缺口

- P0-6 的冒烟通道本身没有 `vitest`/`node --test` 级别的自动化用例去断言 `evaluateCase` 的六个分支各自的边界（例如 `must_not_call_tools:["*"]` 在恰好调用了一次工具、`exact_output` 在输出带前导空白时是否正确 trim）——目前只靠人读源码确认逻辑正确，没有单元测试兜底这条判定逻辑本身不会回归。
- `p1-host-tools.ts` 的手写断言表没有失败路径的用例（例如刻意让 `bash` 返回非零退出码），只有 smoke 脚本本身手动跑一次的隐式覆盖。

## 未经执行验证的声明

- `pnpm smoke:runtime`（即 `node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline`）在当前 HEAD 上能否实际跑通、六项断言是否全部通过——本次审查只做了静态导入与类型核对，没有执行，按硬规则不允许在开发机上跑这条命令。
- `--model` 在线 lane 在当前 HEAD 上针对真实供应商是否仍然端到端可用——`live-smoke.md` 记录的是 2026-09-08 当时的结果，且依赖用户提供的 `~/.pilab/pi-agent/` 目录与网关凭据，本次无法复核。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| offline lane 现行可跑 | `node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline` 退出码为 0，六项断言全部 PASS，新 trace 的 `version_stamp.backend==='native'`、`config_version==='runtime_p6_hardening_v1'` | 实际执行命令，存档 stdout 与新生成的 `runs.jsonl` | dev-box |
| live lane 现行可跑（P0-6 判定依赖的 R1 关闭结论仍然成立） | 至少一个真实供应商的 `--model provider/id` 调用返回 `must_succeed=true` 且不超过 `max_latency_ms` | 用登录后的 `~/.pilab/pi-agent/` 目录跑 `--model`，比对新旧 trace 的 `version_stamp` 差异 | real-model |
| `--json` 报告与 trace 一并存档 | 新证据同时包含 `report.outcomes`（逐条断言名与 pass/fail）与 `runs.jsonl`，而不是像现有证据那样只有裸 trace | 执行时加 `--json`，把 stdout 与 trace 一起写进 evidence 目录 | dev-box |

## 读过的文件

- src/runtime/smoke/runOnce.ts
- src/runtime/smoke/assertions.ts
- src/runtime/smoke/cases/p0-single-turn.json
- src/runtime/smoke/cases/p0-single-turn-offline.json
- src/runtime/smoke/p1-host-tools.ts
- src/runtime/smoke/p1-bundled-node.ts（略读，仅核对 import）
- src/runtime/smoke/p1-standalone.ts（略读，仅核对 import）
- src/runtime/smoke/p1-utility-worker.ts（略读，仅核对 import）
- src/runtime/bootstrap.ts
- src/runtime/contracts.ts
- src/runtime/trace.ts
- src/runtime/flags.ts
- src/runtime/host/config.ts
- src/runtime/plugins/agent-loop/index.ts（仅 `turns` 计算片段）
- src/runtime/node_modules/@earendil-works/pi-ai/package.json（exports 校验）
- src/runtime/node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts
- src/runtime/package.json
- package.json（根，smoke 相关脚本）
- docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl
- docs/plantree/plans/runtime-evolution/evidence/p0/live-smoke.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（GAP 6 及 CRITIC 摘要段）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/area-assessments.md（P0-6 判定原文）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段、T030 行）
