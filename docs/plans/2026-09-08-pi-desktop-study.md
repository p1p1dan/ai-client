# PI-Desktop 调研档 — 对照与可借鉴项

> 日期：2026-09-08 · 触发：用户提供参考项目 `/home/pi/code/PI-Desktop/`（v0.13.11），
> 点名关注：插件相关 / Token 统计插件 / Git Lens 侧边栏插件 / 模型配置 / 会话导入 /
> Subagent 真正可见 / 高缓存命中率。
> 取证方式：本地全仓通读（docs/adr 175 条、docs/spec 八域、`apps/desktop`、`packages/*`、`crates/host-core`）。
> 本文件是 [用量可见性与目录韧性](../plantree/plans/usage-and-catalog/README.md) 与
> [资源归位与会话导入](../plantree/plans/resource-home-and-import/README.md) 两条计划的需求原文。

## 1. 定位：三个层级，不是两个

| | dsh（[2026-08-18 调研档](./2026-08-18-deepseek-harness-study.md)） | PI-Desktop | ai-client |
|---|---|---|---|
| 是什么 | agent 运行时框架**本体** | 客户端外壳，嵌 pi **引擎**，产品层自建 | 客户端外壳，用 pi **整套产品层** |
| 依赖的 pi 包 | `@earendil-works/pi-ai`（`llm-pi-ai` 插件） | `pi-agent-core` + `pi-ai` 0.85.0 | `pi-coding-agent` 0.84.3 |
| agent loop | 自己实现 | 用 pi 的 | 用 pi 的 |
| 资源层（skills/prompts/subagents/MCP/权限/压缩） | 自己实现 | **自己实现**（Rust `host-core` + `agent-runtime`） | 用 pi 的 resource loader / SettingsManager |

**PI-Desktop 在 dsh 和我们中间。** 三者独立地都选中 `pi-ai` 当模型适配层。

### 1.1 「更硬的隔离」的真实含义

我们已经在跑 sidecar 嵌库：`utilityProcess.fork` → `agent-host/worker.js` →
`import('@earendil-works/pi-coding-agent')`（`piWorkerSession.ts:1363`）。形态与 PI-Desktop 相同。

差别不在有没有 sidecar，在**嵌得多深**。PI-Desktop 全仓无 `PI_CODING_AGENT_DIR`、无 `agentDir` 概念，
因此不存在「agent 目录归谁」这个问题——代价是产品层全部自建。

**结论：不改。** 四条理由记档：

1. 换成 `pi-agent-core` + `pi-ai` 等于重写产品层（skills / prompts / subagents / MCP / 权限 /
   压缩 / 会话树 / 命令清单）。PI-Desktop 为此写了一个 Rust 进程 + 175 条 ADR + 八域 spec。
2. 收益与痛点错配：本轮六个关注点没有一个需要换引擎。
3. 已付的成本已有回报：权限扩展、resource loader、会话树与压缩、命令清单、TUI 与 GUI 共用一份配置。
4. 升级风险是换向而非变小：他们钉两个包自扛 breaking，我们钉一个包升级面大但补丁少。

**重新考虑的触发条件**：pi 的 breaking change 反复打断发布节奏，或需要 pi 产品层做不到的线行为
（例如自定义缓存断点策略）。当前均不成立。

## 2. 凭据与目录（回答「是否改用 `~/.pi`」）

### 2.1 PI-Desktop 的实际做法

- **不跑 pi CLI**：`spawn(process.execPath, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })`
  （`agent-sidecar.ts:120`）。不设 `PI_CODING_AGENT_DIR`，不读 `~/.pi/agent/settings.json`、
  不读 `~/.pi/agent/auth.json`，**从不写 `~/.pi/`**。
- **自有状态根 `~/.pi-desktop/`**：`pi.sqlite` + `sessions/` JSONL + `secrets/`（AES-GCM +
  `.machine-key`，主用 Electron safeStorage）+ `plugins/` + `logs/` + `cache/` + `scratch/`。
  密钥值永不进 DB，DB 只存 `secrets_meta` 记账。
- **从原生目录只读**用户手写文本：`~/.pi/agent/AGENTS.md`（`project-instructions.ts:12`）、
  `~/.pi/agent/prompts/*.md`（`prompt-templates.ts:59`）、`<workspace>/.pi/prompts`、
  导入时扫 `~/.pi/agent/sessions`（`importers/pi.ts:12`）。
