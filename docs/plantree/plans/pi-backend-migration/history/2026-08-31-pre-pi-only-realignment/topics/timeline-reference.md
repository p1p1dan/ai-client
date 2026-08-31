# Topic — 时间线交互参照 pi-app（皮肤风格保留、实现大胆取用）

> 2026-08-28 立项，用户拍板方向（rev.2）：「皮肤/UI 设计风格保留（很满意）；布局可适当调整，我们独有的按钮功能可丢后面；功能实现直接抄 pi-app 省时间省 token；气泡观感也学习——我们的气泡现在有点丑；权限审批肯定要加，有对应的高分插件」。
> 落地为 D9 rev.2 + roadmap 重排（T08 提前 · T12 重定义）。本文是参照对象的调查档案与映射表。

## 一、为什么是 pi-app（以及 pix）

- pi-app 与我们同栈（Electron + React + pi SDK），其 timeline 体系是**为 pi 的事件模型定制打磨的**。
- **License 已核实：pi-app 是 MIT**（Copyright 2026 justhil）——代码可直接取用/改写，这正是 D9 rev.2 的授权基础。
- 我们的 0820 批等历史工作是在 Claude/Codex 事件模型上打磨的（EventNormalizer 统一层）；pi 轴接入后打磨目标错了对象。

## 二、pi-app 时间线体系调查（2026-08-28）

源码：`/home/ai/code/pi-app/src/renderer/src/features/timeline/`（约 50 文件）+ `features/composer/`（约 50 文件）。

### 2.1 架构分层（可借鉴的结构决策）

| 层 | 文件 | 职责 |
|---|---|---|
| 项目建模 | `timeline-display-items.ts` / `timeline-turn-groups.ts` | 原始条目 → 显示条目（turn 分组、工具组归并） |
| 渲染预算 | `timeline-render-segments.ts` | **稳定历史 vs 活动尾部分段**：流式时当前 turn（自最后一条用户消息起）全量挂载，历史段按 viewport 裁剪（`sliceHistoryForViewport`） |
| 展开策略 | `timeline-tool-expand-policy.ts` | 工具卡展开的预算规则（自动展开有预算上限，手动展开永远可用） |
| 行渲染 | `tool-call-row.tsx` | **自然语言摘要为主文本**（`buildToolSummary`），变更类工具右侧 +N -M（`DiffStatBadge`），展开态三层 fallback |
| 工具预览 | `tool-previews.tsx` | 六个原生工具的专属预览：Edit/Write（diff 行）、Read（路径+行数）、Grep/Find（pattern+命中高亮）、Bash（命令+退出码）、Ls；`renderNativeToolPreview` 分发 |
| 工具卡模板 | `tool-card-templates.tsx` + `tool-card-registry.ts` | 通用模板（media/list/tree/kv/default）由 adapter 声明式选用——**扩展工具卡走 adapter catalog 查表，无插件名硬编码** |
| 思考链 | `thinking-chain-block.tsx` | 「安静的 12px 活动行」：live 态只有 shimmer 动词（Thinking/Briefly/Working/Reasoning 按种子稳定轮换），完成态收成 "Thought for Xs"，正文 maxh-40 可滚 |
| 流式文本 | `stream-text-reveal.tsx` | 最新 1–2 字符软淡入 tip（`STREAM_REVEAL_TIP_CHARS=2`），**显示永不滞后于源流** |
| markdown | `markdown-view.tsx` / `markdown-stream-split.ts` / `markdown-math.tsx` | 流式期间按完成块切分渲染（与我们的 FB1-b 渐进 markdown 同族）；数学走 MathML 预处理 |
| 跟随滚动 | `timeline-follow-scroll.ts` / `timeline-bottom-anchor*` | 贴底跟随 + 跳出锚点按钮 |
| Composer | `features/composer/` | 发送队列（`composer-pending-queue`）、模型条（`composer-model-strip`）、思考档选择（`thinking-picker`）、附件、文件搜索、输入历史、语音 |

### 2.2 值得点名借鉴的交互细节

1. **工具行主文本是动词+对象的人话摘要**（"Edit src/foo.ts · 3 edits"、"grep \"pattern\" in src/"），不是工具名+JSON。
2. **变更类工具的 diff 统计徽记**（+N -M）挂在行右，一眼看改了多少。
3. **展开三层 fallback**：adapter 声明模板 → 原生工具预览 → 通用 default 模板（语法高亮文本+工件路径）。
4. **展开态记忆按会话存**（`toolExpandBySession`），且本地 state 兜底——「点击必须永远能切」。
5. **问答/ask_user 走独立问卷对话框**（`questionnaire-dialog.tsx`：单选/多选/自定义文本/预览 tab），不是气泡内嵌表单。
6. **权限不是时间线工具卡的一部分，而是 Extension UI 消费者**：pi-app 本身未内置权限卡；pi 的审批由 `@gotgenes/pi-permission-system` 扩展承载，非 TUI 模式通过 `ui.select()`/`ui.input()` 请求前端。我们保留 `projectTrusted` 作为工作区信任，同时必须接入该扩展的审批链（详见 §四）。

