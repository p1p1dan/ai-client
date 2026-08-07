# 打包上加密机 —— 体检裁定（2026-08-06）

> 三路并发体检（打包链路 / 加密机前提 / 本轮改动与 Windows 测试）+ 编排者复核后定稿。
> 触发：用户 2026-08-06 问「现在的版本是不是可以打个包在加密机上测试一下功能了」。
> 相关：[T-10 打包版清单](./t10-packaged-gui-checklist.md) · 执行计划的 **T-11 / C-15 / D17**。
> 每条标 [实测] / [读码] / [推测]。

## 0. 编排者复核更正（2026-08-06）

**更正一处：本机 `node_modules` 不是「无效安装」，是「被 npm 装过的 pnpm 工程」。**

| 事实 | 证据 |
|---|---|
| `.npmrc` 写着 `node-linker=hoisted` —— **扁平 node_modules 本就是本工程的既定形态**，无 `.pnpm` 目录属正常 | `cat .npmrc` [实测] |
| 但 `.modules.yaml` **缺失**，且仓库根**同时存在** `package-lock.json`(458KB) 与 `pnpm-lock.yaml`(246KB) | `ls` [实测] |
| `pnpm list --prod --depth 0` 零输出，551 个顶层包却报不出依赖 | 实跑 [实测] |

**推断**：某次跑过 `npm install`，把 pnpm 的安装元数据覆盖了。
→ 对结论**无影响**（Linux 上交叉打 Windows 包本来就因原生件而不可行），
但**修法不同**：本机重跑 `pnpm install` 即可恢复，不是仓库缺陷；CI 的 `build-windows` 是全新 `pnpm install`，不受影响。

**确认两处（体检报告成立）：**

1. **那 3 例 Windows 测试确非产品缺陷** —— 根因是模块级常量在 import 期求值：
   `ShellDetector.ts:7` 与 `CliDetector.ts:6` 都是 `const isWindows = process.platform === 'win32'`，
   import 之后再 mock `process.platform` 影响不到它。[实测]
2. **`tsdSafeRead` 确实起裸 `node`** —— 但这不是疏忽，是**有意设计**：
   源码注释原文「The packaged Electron exe is not in TEC's whitelist, so it reads raw encrypted bytes.
   Detect the TSD header and fall back to spawning **system node.exe (which IS whitelisted)**」
   （`src/main/utils/tsdSafeRead.ts:7-10`，`:31` `execFileAsync('node', …)`）。[实测]
   **真正的问题因此更准确**：C-15 随包 Node 解决的是「Agent Host 没有系统 Node 可用」，
   而 `tsdSafeRead` 仍**假定存在一个被白名单的系统 node**。两者对同一台机器给出了不同假设——
   **这恰恰是 T-11⑥ 要实证的那件事**，不是先修再去，而是**去了正好一并验掉**。
   处置从「M4 必须改码」下调为：**现场分两次取证**（有系统 node / 只有随包 node），把两条假设各自的结论带回来。



## 1. 一句话答复

**不能。** 现在这台机器（Linux）打不出可用的 Windows 包——不是慢，是三处硬断；
**换到 Windows 机器打包后可以去**，但这一趟只能测「通用功能 + TSD 白名单实证（T-11 的真正目的）」，
**测不到 multi-agent**——Codex 侧还没落地，Host 只接受 `claude-code`，侧栏 agent chip 永远是「Claude Code」。

---

## 2. go / no-go 判定表

