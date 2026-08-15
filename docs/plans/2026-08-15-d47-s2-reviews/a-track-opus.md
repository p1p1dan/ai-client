> D47 S2 规格 rev.1 双盲对抗评审 · A 轨（deep-reasoner/Opus，运行时行为与兼容性镜头，2026-08-15）。原文归档。

核对完毕。下面是评审结果（不改任何文件）。

---

# D47 S2 规格 rev.1 对抗评审 — 运行时行为与兼容性镜头

核对基线：`main/index.ts` 全文、`services/claude/` 八个模块、`agent-host` spawn/ensureRuntime 链、三个 Provider 消费点、`App.tsx` resume 链、`scripts/dev.js`、S1 as-built 代码。

---

## BLOCKER（5）

### B1 启动期 regenerate 在 crypto 升格前读 vault → 每次启动抹掉托管凭据

**规格位置** §2.2「`ensureManagedClaudeHome` 触发点：启动（flag on，vault 可读或 absent 都要保证目录+`.claude.json` 存在）」+ §1 新文件签名「注入 `{ homeDir, vaultDoc|null }`」+ §2.1「无凭据版 = 同形状但 `env` 为 `{}`」。

**仓内证据**
- `src/main/index.ts:703-705` 升格闩挂 `app.once('browser-window-created')`；第一扇窗在 `src/main/index.ts:768` `openLocalWindow(...)` 才创建。启动阶段任何 vault 读都在升格之前。
- `src/main/services/auth/CredentialVault.ts:66-72` 读结果是五态联合；`:217` 在 `enc:'safeStorage'` 且 crypto 不可用时返回 `{status:'locked'}`（S1 §2.1 硬规定「永不 invalid」）。Win/mac 上 vault 必然是 `safeStorage` 加密 → 启动期读必得 `locked`。
- 规格把五态压成 `vaultDoc|null`，`locked` 与 `absent` 不可区分 → 生成器走「无凭据版」→ 覆盖上次登录写好的 `env`。
- 伤害放大链：`src/main/services/agent-host/AgentHostProcess.ts:48-50` spawn 时 `{...process.env, ...}`（时点正确，但读的是被抹空的文件）；`src/agent-host/index.ts:129-131` `if (runtime) return runtime` 永久缓存；`src/agent-host/claudeSettings.ts:29-34` 只在首次 `ensureRuntime` 读一次；`src/main/services/terminal/PtyManager.ts:378` `...process.env`。用户表现＝「每次重启就掉线，且整个进程周期不恢复」。

**改法** 生成器入参改成 S1 的完整 `VaultReadResult`：仅 `absent` 写无凭据版；`locked`/`unsupported`/`invalid` **一律跳过 env 段**（盘上既有 `env` 逐字节保留）。同时把启动动作拆两相：`ensureManagedHomeSkeleton()`（建目录 + `.claude.json`，不碰 `env`）放 `index.ts:136` 之后；`regenerateFromVault()` 放 `index.ts:768` 之后。必测变异：「预置带 env 的托管 settings.json + vault 为 locked → 启动后 env 字节不变」。

### B2 登出 regenerate 与 fire-and-forget `vault.clear` 竞态 → 可能把刚清掉的凭据写回

**规格位置** §1「`logout()`（vault.clear 后）flag on 时 regenerate 托管 home（登出=无凭据版）」。

**仓内证据** `src/main/services/onboarding/OnboardingService.ts:229-240` `logout()` 是**同步 `boolean`**；`:248-256` `clearVaultShadowCopy()` 用 `void getCredentialVault().clear(...)` 完全 fire-and-forget（S1 as-built 偏差 5 明写）。规格所谓「vault.clear 后」这个时点在现实现里**不存在**。

**后果** 若 regenerate＝「读 vault → 生成」，读到的多半仍是未清的 doc，把凭据写回托管 `settings.json`；母规格 §7 S5 行断言「登出后托管 home secret 字节=0」直接挂。

