# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。

- **Current Phase**: Phase 3 Chat MVP 收口（2026-07-24 双轨合一，单线推进）
- **Last Landed**: 2026-07-27 **T-07 补强四项 + open-q#7** `0f886a8`（目录可选 +144 条 / `--hidden` 90 条隐藏条目 / 查 `chat` 显示「10/319」/ 同分全序）；同日 **#8 thinking 形态修正** `bfd4f6b`
- **Last Verified**: 2026-07-27 三绿——typecheck 干净 / lint 587 文件 0 诊断 / vitest **41 文件 391 例**
- **Next Target**: T-04 + T-07 GUI 验收（均已就绪，等用户统一点测）；并行可推 T-05 开发

## #8 结论（2026-07-27）

| 项 | 结论 |
|---|---|
| T-04 thinking 空白真凶 | ✅ `display` 默认 `omitted`。实测：裸 `{type:'adaptive'}` → thinking 块 1 个但文本 **0**；加 `display:'summarized'` → 文本 **408** 字符 |
| C-14「400 thinking 格式无效」根因 | ❌ **原假说被推翻**——`{type:'enabled', budgetTokens}` 实测仍返回 200。open-questions #5 **保持 open** |
| `effort` 位置 | ✅ SDK 顶层 `Options.effort`，**不是** `output_config.effort`（更正 C-10 台账行） |
| T-20 协议底座 | ✅ `session.create.effort` / `session.send.effort` 已落（纯可选加法，未 bump 协议版本） |

证据：`spikes/c16-thinking-shape-probe.ts`（SDK 层五场景）+ `spikes/c16-thinking-host-smoke.ts`（真 Host NDJSON 全链）+ `__tests__/claudeRuntimeOptions.test.ts`（10 例钉死 options）。

## 首轮 GUI 联调结论（2026-07-26）

| 任务 | 结论 | 说明 |
|---|---|---|
| T-02 会话生命周期 | ✅ Done | 标题 bug 已修并复验通过；归档无 un-archive 入口 = 设计缺口，转 open-questions #6 |
| T-03 Resume 历史 | 🟡 部分通过 | 重放机制通（tool 卡正常渲染），历史读失败的 UI 展示仍缺；thinking 缺失已另案定性 |
| T-04 Thinking 卡 | 🟡 **已解除阻塞** | 代码链逐环验证正确；#8 落地后 `display:'summarized'` 使文本非空，**可观测对象已就位**，等 GUI 人工点验 |
| T-06 元数据/重试 | ⬜ 未测 | 唯一完全未碰的任务，不受上述 bug 影响，可直接补测 |
| T-07 `@` 引用 | ✅ Done | P0 反斜杠已修并复验通过；三项补强（目录 / 隐藏文件 / 截断提示）+ 同分定序已于 2026-07-27 `0f886a8` 落地，等 GUI 点验 |

Tool 卡不折叠 = T-05 未开发，**非 bug**。

## Active TODO

1. **T-04 / T-07 GUI 验收**（用户人工，统一点测）：联调环境
   `CLAUDE_CONFIG_DIR='C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config' pnpm dev`
   - **T-04 thinking 卡**：历史 fixture 的 153 个 thinking 块**文本仍是空串**（旧会话录制时 display=omitted，不可追溯补全）——**只能在新发起的轮次上验证**，resume 旧会话看不到 thinking 属预期。
   - **T-07 补强**：`@` 输入 `src/` 应见目录条目（黄色文件夹图标 + 尾随 `/`）；输入 `git` 应见 `.gitignore` 等隐藏文件；输入 `chat` 右下角应显示 `10/319`。
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）
3. T-05 开发（工具卡 + Question 卡）
4. **T-20 Effort 选择器 UI**：协议底座已就位（`session.create/send` 的 `effort`），只剩 Renderer 选择器 + 透传
5. T-10 打包版点验（用户，[清单](../../../plans/t10-packaged-gui-checklist.md)）→ **CP2 汇报**
6. C-15 体积 141MB（+21MB）可接受性——等用户拍板
7. T-19 消息队列提案——等用户落库

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）

## Handoff Notes

- 提交习惯：pathspec 提交保留（非强制）；三绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- 同事交接词两处过时勿信：「biome CRLF 行尾债」（C-09 后 lint 0 诊断）、「T-05 Question 等 C-04」（C-04 已 ✅）。
