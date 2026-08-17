# D48 设计任务书 — Codex CLI 选择功能（阶段 3）双轨双盲输入

> 2026-08-16。本文件是双轨设计的共同输入（Opus 轨与 Codex 轨各自独立作答，互不见对方）。
> 读者先读调查五篇：本目录 [README](./README.md) → 00~04。仓库 = /home/dan/projects/ai-client。

## 已拍板约束（D48，不可重开）

1. **范围 = 三块全做**：agent 选择入口（消费 `capabilities.agents`，首个 UI 消费者）+ 模型/思考档按 agent 适配 + 权限模式管理面。
2. **绑定语义 = 零回合可选、物化后锁定**（物化点 = 首条消息 `sendMessage()`；已物化会话 picker 转只读，具体只读形态是设计项）。
3. **三轴隔离**：不碰终端轴 `AgentPickerMenu`/`SessionBar`；聊天轴另立入口；`AgentWireName` 与 `BuiltinAgentId` 不互转（静态断言已钉）。
4. 沿用既定：D45 直连（无 ACP config_options 通道）；flag `AICLIENT_AGENT_CODEX` 只控 capabilities 与运行时注册，不控 store 形状/渲染分支；红线 store `chatSessions.ts` 改动走加法；门禁四门串行。
5. **模型展示面 = 家族规则白名单 + 动态推导（用户拍板 2026-08-16，双轨开跑后追加，合取仲裁时强制执行）**：UI 只显示——Claude 轴 haiku/sonnet/opus 三族各自最新版（同版本优先无日期别名），Codex 轴最高世代（现为 5.6）的全部变体（排除 `gpt-image-*`/`codex-auto-review`/`-mini`）。**白名单硬编码的是家族/世代筛选规则，不是模型 id**；具体型号每次从 cch `/v1/models` 动态推导 → 族内更新与世代更迭零代码改动，仅全新家族名（如 fable）需人工加一行规则。查询失败三级回落：运行时查询 → 上次成功结果本地缓存 → 内置种子表（调查 04 实测六条）。推导结果为全名，静态短名表（`CHAT_MODELS`）随之退役。

## 实证事实（设计必须吸收，出处 = 调查 01/02/04）

- cch 双轴 `/v1/models` 可信（列表外模型实测打不通）：codex 10 条、claude 15 条**全长名**；**短名别名（sonnet/haiku/opus）不被 cch 接受**——现链路靠 SDK/CLI 层翻译才能跑。
- codex effort 实证五档 low/medium/high/xhigh/max（ultra 显式报错），与 `CHAT_EFFORTS` 一致。
- D40 会话中途 model/effort：Claude 轴全链已落地；**Codex 轴 send() 接收后显式丢弃**（`codexRuntime.ts:250-256`），丢弃理由（词表未知）已被实证消除。
- 权限：读侧 Claude 全通 / Codex 断链（`permissionPolicy` 渲染端零消费者，Context 面板整行消失）；写侧零存在（无存储位无 IPC 无控件）；中途改档协议半通道两条均未实证（SDK `setPermissionMode` 仅 streaming-input / codex `thread/settings/update` 零 schema）。
- codeg 参照（用户认可形态）：segmented pill + 未安装琥珀点 + 落库锁定 + per-agent localStorage 偏好；模型目录会话回包驱动（直连须换轴）；权限三层结构；(a)(b) 选择器互斥。

## 设计要求（产出物形状）

按本仓规格惯例产出**一份施工规格草案**，须含：

1. **切片划分**（建议 2~4 片，每片独立可回归、四门全绿收口）与依赖序。
2. **agent picker**：组件形态、落点（`ChatComposer.tsx` 底栏组装处 :2455-2461/:2474-2479）、三态表达（可用/flag-off 或不可用/已锁定）、与 `hostStatus.capabilities.agents` 的接线、空态与降级（old Host 无 capabilities 字段）。
3. **模型目录改造**：静态表 → 代理查询的通道设计（谁查、何时查、缓存哪、失败回退）；短名→全名迁移的兼容口径（存量 localStorage 里的短名怎么办）;per-agent 目录切换与 `ComposerModelTrigger` 的改造面；D40 Codex 半边补齐（`buildTurnStartParams` 加 model/effort 还是维持 thread/start 钉死，须给裁定与理由）。
4. **权限面**：先补 Codex 读侧断链（`SessionPermissionPolicy` 进 `sessionRuntimeFacts` 与 Context 面板）；写侧管理面的最小形态与持久化位置；中途改档两条未实证通道**写成条件执行项**（探针先行，不得当作已成立）。
5. **每片的 Happy Path + 确定性断言点 + 变异验证候选**（本仓工程规范 12/4/15 条）。
6. **风险与未决表**：需要用户拍板的项单列（含推荐案），不得自行扩权拍板。

## 边界（本阶段不做）

多 agent 协同；终端轴改造；2b 打包链（阶段 4）；git surface 扩展（open-q #4）；提问坞单槽（open-q #10 另立）；cch 服务端改动。