**改法** 登出走**确定性无凭据生成**（`generateClaudeSettings({credentials:null})`），根本不读 vault，且在 `removeClaudeCredentials()` 之后同步完成。把这条写进 §2.1 契约，而不是靠调用顺序描述。

### B3 `CLAUDE_PROVIDER_READ_SETTINGS` flag-on 仍把托管明文 token 推 renderer（破 I2/I1）

**规格位置** §1 S2b 只退役 apply / watcher / UI；§3-4 的断言是「只读卡不含明文（深查）」——UI 层断言，不是接缝断言。

**仓内证据**
- `src/main/ipc/claudeProvider.ts:20-31` handler 返回 `{ settings, extracted }`；`src/main/services/claude/ClaudeProviderManager.ts:229-231` `extracted.authToken` 是明文，`settings` 更是整份文件（含 `env.ANTHROPIC_AUTH_TOKEN`）。flag-on 时这份文件＝托管 home＝公司 token。
- 三个 renderer 调用点全部保留：`ProviderList.tsx:201`、`SessionBar.tsx:485`、`ActionPanel.tsx:231`。
- **二次落盘**：`src/shared/types/claude.ts:9` `ClaudeProvider.authToken: string` 是必填；「保存为当前配置」会把它写进 `claudeCodeIntegration.providers`，最终落 `~/.aiclient/*.json`——`src/main/services/SharedSessionState.ts:7,34,52` `writeFileSync` **无 mode**（默认 0644）。I1「此外任何位置不得出现明文 key」被打穿，且是世界可读。

**改法** 在 **Main handler 接缝**做 flag-on 裁剪（照 S1 §2.3 `createVerifyAndRegisterHandler` 的工厂接缝范式）：本地分支只返回 `{ baseUrl, 各 model 键 }`，`authToken` 与整份 `settings` 永不出 Main。负控测试驱动真实 handler，UI 隐藏只当第二道。

### B4 `ClaudeSessionScanner` 改「构造注入」会踩模块级捕获

**规格位置** §1 S2b「`ClaudeSessionScanner` 构造改注入双根」。

**仓内证据**
- 该类**根本没有构造函数**（`src/main/services/claude/ClaudeSessionScanner.ts:297`），路径靠模块级自由函数 `getClaudeProjectsDir()`（`:26-29`）**每次调用**读 env——今天之所以能跟随重定向，正是因为没有构造期捕获。
- 实例是模块级单例：`src/main/ipc/claudeSessions.ts:5` `const scanner = new ClaudeSessionScanner();`。ESM import 提升让这行在 `main/index.ts` 任何语句之前执行（S1 A 轨 B1 已立此案，判例注释在 `src/main/services/auth/index.ts:8-14`）。
- 全仓复核：`rg '^(const|let|export const) .*(homedir\(\)|CLAUDE_CONFIG_DIR|getPath\()' src/main src/agent-host src/preload` **零命中**——今天没有任何模块级路径捕获，S2 这条改动会是**第一个**。

**后果** flag-on 下主根固化成重定向前的 `~/.claude`，双源退化成「同一个 legacy 根扫两遍」，托管 home 的新历史全不可见；而 flag-off 全绿，只有真机 flag-on 暴露。

**改法** 注入**惰性提供者**（`{ resolveRoots: () => string[] }`）或保持调用级解析；补断言「env 在 import 之后变化时 scanner 跟随」（照 S1 §3-1h 的 setPath 跟随用例）。

### B5 renderer 拿不到托管 home 路径，「resume 候选前插托管 home」无法实现

**规格位置** §1 S2b「resume 候选：`resolveClaudeConfigDirForResumeSession` 候选列表 flag-on 时前插托管 home」+「renderer 如何知道 flag：新 IPC 只读查询 `auth.managedMode`（bool）」。

**仓内证据** `src/renderer/App.tsx:122-151` 候选完全由 `homeDir` 拼出，`homeDir` 来自 `src/preload/index.ts:809` 的 `HOME`；`<userData>/claude-home` 在 renderer 与 preload 侧**没有任何来源**。一个 bool 无法解决。

