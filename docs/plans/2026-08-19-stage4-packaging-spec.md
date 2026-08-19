# 阶段 4「2b 打包链」施工规格（rev.2）

> 2026-08-19。plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> **rev.2（2026-08-19，双轨双盲评审「须改后再审」后就地修订）**：两轨合取 20 条（8 blocker / 12 major）+ 全部 minor 已逐条落实，去向见 **§13 rev.1→rev.2 修订记录**。
> 承重改判四条：① `AgentInstaller.ensureNode` 是**虚构符号**，加闸入口改为实存的五个（§4.3）；② `build-agent-host.mjs` 顶层 `await main()` 使「import 即测」不可行，抽纯模块 `scripts/agent-host-build-lib.mjs`（§9）；③ mac 上 codex **整包 prune**（rev.1 的按当前平台取包会把 347MB 未签名 Mach-O 送进公证链，§3.2/§3.4）；④ Linux bundled node 的覆盖靠 **verify 硬断言**而非删 CI 步骤（§5.4-5）。
> **权威链**：[S3 切片 2 仲裁档](./2026-08-09-s3-slice2-arbitration.md)（用户裁定层，最高）→
> [阶段 4 立项调查档](./2026-08-19-stage4-packaging-kickoff.md)（REQ 清单 + D52 拍板）→ **本文**（施工唯一入口）。
> 与仲裁档冲突处以仲裁档为准，**唯一例外**：仲裁 C-b 的「external」半句已由本文 §0.2-① 正式改判（有实测依据）。
>
> **产生方式**：编排者三路调查（sonnet ×3）合流立项 → 本文为规格 rev.1，待双轨双盲评审（工法同 D47/D48）。
> **标注纪律**（沿用仲裁档）：`[实测]` = 本批在本机/本仓跑出过字节证据 · `[读码]` = 源码可证 · `[推测]` = 仍是推测，**不得升格**。
> **本文全部 file:line 均于 2026-08-19 在 `99dfd78`（rev.2 重锚，rev.1 锚 `aa016b9`）上 `cat -n` 实读核对。** 本机实测环境：Linux x64 / node v24.18.0 / `codex-cli 0.145.0`。
> **量纲纪律（rev.2 新增）**：本文凡体积数字，`[du]` = `du -sh` 的**块占用**（含 4K 粒度与目录项），`[bytes]` = 文件字节累加（即 `build-agent-host.mjs:210-218` / `verify-packaged-app.mjs:65-73` 的 `dirSize()` 口径）。**两者差可达 ~19%**（实测 `out-agent-host/`：`du -sh` 51M `[du]` vs 42,788,670 B = 40.8 MiB `[bytes]`）。**门禁与预算常量一律用 `[bytes]`**，混用即视为规格缺陷。
>
> 实现方对标注「**实现方可否决**」的项保留否决权；开放问题**单列 §11**，不混进正文。

---

## §0 结论先行

### 0.1 三句话

1. **切四片，依赖序 P1 →（P2 ∥ P3）→ P4**：P1 = 依赖 pin + `build-agent-host.mjs` 四处改造（preflight / copy-prune / mustExist / mustNotExist），产物 = 一个**本地可验的 `out-agent-host/`**，零运行时行为改动；P2 = Main 接线（`AICLIENT_CODEX_JS_PATH` 注入 + AgentInstaller 降级为 fallback + 平台闸）；P3 = 出包与 CI（`electron-builder.yml` 死规则 + D36 Linux 捆 Node + D41 前置门禁 + 缓存/磁盘核算）；P4 = 打包后验证（结构断言 + 零额度 Codex 握手 smoke + 双边体积门禁 + TSD 头扩扫）。
2. **本批不新增任何协议、不新增任何 env 候选规则、不改任何 resolver 顺序**：接线口 `AICLIENT_CODEX_JS_PATH` 在 `codexNodeEntry.ts:100` 已是**候选表第 1 条**（`[读码]`），Main 侧只是往既有 env 契约（`hostEnv.ts:62-73`）加一个**条件注入**的键。REQ-8 / REQ-9 逐字重申见 §1.1。
3. **两条与立项档倾向相反的裁定**：① `codex-code-mode-host`（44MiB）**保留不 prune** —— 这是 **`[推测/保守决策]`**（已证「默认模型是 `code_mode_only`」，**未证**「原生 codex 会 spawn 它」；施工时按 §3.5 的进程树/有无对照闭合，闭合失败则另立 prune 票）；② esbuild `external` **不加 codex**（全仓零 import，`[实测]`，见 §0.2-①）。
4. **rev.2 的四条承重改判**（文档头已列）：`ensureNode` 虚构符号 → 五个实存写侧入口；顶层 `await main()` → 抽 `agent-host-build-lib.mjs`；mac 白名单（codex 整包不进 mac 产物）；Linux bundled node 靠 verify 硬断言而非删 CI 步骤。

### 0.2 定稿相对上游文档的改判清单

> 给评审者的差异索引：说明「为什么与你读过的仲裁档/立项档不同」。施工方只读正文即可。

| # | 改判项 | 上游原状 | 本文裁定 | 依据 |
|---|---|---|---|---|
| ① | esbuild `external` 是否加 `@openai/codex` | 仲裁 C-b：「preflight / external / copy-prune / mustExist / packaged verifier **整条都要改**」 | **不加**。`external` 保持 `['@anthropic-ai/claude-agent-sdk','@cometix/claude-code']` 两项不动（`build-agent-host.mjs:113`） | `[实测]` 全仓零 `import … from '@openai/codex'`：`grep -rn "@openai/codex" src/` 命中 **25 处**（rev.2 复核；rev.1 写 10 处是被 `head_limit` 截断后误记），**全部是字符串/注释/测试断言文案**（`codexNodeEntry.ts:9/134/254/255`、`agentSupport.ts:234`、`__tests__` 文案、`spikes/s1-acp-codex-probe.ts:17` 等），**零 import 结论不变**。codex 是 `spawn` 出去的外部 CLI，esbuild 的模块图里根本没有它 —— 往 `external` 里加一个从不被 import 的名字，是**零效果的假施工**，还会让下一个人以为它进了 bundle 依赖面 |
| ② | `codex-code-mode-host`（44MiB）取舍 | 立项档 R3：「code-mode 特性我们不消费则 prune 掉」 | **保留**（**保守决策，证据等级 `[推测/保守决策]`，非 `[实测]`**），并加 mustExist 断言防误删；施工时按 §3.5 的闭合动作取证，**闭合失败则另立 prune 票** | rev.2 按双轨分歧裁定下调证据等级：现有证据只证明「默认模型是 `code_mode_only`」，**没有任何生产代码消费该二进制的因果证据**（无进程树、无有/无对照）。保守方向维持保留（省 44MiB 的下行风险落在用户机、不落在开发机），但不得把它写成已证事实 |
| ③ | `AICLIENT_CODEX_JS_PATH` 的注入范式 | D47 三键范式（`hostEnv.ts:29-46`）：键**恒在**、值可 `undefined`，用来**压制**继承污染 | **相反**：值缺席时**整键省略**；且用户 shell 已设该键时 Main **不覆盖**。**限定（rev.2 补）**：该逃生口只在**终端启动 / 系统级环境变量**下可用 —— Dock/桌面/开始菜单启动的 Electron 进程**不继承登录 shell 的 env**，GUI 常规启动的用户无从设置它 | 两者防的东西不同：D47 三键是**凭据**，一个从开发 shell 漏进去的 key 是安全事故；本键是**路径**，且 `codexNodeEntry.ts:34-35/99-100` 逐字自陈它是「explicit escape hatch」。覆盖它 = 删掉逃生口，与 C-a「坏的 bundled 可被 env 覆盖」同构反例。**面向 GUI 用户的真逃生口（settings 显式路径项）另立票，本批不做**（§11-Q10） |
| ④ | Linux 侧「bundled node 真的被用上」怎么证 | rev.1：**删除** `build.yml:231-237` 的 `Setup Node.js 24 (packaged-state verify)` 步骤，靠 runner 只剩 node 20 来逼出 bundled | **改判**：主手段是 **`checkNodeRuntime` 加一条独立硬断言** ——「`nodeRuntimePinFor(platform,arch)` 有 pin ⇒ bundled 必须存在、可执行、版本等于 pin」（§5.4-5）；**删不删那个 CI 步骤降级为次要**（建议仍删，减少误导） | rev.1 的推理有洞：`main()` 的 `Boolean(node24) \|\| Boolean(bundled)`（`verify-packaged-app.mjs:320-326`）是 **OR**，删步骤只是让「当前这台 runner 上」没有 v24；runner 镜像预装/缓存残留/未来镜像变更都可能重新提供 v24，把坏掉的 bundled 重新掩护住。**断言不该依赖 runner 镜像的当期成分** |
| ⑤ | Main 侧 `getBundledNodeRuntimePath()` 的 win32 闸 | 立项档 D36 行只列了 `node-runtime-pin` / `fetch` / `afterPack` / `verify` 四处 | **必须同批撤闸**（第五处改动面） | `AgentHostManager.ts:687-691` `[读码]`：`if (process.platform !== 'win32') return undefined`。不撤 = Linux 包里躺着一个 node 但 resolver 永远不看它，D36 只涨体积不产生收益 |
| ⑥ | AgentInstaller 平台闸（R5）的落点 | 立项档：「`installAgent()` 无平台闸…顺手加闸」；**rev.1 把入口写成四个，其中 `ensureNode` 是虚构符号** | 闸加在**实存的五个写侧入口**：`installGit`(:237) / `installNode`(:284) / `installAgent`(:340) / `downgradeClaudeToNodeVersion`(:392) / `installAll`(:411)；**探测类入口 `checkPrerequisites`(:202)/`detectGit`/`detectNode`/`checkWingetAvailable` 保持现状不抛**；`refreshPath`(:218) **本批不加闸**（§11-Q9） | `[读码]` 复核：类里根本没有 `ensureNode`（`grep -n "async " AgentInstaller.ts` 全表见 §4.3）。`OnboardingService.ts:939-946` 的 `detectCli()` 在**所有平台**都调 `checkPrerequisites()` ⇒ 在探测侧加闸 = Linux/mac onboarding 直接炸。R5 的真实缺陷面是 `runCmd`（`AgentInstaller.ts:191-193` = `cmd.exe /d /s /c`）在非 Windows 上 `ENOENT`，只出现在写侧 |
| ⑦ | 体积门禁形状（REQ-14） | 立项档：「verify 加包体阈值断言」（单边上限） | **双边**：上限（防静默膨胀）**+ 下限**（防静默丢失） | 丢失比膨胀更阴：codex 平台包没打进去时，开发机与 CI 都有全局 codex 可回落（`codexNodeEntry` 规则 2/3/4），**只有用户机会红**——正是 `codexNodeEntry.ts:16-22` 记载的同一失效族 |
| ⑧ | codex 随包的**平台白名单** | rev.1：`shouldCopy`/preflight 按 `process.platform` 取「当前平台包」 | **显式白名单 `CODEX_SHIPPED_PLATFORMS = ['win32-x64','linux-x64']`**（与 D52-② 同集合）：不在白名单的平台，preflight 跳过全部 codex 校验、copy 阶段 codex **整包 prune**、verify 断言 `node_modules/@openai` **不存在** | rev.1 的写法在 mac 上会把 **≈347MB 未签名 Mach-O** 拷进 `resources/agent-host`，随后进 `hardenedRuntime: true` + `notarize: true` 链（`electron-builder.yml:167-171`）——轻则公证失败、重则出一个签名无效的包，与 D52-②「mac 不纳入本批」直接矛盾。白名单同时是 `nodeRuntimePinFor` pin 表的 key 集合，两表用一条静态断言互钉（C9） |
| ⑨ | `src/agent-host/package-lock.json` | rev.1 改动面漏列 | **列入 P1 改动面**：用与 CI 同版本的 npm 重新生成并提交，六平台 alias 条目齐全 | `npm ci` 严格按 lock 安装（`build.yml:119-124`/`:218-221`）。只改 `package.json` 不改 lock ⇒ **CI 的 `npm ci` 直接失败**（lock 与 manifest 不一致），P1 在本机「装好了」的假象撑不到 CI |
| ⑩ | 体积门禁的上限公式 | rev.1：`(A0 + P) × (1 + 0.15)` 单一余量 | **分项余量** `A0 × (1+h₁) + P × (1+h₂)`，`h₁ = 0.10`、`h₂ = 0.15` | 两个基数的波动性质不同：`A0` 是仓内已驯化的依赖（cometix/sdk 小步升级），`P` 是新引入的单一上游二进制（波动未知）。合并余量会让 `A0` 借走 `P` 的空间，反之亦然，两边的分辨率都下降 |

