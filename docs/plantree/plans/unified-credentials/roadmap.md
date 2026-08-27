# Roadmap — 统一凭据目录与托管凭据转默认

> 状态：**In Progress** —— S1 · **S0'（Claude 侧 + codex 侧）** · **S2** 均已落地。
> **S0' 整条完成，S3 与 D64 已合并落地。**下一件 = **S4**（pi arm）。原先写「S3 的形状取决于 [entry-and-environment 的 D64](../entry-and-environment/README.md)」—— 已按此同轮做完。
> **2026-08-26 [D60](../../../plans/openchamber-chat-refactor-ledger.md) 重塑了 S2 之后的形状**：
> 隔离 home 降级为「只隔离凭据」，取消 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 整体重定向。
> 连带 open-q #2 关闭、#5 修法定案；新增前置切片 **S0'**。未决项见 [open-questions](./open-questions.md)。

## Done

- **2026-08-27 S3 + [D64](../../../plans/openchamber-chat-refactor-ledger.md) 合并落地：凭据模式从构建期开关变成运行期状态** ——
  `AICLIENT_MANAGED_CREDENTIALS` 退役为**仅开发期**逃生口，真正的答案存进 `~/.pilab/<profile>/settings.json`。

  **为什么必须合并做**：S3 原本是「退役 flag」，D64 把它改成「把 flag 换成用户可见的状态」——
  两者落地形态不同，分开做就会先落一个马上要推翻的东西。

  **规则**（纯模块 `@shared/credentialMode`，优先级从高到低）：
  ① 开发期 env 覆盖（`'1'`→managed，`'0'`→local），**打包后一律忽略**；
  ② settings.json 里记下的选择；③ 没有记录 → `managed`。

  **③ 是用户拍板，不是兜底**（2026-08-27「首次必须登录」）：配置里没有这个键就视为首次，首次必须登录。
  **代价已明示并接受**：从没走过公司登录的老用户升级后会被拦在登录页一次，包括一直用自己 key 干活的人。
  登录过的人不受影响 —— `adoption.ts` 开机把他们的凭据收编进 vault，解析为 `managed` 直接进主界面。

  **`'0'` 现在是显式 local，不再等同于「不是 1」**：旧 flag 下「off」和「未设」是一回事，现在不是。
  这条在测试面上是最大的一处语义变化 —— 十来处「delete 掉变量 = 关」的用例必须改成显式 `'0'`。

  **分层**：`AuthStateService` 与 `adoption.ts` 都是**契约上的纯模块**（后者的 import 禁令有静态扫描守着），
  而答案现在要读 settings.json（需要 electron）。所以把 `resolveManagedCredentialsEnabled` **移出** `AuthStateService`，
  电感依赖落在新的 `main/services/auth/credentialMode.ts`，两个纯模块改为**接收**已解析的模式：
  `AuthStateService` 收一个 `managed: () => boolean`（**函数不是布尔值** —— 模式现在会在服务存活期间变），
  `ensureVaultAdoption` 收 `managed: boolean`。13 个消费方只改 import 一行。

  **登录即选择 managed**，写在任何读模式的分支**之前**。少了这个顺序，一台处于 `local` 的机器登录时会**各取一半**：
  写用户自己的 `~/.claude/settings.json`（D60 与 S0' 花两个切片拿掉的东西）**并且**跳过 vault。

  **连带删掉遗留写入侧**（`persistCredentialFiles` / `writeClaudeConfig` / `writeCodexConfig` /
  `ensureClaudeOnboardingComplete` / `upsertCodexConfigToml`）—— 上一条之后没有任何登录能走到它们。
  **登出侧的清理刻意保留，并从「仅 local 分支」改为无条件**：它删的是只有我们写过的键
  （`ANTHROPIC_*` 三个 + `[model_providers.jyw]` 表），而 **S3 之前的构建确实写过**；
  继续按模式设闸的话，升级后再登出的用户会把我们的网关永久钉在自己配置里，且再没有任何路径能清掉。

  **变异 8/8 咬红**，其中 Q7 第一次是**存活**的，原因值得记：
  「登录后 `getCredentialMode()` 是 managed」这条断言看着对、其实什么都没证明 ——
  键不存在时解析器本来就答 `managed`，**默认值把写入盖住了**。改成直接读文件里的键才咬得住。
  （本会话第三次出现「断言看着对、变异证明它没用」。）

  四门：typecheck 0（含 agent-host）· biome 1000 文件 0 · **vitest 248 文件 5006 例**。
  真机四位置复核：未打包 `'1'`→managed · 未打包 `'0'`→local · 未打包未设→managed ·
  **已打包 + 环境设 `'0'` → 仍 managed**（用户够不到的变量决定不了他们的行为）。

  ⚠️ **切换入口尚不存在**：能写这个值的只有「登录」。用户可见的二选一要等
  [entry-and-environment 的 A2 登录页](../entry-and-environment/roadmap.md)。
  ⚠️ **留给登录页同轮定**：能否中途切换、切换时在途会话怎么办。当前形态是「读取不缓存 ⇒ 下次 spawn 生效」，
  在途会话保持原模式直到重开。