## 三、本仓现状映射（对齐表）

| 能力 | 本仓现状（Claude/Codex 轴打磨产物） | pi-app / pi 扩展对应 | 处理方向 |
|---|---|---|---|
| 输入/输出气泡 | 现有 OpenChamber 气泡，用户明确认为观感偏丑 | pi-app timeline/turn chrome | **视觉与布局均可调整**；直接取用结构与交互，再套本仓设计语言 |
| 回合分组 | `chatTurn.ts` + MessageTimeline 的 turn 结构 | `timeline-turn-groups.ts` | 能复用则保留，耦合过重则直接换成 pi-app 形态 |
| 工具行 | `toolCard.ts`(1122 行) + `ToolRows.tsx`，含 Claude permission join（FB7） | `tool-call-row.tsx`(184 行) + 分层预览 | 直接取用/改写 pi-app 薄分层；FB7 不迁移，权限改走 Extension UI |
| 工具摘要 | 各工具 case 内联 | `buildToolSummary` 纯函数集中 | 优先直接移植纯函数 |
| 权限审批 | Claude Allow/Deny 卡 | `pi-permission-system` → `ui.select/input` | T08/T11 前置，独立 GUI 审批面 |
| 思考链 | `thinkingCard.ts` | `thinking-chain-block.tsx` | 直接取用后按主题变量调色 |
| 流式 markdown | FB1-b 渐进分段（6379ms→165ms 实测） | `markdown-stream-split.ts` | 两者对比后择优，不为保留旧实现而保留 |
| 会话列表 | sessionIndex 体系 | 独立侧栏 | 当前不阻塞主线；独有按钮/功能可降优先级 |
| Composer 队列 | T14 Deferred | `composer-pending-queue` | 参照实现存在，可直接取用 |

## 四、权限审批：pi-permission-system（2026-08-28 补充调查，推翻 rev.1「无权限卡」的推断）

pi-app 无 permission 卡 ≠ pi 无权限审批——**审批由扩展承载**。用户点名的高分插件已核实：`@gotgenes/pi-permission-system`（MIT，fork 自 MasuRii 版，本机 `~/.pi/agent/npm/` 已装 v27.0.1 且用户 settings.json 已启用）。

**能力面**（README 实测要点）：

- allow/ask/deny 三态，工具/bash/MCP/skill/特殊操作全覆盖；
- bash 通配模式（`git *: ask`、`rm -rf *: deny`）；
- **路径横切门**：`path` 规则跨所有工具与 bash 生效，匹配引用路径与 symlink 解析后形态（deny 不可被符号链接规避）；
- 外部路径门（`external_directory: ask`）；fail-closed（门内部出错即拦截，不可解析的 bash 命令或间接包装如 `bash -c`/`eval`/`sudo`/`env`/`xargs`/`find -exec` 一律 ask）；
- 子代理 ask 转发（非 UI 上下文的 `ask` 策略仍可到达用户）；
- 事件总线：`permissions:ui_prompt`（即将弹 UI 时广播）+ `permissions:decision`（应答，含子代理转发臂）。

**对我们的关键路径**（源码已核实 `authority/permission-prompt-component.ts:69-100`）：

```
mode === 'tui'        → 行内快捷键对话框（y/s/n/r 双击确认）
mode !== 'tui'（我们）→ ui.select()/ui.input() fallback ——
                        pi SDK 扩展 UI 的 select 原语
                        = 我们 Phase 2 T08 的 Portable UI 原语
```

即：**权限审批是 T08（select/confirm/input 原语）的第一个、也是最高优先级的消费者**——这直接把 T08 从 Phase 2 提前。四选一决策（Yes / Yes for this session / No / No with reason）由 `permission-dialog.ts:118-160` 的 `requestPermissionDecisionFromUi()` 实现，结构可直接取用。

**展示面**（`presentation/dialog-renderer.ts`）：一行一事实（`label : value` 标签对齐），行预算内裁剪、超预算可展开——比 Claude 式 Allow/Deny 卡信息密度更高。Claude 的 FB7 permission join 不迁移；但**权限能力本身必须落地**，经 Extension UI 独立呈现。

**分发要求**：不能依赖用户机器恰好已经安装插件。登录模式的隔离 agentDir 与本地模式都必须有明确来源：应用固定版本随包/声明依赖并加载，或在隔离目录中受管安装。具体作为 T08-a 任务； substantial 代码直接取用时保留 MIT copyright/license notice。
