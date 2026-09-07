# Roadmap — 现场反馈待办 6–11

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 需求原文（目标 / 实施范围 / 验收）在 [`待办任务执行计划.md`](../../../../待办任务执行计划.md)；
> 本文件只维护任务身份、状态、依赖，以及原文没写的**落点**与**判据**。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 0 | — |
| In Progress | 4 | F07 / F11 / F06 / F08 已实现，自动化通过；GUI 与真实请求头未验证 |
| Next | 2 | F09 → F10 |
| Deferred | 0 | — |
| 另立任务 | 0 | — |

## 执行顺序

```text
批次一（前端即时问题，互不依赖，按可见度排序）
  F07 启动阶段误报 unverified
  F11 @ 弹层超出画幅
  F06 流式 ↓ 字符数
批次二（Pi 配置链路）
  F08 Pi 请求自定义 User-Agent
批次三（应用级通知）
  F09 启动公告 + 铃铛 + 隐藏“...”菜单
批次四（账户额度）
  F10 本月调用次数 → 周限额金额
```

顺序取自需求原文的「执行顺序」段。批次一三项之间没有代码依赖，排序只反映用户看得见的程度：
`unverified` 每次启动都出现，弹层超框在特定窗口高度下必现，`↓` 是新增信息。

## 通用门禁

每个任务合入前：`pnpm lint` · `pnpm typecheck` · `pnpm test`。
本机是资源受限的小服务器，测试按小批次执行（`--maxWorkers=1 --no-file-parallelism`），
不跑整套生产构建；未跑到的门禁如实记在 [implementation-status](./implementation-status.md)，不写成全绿。

**每个任务至少一条纯函数层断言。** 仓库的 vitest 是 `environment: 'node'` 且只收 `*.test.ts`，
所以任何写在 `.tsx` 里的判断都没有自动化覆盖——决策必须先落到纯模块，才谈得上验收。
需要真实渲染时用 `// @vitest-environment happy-dom` + `react-dom/client`，
范式见 `components/settings/__tests__/SettingsContent.test.ts`。

GUI 点验并入 [UI 对齐计划](../pix-ui-alignment/README.md)的累计点验。

---

## 批次一：聊天交互与模型选择

### F07 — 启动阶段不再误报 `unverified` · **In Progress**

**现象**：App 刚启动、目录还没回来时，Composer 显示 `grok/grok-4.6 · unverified`。

**根因**：`ComposerModelTrigger.tsx` 的 `unknownLabel` 只看 `inCatalog`：

```ts
const unknownLabel = isAutomatic || inCatalog ? undefined : unverifiedModelLabel(model);
```

目录未加载时 `catalogOptions` 是空数组，`inCatalog` 恒为 `false`，于是「还没问过」被显示成
「问过了，目录里没有」。选择逻辑本身没有这个 bug——`reconcileModelSelection` 早就用
`catalogLoaded` 把两者分开了（models.ts 的 B17 注释写明「we have not asked yet 与 the catalog
does not contain it 不是同一个事实」）；**漏的是标签这一路没有跟着分**。

第二个洞：`isCatalogLoaded` 只排除 `host-not-ready`，所以 `source: 'unavailable'`
（fetch 失败且无缓存）也算 loaded，网络失败会被直接说成模型未验证——正是需求原文第四条验收禁止的。

- **做什么**：在 `piModelCatalog.ts` 增加一个纯函数，把「模型相对目录的验证状态」判为三值
  （`verified` / `unverified` / `pending`），判据是目录是否给出**权威答复**
  （`source` ∈ `proxy` / `managed` / `local`），而不是 `catalog !== null`。
  `ComposerModelTrigger` 与菜单行的 `verified` 标记都改读它；`pending` 时保留模型名、不加后缀。
- **不做**：不改 `reconcileModelSelection` 的选择优先级，不改目录请求时机。这是显示口径问题，
  改选择逻辑会顺带改变发出去的 model 字段。
- **验收**：纯函数真值表覆盖「未加载」「加载成功且命中」「加载成功未命中」「请求失败」
  「host 未就绪」「stale-cache」六种输入；session 切换时不复用上一个对象的状态
  （已由 `pairChanged` 覆盖，补一条断言防回归）。
- **依赖**：无。
- **落地**：`isCatalogAuthoritative`（piModelCatalog）+ `modelVerification`（models）+ trigger 接线。
  `stale-cache` 判为非权威。证据见 [批次一](./evidence/batch1-f07-f11-f06.md)。

