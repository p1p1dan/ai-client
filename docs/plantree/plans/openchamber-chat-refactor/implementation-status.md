# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。

- **Current Phase**: Phase 3 Chat MVP 收口（2026-07-24 双轨合一，单线推进）
- **Last Landed**: 2026-07-26 T-02/T-07 联调 bug 修复 `db5116a`（标题全空守卫 + `@` 引用路径归一化）——**用户当日 GUI 复验通过，两任务转 Done**
- **Last Verified**: 2026-07-26 三绿——typecheck 干净 / lint 583 文件 0 诊断 / vitest **39 文件 354 例**
- **Next Target**: #8 thinking API 形态修正（一处改动解四件事，见 Active TODO 1）

## 首轮 GUI 联调结论（2026-07-26）

| 任务 | 结论 | 说明 |
|---|---|---|
| T-02 会话生命周期 | ✅ Done | 标题 bug 已修并复验通过；归档无 un-archive 入口 = 设计缺口，转 open-questions #6 |
| T-03 Resume 历史 | 🟡 部分通过 | 重放机制通（tool 卡正常渲染），历史读失败的 UI 展示仍缺；thinking 缺失已另案定性 |
| T-04 Thinking 卡 | ⬜ 阻塞 | 代码链逐环验证正确；`display` 默认 `omitted` → 文本恒空，无可观测对象，等 #8 |
| T-06 元数据/重试 | ⬜ 未测 | 唯一完全未碰的任务，不受上述 bug 影响，可直接补测 |
| T-07 `@` 引用 | ✅ Done | P0 反斜杠已修并复验通过；目录不返回 / 隐藏文件被吞 / 10 条静默截断三项另列补强 |

Tool 卡不折叠 = T-05 未开发，**非 bug**。

## Active TODO

1. **#8 thinking API 形态修正**（下一个开发任务）：`claudeRuntime.ts:393` 的 `{type:'enabled', budgetTokens:4096}` 在 Opus 4.8/4.7、Sonnet 5、Fable 5 上已移除、发送即 400 → 改 `{type:'adaptive', display:'summarized'}` + `output_config.effort`。**一处改动解四件事**：消 400 瞬态（open-questions #5 结项）、thinking 卡可见（解锁 T-04 GUI 验收）、T-20 Effort 选择器协议底座、effort 档位对齐官方
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）
3. T-07 补强：目录可选 / `--hidden` / 返回 `total` 并提示截断 / 同分 tie-break
4. T-05 开发（工具卡 + Question 卡）
5. T-10 打包版点验（用户，[清单](../../../plans/t10-packaged-gui-checklist.md)）→ **CP2 汇报**
6. C-15 体积 141MB（+21MB）可接受性——等用户拍板
7. T-19 消息队列提案——等用户落库

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）
- T-04 GUI 验收需 `display: 'summarized'` 落地后才有可观测对象（并入 #8）

## Handoff Notes

- 提交习惯：pathspec 提交保留（非强制）；三绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- 同事交接词两处过时勿信：「biome CRLF 行尾债」（C-09 后 lint 0 诊断）、「T-05 Question 等 C-04」（C-04 已 ✅）。
