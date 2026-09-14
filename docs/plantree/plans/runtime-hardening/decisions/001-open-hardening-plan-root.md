# 决策 001：为修补与收口另开计划根，runtime-evolution 收口为参考与证据基线

日期：2026-09-14。状态：已采纳。

## 背景

runtime-evolution 的核心任务树在 2026-09-13 记「全部节点已执行完，只剩现场」。2026-09-14 的只读审计确认 185 条缺陷，其中 10 条 high，涉及 P0～P6 几乎每个阶段；同时审计对 22 个节点的 ✅ 提出异议。用户问：现有任务树是否归档、另建新树。

## 选项

1. 在 runtime-evolution 里加一个「P7 加固」阶段。
2. 另开 runtime-hardening 计划根，runtime-evolution 收口为参考与证据基线，文件不搬。
3. 把 runtime-evolution 整体搬到 history 归档，新树从零开始。

## 决定：选项 2

- 旧树 README 已 243 行、20 个 topics、20 个 evidence 目录，ARD、进度看板、记忆文件、Windows 证据里几百条链接指向它。物理搬迁（选项 3）只会断链，没有检索收益。
- 旧树的所有权是「把 runtime 做出来」，新计划是「把它修到可发布并上机」；两者的任务身份体系不同（节点 vs 修补任务），混在一个 roadmap 里（选项 1）会让 243 行再涨一倍，且旧节点的 ✅ 与新任务的状态互相污染。
- 本仓已有先例：gui-sdk-experience 并入 runtime-evolution 后「保留为功能与验收参考，不再作为独立执行状态源」。runtime-evolution 现在走同一条路。

## 落地形态

- `docs/plantree/README.md` 注册表：runtime-evolution 状态改为「已收口（参考与证据基线）」，runtime-hardening 为唯一活跃执行计划。
- 根级 `进度看板.md` 改为 runtime-hardening 的看板；旧看板最后一版原样存入 `runtime-evolution/history/2026-09-14-进度看板-收口快照.md`。
- runtime-evolution/README.md 只在头部加一段指向审计与新计划，节点状态表不重写；审计对节点的异议以审计证据第五节为准。
- 审计证据放在 `runtime-evolution/evidence/runtime-audit-2026-09-14/`：它审的是旧树的落地情况，属于旧树的 evidence；新计划链接它。

## 后果

- 旧树的 ✅ 不再是「可发布」的判据；「可发布」由 runtime-hardening 的 roadmap 说了算。
- 旧树不再更新，除非是修补落地后回写「已修」的一行引用。
- 回退方式：删除 runtime-hardening 目录、恢复注册表与看板即可，旧树文件未动。