- **2026-08-27 S0'-b 配置加载失败的错误落地 ✅ 已落地** —— S0' 收尾，也是 [D63](../../../plans/openchamber-chat-refactor-ledger.md) 的连带要求。

  **为什么必须做**：S0' 让用户自己的 `~/.codex/config.toml` 变成承重件，
  于是我们第一次要报一类**以前根本到不了我们**的失败（原先隔离目录把它整个屏蔽了 —— 是遮住，不是处理过）。
  而 D63 拍的是「判断不了就放行」，**放行只有在失败说得清楚时才站得住**，否则那条拍板只是把成本转嫁给用户。

  **两类致命失败**（[E2 D 组](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)已量过边界：
  未知键 / 类型错 / 未激活的 `[profiles.x]` 表**都无害**）：
  ① **TOML 语法错** —— 报文带 `<路径>:<行>:<列>: <原因>`；
  ② **遗留 `profile = "x"` 根行** —— 报文**不带任何路径**。
  后者是真会发生的那个：`profile = "x"` 曾是官方写法（新参数类型直接叫 `CONFIG_PROFILE_V2`），
  用户什么都没做错；而他们系统里的 `codex` 若是老版本，**在自己终端里照常能用** ——
  症状是「我终端里 codex 好好的，AiClient 里起不来」。

  **实现**：纯模块 `agent-host/codexConfigError.ts`（分类 + 成文），接进 `startThread` 的失败分支，
  给出独立错误码 `codex_config_invalid`；`checkHomeEcho` 现在**记录** codex 回显的 `codexHome`，
  因为遗留-profile 那条报文没有路径，这个回显是**唯一**能说出「哪个文件」的来源。
  codex 的原话**原样引用不改写** —— 它比我们能写的更准，用户拿它去搜也搜得到。
  `configWarning` 通知（握手后、拒绝前推的同一份文本）只记日志不发事件，一个问题不报两次。

  **变异 8/9 咬红**，第 9 个的处理值得记：位置正则的注释**连写错两版** ——
  先归因给贪婪匹配、再归因给末尾锚点，两次都被「杀不掉的变异」戳穿。
  查清后订正为：挡住 Windows 盘符的其实是 `:(\d+):(\d+): ` 这个**数字要求**本身（`C:` 后面是反斜杠不是数字）；
  真正承重的是**惰性**路径组（报文里出现第二个位置时，第一个才是出错的文件，贪婪会指错文件指错行）——
  这条已由新用例咬红；末尾锚点确实**冗余**，注释里如实写明「杀不掉、不是防线」而不是给它编一个理由。

  **真机端到端**：拿随包 codex 喂两份坏配置 + 一份干净配置，
  坏的两份分别归类为 `legacy_profile` / `syntax_error` 并输出带文件、行列、修法的整句；
  干净那份不被改写（负控）。四门：typecheck 0（含 agent-host）· biome 997 文件 0 · **vitest 247 文件 5000 例**。

