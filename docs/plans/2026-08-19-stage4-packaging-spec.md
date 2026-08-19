# 阶段 4「2b 打包链」施工规格（rev.1）

> 2026-08-19。plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> **权威链**：[S3 切片 2 仲裁档](./2026-08-09-s3-slice2-arbitration.md)（用户裁定层，最高）→
> [阶段 4 立项调查档](./2026-08-19-stage4-packaging-kickoff.md)（REQ 清单 + D52 拍板）→ **本文**（施工唯一入口）。
> 与仲裁档冲突处以仲裁档为准，**唯一例外**：仲裁 C-b 的「external」半句已由本文 §0.2-① 正式改判（有实测依据）。
>
> **产生方式**：编排者三路调查（sonnet ×3）合流立项 → 本文为规格 rev.1，待双轨双盲评审（工法同 D47/D48）。
> **标注纪律**（沿用仲裁档）：`[实测]` = 本批在本机/本仓跑出过字节证据 · `[读码]` = 源码可证 · `[推测]` = 仍是推测，**不得升格**。
> **本文全部 file:line 均于 2026-08-19 在 `aa016b9` 上 `cat -n` 实读核对。** 本机实测环境：Linux x64 / node v24.18.0 / `codex-cli 0.145.0`。
>
> 实现方对标注「**实现方可否决**」的项保留否决权；开放问题**单列 §11**，不混进正文。

---

## §0 结论先行

### 0.1 三句话

1. **切四片，依赖序 P1 →（P2 ∥ P3）→ P4**：P1 = 依赖 pin + `build-agent-host.mjs` 四处改造（preflight / copy-prune / mustExist / mustNotExist），产物 = 一个**本地可验的 `out-agent-host/`**，零运行时行为改动；P2 = Main 接线（`AICLIENT_CODEX_JS_PATH` 注入 + AgentInstaller 降级为 fallback + 平台闸）；P3 = 出包与 CI（`electron-builder.yml` 死规则 + D36 Linux 捆 Node + D41 前置门禁 + 缓存/磁盘核算）；P4 = 打包后验证（结构断言 + 零额度 Codex 握手 smoke + 双边体积门禁 + TSD 头扩扫）。
2. **本批不新增任何协议、不新增任何 env 候选规则、不改任何 resolver 顺序**：接线口 `AICLIENT_CODEX_JS_PATH` 在 `codexNodeEntry.ts:100` 已是**候选表第 1 条**（`[读码]`），Main 侧只是往既有 env 契约（`hostEnv.ts:62-73`）加一个**条件注入**的键。REQ-8 / REQ-9 逐字重申见 §1.1。
3. **两条与立项档倾向相反的裁定**：① `codex-code-mode-host`（44MiB）**保留不 prune**（R3 查证结论：我们默认模型正是 `code_mode_only` 的那个，见 §3.5）；② esbuild `external` **不加 codex**（全仓零 import，见 §0.2-①）。

### 0.2 定稿相对上游文档的改判清单

> 给评审者的差异索引：说明「为什么与你读过的仲裁档/立项档不同」。施工方只读正文即可。

| # | 改判项 | 上游原状 | 本文裁定 | 依据 |
|---|---|---|---|---|
| ① | esbuild `external` 是否加 `@openai/codex` | 仲裁 C-b：「preflight / external / copy-prune / mustExist / packaged verifier **整条都要改**」 | **不加**。`external` 保持 `['@anthropic-ai/claude-agent-sdk','@cometix/claude-code']` 两项不动（`build-agent-host.mjs:113`） | `[实测]` 全仓零 `import … from '@openai/codex'`：`grep -rn "@openai/codex" src/` 命中 10 处**全部是字符串/注释/测试断言文案**（`codexNodeEntry.ts:9/134/254/255`、`agentSupport.ts:234`、三处 `__tests__` 文案、`spikes/s1-acp-codex-probe.ts:17`）。codex 是 `spawn` 出去的外部 CLI，esbuild 的模块图里根本没有它 —— 往 `external` 里加一个从不被 import 的名字，是**零效果的假施工**，还会让下一个人以为它进了 bundle 依赖面 |
| ② | `codex-code-mode-host`（44MiB）取舍 | 立项档 R3：「code-mode 特性我们不消费则 prune 掉」 | **保留**，并加 mustExist 断言防误删 | 前提不成立，见 §3.5 三条证据（探针实测 `gpt-5.6-sol` 是 `tool_mode:"code_mode_only"` + 我方 managed config 刻意不写 `model` ⇒ 默认落到该模型） |
| ③ | `AICLIENT_CODEX_JS_PATH` 的注入范式 | D47 三键范式（`hostEnv.ts:29-46`）：键**恒在**、值可 `undefined`，用来**压制**继承污染 | **相反**：值缺席时**整键省略**；且用户 shell 已设该键时 Main **不覆盖** | 两者防的东西不同：D47 三键是**凭据**，一个从开发 shell 漏进去的 key 是安全事故；本键是**路径**，且 `codexNodeEntry.ts:34-35/99-100` 逐字自陈它是「explicit escape hatch」。覆盖它 = 删掉逃生口，与 C-a「坏的 bundled 可被 env 覆盖」同构反例 |
| ④ | build-linux 的 `Setup Node.js 24 (packaged-state verify)` 步骤 | `build.yml:231-237` 现存（Linux 不捆 node，故靠 runner 的 machine node 满足断言） | **删除** | D36 落地后若保留，`main()` 的 `Boolean(node24) \|\| Boolean(bundled)`（`verify-packaged-app.mjs:320-326`）会被 runner 的 node 24 满足 ⇒ **bundled 整个坏掉也照样绿**。删掉后 runner 只剩 node 20（`build.yml:187-192`），该断言只能由 bundled 满足，才是真覆盖 |
| ⑤ | Main 侧 `getBundledNodeRuntimePath()` 的 win32 闸 | 立项档 D36 行只列了 `node-runtime-pin` / `fetch` / `afterPack` / `verify` 四处 | **必须同批撤闸**（第五处改动面） | `AgentHostManager.ts:687-691` `[读码]`：`if (process.platform !== 'win32') return undefined`。不撤 = Linux 包里躺着一个 node 但 resolver 永远不看它，D36 只涨体积不产生收益 |
| ⑥ | AgentInstaller 平台闸（R5）的落点 | 立项档：「`installAgent()` 无平台闸…顺手加闸」 | 闸只加在**改机器状态的四个入口**（`installAgent` / `installAll` / `ensureNode` / `downgradeClaudeToNodeVersion`），**探测类入口 `checkPrerequisites`/`detectGit`/`detectNode` 保持现状不抛** | `[读码]` `OnboardingService.ts:939-946` 的 `detectCli()` 在**所有平台**都调 `checkPrerequisites()`。在探测侧加闸 = Linux/mac onboarding 直接炸。R5 的真实缺陷面是 `runCmd`（`AgentInstaller.ts:191-193` = `cmd.exe /d /s /c`）在非 Windows 上 `ENOENT`，只出现在写侧 |
| ⑦ | 体积门禁形状（REQ-14） | 立项档：「verify 加包体阈值断言」（单边上限） | **双边**：上限（防静默膨胀）**+ 下限**（防静默丢失） | 丢失比膨胀更阴：codex 平台包没打进去时，开发机与 CI 都有全局 codex 可回落（`codexNodeEntry` 规则 2/3/4），**只有用户机会红**——正是 `codexNodeEntry.ts:16-22` 记载的同一失效族 |

### 0.3 承重事实（本批 2026-08-19 实测，写进规格是因为设计形状依赖它们）

**A. `@openai/codex@0.145.0` 的真实形状**（本机全局安装 `/home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex`，`[实测]`）

| 项 | 值 |
|---|---|
| 主包 `files` | 只有 `bin/codex.js`（7,236 B）+ `package.json`（511 B）+ `README.md`（2,814 B） |
| `optionalDependencies` | 六项，**别名形式** `"@openai/codex-linux-x64": "npm:@openai/codex@0.145.0-linux-x64"`（六平台：linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 / win32-x64 / win32-arm64） |
| 平台包 `package.json` 的 `name`/`version` | `"@openai/codex"` / **`"0.145.0-linux-x64"`** ← 目录名是 `@openai/codex-linux-x64`，**包名不是**。preflight 若按目录名校验 `version === pin` 会恒红 |
| 平台包 `files` | 只有 `vendor` |
| 平台包全部文件（**8 个，可穷举**） | `package.json` 511 · `README.md` 2,814 · `vendor/x86_64-unknown-linux-musl/bin/codex` **310,730,800** · `…/bin/codex-code-mode-host` **46,139,288** · `…/codex-path/rg` 5,408,904 · `…/codex-resources/zsh/bin/zsh` 898,480 · `…/codex-resources/bwrap` 529,776 · `…/codex-package.json` 205 |
| 平台包合计 | 363,707,964 B ≈ **346.9 MiB**（`du -sh` 报 347M，与仲裁档 §0-① 一致） |
| 文件权限 | vendor 下全部 **0775**（含两颗二进制） |
| `bin/codex` 首 8 字节 | `7f 45 4c 46 02 01 01 00`（ELF） |
| `vendor/<triple>/codex-package.json` 内容 | `{"layoutVersion":1,"version":"0.145.0","target":"x86_64-unknown-linux-musl","variant":"codex","entrypoint":"bin/codex","resourcesDir":"codex-resources","pathDir":"codex-path"}` ← **上游自带的清单**，是比我们猜路径更强的断言源 |
| `codex --version` | `codex-cli 0.145.0`（该 shim realpath 到 `bin/codex.js`，即 `node codex.js --version`） |

**B. `bin/codex.js` 怎么找二进制**（`[读码]`，决定了 prune 的安全边界）

`codex.js:79-108`：`require.resolve('<平台包名>/package.json')` → `dirname()` + `'vendor'`；失败才回落 `<__dirname>/../vendor`（主包没有 `vendor`，所以**回落必炸**）。
⇒ **平台包的 `package.json` 是承重文件，不能只留 `vendor/`**；平台包的目录名必须保持 `@openai/codex-<platform>-<arch>`（`codex.js:16-23` 的 `PLATFORM_PACKAGE_BY_TARGET` 硬编码这六个名字）。

**C. npm 的落盘布局**（`[实测]`）

