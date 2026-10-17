# S-6 反馈第 1 条后续：放开 ReportFindings 并做审查结果卡（交给另一个代理，2026-10-17）

用户裁决（2026-10-17）："放开并做配套"。背景见 [S-6 反馈清单](s6-feedback.md) §3 第 1 条与 README 裁决 24。

## 工具是什么

`ReportFindings` 是官方 CLI（2.1.300，非交互模式也提供）的工具：代码审查一类技能（`code-review`、`security-review`、`simplify` 等）用它把审查发现的问题**结构化地交给宿主**，宿主画成可点击的问题列表。工具说明原文（CLI 发给模型的）要点：只有审查说明要求时才用；一次调用交出全部经核实的问题，按严重程度从高到低，没有问题就交空数组；**用了它就不要再把问题写成正文**；修复之后重报时给每条填 `outcome`。

输入结构（从 CLI 发出的请求里取的 `input_schema`，`additionalProperties: false`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `level` | `low`/`medium`/`high`/`xhigh`/`max`，可选 | 审查跑的力度 |
| `findings` | 数组，必填，最多 32 条 | 经核实的问题，最严重的在前；可以为空 |
| `findings[].file` | 字符串，必填 | 相对仓库根的路径 |
| `findings[].line` | 整数，可选 | 从 1 起的行号 |
| `findings[].summary` | 字符串，必填 | 一句话的问题陈述 |
| `findings[].short_summary` | 字符串，可选，≤60 字 | 紧凑界面用的短标签 |
| `findings[].failure_scenario` | 字符串，必填 | 具体的输入或状态如何导致错误 |
| `findings[].category` | 字符串，可选，≤40 字 | 如 `correctness`、`simplification`、`efficiency`、`test-coverage` |
| `findings[].verdict` | `CONFIRMED`/`PLAUSIBLE`，可选 | 跑过核实时才有 |
| `findings[].outcome` | `fixed`/`skipped`/`no_change_needed`，可选 | 只在修复后重报时有 |

## 要做的

1. **宿主放开**：`src/claude-sdk-host/sdkSessionRuntime.ts` 的 `HOST_ONLY_TOOLS` 去掉 `ReportFindings`，更新上方注释（只剩 RemoteTrigger、ListAgents、SendMessage、Workflow）。确认这个工具在各权限档位下都不弹权限卡（它只是把结果交给界面，不动任何东西）；如果 CLI 会为它走 `canUseTool`，宿主直接放行。
2. **审查结果卡**（渲染层，`src/renderer/components/chat/`）：时间线里 `ReportFindings` 的工具调用不画成普通工具行，而是一张卡：
   - 标题行：「审查结果」+ 条数（以及 `level`，有的话）；没有问题时显示"未发现问题"。
   - 每条一行：短标签（没有就用 `summary` 截断）、`file:line`（点了用现有的打开文件意图在编辑器里打开并定位到行，参照 `ToolRows.tsx` 的 `openFileTarget`）、`category` / `verdict` / `outcome` 用小标签显示。
   - 每条可展开看完整的 `summary` 与 `failure_scenario`。
   - 条数多时默认只展开前几条或全部折叠，自己定一个合理的默认，写清理由。
   - 实时与重新打开的历史都要能画（历史里它是 `tool_call` 块，输入在 `toolInput`）。
   - 运行中（参数还在流式到达）时显示一行占位，不要画半截 JSON。
   - 工具行文案表（`toolCard.ts`）补上它的动词，如"已报告审查结果"。
3. **文案**：全部走 `src/shared/i18n.ts`。
4. **测试**：
   - 渲染层：模型层单测（排序保持、空列表、缺可选字段、`outcome` 标签）与挂载测试（卡片出现、点击文件触发打开意图、展开显示 `failure_scenario`）。
   - 宿主：`src/claude-sdk-host/tools/host-probe.ts` 加一个场景，用本机假网关的 `CC-RUN`（`src/dsh-host/tools/fake-gateway.mjs`，见其头部注释）让模型调一次 `ReportFindings`，检查工具调用开始与结束事件里输入原样带到、没有权限卡；把场景加进 `probe-suite.ts` 的某一组。
   - 宿主单测里 `HOST_ONLY_TOOLS` 相关的断言跟着改。

## 不做的

- 不改 DSH 引擎（DSH 没有这个工具）。
- 不改审查技能本身，也不加"一键修复"之类的按钮。
- 不改 `src/shared/permissions/` 与权限审批卡（另有人在改）。

## 验收

- 根目录 `pnpm typecheck` 与 `pnpm typecheck:claude-sdk-host` 都 0 错。
- `src/renderer/components/chat`、`src/claude-sdk-host` 的 vitest 全过。
- 本机回归 `node src/claude-sdk-host/tools/probe-suite.ts` 全部组通过，包括新场景。
- 能起开发版的话，用 `src/claude-sdk-host/tools/gui-probe.mjs` 在 SDK 对话里触发一次，截图看卡片；起不来就写明没在界面上看。