**附带**：现存 dev 侧已经断链——`scripts/dev.js:233` 把 `CLAUDE_CONFIG_DIR` 指向 `node_modules/.cache/aiclient-dev-credentials`，Scanner 列那儿的会话，resolver 却只查 `claude-null`/`~/.claude`（`App.tsx:131-133`），dev 下 resume 必失败。

**改法** `auth.managedMode` 返回 `{ managed: boolean; claudeHomeDir: string | null }`（路径非 secret），或把整个 resolve 搬进 Main（更合「Main 唯一权威」）。**注意**：S1 的静态禁令 `src/main/services/auth/__tests__/staticImportBans.test.ts:37-73` 禁的是 renderer/preload **import 三个符号**，不禁 IPC 通道注册——所以此处无需「显式放宽」任何断言，规格 §1 的措辞过度自我设限。

---

## MAJOR（14）

### M1 生产 strip 清单比 dev 窄，Bedrock/Vertex 顶穿口没堵
§1「剥离继承的 `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN`（`scripts/dev.js:91-100` STRIPPED 清单的生产版）」。真实清单在 `scripts/dev.js:91`（前缀 `ANTHROPIC_`）+ `:96-105`：`CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX / AWS_BEARER_TOKEN_BEDROCK / GOOGLE_APPLICATION_CREDENTIALS / CLOUD_ML_REGION`。规格只抄了两项，且引用行号 `91-100` 恰好截断在关键条目处。员工 shell 里一个 `CLAUDE_CODE_USE_BEDROCK=1` 就能让 CLI 绕开托管网关。**改法**：清单逐字列进规格，并由**同一个共享常量**派生 dev 与 prod 两侧（防单边漂移），加断言。

### M2 托管 `settings.json` 有四个写手，全是非原子读-改-写、无串行、无显式 chmod
§2.1 只说「写法照 `writeSettingsWithEnvGuard` 的读-合-写」。flag-on 后同写一份文件的是：
- 生成器（新）
- `ClaudeHookManager.ts:115-127` `writeSettingsWithEnvGuard` → 裸 `fs.writeFileSync`，且 `:107-114` 注释自述「We log instead of refusing」——**只报警不阻止**；五个调用点 `:453/:750/:933/:1001/:1069`
- `PluginsManager.ts:70-78` `writeSettings` 全量覆盖，零 env 守卫（`:118-131 setPluginEnabled` 走它）
- `ClaudeRuntimeConfig.ts:19-22` `writeJson` **连 mode 都没有**，`mkdirSync` 也无 mode（改口径后就往托管 home 写，`:37`）

现网已被咬过的证据：`OnboardingService.ts:326-330` 的注释明写「a sibling settings.json writer (ClaudeHookManager, ClaudeProviderManager) holds the file」并为此加了重试+读回校验。
**后果**：丢更新＝公司 token 从「唯一授权第二份落盘」里消失；`mode:0o600` 对已存在文件无效（S1 A 轨 B5 同款），若 `ClaudeRuntimeConfig.writeJson` 抢先创建，托管 `settings.json` 会**永久 0644 带 token**。
**改法**：§2.1 契约钉死——所有写手走同一个 `writeManagedSettings()`（进程内 Promise 队列串行 + tmp+rename 原子 + 写后显式 `chmodSync(0o600)`，直接复用 S1 写盘件）；flag-on 下 `writeSettingsWithEnvGuard` 由「告警」升级为「拒写+重读重试」。

### M3 `ensureWorkspaceTrusted` 读-改-写无并发保护，且调用点未钉
§2.1「`ensureWorkspaceTrusted` 增量补 ws 条目（读-改-写，保留既有键）」。同一份托管 `.claude.json` 的另一写手是 `McpManager.ts:43-52 writeClaudeJson`（全量覆盖）。多工作区并发建会话（切片 6 之后是常态）→ 后写者抹掉前者 ws 条目 → PTY 里 `claude` 卡首次信任对话框（E2 臂 (a) 就是这个现象）。且规格**没钉调用点**（`SessionManager.createLocal`？PtyManager？加仓库时？），§3 的验收面因此不存在。**改法**：同 M2 的串行原子写；调用点写死，或明确「本片只交付函数+单测，接线归 S3」。

