# 阶段 4「2b 打包链」立项调查（2026-08-19）

> 编排者三路并行调查（构建脚本链 / electron-builder+CI / 文档需求汇总，sonnet ×3，292k tokens）合流产物。
> 状态：**已立项（D52，2026-08-19 当场问答收口）**。进入规格阶段（双轨双盲评审，工法同 D47/D48）。
> 排期依据：plantree multi-agent 行阶段顺序 3（D48 收官 2026-08-17）→ 3b（线协议小批 `55b45b1`）→ **4 = 本批**。
> 旧后置理由「Codex 尚未到可用程度，无即时收益」已消除：D47 登录 + D48 picker 均收官，Codex 已到可用形态。

## 1. 已拍板的输入（不再重议）

| # | 拍板 | 日期 | 来源 |
|---|---|---|---|
| REQ-1 | **Codex 随 Agent Host 打包**，不走「依赖用户全局 npm 装」 | 2026-08-09 | [仲裁档 §0](2026-08-09-s3-slice2-arbitration.md) |
| REQ-2 | **体积可接受**：141MB → 约 480MB（3.4×）；codex 平台包单文件 296MiB（磁盘体积，勿混淆为内存——RSS 实测 124MiB，见 open-q #8 存根） | 2026-08-10 | roadmap 阶段表 + 仲裁档实测（`codex-linux-x64` 平台包 347MB；`vendor/…/bin/codex` 310,730,800 字节） |
| REQ-8 | **spawn 恒为 `node <codex.js> app-server`**，绝不回落原生二进制 / PATH `codex` | 2026-08-09 | 仲裁档 §1 第 5 条（用户约束「得用 node 版本」） |
| REQ-9 | **Node runtime resolver 优先级顺序不许被 2b 擅自改**（explicit→env→bundled→extra→nvm/fnm/volta→PATH；「坏的 bundled 可被 env 覆盖」是逃生口）；Codex 复用 Main 已解析结果 | 2026-08-09 | 仲裁档 C-a |
| D36 | **Linux 包捆随包 Node**，口径与 Windows 一致（pin `24.18.0` + SHA256；verify「Node 24 resolvable」转绿） | 2026-08-15 | [总台账 D36](openchamber-chat-refactor-ledger.md)；**已拍板未施工**（转施工票「择机」） |
| D41 | **build.yml 打包前置 lint + typecheck + vitest 作业**（Linux runner，失败阻断出包；Windows 不重复跑） | 2026-08-15 | 总台账 D41；**已拍板未施工**（本次核验：`build-app` 作业只跑 `pnpm build`，无三门） |

## 2. 现状盘点（2026-08-19 三路实测，file:line）

### 2.1 构建链四阶段齐备（无 Codex 意识）

`scripts/build-agent-host.mjs`（311 行）：preflight（`:44-92`，只 pin `@cometix/claude-code` + `@anthropic-ai/claude-agent-sdk`）→ esbuild bundle（`:98-115`，`external` 只列这两包）→ copy-prune（`:120-205` 手写递归复制避 Windows cpSync filter bug；`@img/sharp-<platform>-<arch>`、node-pty prebuilds 已有按平台过滤先例 `:128-174`）→ verifyArtifact（`:220-250` mustExist/mustNotExist）。产物 `out-agent-host/` 由 `scripts/afterPack.mjs` copyAgentHost()（`:45-56`）整树拷入 `resources/agent-host`——**刻意绕开 extraResources**（`:37-43`：extraResources 静默剥 node_modules + Windows 上与 rcedit 竞态）。

### 2.2 Codex 今天完全不进包