- 项目安装（`src/agent-host/npm ci`）：平台包**提升到顶层** —— 现存 `src/agent-host/node_modules/@cometix/claude-code-linux-x64`、`@anthropic-ai/claude-agent-sdk-linux-x64`、`@img/sharp-linux-x64` 均在顶层；`package-lock.json` 里的 key 也是 `node_modules/@cometix/claude-code-linux-x64`（`optional:true` + `os`/`cpu` 字段）。
- 全局安装（`npm i -g`）：平台包**嵌套**在 `@openai/codex/node_modules/@openai/codex-linux-x64`。
⇒ prune/mustNotExist 必须**两处都扫**（§3.4-3）；「npm 一定 hoist」是信念，不是事实（取证方式见 §10 硬编码信念表）。

**D. 拷贝链保权限**（`[实测]`）`fs.copyFileSync` 与 `fs.cpSync` 均保留 0755 → 0755。但 `@cometix/claude-code/install.cjs:91-95` 自陈「**npm strips +x from non-bin files**；without it pty.spawn() fails with posix_spawnp failed on unix」——两个证据方向相反（本机全局装实测 0775 未被剥），故 exec 位**必须断言，不许相信**（§3.3-4）。

**E. 现状体积锚点**（本机 `[实测]`，用于 §6.3 的门禁推导）

| 项 | 值 |
|---|---|
| `out-agent-host/`（linux-x64，codex 未入包） | **51 MB** |
| `dist/linux-unpacked/`（0.3.4 构建） | 413 MB；其中 `resources/` 129 MB；`resources/agent-host/` 51 MB |
| `dist/AiClient-0.3.4.AppImage` | 114,381,606 B |
| `src/agent-host/node_modules/`（未 prune 全量） | 467 MB |

**F. 构建脚本的单测入口已存在**（`[读码]`，改变了 §9 的测试形状）
`vitest.config.ts` 的 `include` = `['src/**/__tests__/**/*.test.ts', **'scripts/__tests__/**/*.test.mjs'**]`；仓内已有先例：纯模块 `scripts/credential-env-keys.mjs` + 单测 `scripts/__tests__/credential-env-keys.test.mjs`（脚本与测试共用同一 `.mjs`）。
⇒ 立项档 §2.5「构建脚本零单测」应读作「**零单测但基建齐备**」：本批的纯判定必须走这条路，不许说「构建脚本没法测」。

---

## §1 定稿约束与施工纪律

### 1.1 红线（逐字重申，不可重开）

> **REQ-8**（仲裁档 §0.5-④' 用户裁定）：**spawn 恒为 `node <codex.js> app-server`，绝不回落原生二进制 / PATH `codex`。**
> 本批**不得**引入任何指向 `vendor/<triple>/bin/codex[.exe]` 的执行路径。随包带原生二进制与该红线不矛盾（仲裁档 §0-① 已澄清：`codex.js` 是 launcher，它自己 spawn 那颗 296MiB 二进制）。
> 落地口径：`codexNodeEntry.ts` 的 `isCodexJsEntry`（`:127-131`，basename 全等 + 大小写敏感）与既有断言「每一个候选都 `.endsWith('codex.js')`」（仲裁 §3-2a-5）**一字不动**；本批新增的所有路径推导（Main 侧 §4.2、verifier 侧 §6.2）**同样只允许产出 `codex.js` 结尾的路径**，并各自带一条断言。

> **REQ-9**（仲裁档 C-a）：**Node runtime resolver 优先级顺序不许被 2b 擅自改**（`explicit → env → bundled → extra → nvm/fnm/volta → PATH`，`NodeRuntimeResolver.ts:68-89` `[读码]`；「坏的 bundled 可被 env 覆盖」是逃生口）；**Codex 复用 Main 已解析出的结果**。
> 本批**唯一**与该 resolver 相关的改动是 §5.4：把 `getBundledNodeRuntimePath()` 的 win32 闸扩成 win32+linux —— 这是**给 `bundledPath` 这一档在 Linux 上填值**，**不动任何一档的先后顺序**。任何顺序改动都要另行裁定。
> 同理：`codexNodeEntry.ts` 的候选表顺序（env → path_shim → node_sibling → path_node_sibling，`:171-202`）本批**零改动**，一行不加。

**其余不可重开项**：REQ-1 随包（仲裁 §0-①）· REQ-2 体积代价已被接受（约 480MB）· D52-② **mac 不纳入本批**（只做 win-x64 + linux-x64）· 投影链退役批不挂本批（立项档 R4）。

### 1.2 运维铁律（沿用 D48 §1.2，逐字有效）

- **绝不更改开发机本地 `~/.claude/` 与 `~/.codex/`；绝不用 cch 密钥覆盖本地配置。**
- 一切打 cch 的探针：事前向用户报测试项与预计用量，批准后以最小 payload 执行。**本规格设计的全部 smoke 均为零额度**（§6.2），如需升级为真回合 smoke 见开放问题 §11-Q3。
- 本地不得主动拉起完整 app 走注册/登录流程做测试。
- 新增一条（本批特有）：**不得为了验证打包而在开发机执行 `npm install -g @openai/codex`** —— 本机已有 0.145.0 全局安装，重装可能升到 0.147.0 并静默改变 `codex --version`、进而污染所有以本机为参照的实测记录。

### 1.3 收口条件与证据（每片一致）

- 四门**逐门串行**（链式合跑曾 OOM exit 137）：`pnpm typecheck` → `pnpm typecheck:agent-host` → `pnpm lint` → `pnpm test`。门禁权威见 `docs/plantree/baseline/test-and-release-gates.md:3-18` 与 `package.json:30-34`。
- 基线 = D48 收官后的实跑数（as-built 记实跑文件数/例数，不抄旧数）。
- 每片按规范 12/4/15 条：**先落会红的纯函数/结构断言，再补实现**；变异**逐对实跑并抄红灯原文**，**零跳过**。
- 每片 as-built 必须记：git commit · 四门逐门实跑输出 · 变异逐对红灯原文 · **CI 真跑 run id 与关键实测数**（体积/耗时/缓存命中/磁盘余量）· 新增改动文件清单 · 规格偏差条目。
- **本批特有**：凡规格里写「施工时实测填入」的数（SHA256、win 变体清单、体积基数、耗时），as-built 必须逐条回填**实测值 + 取值命令**；留空即视为未收口。

---

## §2 切片划分与依赖序

| 片 | 名称 | 范围 | 依赖 | 出包风险 | 独立可回归 |
|---|---|---|---|---|---|
| **P1** | 依赖 pin + 构建产物 | `src/agent-host/package.json` 加 `@openai/codex` 精确 pin（REQ-3）+ `build-agent-host.mjs` 四处（preflight / copy-prune / mustExist / mustNotExist，REQ-4）+ 新纯模块 `scripts/codex-platform.mjs` | — | 无（只产 `out-agent-host/`） | ✅ 四门 + `pnpm build:agent-host` 本地实跑 + 纯模块单测 |
| **P2** | Main 接线 | `hostEnv.ts` 加 `codexJsPath` 条件注入（REQ-15）+ `AgentHostManager` 推导 + `AgentInstaller` 平台闸（R5）+ 降级语义落文档 | P1（要有随包 codex 才能验注入命中） | 无（Main 侧行为，flag 无关） | ✅ 四门 + Main 单测（注入/缺席/用户覆盖三臂） |
| **P3** | 出包与 CI | `electron-builder.yml` 死规则与注释（REQ-5）+ **D36**（多平台 pin / fetch 参数化 / afterPack 双平台 / Main 撤闸）+ **D41**（前置门禁作业）+ CI 缓存与磁盘核算（REQ-7） | P1 | **高**（改的就是出包） | ✅ 四门 + CI 真跑（win + linux 双作业绿）+ 门禁作业自身红/绿双轮 |
| **P4** | 打包后验证 | `verify-packaged-app.mjs`：Codex 结构断言 + 零额度握手 smoke + 双边体积门禁（REQ-14）+ TSD 头扩扫（R1） | P1 ∧ P2 ∧ P3 | 无（只加断言） | ✅ 四门 + CI 真跑 + **负控**（人为构造违规产物必须红） |

**为什么这么切**

- **P1 与 P3 不能合**：P1 全部可在本机 `pnpm build:agent-host` 内闭环、失败面只有一个脚本；P3 一动就要真出包（win runner + 480MB + 多平台 Node pin + 门禁作业依赖图），红了分不清是「copy-prune 写错」还是「CI 缓存/磁盘」。
- **P2 与 P3 可并行**：两者改动面零交集（Main/TS vs 脚本/YAML），且都只依赖 P1 的产物形状。若排期紧，P2 可与 P3 同轮施工，但**收口各自独立**。
- **P4 必须最后**：它断言的是 P1+P2+P3 的合成结果；提前落地只会拿到一个「断言了不存在的东西」的空壳。
- **D36 与 D41 为什么并进 P3**（D52-① 拍板）：三者动的是同一条 `build.yml` + `afterPack.mjs` 链，分批 = 三次动同一文件、三次跑 CI 真出包。并入后 `verify` 的「Node 24 resolvable」在 Linux 上一次性转绿（§0.2-④）。

**最小安全交付线 = P1 + P2 + P4**：即便 P3 的 D36/D41 半边延期，「Codex 随包 + Main 接线 + 打包后验证」仍是可发布的自洽态（Linux 走 machine Node，与今天一致）。**但 P3 的 `electron-builder.yml` 半边不可延期**——那条死排除规则与 REQ-1 直接矛盾，留着就是给下一个人挖坑。

---

## §3 P1 — 依赖 pin 与 `build-agent-host.mjs` 改造

### 3.1 版本选取规则（REQ-3）

**规则（写进 `src/agent-host/package.json` 旁的注释与本节，不是一次性拍板）**：

> `@openai/codex` 的 pin = **仓内 Codex 线协议证据链所依据的版本**，即「夹具捕获版本」与「blessing 记录版本」的交集。今天两者都是 `0.145.0` ⇒ **pin `"@openai/codex": "0.145.0"`**（精确，无 `^`/`~`，与既有两包同形；`build-agent-host.mjs:56` 的 `/^[\^~]/` 会拒绝范围写法）。

**依据（三处独立记录，均 `[实测]`）**：

1. `src/agent-host/__tests__/fixtures/codex/README.md`「来源与抓取信息」表 `codex-cli` 行 = **0.145.0**；该目录是切片 2/3 全部回放验收的唯一真源，且文件头逐字写着「任何时候都不要"补全"或"整理"这些文件」。
2. `src/main/services/auth/__tests__/fixtures/README.md:41`「本次 blessing 记录」= `0.145.0`，同文件「何时必须重跑 blessing」逐字列出「**`codex` CLI 版本升级**（新版本可能收紧或放宽哪些字段合法）」。
3. 仲裁档 §0-① 体积表锚定 `@openai/codex@0.145.0`；S1 spike 报告 `:23`/`:310`/`:369` 三处交叉记同版。