### M4 flag-on 时 `vault.save` 失败 ＝ 静默无凭据登录
`OnboardingService.ts:179-187` flag-on 才 `await saveVaultShadowCopy`；`:212-216` 失败**只 warn**（S1 §2.7「影子写不阻断」）。失败因子真实存在（`crypto_not_ready`、as-built 偏差 6 的 `unsupported_version`）。S2 把 vault 从影子升成生成器的**输入源**，这条继承约束已失效：save 失败 + regenerate 回读 vault ＝ 用户「登录成功」但 CLI 无凭据，而 legacy 文件是好的，排障时两份真相打架。**改法**：regenerate 用登录当场手里的 credentials 对象（`getCredentialWriteInputs` 的返回值），不回读 vault；并在规格里显式改写「影子写不阻断」在 S2 的适用性。

### M5 `CLAUDE_PROVIDER_APPLY` 一刀切拒绝会误伤远程（破 I8），且返回类型是契约破坏
`src/main/ipc/claudeProvider.ts:34-47` handler 先 `resolveRepositoryRuntimeContext(repoPath)`，`kind==='remote'` 时写的是**远端**仓库设置（`writeRepositoryClaudeSettings`），与托管 home 无关；母规格 I8 明令远程维持现状。
更硬的一条：`applyProvider` 现在返回 `boolean`，三个消费点都按 boolean 判——`ProviderList.tsx:233-234`、`SessionBar.tsx:498-503`、`ActionPanel.tsx:241-247`（`if (!success)`）。规格要求改返 `{ok:false, reason:'managed'}` → **对象恒 truthy**，三处会静默弹「切换成功」而实际未切。**改法**：拒绝只包 `kind==='local'` 分支；返回值保持 `boolean`（或三处同改并加断言）；补负控「flag-on + remote repoPath → apply 仍成功」。

### M6 watcher 的 flag 门控有第二入口没堵；且 §0 事实 3 是错的
§0.3 断言「主进程 watcher **无视开关恒跑**」——**不成立**：`main/index.ts:774-778` 明确按 `enableProviderWatcher !== false` 决定，`claudeProvider.ts:57-61` `if (enabled) watchClaudeSettings(...)`。真正的洞在第二入口 `toggleClaudeProviderWatcher`（`claudeProvider.ts:66-72`），由 `src/main/ipc/settings.ts:105` 在用户改设置时调用，绕过 init。
漏堵后果：flag-on + 用户开 watcher → 监听托管 `settings.json` → 每次 regenerate/hook 写都触发 `ClaudeProviderManager.ts:129-134` 的 `webContents.send({settings, extracted})` 把公司明文 token 推 renderer，且 `useClaudeProviderListener.ts:48-84` 弹「New provider detected → Save」，一点就把 token 存进 `providers` 落 0644 文件（接 B3）。**改法**：flag 判定放进 `watchClaudeSettings()` 自身（唯一收口），init 与 toggle 自然被堵，两路径各一条断言。

### M7 静态扫描规则按字面写不可实现，I3 措辞已被本片自己的口径推翻
§1「禁新增 `homedir` 与 `'.claude'` 拼接；白名单豁免 `OnboardingService` 与 `RemoteHelperSource`」。本片选定口径就是 `CLAUDE_CONFIG_DIR ?? homedir+'.claude'`，所以改完后仍有大量字面命中：`ClaudeHookManager.ts:75`、`ClaudeProviderManager.ts:12`、`ClaudeIdeBridge.ts:96`、`ClaudeSessionScanner.ts:27`、`sessionLogReader.ts:15`、`ClaudeCompletionsManager.ts:18,31`、`agent-host/claudeSettings.ts:31`、`agent-host/historyReader.ts:241`——两个白名单远远不够，测试写不出来。母规格 I3「不再拼 `homedir()+'.claude'`」同样已被推翻。**改法**：规则改成「禁止**不带同表达式 `process.env.CLAUDE_CONFIG_DIR` 回退**的 `homedir+'.claude'`」，或退成「文件级 allowlist + 每文件命中计数基线」（照 `shellSwitchStatic.test.ts` 范式，更稳）；I3 措辞同步修订。

