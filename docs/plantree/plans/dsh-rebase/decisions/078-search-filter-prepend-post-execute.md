# 决策 078：搜索结果过滤挂在 prepend 的 post-execute 上，过滤到内容时直接返回（修订决策 048 第 2 条）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：P1-6b 实验 3（`src/dsh-host/tools/perm-experiments.ts`）、[决策 048](048-filter-search-results.md)。

## 事实

决策 048 第 2 条假设「我方 post-execute 排在 fs-search 下游」。实测相反：不加 prepend 的 post-execute，按激活顺序排在 fs-search **上游**，glob 已经把含 `.env`、`server.key` 的完整清单写进了 spill 文件。

## 规则

1. 过滤监听改为 prepend。结果里命中拒绝清单时，不调 `next()`，直接返回过滤后的 value。这样之后不再落盘，结果内容和 meta 里也都没有被过滤的项。
2. 没有命中时照常调 `next()`，行为与 DSH 原样相同。
3. 用例钉住：glob 与 grep 在含密钥文件的工作区里，结果与 spill 都不含这些文件。

## 代价

被过滤的那一次调用，会跳过 DSH 的 repeat-tool-reminder；模型也拿不到「完整清单已存到某处」的提示。只影响命中拒绝清单的那一次。