**升级规则（本批不做，登记为独立票）**：codex 升级**不是**依赖 bump，而是一个**契约批**，最小动作三件——① 重跑 `codex --strict-config` blessing 并替换 fixture 字节；② 用仲裁 U-a 的零额度法 `codex app-server generate-json-schema --experimental` 出契约快照并 diff `CODEX_METHOD` 全表；③ 复核夹具形状假设（如 §4.5 改判① 的 `idle` 无 `activeFlags` 键）。
**已知在野更新版本**：`docs/plans/2026-08-18-deepseek-harness-study.md:5` 记 `codex-cli 0.147.0`（外部研究档的证据 pin，不是我们的运行时）。本批**不采用**，登记进遗留（§11-Q7）。

**副产品（顺带解决 b-track B5）**：`docs/plans/2026-08-15-d47-s34-reviews/b-track-codex.md:187-213` 曾指出「所谓『复用仓内 Codex 0.145.0』不实……本机安装不是仓库依赖，不能作为 CI/新开发机前提」，并建议「将 `@openai/codex@0.145.0` 固定为测试依赖」。P1 落地后该建议**自动成立**（依赖进了 `src/agent-host/package.json`），P2 的 §4.2 推导会让**开发机也用仓内那份**。B5 的遗留在本批收口时可一并销账。

### 3.2 平台包矩阵与命名（承重表，供 preflight / prune / verify 共用）

**新增纯模块 `scripts/codex-platform.mjs`**（无 IO、无 `process` 读取，全部靠入参；被 `build-agent-host.mjs`、`verify-packaged-app.mjs` 与单测三方共用 —— 三处 import 同一符号，禁止写第二份表）：

```js
// 六平台 optionalDependencies 的目录名 → 上游 target triple。
// 唯一真源 = @openai/codex@0.145.0 bin/codex.js:16-23 的 PLATFORM_PACKAGE_BY_TARGET（本批逐字实读）。
export const CODEX_PLATFORM_DIRS = {
  'linux-x64':    'x86_64-unknown-linux-musl',
  'linux-arm64':  'aarch64-unknown-linux-musl',
  'darwin-x64':   'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64':    'x86_64-pc-windows-msvc',
  'win32-arm64':  'aarch64-pc-windows-msvc',
};
export function codexPlatformKey(platform, arch)      // 'win32','x64' -> 'win32-x64'
export function codexPlatformPkgDirName(platform, arch) // -> '@openai/codex-win32-x64'
export function codexTargetTriple(platform, arch)     // -> 'x86_64-pc-windows-msvc'
export function codexBinaryName(platform)             // -> 'codex.exe' | 'codex'
export function codexPlatformPkgCandidates(platform, arch) // 见 §3.4-3，两条相对路径
export function isForeignCodexPlatformPath(rel, platform, arch) // 见 §3.4-2
```

- **本批交付面只有 `win32-x64` 与 `linux-x64`**（D52-②）。表里另外四项**照抄上游**是为了让 `isForeignCodexPlatformPath` 有完整的「必须不在」集合，不是承诺支持。
- `codexPlatformKey` 的输出形状与 `${process.platform}-${process.arch}` 一致 —— 与 `build-agent-host.mjs` 既有的 `@img/sharp-${process.platform}-${process.arch}`（`:137`）、`node-pty/prebuilds/${process.platform}-${process.arch}`（`:145`）**同构**，这是仓内既定口径，不另起一套。

### 3.3 preflight 新增条目（`build-agent-host.mjs:44-92`）

在既有 `pins` 表（`:50-53`）加 `'@openai/codex'`，复用既有三步（声明存在 / 非范围 / `installed !== pin` 报错）。**在此之后**新增五条 codex 专属校验（形状照抄既有 cometix 空壳守卫 `:64-75`）：

| # | 校验 | 失败信息要点 | 为什么 |
|---|---|---|---|
| 1 | 平台包目录存在（两候选任一，§3.4-3） | `@openai/codex-<key> is not installed — reinstall src/agent-host WITH optional dependencies` | `npm ci --omit=optional` 会装出一个**只有 launcher 没有二进制**的空壳；这是 cometix `cli.js` 守卫（`:67-69`）的同款失效模式 |
| 2 | 平台包 `package.json` 的 `version === \`${pin}-${key}\`` | `expected 0.145.0-win32-x64, got …` | §0.3-A：平台包的 `name` 是 `@openai/codex`、`version` 是**别名串**。按目录名比 `version === pin` 会恒红；不校验则装错版本静默通过 |
| 3 | `vendor/<triple>/codex-package.json` 存在且 `{version,target}` 与 pin/triple 全等，`entrypoint` 指向的文件存在 | `vendor manifest mismatch: …` | 上游自带清单（§0.3-A），比我们猜路径强；同时把「目录名对了但里面是另一个平台的二进制」这种错配挡在构建期 |
| 4 | 入口二进制 size ≥ **200 MiB**，且**非 win32** 下 `mode & 0o111 !== 0` | `codex binary suspiciously small / not executable` | size 下限的推导：本机实测 296 MiB，取 `floor(296 × 2/3)` 归整到 200 MiB —— 它**不是版本闸**（版本由第 2/3 条管），只用于挡 LFS 指针 / 截断 / 占位文件。exec 位见 §0.3-D 的两个相反证据 |
| 5 | 其余五平台目录**不在**（两处布局各扫一遍） | `unexpected foreign platform package: …` | R2：构建机装多了变体，`out-agent-host` 直接翻倍且**没有任何人会发现** |

> **实现方可否决**：第 3 条依赖上游 `codex-package.json` 的存在（本机 linux-x64 `[实测]`，**win32-x64 未实证**）。若首个 Windows CI 跑发现该文件不存在，退到「只用第 2+4 条」，并把该发现写进 as-built 与 §11-Q1。**不许改成 `if exists then check`**——那会让最需要它的平台正好跳过（同 b-track「禁止找得到就跑、找不到就 skip」）。

### 3.4 copy-prune（`shouldCopy` / `pruneResidualPlatformPackages`）

**1）保留规则（镜像 `@img` 与 cometix vendor 两条先例）**

在 `shouldCopy`（`:128-174`）里、`@img` 分支（`:136-138`）之后加：

```
if (parts[0] === '@openai' && parts.length >= 2) {
  // 只放行主包与当前平台包；其余（含嵌套布局）交给 isForeignCodexPlatformPath 兜底
  if (top !== '@openai/codex' && top !== codexPlatformPkgDirName(process.platform, process.arch)) return false;
}
if (isForeignCodexPlatformPath(rel, process.platform, process.arch)) return false;   // 嵌套布局逃逸口
if (rel.includes(`${codexPlatformPkgDirName(...)}/vendor/`)) return true;            // vendor 逐字保留
```

- **为什么需要 `isForeignCodexPlatformPath`**：`topPackage(parts)`（`:120-122`）**只看前两段**。嵌套布局下 `@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/…` 的 `top` = `@openai/codex` ⇒ 上面那条 `@openai` 规则放行，整颗外平台包被复制进去。该函数按**每一段**匹配 `codex-<something>` 形状，非当前平台即 `false`。
- **为什么 vendor 要逐字保留**：镜像 `:159-160` 的 cometix 先例。今天实测 codex vendor 内无 `.md`/`.ts`/`licence`（§0.3-A 八文件全表），但通用尾缀过滤（`:162-173`）对上游新增文件是**默认丢弃**语义；vendor 内容属上游运行时资产，构造性安全的做法是整段放行。

**2）残留兜底（`pruneResidualPlatformPackages`，`:274-290`）**

加规则并**改成两处扫描**：

```
const rules = [
  ['@anthropic-ai', /^claude-agent-sdk-.+/],
  ['@cometix',      /^claude-code-.+/],
  ['@img',          new RegExp(`^sharp-(?!${plat}-${arch}$).+`)],
  ['@openai',       new RegExp(`^codex-(?!${plat}-${arch}$).+`)],   // 新增
];
// 扫描根：out-agent-host/node_modules/<scope>  以及  out-agent-host/node_modules/@openai/codex/node_modules/<scope>
```

该函数的头注（`:267-273`）已记载「Windows CI 上 cpSync filter 曾整体失效」的教训——**codex 的残留代价是 347MB × 5**，所以兜底不是可选项。

**3）平台包定位（两候选，共用符号 `codexPlatformPkgCandidates`）**

```
`@openai/${dirName}`                                  // hoisted（项目安装，实测 cometix/sharp 均如此）
`@openai/codex/node_modules/@openai/${dirName}`        // nested（全局安装布局，实测）
```
preflight / mustExist / mustNotExist / verifier **四处共用同一函数**，并遵守：命中即以命中那条为准（`resolvedPlatformPkgRel`），后续断言全部相对它拼接 —— 不许各处再各拼一次（第二真源）。

### 3.5 R3 裁定：`codex-code-mode-host` **保留**

**查证过程（本批实测，立项档「用途待查证」的答案）**：

1. 仓内 `code_mode` 全部命中（`grep -rn -i 'code-mode|code_mode|codeMode'`）：`s2-codex-question-probe.ts:722` 的对照臂 `'features.code_mode_host=false'`，与 `:631-634` 的实测注释——
   > `// MEASURED: gpt-5.6-sol has \`tool_mode: "code_mode_only"\` + \`use_responses_lite: true\`, so the Responses request carries NO top-level \`tools\` array at all.`
2. 我方 managed config **刻意不写 `model` 根键**（`codexManagedConfig.ts:18-27` 逐字：「Omitting it means "no session model" falls through to whatever the `codex` binary's OWN built-in default is (0.145.0 [实测]: `gpt-5.6-sol`)」）。
3. ⇒ 「code-mode 我们不消费」这个前提**不成立**：我们的默认落点正是 `tool_mode:"code_mode_only"` 的那个模型。

**裁定**：**保留，不 prune**，并加一条 mustExist（防上游/我们自己误删）。省 44 MiB 的代价是**默认模型的工具执行路径可能整条断掉**，而且断在用户机、不断在开发机（开发机有全局 codex 兜底）——与 `codexNodeEntry.ts:16-22` 记载的失效族完全同形。
**反证条件（将来要省这 44 MiB 必须先满足）**：① 有实证说明我们下发的每个 model 都不是 `code_mode_only`（D48-S2 的目录白名单落地后才可能有这个前提）；② prune 后跑一次**真回合** smoke（要额度，须先报量）。两条都满足前，任何人 prune 它都算回归。

### 3.6 mustExist / mustNotExist（`verifyArtifact`，`:220-250`）

