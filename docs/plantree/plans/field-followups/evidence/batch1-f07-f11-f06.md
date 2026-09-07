# 批次一实现证据 — F07 / F11 / F06

> 日期：2026-09-07 · 分支：`feat/model-catalog-admin` · 环境：本机 Linux，约 1.9 GiB RAM。
> 本文件记录实际执行过的命令与结果。GUI 未点验，见文末「未验证项」。

## F07 — 启动阶段不再误报 `unverified`

### 判定

改的是**标签口径**，不是选择逻辑。`reconcileModelSelection` 早就区分了
「还没问」和「问过了没有」（`catalogLoaded`），标签这一路没跟着分，
所以目录为空的启动窗口里 `inCatalog` 恒 `false`，被读成「模型未验证」。

### 改动

| 文件 | 内容 |
|---|---|
| `chat/piModelCatalog.ts` | 新增 `isCatalogAuthoritative()`：只有 `proxy` / `managed` / `local` 算权威答复。比 `isCatalogLoaded` 严格——后者「已结束」即为真，失败也算 |
| `chat/models.ts` | 新增 `modelVerification()` → `verified` / `unverified` / `pending`；`catalogAuthoritative` 以布尔入参，与既有 `catalogLoaded` 同一范式 |
| `chat/usePiModelCatalog.ts` | 返回值增加 `authoritative` |
| `chat/ComposerModelTrigger.tsx` | `unknownLabel` 改由 `verification === 'unverified'` 决定 |

`stale-cache` 判为**非权威**：那是「刷新失败、屏幕上是旧答案」，
按它给模型定性等于把网络结果说成模型事实，正是验收第四条禁止的。
代价是目录不可达期间，真被下架的模型不会被标注——菜单下方的状态行已经说明目录不可达，
说真话优于猜。

### 测试

`models.test.ts` +5、`piModelCatalog.test.ts` +3。
覆盖未加载 / 命中 / 未命中 / 请求失败 / host 未就绪 / stale-cache / Automatic 哨兵 /
session 切换不复用上一个对象的判定。

## F11 — `@` 弹层不再超出画幅

### 判定

旧规则只看 Composer 的**模式**（`empty` 向下、`session` 向上），加一个写死的
`max-h-[240px]`。两半都是没量过的假设：窗口矮、草稿多行、输入法弹出都会缩小选中那一侧，
240px 于是伸出画幅。模式偏好本身没错，它只是不该是全部规则。

### 改动

| 文件 | 内容 |
|---|---|
| `chat/middleColumnLayout.ts` | 新增 `resolveComposerPopupPlacement()`（先能放下、再看偏好，高度一律夹到该侧实际空间）与四个常量；`mentionPopupPlacementClass` 入参由 mode 改为已解析的 side |
| `chat/useComposerPopupPlacement.ts`（新） | 测量 hook：`getBoundingClientRect` + `visualViewport.height`，订阅 window/visualViewport 的 resize 与 scroll，仅在弹层打开时生效 |
| `chat/ChatComposer.tsx` | 卡片挂 ref，mention 与 slash 共用一次测量结果；`maxHeight` 落在**整个弹层**上，列表改 `min-h-0 flex-1`，页脚 `shrink-0` |

两个细节：`visualViewport` 不是可选增强——输入法弹出不触发 `window.resize`，
只有它报告可见区域变化；`maxHeight` 从列表移到弹层外层，否则页脚约 28px 仍会越界。

### 测试

`middleColumnLayout.test.ts` +6：偏好侧放得下 / 放不下翻面 / 两侧都放不下时高度不超过该侧空间 /
偏好侧连最小高度都不够时取较大侧 / 锚点越界时夹到 0 而不是负值 / 可见视口缩小（输入法）时改判。

## F06 — 流式 `↓` 字符数

### 判定

`composerSendingLine` 原有一句注释说「没有 `↓`，Pi 只在 `turn_end` 报 usage」。
那句话对 **token 与金额**成立且保留，对**字符数**从来不成立：assistant 文本逐块到达 renderer，
`ChatBlock.text` 就在手里。改动把这条规则的适用范围写清楚，而不是删掉它。

第二个发现：`deriveTurnStatus` 在 `hasBlocks` 为真时切到**只剩时钟**的措辞，
而 `hasBlocks` 见到任意一个块（thinking、tool call 都算）就为真。
所以只把 `↓` 加进等待措辞，它永远不会在真正流式的时候出现在屏幕上——
计数必须同时进 streaming 分支。

### 改动

| 文件 | 内容 |
|---|---|
| `chat/chatTurn.ts` | 新增 `countAssistantReplyChars()`：只数 assistant 的 `text` 块，按 code point；thinking / tool / permission / question 一律不计；`h:` 回放消息不计 |
| `chat/countFormat.ts` | 新增 `replyCharsLabel()`：`↓ 128 chars` 或 `''`。两处措辞共用一份 |
| `chat/attachments.ts` | `composerSendingLine` 增加 `replyChars`，输出 `↑ … · ↓ … · Sent … · Ns` |
| `chat/turnStatus.ts` | 透传；streaming 分支输出 `↓ 128 chars · 6s` |
| `chat/MessageTimeline.tsx` | 从当前轮 `turn.body` 计算后传入 |

**新一轮清零不需要任何代码**：新一轮就是新 turn，body 从空开始。

### 测试

`chatTurn.test.ts` +6、`attachments.test.ts` +3、`turnStatus.test.ts` +2。
覆盖无文本不显示、只有 thinking/tool 为 0、跨块跨消息累加、code point 计数（CJK + emoji）、
回放消息不计入、`↑`/`↓` 顺序与附件子句位置、streaming 头随流增长。

## 执行过的命令

| 命令 | 结果 |
|---|---|
| `npx vitest run src/renderer/components/chat/__tests__ --maxWorkers=1 --no-file-parallelism` | 78 文件 / 1757 项通过 |
| `npx vitest run src/renderer/components/workspace-shell/__tests__ src/renderer/App/__tests__ src/renderer/hooks/__tests__ --maxWorkers=1 --no-file-parallelism` | 35 文件 / 507 项通过 |
| `NODE_OPTIONS=--max-old-space-size=1200 npx tsc --noEmit` | 通过，无输出 |
| `npx biome check .` | 983 文件，**0 error**；27 warning / 17 info 均为既有 |

整套 tsc 这次在 1200 MiB 堆上限下跑通（上一计划记录的 896 MiB 会 OOM，本轮据此上调）。
未运行整套生产构建，未启动 Electron。

## 未验证项

1. **GUI 点验**：三项都改的是屏幕上的东西，自动化只能证明纯函数与措辞。
   并入 UI 对齐计划的累计点验：冷启动看模型名不带 `· unverified`；
   矮窗口 + 多行草稿下开 `@` 弹层完整可见；发送后状态行出现并持续增长的 `↓`。
2. **真实输入法**：`visualViewport` 分支只有数值层断言，未在真实 IME 下验证。
3. **目录请求失败的真实链路**：`stale-cache` / `unavailable` 由构造记录断言，
   未在断网条件下跑过真实 App。
