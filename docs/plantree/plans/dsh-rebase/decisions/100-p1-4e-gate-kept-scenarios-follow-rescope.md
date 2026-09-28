# 决策 100：P1-4e 录制门禁保留并进 CI，场景随 4c / 4d 重划

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §4.3；
- [P1-4 分片 05](../topics/p1-4-bridge-parity/05-gate-and-changes.md)；
- `src/dsh-host/tools/bridge-record.ts` 的骨架（P1-4a 与 4b 已录 9 个场景）。

## 规则

1. **保留录制门禁，合入前进 CI**。
   - DSH 还是 developer preview，钉版本升级时，金样本的 diff 是发现事件词表变化的第一道警报；
   - 跟随 DSH 之后，bridge 的映射越薄，越要靠它发现 DSH 那边的变化。
2. **场景**：
   - 已有 9 个保留：stream、tool、fail、stop-stream、stop-tool、compact、crash-resume、rewind、fork。
   - 新增：`steer`（决策 093 不通过时改为 `interject`）、`fail-retry`、`image`、`file-attach`、`think`、`usage`、`job-notice`；`question` 等决策 098 落地后再加。
   - 目标、待办、后台任务、子代理这些界面场景归 P1-7。
   - 原计划的 READ-PAGE 已由 P1-4a 的真宿主集成测试覆盖，不进录制。
   - 每个子任务自己补场景，由编排者在 P1-4 收口时统一重录，代理不重录（沿用惯例）。
3. **渲染层回放测试**：新建 `src/renderer/stores/__tests__/dshStreamReplay.test.ts`，照 `nativeStreamReplay.test.ts` 的结构，把 `stream.*.json` 灌进真实 reducer，断言用户最终看到的内容。
4. **投影金样本测试**：已有（`src/shared/dshHistory/__tests__/dshHistoryGolden.test.ts`），新场景自动覆盖，不用另写。
5. **CI**：
   - `build.yml` 的 gate 加三步：`src/dsh-host` 执行 `npm ci`；取随包 node；`out-node-runtime/node src/dsh-host/tools/bridge-record.ts --check`；
   - 另建按分支或手动触发的 `dsh-bridge-gate.yml`；
   - 推送前要用户确认。
6. **GUI 点验清单**跟着新行为改：重开会话见历史、崩溃重启见中断注记、回退、fork、失败后「继续」、Ctrl+Enter（steer）、发图、文本附件、用量环、`/compact`、提问卡（决策 098 落地后）。放在 P1-14 的点验里一起做。

## 取舍

- **删掉录制门禁、只留单测**：单测用的是假 `DshBridgeContext`，看不到 DSH 真实的事件顺序和词表。总原则减少的是「移植 1.0.x」，不是「防 DSH 漂移」。
- **代价**：约 3.5 人日（场景与假网关约 1.5、回放测试约 1.5、CI 约 0.5）；开发机录制前要先确认可用内存大于 800 MB。

## 影响

- **金样本**：新增约 8 组，每组 stream、log、rpc 三份；已有的 `stream` 金样本在收口时全部重录一次（决策 099 的用量与投影快照会改动全部）。
- **roadmap**：P1-4 的退出判据不变（「录制门禁进 CI；开发机 GUI 点验主要场景」），场景清单按本决策细化。
