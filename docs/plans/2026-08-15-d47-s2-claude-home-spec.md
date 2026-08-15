# D47 S2 施工规格 — 托管 claude-home 与全局重定向（rev.2 评审合取版）

> 2026-08-15。母规格 = [D47 设计规格 rev.2](./2026-08-15-login-management-design-spec.md) §3.A/§7 S2 行。
> **rev.2 = rev.1 大改**：双盲对抗评审合取——A 轨 Opus（运行时行为，5B/14M/10m）+ B 轨 Codex（证据与可验证性，
> 5B/6M/3m），原文归档 [reviews/](./2026-08-15-d47-s2-reviews/)。两轨判语一致：rev.1 不可开工。
> 重叠 4 处（Scanner 单例时序 / apply truthy / trust 调用矩阵 / 写手竞态），失实事实 1 条被 B 轨源码推翻
> （watcher 门控——rev.1 §0.3 反了，本版已改）。flag 与 S1 同。**S2a/S2b 文件集不相交可并行施工。**

## §0 前置事实（rev.2 修正版）

1. 历史 UI 真链 = `ClaudeSessionScanner`（调用级读 env，`ClaudeSessionScanner.ts:26-29`——**没有构造函数**，
   今天能跟随重定向正因无构造期捕获）；实例是模块级单例 `claudeSessions.ts:5`（ESM 提升先于 main/index 全部语句）。
   `listSessionHistory` 是零渲染消费者死链（登记不动）。
2. 硬编码写手清单（**逐处列举，不再用总数**）：`McpManager.ts:14-15`（`.claude.json`）· `PluginsManager.ts:7-12`
   · `PromptsManager.ts:5-6,59` · `ClaudeRuntimeConfig.ts:5-6`（调用方 `AgentInstaller.ts:376-383` +
   `main/ipc/claudeRuntime.ts:50`）· `RemoteHelperSource.ts:2092-2109`（**远程模板段，I8 豁免**）·
   `OnboardingService.ts:311,523,543,654`（**legacy 双写本体，留至 S6/S5**）。另有 `ClaudeCompletionsManager.ts:30-45`
   ——**联集语义**（`~/.claude` ∪ `CLAUDE_CONFIG_DIR` 扫 commands/skills），纳入本片口径统一。
3. Provider watcher **已受 `enableProviderWatcher` 门控**（`main/index.ts:773-778` init +
   `claudeProvider.ts:54-72` toggle 两入口）；rev.1 的「恒跑」失实。S2 加的是第二层 managed 门控。
4. `applyProvider` 现返 `Promise<boolean>`，三消费点按 boolean 判（`ProviderList.tsx:233` / `SessionBar.tsx:497`
   / `ActionPanel.tsx:241`）；handler 有 local/remote 两分支（`claudeProvider.ts:34-47`），remote 写远端仓库设置。

## §1 范围与交付物

### S2a（Main 侧）——flag 门控（除注明「无 flag」者）

**新文件**：
- `src/main/services/auth/claudeHome.ts` — 纯模块。`generateClaudeSettings({credentials|null})`（纯函数产
  settings 补丁）、`generateClaudeJson()`、`ensureWorkspaceTrusted(claudeJsonPath, wsPath)`；
- `src/main/services/auth/managedFileWriter.ts` — 纯模块。**per-path 串行队列 + 读最新-补丁-原子写（tmp+rename）
  + 写后显式 chmod 0600**（复用 S1 写盘件实现），`writeSettingsFile(path, mutator)` 唯一入口（A 轨 M2/M3 +
  B 轨 B3 合取：托管 settings.json 有生成器/HookManager/PluginsManager/ClaudeRuntimeConfig 四写手，
  `.claude.json` 有 trust/McpManager 两写手——全部改走本入口；`writeSettingsWithEnvGuard` 保留为断言层）。
- `scripts/credential-env-keys.mjs` — **剥离清单唯一来源**（A 轨 M1：`ANTHROPIC_` 前缀 +
  `CLAUDE_CODE_OAUTH_TOKEN/CLAUDE_CONFIG_DIR/CLAUDE_CODE_USE_BEDROCK/CLAUDE_CODE_USE_VERTEX/
  AWS_BEARER_TOKEN_BEDROCK/GOOGLE_APPLICATION_CREDENTIALS/CLOUD_ML_REGION` 全量），dev.js 与 Main 共同 import，
  vitest 断言两侧同源。