- **可写的共享位是 `~/.agents/`**（跨 agent 约定）：`skills` / `subagents` / `servers`(MCP)，
  项目级同名 `<repo>/.agents/`（`crates/host-core/src/agent_capabilities.rs:11`）。
  Skills / MCP / Subagents 三个设置页在这里增删改。
- 唯一写进仓库 `.pi/` 的是 plan/goal 检查点文档（`plans.rs:449`）。

### 2.2 对照结论

**凭据与状态各自持有这一点，我们与它一致**（我们 `~/.pilab/<profile>`，它 `~/.pi-desktop`）。
差别只在一处：**它有一个可写的跨 agent 共享位，我们只有「借读」。**

### 2.3 「改用 `~/.pi` + 运行时备份还原」——不建议

用户 2026-09-08 提出：多数用户不用本地模式，是否可直接用 `.pi`，`.pilab` 只放凭据，运行时备份用户配置。
调研结论是**不采纳该形态**，三条理由：

1. **备份/还原是有状态操作，崩溃即失真。** pi 运行时会重写 `settings.json`
   （`userResourcePaths.ts:23` 已记录该实测事实）。进程被 kill / 断电 / 强退时还原步骤不执行，
   用户配置永久停在我们改过的那一版，且无任何提示。
2. **并发击穿备份语义。** 用户在终端开着 pi CLI，或使用我们内嵌的 TUI 时，
   两个进程同时写同一个 `settings.json`，「备份—修改—还原」的前后配对不成立。
3. **信任闸语义无法解释。** `settings.json` 的 `packages` 会让 pi 真的执行 `npm install`；
   托管模式现靠 `projectTrusted=0` 挡住「克隆的仓库能加包」，指向 `~/.pi/agent` 后这道闸变成
   「我们在用户自己的目录里替他决定信任」。

**但用户的观察成立**：痛点不是目录归属，是**缺少可写的共享安装位**。
该问题不动凭据边界即可解决——见计划 B 的 B1/B2。

## 3. 逐项可借鉴内容

### 3.1 插件体系

PI-Desktop 有完整第三方插件平台（`~/.pi-desktop/plugins/{installed,disabled,cache}` + manifest
contributes），我们只有随包 pi 扩展。值得抄的是纪律而非平台：

- **权限名管「能不能」，manifest 字段管「到哪为止」**（`07-plugins/13-plugin-permissions-matrix.md` §2A）。
  `net.domains` / `fs.read|write|delete` scope 缺省即空 = 什么都不给；`fs.write` 声明全树通配符
  **校验失败**；`fs.delete` 三重约束（own 写入账本免提示 / 走系统回收站且 `recursive: false` /
  60s 内 50 次限流）。
- **第一方功能用公开通道自证**：Files、Browser、Advisor 均为「随包插件、默认可停用、不可卸载」
  （ADR 0105 / 0170 / 0174），明确拒绝私有 API。Browser 一例尤其干净：插件只拿 chrome UI，
  真正的 `WebContentsView` guest 与 CDP 仍归主进程，插件通过 `pi.browser.setBounds` 报一个
  内容相对的洞，bounds 被钳制在调用方视图内。
- **插件不持密钥**（ADR 0174）：`models.list` / `session.read` / `agent.complete` 三个公开 API，
  补全由主进程用用户已有凭据发起。刹车：8 次/60s、system ≤ 32 KiB、messages ≤ 200k 字符、
  90s 预算（压在 110s 工具超时之下）、审计只记 plugin id / model / 大小 / 用量，不记正文。
  `session.read` 返回**投影不是 dump**：剥子代理行、剥插件自己在飞的调用、压缩点前换摘要、工具结果截断。
- **插件设置 UI 由 manifest 生成**（ADR 0159）：`string|number|boolean|select|json|shortcut`；
  快捷键 `scope` 固定 `"plugin"`，仅窗口聚焦时由渲染层处理，不注册全局快捷键。

**「Git Lens 侧边栏插件」在该仓库中不存在。** 它只是 `08-component-spec.md:689` 工作面板
ASCII 图里的一行示意（`⑂ GitLens [×]`），用于说明第三方插件经 `contributes.views` 出现在
插件视图组。可复用件是那个视图通道（ADR 0104），不是这个插件。

**处置**：不做第三方平台——他们 spec 自述「插件主进程保留裸 Node 内置，市场包即以用户权限运行的
任意代码，沙箱未实现」；我们的产品发到加固机器，风险性质不同。该做的一小步是把随包扩展改成
表驱动清单（计划 B 的 B3）。

### 3.2 Token 统计与缓存命中率