`R = resolvedPlatformPkgRel`（§3.4-3）、`T = codexTargetTriple(...)`、`B = codexBinaryName(...)`。

**mustExist 追加**（相对 `out-agent-host/`）：

| # | 路径 | 附加断言 |
|---|---|---|
| 1 | `node_modules/@openai/codex/bin/codex.js` | basename 恒为 `codex.js`（REQ-8 的可执行版本） |
| 2 | `node_modules/@openai/codex/package.json` | `version === pin` |
| 3 | `node_modules/${R}/package.json` | `version === \`${pin}-${key}\`` |
| 4 | `node_modules/${R}/vendor/${T}/codex-package.json` | `{version,target}` 全等（见 §3.3-3） |
| 5 | `node_modules/${R}/vendor/${T}/bin/${B}` | size ≥ 200 MiB；非 win32 断 exec 位 |
| 6 | `node_modules/${R}/vendor/${T}/bin/codex-code-mode-host[.exe]` | 存在即可（§3.5） |
| 7 | `node_modules/${R}/vendor/${T}/${manifest.pathDir}` | 目录存在（linux 实测含 `rg`）；**路径取自 manifest 而非硬编码 `codex-path`** |
| 8 | `node_modules/${R}/vendor/${T}/${manifest.resourcesDir}` | 目录存在；**同样取自 manifest**（linux 是 `codex-resources/{zsh,bwrap}`，win 变体形状未实证 —— 用 manifest 就不必猜） |

**mustNotExist 追加**：

| # | 路径 | 挡住的事 |
|---|---|---|
| 9 | 其余五平台目录，**两处布局各一条**（共 10 条） | R2 静默膨胀（347MB × 5） |
| 10 | `node_modules/.bin/codex` | npm 的 bin 软链；既有 `.bin` 已在 `shouldCopy:133` 排除，这条是**发射半边 pin** |
| 11 | `node_modules/@openai/codex/vendor` | 该目录若存在，说明有人把 `codex.js:85` 的回落路径当成了正路（主包 `files` 里没有 vendor，出现即异常） |

**日志**：既有 `[build-agent-host] OK — <mb>MB` 行（`:245-249`）追加 codex pin 与平台包实测字节，形如
`(cometix 2.1.212, sdk 0.3.218, codex 0.145.0/win32-x64 <bytes>B)` —— 让每次 CI 都留下体积原始值，§6.3 的门禁阈值才有回归口径。

---

## §4 P2 — Main 接线与降级 fallback

### 4.1 红线复述（本片最容易被顺手违反）

- 本片**不改** `codexNodeEntry.ts` 一行（候选表、顺序、`isCodexJsEntry` 全部冻结）。
- 本片**不改** `NodeRuntimeResolver` 一行。
- 本片**不新增** env 键，只给既有键 `AICLIENT_CODEX_JS_PATH`（`codexNodeEntry.ts:100`）填值。

### 4.2 随包 `codex.js` 路径推导（REQ-15）

**新增纯函数**（落 `src/main/services/agent-host/hostEnv.ts` 旁或同文件，须可被 node-env 单测直跑）：

```ts
/** `<dir(hostEntry)>/node_modules/@openai/codex/bin/codex.js`，不做 IO。 */
export function deriveBundledCodexJsPath(hostEntryPath: string): string;
```

- **为什么从 `hostEntryPath` 推**（而不是再写一次 `process.resourcesPath`）：`resolveHostEntryPath()`（`AgentHostManager.ts:693-700` `[读码]`）已经是「Host 产物在哪」的唯一真源——packaged 时 `<resourcesPath>/agent-host/index.js`，dev 时 `<appPath>/src/agent-host/index.ts`。两种形态下 `node_modules` 都是 `index.*` 的**兄弟目录**（packaged 由 `afterPack.copyAgentHost` 整树拷入 `afterPack.mjs:45-56`；dev 就是 `src/agent-host/node_modules`）。再写一次 `path.join(process.resourcesPath, 'agent-host', …)` 就是第二真源，且 dev 分支会永远指向不存在的路径。
- **副作用（正收益）**：dev 下 Host 也会用**仓内 pin 的那份 codex**，而不是开发机全局的 0.145.0 —— 直接消掉 b-track B5 指出的「本机安装不是仓库依赖」隐性前提（§3.1 副产品）。
- **REQ-8 咬合**：该函数的返回值 basename 恒为 `codex.js`，单测钉死（A-BundledPath-2）。

**注入判据（三条，缺一不可）**：

```ts
const bundled = deriveBundledCodexJsPath(hostEntryPath);
const userOverride = process.env[CODEX_JS_PATH_ENV]?.trim();     // 用户逃生口优先
const codexJsPath = userOverride ? undefined : (existsSync(bundled) ? bundled : undefined);
buildAgentHostEnv({ …, codexJsPath })                            // undefined ⇒ 整键省略
```

| 条件 | Main 行为 | Host 侧结果 |
|---|---|---|
| 用户 shell 已设 `AICLIENT_CODEX_JS_PATH`（非空） | **不注入**（省略键） | `AgentHostProcess.start()` 的 `{...process.env, ...options.env}` 让用户值原样穿过 ⇒ 用户逃生口成立 |
| 未设 + 随包文件存在 | 注入 bundled 路径 | `codexNodeEntry` 候选表规则 1 命中，`source:'env'` |
| 未设 + 随包文件缺失（mac 本地包 / 打包出错 / dev 未 `npm install`） | **不注入** | 规则 2/3/4 照旧 ⇒ 落到用户全局 npm 装（§4.3 fallback）；全不中则 `codex_entry_unresolved`，文案已含「Set AICLIENT_CODEX_JS_PATH…或 npm i -g @openai/codex」（`:251-257`） |

**`hostEnv.ts` 的接口改动**（加法）：`AgentHostEnvInput` 加 `codexJsPath?: string`；`buildAgentHostEnv` 返回体加 `...(input.codexJsPath ? { AICLIENT_CODEX_JS_PATH: input.codexJsPath } : {})`。
**必须在文件头注写清「为什么这一键与 D47 三键范式相反」**（§0.2-③ 的两句理由：凭据 vs 路径、逃生口 vs 防污染）。既有五键 `toEqual` 测试（`hostEnv.test.ts:33`）因 `toEqual` 忽略 `undefined` 属性而不受影响，但**新增的省略语义必须有自己的断言**（B3/B4），否则「改成恒在 + undefined」这个变异不会红。

### 4.3 AgentInstaller 降级为 fallback + 平台闸（R5）

**语义降级（文档 + 调用侧措辞，不删代码）**：`installAgent('codex')` 的 `npm install -g @openai/codex`（`AgentInstaller.ts:347-365`）从「Codex 可用的前置条件」降级为「**fallback 路径**」。保留它的理由有三：① mac 未纳入本批（D52-②），mac 用户仍靠它；② 用户自带/自管 codex 的场景；③ 随包文件损坏时的人工恢复手段。
**改动面**：`installAgent` 上方补注释说明降级与依据（本规格 §4.2 三条判据表 + REQ-1），并在 onboarding 文案侧登记（**实现方可否决**：若 onboarding 文案改动会牵出 D47 的 golden-diff 测试面，则本片只改注释、文案改动另票）。

**平台闸（R5）**：

- 加闸入口（**只加在会改机器状态的四个**）：`installAgent` · `installAll` · `ensureNode` · `downgradeClaudeToNodeVersion`。
- 闸形状：`if (process.platform !== 'win32') throw new Error('AgentInstaller is Windows-only (cmd.exe/PowerShell/msiexec toolchain)')`。
- **不加闸**的入口：`checkPrerequisites` / `detectGit` / `detectNode` / `checkWingetAvailable` —— 依据 §0.2-⑥（`OnboardingService.ts:939-946` 在所有平台调它）。
- 依据（缺陷是真的）：`runCmd` = `runCommand('cmd.exe', ['/d','/s','/c', command])`（`AgentInstaller.ts:191-193` `[读码]`），非 Windows 上必 `ENOENT`，用户看到的是「spawn cmd.exe ENOENT」而不是「这功能不支持你的平台」。

### 4.4 P2 Happy Path

1. **随包主路径**：打包 Windows → 装机 → Host 启动 → Main 注入 `AICLIENT_CODEX_JS_PATH=<install>/resources/agent-host/node_modules/@openai/codex/bin/codex.js` → `resolveCodexLaunch` 规则 1 命中、`source:'env'` → spawn `node <codex.js> app-server` → `initialize` 回包 → `capabilities.agents` 含 `codex`。
2. **用户逃生口**：用户 shell 设 `AICLIENT_CODEX_JS_PATH=/opt/mycodex/bin/codex.js` → Main 不覆盖 → Host 用用户值。
3. **降级 fallback**：mac 本地包（无随包 codex）→ Main 不注入 → Host 规则 2 命中全局装 → 与今天行为一致。
4. **全不中**：`codex_entry_unresolved`，`agentSupport.ts:234` 的既有文案照旧，UI 侧 codex 置灰（D48-S1 的降级矩阵，本批不改）。
5. **dev**：`pnpm dev` → hostEntry 是 `src/agent-host/index.ts` → 注入 `src/agent-host/node_modules/@openai/codex/bin/codex.js`（P1 落地后存在）→ 开发机全局 codex **不再参与**。

---

## §5 P3 — electron-builder / D36 / D41 / CI

### 5.1 `electron-builder.yml` 死规则与注释（REQ-5）

**现状**（`:47-49` `[读码]`）：

```yaml
  # Exclude AI SDK bundled CLI binaries (we use system-installed CLIs via custom spawn)
  # @openai/codex vendor: ~326MB of pre-built binaries for all platforms
  - "!node_modules/@openai/codex/vendor/**"
```

**判定**：这条规则针对的是**根** `node_modules`（`files:` 的 glob 根 = 应用根目录），而根 `package.json` 里从来没有 `@openai/codex`（本批 `[实测]` 复验：`grep -n openai package.json` 零命中）。P1 之后 codex 也只进 `src/agent-host/node_modules`，而 agent-host 产物**刻意不走 `files`/`extraResources`**（`:154-158` 的注释已写明，走 `afterPack.copyAgentHost`）⇒ 该规则**过去是、将来仍是死代码**，且注释「we use system-installed CLIs」与 REQ-1 直接矛盾。