**改动**：
- `src/main/index.ts` — 两相启动（A 轨 B1 核心裁定）：
  ① `setPath('userData')` 块之后、任何服务动作之前（m1 行位：`:136` 后）：flag on ⇒ 设
  `process.env.CLAUDE_CONFIG_DIR=<userData>/claude-home`（覆盖 dev.js 已设值）+ 按共享清单剥离继承 env
  （**dev seed 例外**：`!app.isPackaged` 且 vault absent 时，剥离前先捕获 `ANTHROPIC_*` 供 ③ 一次性 seed——
  A 轨 M9，否则 dev flag-on 全无凭据无法点验）+ `ensureManagedHomeSkeleton()`（**只建目录 +
  `.claude.json` + commands/skills 子目录（m4），绝不碰 settings.json 的 env**）；
  ② 升格闩（S1 已落）不变；
  ③ **`regenerateFromVault()` 只在首窗创建（升格）之后**执行：vault `ok` → 写 env；`absent` → dev seed 有值则
  seed 否则写空 env；**`locked`/`unsupported`/`invalid` → 跳过 env 段，盘上既有 env 逐字节保留**（B1 致命链：
  win/mac 启动期读必 `locked`，按 rev.1 会每次重启抹凭据）。
- `OnboardingService.ts` — 登录成功后 regenerate **用当场凭据对象**（`getCredentialWriteInputs` 返回值，
  不回读 vault——A 轨 M4：vault save 失败不该导致无凭据登录）；登出 regenerate = **确定性无凭据版**
  （不读 vault，同步完成于 `removeClaudeCredentials` 之后——A 轨 B2：fire-and-forget clear 无「clear 后」时点）；
  regenerate 成功后 `void agentHostManager.shutdown()`（A 轨 M10：I5 纪元链本片就接，防旧 env 缓存整进程周期）。
- 写手改口径 + 改走 managedFileWriter：`McpManager` / `PluginsManager` / `PromptsManager` /
  `ClaudeRuntimeConfig`（改 `CLAUDE_CONFIG_DIR ?? ~/.claude` 口径；**a 裁定维持改口径不删除**，两调用方
  `AgentInstaller`+`claudeRuntime.ts:50` 与既有测试 env 清理一并列入改动面——B 轨 M5；其 `writeJson` 无 mode
  的隐患随 managedFileWriter 消除）。`ClaudeCompletionsManager` 联集语义**保持**（天然兼容 U1 收编不清理），
  纳入静态扫描基线。
- **CLAUDE.md 收编**（f 裁定修订，A 轨 f + U1 精神）：首次 flag-on 生成时若托管 home 无 `CLAUDE.md` 且
  `~/.claude/CLAUDE.md` 存在 → **一次性 copy 进托管 home**（非搬运，原文件不动），杜绝员工全局指令静默失效。
- **删除**（死码，无 flag）：`mergeClaudeEnvSettings` + IPC `CLAUDE_RUNTIME_REGISTER_ENV` + preload `registerEnv`。
- 生成物抬头：**sidecar 文件 `<claude-home>/.aiclient-generated`**（version/commit/时间），settings.json
  **不塞未知键**（A 轨 M11：`__generated__` 未经 CLI 实证；`autoUpdates`/`skipWebFetchPreflight` 是生产已验真键，保留）。
- 静态扫描（A 轨 M7 重设计）：**文件级 allowlist + 每文件命中计数基线**（`shellSwitchStatic` 范式）——
  基线表列出全部合法 `homedir+'.claude'` 命中（含 `?? 回退`形态的 9 个跟随者 + OnboardingService 4 处
  legacy 标记 + RemoteHelperSource 模板段），任何新增/漂移即红；正/负控 fixture 各一（B 轨 M3）。