### 0.3 承重事实（本批 2026-08-19 实测，写进规格是因为设计形状依赖它们）

**A. `@openai/codex@0.145.0` 的真实形状**（本机全局安装 `/home/dan/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex`，`[实测]`）

| 项 | 值 |
|---|---|
| 主包 `files` | 只有 `bin/codex.js`（7,236 B）+ `package.json`（**1,082 B**）+ `README.md`（2,814 B）。**rev.1 的 511 B 是平台包的 package.json，串行了**（B-5 勘误） |
| `optionalDependencies` | 六项，**别名形式** `"@openai/codex-linux-x64": "npm:@openai/codex@0.145.0-linux-x64"`（六平台：linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 / win32-x64 / win32-arm64） |
| 平台包 `package.json` 的 `name`/`version` | `"@openai/codex"` / **`"0.145.0-linux-x64"`** ← 目录名是 `@openai/codex-linux-x64`，**包名不是**。preflight 若按目录名校验 `version === pin` 会恒红 |
| 平台包 `files` | 只有 `vendor` |
| 平台包全部文件（**8 个，可穷举**） | `package.json` 511 · `README.md` 2,814 · `vendor/x86_64-unknown-linux-musl/bin/codex` **310,730,800** · `…/bin/codex-code-mode-host` **46,139,288** · `…/codex-path/rg` 5,408,904 · `…/codex-resources/zsh/bin/zsh` 898,480 · `…/codex-resources/bwrap` 529,776 · `…/codex-package.json` 205 |
| 平台包合计 | **363,710,778 B** `[bytes]`（八文件全量）；**363,707,964 B** = 减去被 `shouldCopy:169` 的 `.md` 规则丢弃的 `README.md` 后的**有效负载**（`du -sh` 报 347M `[du]`，与仲裁档 §0-① 一致）。**P4 的预算基数 `P` 用「有效负载」口径**，定义见 §6.3（B-5 勘误：rev.1 把 363,707,964 当成了八文件全量） |
| 文件权限 | vendor 下**可执行件** 0775（`codex` / `codex-code-mode-host` / `codex-path/rg` / `codex-resources/zsh/bin/zsh` / `codex-resources/bwrap`）；**清单与元文件 0664**（`codex-package.json` / 平台包 `package.json` / `README.md`）；目录 0775。**rev.1 的「vendor 下全部 0775」不成立**（B-5 勘误）——exec 位断言（§3.3-4）只针对**入口二进制**，不许写成「vendor 下全员可执行」 |
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
| `out-agent-host/`（linux-x64，codex 未入包）**= §6.3 的 A0** | **42,788,670 B = 40.8 MiB** `[bytes]`（`du -sh` 51M `[du]`） |
| `dist/linux-unpacked/resources/agent-host/`（0.3.4 构建） | 42,653,382 B = 40.7 MiB `[bytes]`（与上行差 135,288 B，因构建时点不同；预算取 `out-agent-host` 现值） |
| `dist/linux-unpacked/`（0.3.4 构建） | 413 MB `[du]`；其中 `resources/` 129 MB `[du]` |
| `dist/AiClient-0.3.4.AppImage` | 114,381,606 B |
| `src/agent-host/node_modules/`（未 prune 全量） | 467 MB `[du]` |
| **codex 进包后的净增量 `P`（linux-x64）** | 平台包有效负载 363,707,964 + 主包有效负载（`bin/codex.js` 7,236 + `package.json` 1,082，README 被丢）8,318 = **363,716,282 B = 346.9 MiB** `[bytes]` |

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
- 新增一条（rev.2，minor A-m8）：**仓内 `npm ci` / `npm install` 只在 `src/agent-host/` 内拉 pin 版，绝不带 `-g`、绝不动全局 `lib/node_modules`**。本批引入的 `@openai/codex` 是**项目依赖**；任何一条把它装到全局的命令都同时违反上一条与「不动本机配置」铁律。施工中若发现某步骤需要全局装才能跑通，**当场停并登记**，不许绕。

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
| **P1** | 依赖 pin + 构建产物 | `src/agent-host/package.json` 加 `@openai/codex` 精确 pin + **`src/agent-host/package-lock.json` 重生成并提交**（REQ-3，改判 ⑨）+ `build-agent-host.mjs` 四处（preflight / copy-prune / mustExist / mustNotExist，REQ-4）+ 新纯模块 `scripts/codex-platform.mjs` **与 `scripts/agent-host-build-lib.mjs`**（改判 ②，§9） | — | 无（只产 `out-agent-host/`） | ✅ 四门 + `pnpm build:agent-host` 本地实跑 + **干净目录 `npm ci` / `npm ci --omit=optional` 双跑** + 纯模块单测 |
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

**lockfile 纪律（rev.2 新增，改判 ⑨）**：`src/agent-host/package-lock.json`（现 70,089 B `[实测]`）必须**与 `package.json` 同批重新生成并提交**。

- 生成方式：在 `src/agent-host/` 内 `npm install`（**不带 `-g`**，§1.2 铁律），用与 CI 一致的 npm —— CI 走 `actions/setup-node` node 20（`build.yml:78-81`/`:187-192`），as-built 必须记本机 `npm -v` 与 CI 上 `npm -v` 两个值，**不一致就以 CI 版本重跑**（npm 8/9/10 的 lock 结构差异会让 `npm ci` 在 CI 上炸）。
- 提交前逐条确认：lock 里有 **六条** `node_modules/@openai/codex-<key>` 条目，各带 `"optional": true` + `os`/`cpu`，且 `name:"@openai/codex"` / `version:"0.145.0-<key>"`（别名形态，§0.3-A）。缺条 = 换台机器 `npm ci` 装不到平台包。
- **Happy Path 必跑两轮**（§8-P1）：干净目录 `npm ci`（含 optional，供构建）与 `npm ci --omit=optional`（供 D41 门禁作业，§5.6）——后者要实证 cometix postinstall 不炸（`install.cjs:59-67` 只 `console.error` 后 `return`，`[读码]`，但 codex 的 postinstall 行为**零证据**，必须实跑）。

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
/** 本批随包的平台白名单（改判 ⑧）。key 集合必须与 NODE_RUNTIME_PINS 完全相等（静态断言 C9）。 */
export const CODEX_SHIPPED_PLATFORMS = ['win32-x64', 'linux-x64'];