**改法**：
1. 删除 `:48-49` 两行（codex 专属注释 + 规则）。
2. `:47` 的分组注释改写为只描述实际生效的对象（`@anthropic-ai/claude-agent-sdk` 的 vendor/cli.js/wasm，`:50-53` 三条不动），并**指向随包事实**：一句话说明 Codex 与 Claude 的 CLI 都由 `resources/agent-host` 随包提供（afterPack 链），根 asar 不携带任何 agent CLI。
3. **不新增**任何 `!node_modules/@openai/**` 防御性规则 —— 一条永不命中的规则会被下一个人误读为「codex 在根依赖里」。
4. `:154-158` 的 agent-host 说明块补一句：agent-host 产物**现在含 codex 平台包**，体积量级从 51MB 升到 ~400MB（实测值施工时填），提醒后来者不要把它挪回 `extraResources`。

**其余不动**：`asar: true` / `asarUnpack` / `compression: maximum`（`:159`）/ `win`/`linux` target（`:189-222`）本片零改动。

### 5.2 D36 ①：`node-runtime-pin.mjs` 改多平台表

**新形状**（保持 `NODE_RUNTIME_PIN` 名字可用，避免破坏两个既有 import：`fetch-node-runtime.mjs:22` 与 `verify-packaged-app.mjs:33`）：

```js
export const NODE_RUNTIME_VERSION = '24.18.0';           // 单一版本，双平台共用
export const NODE_RUNTIME_PINS = {
  'win-x64':   { archiveName: 'node-v24.18.0-win-x64.zip',        sha256: '<既有值>', binaryRel: 'node.exe',     outName: 'node.exe' },
  'linux-x64': { archiveName: 'node-v24.18.0-linux-x64.tar.gz',   sha256: '<施工时取真值>', binaryRel: 'bin/node', outName: 'node' },
};
export function nodeRuntimePinFor(platform, arch)        // 'win32','x64' -> pins['win-x64']；无 pin 返回 undefined
export const NODE_RUNTIME_PIN = { version: NODE_RUNTIME_VERSION, ...NODE_RUNTIME_PINS['win-x64'] }; // 过渡兼容，收口时删
```

**硬纪律 —— SHA256 绝不许编造**：

- `win-x64` 的 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821` 是既有值（`node-runtime-pin.mjs:7`），**原样搬运，不重算**。
- `linux-x64` 的值**规格里留 `<施工时取真值>` 占位**。施工步骤（必须逐字执行并把输出抄进 as-built）：
  1. `curl -fsSL https://nodejs.org/dist/v24.18.0/SHASUMS256.txt -o /tmp/SHASUMS256.txt`
  2. `grep 'node-v24.18.0-linux-x64.tar.gz$' /tmp/SHASUMS256.txt`
  3. 把该行的哈希填进 pin；随后 `node scripts/fetch-node-runtime.mjs --platform linux-x64` **实跑一次**，由脚本自身的校验（`fetch-node-runtime.mjs:86-94`）二次确认。
  4. as-built 记：SHASUMS256.txt 的抓取时间 + 该行原文 + 实跑输出。
- **任何评审稿里出现一个具体的 linux SHA256 字面量都视为编造**，除非同时附上第 2 步的命令输出。

**归档格式选 `.tar.gz` 而非 `.tar.xz`**：依据仓内先例 `build-remote-runtime-bundle.mjs:86,113`（`node-v${v}-linux-${arch}.tar.gz` + `tar -xzf`），避免对 runner 上 `xz` 的隐性依赖。
**镜像 URL** 沿用既有双源形状（`node-runtime-pin.mjs:8-11`）：`https://nodejs.org/dist/v<v>/<archive>` + `https://registry.npmmirror.com/-/binary/node/v<v>/<archive>`。**第二条是按既有 win 条目的形状推导的**（`[推测]`），施工时须 `curl -I` 验活并把结果记进 as-built；不通则只留官方源（`downloadZip` 的多源循环 `:66-96` 天然支持一条）。

### 5.3 D36 ②：`fetch-node-runtime.mjs` 平台参数化

| 改点 | 现状 file:line | 新口径 |
|---|---|---|
| 目标平台 | 无（win-x64 写死） | `--platform <key>` 可选参数；缺省 = `nodeRuntimePinFor(process.platform, process.arch)` |
| **无 pin 时的行为** | 不适用 | **打印跳过提示并 `exit 0`**，不 fail | 
| 幂等判据 | `alreadySatisfied()` 比 `pin.version`（`:49-57`） | 改比 `{version, platformKey}` 两项（否则 win 缓存能冒充 linux 缓存） |
| 校验 | `NODE_RUNTIME_PIN.zipSha256`（`:87`） | `pin.sha256`（逻辑不变） |
| 解包 | `tar -xf` + `zipName.replace(/\.zip$/,'')`（`:120-138`） | `.zip` 走既有 bsdtar 路径（`resolveTarCommand:111-118` 不动）；`.tar.gz` 走 `tar -xzf`；解包目录名 = `archiveName.replace(/\.(zip\|tar\.gz)$/,'')`，取件路径 = `pin.binaryRel` |
| 产物 | `out-node-runtime/node.exe` | `out-node-runtime/<pin.outName>`；`PIN.json` 加 `platformKey` 字段 |
| 版本自检 | `node.exe --version`（`:166-173`） | 同逻辑，对 `<outName>`（Linux 上直接执行需 exec 位，`copyFileSync` 保 mode `[实测]`，但仍**断言 exec 位**再执行，失败信息要指名道姓） |

**「无 pin 即跳过」为什么是必须的**：`package.json:39` 的 `dist:prereq = pnpm build && pnpm build:agent-host && pnpm fetch:node-runtime` 被 `build:mac`/`build:mac:unsigned`/`build:mac:debug` 三个脚本复用（`:40-42`）。今天它在 mac 上会下载**Windows 的 zip**（无害的浪费）；参数化后若改成「无 pin 就 fail」，`pnpm build:mac` 当场红。D52-② 说 mac 不纳入本批 —— **不纳入 ≠ 允许打断**。

### 5.4 D36 ③：`afterPack.mjs` 与 Main 撤 win32 闸

| # | 位置 | 改法 |
|---|---|---|
| 1 | `afterPack.mjs:65` `copyNodeRuntime` 的 `if (context.electronPlatformName !== 'win32') return` | 改为「按 `nodeRuntimePinFor(electronPlatformName, arch)` 查；无 pin 才 return」。**用 `context.electronPlatformName` 而不是 `process.platform`**（既有代码已是前者，交叉编译时才对） |
| 2 | `afterPack.mjs:67-71` 的 `node.exe` 存在性检查与报错文案 | 换成 `pin.outName`；报错文案带上平台 key 与该跑哪条命令 |
| 3 | `afterPack.mjs:75` 的 `copyFileSync` | 同上换名；**非 win32 追加 exec 位断言**（失败即 throw，别等到用户机上 EACCES） |
| 4 | `AgentHostManager.ts:687-691` `getBundledNodeRuntimePath()` | 撤 win32 闸：`app.isPackaged` 且当前平台有 pin 时返回 `path.join(process.resourcesPath,'node-runtime', outName)`。**函数头 `:676-686` 那段「Windows-only on purpose」的 JSDoc 必须同批改写**，否则注释与代码打架（该注释逐字写着 "the whole chain is win-x64"，D36 之后不再成立） |
| 5 | `verify-packaged-app.mjs:227` `checkNodeRuntime` 的 win32 闸 | 同样按 pin 存在与否分支；`expected = v${NODE_RUNTIME_VERSION}`（`:241` 逻辑不变） |

> Main 侧改动虽属 P2 的地盘（TS + 单测），但它与 D36 是同一条因果链，**归 P3 施工**，在 P3 的四门里收口。

### 5.5 D36 ④：`build.yml` 的 build-linux 补 fetch 步骤

在 `build-linux` 的 `Build agent-host artifact`（`:223-224`）与 `Build Linux`（`:226-229`）之间插两步，形状照抄 win 作业（`:129-136`）：

```yaml
      - name: Cache bundled Node runtime
        uses: actions/cache@v4
        with:
          path: out-node-runtime
          key: node-runtime-${{ runner.os }}-${{ hashFiles('scripts/node-runtime-pin.mjs') }}

      - name: Fetch bundled Node runtime
        run: node scripts/fetch-node-runtime.mjs --platform linux-x64
```

**缓存键为什么改成 `hashFiles`**：现状 win 作业的键是写死的 `node-runtime-24.18.0-win-x64`（`:133`）。`actions/cache` 对已存在的 key **不会覆盖**，所以 pin 一升级、键不变 ⇒ 每次都恢复到旧缓存、再被 `alreadySatisfied()` 判否重下载，缓存等于永久失效且没人会发现。用 pin 文件的 hash 做键，升级即自然换键。**win 作业的键同批一起改**（同一处病）。

**同批删除** `:231-237` 的 `Setup Node.js 24 (packaged-state verify)` 步骤与其上方注释（依据 §0.2-④）。

### 5.6 D41：前置门禁作业

**新增 job `gate`（ubuntu-latest，最前置）**：

```yaml
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: <见下推导>
    steps:
      - checkout / setup pnpm 10.26.2 / setup node 20 / pnpm store cache      # 与 build-app 同形（:20-38）
      - run: pnpm install --frozen-lockfile
      - run: npm ci --omit=optional
        working-directory: src/agent-host
      - run: pnpm typecheck
      - run: pnpm typecheck:agent-host
      - run: pnpm lint
      - run: pnpm test
```

**依赖图改法**（三条边，缺一即漏网）：

| job | 现状 needs | 新 needs | 理由 |
|---|---|---|---|
| `build-app` | 无（`:14`） | `[gate]` | 挡住 win/linux 两条出包线（它们都 `needs: build-app`） |
| `build-remote-runtime-linux` | 无（`:253`） | `[gate]` | 否则门禁红了，remote runtime 资产照样上传进 release（`generate-release-notes:324-331`） |
| `generate-release-notes` | `[build-windows, build-linux, build-remote-runtime-linux]`（`:300`） | 不动 | 已被上面两条传递阻断 |

**四门逐门串行、不合跑**：与 `docs/plantree/baseline/test-and-release-gates.md:3-18` 同口径（链式合跑曾 OOM exit 137）。

**为什么 agent-host 装依赖用 `--omit=optional`**：门禁只需要**类型**与**测试**，不需要 cometix 的 `cli.js`、不需要 codex 的 347MB 平台包。`@cometix/claude-code/install.cjs:59-67` `[读码]` 在平台包缺失时**只打 `console.error` 并 `return`**（不抛、不 `process.exit(1)`），所以 `npm ci --omit=optional` 不会失败。
> **实现方可否决（必须首跑实证）**：若 `pnpm test` 或 `pnpm typecheck:agent-host` 因缺少 optional 包而红，退到完整 `npm ci` 并接受时长（此时缓存策略见 §5.7）。**不许改成「测试遇到缺包就 skip」**。首跑结论写进 as-built。