- 依赖零声明：root 与 `src/agent-host/` 两级 package.json、pnpm-lock 全无 `@openai/codex`；node_modules 无此包。
- 运行时靠用户机解析：`codexNodeEntry.ts` resolveCodexLaunch()（`:268-345`）搜 PATH / node 兄弟目录找全局 npm 装的 `bin/codex.js`；`AgentInstaller.ts:340-365` 的 `npm install -g @openai/codex` 是用户机 onboarding 动作（Windows 味重但**无 win32 平台闸**——隐患见 §5-R5）。
- `electron-builder.yml:47-49` 的 `!node_modules/@openai/codex/vendor/**` 排除规则是**死代码**（针对从不存在的依赖），注释「we use system-installed CLIs」与 REQ-1 随包裁定直接矛盾——须随批改掉。
- **天然接线口已存在**：`codexNodeEntry.ts:100` 已有 `AICLIENT_CODEX_JS_PATH` env-override 候选（CODEX_JS_PATH_ENV）。Main 侧 `hostEnv.ts:66`（buildAgentHostEnv，现注入 `AICLIENT_NODE_EXEC_PATH`）补一个指向随包 codex.js 的注入即通——**不必新增候选规则，也不触碰 REQ-9 的 resolver 顺序**。

### 2.3 Node 运行时随包 = win-x64 only

`node-runtime-pin.mjs:2-12` 单平台 pin（win-x64 24.18.0 + SHA256 + 双下载源）；`fetch-node-runtime.mjs` 无平台分支；`afterPack.mjs:64-81` copyNodeRuntime() 明闸 `!== 'win32'` return。`build.yml:231-233` 注释明言 Linux 不捆（C-15 win-only）。`build-remote-runtime-bundle.mjs` 是远程 SSH 运行时的 Linux tarball，与桌面包无关。

### 2.4 CI 现状

作业：`build-app`（只 `pnpm build`）→ `build-windows`（agent-host npm ci + build + fetch-node-runtime + electron-builder + verify --skip-smoke）/ `build-linux`（同前但**无** node-runtime fetch）/ `build-remote-runtime-linux` / `generate-release-notes`。**无 macOS 作业**（electron-builder.yml 配齐 mac dmg/zip + notarize 但 CI 从未出过 mac 包，仅本地 `build:mac` 脚本）。`compression: maximum` 已开；**无任何总体积门禁**；runner 磁盘/超时余量对 +300MB 无核算。

### 2.5 构建脚本零单测

`scripts/__tests__/` 仅一个无关文件（credential-env-keys）。构建链正确性只靠 CI 真跑兜底。

## 3. 需求清单（除 §1 已拍板项外）

| # | 需求 | 来源 | 现状 |
|---|---|---|---|
| REQ-3 | `src/agent-host/package.json` 加 `@openai/codex` 精确 pin | 仲裁档 §3 切片表 | 未开工 |
| REQ-4 | `build-agent-host.mjs` 整条改造（preflight pin 校验 / copy-prune 按平台留一 / mustExist·mustNotExist）；**esbuild `external` 是否需加待规格核实**——codex 是 spawn 的 CLI 不是 import 依赖，仲裁档 C-b「整条都要改」的 external 半句可能不适用 | 仲裁档 C-b | 未开工 |
| REQ-5 | `electron-builder.yml` 死排除规则与「system-installed CLIs」注释改掉 | 仲裁档 L19 | 未开工 |
| REQ-6 | `verify-packaged-app.mjs` 补 Codex 断言（结构 + smoke） | 仲裁档 §3 表 | 未开工 |
| REQ-7 | CI 作业体积与缓存（npm ci 拉 347MB 平台包的缓存策略、runner 磁盘、超时） | 仲裁档 §3 表 | 无设计 |
| REQ-14（新） | **总体积门禁**：verify 加包体阈值断言，防「误打多平台变体 / 44MiB `codex-code-mode-host` 陪跑」型静默膨胀 | 本次调查 gaps | 无 |
| REQ-15（新） | Main 侧 `hostEnv.ts` 注入 `AICLIENT_CODEX_JS_PATH` → 随包 codex.js（§2.2 接线口）；`AgentInstaller` 全局 npm 装降级为 fallback 路径 | 本次调查 | 无 |

## 4. 风险与疑点

