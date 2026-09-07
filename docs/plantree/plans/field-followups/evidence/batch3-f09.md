# 批次三实现证据 — F09 启动公告与铃铛

> 日期：2026-09-07 · 分支：`feat/model-catalog-admin`。

## 开工前的两个决定（用户 2026-09-07 裁定）

### 1. 铃铛放左侧栏底部，不放标题栏

需求原文写「铃铛放在原『...』按钮的位置」。那个按钮在 `WindowTitleBar`，
而该组件 **在 macOS 上整个返回 `null`**（macOS 用原生 hiddenInset 标题栏）。
照字面实现，三个已发布平台之一将没有任何「事后再看一遍公告」的入口。

选项摆给用户后，裁定为**三个平台统一放左侧栏底部**（`UserFooterPill`，账户 pill 右侧）：
一个渲染点、无平台分支，也正是 D07/D08 当初把标题栏承载的应用级 chrome 搬去的地方。
代价是不符合原文字面，这一点是明确接受的。

### 2. 公告端点不鉴权

裁定为公开端点 `GET {onboarding 服务}/api/v1/announcements`，**不带 `Authorization`**。
理由：公告最该送达的正是登录已过期、盯着登录页不知为何的人。
代价是内容对能访问该服务的任何人可见，因此**此端点永不得承载用户相关或机密内容**——
这条写进了 `shared/announcements.ts` 的模块头。

## 改动

| 文件 | 内容 |
|---|---|
| `shared/announcements.ts`（新） | 契约 + 四个纯函数：`parseAnnouncements` / `unreadAnnouncementIds` / `shouldOpenAnnouncementsOnStartup` / `mergeReadAnnouncementIds` |
| `main/services/announcements/AnnouncementService.ts`（新） | 拉取、磁盘缓存、已读状态；单飞；任何方法都不抛 |
| `main/services/announcements/index.ts`（新） | 端点地址（沿用 onboarding 服务地址，同 D05）+ 懒初始化 |
| `main/ipc/announcements.ts`（新）· `shared/types/ipc.ts` · `main/ipc/index.ts` | 三个 channel：`get` / `refresh` / `markRead` |
| `preload/index.ts` | `announcements` 三个方法 |
| `renderer/components/announcements/`（新三件） | `useAnnouncements` / `AnnouncementBell` / `AnnouncementDialog` |
| `renderer/components/workspace-shell/UserFooterPill.tsx` | 挂载铃铛 |
| `renderer/components/layout/WindowTitleBar.tsx` | 删除「...」菜单及 Reload / Developer Tools / GitHub / Exit 四项 |
| `shared/i18n.ts` | 新增四条公告文案；删除 `Developer Tools` 译文（它标注的控件已不存在） |

### 关键判断

**「不阻塞启动」是硬要求，落成三条具体规则：** IPC 层三个 handler 都不 reject
（result 记录自带 `source: 'unavailable'` 与原因）；hook 里两次调用都是 `void`，
不在 shell 依赖的任何路径上 await；失败就保持初始空结果，界面上没有错误分支要画。

**先读磁盘再打网络。** `get()`（纯磁盘）与 `refresh()`（网络）走同一个 `apply`，
所以离线启动能立刻显示缓存的公告，而不是等一个注定超时的请求。

**缓存没有 TTL、也没有「新鲜就不问」这一档。** 与模型目录不同：每次启动都问，
缓存只是问失败时的兜底。一个可以**替代**询问的缓存，会让已撤回的公告活过它的撤回。

**已读集合会剪枝。** 只保留服务端当前仍在发的 id。否则集合无界增长，
而且服务端撤回后又复用同一 id 时，公告会「一到就是已读」，用户永远看不到。

**弹窗每次启动都开，不看已读状态**——这是已确认的产品口径，
`shouldOpenAnnouncementsOnStartup` 的注释写明这是有意为之而非漏判。已读状态服务于铃铛的未读点。
hook 里有 `openedRef` 闩锁：一次启动只自动开一次，晚到的 `refresh()` 不会在用户关掉后再弹回来。

