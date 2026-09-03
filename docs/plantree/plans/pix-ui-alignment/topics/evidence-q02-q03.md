# Evidence — Q02 模型分组键 / Q03 pix Resources 取证

> 2026-09-03，[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定三派 `maxapi/grok-4.6` 子代理取证。
> 读取对象：AiClient `feat/pi-primary-backend` 当前代码 + pix 冻结提交 `da01b3e`。
> 结论已分别关闭 Q02 / Q03。

## Q02 — 模型菜单分组键：**不是供应商名，U08-1 需要改分组键**

**结论**：目前分组键是 `model.tags[0]`，它是**管理站配置的「主分组标签」**（任意有序字符串），**不是供应商字段**。供应商信息在别处——`providers` 键（如 `dan`）与 `provider.name`（如 `Company Dan`），目录 id 形如 `dan/deepseek-v4`（`providerId/modelId`）。

**证据（file:line）**：
- `src/renderer/components/chat/models.ts:132` — `primary = model.tags?.find(...)` 取第一个非空 tag 作分组键
- `models.ts:116-117` — 注释明说「first configured tag / management site's model/tag order」
- `src/shared/types/agentCatalog.ts:27` — `AgentModelOption` 的 tags 注释「Ordered cloud/config labels. The first is the sole primary menu group.」；**该类型没有 provider/vendor 字段**
- `src/shared/piModelConfig.ts:43, 111-116` — tags 来自管理站；`piModelOption` 直接拷贝
- `src/renderer/components/chat/__tests__/models.test.ts:17-32` — fixtures 用 `国产` / `Hosted` 作首标签，不用 `dan`
- `PiModelConfigService.test.ts:12-21, 77-80` — provider `dan` / name `Company Dan`，tags `['国产','reasoning']`

**线上路径已变**：`chat:listAgentModels` 已被移除（T31）；现在走 `chat:listPiModels` → `PiModelConfigService.readCatalog()` → `piModelOption()`，tags 从管理站/本地 `models.json` **透传**，**不合成**，provider id 并不写进 tags。

**U08-1 判定**：若产品诉求是「供应商在前、悬停展开其中模型」，则**需要改分组键**——从 `tags[0]` 改为从 provider 字段（id 的 `providerId/` 前缀或 `provider.name`）派生。当前代码/测试 fixture 都不按供应商分组。

**未完全确认**：真实账号下的**线上** `tags[0]` 值（本仓跑不到真实目录）。若运维确实把供应商名放在 `tags[0]`，UI 会「巧合地」看起来按供应商分；但代码语义与 fixture 都不是。建议 U08-1 落地前用真实 `/api/v1/models-config` 或管理站 `models.json` 复核一次。

## Q03 — pix 的 Resources：**列出的是「agent 已加载资源」，不是工作区文件；AiClient 无直接对应**

**结论**：pix `nav-resources` 列的是一组 **Pi 加载的 agent 资源**，不是 workspace 文件。

**pix 代码（file:line）**：
- `apps/desktop/src/renderer/components/.../main.tsx:4361-4419` — `ResourcesPage` 映射 `ResourceSummary[]`，展示 `name`/`path`/可选 `source`/`kind` chip；Open 调 `window.pix.workspace.openFile`
- `packages/agent-runtime/src/index.ts:1281-1356` — `listResourcesFromServices` 列出五种 kind：`extension`（`getExtensions()`）、`skill`（`getSkills()`）、`prompt`（`getPrompts()`）、`theme`（`getThemes()`）、`context`（`getAgentsFiles()`，AGENTS.md 式）、`system`（可信 SYSTEM.md / APPEND_SYSTEM.md）
- 空态文案：「No extensions, skills, prompts, or themes are loaded yet.」——真实视图，可为空

**徽标计数**：
- `AppSidebar.tsx:405` → `String(props.resourceCount)`
- `main.tsx:3227-3236` — 优先 `resources.length`（`useShellStore`）；否则累加 `snapshot.resources.{extensions,skills,prompts,themes,contextFiles}`（**不含 system**）
- 数据源：`refreshPiStatus`（`main.tsx:1475-1485`）→ `window.pix.resources.list()` → `setResources`；Host 侧 IPC `resources.list` → `handle.listResources()`

**Q03 修正（2026-09-03 用户实测）**：上述 kind 枚举（extension/skill/prompt/theme/context/system）是**代码层**支持的全部 kind；但用户实测 pix 左栏只看到 **新建会话 / 插件 / 资源**，且插件页 = 已装 extensions 列表 + 一个发现页。当前并无 skill/theme/prompt 加载，资源页实际可见内容只有已加载的 extension（空态即「No extensions, skills, prompts, or themes are loaded yet.」）。因此**内容上「资源」与「插件」重叠**——都指向已加载 extension；资源页是按 kind 分组的「已加载资源总览」。

**对 AiClient 的意义修正**：本仓「资源」与「插件」对应**同一实体**（扩展/MCP server），**不要**把它当成独立实体新建，也不要映射到工作区文件（Files/editor surface）。

**U04 落点（待用户拍板）**：① 不另设资源入口、与插件合并（最简约）；② 照 pix 另设一个（与插件内容重叠但结构对齐，均带徽标）。