- **2026-08-27 S0' codex 侧 ✅ 已落地（`7785ee1c`）** —— 隔离 home 整个下线，凭据与 provider 改经 `-c` + env 注入。

  **换掉的是什么**：`CODEX_HOME` **不再由我们设置**（任一分支都不设），codex 因此读用户自己的 `~/.codex`
  ——他们的全局 `AGENTS.md` 与 `agents`/`hooks`/`skills`/`plugins` 整棵树**结构性回来**，
  不需要投影、不需要收养。原先写进 `config.toml` 的那几件事全部搬到命令行：
  `-c approval_policy` / `-c sandbox_mode` / `-c model_provider` / `-c model_providers.jyw.*`（含 `env_key`）。
  新模块 `agent-host/codexConfigOverrides.ts` 是纯函数，把这套 argv 一次说清；
  凭据本身仍只走 env，**argv 上不带任何密钥**（`ps` 全机可见）。

  **新增一个 env 键**：`AICLIENT_CODEX_BASE_URL`。它替掉了 `AICLIENT_CODEX_HOME_MANAGED_DIR`
  —— 一个路径换成一个值，这就是 D60 的形状。`resolveCodexCredentialMode` 现在**两半都要**
  （key + baseUrl），少一半一律 `managed_missing_credentials`：半份凭据不是"降级的凭据"，
  是"指向别家的凭据"。

  **删掉的东西**：`agent-host/codexHome.ts`（投影 + config.toml 生成 + auth.json 删除，761 行）·
  `main/services/auth/codexHome.ts`（托管 codex-home 物化）· `shared/codexManagedConfig.ts`（生成器）·
  注册表的第三道闸 `home_prepare_failed`（那道闸每次 Host 启动都要建目录、投影、拷 auth.json，
  现在**注册表构建期零写盘**）· 登录/登出/启动三处 regenerate · Host 入口的 `AICLIENT_CODEX_HOME` 缺失拒绝。

  ⚠️ **一处用户可见的行为变化，须拍板**：**应用内终端敲 `codex` 不再走公司网关**。
  原先终端拿 `CODEX_HOME`（指向托管目录）+ key 两件套，而**这两半不能拆**——key 单独给毫无意义
  （用户自己的 config 不会用 `env_key = "AICLIENT_CODEX_API_KEY"` 这个名字），
  而 codex **没有任何环境变量能改 `base_url`**。这与 Claude 侧的不对称不是疏漏：
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 是 CLI 直接读的名字，codex 没有对应物。
  已登记为 [open-q #8](./open-questions.md)。

  **变异 9/9 咬红**（posture 从 `-c` 里拿掉 / posture 只在 managed 分支发 / `requires_openai_auth`
  发成带引号字符串 / base_url 裸插值可越狱 TOML / 重新注入 `CODEX_HOME` / 凭据半份也算 managed /
  Main 只送 key 不送 baseUrl / 启动期又写 codex-home / 终端又注入 `CODEX_HOME`）。
  四门：typecheck 0（含 agent-host）· biome 995 文件 0 · **vitest 246 文件 4983 例**。
  **真机确认**：启动后 `<userData>/codex-home` 里的文件时间戳仍是旧版本写的那一刻，本次启动零触碰。

  ⚠️ **本批未做（S0' 的最后一件，见下方 Next）**：[E2 ③](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)
  要求的**配置加载失败的错误落地**。这条同时是 [D63](../../../plans/openchamber-chat-refactor-ledger.md) 的连带要求。

- **2026-08-27 S2 目录改名 `.aiclient` → `.pilab` + 凭据迁入 ✅ 已落地（`18da2d7f`）** ——
  `APP_STATE_DIR` 改值，本机布局变成 `~/.pilab/<profile>/`（`settings.json` · `session-state.json` ·
  `credentials/vault.json` · `remote-auth/` · 三个迁移标记），凭据从 `<userData>/credentials/` 搬入同一处。

  **profile 层的实现方式**：取 `<userData>` 的 basename（`jyw-ai-client` / `jyw-ai-client-dev`），
  **不另立一套命名规则** —— 这样 `AICLIENT_PROFILE=foo` 一改，两个根一起动，没有第二处要同步。
  纯核心放在 `@shared/appStateLayout`，electron 包装放在 `main/services/appStatePaths.ts`：
  拆开是因为 `adoption.ts` 需要这套布局而它**契约上是纯模块**（`adoptionStaticImportBans.test.ts` 守着），
  而它本来就已经拿到 `<userData>` 参数。

  **迁移是 copy 不是 move**（`appStateMigration.ts`，boot 里排在 Phase ⓪、`setPath('userData')` 之后第一件事）。
  两条理由，第一条是正确性：**旧根没有 profile 层**，正式版与开发版读的是同一个 `~/.aiclient`，
  谁先启动谁把字节搬走，另一个就会以「全新机器」姿态起来。第二条是留一条可回退的路。
  目标已存在的文件**一律跳过**（先写者赢），所以幂等、可重入，也不会用陈旧的旧文件盖掉用户在新版里改过的设置。

  **硬验收线（不许任何人重新登录）已在真机走通**：造一台「S1 形态」的机器
  （`<userData>/credentials/vault.json` 0600 + `~/.aiclient/settings.json` 带 registered），
  真启动一次 → `[appState] migrated to .pilab: copied=4` · vault **逐字节相同**且 **mode 仍是 0600** ·
  旧根原样保留 · 标记写入。另有 `adoption.ts` 的两根读法兜底：先读新根（迁移后字节在那），
  新根没有再回落旧根 —— 迁移万一失败也不会让用户丢会话。

  **顺带修掉 S1 静态扫描的一个洞**：旧扫描要求名字前面是单引号，于是
  `RemoteConnectionManager.ts` 里 `` `${runtime.homeDir}/.aiclient` `` 这处**模板字面量用法整个漏掉了**
  ——S1 自称「五处全部转常量」，实际是六处。新扫描改成**先剥注释再扫**（注释里可以写、代码里不许写），
  并加了前后边界（排除 `.aiclient-generated` 文件名与 `com.aiclient.app` bundle id）。
  变异 M7 复现了这个洞：把裸字面量放回去，旧法仍绿、新法咬红。

  **另修一条本批自己引入的真回归**：凭据离开 `<userData>` 之后，
  「只把 `<userData>` 指向临时目录、没管 `$HOME`」的测试开始**往开发者真实 home 里写 vault** ——
  跑完一轮全量在 `~/.pilab/` 下发现 **96 个**临时目录，每个都含一份 `vault.json`。
  没有逐个打补丁（那只修今天不修明天），而是在边界上堵：
  `src/__tests__/setup/hermeticHome.ts` 让每个测试进程拿到自己的一次性 `$HOME`。

  **变异 8/9 咬红**（去掉 profile 层 / 改成 move / 允许覆盖已存在文件 / 新装也写标记 /
  adoption 只读新根 / adoption 只读旧根 / 扫描洞复现 / vault 退回 `<userData>`）。
  第 9 个**杀不掉**，因为那段 `chmodSync` 是死代码 —— `copyFileSync` 本身就带过权限位；
  该段已删除，并留下 `[实测]` 注释（换成 read+write 会红成 0o664 vs 0o600）。
  四门：typecheck 0（含 agent-host）· biome 1000 文件 0 · **vitest 249 文件 5032 例**。

  **交付物（D62 要求）**：[发布说明草稿](../../../release-notes/unreleased.md) —— 本机透明迁移、
  旧目录保留不删、**远端已连机器会像被重置一次**（设置回默认 + runtime 重下一次）。

  ⚠️ **刻意未动**：`com.aiclient.app`（bundle id）· `productName: AiClient` · package `jyw-ai-client` ·
  `.aiclient-generated` sidecar 文件名。品牌口径统一是 [open-q #4](./open-questions.md) 记的另一件事，不在本批。
  ⚠️ **远端侧只改名、不加 profile 层**：`MANAGED_REMOTE_RUNTIME_DIR` 与生成的 helper 里那两条路径
  指的是**别人机器上的目录**，那里从不写凭据，且远端状态属于那台主机而不属于「哪个本地构建连过它」。

- **2026-08-26 S1 目录字面量收敛 ✅ 已落地** —— `.aiclient` 收敛为 `defaultPaths.ts` 的
  `APP_STATE_DIR` 单一常量，7 处改为 import。**实际是 7 处不是立项时估的 5 处** ——
  多出的 `OnboardingService.ts:110` 与 `adoption.ts:48` 是**静态扫描断言抓出来的**，
  人工 grep 漏了；这条断言的价值当场兑现。
  **零行为变更已实证**：生成的远端 helper 脚本前后**逐字节相同**（89,307 B），
  中途一版用 `JSON.stringify` 插值导致引号从 `'` 变 `"`（语义等价但非逐字节），已改直接插值消掉。
  静态扫描收紧过一次：`claudeHome.ts` 的 `.aiclient-generated` 是**文件名**不是目录名，
  前缀匹配会误报，改为要求后随 `'` 或 `/`。
  变异 2/2 咬红（还原一处裸字面量 → 扫描红；改常量值 → 兜底断言红）。
  四门：typecheck 0（含 agent-host）· biome 995 文件 0 · **vitest 247 文件 5005 例**。
  ⚠️ **刻意未动**：`i18n.ts` 与 `RemoteSettings.tsx` 里两条含 `~/.aiclient/...` 的**占位示例文案** ——
  它们的英文原文同时是 i18n 查找键，改动即改键，超出「零行为变更」范围。
  已在扫描断言里**显式列出而非静默跳过**，S2 改名批不得遗漏。

- **2026-08-26 S0' Claude 侧 ✅ 已落地（`77ff5dd4`）** —— `CLAUDE_CONFIG_DIR` 重定向取消，凭据改经 env 直送。
  用户的 `~/.claude`（CLAUDE.md · commands · skills · plugins · hooks）在 GUI 与运行时**全部回来**。

  **通路替换**：Main 每次 spawn 现读 vault → `AICLIENT_CLAUDE_BASE_URL` / `AICLIENT_CLAUDE_AUTH_TOKEN`
  两个 env 键（`hostEnv.ts`，照抄 codex 的 `AICLIENT_CODEX_API_KEY` 通路）→ Host 侧
  `claudeSettings.ts` 以「**vault 优先于用户 settings.json**」的规则合并进 `options.env`。
  终端 pty 走同一份 vault，直接注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`。
  **这条优先级规则是整个方案对目录控制的唯一替代品**，7 个断言专门守它。

  **下线的东西**：托管 claude-home 目录整体（skeleton / settings.json 生成 / `.aiclient-generated` sidecar /
  空 commands+skills 目录 / CLAUDE.md 一次性收养）· `generateClaudeSettings` · `getManagedClaudeHomeDir` ·
  登录与登出的 claude-home regenerate 分支 · 会话历史的 dual-root（回落单根，天然跟随用户的 `CLAUDE_CONFIG_DIR`）。
  文件更名 `managedClaudeHomeStartup.ts` → `managedCredentialsStartup.ts`（名字里的 ClaudeHome 已不存在）。

  **仍然写的唯一用户文件**：`~/.claude.json` 的 onboarding 与 workspace trust —— **merge 不是重写**
  （`{...我们的默认, ...用户现有}`，用户已有键恒赢），且正是 claude CLI 自己接受 trust 对话框时写的同一条目。
  没有这一步，第一次用我们 GUI 的用户会卡在 CLI 的主题/信任向导里（D47 S0 [E2](../../../plans/2026-08-15-d47-s0-spikes/e2-claude-json-trust.md) 实证）。

  **施工中抓到的两个真缺陷**（都由新断言先咬红，不是事后发现）：
  ① `stripInheritedCredentialEnv()` 会连用户自己设的 `CLAUDE_CONFIG_DIR` 一起删 ——
  旧设计下无害（删完立刻设回自己的值），D60 后就是**删掉用户的深思熟虑**。
  修法：`CLAUDE_CONFIG_DIR` 移出共享凭据列表（它是路径不是凭据），`scripts/dev.js` 本地追加它
  （dev.js 紧接着要设自己的隔离目录，清场是它自己的事）。
  ② 旧 vault 文档没有 `claude` 分支时解构会抛 —— 改 `?.` 并降级为「无托管凭据」。

  **变异 5/5 咬红**：恢复重定向 / 优先级反转（settings.json 赢）/ 两个 claude 键改成 omit-when-undefined
  （污染防御失效）/ pty 不注入 / 重新创建托管目录 —— 每个都至少打红一条断言。
  四门：typecheck 0（含 agent-host）· biome 995 文件 0 · **vitest 247 文件 5012 例**。

  ⚠️ **本批只动 flag-on 路径**：`AICLIENT_MANAGED_CREDENTIALS` 仍在（退役归 S3），flag-off 保持零变异契约。
  ⚠️ **codex 侧未施工**：[E1](../../../plans/2026-08-26-s0-spikes/e1-codex-no-home.md) 已证可行，但改造不在本批。

- **2026-08-26 立项与起点摸底** —— 实测确认「用户设想的东西大部分已存在」：
  `~/.aiclient/settings.json` 已在用、vault 已按 agent 分存 url+key、`adoption.ts` 已能免重登收编存量。
  缺的是合并 + 改名 + 打开三件事。详见 [README 起点认知](./README.md)。

## Next（按依赖序）

### ~~S0' — 取消隔离 home，凭据改经 env 直送（D60 主体）~~ ✅ **整条已落地**（Claude 侧 `77ff5dd4` · codex 侧 `7785ee1c` · 收尾 S0'-b）

以下为立项时的设计原文，保留作为 as-built 对照。

**排最前的理由**：codex 侧的配置树丢失**今天已经在影响用户**（`ensureCodexHome` 不受托管 flag 控制），
且 S3 的形状完全取决于本切片的结果。

**Claude 侧** —— ✅ 已落地，见上方 Done 条目。

**codex 侧 —— ✅ E1 取证已完成（2026-08-26），结论 = 是，退化分支已关闭**

证据：[e1-codex-no-home.md](../../../plans/2026-08-26-s0-spikes/e1-codex-no-home.md)（11 个用例，离线，未改产品代码）。

`codex app-server` 支持 `-c key=value`（TOML 覆盖），凭据 / provider / posture **三样都能不落文件**注入
⇒ `CODEX_HOME` 可以就是用户自己的 `~/.codex`，**软链投影 / 直写用户目录两个退化方案都不需要了**。

1. `CODEX_HOME` 不再指向 `<userData>/codex-home`，就用 `~/.codex`
   ⇒ 用户全局 `AGENTS.md` + `agents`/`hooks`/`skills`/`plugins` 整棵树**结构性恢复**，无需投影无需收养。
2. provider + 凭据经 `-c model_providers.<id>.env_key=…` + 一个 env 变量注入（R2/R3 实测）。
3. posture 经 `-c approval_policy` / `-c sandbox_mode` 强制，与今天写进 config.toml 等价（R5 实测：
   用户 config 写死 `never`/`danger-full-access` 也被盖住）。
4. `ensureCodexHome` 的 projection 写盘、`config.toml` 生成、`auth.json` 删除**三件事全部下线** ——
   R6/R7 实测用户 `auth.json` 里的 `OPENAI_API_KEY` **不会遮蔽** env_key，也**不是静默兜底**，
   「删 auth.json 防遮蔽」这一步在新方案下失去理由。

**施工前欠的两发 —— ✅ 2026-08-27 [E2](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md) 补齐，两问都放行**

（E2 起了一个本机假网关让回合真正跑完，这样才有 rollout 可 resume、才有真实出向报文可查。仍然零外网。）

- **跨进程 resume 的 posture：`-c` 扛得住**（A-P2 实测）。对照组 P3 不带 posture `-c` 时
  sandbox 回落到用户文件的 `dangerFullAccess`，两向都咬住了。
- **`developer_instructions` / `notify` 确实会一并生效**（B-C1 实测：哨兵串出现在真实请求体里、
  notify 程序真的被执行）；顺带把**全局 `AGENTS.md` 生效**也实测到了 —— D60 取消隔离想要的效果有了正面证据。
  `profiles` 一问**作废**：0.149.1 不再支持 `profile = "x"` 写法，而 `app-server` 根本没有 `--profile` 参数。

**⚠️ E2 新捞出两条，S0' 施工要一并处理**：

1. **会把用户机器搞挂的回归**：取消隔离后用户 `~/.codex/config.toml` 变成承重件，
   而 **TOML 语法错**或**遗留 `profile =` 根行**会让 `thread/start` 直接失败、**`-c` 救不回来**
   （`-c` 是在配置加载成功之后才合并进表的）。今天隔离 home 把这类问题整个屏蔽了 ⇒ **这是 S0' 引入的**。
   `profile =` 尤其阴：老版本 codex 里它合法且常见，用户系统装的 codex 可能还认，
   现象会是「我终端里 codex 好好的，AiClient 里起不来」。
   爆炸半径已量过（D 组）：未知键 / 类型错 / 未激活的 `[profiles.x]` 表**都无害**，只有上面两类致命。
   对策：`thread/start` 的 `-32600` 若含 `failed to load configuration`，
   不要降级成通用会话失败，把 codex 自己给的**文件路径 + 行号 + 原因**原样带到 UI。
2. **一条与仓内注释矛盾的事实**：`approval_policy` 在 resume 时**由 rollout 定死**，
   `-c` 与 `config.toml` 谁都改不动（A-4 三路对照）。对 S0' **不构成回归**（新旧两法同样无力），
   但 `codexHome.ts` 「改常量会 RE-POSTURE 老线程」的注释**是错的**，须订正；
   且 `verifyResumePosture()` 会因回显对不上而抛错 ⇒ 那些线程会**变成打不开**而不是变弱。
   常规路径撞不到（冷 resume 的期望档位取自会话自己存的偏好，与出生同源），
   两个例外要确认：会话建好后**改过**权限偏好 · **没存偏好的老会话**遇上常量改值。

**⚠️ E1 带出的新策略问题（[open-q #7](./open-questions.md)，S0' 施工前须拍）**：取消隔离后，
今天 projection 刻意丢弃的用户 `mcp_servers` / `developer_instructions` **会流回来生效**（R8 实测用户 MCP 被真实拉起）。
posture 那半 `-c` 补得回来，这半补不回来：`-c mcp_servers={}` 整表清空**无效**（R9），
只有逐条 `-c mcp_servers.<name>.enabled=false` 有效（R10）—— 而逐条压制**需要先读用户 config 枚举名字**。

**验收**：真机零 env 起 app —— ① 用户 `~/.claude/CLAUDE.md`、`commands/`、`skills/`、plugins 在 GUI 与运行时**都在**；
② 用户 `~/.codex/AGENTS.md` 与配置树生效；③ claude 与 codex 都用 vault 里的 key 起会话；
④ 用户自设 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 仍被尊重；
⑤ 存量机器不被要求重新登录（`adoption.ts` 的 `flag_off` 早退分支连带复核）。

### ~~S2 — 目录改名 `.aiclient` → `.pilab` + 凭据迁入~~ ✅ 已落地（2026-08-27，见 Done）

以下为立项时的设计原文，保留作为 as-built 对照。

**不受 D60 影响**（这是我们自己的目录，与 agent 配置树无关）。

**目标形态**（用户 2026-08-26 当场指定并确认目录名仍取 `.pilab`）：

```
~/.pilab/
  jyw-ai-client/              ← profile 层（正式版）
    settings.json
    session-state.json
    credentials/vault.json    ← 从 <userData>/credentials/ 迁入
    remote-auth/
    remote-runtime/
  jyw-ai-client-dev/          ← profile 层（开发版）
    ...
```

用户原话：「应该是存到我们自己的应用文件夹，而不是 `<userData>/credentials`」。
这正是 [D59](../../../plans/openchamber-chat-refactor-ledger.md) ①「合并」的落地形态 ——
今天设置在 `~/.aiclient/`、凭据在 `<userData>/credentials/`，**分裂的两处合成一处**。

**profile 层不是可选的**（open-q #1 已拍板）：凭据一旦离开 `<userData>`，
正式版与开发版就会共用同一份凭据 —— 开发时的实验改动会写到用户真实账号上，
`cchBaseUrl` 也会在测试网关与真网关之间横跳。分层就是挡这个，
保住今天靠 `jyw-ai-client` / `jyw-ai-client-dev` 后缀取得的隔离性。

**必须同批处理的三件事**：
1. **常量改值**：`APP_STATE_DIR`（S1 已收敛成单一常量，这是它存在的理由）。
   ⚠️ S1 刻意未动的两条 i18n 占位文案（`i18n.ts` / `RemoteSettings.tsx` 里含 `~/.aiclient/...`）
   本批不得遗漏 —— 静态扫描断言里已显式列出。
2. **本机迁移**：旧目录存在则搬运（设置 / session-state / remote-* / 凭据 / 迁移标记），
   幂等、可重入。**存量用户不得被要求重新登录** —— 这是本切片的硬验收线。
3. **远端孤儿 ✅ 已拍板（[D62](../../../plans/openchamber-chat-refactor-ledger.md)）：接受，不做远端搬运。**
   已连过的机器留下 `~/.aiclient/`，远端设置回默认 + runtime 重下一次 —— 不会坏，只是观感像被重置。
   ⇒ **S2 多一条交付物：发布说明必须写明这一项**，否则用户会当成 bug 报上来。

**S2 的开工前置已全部出清**（#1 profile 分层 · #3 远端孤儿 · #4 目录名二次确认），可进 execute。

### ~~S3 — `AICLIENT_MANAGED_CREDENTIALS` 转默认开~~ ✅ 已落地（2026-08-27，与 D64 合并，见 Done）

以下为立项时的设计原文，保留作为 as-built 对照。

退役 flag，让托管凭据成为唯一路径 —— 与 [D58](../../../plans/openchamber-chat-refactor-ledger.md) 对 codex flag 做的事同型。

**D60 之后它比原计划轻得多**：一开不再意味着「`CLAUDE_CONFIG_DIR` 切走 + settings.json 被重写」，
只意味着「凭据来源从用户 settings.json 换成 vault」。原先挡在这里的 open-q #2 已随之关闭。

**依赖**：S0' 落地后才有意义（否则退役 flag 等于把整体重定向转正）。

⚠️ **2026-08-27 新增：形状还取决于另一个 plan 的一条待拍板。**
[entry-and-environment](../entry-and-environment/README.md) 想把启动首屏做成两按钮
（登录 / 使用本机已有配置），那等于把「用哪套凭据」从**构建期开关**变成**用户的运行期选择**。
若那条拍成「运行期二选一」，S3 就**不再是「退役 flag」，而是「把 flag 换成一个用户可见的状态」** ——
两者的落地形态不同。⇒ **S3 与 [那边的待拍板 #2](../entry-and-environment/open-questions.md) 必须同轮定**，
否则 S3 会先落一个马上要推翻的形态。

### S4 — 为 pi 预留 vault arm

`VaultPayload` 加第三个 arm 的形状与迁移（vault 有 `SCHEMA_VERSION`，加字段要走版本位）。
**不做 pi 接入本身**，只保证加家不需要动架构。排在 pi 立项之后或与之合并。
D60 之后这条更便宜：加一家 = 加一对 env 键，不再是加一棵投影树。

## Deferred

- **明文 `auth.json`**：用户拍板保留 safeStorage 加密（D59 ③）。理由记在 D59：加密防的是误泄不是被盗，
  但代码已有、删掉是净损失。⚠️ 已知缩水：Linux 无 keyring 时 Chromium 退到固定密钥后端，
  而 `isEncryptionAvailable()` 仍返回 true ⇒ 我们照旧标 `enc:'safeStorage'`，实际防护接近装饰。
  **不据此依赖它作安全底线。**

- **`settingSources: []` 与 CLAUDE.md 上下文**：D60 明确不在本 plan 内，见 [open-q #6](./open-questions.md)。