**正文按纯文本打印**（`whitespace-pre-wrap` + `break-words`），不是 markdown 也不是 HTML。
在应用自己的 chrome 里解释远端内容，公告通道恰恰是最不该这么做的地方。

## 测试

- `shared/__tests__/announcements.test.ts`（新，14 项）：envelope 与裸数组都收、
  任何异常输入都答空而不抛、空白卡片被丢弃、重复 id 折叠、未知 severity 降级不丢消息、
  条数与正文长度封顶、缺 `publishedAt` 不编造；启动弹窗的三条规则；已读的合并与剪枝。
- `main/services/announcements/__tests__/AnnouncementService.test.ts`（新，10 项）：
  拉取与缓存、**不发 Authorization 头**、离线回落缓存、无缓存报 unavailable、
  HTTP 错误与超大响应都算失败、损坏缓存文件不致崩、`snapshot()` 零网络调用、
  已读剪枝、登出清理、并发单飞。
- `renderer/components/announcements/__tests__/announcementWiring.test.ts`（新，7 项）：
  铃铛挂在 footer 而非标题栏；先磁盘后网络的顺序；hook 里没有 `await ...announcements`；
  正文不走 markup；**标题栏不再出现 MoreHorizontal / MenuTrigger / openDevTools / window.close**，
  且这四项没有换个地方长回来。
- `main/ipc/__tests__/onboardingLogoutSequence.test.ts` +1：登出序列的 ⑥b 步确实调用
  `clearReadState()`，且位置在 `vault.clear` 之后、`signed_out` 广播之前。

## 执行过的命令

| 命令 | 结果 |
|---|---|
| `npx vitest run src/shared/__tests__/announcements.test.ts` | 14 项通过 |
| `npx vitest run src/main/services/announcements/__tests__` | 10 项通过 |
| `npx vitest run src/renderer/components/announcements/__tests__` | 7 项通过 |
| `npx vitest run src/renderer/components/workspace-shell/__tests__ src/renderer/App/__tests__ src/main/ipc/__tests__ src/renderer/components/settings/__tests__ src/shared/__tests__` | 59 文件 / 766 项通过 |
| `npx vitest run src/main/__tests__ src/shared/types/__tests__ src/renderer/stores/__tests__` | 32 文件 / 394 项通过 |
| `NODE_OPTIONS=--max-old-space-size=1200 npx tsc --noEmit` | 通过 |
| `npx biome check .` | 993 文件，0 error |

## 服务端已落地（2026-09-07 同日）

`jyw-cch-onboarding` 已实现两个端点，提交 `5993d84`：

- `GET /api/v1/announcements`——不鉴权、`no-store`、按 enabled + 时间窗筛选、
  按 `sortOrder` 再按最新排序、per-IP 限流。
- `/api/admin/announcements` CRUD——复用 `MODEL_ADMIN_TOKEN`，未配置时 503。

**跨仓契约已验证**：从该服务真实 handler 抓下的响应，作为 fixture 写进
`shared/__tests__/announcements.test.ts` 的 contract 段，喂给本仓的 `parseAnnouncements`
与 `shouldOpenAnnouncementsOnStartup`，断言解析结果与「会弹窗」。
两半在不同运行时、不同测试框架下，这是唯一真正把它们对上的一处。

服务端侧门禁（在装好 Bun 的本机执行）：`bun test` 170 项通过、`bun run typecheck` 通过、
`bunx biome check .` 65 文件 0 error、`bun run build:web` 成功。

## 未验证项

1. **真实部署联调**：上述验证用的是服务端 handler 的真实输出，但服务**尚未部署**；
   真机上「启动 → 拉取 → 弹窗」的整条链路未跑过。
2. **GUI 点验**：铃铛外观与位置、弹窗在窄窗口与长内容下的表现、
   顶部「...」确实消失，均未跑真实 Electron。
3. **登出清理**：`clearReadState()` 已接进 `performLogoutSequence` 的 ⑥b 步
   （不受 flag 门控、失败不影响登出返回值），顺序由 `onboardingLogoutSequence.test.ts` 断言，
   但未跑真实登出。缓存的公告本身**不清**——登出后的窗口仍应能看到已有公告。