| 前置 | 判定 | 依据（一句话） |
|---|---|---|
| **打包链路可跑（本机）** | ❌ | `fetch:node-runtime` 用 GNU tar 解 zip 必失败，解开后还要 exec `node.exe`（本机 Exec format error）；`dist:prereq` 永不通过 [实测] |
| **打包链路可跑（本机·绕过）** | ❌ | 直接 `npx electron-builder --win --dir` 走到 afterPack 死在 `out-node-runtime missing node.exe`；且本机无 wine，nsis/portable 出不来 [实测] |
| **交叉打包产物可用性** | ❌ | 根 node_modules 的 sqlite3 / @vscode/ripgrep / node-pty 全是 Linux ELF，@parcel/watcher 只有 linux 后端，`npmRebuild:false`；out-agent-host 也是 Linux 味（空 prebuilds + ELF pty.node + sharp-linux-x64） [实测] |
| **本机依赖树完整性** | ❌ | node_modules 不是有效 pnpm 安装（无 .pnpm/.modules.yaml），`pnpm list --prod` 零依赖 → 打出的 app.asar 只含 `out/`、无 node_modules、无 asar.unpacked，任何平台启动即死 [实测] |
| **打包链路（Windows 机器）** | ✅ | CI 的 `build-windows`（windows-2022）路径完整：pnpm install → agent-host npm ci → build-agent-host → fetch-node-runtime → electron-builder → verify --skip-smoke [读码] |
| **出包通道（CI 取件）** | ⚠️ | `build-windows` 无 `upload-artifact`，只有 push `v*` tag 时靠 electron-builder publish 出 draft release；`workflow_dispatch` 跑完拿不到 exe（台账已登记「≈6 行补法已备」） [读码] |
| **C-15 随包 Node（代码）** | ✅ | pin 24.18.0 win-x64 + SHA256 + afterPack 拷贝 + resolver bundled 源 + verify 三条断言，全在仓库；2026-07-24 已在 Windows 全验（adc3127，25 项 PASS） [读码] |
| **C-15 随包 Node（产物）** | ❌ | 本机无 `out-node-runtime/`、无 `dist/win-unpacked`（现只剩 dist/remote-runtime）；bundled 路径只在「已打包 且 win32」生效，Linux 上根本验不到 [实测] |
| **版本新鲜度** | ❌ | 上一个已知 Win 包是 157 个提交前的 0.3.4（2026-07-24），T-12~T-35 整套壳/主题/字体/压缩重构全不在内；package.json 仍写 0.3.4 [实测] |
| **凭证注入** | ⚠️ | 方案未定死：`prepare:test-config` 是 node 脚本，在「无用户 Node」的加密机上鸡生蛋跑不起来；且 GUI onboarding 写死 `~/.claude`，与 `CLAUDE_CONFIG_DIR` 打架，混用会造假故障 [读码] |
| **网络可达** | ⚠️ | 网关 `cch-jyw.pipidan.qzz.io` 从本开发机 307 / 1.12s 可达；**加密机侧未知**，内网代理/TLS 拦截都可能挡死，连不通则 T-11③④⑤⑥ 全部作废 [实测 + 未知] |
| **T-10 前置九项** | ❌ | 团队台账 T-10 仍 ⬜ 一项未做，T-11 自身 ⬜「等 T-10」。加密机是一次性差旅成本，不该拿从未人工点验过的包去叠加密变量 [读码] |
| **本轮改动风险（3 例测试）** | ✅ | **不是真缺陷**：把 `process.platform` stub 成 win32 后 ShellDetector 2 例 + CliDetector 1 例 **3/3 全绿**；根因是模块级 `const isWindows = process.platform==='win32'` 未被 mock。全量门禁 2468 passed / 3 failed，两条 typecheck EXIT=0 [实测] |
| **本轮改动风险（侧栏 chip）** | ⚠️ | 默认侧栏 280px（= 最小宽，开箱即最坏）+ 长分支名（本仓库 `feat/openchamber-chat-refactor` 必打满 max-w-28=112px）下，标题预算从 ~91px 掉到 ~17px（只剩省略号），hover 时算下来 −7px 会溢出 [推测·像素预算] |
| **本轮改动风险（兼容）** | ✅ | 缺省 agent → `claude-code`（`resolveAgentWireName`），磁盘侧用 `agent?: string` 不当错；`rejectUnsupportedAgent` 先放行缺省/空串，渲染侧调用点全部来自 `sessionAgent()`，不会误伤 Claude [读码] |
| **主进程 TSD 兜底** | ⚠️ | `src/main/utils/tsdSafeRead.ts:31` 写死裸 `node` 走 PATH，**没用随包 node.exe**；无用户 Node 的加密机上，文件树/编辑器打开加密文件、旧版会话扫描、日志尾读全部 spawn ENOENT [读码] |

---