### M8 §0 事实 2 漏了 `ClaudeCompletionsManager`，而它是**联集**语义，与裁定 (f) 自相矛盾
逐条数规格自列清单只有 11 处（`McpManager:15` / `PluginsManager:8,12` / `PromptsManager:6,59` / `ClaudeRuntimeConfig:6` / `RemoteHelperSource:2093` / `OnboardingService:311,523,543,654`）。第 12 处是漏掉的 `ClaudeCompletionsManager.ts:31`，而且它不是硬编码单根，是 `getClaudeConfigDirs()`（`:30-45`）**把 `~/.claude` 与 `CLAUDE_CONFIG_DIR` 并起来**扫 `commands`/`skills`（`:47-53`），learned cache 却只跟主根（`:55-58`）。
后果：flag-on 下同一个 `~/.claude` 目录里三类资产三种策略——commands/skills＝联集（旧的可见）、CLAUDE.md＝只看托管（旧的静默失效）、历史＝双源合并。员工只会当 bug 报。**改法**：把 CompletionsManager 纳入 §1 改动清单与静态扫描白名单，并统一策略口径。

### M9 dev 轮 flag-on 必然无凭据，S2 的 GUI 点验路径未定义
`scripts/dev.js:198` 先剥 `ANTHROPIC_*` 与 STRIPPED_KEYS，`:230` 注入 dev.env token，`:233` 把 `CLAUDE_CONFIG_DIR` 指向隔离目录并 seed 了 `settings.json`（`:161`）+ 预信任 `.claude.json`（`:176-186`）。Main flag-on 后：覆盖 `CLAUDE_CONFIG_DIR`（隔离 settings 失联）+ 剥 `ANTHROPIC_*`（dev.env 注入的 token 也被剥）→ 托管 home 无 vault → 无凭据版 → **dev 下 Claude 完全不可用**，还丢掉 dev.js 的预信任条目。规格裁定 (c) 的理由「dev 显式开 flag 即意在验证托管链」在仓内落不了地。**改法**：补 dev seed 通道（仅 `!app.isPackaged`，flag-on 且 vault absent 时从 dev.env 一次性 seed），或明确「S2 GUI 点验必须走真实登录（S1 §3 开轮方式：临时 `SKIP_ONBOARDING_GATE=false`，点验后还原）」并写进验收步骤。

### M10 I5（凭据纪元＝host 生命周期）在本片被制造成新缺口，却无归属
全仓 `agentHostManager.shutdown()` 只有三处：`src/main/ipc/agentHost.ts:32/38/42`（手动 restart / 退出清理），登录/登出路径**零调用**。配合 `agent-host/index.ts:129-131` 永久缓存，B1 一旦发生，伤害从「一次」放大到「整个进程周期」；同一次运行内「登出→再登录」也拿旧 env。**改法**：本片 regenerate 成功后 `void agentHostManager.shutdown()`，或明写「I5 归 S5，S2 登记该窗口并断言 regenerate 后 host 状态」。别悬空。

### M11 生成物加 `"__generated__"` 抬头键是未实证动作
§2.1 自称「照 E2/E3 实证 + `scripts/dev.js:135-171` 配方」。两处不实：① `dev.js` 配方实际在 `:151-189`（`seedIsolatedConfigDir`），`135-171` 指到了 `parseEnvFile`/`maskSecret` 里；② E2/E3 的 `settings.json` **只含 `env`**（e3 报告原文「loaded settings.json env keys=ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL」），`dev.js:153-157` 也只写 `env` + `model`——**未知顶层键与 `skipWebFetchPreflight` 都没被 CLI 实打验证过**。**改法**：抬头放兄弟文件 `<claude-home>/.aiclient-generated`（version/commit/生成时间），不塞进 `settings.json`（未知键既有被 CLI 校验拒绝的风险，也会被 `extractProviderFromSettings` 之类读者原样带走）；若坚持塞，本片必须补一次 E2 式 PTY 实打。

