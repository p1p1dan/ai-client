# 决策 096：发图与读图直接用 DSH 的附件服务与 `read_image`，限额与归一化按 DSH

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-4、4c-5；
- [P1-4 分片 04 §3](../topics/p1-4-bridge-parity/04-turn-semantics.md)；
- `dsh-attachment/lib/types/index.d.ts:51`；`dsh-attachment/README.md:12`；`dsh-attachment-local/README.md:41,86`；`dsh-tool-fs/README.md:224`。

修订：替换[决策 010](010-p1-1-scope-boundary.md) 第 1 条里「带附件抛 `WORKER_DSH_UNSUPPORTED`」的安全桩。

**实现注记（2026-09-28，P1-4c2）**：按本决策落地，细节与自主取舍见[决策 112](112-p1-4c2-attachment-choices.md)：
- 第 1 条「bridge 行的 `inject` 要加上 `attachments`」指 Cordis 行的服务注入列表，已加（112 第 15 条）；
- 第 2 条的拒绝消息格式为 `<DSH 错误码> "<文件名>": <DSH 原句>`；DSH 的错误不指明哪一张，由 bridge 找出（112 第 3 条）；
- 第 5 条：模型没声明图片输入时 bridge 不拦，DSH 换成占位文字（112 第 10 条）；
- 第 6 条：回显与历史用同一个函数读 chip，图片的类型是 DSH 规范化后的（112 第 9 条）；
- 影响一节的 `image` 金样本：被拒的一张用边长超限的 PNG（`IMAGE_DIMENSION_TOO_LARGE`），不用超过 20 MiB 的大图（112 第 14 条）。

## 规则

1. **发图**：
   - bridge 把正文和图片交给 `ctx.attachments.admitPromptContent([{type:'text', text}, {type:'image', mediaType, data, name}…])`，用返回的 `ImageAttachmentRef` 组成 `user/message` 的 image 块，来源为 `user`；
   - 插话（决策 093）与普通发送共用这个入口；bridge 行的 `inject` 要加上 `attachments`。
2. **拒绝**：admit 失败（`AttachmentError`：格式、大小、像素、字节与类型不符等）时，在发出任何事件之前抛 `WORKER_ATTACHMENT_REJECTED`，带上 DSH 的错误码和文件名。渲染层走现有「附件被拒」的路径，把草稿退回输入框（P1-1 的 D2 修复）。
3. **限额以 DSH 为准**：
   - bridge 不再重复 1.0.x 的「单个 5 MiB」校验。那是 native 的防绕过（`runtime/plugins/agent-loop/attachments.ts:17-38`），渲染层与 Main 已经按 5 MiB 把关（`src/shared/types/attachmentIo.ts:36`），DSH 自己也有上限（单张 20 MiB、每条 20 张、合计 200 MiB）。
   - 用户能感到的上限仍是 5 MiB，不变。
4. **归一化按 DSH**：去 EXIF 与元数据，总像素压到 2048² 以内，长边不超过 8192，目标 4 MiB（`dsh-attachment-local/README.md:86`）。模型拿到的是处理后的图，不移植 1.0.x「原图直发」。
5. **读图**：
   - 用 DSH 的 `read_image`；`read` 只读 UTF-8，读图片时会提示改用 `read_image`（`dsh-tool-fs/README.md:224`）；
   - 不移植 1.0.x `read` 工具的图片分支（`7fe97881`）；
   - 模型支不支持图片输入，由 P1-5 计划里的 `input` 决定（`src/shared/dshModelPlan/build.ts:355`）；
   - 工具行文案归 P1-7c。
6. **回显与历史**：
   - `message.started`（user）带 `attachments: [{kind, mediaType, name}]`；
   - 历史从 image 块恢复附件信息，P1-4a 已做（`src/shared/dshHistory/projection.ts:135-147`）。
7. **迁移**：P1-9c 迁移旧会话里的图片，走同一个入库入口。

## 取舍

- 这一项本来就是 DSH 做法。重划只去掉 bridge 里那层 1.0.x 的重复校验。
- 代价：
  - 特别大的截图，模型看到的细节可能少于 1.0.3；
  - 附件永不自动删除（`dsh-attachment/README.md:12`），`DSH_HOME` 会随发图增长。现有日志清理（决策 024）不管附件。

## 影响

- **测试**：
  - `src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts` 的「refuses attachments instead of dropping them」改为 admit 成功与 admit 失败两组用例；
  - `src/renderer/components/chat/__tests__/sendRefusalWiring.test.ts` 的 D2 用例，拒绝码和注释要改成新的 `WORKER_ATTACHMENT_REJECTED`，否则会留下过期的静态测试。
- **金样本**：新增 `image` 场景（带一张 PNG 发送，回显和历史都有附件；另发一张超限的被拒）；假网关要回显收到的图片块数。