ADR 0171 / 0173 的分层：

- **父 `message.usage` 永远是 provider 报的原值**，子代理花费绝不合并进去。
- 子代理花费只进**轮级 rollup**（父 assistant `message_end` 之和 + `turn_end.subagentUsage` 增量）。
- `stats.getTokenUsageHistory` 是**纯增量 RPC**：有界本地日历窗、按 day/ISO week/month 分桶、
  空桶补零、索引 `CREATE INDEX IF NOT EXISTS`，**不升 PROTOCOL_VERSION 也不升 SCHEMA_VERSION**。
- **看板不进设置页**：ADR 0173 删掉了 Settings → Usage 整个目的地，热力图交给市场插件
  `pi.token-insights`，命令面板关键词 `usage` / `tokens` / `用量` 直接开插件。

缓存命中率公式（`apps/desktop/src/lib/context-usage.ts:250`）：

```
命中率 = cacheRead / (inputTokens + cacheRead)      // 分母不含 cache write
```

注释点明理由：`inputTokens` 是未命中的 prompt 部分，`cacheRead` 是命中部分，cache write 不属于该分母。

**我们的现状**：`cacheRead` / `cacheWrite` 已在 `src/shared/piUsage.ts:40`，
Run 面板已显示两个绝对数字（`RunSurfaceView.tsx:331`），**唯独没算比率**。
该数字的真正用途是当哨兵——打开随包扩展、系统提示混入会变的内容、借来的技能列表变动，
都会立刻表现为命中率下跌；没有它，这类问题只表现为「账单涨了」。

### 3.3 模型配置

ADR 0133 → 0134 的**演进**值得看：先「models.dev 优先 + pi-ai 兜底」，一个月后收敛为唯一元数据源，
理由是「两个权威 = 升级一个 npm 包就能悄悄改掉用户选中的模型配置」。

最实用的手法是**目录快照随发布物走**：`apps/desktop/resources/models.dev/api.json` 进仓库；
`scripts/release.mjs <version> --tag` 在打 tag 前拉取 → 校验 → 原子替换 → 进 release commit；
启动**零网络 I/O** 读快照；设置页「刷新模型目录」只替换当前进程的内存快照，
**既不写包内文件也不写用户缓存**（理由：用户缓存会让不同装机跑在不同配置上，发布物不可复现）。

**我们的现状**：启动拉 `/api/v1/models-config`，失败即 `unavailable`。D03 删掉内置模型表之后，
网络不佳或管理端不可用 = 用户看到空的模型下拉框。

加提供商表单（ADR 0156）：对话框**只从「服务」一个字段开始**，选定具名服务后仅剩服务 + API key +
一行地址摘要；名字 / Base URL / API 格式全进「高级」。

### 3.4 Subagent 真正可见（本轮不立项，仅记档）

ADR 0166 记录了一次完整失败。原设计与常见做法一致：`Task` 非阻塞、父代理 `TaskWait`、
父 `agent_end` 兜底 abort 遗留子代理、300s 空闲看门狗 + 6h 上限。

**实践中全线失败**：父代理看不见子代理的活，`TaskWait` 最多 900s 返回，模型把返回理解为
「可以收工」，`agent_end` 随即杀掉仍在运行的子代理。长编译、测试、审计死于父代理关门。
ADR 原话：

> 提示模型再等一次并不能解决问题。等待是一个事件循环；模型不是可靠的事件循环。

新方案四条：① 不按时间杀（idle/duration 看门狗不武装，字段仍可解析以兼容旧文档，
`maxTurns` 保留，并发上限 10）② 父代理 idle 不 abort，`agent_end`/`turn_end` 被吞掉，
durable turn 保持打开，只有用户 Stop / `TaskStop` / runtime dispose 能中止
③ 子代理跑完后 runtime 把合并报告喂回父代理（不作为用户气泡）由父代理判断
④ 给父代理**心跳而非转录**：`TaskList` 与超时的 `TaskWait` 携带 agent / status / elapsed /
turns / toolCalls / lastToolName，进程行不进父上下文。明确否掉「Claude Code 式进度文件让父代理去 Read」。

**对我们的意义**：可见性这半边我们更细——`subagentProjection.ts` 的白名单投影 + 字段夹断 +
每次委派 200 事件上限，是他们没有的（他们让子代理进程行既不进父上下文也不进 UI）。
**缺的是生命周期那半边。** 但我们的子代理是随包第三方扩展 `@gotgenes/pi-subagents`
（`bundledPlugins.mjs:69`），生命周期归该包管。因此正确顺序是**先做实验再写代码**：
开一个跑数分钟的子代理，让父代理提前结束，观察它是被杀还是存活。

