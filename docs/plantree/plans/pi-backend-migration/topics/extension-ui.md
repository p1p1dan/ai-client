# Topic — Extension UI 产品契约与 WorkerSlot 适配

> Cycle 2 行为已完成并验证；本文件不是重新设计 UI，而是定义迁移到 D15 WorkerSlot 时必须保持的 contract。旧规划稿见 [history snapshot](../history/2026-08-31-pre-pi-only-realignment/topics/extension-ui.md)。

## Capability classes

| Class | 方法/示例 | GUI 行为 |
|---|---|---|
| Blocking portable | `select`、`confirm`、`input`、`editor` | session-local inline dock；FIFO、ACK/retry、dismiss fallback |
| Display portable | `notify`、`setStatus`、string-only `setWidget` | 独立 display store；toast/OS、status chips、above/below composer widgets |
| Semantic no-op | title/working/editor state 中产品已自行表达的方法 | 安静接受，不伪造 unsupported |
| TUI-only | component widget、footer/header/custom renderer、未知 future method | 按 session/runtime/method 聚合非阻断提示 |

shared capability table 是分类单一来源；unknown 默认 TUI-only。

## 已验证产品行为

- 窗口级 Extension UI modal 已退役；active session 在 Composer 邻近区域显示内联审批。
- 后台 session 只显示待处理徽标，切换过去才挂载请求内容。
- 四种 permission decision、session-local FIFO、keyed remount、send-in-flight、ACK 后移除、失败原位重试保持。
- Stop/timeout/session close/runtime reload 清理 pending request。
- fire-and-forget 不进入 blocking request map；已知 owner 时只定向 owner window，避免 mirror 重复通知。
- `extensionUi.reset` 独立清理旧 runtime display/unsupported，不依赖某个 dialog cancellation。
- status/widget/notification 有 per-value/per-runtime 数量和 byte bounds；widget 只接受 `string[]`。

证据见 [Cycle 2 execution](../evidence/2026-08-31-cycle2-execution.md)。

## WorkerSlot 适配要求

1. 每个 blocking request 必须携带 logical session、slot runtime identity、worker generation 和 request ID。
2. Main 只在所属 WorkerSlot/window owner 保存 blocking response route；display event 不进入 pending request map。
3. slot crash/dispose/restart/remap 必须：
   - cancel/retire blocking requests；
   - 发 display reset 或等价 lifecycle event；
   - 清 owner route；
   - 丢弃旧 generation 的迟到 event/response。
4. idle eviction 前有 pending blocking request 的 slot 不可淘汰。
5. slot 复用不得把前一 session 的 status/widget/unsupported/drafts 带入新 session。
6. mirror window 不得重复 toast/OS notification；owner 不存在时才允许受控 broadcast/fallback。
7. rewind/fork/session retirement 必须与 queue/pending/repository tombstone 一起清理，不只清 UI store。

## TUI action

Cycle 2 只显示“可在 Pi TUI 使用”的非阻断提示。真实 action 属于 T36：

- TUI 不可用时说明真实原因，不放空按钮。
- action 必须服从 GUI/TUI single-writer authority。
- 不承诺自动把尚未 flush 的 GUI 内存态无损交给 TUI。

## 禁止退化

- 恢复 window-wide modal/focus trap；
- 用 process-global FIFO 混合多个 session；
- 让 display event 永久占用 request target；
- 把 unknown method 静默当 portable；
- 以 HTML/component payload 绕过 text-only widget；
- crash 后等待旧 request 自己超时才清理。
