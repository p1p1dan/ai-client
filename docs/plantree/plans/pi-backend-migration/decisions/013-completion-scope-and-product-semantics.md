# D13 — 功能补齐范围与上线语义

> **状态：Revised / partially active（2026-08-31）**
>
> Cycle 1/2 已落地的内联审批、队列、Extension UI、timeline 与模型语义继续有效；本文原定的 Cycle 3–5 顺序和 singleton-host 前提已由 [D14](./014-pi-only-product-and-conversation-import.md)、[D15](./015-main-owned-worker-manager.md) 与当前 [`roadmap.md`](../roadmap.md) 替代。
>
> 用户原拍板：2026-08-30。历史施工周期见 [功能补齐与上线周期](../topics/completion-cycles.md)。

## 决策

1. 当前所有 Partial、Pending、Deferred 节点全部进入连续排期；目标是 Phase 1～5 全部 Done 后上线实测，不再保留笼统后续池。
2. T13 本轮完成历史浏览、真实 resume、fork/rewind；永久删除不在范围内，禁止通过裁剪前端数组或截断 Pi JSONL 伪装回退。
3. T16 首版 GUI→TUI 语义是“同 workspace、同配置的新 Pi TUI 进程”，不承诺无损接管当前 GUI 内存会话。
4. 后台会话的权限审批只在所属会话显示，左侧会话行提供待处理徽标；不得恢复全局阻断 modal。
5. 模型允许多个标签，但只按首标签归入一个主菜单组；其他标签用于搜索/筛选，不重复模型项。
6. 模型 effort 直接复用 `reasoning` / `thinkingLevelMap`；切换模型后旧值不合法时回到 Automatic/模型默认，不维护第二份平行能力表。
7. T14 消息队列首版继续是仅内存状态，不承诺跨应用重启恢复，也不扩张成后台会话调度器。
8. T18 首版只持久化全局默认展示模式；历史会话启动时不得因为旧偏好自动 spawn TUI PTY。

## 权限策略连带决定

`~/.pilab/*` 的最终产品动作由 deny 改为 ask。该变更归 [D11](./011-default-permission-policy.md) rev.2；Q10 仍须先查明当前普通 read 与 `.pilab` 异常命中的技术根因，不能用动作改判掩盖 cwd、配置加载或 gate 匹配错误。

## 影响

- T09/T10/T14～T18 从 Deferred 改为 Planned，并分配到 Cycle 1～4。
- T25 从 Pending 改为 Planned，Q11 关闭。
- T08-b、T08-c、T13 的剩余切片均获得明确验收边界。
- 完成后唯一明确不交付的是永久删除和真正无损接管 GUI 内存态的 TUI handoff。