### M12 flag-off「逐字节不变」在 dev（`CLAUDE_CONFIG_DIR` 已设）下不成立
§1「flag-off 行为逐字节不变」、§2.3「flag off 全现状」。但 `scripts/dev.js:233` 在 flag-off（缺省 `'0'`）时**照样**设 `CLAUDE_CONFIG_DIR`。改口径后，McpManager/PluginsManager/PromptsManager/ClaudeRuntimeConfig 在 dev flag-off 下从写开发者真实 `~/.claude*` 变成写隔离目录——方向上是好事，但等价性声明是假的，且设置页「全局 CLAUDE.md」会从有内容变成空白（会被当回归报）。**改法**：等价性限定为「flag-off **且 `CLAUDE_CONFIG_DIR` 未设**」；测试矩阵补第三轮（flag-off + env 已设）；dev 下 CLAUDE.md 变空写进已知变更。

### M13 双源合并后 provenance 丢失，类型无来源位
`src/shared/types/claudeSession.ts:1-9`（`ClaudeProject`）与 `:11-22`（`ClaudeSessionMeta`）都没有 root/source 字段。而 `scanProjects()` 还要产出 `sessionCount` 与 `lastActivityAt`（`ClaudeSessionScanner.ts:355-362`），合并是取并集计数还是相加，规格没说；`decodeProjectPathFromFiles`（`:504-516`）跨根时得知道去哪个根打开 jsonl。没有来源位，resume 就只能靠 renderer 逐候选 `file.exists` 反推（`App.tsx:138-150`），而 B5 说明 renderer 拿不到托管路径——两个洞互锁。**改法**：给 `ClaudeSessionMeta` 加 `configDir: string`（或 `sourceRoot: 'managed'|'legacy'`），resume 直接用它，B5 顺带解决；`sessionCount` 明确按去重后并集计。

### M14 resume 命中 legacy 根 ＝ flag-on 下往真实 `~/.claude` 写会话（与 I3 / S2 断言冲突）
`App.tsx:1167-1196` 把命中的 configDir 传给 `resumeClaudeSession` → `stores/agentSessions.ts:218-237` → `AgentPanel.tsx:1505` → `AgentTerminal.tsx:364-365` 变成 PTY 的 `CLAUDE_CONFIG_DIR` 覆盖。resume 老会话必然命中 `~/.claude`，于是 PTY 里的 `claude --resume` 把新消息写回 `~/.claude/projects/...`，并吃 legacy `settings.json` 的凭据（S6 停双写后＝过期/无凭据）。母规格 S2 行断言「一次 SDK 会话期间 `~/.claude*` 写调用数=0」与「历史双源可 resume 老会话」在此对撞。**改法**：三选一并写进规格——① 老会话 resume 也强制托管 home，jsonl copy-on-resume（需放宽「不搬运」约束）；② 保持读 legacy，母规格断言改成「非 resume 路径写调用数=0」并登记；③ 老会话降级为只读查看。现规格默认了①的效果却给了②的实现。

---

## MINOR（10）