export function codexPlatformKey(platform, arch)      // 'win32','x64' -> 'win32-x64'
export function isCodexShippedPlatform(platform, arch)// -> boolean（白名单查表）
export function codexPlatformPkgLeafName(platform, arch) // -> 'codex-win32-x64'  ← 叶名，**不带 scope**
export function codexTargetTriple(platform, arch)     // -> 'x86_64-pc-windows-msvc'
export function codexBinaryName(platform)             // -> 'codex.exe' | 'codex'
export function codexPlatformPkgCandidates(platform, arch) // 见 §3.4-3，两条**逐字**相对路径
export function isForeignCodexPlatformPath(rel, platform, arch) // 见 §3.4-2
```

**命名契约（rev.2 修正 B-2 的双重 scope 缺陷）**：`codexPlatformPkgLeafName()` **只返回叶名** `codex-<platform>-<arch>`（rev.1 的 `codexPlatformPkgDirName()` 返回 `@openai/codex-win32-x64`，而 `codexPlatformPkgCandidates()` 又拼 `@openai/${dirName}` ⇒ 产出 `@openai/@openai/codex-win32-x64`，两处路径全错且**preflight 的双候选都不命中**，表现为「装好了却说没装」）。**scope 由调用方拼**，且候选表在模块里**写成逐字常量**，不再由拼接生成：

```js
// win32-x64 的两条候选（逐字，可与单测真值表字面比对）
export function codexPlatformPkgCandidates(platform, arch) {
  const leaf = codexPlatformPkgLeafName(platform, arch);            // 'codex-win32-x64'
  return [
    `@openai/${leaf}`,                                             // hoisted
    `@openai/codex/node_modules/@openai/${leaf}`,                   // nested
  ];
}
```

> **断言纪律（B-2 附带要求）**：A2/A8 的真值表**期望值必须手写字面量**（如 `'@openai/codex-win32-x64'`、`'@openai/codex/node_modules/@openai/codex-win32-x64'`），**禁止用同一个函数既生成 fixture 又生成期望值** —— 那样双重 scope 这类缺陷会两边同错、断言恒真。

- **本批交付面只有 `win32-x64` 与 `linux-x64`**（D52-② + 改判 ⑧）。表里另外四项**照抄上游**是为了让 `isForeignCodexPlatformPath` 有完整的「必须不在」集合，不是承诺支持。
- **非白名单平台（mac 等）的全链行为**：preflight 跳过 codex 校验并打印 `skip: codex not shipped for <key>`（同 §5.3 的「无 pin 即跳过」范式）→ `shouldCopy` 对 `@openai/**` 一律 `false` → `verifyArtifact` 断言 `node_modules/@openai` 不存在。**mac 本地 `pnpm build:mac` 因此产出一个不含 codex 的包**，这是设计，不是缺口（§4.4-3、§11-Q5）。
- `codexPlatformKey` 的输出形状与 `${process.platform}-${process.arch}` 一致 —— 与 `build-agent-host.mjs` 既有的 `@img/sharp-${process.platform}-${process.arch}`（`:137`）、`node-pty/prebuilds/${process.platform}-${process.arch}`（`:145`）**同构**，这是仓内既定口径，不另起一套。

### 3.3 preflight 新增条目（`build-agent-host.mjs:44-92`）

**第 0 步（rev.2 新增，白名单闸）**：`if (!isCodexShippedPlatform(platform, arch))` ⇒ 打印 `skip` 并**跳过本节全部 codex 校验**（含 `pins` 表里的 codex 条目），直接返回。依据 = 改判 ⑧；范式 = §5.3 的「无 pin 即跳过」。

在既有 `pins` 表（`:50-53`）加 `'@openai/codex'`，复用既有三步（声明存在 / 非范围 / `installed !== pin` 报错）。**在此之后**新增五条 codex 专属校验（形状照抄既有 cometix 空壳守卫 `:64-75`）：

| # | 校验 | 失败信息要点 | 为什么 |
|---|---|---|---|
| 1 | 平台包目录存在（两候选任一，§3.4-3） | `@openai/codex-<key> is not installed — reinstall src/agent-host WITH optional dependencies` | `npm ci --omit=optional` 会装出一个**只有 launcher 没有二进制**的空壳；这是 cometix `cli.js` 守卫（`:67-69`）的同款失效模式 |
| 2 | 平台包 `package.json` 的 `version === \`${pin}-${key}\`` | `expected 0.145.0-win32-x64, got …` | §0.3-A：平台包的 `name` 是 `@openai/codex`、`version` 是**别名串**。按目录名比 `version === pin` 会恒红；不校验则装错版本静默通过 |
| 3 | `vendor/<triple>/codex-package.json` 存在且 `{version,target}` 与 pin/triple 全等，`entrypoint` 指向的文件存在 | `vendor manifest mismatch: …` | 上游自带清单（§0.3-A），比我们猜路径强；同时把「目录名对了但里面是另一个平台的二进制」这种错配挡在构建期 |
| 4 | 入口二进制 size ≥ **200 MiB**（`CODEX_BINARY_FLOOR`，**Windows 侧首跑前为观察值，见 Q1 两步走**），且**非 win32** 下 `mode & 0o111 !== 0` | `codex binary suspiciously small / not executable` | size 下限的推导：**linux-x64 实测 296 MiB**，取 `floor(296 × 2/3)` 归整到 200 MiB —— 它**不是版本闸**（版本由第 2/3 条管），只用于挡 LFS 指针 / 截断 / 占位文件。**`codex.exe` 的真实体量本仓零证据**（本机只有 linux-x64），故该常量与 §3.6-7/8 一并按 **Q1 两步走**：首个 Windows CI 跑 `continue-on-error` 打印真实字节 → 回填 → 转硬门禁。exec 位见 §0.3-D 的两个相反证据（**只针对入口二进制**，不覆盖 vendor 全员） |
| 5 | 其余五平台目录**不在**（两处布局各扫一遍） | `unexpected foreign platform package: …` | R2：构建机装多了变体，`out-agent-host` 直接翻倍且**没有任何人会发现** |

> **实现方可否决**：第 3 条依赖上游 `codex-package.json` 的存在（本机 linux-x64 `[实测]`，**win32-x64 未实证**）。若首个 Windows CI 跑发现该文件不存在，退到「只用第 2+4 条」，并把该发现写进 as-built 与 §11-Q1。**不许改成 `if exists then check`**——那会让最需要它的平台正好跳过（同 b-track「禁止找得到就跑、找不到就 skip」）。

### 3.4 copy-prune（`shouldCopy` / `pruneResidualPlatformPackages`）

**1）保留规则（镜像 `@img` 与 cometix vendor 两条先例）**

在 `shouldCopy`（`:128-174`）里、`@img` 分支（`:136-138`）之后加：

```
if (parts[0] === '@openai') {
  // 白名单外的平台（mac 等）：codex 整包不进产物（改判 ⑧，防 347MB 未签名 Mach-O 进公证链）
  if (!isCodexShippedPlatform(process.platform, process.arch)) return false;
  // 只放行主包与当前平台包；其余（含嵌套布局）交给 isForeignCodexPlatformPath 兜底
  const keep = new Set(['@openai/codex', `@openai/${codexPlatformPkgLeafName(process.platform, process.arch)}`]);
  if (parts.length >= 2 && !keep.has(top)) return false;
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

**裁定**：**保留，不 prune** —— 但这是 **`[推测/保守决策]`，不是 `[实测]`**（rev.2 按双轨分歧裁定下调证据等级）。

- **已证的**：默认模型是 `gpt-5.6-sol`，且它 `tool_mode:"code_mode_only"`。
- **未证的**：**没有任何证据表明 `codex` 原生二进制会去 spawn `codex-code-mode-host`**，也没有「删了它某功能就坏」的对照。「`code_mode_only` ⇒ 需要那颗二进制」是**名字上的推断**。
- **为什么仍然保留**：两个方向的错误代价不对称 —— 错误保留 = 多 44 MiB（可量化、可回收）；错误删除 = 默认模型的工具执行路径可能在**用户机**上断掉，而开发机与 CI 都有全局 codex 兜底、复现不出来（与 `codexNodeEntry.ts:16-22` 记载的失效族完全同形）。

**施工时的闭合动作（必须做，做完把结论回填本节并升/降级）**：任选其一 —— ① **进程树取证**：跑一个真回合（或 S2 握手后的最小工具调用），`ps --forest` / Process Explorer 看是否出现 `codex-code-mode-host` 子进程；② **有/无对照**：临时移走该文件跑同一场景，观察是否报错。
**闭合结果的三条去向**：证实消费 ⇒ 升级为 `[实测]`、mustExist 保留；证实不消费 ⇒ **另立 prune 票**（省 44 MiB），本规格不改；无法取证 ⇒ 维持 `[推测/保守决策]` 并在遗留登记。
**反证条件（将来要省这 44 MiB 必须先满足）**：① 上述闭合动作证实不消费，或有实证说明我们下发的每个 model 都不是 `code_mode_only`（D48-S2 的目录白名单落地后才可能有这个前提）；② prune 后跑一次**真回合** smoke（要额度，须先报量）。

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
| 9 | 其余五平台目录，**两处布局各一条**（共 **10** 条） | R2 静默膨胀（347MB × 5） |
| 10 | `node_modules/.bin`（**整个目录**，与 verifier 层级对齐） | npm 的 bin 软链目录；既有 `shouldCopy:133` 排除它、`verify-packaged-app.mjs:127` 的 mustNotExist 也是 `node_modules/.bin` **整目录**（rev.1 写成 `node_modules/.bin/codex` 单文件，与 verifier 层级不一致 —— 目录在而只是没有 codex 链接时会漏判）。这条是**发射半边 pin** |
| 11 | `node_modules/@openai/codex/vendor` | 该目录若存在，说明有人把 `codex.js:85` 的回落路径当成了正路（主包 `files` 里没有 vendor，出现即异常） |
| 12 | **非白名单平台**：`node_modules/@openai`（整个 scope 目录） | 改判 ⑧ 的可执行版本：mac 产物里出现任何 `@openai` 即红 |

> **计数口径**：mustNotExist 共 **12 条**（第 9 条自身展开为 10 条路径，故实际断言数 = 10 + 1 + 1 + 1 = 13 个 `check()`，其中第 12 条只在非白名单平台生效）。rev.1 写「十一条」是漏了第 12 条，A-m1 勘误。

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
// B-8：statSync().isFile() 而非 existsSync —— 同名目录/损坏项必须判否，
// 否则我们会把一个非文件路径塞进 env，把失败从「Main 侧可诊断」推到「Host spawn 时才炸」。
const usable = (p) => { try { return statSync(p).isFile() && statSync(p).size > 0; } catch { return false; } };
const codexJsPath = userOverride ? undefined : (usable(bundled) ? bundled : undefined);
buildAgentHostEnv({ …, codexJsPath })                            // undefined ⇒ 整键省略
```

| 条件 | Main 行为 | Host 侧结果 |
|---|---|---|
| 用户 shell 已设 `AICLIENT_CODEX_JS_PATH`（非空） | **不注入**（省略键） | `AgentHostProcess.start()` 的 `{...process.env, ...options.env}` 让用户值原样穿过 ⇒ 用户逃生口成立。**限定**：Electron 主进程只有在**终端启动**或用户设了**系统级环境变量**（Windows 用户/系统变量、Linux `~/.config/environment.d`、macOS `launchctl setenv`）时才看得到它；Dock/桌面/开始菜单启动**不继承登录 shell env**（改判 ③）。故本臂是「**排障用逃生口**」，不是面向普通用户的功能 |
| 未设 + 随包文件存在 | 注入 bundled 路径 | `codexNodeEntry` 候选表规则 1 命中，`source:'env'` |
| 未设 + 随包文件缺失（mac 本地包 / 打包出错 / dev 未 `npm install`） | **不注入** | 规则 2/3/4 照旧 ⇒ 落到用户全局 npm 装（§4.3 fallback）；全不中则 `codex_entry_unresolved`，文案已含「Set AICLIENT_CODEX_JS_PATH…或 npm i -g @openai/codex」（`:251-257`） |

**`hostEnv.ts` 的接口改动**（加法）：`AgentHostEnvInput` 加 `codexJsPath?: string`；`buildAgentHostEnv` 返回体加 `...(input.codexJsPath ? { AICLIENT_CODEX_JS_PATH: input.codexJsPath } : {})`。
**必须在文件头注写清「为什么这一键与 D47 三键范式相反」**（§0.2-③ 的两句理由：凭据 vs 路径、逃生口 vs 防污染）。既有五键 `toEqual` 测试（`hostEnv.test.ts:33`）因 `toEqual` 忽略 `undefined` 属性而不受影响，但**新增的省略语义必须有自己的断言**（B3/B4），否则「改成恒在 + undefined」这个变异不会红。

### 4.3 AgentInstaller 降级为 fallback + 平台闸（R5）

**语义降级（文档 + 调用侧措辞，不删代码）**：`installAgent('codex')` 的 `npm install -g @openai/codex`（`AgentInstaller.ts:347-365`）从「Codex 可用的前置条件」降级为「**fallback 路径**」。保留它的理由有三：① mac 未纳入本批（D52-②），mac 用户仍靠它；② 用户自带/自管 codex 的场景；③ 随包文件损坏时的人工恢复手段。
**改动面**：`installAgent` 上方补注释说明降级与依据（本规格 §4.2 三条判据表 + REQ-1），并在 onboarding 文案侧登记（**实现方可否决**：若 onboarding 文案改动会牵出 D47 的 golden-diff 测试面，则本片只改注释、文案改动另票）。

**平台闸（R5，rev.2 按实存符号重写 —— rev.1 的 `ensureNode` 不存在）**

`[读码]` `AgentInstaller` 类的全部 `async` 成员（`grep -n "^  async " src/main/services/cli/AgentInstaller.ts`）：

| 行 | 成员 | 性质 | 本批处置 | 非 Windows 行为臂 |
|---|---|---|---|---|
| :202 | `checkPrerequisites` | 探测 | **不加闸** | 维持现状（各 detect 内部自行吞错，返回 `installed:false`）；断言见 B7 |
| :218 | `refreshPath` | 探测/副作用（读 Windows 注册表 PATH） | **本批不加闸** | 维持现状；理由与遗留见 §11-Q9 |
| :237 | `installGit` | **写侧**（winget / PowerShell） | **加闸** | `throw new Error('AgentInstaller.installGit is Windows-only …')` |
| :284 | `installNode` | **写侧**（Invoke-WebRequest + msiexec + UAC） | **加闸** | 同上（`throw`） |
| :340 | `installAgent` | **写侧**（`runCmd` = `cmd.exe /d /s /c npm install -g …`） | **加闸** | 同上（`throw`） |
| :392 | `downgradeClaudeToNodeVersion` | **写侧**（uninstall + 重装） | **加闸** | 同上（`throw`） |
| :411 | `installAll` | **写侧编排器** | **加闸，放在既有 `try` 的第一行** | **不外抛**：由既有 `catch` 转成 `{ success:false, errors:[message] }`（`InstallResult`，`src/shared/types/onboarding.ts:77-81`；与 `cancelled` 臂同形）。**这是与另外四个入口的语义分叉，必须逐字实现，不许"统一成 throw"** —— IPC/renderer 侧消费的是 `InstallResult`，抛出去只会变成一个未分类的 IPC 错误 |

- 闸文案统一含 `Windows-only`（B6 断言按该关键词匹配）并点名 `cmd.exe/PowerShell/msiexec toolchain`。
- **不加闸**的入口：`checkPrerequisites` / `refreshPath` / `detectGit` / `detectNode` / `checkWingetAvailable` —— 依据 §0.2-⑥（`OnboardingService.ts:939-946` 在所有平台调 `checkPrerequisites()`）。
- 依据（缺陷是真的）：`runCmd` = `runCommand('cmd.exe', ['/d','/s','/c', command])`（`AgentInstaller.ts:191-193` `[读码]`），非 Windows 上必 `ENOENT`，用户看到的是「spawn cmd.exe ENOENT」而不是「这功能不支持你的平台」。

### 4.4 P2 Happy Path

1. **随包主路径**：打包 Windows → 装机 → Host 启动 → Main 注入 `AICLIENT_CODEX_JS_PATH=<install>/resources/agent-host/node_modules/@openai/codex/bin/codex.js` → `resolveCodexLaunch` 规则 1 命中、`source:'env'` → spawn `node <codex.js> app-server` → `initialize` 回包 → `capabilities.agents` 含 `codex`。
2. **用户逃生口（限定场景）**：用户**从终端启动**或设了**系统级环境变量** `AICLIENT_CODEX_JS_PATH=/opt/mycodex/bin/codex.js` → Main 不覆盖 → Host 用用户值。**GUI 常规启动（Dock/桌面/开始菜单）下该臂不可达** —— 此时唯一的排障手段是重装或改用 settings 逃生口（**另立票**，§11-Q10）。
3. **mac（非白名单平台）**：`pnpm build:mac` 产出的包**不含随包 codex**（改判 ⑧ 的设计结果，不是打包出错）→ Main 推导路径不存在 → 不注入 → Host 规则 2/3/4 命中用户全局 npm 装 → 与今天行为一致。**mac 上 `AgentInstaller` 五入口全被平台闸挡住**（§4.3），用户须自行 `npm i -g @openai/codex`，这一条必须进 mac 票的已知内容（§11-Q5）。
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
   > **注释措辞禁令（rev.2，消解 A-m5 的自相矛盾）**：该注释可以出现「Codex」一词，但**禁止写出完整包名 `@openai/codex`** —— C4 断言的正是「YAML 里不再有这个包名」，注释里写回去会让 C4 与本条互斥。C4 的形状同步收窄，见 §7.3-C4。
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
| 5 | `verify-packaged-app.mjs:227` `checkNodeRuntime` 的 win32 闸 | 同样按 pin 存在与否分支；`expected = v${NODE_RUNTIME_VERSION}`（`:241` 逻辑不变）。**并新增一条独立硬断言（改判 ④，本片最承重的一条）**：`nodeRuntimePinFor(platform,arch)` 有 pin ⇒ `bundled !== null`（存在 + 可执行 + 版本等于 pin）**必须单独 `check()` 一次**，**不参与 `main():320-326` 的 `node24 \|\| bundled` OR**。有了它，runner 上有没有 machine node 24 都不再能掩护一个坏掉的 bundled；`build.yml:231-237` 那个 `Setup Node.js 24` 步骤删不删只剩「减少误导」的次要价值（**仍建议删**） |

> Main 侧改动虽属 P2 的地盘（TS + 单测），但它与 D36 是同一条因果链，**归 P3 施工**，在 P3 的四门里收口。

**风险登记（rev.2 新增，A-M4）——「Linux 存量用户的 runtime 被静默切换」**

撤闸（改动 4）的直接后果：**已装机的 Linux 用户，下次升级后 Agent Host 的 Node 从「机器上的 node 24」切成「包内的 24.18.0」**。这不是纯增量，是一次运行时替换。

- **失效面**：`NodeRuntimeResolver` 的 `probeNodeBinary`（`:97-109`）对**探不通/版本不符**的候选只是 `inspected.push(reason)` 后 `continue`（`[读码]`）——即**坏的 bundled 会被静默跳过**，用户表面上一切正常，实则退回机器 Node。好处是不会炸，坏处是**我们不会知道它坏了**。
- **发现面**：正因如此，改动 5 的硬断言是这条风险的**唯一自动发现手段**（CI 每次出包都验），必须与撤闸**同批落地**，不许拆开。
- **回退手段**：本改动**没有 flag**（resolver 不读 flag，加一个就是改 REQ-9 的形状）。回退 = **revert 撤闸那一个 commit**（`getBundledNodeRuntimePath` 恢复 win32 return）——因此该改动必须是**独立小 commit**，不与 afterPack/CI 改动混在一起，as-built 记下它的 hash。
- **不做的事**：不为此加「优先机器 Node」的临时开关（第二真源）；不改 resolver 顺序（REQ-9）。

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
      - checkout（`actions/checkout@v5`，形状同 `build.yml:17-18`）/ setup pnpm 10.26.2（`:20-23`）
        / setup node 20（`:25-28`）/ pnpm store cache（`:30-38`）
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

**as-built 观测项（rev.2，minor A-m7）**：`gate` 与 `build-app` 都会各装一次 pnpm 依赖（两次 `pnpm install --frozen-lockfile`，各自命中同一 `pnpm-store-<hash>` 缓存）。**本批不合并这两个作业**（合并会让「门禁」与「产物」耦合，且 `build-app` 的产物上传逻辑要重排），但必须在 as-built 记录：两次 install 的 step duration、缓存命中与否。若二者合计显著拖长总时长，作为**后续优化票**的输入，不在本批处理。

> `actions/cache` 版本统一用 **`@v5`**（minor A-m6）：仓内既有 `@v5`（`build.yml:34/99/106/205`）与 `@v4`（`:130` 的 node-runtime 缓存）混用；本批新增/改动的缓存步骤一律 `@v5`，并**顺手把 `:130` 那条也升到 `@v5`**（同一批里留一个 v4 会让下一个人以为有版本讲究）。

### 5.7 CI 缓存、磁盘与时长的核算方法（REQ-7）

**这一节给方法与判据，不给凭空的数字。**

> **常量定性（rev.2，B-11 ≡ A-§5.7）**：本节出现的 **2 GB（缓存条目）/ 5 GB（磁盘剩余）/ 40 min（压缩单步）** 三个数**均为「首跑基线建立前的可调告警值」，不是验收硬门**。首跑拿到真实值后回填基线并据此重设告警线；**在基线回填前，超过告警值只记录、不判红**。任何人把它们当门禁阈值都属误读。

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
| **S1（必做，进门禁）** | `spawn(node24, [<packaged codex.js>, '--version'])` | stdout 全等 `codex-cli <pin>` | 一次进程启动 | 本机 `[实测]`：`codex --version` → `codex-cli 0.145.0`，而该 shim realpath 即 `bin/codex.js`（`codexNodeEntry.ts:36-38` 记的同一事实）。这一条同时证明：随包 launcher 可读、`require.resolve` 找得到平台包、原生二进制可执行（`codex.js:195` 的 `spawn(binaryPath, …)` 是版本输出的唯一来源 —— **rev.2 勘误：rev.1 引的 `:110` 是 `const binaryPath = findCodexExecutable()`，不是 spawn 行**） |
| **S2（先观察后转门禁）** | `spawn(node24, [<codex.js>, 'app-server'])` + 临时 `CODEX_HOME` + **只发 `initialize`**，读回包后关 stdin | 回包含 `codexHome === <临时目录>`、`platformOs` 与当前平台一致；进程干净退出 | 无额度（仲裁 §3-2a-2 逐字：「只发 `initialize`，S1 实测 178–188ms，**不花额度**」）；e4 spike 记有真实回包形状（`2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md:79`：**凭据缺失下 `initialize` 照样回 result**）| 证明**三级进程链**（node → codex.js → 原生 codex）在打包布局下真的能起来 —— 这是 S1 证不到的那一半 |
| **S3（不进 CI）** | 真回合 PONG（Codex 轴） | — | 要 cch 凭据 + 额度 | 归入手工/加密机点验半边（§9-T4）与 §11-Q3 |

**S2 的两步走纪律**：首个 CI 跑以 `continue-on-error: true` 观察（或用 `--codex-smoke=observe` 开关），拿到真实 stdout/stderr 后**第二跑转硬门禁**。理由：`app-server` 在无 `auth.json` 的 runner 上的行为只有 Linux 的间接证据，Windows 侧零证据。**不许写成「起得来就断言、起不来就跳过」**。

**CLI 参数**：新增 `--skip-codex-smoke`（与既有 `--skip-smoke`，`:43-44`，并列且互不影响），让 D36/D41 的排障可以单独关掉这一段。

**挂载点与 runtime 选择（rev.2，A-M7 —— rev.1 没写，会被继承成恒真 skip）**

- **位置**：`main()`（`:312-350`）里，**`checkNodeRuntime(args.appDir)` 之后、既有 `--skip-smoke` 分支（`:330-341`）之前**，作为一段独立逻辑。理由：它需要 `bundled` 的结果，但**不属于**既有 Claude smoke 的条件链。
- **runtime 选择**：`bundled ?? node24`（与既有 `:329` 同序）。
- **禁止继承 `:340` 的恒真 skip**：既有代码在拿不到任何 runtime 时走 `console.log('smoke skipped — no runtime available')` 且**不计失败**。codex smoke **不许沿用**：在**有 pin 的平台**（win32-x64 / linux-x64）上拿不到 runtime，本身就是 D36 失败的证据 ⇒ **按红计**（`check('codex smoke runtime available', false, …)`）。只有非白名单平台（mac）才允许静默跳过。
- **structure 失败时**：沿用 `:337-339` 的既有语义（结构红了就不跑 smoke），避免在半残产物上刷一屏二次错误。

**S1/S2 的进程纪律（rev.2，B-10）**

1. **双超时**：① **响应超时**（S2 发出 `initialize` 后等首帧）与 ② **退出超时**（关 stdin 后等进程退出）**分开计时、各自可判**。只设一个总超时会把「回了但不退出」误诊成「起不来」。首值取 `initialize` 实测 178–188ms（仲裁 §3-2a-2）的**十倍档**（2000 ms）作观察值，退出超时同档；**首跑后按实测回填**（与 §5.7 同一「可调告警值」纪律）。
2. **NDJSON 帧上限**：读 stdout 时设**累计字节上限**（如 1 MiB）与**行数上限**，超限即判失败并截断打印。理由：`app-server` 是长驻进程，异常时可能持续输出；无上限的 `stdout += buf` 会把 CI 内存吃满（既有 `runSmokeOnce:274-279` 就是无上限累加，**不许照抄**）。
3. **失败即终止进程树**：任何一条超时/上限触发，都要 `kill` 子进程**及其派生的原生 codex**（三级进程链：node → codex.js → 原生 codex）。仅 `child.kill()` 只杀 node 层，原生 codex 会**留在 runner 上**并可能吊住作业。用仓内既有 `killProcessTree`（`src/main/utils/processUtils`）的同款做法；脚本侧无法 import TS 时，win 用 `taskkill /T /F /PID`、posix 用进程组 `kill(-pid)`（spawn 时带 `detached:true` 建组）。**该做法首跑必须实证有效并记进 as-built。**

### 6.3 总体积门禁（REQ-14）：**双边**，阈值给推导式

**落点**：新增纯模块 `scripts/packaging-budget.mjs`（可单测），由 `verify-packaged-app.mjs` 调用。

```js
// 全部为 [bytes]（dirSize() 口径，非 du）。A0/P 由实测填入；h1/h2 为分项余量（改判 ⑩）。
export const PACKAGING_BUDGET = {
  'linux-x64': { baseAgentHost: 42788670, codexPayload: 363716282, h1: 0.10, h2: 0.15 }, // 实测 2026-08-19
  'win32-x64': { baseAgentHost: <首个 win CI 回填>, codexPayload: <首个 win CI 回填>, h1: 0.10, h2: 0.15 },
};
export function agentHostCeiling(k) { const b = PACKAGING_BUDGET[k]; return Math.ceil(b.baseAgentHost * (1 + b.h1) + b.codexPayload * (1 + b.h2)); }
export function agentHostFloor(k)   { const b = PACKAGING_BUDGET[k]; return Math.floor((b.baseAgentHost + b.codexPayload) * 0.9); }
export const CODEX_BINARY_FLOOR = 200 * 1024 * 1024;   // 与 §3.3-4 同一常量，单一真源；win 侧按 Q1 两步走
```

**为什么是分项余量（改判 ⑩ 的说理）**：`A0`（仓内已驯化依赖，cometix/sdk 小步升级）与 `P`（新引入的单一上游二进制，波动未知）的波动性质不同。合并成一个 15% 会让 `A0` 的正常增长借走 `P` 的空间（反之亦然），两边分辨率都下降。`h₁ = 0.10` / `h₂ = 0.15` 都是**工程判据不是实测值**，判据是「能吸收上游正常增长，吸收不了一个多余平台变体（+347MB ≈ +87%）」。
> **备选（实现方可否决时采用）**：`P` 完全交给 §3.6 的清单断言 + `CODEX_BINARY_FLOOR` 单文件断言兜底，**上限只管 `A0 × (1+h₁)`**（把 `P` 从公式里剔除，改为「codex 那部分只验清单不验总量」）。取舍：结构断言对「多一个变体」的咬合力更精确，但对「上游二进制自身暴涨」无感。**本规格取分项余量方案**，因为后者恰好是 R2 之外的第二类膨胀源。

| 门 | 判据 | 挡住的事 |
|---|---|---|
| 上限 | `size(resources/agent-host) ≤ agentHostCeiling(key)` | R2 多平台变体陪跑（一个变体 = +347MB，必然击穿 15% 余量）；上游意外膨胀 |
| 下限 | `size(resources/agent-host) ≥ agentHostFloor(key)` | **codex 整个没打进去**（开发机/CI 有全局 codex 兜底，只有用户机会红） |
| 单文件下限 | `size(vendor/<T>/bin/<B>) ≥ CODEX_BINARY_FLOOR` | 截断 / LFS 指针 / 占位文件 |

**A0 / P 的取值规则（不许拍脑袋，且量纲钉死 `[bytes]`）**：

- `A0` = **本批施工前**该平台 `out-agent-host/` 的 **`dirSize()` 字节**。linux-x64 已实测 = **42,788,670 B**（`du -sh` 的 51M 是块占用，**不得用作 A0**——两者差 ~19%，§0.3 量纲纪律）；win32-x64 **必须从首个 Windows CI 跑取**：为此把 `[build-agent-host] OK` 行（`:245-249`）的输出**从 `<mb>MB` 改为同时打印精确字节**，否则 MB 取整后回填进预算会引入 0.5MB 级的假余量。
- `P` = codex 进包后的**有效负载字节**（主包 + 当前平台包，减去被 prune 规则丢弃的文件）。linux-x64 已实测 = **363,716,282 B**（推导见 §0.3-E 末行）。**注意与 §0.3-A 的两个数区分**：363,710,778 是平台包八文件全量，363,707,964 是平台包减 README，`P` 还要再加主包的 8,318 B。
- `h₁/h₂` 见上（工程判据）。**实现方可否决**：若首个 CI 跑就贴近上限，按分项调整并记录理由（不许两项一起放大）。
- **门禁失败必须打 breakdown**：按目录聚合的 top-10（复用既有 `dirSize` `:65-73`）。只报「超了 12MB」而不说是谁涨的，等于没有门禁。

**次门禁（松，只挡整体失控）**：`size(appDir) ≤ 2 × (基线 appDir + P)`。基线 linux-unpacked = 413 MB `[实测]`。这条**不参与红灯统计**（只 `console.warn`），因为 Electron/monaco 等与本批无关的体积波动不该让打包链红。**实现方可否决**：若评审认为 warn 级别没有咬合力，升为硬门禁并给出各自的余量档。

---

## §7 断言清单

> 命名：A* = P1 · B* = P2 · C* = P3 · D* = P4。**每条都标「谁是生产者」**（§10 空壳自查的输入）。

### 7.1 P1

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| A1 | `codexPlatformPkgDirName/codexTargetTriple/codexBinaryName` 六平台真值表全等上游 `PLATFORM_PACKAGE_BY_TARGET` | 纯函数单测（`scripts/__tests__/codex-platform.test.mjs`） | `scripts/codex-platform.mjs` |
| A2 | `isForeignCodexPlatformPath` 真值表：**hoisted 外平台** `@openai/codex-darwin-arm64/vendor/x` → true；**nested 外平台** `@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/x` → true；当前平台两种布局 → false；`@openai/codex/bin/codex.js` → false；`@openai/codexfoo/x` → false | 纯函数真值表，**期望值手写字面量**（§3.2 断言纪律） | 同上 |
| A2b | `codexPlatformPkgCandidates('win32','x64')` **逐字全等** `['@openai/codex-win32-x64', '@openai/codex/node_modules/@openai/codex-win32-x64']`；`linux/x64` 同形 | 纯函数字面量比对（**禁止用被测函数生成期望值**） | 同上。**这条专杀 rev.1 的双重 scope 缺陷（B-2）** |
| A2c | `CODEX_SHIPPED_PLATFORMS` 与 `NODE_RUNTIME_PINS` 的 key 集合**全等**；`isCodexShippedPlatform('darwin','arm64') === false` | 纯函数 | `codex-platform.mjs` + `node-runtime-pin.mjs`（另见 C9） |
| A3 | preflight 五条各一例红臂（缺平台包 / 别名 version 不符 / manifest target 不符 / 二进制过小 / 外平台残留），断言 `process.exit(1)` 与错误文案关键词 | 用临时目录构造假 `node_modules` 后调 preflight（把 preflight 拆成可注入 root 的函数） | `build-agent-host.mjs` |
| A4 | `verifyArtifact` 的 mustExist 八条 + mustNotExist 十一条**逐条**有对应红臂 | 同上（构造缺失/多余产物） | `build-agent-host.mjs` |
| A5 | **exec 位断言**：非 win32 下把入口二进制 `chmod 644` 后 preflight 必红 | 构造 | `build-agent-host.mjs` |
| A6 | `external` **恰为两项且逐元素全等** `['@anthropic-ai/claude-agent-sdk','@cometix/claude-code']` | **把 external 数组提进 `agent-host-build-lib.mjs` 作为导出常量，直接 `toEqual` 单测**（首选）；退而求其次才做源码扫描，且必须**捕获数组字面量后断言 `length === 2` + 元素全等**。**禁止用 `toContain('@cometix')` 这类子串断言** —— rev.1 的写法在「多加了一项 codex」时**恒真不红**（A-M2） | `build-agent-host.mjs:113` |
| A7 | 真产物验收：`pnpm build:agent-host` 后 `out-agent-host/node_modules/@openai/codex/bin/codex.js` 存在、平台包 manifest 匹配、外平台零命中 | 本机实跑（P1 收口证据，非 vitest） | 构建链 |
| A8 | `src/agent-host/package-lock.json` 含**六条** `node_modules/@openai/codex-<key>`，各带 `optional:true` + `os`/`cpu` + `version:"0.145.0-<key>"` | 解析 lock 的纯单测（**期望 key 列表手写字面量**） | `package-lock.json`（改判 ⑨） |
| A9 | **白名单臂**：`platform='darwin'` 时 `shouldCopy('@openai/codex/bin/codex.js') === false`；preflight 走 skip 分支且不抛；`verifyArtifact` 断言 `node_modules/@openai` 不存在 | 纯函数 + 构造式（注入 platform） | `agent-host-build-lib.mjs`（改判 ⑧） |

### 7.2 P2

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| B1 | `deriveBundledCodexJsPath('/opt/app/resources/agent-host/index.js')` === `/opt/app/resources/agent-host/node_modules/@openai/codex/bin/codex.js`；dev 形态同理 | 纯函数 | `hostEnv.ts` 旁 |
| B2 | 该函数返回值 basename 恒为 `codex.js`（REQ-8 可执行版） | 纯函数（含 win32 分隔符臂） | 同上 |
| B3 | `buildAgentHostEnv({…, codexJsPath:'X'})` 含 `AICLIENT_CODEX_JS_PATH:'X'`；`codexJsPath: undefined` 时**该键不是自有属性**（`Object.keys(...)` 不含它） | 单测（**必须用 `Object.keys` 而不是 `toEqual`**——`toEqual` 忽略 undefined 值，写成 `toEqual` 这条断言就是空壳） | `hostEnv.ts` |
| B4 | 三臂矩阵：用户 env 已设 → 不注入；未设 + 文件在 → 注入；未设 + 文件不在 → 不注入 | **`vi.mock('electron')` + 动态 `await import(...)` 的仓内既有范式**（`AgentInstaller.test.ts:97`/`:110` 的 `const { X } = await import('../X')` 同形；`AgentHostManager` 直接 import `electron` 的 `app`，静态 import 会在 node 环境炸）。三臂各一例，`existsSync`/`env` 走注入或 `vi.spyOn` | `AgentHostManager.ts` |
| B5 | **接缝断言**：`AgentHostManager` 确实把推导结果喂给了 `buildAgentHostEnv` | **首选行为臂**：调用真实 `startInternal` 路径（mock 掉 spawn）后断言传给 `buildAgentHostEnv` 的入参含推导值。**若保留源码扫描**（范式照 `hostEnv.test.ts:128`），必须扫**三判据合并后的整条表达式**（白名单/existsSync/用户 env 三者）而不是只扫函数名 —— 否则 M7 变异（删掉「用户 env 已设则不注入」）**咬不住**（A-M3） | `AgentHostManager.ts:647-656` |
| B6 | 平台闸：非 win32 下**五个写侧入口**各一例 —— `installGit`/`installNode`/`installAgent`/`downgradeClaudeToNodeVersion` **抛**且信息含 `Windows-only`；`installAll` **不抛**、返回 `{success:false, errors:[含 Windows-only]}` | 单测（`process.platform` 打桩，同 `AgentInstaller.test.ts` 既有范式） | `AgentInstaller.ts:237/284/340/392/411`（改判 ⑥） |
| B7 | **负控**：非 win32 下 `checkPrerequisites()` **不抛**（回归钉住 §0.2-⑥） | 单测 | `AgentInstaller.ts` |
| B8 | `codexNodeEntry.ts` 本批零改动 | git diff 断言 / 源码哈希（收口检查项，非 vitest） | — |

### 7.3 P3

| # | 断言 | 形状 | 生产者 |
|---|---|---|---|
| C1 | `nodeRuntimePinFor` 真值表：`win32/x64`→win-x64 pin；`linux/x64`→linux-x64 pin；`darwin/arm64`→`undefined` | 纯函数单测 | `node-runtime-pin.mjs` |
| C2 | 两个 pin 的 `sha256` 均为 64 位十六进制、`archiveName` 与 `version` 一致（形状自洽，**不校验哈希内容**） | 纯函数单测 | 同上 |
| C3 | `fetch-node-runtime --platform darwin-arm64` → 退出码 0 且 stdout 含 skip 提示（护住 `pnpm build:mac`） | 脚本实跑（无网络） | `fetch-node-runtime.mjs` |
| C4 | `electron-builder.yml` 的 **`files:` 段内不含任何以 `@openai` 开头的排除项**，且全文不含 `!node_modules/@openai/codex/vendor/**` 这条规则行 | 形状扫描单测（按 `files:` 段解析后判定；注释行不参与，与 §5.1-2 的注释禁令互补而非互斥，A-m5） | `electron-builder.yml` |
| C9 | `CODEX_SHIPPED_PLATFORMS` 与 `NODE_RUNTIME_PINS` 的 key 集合全等（两表互钉） | 纯函数单测（同 A2c，跨模块断言） | `codex-platform.mjs` + `node-runtime-pin.mjs` |
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
| D6 | 体积门禁**四点真值表**：`floor-1` → 红 · `floor` → 绿 · `ceiling` → 绿 · `ceiling+1` → 红（边界含端，逐点断言）；单文件下限同样四点 | 纯函数单测（`packaging-budget.test.mjs`）+ 至少一例构造目录实跑 | `scripts/packaging-budget.mjs`（B-13） |
| D9 | 随包 launcher 判定用 **`statSync(p).isFile()`** 而非 `existsSync`：负臂 ① 同名**目录** `…/bin/codex.js/` → 判否；② 长度为 0 的空文件 → 判否 | 纯函数 + 构造式（Main 侧 §4.2 的注入判据同款改造） | `verify-packaged-app.mjs` + `AgentHostManager.ts`（B-8） |
| D7 | 门禁红时输出含 top-10 breakdown | 构造实跑，断言 stdout | `verify-packaged-app.mjs` |
| D8 | **负控（空壳克星）**：往打包产物里**塞一个假的** `@openai/codex-darwin-arm64/` 目录后，verify 必红且指名该目录 | 构造实跑 | 同上 |

---

## §8 Happy Path（每片一条，供规范第 3 条引用）

- **P1**：`src/agent-host` 内 `npm install`（含 optional）→ **lock 重生成并提交，六条 alias 齐全** → **干净目录双跑**：`rm -rf node_modules && npm ci`（含 optional，构建用）与 `rm -rf node_modules && npm ci --omit=optional`（门禁用，须实证 postinstall 不炸）→ 恢复完整安装 → `pnpm build:agent-host` → preflight 五条全过 → copy 后 `out-agent-host/node_modules/@openai/` 下**只有** `codex` 与当前平台包 → verifyArtifact 全绿 → OK 行打印 `codex 0.145.0/<key> <精确字节>B`。
- **P1-mac 臂**（非白名单平台，本机跑不到则在 as-built 标未验）：`platform='darwin'` 下 preflight 打 skip、产物中 `node_modules/@openai` 不存在、verifyArtifact 仍全绿。
- **P2**：packaged Windows 装机 → Host 启动 → 日志显示 `codex entry source=env` 且路径落在 `resources/agent-host/…/bin/codex.js` → `capabilities.agents` 含 codex → 新建 Codex 会话可发首条消息。
- **P3**：打 tag → `gate` 绿 → `build-app` → win/linux 双出包 → 两侧 `verify --skip-smoke` 全绿（Linux 的「Node 24 resolvable」由 **bundled** 满足）→ release 资产齐备。
- **P4**：CI 上 verify 打印 `resources/agent-host size: <X>MB`（在上下限之间）+ `codex-cli <pin>` + `initialize ok`；人为塞外平台目录后**立即红**。

---

## §9 测试与验证结构（规范 3/4/9/13 条）

**分层（本批的核心方法论：能纯化的纯化，纯不了的真跑，真跑不了的挂人工）**

| 层 | 覆盖对象 | 载体 | 为什么只能在这层 |
|---|---|---|---|
| **T1 纯单测** | 平台矩阵 / 路径推导 / 阈值公式 / pin 查表 / env 组装 | vitest：`scripts/__tests__/*.test.mjs`（入口已存在，§0.3-F）+ `src/main/**/__tests__/*.test.ts` | 无 IO、可穷举，是变异咬合力的主战场 |
| **T2 构造式脚本测试** | preflight / verifyArtifact / prune / 体积门禁的**红臂** | vitest 里建临时目录造假产物后 **import `scripts/agent-host-build-lib.mjs`** 调被测函数 | 需要文件系统，但不需要真依赖；**前提是抽出纯模块**（见下，改判 ②） |
| **T3 CI 真跑断言** | 真 `npm ci` 布局、真出包、真 verify、缓存/磁盘/时长 | GitHub Actions | 只有真装真打才有真布局（hoist 与否、exec 位、win 变体形状） |
| **T4 加密机实测（用户线）** | R1：TSD 环境下 296MiB 二进制是否被改写、能否 spawn | 人工：取 `windows-unpacked` 工件（`build.yml:160-167` 已有该上传步骤）→ 加密机跑 `verify-packaged-app.mjs --app-dir <dir>` | 我们没有 TSD 机器，且这是 R1 唯一的闭合手段 |
| **T5 零额度探针** | Codex 握手 S2 | CI 内 verify 的一段（先观察后转门禁） | 需要真二进制 + 真进程链 |

**必须的重构动作（一次，P1 做）—— 抽 `scripts/agent-host-build-lib.mjs`（改判 ②，rev.2 定稿）**

rev.1 写的是「把 `build-agent-host.mjs` 里的三个函数改成可注入并导出」，**这条在本仓行不通**：该文件末尾是**顶层 `await main()`**（`:311` `[读码]`），而 `main()` 的第 3-4 行就是 `fs.rmSync(outDir, {recursive:true, force:true})` + `mkdirSync`（`:296-297`），`fail()` 又是 `process.exit(1)`（`:32-35`）。⇒ **测试只要 `import` 它，就会当场删掉开发者的 `out-agent-host/`，并可能让 vitest 进程直接退出**（`process.exit` 在 vitest worker 里会终止整个 run，是「一测毁一屋」级别的事故）。

定稿形状：

| 文件 | 内容 | 纪律 |
|---|---|---|
| **`scripts/agent-host-build-lib.mjs`**（新，被测面） | `preflightHostDeps({root, platform, arch})` · `shouldCopy(rel, {platform, arch})` · `verifyArtifact({outDir, platform, arch, pins})` · `pruneResidualPlatformPackages({outDir, platform, arch})` · `ESBUILD_EXTERNAL` 常量（A6） | **零副作用**：不 `rmSync`、不 `mkdir`、**不 `process.exit`**；失败一律 `throw` 或返回 `{ok:false, failures:[]}`。**模块顶层不得有任何语句执行**（无顶层 `await`、无自跑） |
| `scripts/build-agent-host.mjs`（保留，CLI 外壳） | `import` 上面的库 + 既有 `main()`（rmSync/mkdir/bundle/copy/tsdFix）+ 顶层 `await main()` + 把库的失败转成 `fail()`/`process.exit(1)` | 外壳里**不留判定逻辑**，只留编排与 IO |
| `scripts/__tests__/agent-host-build-lib.test.mjs`（新） | T1/T2 全部用例 | **只 import 库，永不 import CLI 外壳**（一条静态断言钉住：测试文件里不得出现 `build-agent-host.mjs` 字样） |

理由与 D48 §3.3 提取 `computeEverHostBound` 同构：不提取就只能靠 CI 真跑兜底，而 CI 真跑**一次 20 分钟且只覆盖当前平台的一条臂**。
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
| M13 | `codexPlatformPkgCandidates` 改回「叶名带 scope + 调用方再拼 scope」 | A2b 逐字真值表 | 双重 scope 缺陷复活（B-2 的原缺陷） |
| M14 | `shouldCopy` 去掉白名单闸（退回按当前平台取包） | A9 mac 臂 | mac 公证链会被塞进 347MB 未签名 Mach-O（改判 ⑧） |
| M15 | `installAll` 的平台闸改成 `throw`（放到 `try` 外） | B6 的 `installAll` 臂 | `InstallResult` 契约被破坏，renderer 拿到未分类 IPC 错误 |
| M16 | `checkNodeRuntime` 的 bundled 硬断言改回并进 `node24 \|\| bundled` | C7（Linux 侧）+ 一条构造臂（删掉 bundled 后必红） | 改判 ④ 的覆盖力归零，坏 bundled 被 runner node 掩护 |
| M17 | `usable()` 退回 `existsSync` | D9 两条负臂 | 同名目录/空文件被当成可用 launcher |
| M18 | 体积门禁公式合并余量（退回 `(A0+P)×1.15`） | D6 的 `ceiling`/`ceiling+1` 两点（用 A0 超标而 P 正常的构造值） | 分项分辨率丢失（改判 ⑩） |

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
| 「Windows 平台包的 vendor 布局与 linux 同形」**+「`codex.exe` ≥ 200 MiB」** | **零证据**（本机只有 linux-x64） | **统一归入 Q1 两步走**：mustExist 第 7/8 条改为**读上游 manifest 的 `pathDir`/`resourcesDir`** 而非硬编码目录名；首个 win CI 跑 `continue-on-error` 打印平台包文件清单与各文件字节 → 回填进本节与 `CODEX_BINARY_FLOOR` → 第二跑转硬门禁 |
| 「`pathsEqual` 的路径比较对目标平台正确」 | `NodeRuntimeResolver` 的 `pathsEqual`/`path.normalize`（`:62-65`）用的是 **`node:path` 的宿主默认导出**，而该文件其它地方是靠 `options.platform` 描述目标平台的 | **本批不改**（属 REQ-9 保护面），但登记：D36 后 Linux/Windows 两条 bundled 路径都要过这个比较，**若将来出现「同一路径被判成两个候选」的重复探测，先看这里**。与 `codexNodeEntry.ts:117-119` 的 `pathApi(platform)` 做法对照（那边是对的）——B-12 |
| 「`codex.js --version` 会输出 `codex-cli <ver>`」 | 本机 `[实测]`（经 shim，等价于 `node codex.js`） | D4 首跑即验证；若 win 上格式不同，按实测调整断言（**不许放宽成 includes**） |
| 「npmmirror 有 linux tar.gz 镜像」 | `[推测]`（按 win 条目形状外推） | `curl -I` 验活；不通就只留官方源 |
| 「GitHub runner 磁盘够 480MB 包」 | 无核算 | §5.7 的 `df -h` 前后两测 |

---

## §11 开放问题（待拍板，不混进正文）

| # | 议题 | 背景（为什么需要拍） | 建议 |
|---|---|---|---|
| **Q1** | **Windows 侧零证据项的统一处置**（rev.2 扩围）：① mustExist 第 3/7/8 条依赖的 `codex-package.json` / `pathDir` / `resourcesDir`；② **`CODEX_BINARY_FLOOR = 200 MiB` 对 `codex.exe` 是否成立**；③ `codex.exe --version` 的输出格式；④ win 侧 `A0`/`P` 预算基数 | 本机只有 linux-x64；任一条猜错都会让首个 Windows CI 红在 preflight/门禁，而不是红在真缺陷上 | 全部接受「首跑 `continue-on-error` 观察 → 回填清单与常量 → 第二跑转硬门禁」的两步走 |
| **Q2** | **体积余量 `headroom = 0.15`** 与「次门禁只 warn」两个档位 | 这是工程判据不是实测；太松等于没门禁，太紧会因上游正常增长频繁误红 | 首跑后按实际余量确认；次门禁维持 warn |
| **Q3** | **要不要在 CI 跑一次 Codex 真回合 smoke** | 现有 Claude 线 smoke 用测试网关凭据（`testCredentials.ts`）；Codex 侧等价物需要 cch 凭据与额度，触发铁律「事前报量」 | **不做**，S3 归手工/加密机点验；若要做须先报量并单独拍板 |
| **Q4** | **`codex-code-mode-host` 保留 = +44 MiB** | 本规格 §3.5 裁定保留并给了反证条件 | 接受保留；省它另立票（需先有「不下发 code_mode_only 模型」的实证） |
| **Q5** | **mac 线的既定形态**（rev.2 改写：从「破口」改为「显式设计」） | 改判 ⑧ 之后，mac 上是**三件同时成立**：① `fetch:node-runtime` 跳过（无 pin）；② **codex 整包不进产物**（白名单闸，防 347MB 未签名 Mach-O 进 `hardenedRuntime`+`notarize` 链）；③ `AgentInstaller` 五个写侧入口被平台闸挡住 ⇒ **mac 用户必须自己 `npm i -g @openai/codex`**，且 app 内没有任何引导 | 接受（D52-② 的直接后果），写进 mac 票的已知内容；**若认为「mac 用户完全无引导」不可接受，请拍板是否在本批补一条 mac 专属提示文案**（改动面小，但会牵动 onboarding golden-diff 测试面） |
| **Q6** | **门禁只在出包时跑**：`build.yml` 的触发器是 `push: tags` + `workflow_dispatch`（`:3-7`），D41 的 gate 挂在同一 workflow ⇒ 合入 main 时不跑，打 tag 才发现红 | D41 原文只说「打包前置」，没说 PR 门禁；补 `on: pull_request` 属新增 workflow，超出本批范围 | 本批按 D41 原文只做打包前置；**是否另立 `ci.yml` 跑 PR 门禁**请拍板 |
| **Q7** | **codex 0.147.0 升级票排期** | 在野已有更新版本（deepseek 研究档的证据 pin）；升级须走「blessing 重跑 + 契约快照 diff + 夹具复核」三件套 | 本批不做；升级票排在 2b 收官后、flag 转 on 之前或之后由用户定 |
| **Q8** | **`compression: maximum` 是否降档** | 新增 ~347MB 未压缩二进制，`maximum`（xz 极限档）可能让单步出包时间翻倍；连带 NSIS `differentialPackage: true`（`electron-builder.yml:207`）的 blockmap 生成 | 首跑实测；单步超过告警值（40 min，**可调告警值非硬门**）则提交降到 `normal` 的拍板（代价 = 安装包变大） |
| **Q9**（rev.2 新增） | **`AgentInstaller.refreshPath()`(:218) 要不要加平台闸** | 它同样是 Windows 味（读注册表/刷新 PATH），但被 `installAll`/`installAgent` **内部**调用（`:254/:273/:301/:331/:367/:406`），也可能被将来的探测链复用。加闸位置错一次就重演「Linux onboarding 直接炸」（改判 ⑥ 的教训） | **本批不加闸**（写侧五入口已在更外层拦住）；是否单独加、以及加成 throw 还是 no-op，请拍板或另立票 |
| **Q10**（rev.2 新增） | **面向 GUI 用户的 codex 路径逃生口** | `AICLIENT_CODEX_JS_PATH` 只在终端启动/系统级环境变量下可达（改判 ③）；GUI 常规启动的用户在随包 codex 损坏时**没有任何自救手段**（只能重装） | 建议**另立票**做 settings 显式路径项（与 `AICLIENT_NODE24_PATH` 的 settings 化诉求同族），本批不做 |

---

## §12 溯源

- **上游**：[S3 切片 2 仲裁档](./2026-08-09-s3-slice2-arbitration.md)（§0-① 随包裁定 + C-a/C-b）· [阶段 4 立项调查档](./2026-08-19-stage4-packaging-kickoff.md)（REQ-1~15 / R1~R6 / D52）· [S1 spike 报告](./2026-08-06-s1-acp-codex-spike-report.md)（体积与进程链实测）· 总台账 D36/D41 · [S6 adoption spec](./2026-08-15-d47-s6-adoption-spec.md) L115（投影链退役批归口，本批只登记不施工）。
- **章法参照**：[D48 施工规格](./2026-08-16-d48-agent-picker-spec.md)（目标/红线/逐切片契约/断言清单/测试与变异计划/开放问题）。
- **本批新实测**（2026-08-19，rev.1 锚 `aa016b9` / **rev.2 复核锚 `99dfd78`**，Linux x64 / node v24.18.0 / codex-cli 0.145.0）：§0.3 A~F 六组，全部可复现（命令见各条）。

---

## §13 rev.1 → rev.2 修订记录

> 双轨双盲评审总判均「须改后再审」，编排者合取后下达 8 blocker + 12 major + 9 minor。逐条去向如下（A-* = Opus 轨，B-* = Codex 轨）。

### Blocker（8）

| # | 来源 | 问题 | 去向 |
|---|---|---|---|
| 1 | A-B1 ≡ B-4 | `ensureNode` 虚构符号 | **§4.3 全表重写**：五个实存写侧入口（:237/:284/:340/:392/:411）+ 逐入口非 Windows 行为臂；`installAll` 走 `{success:false}` 而非 throw；`refreshPath` 标 Q9。§0.2-⑥、§7.2-B6、M15 同步 |
| 2 | A-B2 ≡ B-3 | 顶层 `await main()` + `process.exit` ⇒ 测试 import 即删产物 | **§9 定稿抽 `scripts/agent-host-build-lib.mjs`**（零副作用、不 exit、顶层无语句），CLI 外壳保留 `main()`；T2 层全部改为 import 纯模块；测试禁 import 外壳 |
| 3 | B-2 | `codexPlatformPkgCandidates` 双重 scope | **§3.2 命名契约改写**：`codexPlatformPkgLeafName()` 只返回叶名，scope 由调用方拼，候选表写成逐字常量；新增 **A2b 逐字真值表** + 断言纪律「禁止同一函数生成 fixture 与期望值」；变异 M13 |
| 4 | A-B3 | mac 会把 347MB 未签名 Mach-O 送进公证链 | **改判 ⑧**：`CODEX_SHIPPED_PLATFORMS` 白名单；preflight 第 0 步跳过、`shouldCopy` 整段 false、verify 断 `@openai` 不存在；§4.4-3、§11-Q5 改写；新增 A9、M14 |
| 5 | A-B4 | 删 CI 步骤 ≠ 断言（OR 可被 runner 残留 v24 掩护） | **改判 ④**：`checkNodeRuntime` 加独立硬断言（有 pin ⇒ bundled 必须非空可执行且版本等于 pin），不参与 OR；删步骤降为次要；新增 M16 |
| 6 | A-M8 ≡ B-1（升 blocker） | 漏 `package-lock.json` | **改判 ⑨** + §2 P1 改动面 + §3.1 新增「lockfile 纪律」段（npm 版本对齐 / 六条 alias 校验 / 双跑）+ §8-P1 Happy Path + 断言 A8 |
| 7 | B-5 ≡ A-M1 | §0.3-A 实测表三处错 | 主包 `package.json` **1,082 B**；平台包八文件合计 **363,710,778 B**，363,707,964 重定义为「减 README 的有效负载」；`P` 口径在 §0.3-E 与 §6.3 双处钉死为 **363,716,282 B**；「vendor 全 0775」改为「可执行件 0775 / 清单元文件 0664」，exec 位断言限定入口二进制 |
| 8 | B-6 ≡ A-①/m4 | 引用重锚 | grep **25 处**（零 import 结论不变）；`dist:prereq` = `package.json:23`；`differentialPackage` = `electron-builder.yml:207`；codex.js spawn = `:195`；§5.6 checkout = `build.yml:17-18`；文档头锚改 **99dfd78** |

### Major（12）

| # | 来源 | 去向 |
|---|---|---|
| 9 | B-7 vs A-② 分歧裁定 | code-mode-host **保留裁定维持**，证据等级降为 `[推测/保守决策]`；§3.5 重写（已证/未证/为什么仍保留 + 施工时闭合动作 + 三条去向）；§0.2-② 同步 |
| 10 | A-M2 | §7.1-A6 改为「external 提纯模块 `toEqual`」，退路才是扫描且须捕获数组断长度与元素；明禁 `toContain` |
| 11 | A-M3 | §7.2-B4 明写 `vi.mock('electron')` + 动态 import；B5 首选行为臂，保留扫描则须扫三判据合并表达式（否则 M7 咬不住） |
| 12 | A-M4 | §5.4 新增「Linux 存量用户 runtime 静默切换」风险段：`probeNodeBinary` 静默跳过坏 bundled；发现面 = 改动 5 的硬断言；无 flag，回退 = revert 独立小 commit |
| 13 | A-M5 | §6.3 公式改分项 `A0×(1+h₁) + P×(1+h₂)`（0.10 / 0.15）+ 说理 + 备选方案（P 交给清单断言）与取舍；改判 ⑩ |
| 14 | A-M6 | 文档头新增**量纲纪律**（`[du]` vs `[bytes]`，实测差 ~19%）；§0.3-E 全表标注；A0/P 钉死 `dirSize()` 口径；要求 OK 行打印精确字节 |
| 15 | A-M7 | §6.2 新增「挂载点与 runtime 选择」：`checkNodeRuntime` 之后、`--skip-smoke` 之前；有 pin 平台拿不到 runtime **按红计**，禁继承 `:340` 恒真 skip |
| 16 | B-8 | §4.2 判据与 §7.4-D9 改 `statSync().isFile() && size>0`，补目录/空文件负臂；变异 M17 |
| 17 | B-10 | §6.2 新增「S1/S2 进程纪律」：双超时（响应/退出）、NDJSON 字节与行数上限、失败终止**进程树**（三级链，禁照抄无上限累加） |
| 18 | B-11 ≡ A-§5.7 | §5.7 顶部加常量定性：2GB/5GB/40min 均为**首跑基线前的可调告警值**，非验收硬门；基线回填前只记录不判红 |
| 19 | A-M9 | 改判 ③ 加 GUI 不继承 shell env 的限定；§4.2 表与 §4.4-2 Happy Path 同步；settings 真逃生口 → 新增 §11-Q10 |
| 20 | B-9 ≡ A-m3 ≡ Q1 | §11-Q1 扩围为 Windows 侧零证据四项（含 `CODEX_BINARY_FLOOR`、`--version` 格式、win 预算基数），统一两步走；§3.3-4 与 §10.3 同步指向 Q1 |

### Minor（9，全收）

| 来源 | 去向 |
|---|---|
| A-m1 | §3.6 mustNotExist 计数改 **12 条**（含新增第 12 条非白名单平台臂），并给出「12 条 / 13 个 check」的计数口径 |
| A-m2 | mustNotExist 第 10 条由 `.bin/codex` 改为 `node_modules/.bin` **整目录**，与 `verify-packaged-app.mjs:127` 层级对齐 |
| A-m5 | §5.1-2 加注释措辞禁令（可写「Codex」，禁写完整包名）；§7.3-C4 收窄为 `files:` 段形状断言，两者互补 |
| A-m6 | §5.6 新增：本批新增/改动缓存步骤统一 `actions/cache@v5`，并把 `build.yml:130` 的 `@v4` 一并升级 |
| A-m7 | §5.6 新增 as-built 观测项：`gate` 与 `build-app` 两次 `pnpm install` 的时长与缓存命中；不合并作业，超时长作为后续优化票输入 |
| A-m8 | §1.2 铁律新增：仓内 `npm ci` 只在 `src/agent-host/` 拉 pin 版，**绝不带 `-g`、绝不动全局 `lib/node_modules`** |
| B-12 | §10.3 信念表新增 `pathsEqual` 读宿主 platform 的注记（本批不改，属 REQ-9 保护面，登记为排障线索） |
| B-13 | §7.4-D6 改为**四点真值表**（floor-1 / floor / ceiling / ceiling+1），单文件下限同形；变异 M18 |
| — | 变异表由 12 臂扩至 **18 臂**（新增 M13~M18，逐条对应本轮改判） |

### 未采纳 / 降级处理

| 项 | 处置 |
|---|---|
| A-B4 的「删 `Setup Node.js 24` 步骤」 | **降为次要**（仍建议删，但覆盖力改由硬断言承担）——删步骤本身不构成断言，理由见改判 ④ |
| B-7 的「prune code-mode-host」 | **不采纳**（保守方向维持保留），但证据等级下调 + 施工时闭合动作 + 失败即另立 prune 票，见改判 ② |

### 可采信免重验（A 轨复核成立，rev.2 未改动）

§3.1 三处 pin 依据 · §3.5 三条证据的存在性 · §6.2-S2 的 e4 依据 · §0.3-B（`codex.js` 的 `require.resolve` 解析链）· ELF 魔数 · `codex-package.json` 七字段 · `--version` 输出 · §5.1/§5.4/§10.1 全段 · `build-agent-host.mjs` 全部行号。

## §14 拍板收口（2026-08-19，D54）

§11 十项去向：Q1/Q2/Q8 = 首跑观察项（continue-on-error → 回填 → 转硬门禁）；Q3 = 不做 CI 真回合 smoke（cch 事前报量铁律，S3 归手工/加密机点验）；Q4 = 保留 code-mode-host（§0.2-② 保守决策，施工时进程树闭合因果）；Q5 = mac 显式设计形态成立（提示文案随 mac 票）；**Q6 = PR 级门禁另立票后做（用户拍板）**；**Q7 = 升级票排 2b 收官后、flag 转 on 前（用户拍板）**；Q9 = refreshPath 本批不加闸；Q10 = GUI 逃生口另立 settings 票。**本规格就此定稿，P1 开工。**