**trust 调用矩阵（B 轨 B1 + A 轨 M3 合取，钉死）**：
`ensureWorkspaceTrusted` 在以下入口 **await 完成后才继续**（全部仅 flag on + 本地路径；
`isRemoteVirtualPath(cwd)` → no-op，I8）：
① `main/ipc/chat.ts` `CHAT_CREATE_SESSION`（`recordCreated`/`createSession` 之前）；
② 同文件 `CHAT_RESUME_SESSION`（同理）；
③ `SessionManager.create` 本地分支入口（覆盖新旧两个终端 IPC 的共同咽喉）。
ws 键 = `path.resolve` 归一化绝对路径（Windows 大小写/分隔符差异登记 m2，真机轮验）。
生产接缝测试四臂：create / resume / terminal / remote-no-op（fake helper 断言先于 fake spawn 被调）。

### S2b（renderer/scanner/Provider 侧）——flag 门控

- **Provider 面（A 轨 B3+M5+M6 / B 轨 B4 合取）**：
  ① `CLAUDE_PROVIDER_READ_SETTINGS` handler **flag-on 本地分支裁剪**（工厂接缝，照 S1 §2.3 范式）：只返
  `{baseUrl, model 各键}`，`authToken` 与整份 `settings` 不出 Main（否则托管明文穿 renderer + 可被存进
  0644 的 `~/.aiclient` providers——I1/I2 双破）；remote 分支不动。
  ② `CLAUDE_PROVIDER_APPLY`：**返回类型保持 `boolean`**；flag-on 且 `kind==='local'` → `false` + Main 诊断；
  remote 分支原样放行（I8）。
  ③ watcher managed 门控收口在 `watchClaudeSettings()` 自身（唯一咽喉，堵 init+toggle 两入口）；
  四臂矩阵：用户开关 × managed，仅「用户 on + managed off」启动。
  ④ UI：`ProviderList` flag-on 渲染只读「公司托管」卡；`SessionBar`/`ActionPanel` 入口隐藏；
  **默认按托管渲染，`auth.managedMode` resolve 后再放开**（m6 首帧竞态）。
  ⑤ 新 IPC `auth.managedMode` → **`{managed: boolean, claudeHomeDir: string|null}`**（路径非 secret；
  A 轨 B5：renderer 无从得知 userData 路径）。preload 只 invoke 通道、禁 import Main 服务符号——
  S1 staticImportBans **零改动继续绿**（两轨同证：通道注册本就不在禁令内，rev.1「显式放宽」措辞删除）。
- **Scanner 双源（A 轨 B4+M13 / B 轨 B2 合取）**：
  构造改 `new ClaudeSessionScanner({resolveRoots: () => [{dir, kind:'managed'|'legacy'}]})`——**惰性提供者**，
  调用时解析（禁构造期捕获；模块级单例因此无害）；flag off 恒单根现状。
  数据模型：session key = `(projectId, sessionId)`；`ClaudeSessionMeta` 增 `configDir: string`（provenance，
  顺带解 resume）；project 聚合 = 同 slug 合并、`sessionCount` 按去重键计、`lastActivityAt` 取 max；
  胜者 = `mtimeMs` 大者，**相等时 managed 胜**（确定性 tie-break）；单根 stat 失败降级为另一根继续 + 诊断。
  既有六个无参构造测试列入改动面（B 轨 B2）。
- **resume（A 轨 B5+M13+M14 合取）**：`resolveClaudeConfigDirForResumeSession` 优先用
  `ClaudeSessionMeta.configDir`（Scanner 已判来源，renderer 不再猜）；无 meta 时回退候选 =
  `[claudeHomeDir(来自 auth.managedMode), ~/.claude]`；**`claude-null` 判死**（删 `App.tsx:131,1176` 两引用）。
  **M14 裁定 = 方案②**：resume 命中 legacy 根时维持读写 legacy `~/.claude`（老会话继续在原地生长），
  母规格 S2 行断言限定为「**非 resume 路径**对 `~/.claude*` 写调用数=0」，此为 U1（收编不清理）的自然延伸，
  登记已知行为非缺陷。

## §2 关键契约补遗

