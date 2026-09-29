# 决策 056：CC / Codex 导入直接产出 DSH 会话，不再先写 pi

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-9 方案 §5 D8](../topics/p1-9-migration.md#5-需要拍板的决策点)。

## 规则

1. Main 侧的扫描与 `ImportedConversation` 不变。写入器换成宿主的 `seedSession {kind:'imported-conversation'}`（[决策 054](054-seed-session-host-op.md)）。
2. 展示行写成 ignorable 事件（[决策 053](053-ignorable-events-in-seeds-only.md)），界面与 1.0.x 一致，并且不进模型上下文。
3. 索引行写 `agent: dsh`，`runtimeIdentity` 指向桩。`legacyImport.targetPiSessionId` 是 ABI 字段名，保留不改，值改成 DSH 会话 id。去重要认迁移对。
4. 已经导入成 pi 的旧会话，走[决策 050](050-migrate-on-first-continue.md) 的迁移，不重新导入。

## 取舍

- 少一跳；native 写入器可以在 P1-12 删掉。「先写 pi 再转」没有好处。
- 代价：导入的去重规则要认迁移对。

## 补记（2026-09-29，P1-9f，决策 124）

- 第 1 条落地为 `seedSession` 的第二种 `kind`：`imported-conversation`，答复是带标签的导入结果；Main 侧由新模块 `DshLegacyImportHost` 发请求、自己看和删桩，`WorkerManager` 的三个导入方法与 `PiImportProcess` 不再有调用方，留到 P1-12 删（[决策 124](124-p1-9f-imports-produce-dsh-choices.md) 第 1、7、19 条）。
- 第 3 条的「值改成 DSH 会话 id」具体为桩名里的 id `aiclient-<逻辑 id>`；只有宿主顺延到 `_m<n>` 时它与实际会话 id 不同（决策 124 第 8 条）。
- 「去重要认迁移对」按分片 04 §5 实现，另外对账不会拿走迁移过的会话（决策 124 第 15、16 条）。