### F11 — `@` 文件引用弹层不再超出画幅 · **In Progress**

**现象**：底部输入框打开 `@` 弹层时弹层被画幅裁掉。

**根因**：`middleColumnLayout.ts` 的 `mentionPopupPlacementClass(mode)` 只按 Composer 的
**模式**二选一（`empty` 向下、`session` 向上），与实际可用空间无关；
弹层高度又是写死的 `max-h-[240px]`。窗口矮、输入框多行、或空态卡片靠下时，选中的那一侧放不下，
弹层就伸到画幅外。slash 弹层用同一个函数，同一个毛病。

- **做什么**：新增纯函数按 viewport 实测空间决定方向与最大高度
  （输入：锚点上下沿、viewport 高度、期望高度、边距、最小可用高度；输出：`side` + `maxHeight`），
  在 `ChatComposer` 用 `getBoundingClientRect` 喂它，并订阅 resize 与 `visualViewport`
  （输入法弹出走的是这条，不是 window resize）。两个弹层共用同一结果，保持定位一致。
- **不做**：不引入 floating-ui 之类的新依赖——两个弹层都锚在自己的相对容器上，
  需要的只是一次测量和一个 max-height，换定位库的成本和风险都远大于收益。
- **验收**：纯函数覆盖「上方够/下方够/两侧都不够取较大者/结果高度不超过可用空间」；
  长文件名与长路径不撑破弹层（已有 `truncate`，补一条静态断言防回归）。
- **依赖**：无。
- **落地**：`resolveComposerPopupPlacement`（纯）+ `useComposerPopupPlacement`（测量）；
  `maxHeight` 落在整个弹层而非列表，否则页脚仍会越界。证据见 [批次一](./evidence/batch1-f07-f11-f06.md)。

### F06 — 发送状态显示流式回复字符数 · **In Progress**

**现状**：`attachments.ts` 的 `composerSendingLine` 只有 `↑`，且注释明写
「There is no `↓` counterpart: Pi reports usage only at `turn_end`」。
那句话对 **token/usage** 成立，对**字符数**不成立——assistant 文本本身是逐块到达 renderer 的，
`ChatBlock` 里就有 `text`。所以本任务的第一步是推翻那条注释的适用范围，并在注释里说清楚
为什么字符数可以而 token 不可以。

- **做什么**：
  1. 纯函数：从一轮的 body 里数 assistant **文本**块的字符数（code points，与 `↑` 同口径），
     `thinking` / `tool_call` / `tool_result` / `permission_*` / `question` 一律不计。
  2. `composerSendingLine` 增加可选 `replyChars`，`> 0` 才输出 ` · ↓ N chars`，
     位置在 `↑` 之后、附件/重试之前，形成 `Percolating… · ↑ 2 chars · ↓ 128 chars · 6s`。
  3. `deriveTurnStatus` 透传；`MessageTimeline` 从当前轮 body 计算后传入。
- **为什么从 body 数而不是在 store 里累加**：计数与屏幕上真正渲染的文本同源，
  不需要新的 store 字段（`chatSessions.ts` 是 red-line 文件），
  而且「新一轮清零」由「新一轮是新 turn、body 从空开始」天然保证，无需额外的重置逻辑。
- **验收**：`composerSendingLine` 的措辞按字断言（该文件既有范式）；
  计数函数覆盖「无 assistant 文本 → 0 → 不显示」「只有 thinking/tool → 0」「多块累加」
  「历史回放消息不计入本轮」。
- **依赖**：无。
- **落地时发现的第二个洞**：`deriveTurnStatus` 在 `hasBlocks` 为真时切到只剩时钟的措辞，
  而任意一个块（thinking / tool call）就会让它为真。只把 `↓` 加进等待措辞，
  它永远不会在真正流式时出现，所以 streaming 分支也必须带上——两处共用
  `countFormat.ts` 的 `replyCharsLabel`。证据见 [批次一](./evidence/batch1-f07-f11-f06.md)。

---

## 批次二：Pi 模型配置与请求头

### F08 — Pi 请求带自定义 User-Agent · **In Progress**

目标请求头 `User-Agent: claude-cli-pilab/<app.getVersion()>`，取代 pi 默认的
`pi (win32 10.0.26100; x64)`。

