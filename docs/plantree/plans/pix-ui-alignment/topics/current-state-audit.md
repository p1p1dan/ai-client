# Topic — 开工前实况核查

> 2026-09-02 对 `feat/pi-primary-backend`（`eaf2ae07`）与冻结参考版本做的一次核查。
> 目的是分清「用户以为要新建、其实已经有」和「真缺口」，避免把已有能力重做一遍。
> 证据是当时读到的 `file:line`；动工前应复核行号是否漂移。

## 一、已经存在，不需要新建

| 用户需求 | 现状 | 证据 |
|---|---|---|
| 输出文本下的**复制**按钮 | 已有。回合级复制按钮，悬停整个回合时显形；复制文本由 `buildTurnCopyTextFromItems` 生成 | `src/renderer/components/chat/MessageTimeline.tsx:1115`、`:1409` |
| 模型选择器的**多级菜单** | 已有二级子菜单结构（悬停父项展开子项），不是平铺列表 | `src/renderer/components/chat/ComposerModelTrigger.tsx:179-194` |
| 右侧 **Context** 面板 | 已有 `context` surface 注册在面板注册表里 | `src/renderer/components/workspace-shell/surfaceRegistry.ts:96` |
| **思考强度**控件 | 已有 effort 选择器与档位表（low/medium/high/xhigh/max） | `src/renderer/components/chat/efforts.ts:26-32` |

⚠️ 「已存在」不等于「已对齐」。模型菜单的分组键是 `model.tags` 的**第一个标签**而不是明确的供应商字段（`src/renderer/components/chat/models.ts:132`），实际是否按供应商分组要用真数据取证，见 [Q02](../open-questions.md)。思考强度用的是 Claude SDK 的 `EffortLevel` 词汇，与 Pi 的 `ThinkingLevel` 对不上，见下。

## 二、真实缺口

### 2.1 Run 面板缺失

面板注册表里没有 `run` surface（`surfaceRegistry.ts` 全表：git / editor / context / terminal / chat / pr / diff / plan / notes / browser / preview）。

pi-app 的参照实现是 `src/renderer/src/features/run/run-panel.tsx`：展示运行态状态机（idle / running / tool / thinking / failed）、模型、思考档、回合耗时，配 `context-donut.tsx` 的上下文占用环形图与角色图例。数据源是 `useUIStore` 的 `runState` 与 `useComposerMetrics`。

我们要落地需要先确认 Pi runtime 是否把等价字段报上来，见 [Q04](../open-questions.md)。

### 2.2 请求优先级完全没有

全仓对 `serviceTier` 零命中。pix 的实现是 `apps/desktop/src/renderer/lib/service-tier.ts`：`flex | default | priority` 三档，只对 OpenAI / Codex / Azure Responses 系模型暴露，并且有从旧 `speed` 值（fast/balanced/quality）的迁移函数。

关键是 pix 把它和思考强度**明确区分开**：思考强度是推理深度，请求优先级是延迟与成本档位，两根正交的轴。

### 2.3 思考强度词汇与 Pi 不一致

- 我们：`SessionEffortLevel` = low / medium / high / xhigh / max（`efforts.ts:26`），注释明说对齐的是 Agent SDK 的 `EffortLevel`。
- pix：`ThinkingLevel` = off / minimal / low / medium / high / xhigh / max（`lib/thinking-levels.ts:8-16`），并且**按当前模型过滤**——只显示宿主确认支持的档位（`resolveDisplayThinkingLevels`），未知模型安全退化成只有 `off`。

我们缺 `off` 与 `minimal` 两档，也没有按模型过滤的机制。这与已归档的「pi 词汇表漂移」是同一族问题：渲染层按 Claude 词汇查表，遇到 Pi 数据会静默失效。

### 2.4 必须绑定工作目录才能开聊

`src/renderer/components/chat/chatEmptyState.ts` 的 `deriveChatEmptySurface` 明确：没有 workspace / 没有 cwd 时给 `welcome` 引导卡，输入框不能发送。要支持「不绑定项目直接开聊」得新开一条路径，且要决定这种会话的 cwd 落在哪、项目信任门怎么处理，见 [Q01](../open-questions.md)。

### 2.5 TUI 模式没有收起右侧栏

`src/renderer/components/chat/ChatWorkspace.tsx:266` 的 TUI 分支只把**中栏**换成 `AgentTerminal`，右侧 ContextPanel 与左栏都照旧。用户要的是「左栏 + 右侧整块 TUI」。

另外同一处的条件是 `presentationMode === 'tui' && activeWorkspacePath`——**TUI 也要求已绑定工作目录**，与 2.4 是同一个约束。

### 2.6 左栏没有插件 / 资源入口

pix 的左栏顶部是三个导航按钮（`apps/desktop/src/renderer/components/AppSidebar.tsx:380-406`）：

- `nav-projects` 项目
- `nav-packages` 插件 —— 带 MCP 就绪数徽标（如 `0/2`，来自扩展的 setStatus）
- `nav-resources` 资源 —— 带资源计数徽标

我们的 `LeftNav.tsx`（959 行）只有仓库、会话、设置，没有对应入口。「资源」在我们这里对应什么实体待定，见 [Q03](../open-questions.md)。

### 2.7 双栏 / 三栏布局模式开关不存在

现在能做的只是「关闭右面板」——`shellLayoutModel.ts` 的 `activeSurfaceId: null` 状态。这是面板开关，不是一个持久化的布局模式：没有模式概念，也没有「双栏时 Files/Git/Terminal 从哪进」的答案，见 [Q05](../open-questions.md)。

持久化结构在 `PersistedShellLayout`（`shellLayoutModel.ts:405-429`），加模式字段要同步 `sanitizeShellLayoutPersisted` 的清洗逻辑。

## 三、pix 样式层的可搬点

`apps/desktop/src/renderer/styles.css` 的 token（6396 行文件的开头段）：

- 字体：`--font-sans` 以 Inter 起头，`--font-mono` 以 SF Mono / JetBrains Mono 起头。
- 圆角三档：`--radius-sm` 6px（列表行、图标按钮）/ `--radius-md` 10px（输入框、气泡、菜单项）/ `--radius-lg` 12px（卡片、面板、对话框、浮层），且 `xl`/`2xl` 被**压到与 lg 同值**，即大面积表面统一到一个圆角。
- 三层表面灰阶约定（注释里写明各自用途）：`panel #2d2d2d` 输入框/面板/菜单/对话框、`muted #383838` 悬停高亮与输入区凸起、`soft #272727` 用户消息气泡；画布 `#191919`，侧栏 `#151515`。

按 [D01](../decisions/001-style-depth-and-sequencing.md)，可搬的是**分档数值与灰阶关系**，不搬语义变量命名体系。