- 生成物 settings.json 键集：`env` 三键（或无凭据时 `{}`）+ `autoUpdates:false` + `skipWebFetchPreflight:true`；
  **外来键（hooks/statusLine/enabledPlugins/未知）逐字节保留**——由 managedFileWriter 的读最新-补丁语义保证；
  **损坏 JSON 策略**（B 轨 M6）：备份原字节为 `.corrupt-<ts>` + 诊断日志 + 原子重建最小 managed 文件
  （唯一允许丢外来键的降级场景，测试覆盖）。
- flag-off 等价性口径（B 轨 B5 + A 轨 M12）：**「flag-off 且 `CLAUDE_CONFIG_DIR` 未设」逐字节等价**；
  dev（env 已设）下写手落点从真实 home 变隔离目录属既知改善，登记（含设置页全局 CLAUDE.md 在 dev 显示为空）。
  验收两测试：① env 零变异（注入 env 对象全量深比较 + set/delete spy=0）；② 磁盘黄金差分（冻结时钟、
  Buffer 逐文件比较、**比较文件数>0 断言**、`<userData>/claude-home` 不存在）。
- 已知泄漏面具名登记（flag-off 现状保留至 S12）：`ProviderDialog` 明文回显、`backups/` 多份明文副本（A 轨 m5）、
  `providers` 落 `~/.aiclient` 0644。IDE bridge lockfile 随迁托管 `ide/`（app 外终端看不到桥——已知限制补条，A 轨 m3）。

## §3 测试与验证（施工按 S1 范式细化；此处钉承重面）

1. 生成器/writer：两版快照 · 外来键保留 · 损坏 JSON 降级 · **并发交错**（barrier 让生成器与 Hook 写手同读旧值，
   终态 managed env + hooks + statusLine 三类哨兵全存活——A 轨 M2 指定形态）· 0600 含残留 tmp。
2. 启动两相：skeleton 不碰 env；**vault `locked` 时既有 env 字节不变**（B1 承重变异）；dev seed 单轮。
3. trust 四臂接缝 + 幂等 + 归一化。
4. Provider：readSettings flag-on 裁剪深查 · apply 恒 boolean + remote 放行 · watcher 四臂 · UI 首帧默认托管。
5. Scanner：双根合并/胜者内容断言（两臂 utimes 构造 + 同 mtime tie-break + 跨 project 同 sessionId 保双条——
   B 轨 M2 六臂谱）· provenance 贯通 resume · flag off 单根。
6. 静态扫描：命中计数基线 + 正/负控 fixture + 白名单精确到位置标记。
7. off 轮：§2 两测试 + 全量 vitest 门禁串行。
8. 变异 ≥10 对（必含：B1「locked 写空 env」· M2「写后不 chmod」· 「regenerate 抹外来键」· 「apply 返对象」·
   「readSettings 漏裁剪」——A 轨 m9 已把低咬合的「去重取旧」换为承重对）。

## §4 评审合取记录（要点）

| 项 | 裁定 |
|---|---|
| 重叠四处（Scanner 单例 B4≡B2 / apply truthy M5≡B4 / trust 矩阵 M3≡B1 / 写手竞态 M2≡B3） | 独立同结论，全采 |
| A 轨独有 | B1 两相启动+locked 保字节 / B2 登出确定性生成 / B3 readSettings 裁剪 / B5+M13 provenance / M1 剥离清单同源 / M4 当场凭据 / M6 watcher 咽喉 / M7 计数基线 / M8 Completions 联集 / M9 dev seed / M10 I5 接线 / M11 sidecar / M12+M14 等价性与 resume 裁定 |
| B 轨独有 | B1 调用矩阵四臂 / B5 黄金差分落法 / M1 watcher 失实纠正 / M3 扫描器自验 / M6 损坏 JSON 策略 / 3.2 后缀纪律沿用 |
| rev.1 自设裁定 a~f | a 成立（附 M5 条件）；b 成立但升级为 `{managed, claudeHomeDir}` 且无需放宽 S1 断言；c 附 dev seed 后成立；d 升级为统一写手；e 升级为 provenance 模型；f 修订为「一次性收编 copy」 |
| 母规格连带修订 | I3 措辞（硬编码禁令→计数基线口径）；§7 S2 行断言（非 resume 路径限定 + Scanner 锚定）；§6 已知限制补 IDE bridge 条 |