- **m1 行位与顺序**：重定向应插在 `src/main/index.ts:136` 之后、`:139` 之前（`if (isDev) app.setPath('userData')` 块之后）。可行性已核：全仓无模块级路径捕获，唯一模块级实例是 `claudeSessions.ts:5`（见 B4）。规格需写明必须在 darwin 的 `shellEnvSync()` 合并（`index.ts:26-33`）**之后**——ESM 下顺序天然正确，但换人重排就破。
- **m2 trust key 归一化未定**：E2 与 `dev.js:176-186` 都用工作区绝对路径；Windows 大小写/分隔符/尾斜杠未规定，同一工作区可能写出两个键，信任框照弹。
- **m3 IDE bridge lockfile 随迁**：`ClaudeIdeBridge.ts:93-96` 落 `<managed>/ide`，app 外系统终端的 `claude` 读 `~/.claude/ide` 看不到桥。母规格 §6 已知限制 (b) 只写了凭据，补这条。
- **m4 completions watcher ENOENT**：`ClaudeCompletionsManager` 会订阅 `<managed>/commands`、`<managed>/skills`，生成器不建这两个目录 → 首次订阅失败刷日志（有 `watchersRetryTimer` 兜底）。生成器顺手 mkdir 或规格注明依赖重试。
- **m5 backups 是多份明文副本**：`ClaudeProviderManager.ts:19-27 backupClaudeSettings` 每次 apply 都把带 token 的 `settings.json` 复制进 `<configDir>/backups/`。§1「已知泄漏面随 S12 终清」应把这条**具名**登记（是多份，不是一份）。
- **m6 `auth.managedMode` 加载竞态**：三个 Provider 消费点首帧会以「未托管」渲染，闪出可写 UI 并可能已发一次 `readSettings`。默认取「托管/隐藏」，resolved 后再放开。
- **m7 §0.3 事实错误**：「主进程 watcher 无视开关恒跑」不成立（见 M6）。§0 是后续判断依据，请修正正文。
- **m8 §0.2 数字对不上**：自列清单算出 11 处，第 12 处是漏掉的 `ClaudeCompletionsManager.ts:31`（见 M8）。
- **m9 变异谱建议调整**：「双源去重取旧」咬合力低（sessionId 是 UUID，跨根同 id 现实≈0，只能靠 fixture 造）。建议换成 ①「regenerate 在 vault `locked` 时写空 env」（B1）②「托管 settings.json 写后不 chmod」（M2）两条承重变异。
- **m10 死链判定核实无误**：`session.listHistory` 在 `preload/index.ts:1446-1447` 有绑定、`agent-host/index.ts:488` 有 handler，renderer 零调用。登记即可。

---

## §4 自设裁定 a~f 逐条判真伪

| # | 判定 | 依据 |
|---|---|---|
| **a** `ClaudeRuntimeConfig.disableClaudeAutoUpdates` 改口径而非删除 | **成立，但需附加条件** | 确有两个活调用点：`AgentInstaller.ts:380` 与 `main/ipc/claudeRuntime.ts:50`（IPC handler），删了断 flag-off 链。**但**改口径后它成了托管 settings.json 的第四个写手，且 `ClaudeRuntimeConfig.ts:19-22` `writeJson`/`mkdirSync` **都没有 mode** → 可能成为托管文件的首个创建者并把它钉死在 0644。必须并入 M2 的统一写盘件 |
| **b** `auth.managedMode` 只读 IPC | **成立，且比规格说的更轻** | S1 静态禁令（`staticImportBans.test.ts:37-73`）禁的是 renderer/preload **import** 三个符号，**不禁 IPC 通道注册**——无需「显式放宽」任何断言，也不必改 S1 测试。**但** bool 不够用：必须返 `{managed, claudeHomeDir}`（见 B5） |
| **c** Main 无条件覆盖 dev.js 已设 `CLAUDE_CONFIG_DIR` | **按现写法不成立** | 覆盖本身无问题，但它与「剥 `ANTHROPIC_*`」叠加后把 dev 的两条凭据通路同时切断，托管 home 又无 vault → dev flag-on 全无凭据，本片的真机点验路径被打死（M9）。裁定需补 dev seed 通道或改写验收方式 |
| **d** regenerate 读-合-写保留外来键 | **方向对，力度不够** | 保留外来键是必须的（否则 hooks/statusLine/enabledPlugins 全被抹）。但真正风险不是「与抬头的语义张力」，而是**并发与原子性**：现仓已有三个写手同写这份文件，`OnboardingService.ts:326-330` 的重试注释就是被咬过的现场记录。裁定应升级为「统一串行原子写手 + flag-on 下 `writeSettingsWithEnvGuard` 改拒写重试」（M2）；抬头别塞 JSON（M11） |
| **e** 双源去重键 + mtime 新者胜 | **成立但低价值** | 去重键 `<slug>/<sessionId>` 正确；mtime 规则在现实里几乎不会被触发（UUID 不撞）。真正该定的是 **provenance** 与 `sessionCount` 合并口径（M13）。建议把这条的验证预算挪走（m9） |
| **f** `~/.claude/CLAUDE.md` flag-on 下不可见，接受并登记 | **成立但不该照现状接受** | 两条补充事实：① 不是「不可见」而是**静默失效**——CLI 读 `$CLAUDE_CONFIG_DIR/CLAUDE.md`，员工全局指令对每一次会话都不再生效，设置页显示空白且零提示；② 与同目录下 commands/skills 的**联集**策略（`ClaudeCompletionsManager.ts:30-45`）自相矛盾（M8）。要么统一策略，要么首次 flag-on 生成时把 `~/.claude/CLAUDE.md` copy 进托管 home 并在 UI 标注来源 |