- **R1 TSD 加密与 296MiB 原生二进制**：`afterPack.mjs` fixTsdEncryption（`:83-117`）只重写 `.js/.cjs/.mjs`，原生二进制不过重写路径——隐式正确但**从未在加密机上验证过这个体量**；verify 的 `%TSD` 头检查（verify-packaged-app.mjs:145-151）现只扫 agent-host 既有清单，须扩到 codex 二进制。规格阶段列为验证项（加密机实测半边挂用户线）。
- **R2 optionalDependencies 平台矩阵**：`@openai/codex` 以 optionalDependencies 分发六平台包，构建机 npm ci 只装本平台变体——CI win 作业天然装 win 变体、linux 作业装 linux 变体，与「按平台留一」的 prune 先例（sharp/node-pty）同构；但 **mustNotExist 必须断言其余五平台变体不在**，否则 480MB 变 2GB 是静默的。
- **R3 `codex-code-mode-host`（44MiB）取舍**：vendor 内第二颗二进制，用途待规格阶段查证（code-mode 特性我们不消费则 prune 掉）。
- **R4 投影链退役批不挂本批**（易误判）：其真实门槛 = **flag 默认转 on + flag-off fallback 退役之后**（S6 评审 b-track L697-711 推翻「S6 删」；归口 S6 adoption spec L115），2b 完工也不解锁。且 S34 规格四处旧归属（L44/91/142/164）未回改，形成两层嵌套过时——本批只登记不施工，时序链已在此写清：**2b 完工 → flag 转 on（发布决策）→ fallback 退役 → 投影链物理删除**。
- **R5 `AgentInstaller.installAgent()` 无平台闸**：Windows 味工具链（winget/PowerShell/msiexec）但无 `win32` guard，非 Windows 路径误调用属潜在缺陷；随包后该路径降级 fallback 时顺手加闸。
- **R6 编号勘误**：roadmap 阶段 4 行旧文「原 open-q #1（C-15 的 +21MB）一并关闭」系张冠李戴——open-questions #1 是「ACP vs 直连」（已升格 D45）；C-15 体积事项从未编号。已随本批修正 roadmap 措辞。

## 5. 切片草案（规格阶段定稿，须过双轨双盲）

| 切片 | 内容 | 依赖 |
|---|---|---|
| P1 | 依赖 pin + `build-agent-host.mjs` 四处（REQ-3/4）+ 本地产物验证 | — |
| P2 | 接线：hostEnv 注入 + codexNodeEntry 随包优先 + AgentInstaller 降级 fallback + 平台闸（REQ-15/R5） | P1 |
| P3 | electron-builder.yml + CI（REQ-5/7 + 视拍板并入 D36 Linux 捆 node、D41 前置门禁） | P1 |
| P4 | verifier：结构断言 + Codex smoke + 总体积门禁 + TSD 头扩扫（REQ-6/14/R1） | P1~P3 |

## 6. 溯源

- 三路调查原始结构化产物：会话 workflow `wf_761ed3a9-291`（journal 见会话 transcript 目录）。
- 上游：[2026-08-09-s3-slice2-arbitration.md](2026-08-09-s3-slice2-arbitration.md)（随包裁定 + C-a/C-b）· [总台账](openchamber-chat-refactor-ledger.md) D36/D41 · roadmap 阶段表 · [S6 adoption spec](2026-08-15-d47-s6-adoption-spec.md) L115（投影链退役批归口）。

## 7. 待拍板项（当场问答，答案回填此表）

| # | 议题 | 建议 | 拍板 |
|---|---|---|---|
| U1 | **D36（Linux 捆 node）与 D41（前置门禁）是否并入本批施工**：三者同在 build.yml/afterPack 一条链上，分批 = 三次动同一文件；并入则 P3 变重 | 并入（一条链一次施工，verify 转绿口径一并收） | **两项都并入**（D52 ①，2026-08-19） |
| U2 | **macOS 是否纳入本批**：现状无 mac CI 作业，codex mac 变体无处验证；纳入 = 新增 mac CI 作业（签名/公证成本）；不纳入 = mac 维持本地打包 + codex 走全局 npm fallback | 不纳入，另立票（本批交付 win/linux 口径一致） | **不纳入**：只做 win+linux（D52 ②，2026-08-19） |
