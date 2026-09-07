# 现场反馈待办 6–11 执行清单

> 本文件提供执行进度视图；任务身份、状态与依赖以 [roadmap.md](./roadmap.md) 为准，
> 当前阶段、阻塞与验证结果以 [implementation-status.md](./implementation-status.md) 为准。
> 实现完成不等于验收完成；只有实现与验收都完成才勾选。

## 开工准备

- [x] 读需求原文，抄录四条已确认产品口径。
- [x] 逐项定位落点与根因（六项，见 roadmap 的任务条目）。
- [x] 确认测试环境：vitest 为 node env 且只收 `*.test.ts`，React 测试用 happy-dom docblock。
- [x] 每项动工前确认工作区干净、当前分支状态已知。

## 任务进度

- [ ] **F07：启动阶段不再误报 `unverified`。** 三值验证状态纯函数 + trigger/菜单接线 + 六种输入真值表。
- [ ] **F11：`@` 弹层不再超出画幅。** viewport 实测定位纯函数 + 两个弹层接线 + resize/visualViewport 订阅。
- [ ] **F06：流式 `↓` 字符数。** 文本块计数纯函数 + `composerSendingLine` 分句 + 状态链路透传。
- [ ] **F08：Pi 自定义 User-Agent。** env 常量与注入 + `toPiModelsJson` 补 provider headers + 不覆盖管理端同名头。
- [ ] **F09：启动公告与铃铛。** Main 服务 + 缓存/已读 + IPC + 铃铛 + 启动弹窗 + 隐藏旧“...”菜单。
- [ ] **F10：周限额金额。** usage 类型扩展 + 服务适配 + 卡片与紧凑 pill 显示 + 未配置/超限状态。

## 批次一明细（[证据](./evidence/batch1-f07-f11-f06.md)）

- [x] F07：`isCatalogAuthoritative` + `modelVerification` + trigger 接线；8 项断言通过。
- [x] F11：`resolveComposerPopupPlacement` + 测量 hook + 两个弹层接线；6 项断言通过。
- [x] F06：`countAssistantReplyChars` + `replyCharsLabel` + 等待措辞与 streaming 头；11 项断言通过。
- [x] chat 目录 78 文件 1757 项、相邻三目录 35 文件 507 项通过；整套 tsc 通过；全仓 lint 0 error。
- [ ] GUI 点验（冷启动模型名 / 矮窗口 `@` 弹层 / 流式 `↓`）——并入 UI 对齐累计点验。

## 批次二明细（[证据](./evidence/batch2-f08.md)）

- [x] F08：`PI_USER_AGENT_ENV` 等常量、Worker/PTY 环境注入、`toPiModelsJson` 补 provider headers。
- [x] 三条 `models.json` 写入路径都带 header；管理端自带的 `User-Agent`（两种大小写）不被覆盖。
- [x] piModelConfig 2 文件 40 项、主进程三目录 27 文件 286 项通过；整套 tsc 通过；全仓 lint 0 error。
- [ ] 联调：捕获真实出站请求头，确认 `User-Agent: claude-cli-pilab/<版本>` 生效。

## 批次三明细（[证据](./evidence/batch3-f09.md)）

- [x] 定下两个开工前决定：铃铛统一放左侧栏底部；公告端点不鉴权。
- [x] F09：shared 契约与四个纯函数、Main 服务（拉取/缓存/已读/单飞）、三个 IPC channel、
      preload、铃铛与弹窗、登出 ⑥b 清已读。
- [x] 删除标题栏「...」菜单及四项，补静态不变量测试断言它们没有换地方长回来。
- [x] 新增 31 项 + 登出序列 1 项通过；五个目录 766 项、三个目录 394 项通过；
      整套 tsc 通过；全仓 lint 0 error。
- [ ] 联调：onboard 部署 `/api/v1/announcements` 后核对字段与真实启动弹窗。
- [ ] GUI 点验：铃铛外观位置、窄窗口与长内容下的弹窗、顶部「...」确已消失。

## 通用要求

- 每项至少一条纯函数层断言；`.tsx` 里的判断先下沉到纯模块再谈验收。
- 删除/隐藏类改动（F09 的旧菜单）补一条静态不变量测试，断言被隐藏的东西没有长回来。
- 本机资源有限：vitest 按小批次执行（`--maxWorkers=1 --no-file-parallelism`），不跑整套生产构建。
- 未跑到的门禁如实记进 implementation-status，不写成全绿。
- F09 / F10 的联调段在 onboard 接口就绪前不勾。