## 3. 打包前必做

### 必须做（不做就别去）

| # | 事项 | 工时 | 说明 |
|---|---|---|---|
| M1 | **换 Windows 机器出包**（或给 CI `build-windows` 补 `upload-artifact`，约 6 行） | 机器：1.5-2h 首次（nodejs.org 极慢，37MB 约 3 分钟；electron zip 137MB 约 70s；`compression: maximum` + NSIS/portable 双 target 估 10-20min）<br>CI：0.5h 改 + 20-30min 跑 | 本机三处硬断无解，除非改源码（本轮禁止） |
| M2 | **在 Windows 上跑 `pnpm verify:packaged`（25 项全绿）** | 10min | T-10 清单抬头写明的前置「C-02 自动化断言已绿」；Linux 上跑没意义（exe / 随包 node.exe / node-pty 三处断言被 platform 门控，等于放行） |
| M3 | **定死凭证注入方案并写进 T-10 清单** | 0.5h | 二选一：(a) 带仓库过去，用 `dist\win-unpacked\resources\node-runtime\node.exe scripts\make-test-claude-config.mjs`（该脚本只用 node 内置模块，可直跑）；(b) 手工落两个 JSON。**明令禁止混用 GUI onboarding** |
| M4 | **`tsdSafeRead` 改用 `getBundledNodeRuntimePath()`，或把 T-11② 的取证方式限定为「让 Agent 用 Read 工具读」** | 改码 0.5-1h / 改清单 10min | 不处理的话，② 会以 spawn ENOENT 失败并被误判成「白名单问题」，污染整轮结论 |
| M5 | **修侧栏 agent chip 宽度 + 补一条静态不变量测试** | 1h | T-10 第 9 项要的正是真机看侧栏标题。可选处置：chip 降 `max-w-20` / 标签改「Claude」「Codex」/ branch chip 收窄。带着这个缺陷上机 = 浪费一次上机机会 |
| M6 | **查清加密机上是否已有被白名单的 node.exe 及其绝对路径** | 出发前问，10min | ⑥ 失败时的唯一逃生口 `AICLIENT_NODE24_PATH`（优先级在 bundled 之上）；不查清则 ⑥ 一失败整轮作废 |

> 3 例 Windows 测试**不进必做**——已实测证伪为环境假设缺陷，非产品缺陷。

### 建议做

| # | 事项 | 工时 |
|---|---|---|
| S1 | 给那 3 例测试内部 stub `process.platform`，或 `describe.skipIf(process.platform!=='win32')` —— 否则 Linux 门禁永久 3 红，会淹没真实回归 | 0.5h |
| S2 | 先在**普通 Windows 机**上过一遍 T-10 的 1/2/3/7 项（启动 / 首帧 / 建会话 / 终端），再上加密机 | 1h |
| S3 | 版本号从 0.3.4 抬一档（157 个提交后仍是 0.3.4，产物无法区分新旧） | 10min |
| S4 | 现场用 `win-unpacked` 而非 portable（portable 每次解到临时目录，随包 node.exe 绝对路径漂移，若白名单按路径判定则 ⑥ 结论不可复现） | 0 |
| S5 | `pnpm.overrides` 在 pnpm 10.26 已失效（每次命令告警），electron-builder 系三个包的 26.4.0 钉版形同虚设——出包前确认实际解析版本 | 0.5h |

---

## 4. 这一趟能测到什么 / 测不到什么

### T-11 六项（加密机）

