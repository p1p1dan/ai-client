# 决策 097：文本附件改为 DSH 文件块，由模型按需读取（需用户拍板）

日期：2026-09-28。**状态：自主决定，待用户审批（需用户拍板）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-6、§5；
- `dsh-attachment/README.md:40,106`；`dsh-attachment/lib/types/index.d.ts:97`；`dsh-attachment/lib/types/types.d.ts:34-41,97-102`；`dsh-attachment-local/README.md:90`；`dsh-llm/lib/index.js:2268-2277`。

修订：P1-4 分片 04 §3 第 1 条原定「文本附件照 native 的方式并进 text，不用 FileBlock」，改为用 FileBlock。

## 规则

1. **存成文件块**：文本附件不再并进正文。bridge 调 `ctx.attachments.saveFile({data, name})` 得到 `FileAttachmentRef`，以 `{type:'file', attachment}` 块放进这条 user 消息；`admitPromptContent` 原样放行文件块。
2. **模型看到的**：一行句柄，写着文件名、字节数、摘要前缀和只读路径，需要时自己用 `read` 去读（`dsh-attachment/README.md:40,106`）。
   - 路径由 `fs.processPathFromHostPath` 给出，文件落在 `<DSH_HOME>/attachments/v1/files/…`，是只读硬链接（`dsh-attachment-local/README.md:90`）。
3. **权限**：
   - 读附件库 `<DSH_HOME>/attachments/v1/` 算作宿主产生的可信路径：扩展 `isTrustedPath`（现在只认 spill 目录，`src/dsh-host/permissions/permissionHost.ts:141-145,196`），不出审批卡；
   - 显式的 deny 规则照旧生效；图片附件的只读路径同样适用。
4. **回显与历史**：文件块投影成 `{kind:'text', mediaType:'text/plain', name}` 附件 chip，P1-4a 已做（`src/shared/dshHistory/projection.ts:148-153`）；气泡里只显示用户自己写的正文。
5. **上限**：渲染层与 Main 的单个 5 MiB 不变；DSH 对文件不设类型和大小上限。
6. **开工前实验**：共享宿主、沙箱关闭（决策 044）时，句柄里的路径能被 `read` 直接读到，过闸时判为可信路径。不成立就退回「保留 1.0.x 的做法」。

## 取舍

- **保留 1.0.x 的做法**（以 `--- name ---` 并进正文，`runtime/plugins/agent-loop/attachments.ts:85-138`）：
  - bridge 约 30 行；
  - 但 DSH 日志里 user 消息的正文就是整个文件，历史重读时气泡会把文件内容当正文显示，要另加投影规则把附件段拆出来（1.0.x 靠 native 的 rider 做这件事）；
  - 5 MiB 的文本会一次塞满上下文。
- **DSH 文件块**：这是 DSH 对非图片附件的原生形态。大文件不占上下文，历史干净。
  - 代价：模型多一次读取；偶尔可能不读就作答；要一条可信路径规则与一个实验。约 1.5 人日。

**用户看得见的不同**：
- 模型通常先调一次「读取」再作答，时间线里多一行读取，但不出审批卡；
- 大文件不会一次塞满上下文；
- 模型偶尔可能不读附件就回答；
- 气泡里只显示正文，附件是一个 chip。

**如果用户不同意**：保留并进正文，另加投影规则拆附件段，约 1 人日。

## 影响

- **测试**：`src/dsh-host/permissions/__tests__/permissionHost.test.ts`（可信路径）；`src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts`（文件块组装）。
- **金样本**：新增 `file-attach` 场景（发一个文本附件，模型读取后作答；历史里有附件 chip）；假网关要能按句柄路径发起一次 `read`。
- **P1-13**：附件副本落在 `DSH_HOME` 下，属于新建文件，不加密。用户已表示不加密可以接受（决策 090），检查单可以注明。
- **迁移**：迁移会话里 1.0.x 并进正文的文本不变。