**用户 2026-09-08 裁定：本轮不做。** 记档待需求触发。

### 3.5 会话导入

四个来源（claude-code / codex / opencode / pi），每个 importer 约 200 行，统一三方法接口
`{ source, scan(), convert() }`；`scanAllSources()` 用 `Promise.all` 扇出，
**单源抛错降级为空数组**（`importers/index.ts:22`）。

最值得抄的是**确定性会话 id**：`import-${source}-${externalId}`（`importers/types.ts:52`）。
重复导入天生幂等，无需去重表；`sessions.source` 列同时用于 UI 打「已导入」徽章。

对 Claude Code JSONL 的两个处理与我们同源：`isSidechain !== true` 过滤子代理行；
以 `<` 开头的合成 user 行（command caveat、system reminder）整条丢弃（`importers/claude.ts:60`）。

**我们的现状**：只有 `sourceKind: 'claude-code'`，但工程质量更高（`stableSourceIdentity` +
contentHash + size + mode + mtime 指纹、provenance custom entry、逐层字节/条数上限）。
扩展是纯增量，且 codex 读取已写了一半（`codexHistoryReader.ts` / `codexItemMapper.ts`）。

### 3.6 通用 UI 纪律（ADR 0126）

三条与具体功能无关、我们设置页同样适用：

1. **busy 是行级不是页级**——一次请求锁住整页是缺陷。
2. **刷新不是首次绘制**——骨架屏只在首帧，之后保留已有行 + 变暗 + 通知辅助技术。
3. **开关乐观更新**——本地先翻，宿主拒绝才回滚；省掉一次往返和一次骨架闪烁。

## 4. 未验证项（动工前需取证）

1. **pi 是否原生加载 `~/.agents/skills`。** 我们设置页承诺「托管、本地、TUI 三处始终加载」
   （`PiResourcesSettings.tsx:105`），但该承诺在本仓没有测试或探针支撑；
   `commandInventory.test.ts:65` 那条 `~/.agents/skills/pdf/SKILL.md` 是夹具不是实证。
   → 计划 B 的 B1 前置取证。
2. **`@gotgenes/pi-subagents` 在父 turn 结束时的行为。** 未测。→ 本轮不做，记档。
3. **PI-Desktop 的 `pi.token-insights` 插件本体不在该仓库**（属外部 marketplace 仓
   `vastsa/pi-desktop-plugins`），本档关于它的描述全部来自 ADR 0173，未读实现。

## 5. 处置汇总

| 项 | 处置 | 落点 |
|---|---|---|
| 缓存命中率 | **做** | 计划 A · A1 |
| 轮级用量汇总 | **做**（只到会话内累计） | 计划 A · A2 |
| 模型目录随包快照 | **做** | 计划 A · A3 |
| 技能默认安装位 | **做**（含前置取证） | 计划 B · B1 |
| 借读面对齐 | **做** | 计划 B · B2 |
| 随包扩展表驱动 | **做** | 计划 B · B3 |
| Codex 会话导入 | **做** | 计划 B · B4 |
| Subagent 生命周期 | **不做**（用户 2026-09-08 裁定），记档 | §3.4 |
| 第三方插件平台 | **不做**，风险性质不同 | §3.1 |
| 换 `pi-agent-core` 重写产品层 | **不做**，触发条件记档 | §1.1 |
| 改用 `~/.pi` + 备份还原 | **不做**，三条理由记档 | §2.3 |
| 跨会话用量热力图看板 | **不做**，等插件通道 | §3.2 |

## 6. 溯源

- 参考仓库：`/home/pi/code/PI-Desktop/`，v0.13.11，HEAD `948ee676`（2026-09-08 读取）。
- 主要引用：`docs/adr/{0104,0105,0119,0126,0133,0134,0156,0159,0166,0170,0171,0173,0174}.md`、
  `docs/spec/07-plugins/{01,03,13}.md`、`docs/spec/03-runtime/04-data-storage.md`、
  `docs/spec/04-ux/08-component-spec.md`、`apps/desktop/electron/main/importers/*`、
  `apps/desktop/src/lib/context-usage.ts`、`crates/host-core/src/{secrets,agent_capabilities,plans}.rs`。
- 前序调研：[dsh 调研档](./2026-08-18-deepseek-harness-study.md)（三层定位的另一端）。