| 项 | 判定 | 说明 |
|---|---|---|
| ① 记录白名单 Node 的 execPath/version/source | **本轮可测** | 无 GUI 面板，只能开 DevTools（菜单 View → Developer Tools，打包版未被 isPackaged 屏蔽）跑 `await window.electronAPI.agentHost.resolveNode()` → 返回 `{execPath, version, source: bundled\|env\|nvm\|path}` [读码] |
| ② GUI 打开已知加密文件 | **需先补**（M4） | 主进程兜底写死裸 `node`，无用户 Node 时必 spawn 失败；改码或改取证方式二选一 |
| ③ 真实工作区跑通对话 | **本轮可测**（前提：网关连得通） | 现场第一件事 `curl https://cch-jyw.pipidan.qzz.io/`，不通就当场止损 |
| ④ 权限卡 Allow 后写文件 | **本轮可测** | 但通过标准可能要改写——TSD 是否只加密 Node 写出的文件（cli.js 写的 PING.txt 之后 Electron 能否读出明文）无证据覆盖 |
| ⑤ 加密历史 → `encrypted_unreadable` | **本轮可测**（全链已实现） | 64 个用例全绿实测；Host 读单会话/列会话前都探 16 字节魔数，列会话整目录中止不返半截。**取证陷阱**：Host 读的是继承来的 `CLAUDE_CONFIG_DIR`，若指到临时测试配置目录，`~/.claude/projects` 的存量文件根本没被读到——两种口径必须分两次跑或明确只验其一 |
| ⑥ **随包 node.exe 是否被白名单认** | **本轮可测——这是整趟的核心价值** | D17「只要是 node 就白名单」至今只是用户转述、未实证；⑥ 就是它的实证项。按进程名则过，按路径/哈希/签名则不过 |

### T-10 九项（打包版 GUI）

| 项 | 判定 |
|---|---|
| 1 启动 / 2 首帧 / 3 建会话 / 7 终端 | **本轮可测**（建议先在普通 Windows 机过一遍，S2） |
| 4 权限卡写文件 | **本轮可测**，标准可能需按 ④ 的未知项改写 |
| 5 / 6 会话历史与恢复 | **本轮可测** |
| 8 全新机器添加仓库 | **本轮可测**（Linux 本就采集不到，必须真机） |
| 9 Win10 字重真机核 | **需先补**（M5）——带着 chip 挤压缺陷上机等于浪费 |
| 终端 Ctrl+R 透传 | **只在打包态执行**（`app.isPackaged` 门控），dev 永远测不到，**必须真机验** |

### 与本轮无关 / 测不到

- **multi-agent 全部功能**：Codex 侧未落地，`SUPPORTED_AGENTS` 只有 `claude-code`，侧栏 chip 恒为「Claude Code」。本轮改动只是**协议与索引的前置铺垫**（可选字段 + 拒绝分支 + chip 展示），没有第二个 agent 可切。**去了也测不到 agent 切换**。
- **降级场景**：用更高版本写过 session-index.json 再退回本版本，那些行会在侧栏消失（设计意图，非缺陷，但是打包版上第一次可能被用户看见的新行为）。
- **AutoUpdater**：打包态启动 3s 后自动 `checkForUpdates` 打 GitHub——内网加密机上会发起外网请求，注意别误判为卡顿。
- **dev vs 打包差异**（必踩，dev 全绿不代表打包态可用）：userData 路径（dev 是 `AiClient-dev`，加密机首启是全新 profile）、renderer 加载方式（loadURL vs loadFile asar）、Host 入口（`src/agent-host/index.ts` + `--experimental-strip-types` vs `resources/agent-host/index.js` esbuild bundle）、凭证来源（dev.js 强制注入 dev.env，打包态**没有这一层**）。

---

## 5. 现场操作步骤

### 出发前（在打包的那台 Windows 上做完）

```powershell
# 1) 出包
pnpm install
cd src\agent-host && npm ci && cd ..\..
pnpm build:win                       # = dist:prereq(build + build:agent-host + fetch:node-runtime) + electron-builder
pnpm verify:packaged                 # 25 项必须全绿，产物在 dist\win-unpacked
# 2) 把整个 dist\win-unpacked 目录 + 仓库的 scripts\make-test-claude-config.mjs 一起拷到 U 盘
#    （用 win-unpacked，不用 portable —— 见 S4）
```

### 加密机现场