**`timeout-minutes` 的推导（不发明常量）**：施工时先在门禁作业里让四门各自打印耗时（`time` 或 step 级 duration），取首跑总时长 `N` 分钟，设 `timeout-minutes = ceil(3N / 10) × 10`（≥ 3 倍余量并归整到十分钟）。as-built 记 `N` 与最终值。**同样的方法补给 `build-windows` / `build-linux`**——它们今天没有 `timeout-minutes`（`[读码]` 复验：全 workflow 只有 `generate-release-notes:303` 有一个 10 分钟），默认 360 分钟意味着一次卡死要烧 6 小时 runner 额度。

**门禁自身要有红/绿双轮证据**：收口时人为造一个红（如临时改坏一个断言）跑一次，证明 `build-app` 确实被阻断、且 release 资产没有产出。红灯原文抄进 as-built。

### 5.7 CI 缓存、磁盘与时长的核算方法（REQ-7）

**这一节给方法与判据，不给凭空的数字。**

| 项 | 现状 | 本批动作 | 核算方法（施工时执行，as-built 回填） |
|---|---|---|---|
| agent-host npm 缓存 | 无（`npm ci` 每次全量下载，`:119-124`/`:218-221`） | 加 `actions/cache`：<br>path = `~/.npm`（linux）/ `~\AppData\Local\npm-cache`（win）<br>key = `${{ runner.os }}-agenthost-npm-${{ hashFiles('src/agent-host/package-lock.json') }}` | 在 `npm ci` 后加一步打印 `du -sh <npm cache dir>`；比较有/无缓存两次 `npm ci` 的 step duration。判据：缓存命中后 `npm ci` 时长下降且缓存条目 < 2 GB |
| GitHub 缓存总量 | pnpm store × 3 作业 + electron × 2 + node-runtime × 1 | 再加 npm 缓存 × 2 + node-runtime × 2 | 仓库总缓存上限 10 GB（GitHub 侧策略，非本仓常量）。**判据不是「算出来够不够」而是「跑完看 Actions → Caches 页面的实际占用」**，超了就按 LRU 自然淘汰并在 as-built 记一句；若发现 electron/pnpm 缓存被频繁挤掉（表现为 install 时长回弹），再议缓存瘦身，本批不预先优化 |
| runner 磁盘 | 无核算 | 在 win/linux 出包作业的**首步与出包后**各加一步打印剩余空间（linux `df -h /`；win `Get-PSDrive C`） | 判据：出包后剩余 ≥ 5 GB（低于此值先记录再议扩容/清理 `dotnet`/`android` 预装目录）。**5 GB 是余量档不是实测值**，标注为工程判据，as-built 记真实剩余 |
| 出包时长 | 无核算（无 timeout） | 见 §5.6 的 `timeout-minutes` 推导 | 记 `Build Windows` / `Build Linux` step 的实测时长；`compression: maximum`（`electron-builder.yml:159`）对新增 ~347MB 的压缩耗时是本批最大的时长变量，**首跑后若单步 > 40 分钟，把「是否降到 `normal`」提交拍板**（§11-Q8） |
| NSIS 差分包 | `differentialPackage: true`（`:205`） | 不改 | 记 blockmap 生成耗时与 `.exe`/`.blockmap` 体积；异常再议 |

---

## §6 P4 — `verify-packaged-app.mjs`

### 6.1 结构断言（`checkStructure`，`:96-155`）

沿用既有 `check(label, ok, detail)` 汇总模型（`:53-63`）。**把 §3.6 的 mustExist/mustNotExist 全表原样搬到打包后**（共用 `scripts/codex-platform.mjs`，两处不得各写一份），并追加三条只有打包后才能验的：

| # | 断言 | 说明 |
|---|---|---|
| D1 | codex 入口二进制**魔数**：win32 首 2 字节 `MZ`；非 win32 首 4 字节 `\x7fELF` | 比「不是 `%TSD`」强得多：同时挡住截断、占位、被错误重写。ELF 为本机 `[实测]`（`7f 45 4c 46`），`MZ` 为 PE 格式常识，win 侧首跑实证 |
| D2 | **TSD 头扩扫**（R1）：`%TSD` 前缀检查从现有两条（`:146` 的 `index.js` + cometix `cli.js`）扩到 **codex.js + codex 入口二进制 + code-mode-host** | `afterPack.fixTsdEncryption`（`:83-117`）只重写 `.js/.cjs/.mjs`（`:86` 的 `exts`），原生二进制**不过重写路径**——这是「隐式正确」，从未在加密机上验过这个体量。扩扫把隐式变显式 |
| D3 | 非 win32：codex 入口二进制 exec 位 | 打包链末端复查（§0.3-D） |

### 6.2 Codex smoke 形态：**零额度两级**，真回合 smoke 不进 CI

**问题**：现有 smoke（`:253-309`）走 `spikes/phase2-sdk-runtime-smoke.ts` + 测试网关凭据，是 **Claude/Cometix 线**；Codex 的等价物需要 `app-server` 握手甚至真回合，涉及凭据与额度（铁律 §1.2）。

**裁定：分两级，都零额度、零凭据；真回合 smoke 不进 CI。**

| 级 | 形态 | 断言 | 成本 | 依据 |
|---|---|---|---|---|
| **S1（必做，进门禁）** | `spawn(node24, [<packaged codex.js>, '--version'])` | stdout 全等 `codex-cli <pin>` | 一次进程启动 | 本机 `[实测]`：`codex --version` → `codex-cli 0.145.0`，而该 shim realpath 即 `bin/codex.js`（`codexNodeEntry.ts:36-38` 记的同一事实）。这一条同时证明：随包 launcher 可读、`require.resolve` 找得到平台包、原生二进制可执行（`codex.js:110` 先 spawn 才有版本输出） |
| **S2（先观察后转门禁）** | `spawn(node24, [<codex.js>, 'app-server'])` + 临时 `CODEX_HOME` + **只发 `initialize`**，读回包后关 stdin | 回包含 `codexHome === <临时目录>`、`platformOs` 与当前平台一致；进程干净退出 | 无额度（仲裁 §3-2a-2 逐字：「只发 `initialize`，S1 实测 178–188ms，**不花额度**」）；e4 spike 记有真实回包形状（`2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:79`：**凭据缺失下 `initialize` 照样回 result**）| 证明**三级进程链**（node → codex.js → 原生 codex）在打包布局下真的能起来 —— 这是 S1 证不到的那一半 |
| **S3（不进 CI）** | 真回合 PONG（Codex 轴） | — | 要 cch 凭据 + 额度 | 归入手工/加密机点验半边（§9-T4）与 §11-Q3 |

**S2 的两步走纪律**：首个 CI 跑以 `continue-on-error: true` 观察（或用 `--codex-smoke=observe` 开关），拿到真实 stdout/stderr 后**第二跑转硬门禁**。理由：`app-server` 在无 `auth.json` 的 runner 上的行为只有 Linux 的间接证据，Windows 侧零证据。**不许写成「起得来就断言、起不来就跳过」**。

**CLI 参数**：新增 `--skip-codex-smoke`（与既有 `--skip-smoke`，`:43-44`，并列且互不影响），让 D36/D41 的排障可以单独关掉这一段。

### 6.3 总体积门禁（REQ-14）：**双边**，阈值给推导式

**落点**：新增纯模块 `scripts/packaging-budget.mjs`（可单测），由 `verify-packaged-app.mjs` 调用。

```js
// 全部以字节为单位；A0/P 由施工时实测填入，H 为余量系数。
export const PACKAGING_BUDGET = {
  'linux-x64': { baseAgentHost: <A0>, codexPlatformPkg: <P>, headroom: 0.15 },
  'win32-x64': { baseAgentHost: <A0>, codexPlatformPkg: <P>, headroom: 0.15 },
};
export function agentHostCeiling(k) { const b = PACKAGING_BUDGET[k]; return Math.ceil((b.baseAgentHost + b.codexPlatformPkg) * (1 + b.headroom)); }
export function agentHostFloor(k)   { const b = PACKAGING_BUDGET[k]; return Math.floor(b.baseAgentHost * 0.9 + b.codexPlatformPkg * 0.9); }
export const CODEX_BINARY_FLOOR = 200 * 1024 * 1024;   // 与 §3.3-4 同一常量，单一真源
```

| 门 | 判据 | 挡住的事 |
|---|---|---|
| 上限 | `size(resources/agent-host) ≤ agentHostCeiling(key)` | R2 多平台变体陪跑（一个变体 = +347MB，必然击穿 15% 余量）；上游意外膨胀 |
| 下限 | `size(resources/agent-host) ≥ agentHostFloor(key)` | **codex 整个没打进去**（开发机/CI 有全局 codex 兜底，只有用户机会红） |
| 单文件下限 | `size(vendor/<T>/bin/<B>) ≥ CODEX_BINARY_FLOOR` | 截断 / LFS 指针 / 占位文件 |

**A0 / P 的取值规则（不许拍脑袋）**：

- `A0` = **本批施工前**该平台 `out-agent-host/` 的实测字节。linux-x64 已实测 = 51 MB（`du -sh` 报值，施工时用 `dirSize()` 取精确字节）；win32-x64 **必须从首个 Windows CI 跑的 `[build-agent-host] OK — <mb>MB` 日志行取**（该行 `:245-249` 已存在，历史 run 里就有）。
- `P` = 该平台 codex 平台包实测总字节。linux-x64 已实测 = 363,707,964 B；win32-x64 从 §3.6 新增的日志行取（§3.6 要求把平台包字节打进 OK 行，正是为了这里）。
- `headroom = 0.15`：**工程判据不是实测值**。依据是「上游一次 patch 版升级的二进制波动应当远小于一个平台变体（+347MB ≈ +87%）」，15% 处在两者之间：能吸收上游正常增长，吸收不了一个多余变体。**实现方可否决**：若首个 CI 跑就贴近上限，改为 0.25 并记录理由。
- **门禁失败必须打 breakdown**：按目录聚合的 top-10（复用既有 `dirSize` `:65-73`）。只报「超了 12MB」而不说是谁涨的，等于没有门禁。

**次门禁（松，只挡整体失控）**：`size(appDir) ≤ 2 × (基线 appDir + P)`。基线 linux-unpacked = 413 MB `[实测]`。这条**不参与红灯统计**（只 `console.warn`），因为 Electron/monaco 等与本批无关的体积波动不该让打包链红。**实现方可否决**：若评审认为 warn 级别没有咬合力，升为硬门禁并给出各自的余量档。

---

## §7 断言清单

