# 决策 042：审批在我方宿主插件 `aiclient-permissions` 的 `tools/pre-execute` 里完成，加同步 guard 失败关闭

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-6 方案 §5 D2、D3](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[分片 02、03](../topics/p1-6-permissions/03-design.md)。

## 规则

1. 新增独立宿主插件行 `aiclient-permissions`，bridge 硬依赖它。每个虚拟 slot 持有一个 `PermissionGate`。宿主级路由把 `exec.agent` 归到根会话：子会话在 `session/created` 时按 header 里的 `parentSession` 登记，归属不到的调用一律拒绝。
2. 在 `tools/pre-execute`（prepend）里，由 `gate.authorize(request, exec.signal)` 完成我方的全部判定：
   - 四档；
   - 串行队列、120 s 倒计时、`allow_session`；
   - 加宽档位时收回活卡；
   - 拒绝清单。

   结果映射为：放行 → `next()`；拒绝 → `deny`，拒绝理由沿用 1.0.x 原文；取消 → `cancel`。审批通过后再复查一次 canonical 路径。
3. 同步 guard：这次调用没有得到放行判定，就拒绝。前面的监听者不调 `next()` 就返回，也在兜底范围内。
4. `approval/request` 的 answerer 只应答 DSH 自发的询问（越界升级、第三方插件），同一个 callId 最多一张卡。
5. 卡片经 bridge 往返：`permission.requested` 的字段与 native 相同；`worker.permission.respond` → `gate.respond`。

## 取舍

- 不选「pre-execute 返回 `ask`，交给 DSH 的审批服务」：
  - DSH 把子代理的审批策略钉死为 `never`（`dsh-subagent/lib/index.js:540`），子代理的写操作会被一律拒绝；
  - 请求不带工具参数；
  - 只有一次性授权。
- 不选「每个会话各自注册全局监听」（P0-3 的做法）：共享宿主下没法对归属不到的调用失败关闭。
- 代价：DSH 日志里没有 `approval/*` 审计对。权限审计行本来就不做（runtime-hardening 决策 027）。
- 开工前要先做小实验：子代理和 PTC 子调用是否经过全局 pre-execute；guard 能否兜住短路。