```powershell
# 步骤 0（止损点）：网关先探，不通就掉头
curl https://cch-jyw.pipidan.qzz.io/          # 期望 307

# 步骤 1：凭证——用随包 node.exe 跑，不要用 pnpm（加密机可能没有用户 Node）
D:\win-unpacked\resources\node-runtime\node.exe D:\scripts\make-test-claude-config.mjs
#   → 在 %TEMP%\aiclient-gui-test-config 写 settings.json（网关 token + base URL）与 .claude.json
#     （hasCompletedOnboarding + 每个工作区 hasTrustDialogAccepted）
#   兜底：手工写这两个 JSON。**全程禁止走 GUI onboarding**（它写死 ~\.claude，与 CLAUDE_CONFIG_DIR 打架）

# 步骤 2：带环境变量启动
set CLAUDE_CONFIG_DIR=%TEMP%\aiclient-gui-test-config
D:\win-unpacked\AiClient.exe

# 步骤 3（第一取证）：菜单 View → Developer Tools，控制台跑
await window.electronAPI.agentHost.resolveNode()
#   → 截图记下 {execPath, version, source}。source==='bundled' 且 execPath 指向
#     resources\node-runtime\node.exe，才说明随包 node 生效 → 这是 T-11①⑥ 的直接证据
```

### 点验顺序

0. curl 网关（不通 → 止损返程）
1. T-10 1/2/3：启动 → 首帧 → 建会话
2. **T-11⑥**（`resolveNode()` + 发一条消息看 Host 能否起来）—— **优先于其余所有项**，因为它是地基
3. T-11③ 真实工作区对话 → ④ 权限卡 Allow 写文件
4. T-11⑤ 加密历史：**分两次**，一次在临时 `CLAUDE_CONFIG_DIR` 下，一次指回 `~\.claude`
5. T-11②（按 M4 的处置方式取证）
6. T-10 7/8/9：终端（含 Ctrl+R 透传，打包态专属）、全新仓库、Win10 字重与侧栏标题

### 出问题怎么取证

- 每一步都截图 + 记录 `resolveNode()` 的 execPath；
- Host 起不来 → DevTools Console 找 `agent_unsupported` / spawn 错误码；
- 读到密文的典型形态是**静默拿到以 `%TSD-Header-###%` 开头的垃圾，不是抛异常**——看到空白/乱码先怀疑这条，别怀疑功能坏了；
- 文件树/编辑器打开加密文件失败 → 先确认是不是 M4 那条裸 `node` ENOENT，不要记成白名单问题。

---

## 6. 风险与退路（最可能失败的三处）

| # | 风险 | 概率 | 现场应对 |
|---|---|---|---|
| **R1** | **⑥ 失败：随包 node.exe 不被白名单认**（白名单实为按路径/签名/哈希，而非进程名）。连锁后果：②③⑤ 全挂——Host 读工作区文件、读 JSONL、读 node 写出的 settings.json 一律拿到密文 | 中（D17 至今只是转述，从未实证） | 用逃生口，**不改码**：`set AICLIENT_NODE24_PATH=<加密机上已被白名单的 node.exe 绝对路径>`（优先级 explicit → env → bundled，压过随包），重启后复跑 ②③⑤。**前提是 M6 出发前已查清该路径**，否则整轮作废 |
| **R2** | **网关连不通**（内网代理 / 防火墙 / TLS 拦截 / 证书注入）。③ 跑不通，④⑤⑥ 失去「真实工作区跑通」的语境 | 中（本机 307 可达 ≠ 现场可达） | 现场第一件事 curl，不通就**当场止损返程**，别在里面耗。可退而求其次只验 ⑥ 的 `resolveNode()` + ⑤ 的历史读取（这两项不需要网关），把 ①⑤⑥ 的结论带回来也算不虚此行 |
| **R3** | **管控层直接挡在门口**：未签名 exe 被拒、EDR 拦 spawn 子进程、%TEMP% 禁止执行。第 1 项启动就死 | 中低 | 换用 NSIS 安装版而非直接跑目录；凭证目录改放非 %TEMP% 的可写路径（`CLAUDE_CONFIG_DIR` 指哪都行）；若 spawn 被拦，`resolveNode()` 仍能返回（纯路径解析，不 spawn），至少把「随包 node 是否被认到」这一半证据拿回来 |

### 兜底判断

若 M1（换机器出包）这一步本身受阻，**不要**拿 2026-07-24 的 0.3.4 旧包去加密机——那是 157 个提交之前的版本，T-12~T-35 的壳重构全不在内，验的是一个不存在的版本，结论无法回填台账。