> 命名：A* = P1 · B* = P2 · C* = P3 · D* = P4。**每条都标「谁是生产者」**（§10 空壳自查的输入）。

### 7.1 P1

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| A1 | `codexPlatformPkgDirName/codexTargetTriple/codexBinaryName` 六平台真值表全等上游 `PLATFORM_PACKAGE_BY_TARGET` | 纯函数单测（`scripts/__tests__/codex-platform.test.mjs`） | `scripts/codex-platform.mjs` |
| A2 | `isForeignCodexPlatformPath` 真值表：**hoisted 外平台** `@openai/codex-darwin-arm64/vendor/x` → true；**nested 外平台** `@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/x` → true；当前平台两种布局 → false；`@openai/codex/bin/codex.js` → false；`@openai/codexfoo/x` → false | 纯函数真值表 | 同上 |
| A3 | preflight 五条各一例红臂（缺平台包 / 别名 version 不符 / manifest target 不符 / 二进制过小 / 外平台残留），断言 `process.exit(1)` 与错误文案关键词 | 用临时目录构造假 `node_modules` 后调 preflight（把 preflight 拆成可注入 root 的函数） | `build-agent-host.mjs` |
| A4 | `verifyArtifact` 的 mustExist 八条 + mustNotExist 十一条**逐条**有对应红臂 | 同上（构造缺失/多余产物） | `build-agent-host.mjs` |
| A5 | **exec 位断言**：非 win32 下把入口二进制 `chmod 644` 后 preflight 必红 | 构造 | `build-agent-host.mjs` |
| A6 | `external` 仍恰为两项（`['@anthropic-ai/claude-agent-sdk','@cometix/claude-code']`），**不含 codex** | 源码扫描（读 `build-agent-host.mjs` 文本，同 `hostEnv.test.ts` 的 `readFileSync().toContain()` 范式） | `build-agent-host.mjs:113` |
| A7 | 真产物验收：`pnpm build:agent-host` 后 `out-agent-host/node_modules/@openai/codex/bin/codex.js` 存在、平台包 manifest 匹配、外平台零命中 | 本机实跑（P1 收口证据，非 vitest） | 构建链 |

### 7.2 P2

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| B1 | `deriveBundledCodexJsPath('/opt/app/resources/agent-host/index.js')` === `/opt/app/resources/agent-host/node_modules/@openai/codex/bin/codex.js`；dev 形态同理 | 纯函数 | `hostEnv.ts` 旁 |
| B2 | 该函数返回值 basename 恒为 `codex.js`（REQ-8 可执行版） | 纯函数（含 win32 分隔符臂） | 同上 |
| B3 | `buildAgentHostEnv({…, codexJsPath:'X'})` 含 `AICLIENT_CODEX_JS_PATH:'X'`；`codexJsPath: undefined` 时**该键不是自有属性**（`Object.keys(...)` 不含它） | 单测（**必须用 `Object.keys` 而不是 `toEqual`**——`toEqual` 忽略 undefined 值，写成 `toEqual` 这条断言就是空壳） | `hostEnv.ts` |
| B4 | 三臂矩阵：用户 env 已设 → 不注入；未设 + 文件在 → 注入；未设 + 文件不在 → 不注入 | Manager 侧单测（注入 `existsSync`/`env`） | `AgentHostManager.ts` |
| B5 | **接缝断言**：`AgentHostManager` 确实把推导结果喂给了 `buildAgentHostEnv`（范式照 `hostEnv.test.ts:128` 既有的 "AgentHostManager feeds buildAgentHostEnv the resolved runtime path"） | 源码扫描 / spy | `AgentHostManager.ts:647-656` |
| B6 | 平台闸：非 win32 下 `installAgent`/`installAll`/`ensureNode`/`downgradeClaudeToNodeVersion` 各抛且信息含 `Windows-only` | 单测（`process.platform` 打桩，同 `AgentInstaller.test.ts` 既有范式） | `AgentInstaller.ts` |
| B7 | **负控**：非 win32 下 `checkPrerequisites()` **不抛**（回归钉住 §0.2-⑥） | 单测 | `AgentInstaller.ts` |
| B8 | `codexNodeEntry.ts` 本批零改动 | git diff 断言 / 源码哈希（收口检查项，非 vitest） | — |

### 7.3 P3

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| C1 | `nodeRuntimePinFor` 真值表：`win32/x64`→win-x64 pin；`linux/x64`→linux-x64 pin；`darwin/arm64`→`undefined` | 纯函数单测 | `node-runtime-pin.mjs` |
| C2 | 两个 pin 的 `sha256` 均为 64 位十六进制、`archiveName` 与 `version` 一致（形状自洽，**不校验哈希内容**） | 纯函数单测 | 同上 |
| C3 | `fetch-node-runtime --platform darwin-arm64` → 退出码 0 且 stdout 含 skip 提示（护住 `pnpm build:mac`） | 脚本实跑（无网络） | `fetch-node-runtime.mjs` |
| C4 | `electron-builder.yml` **不含** `@openai/codex` 任何字面量 | 源码扫描单测（读 YAML 文本） | `electron-builder.yml` |
| C5 | `build.yml`：`build-app` 与 `build-remote-runtime-linux` 的 `needs` 均含 `gate` | YAML 结构扫描单测（解析或正则 + 明确锚点） | `.github/workflows/build.yml` |
| C6 | `build.yml` 中不再出现 `Setup Node.js 24 (packaged-state verify)` 步骤 | 源码扫描 | 同上 |
| C7 | CI 真跑：win + linux 两条出包作业绿，`verify` 全项 ok（含新增 codex 断言与 Linux 侧 bundled node） | CI（P3 收口证据） | CI |
| C8 | 门禁红轮：人为造红后 `build-app` 被 skip、release 无资产 | CI（一次性证据，抄进 as-built） | CI |

### 7.4 P4

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| D1 | 魔数：win32 `MZ` / 非 win32 `\x7fELF` | packaged verify | `verify-packaged-app.mjs` |
| D2 | `%TSD` 扩扫覆盖 codex.js + 入口二进制 + code-mode-host | packaged verify | 同上 |
| D3 | 非 win32 exec 位 | packaged verify | 同上 |
| D4 | S1 smoke：`node <codex.js> --version` === `codex-cli <pin>` | packaged verify | 同上 |
| D5 | S2 smoke：`initialize` 回包 `codexHome` == 临时目录（**先观察后转门禁**） | packaged verify | 同上 |
| D6 | 体积三门（上限 / 下限 / 单文件下限）各有一例构造红臂 | 纯函数单测（`packaging-budget.test.mjs`）+ 构造目录实跑 | `scripts/packaging-budget.mjs` |
| D7 | 门禁红时输出含 top-10 breakdown | 构造实跑，断言 stdout | `verify-packaged-app.mjs` |
| D8 | **负控（空壳克星）**：往打包产物里**塞一个假的** `@openai/codex-darwin-arm64/` 目录后，verify 必红且指名该目录 | 构造实跑 | 同上 |

---

## §8 Happy Path（每片一条，供规范第 3 条引用）

- **P1**：`src/agent-host` 内 `npm install`（含 optional）→ `pnpm build:agent-host` → preflight 五条全过 → copy 后 `out-agent-host/node_modules/@openai/` 下**只有** `codex` 与当前平台包 → verifyArtifact 全绿 → OK 行打印 `codex 0.145.0/<key> <bytes>B`。
- **P2**：packaged Windows 装机 → Host 启动 → 日志显示 `codex entry source=env` 且路径落在 `resources/agent-host/…/bin/codex.js` → `capabilities.agents` 含 codex → 新建 Codex 会话可发首条消息。
- **P3**：打 tag → `gate` 绿 → `build-app` → win/linux 双出包 → 两侧 `verify --skip-smoke` 全绿（Linux 的「Node 24 resolvable」由 **bundled** 满足）→ release 资产齐备。
- **P4**：CI 上 verify 打印 `resources/agent-host size: <X>MB`（在上下限之间）+ `codex-cli <pin>` + `initialize ok`；人为塞外平台目录后**立即红**。

---

## §9 测试与验证结构（规范 3/4/9/13 条）

**分层（本批的核心方法论：能纯化的纯化，纯不了的真跑，真跑不了的挂人工）**

| 层 | 覆盖对象 | 载体 | 为什么只能在这层 |
|---|---|---|---|
| **T1 纯单测** | 平台矩阵 / 路径推导 / 阈值公式 / pin 查表 / env 组装 | vitest：`scripts/__tests__/*.test.mjs`（入口已存在，§0.3-F）+ `src/main/**/__tests__/*.test.ts` | 无 IO、可穷举，是变异咬合力的主战场 |
| **T2 构造式脚本测试** | preflight / verifyArtifact / prune / 体积门禁的**红臂** | vitest 里建临时目录造假产物后调被测函数 | 需要文件系统，但不需要真依赖；**前提是把 `build-agent-host.mjs` 的 preflight/verify 拆成可注入根目录的导出函数**（本批的唯一重构动作，见下） |
| **T3 CI 真跑断言** | 真 `npm ci` 布局、真出包、真 verify、缓存/磁盘/时长 | GitHub Actions | 只有真装真打才有真布局（hoist 与否、exec 位、win 变体形状） |
| **T4 加密机实测（用户线）** | R1：TSD 环境下 296MiB 二进制是否被改写、能否 spawn | 人工：取 `windows-unpacked` 工件（`build.yml:160-167` 已有该上传步骤）→ 加密机跑 `verify-packaged-app.mjs --app-dir <dir>` | 我们没有 TSD 机器，且这是 R1 唯一的闭合手段 |
| **T5 零额度探针** | Codex 握手 S2 | CI 内 verify 的一段（先观察后转门禁） | 需要真二进制 + 真进程链 |

**必须的重构动作（一次，P1 做）**：把 `build-agent-host.mjs` 的 `preflight` / `verifyArtifact` / `shouldCopy` 三者改成**接受根目录与平台入参**的导出函数（脚本主流程仍在同文件末尾 `await main()`）。理由与 D48 §3.3 提取 `computeEverHostBound` 同构：不提取就只能靠 CI 真跑兜底，而 CI 真跑**一次 20 分钟且只覆盖当前平台的一条臂**。
> 兼容性：`vitest.config.ts` 的 include 已含 `scripts/__tests__/**/*.test.mjs`，**测试文件必须放这里**（放 `src/` 下会被 tsconfig/lint 规则牵连；仓内记忆有「往被测文件加 import 导致 vitest 挂死」的前车之鉴，故被测模块保持纯 `.mjs`、零 Electron/settings import）。

**变异臂计划（逐对实跑、抄红灯原文、零跳过）**

