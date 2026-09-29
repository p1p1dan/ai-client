# 决策 051：迁移后逻辑 id 归 DSH 会话，旧 pi 行搬到新键下原样保留（请重点审批）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-9 方案 §5 D2](../topics/p1-9-migration.md#5-需要拍板的决策点)、[分片 04](../topics/p1-9-migration/04-index-rollback.md)。

## 规则

1. 一次原子索引写，同时做两件事：
   - 旧 pi 行原样复制到新键（示意为 `<逻辑 id>~pi`），只加一个 `migratedTo`。文件路径、`piLeaf`、标题、归档、`legacyImport`、`updatedAt` 都不变。
   - 原逻辑 id 这一行改绑到 DSH：`agent: dsh`，`runtimeIdentity` 指向桩，去掉 `piLeaf`，加上 `migratedFrom`（源 id、源路径、sha256、字节数、mtime、迁移时间）。
2. DSH 构建里：
   - 被 `migratedFrom` 引用、且源文件没变的 pi 行隐藏；
   - 源文件变了（说明回装后在 1.0.x 里续聊过），就显示出来并标「1.0.x 里有新内容」，再继续时迁成一个新会话；
   - 裁剪索引时不删被引用的 pi 行。
3. 迁移时，渲染层把这个会话的四个偏好键（模型、effort、档位等）复制一份到新键下，回装后档位和模型都还在。

## 为什么不能就地改

v1.0.3 只认 `agent: pi`，`dsh` 行一律隐藏（`d23d72aa:…/sessionIndexMerge.ts:108-117`）。就地把旧行改成 dsh，回装 1.0.x 后旧会话就从侧栏消失了，这违反决策 004「回装仍能读旧会话」。

## 取舍

- 不选「DSH 用新逻辑 id，旧行原样不动」：回装最干净，但渲染层要在一次发送的中途切换活动会话，容易出错。
- 代价：
  - 旧 pi 行换了键，回装后 1.0.x 对这类导入会话的去重会失效，重新导入会多出一份；
  - 索引超过 2000 行时，1.0.x 的裁剪可能删掉 dsh 行。

## 补记（2026-09-29，P1-9d，决策 122）

- 新键的字面量定为 `<逻辑 id>_pi`，不用示意里的 `~pi`：分叉的旧行以后会以这个键为逻辑 id 再迁移，`~` 做不了 DSH 会话 id（[决策 122](122-p1-9d-migration-orchestration-choices.md) 第 8 条）。
- 第 2 条的「隐藏」在 Main 的 `listForDisplay()` 里做，`chat:listSessions` 不再返回这些行；分叉的行带 `migrationDiverged` 返回（决策 122 第 10 条）。
- 第 3 条的偏好复制仍归 P1-9e：恢复的答复里给出 `migration.legacySessionId`。