**落点已经存在，缺的是接线**：`PiManagedProviderDefinition.headers` 与它的校验
（`configValidation.ts`：值必须以 `$` 开头，即只能引用环境变量）都已就位，
`toPiModelsJson` 是**唯一**写 `models.json` 的路径，`writeAll` 的三个调用点
（新鲜远端 / 10 分钟内的缓存复写 / stale-cache 回退）全部经过它。因此：

- **做什么**：
  1. `shared/piModelConfig.ts` 增加 `PI_USER_AGENT_ENV = 'AICLIENT_PI_USER_AGENT'`
     与 UA 前缀常量。
  2. `resolveManagedPiWorkerEnv()` 注入该变量，值由 `app.getVersion()` 拼成；
     Worker 与 PTY 两条环境都要有（PTY 剥的是 borrow/opt-in 两个键，不该剥这个）。
  3. `toPiModelsJson` 为每个 provider 补 `headers['User-Agent'] = '$AICLIENT_PI_USER_AGENT'`，
     **管理端已显式配置同名头时不覆盖**——管理员的配置比我们的默认更具体。
- **不做**：不用类型逃逸绕过 `validateProvider` 的 `$` 前缀校验（需求原文点名禁止）。
  注入发生在校验之后、序列化之前，写进去的就是一个合法的环境变量引用。
- **验收**：`models.json` 三条写入路径都带 provider headers；env 里的版本号来自 `app.getVersion()`；
  一条断言证明管理端自带的 `User-Agent` 不被覆盖。
  真实 HTTP 头的捕获属联调项，若本机无法执行则如实记录，不写成已验证。
- **依赖**：无。
- **落地**：注入点在 `toPiModelsJson` 内部（唯一写 `models.json` 的函数，三条写入路径都过它），
  写的是 `$AICLIENT_PI_USER_AGENT` 引用而非字面量，因此仍在 `validateProvider` 的规则之内。
  PTY 环境保留该变量——它是 pi 自己读的，与 borrow / opt-in 两个只有我们读的变量不同。
  真实 HTTP 头未捕获。证据见 [批次二](./evidence/batch2-f08.md)。

---

## 批次三：启动公告与顶部铃铛

### F09 — 每次启动自动弹出的公告通知 · **Next**

- **做什么**：Main 侧公告获取服务（沿用模型管理页的服务地址，即
  `getOnboardingServiceUrl()`）+ 缓存与已读状态 + preload IPC + Renderer 铃铛按钮 + 启动自动弹窗。
  顶部“...”按钮换成铃铛，位置不变；Reload / Developer Tools / GitHub / Exit 全部隐藏，不另设入口。
- **注意**：`WindowTitleBar` 只在非 macOS 渲染（`isMac` 时整个返回 `null`），
  而它的注释说明这条 bar 是 onboarding/welcome 壳唯一的 chrome。铃铛因此不能只放在这里，
  否则 macOS 上没有任何公告入口——放置方案必须在实现前定下来并写进证据。
- **风险**：网络失败、超时不得阻塞启动；弹窗不得阻塞主界面加载。
- **验收（契约段）**：拉取失败 / 超时 / 空公告 / 多条公告 / 重复公告的判定逻辑有纯函数覆盖；
  静态断言证明旧“...”菜单四项不再存在。
- **验收（联调段）**：真实接口返回时启动弹窗——需 onboard 部署，未完成前不勾。
- **依赖**：无代码依赖；联调依赖 onboard。

### F10 — 本月调用次数改为周限额金额 · **Next**

- **做什么**：`shared/types/usage.ts` 扩展周限额字段（已用金额 / 上限 / 周期结束时间），
  `UsageService` 适配 onboard 接口，`useUsageStats` 与 `UserProfileCard` 改显示，
  紧凑版 `UserFooterPill` 同步检查。
- **注意**：`UserProfileCard` 现在有四个硬编码中文 `'暂不可用'`，本任务顺手让它们走 `t()`；
  未配置额度时显示「暂不可用」，不得出现 `NaN` 或错误百分比。
- **验收（契约段）**：金额格式化与进度计算的纯函数覆盖「正常」「未配置」「超限」「登出清理」四种；
  网络失败不影响用户信息与退出登录。
- **验收（联调段）**：真实接口的周期字段与刷新——需 onboard 部署。
- **依赖**：无代码依赖；联调依赖 onboard。