---

## 判语：只改 blocker 能否开工

**不能。**

B1/B2/B4/B5 修完只能让托管链在 happy path 上跑通。真正卡开工的还有四条 major：

- **M2/M3**（四写手竞态 + 无原子写 + 0644 风险）直接决定「公司 token 会不会在正常使用中丢失或被 0644 落盘」——这是 I1 的承重面，且**已有被咬过的仓内证据**（`OnboardingService.ts:326-330`），不是理论风险。
- **M5** 是当场破坏现有 UI 契约的返工（`boolean` → 对象，三个消费点静默假成功），写码前不定就是白干。
- **M9** 决定这片交付时能不能做真机点验；**M7** 决定 §3-7 那条测试写不写得出来。

**建议开工门槛**：B1~B5 + M1、M2、M3、M5、M7、M9 先落进 rev.2 契约正文；M4/M6/M10/M11/M12/M13/M14 允许写成「条件执行 / 登记」但必须有明确归属切片；M8 与全部 minor 随施工 as-built 收口即可。

评审涉及的仓内证据文件（绝对路径）：
`/home/dan/projects/ai-client/src/main/index.ts`、`/home/dan/projects/ai-client/src/main/ipc/claudeProvider.ts`、`/home/dan/projects/ai-client/src/main/ipc/claudeSessions.ts`、`/home/dan/projects/ai-client/src/main/ipc/settings.ts`、`/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts`、`.../ClaudeProviderManager.ts`、`.../ClaudeCompletionsManager.ts`、`.../ClaudeSessionScanner.ts`、`.../ClaudeIdeBridge.ts`、`.../McpManager.ts`、`.../PluginsManager.ts`、`.../PromptsManager.ts`、`/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts`、`/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts`、`/home/dan/projects/ai-client/src/main/services/auth/{index.ts,CredentialVault.ts,__tests__/staticImportBans.test.ts}`、`/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostProcess.ts`、`/home/dan/projects/ai-client/src/main/services/terminal/PtyManager.ts`、`/home/dan/projects/ai-client/src/main/services/SharedSessionState.ts`、`/home/dan/projects/ai-client/src/agent-host/{index.ts,claudeSettings.ts}`、`/home/dan/projects/ai-client/src/renderer/App.tsx`、`/home/dan/projects/ai-client/src/renderer/components/chat/{AgentTerminal.tsx,SessionBar.tsx}`、`/home/dan/projects/ai-client/src/renderer/components/layout/ActionPanel.tsx`、`/home/dan/projects/ai-client/src/renderer/components/settings/claude-provider/ProviderList.tsx`、`/home/dan/projects/ai-client/src/renderer/App/hooks/useClaudeProviderListener.ts`、`/home/dan/projects/ai-client/src/shared/types/{claude.ts,claudeSession.ts}`、`/home/dan/projects/ai-client/scripts/dev.js`。