| # | 变异（改哪一行） | 应红断言 | 不红说明什么 |
|---|---|---|---|
| M1 | `isForeignCodexPlatformPath` 只查前两段（退回 `topPackage` 语义） | A2 的 nested 臂 | 嵌套布局逃逸没被咬住 |
| M2 | `pruneResidualPlatformPackages` 只扫顶层 | A4 的 mustNotExist nested 条 | 同上，且这是 R2 的最后一道 |
| M3 | preflight 把平台包 version 比成 `pin`（不带 `-<key>` 后缀） | A3 别名臂 | 别名版本串这个坑没被钉住 |
| M4 | 删掉 exec 位检查 | A5 | §0.3-D 的两个相反证据白查了 |
| M5 | 把 `codex-code-mode-host` 加进 prune 规则 | A4 的 mustExist 第 6 条 | R3 裁定没有咬合力，44MiB 会被下一个人「顺手优化」掉 |
| M6 | `buildAgentHostEnv` 改成「键恒在、值 undefined」 | B3（`Object.keys` 臂） | 逃生口被 Main 覆盖，且该失效**只在用户设了 env 时**出现 |
| M7 | Manager 侧去掉「用户 env 已设则不注入」判据 | B4 第一臂 | 同上 |
| M8 | 平台闸加到 `checkPrerequisites` 上 | B7 负控 | Linux/mac onboarding 会炸而没人拦 |
| M9 | `nodeRuntimePinFor` 对 darwin 返回 win-x64 pin | C1 + C3 | `pnpm build:mac` 会下载 Windows zip 并把 node.exe 塞进 mac 包 |
| M10 | 体积门禁去掉下限 | D6 下限臂 | 「codex 没打进去」变成静默通过 |
| M11 | 体积门禁把 `resources/agent-host` 换成 `appDir` | D6 上限臂（用一个只有 agent-host 超标的构造产物） | 门禁被无关体积稀释，失去分辨率 |
| M12 | S1 smoke 断言改成 `stdout.includes('codex')` | D4 | 版本漂移（如误装 0.147.0）不再被发现 |

**版本戳（规范 15 条）**：每片 as-built 记 `git commit` · codex pin · node pin · `NODE_RUNTIME_PINS` 哈希 · CI run id · 四门实跑数 · 本批新增的实测体积/耗时。

---

## §10 规格镜头三类空壳自查

### 10.1 同名空壳（断言存在但恒真/恒假）

| 风险点 | 空壳形态 | 破法 |
|---|---|---|
| mustNotExist 的路径写错（如 nested 前缀拼错） | 断言恒真，永远绿 | **D8 负控**：构造一个真的外平台目录，verify 必须红且**指名该目录**；A4 同款红臂 |
| 体积门禁上限设得过松 | 恒真 | 阈值由 `A0 + P` 推导而非拍值；且 D6 用构造产物验证「+1 个变体必红」 |
| `%TSD` 扩扫写在了不存在的路径上 | 恒真 | 断言前先断言**文件存在**（既有代码 `:148` 已是 `if (fs.existsSync(file))` 的写法 —— 这正是空壳来源：文件不在时该 check 整个不产生）。本批改为：路径来自 §3.6 的 mustExist 表，**mustExist 已保证存在**，扩扫不再自带 exists 分支 |
| S2 smoke 写成「起不来就跳过」 | 恒真 | §6.2 明令两步走：先 `continue-on-error` 观察，再转硬门禁；**不留 skip 分支** |

### 10.2 生产者缺席（断言了消费侧，没人生产）

| 断言 | 生产者在哪（必须能指出来） |
|---|---|
| `AICLIENT_CODEX_JS_PATH` 被 Host 消费 | 消费者 = `codexNodeEntry.ts:297` 的 `env[CODEX_JS_PATH_ENV]`（既有，本批零改动）；**生产者 = 本批新增的 `AgentHostManager` 注入** ⇒ 只测 `buildAgentHostEnv` 纯函数是**生产者缺席**，必须有 B5 接缝断言 |
| 「随包 codex 被真的用上了」 | 生产者 = P1 的 copy-prune；消费者 = Host 的 `resolveCodexLaunch`。**两端之间没有自动化连接**（CI 不起 Electron）⇒ 用 D4/D5 的 packaged smoke 顶上，并在 as-built 记一次真机 GUI 点验（Host 日志里 `source=env`） |
| Linux bundled node 被 resolver 采信 | 生产者 = §5.4-4 的 `getBundledNodeRuntimePath` 撤闸；消费者 = `NodeRuntimeResolver:72` 的 `pushUnique(options.bundledPath,'bundled')` ⇒ 若只改 afterPack 不改 Main，verify 会绿（它自己直接查文件）而**产品行为不变** ⇒ 必须有 Main 侧单测断言「packaged + linux + 有 pin ⇒ 返回路径」 |
| 门禁作业真的阻断 | 生产者 = `needs` 边；**YAML 里写了不等于生效** ⇒ C8 红轮实证 |

### 10.3 硬编码信念（当成事实但没证据）

| 信念 | 现状证据 | 取证方式（施工时执行，as-built 回填） |
|---|---|---|
| 「npm 会把平台包 hoist 到顶层」 | 项目安装 `[实测]` 成立（cometix/sdk/sharp 三例）；全局安装 `[实测]` 相反 | CI 两条作业各加一步：`ls src/agent-host/node_modules/@openai` 与 `ls src/agent-host/node_modules/@openai/codex/node_modules/@openai 2>/dev/null`，输出抄进 as-built。代码侧已用双候选（§3.4-3）不依赖该信念 |
| 「npm ci 保留 vendor 二进制的 exec 位」 | 两个相反证据（§0.3-D） | A5 + D3 断言；CI 里打印 `stat -c '%a'`（linux）实测值 |
| 「`codex app-server` 无凭据也能回 `initialize`」 | Linux `[实测]`（e4 spike 回包）；Windows **零证据** | S2 的两步走（先观察） |
| 「Windows 平台包的 vendor 布局与 linux 同形」 | **零证据**（本机只有 linux-x64） | mustExist 第 7/8 条改为**读上游 manifest 的 `pathDir`/`resourcesDir`** 而非硬编码目录名；首个 win CI 跑打印 `dir /s` 的平台包文件清单，回填进本节 |
| 「`codex.js --version` 会输出 `codex-cli <ver>`」 | 本机 `[实测]`（经 shim，等价于 `node codex.js`） | D4 首跑即验证；若 win 上格式不同，按实测调整断言（**不许放宽成 includes**） |
| 「npmmirror 有 linux tar.gz 镜像」 | `[推测]`（按 win 条目形状外推） | `curl -I` 验活；不通就只留官方源 |
| 「GitHub runner 磁盘够 480MB 包」 | 无核算 | §5.7 的 `df -h` 前后两测 |

---

## §11 开放问题（待拍板，不混进正文）

| # | 议题 | 背景（为什么需要拍） | 建议 |
|---|---|---|---|
| **Q1** | **Windows 平台包形状零证据**：mustExist 的第 3/7/8 条依赖 `codex-package.json` 与它声明的 `pathDir`/`resourcesDir` 在 win32-x64 同样存在 | 本机只有 linux-x64；错了会让首个 Windows CI 直接红在 preflight | 接受「首跑 `continue-on-error` 观察 → 回填清单 → 第二跑转硬门禁」的两步走 |
| **Q2** | **体积余量 `headroom = 0.15`** 与「次门禁只 warn」两个档位 | 这是工程判据不是实测；太松等于没门禁，太紧会因上游正常增长频繁误红 | 首跑后按实际余量确认；次门禁维持 warn |
| **Q3** | **要不要在 CI 跑一次 Codex 真回合 smoke** | 现有 Claude 线 smoke 用测试网关凭据（`testCredentials.ts`）；Codex 侧等价物需要 cch 凭据与额度，触发铁律「事前报量」 | **不做**，S3 归手工/加密机点验；若要做须先报量并单独拍板 |
| **Q4** | **`codex-code-mode-host` 保留 = +44 MiB** | 本规格 §3.5 裁定保留并给了反证条件 | 接受保留；省它另立票（需先有「不下发 code_mode_only 模型」的实证） |
| **Q5** | **mac 线的既定破口** | 参数化后 `pnpm build:mac` 的 `fetch:node-runtime` 会跳过（正确），但 mac 包**没有随包 codex**，Codex 只能走全局 npm fallback（`AgentInstaller` 在 mac 上还要加平台闸 ⇒ mac 用户得手动 `npm i -g`） | 接受（D52-② 的直接后果），登记为 mac 票的已知内容，**不在本批临时补救** |
| **Q6** | **门禁只在出包时跑**：`build.yml` 的触发器是 `push: tags` + `workflow_dispatch`（`:3-7`），D41 的 gate 挂在同一 workflow ⇒ 合入 main 时不跑，打 tag 才发现红 | D41 原文只说「打包前置」，没说 PR 门禁；补 `on: pull_request` 属新增 workflow，超出本批范围 | 本批按 D41 原文只做打包前置；**是否另立 `ci.yml` 跑 PR 门禁**请拍板 |
| **Q7** | **codex 0.147.0 升级票排期** | 在野已有更新版本（deepseek 研究档的证据 pin）；升级须走「blessing 重跑 + 契约快照 diff + 夹具复核」三件套 | 本批不做；升级票排在 2b 收官后、flag 转 on 之前或之后由用户定 |
| **Q8** | **`compression: maximum` 是否降档** | 新增 ~347MB 未压缩二进制，`maximum`（xz 极限档）可能让单步出包时间翻倍 | 首跑实测；单步 > 40 分钟则提交降到 `normal` 的拍板（代价 = 安装包变大） |

---

## §12 溯源

- **上游**：[S3 切片 2 仲裁档](./2026-08-09-s3-slice2-arbitration.md)（§0-① 随包裁定 + C-a/C-b）· [阶段 4 立项调查档](./2026-08-19-stage4-packaging-kickoff.md)（REQ-1~15 / R1~R6 / D52）· [S1 spike 报告](./2026-08-06-s1-acp-codex-spike-report.md)（体积与进程链实测）· 总台账 D36/D41 · [S6 adoption spec](./2026-08-15-d47-s6-adoption-spec.md) L115（投影链退役批归口，本批只登记不施工）。
- **章法参照**：[D48 施工规格](./2026-08-16-d48-agent-picker-spec.md)（目标/红线/逐切片契约/断言清单/测试与变异计划/开放问题）。
- **本批新实测**（2026-08-19，`aa016b9`，Linux x64 / node v24.18.0 / codex-cli 0.145.0）：§0.3 A~F 六组，全部可复现（命令见各条）。
