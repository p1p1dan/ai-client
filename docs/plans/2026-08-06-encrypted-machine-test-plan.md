# 加密机测试方案（自己在 Windows 上出包，不走 CI）

> 2026-08-06。用户口径：**不用 CI，自己出包去测**。
> 相关：[T-10 打包版清单](./t10-packaged-gui-checklist.md) · [打包体检裁定](./2026-08-06-packaging-readiness-verdict.md) ·
> 执行计划的 **T-11 / C-15 / D17**。
> 每条标 [实测] / [读码] / [推测]。

---

## 0. 先回答「会不会把测试版推给正在用的人」

**不会。三层保险，逐层已核实：**

| 层 | 机制 | 证据 |
|---|---|---|
| ① 推代码不触发发布 | CI 的发布作业条件是 `if: startsWith(github.ref, 'refs/tags/v')` —— **只有推 `v*` tag 才发布**，推普通提交/分支不发布任何东西 | `.github/workflows/build.yml:260` [读码] |
| ② 就算推了 tag，发的也是草稿 | `publish.releaseType: draft` —— electron-builder 建的是 **draft release** | `electron-builder.yml` publish 段 [读码] |
| ③ 草稿对更新器不可见 | electron-updater 的 GitHub provider 取的是 `/repos/<owner>/<repo>/releases/**latest**`（公共 API），**GitHub 的 `/releases/latest` 明确排除 draft**；且 `allowPrerelease` 全仓未设置（默认 false） | `node_modules/electron-updater/out/providers/GitHubProvider.js:150-161`；全仓 grep `allowPrerelease` 零命中 [实测] |

**唯一危险动作**：去 GitHub 上手动点 **Publish release** 把草稿转正。
一旦转正，在线用户会**自动下载**——`autoDownload` 默认 `true`（`src/main/index.ts:271` 的 `?? true`），
且窗口获得焦点时会检查（30 分钟防抖）。[读码]

> **本方案完全不碰发布**：在自己的 Windows 机器上本地出包、拷 U 盘带走。
> 产物既不上传 GitHub，也不进 release，**在线用户零感知**。

---

## 1. 在 Windows 机器上出包

### 1.1 前提

| 项 | 要求 | 备注 |
|---|---|---|
| Node | ≥ 24（本仓 agent-host `engines: node>=24`） | 出包机需要；**目标加密机不需要**（C-15 随包 node.exe） |
| pnpm | 10.x | |
| 网络 | 出包机**需要**外网 | 要下 electron zip（137MB）与 node.exe（从 nodejs.org，**实测极慢，37MB 约 3 分钟**）[实测] |
| 磁盘 | ≥ 3GB 空闲 | win-unpacked 约 0.5–0.6GB + 缓存 |

### 1.2 命令（PowerShell）

```powershell
git clone <repo> ai-client        # 或 git pull
cd ai-client
git checkout feat/openchamber-chat-refactor

pnpm install
cd src\agent-host
npm ci                            # 注意：agent-host 是独立的 npm 工程，必须单独装
cd ..\..

pnpm build:win                    # = dist:prereq(build + build:agent-host + fetch:node-runtime) + electron-builder
pnpm verify:packaged              # 25 项必须全绿
```

**产物**：`dist\win-unpacked\`（目录版）与 `dist\AiClient-<version>-portable.exe`（便携版）。

### 1.3 三个已知坑

1. **`npm ci` 别漏**。`src/agent-host` 有自己的 `package.json`，装的是
   `@anthropic-ai/claude-agent-sdk` 与 `@cometix/claude-code`（后者的 `cli.js` 是 20MB 纯 JS，
   Claude 全靠它）。漏装则 agent-host bundle 里没有 Claude。[实测]
2. **nodejs.org 极慢**。`fetch:node-runtime` 要下 88MB 的 win-x64 node.exe，本机实测同类下载
   37MB 用了 3 分钟。急的话先手动下好放进脚本期望的位置（看 `scripts/fetch-node-runtime.mjs` 的 pin 与校验逻辑）。[实测]
3. **带 `win-unpacked` 去，不要带 portable**。portable 每次运行解到临时目录，
   随包 node.exe 的绝对路径会漂移；若白名单按路径判定，结论不可复现。[推测·稳妥起见]

### 1.4 拷什么去加密机

```
dist\win-unpacked\                     整个目录
scripts\make-test-claude-config.mjs    单个文件（只用 node 内置模块，可用随包 node 直跑）
```

---

## 2. 现场测试（按此顺序）

### 步骤 0 — 止损点：先探网关

```powershell
curl https://cch-jyw.pipidan.qzz.io/
```

期望 307。**不通就掉头**，别在里面耗——对话类的项全部依赖它。
（不通时仍可测第 3 步和第 6 步，那两项不需要网关。）

### 步骤 1 — 凭证

**用随包 node 跑，不要用 pnpm**（加密机可能没有用户装的 Node）：

```powershell
D:\win-unpacked\resources\node-runtime\node.exe D:\make-test-claude-config.mjs
```

它会在 `%TEMP%\aiclient-gui-test-config` 写 `settings.json`（网关 token + base URL）与 `.claude.json`。

> **全程禁止走 GUI onboarding** —— 它写死 `~\.claude`，与 `CLAUDE_CONFIG_DIR` 打架，混用会造出假故障。[读码]

### 步骤 2 — 启动

```powershell
set CLAUDE_CONFIG_DIR=%TEMP%\aiclient-gui-test-config
D:\win-unpacked\AiClient.exe
```

### 步骤 3 — 第一取证：随包 node 到底生没生效（**优先于其它所有项**）

菜单 **View → Developer Tools**，控制台跑：

```js
await window.electronAPI.agentHost.resolveNode()
```

**截图记下 `{execPath, version, source}`。**

- `source === 'bundled'` 且 `execPath` 指向 `resources\node-runtime\node.exe`
  → 随包 node 生效，**T-11①⑥ 的直接证据**
- `source === 'path'` / `'nvm'` → 说明机器上本来就有 Node，随包 node 没被用上
  （这本身也是有效结论，但要记下来，否则后面的判断会串）

**这一步为什么排第一**：D17「只要是 node 就白名单」至今只是转述、从未实证。
它是后面所有加密相关结论的地基——地基不成立，后面全白测。

### 步骤 4 — 通用功能（T-10 九项）

| # | 操作 | 通过标准 |
|---|---|---|
| 1 | 双击启动 | 无白屏 / 无报错弹窗 |
| 2 | Settings → Appearance → 打开 OpenChamber Workspace Shell | 四区壳出现 |
| 3 | 新建会话，发 `Reply with exactly: PONG. Do not use tools.` | 时间线出现流式文本，含 PONG |
| 4 | 发 `Create PING.txt with content pong` | 工具行 → 权限卡 → Allow → `PING.txt` 真实生成且内容为 pong |
| 5 | 再触发写文件 → Deny | 会话不崩，模型收到拒绝正常收尾 |
| 6 | 发长任务 → 运行中点 Stop | 流终止，状态回 idle，可继续发 |
| 7 | 关闭应用 → 任务管理器搜 `node.exe` | 无残留（对比启动前快照）。**顺带测终端 Ctrl+R 透传——它被 `app.isPackaged` 门控，开发态永远测不到** |
| 8 | 全新 profile 首启：① 左栏空态 CTA 添加本地仓库；② 从资源管理器拖文件夹到窗口 | ① 弹窗添加成功；② 出高亮遮罩、松手弹窗预填路径 |
| 9 | 顶栏会话标题（15px semibold）与正文并列对比 | 标题明显更醒目；**粗细无差 = 字重回退 bug**（Win10 常缺 500 字重） |

> **第 9 项顺带看侧栏**：本轮每行新增了一枚 agent chip（显示「Claude Code」）。
> 出包前已按宽度预算改过让位顺序（**分支 chip 先让 → 相对时间定宽 → 标题有 `min-w-20` 下限，永不被挤成省略号**），
> 5 组变异实验证明静态不变量不是空跑。但**布局缺陷只在截图里显形**，本机无 GUI，所以现场必须看这三样：
>
> 1. 侧栏拖到**最窄（280px）** + 当前这种长分支名（`feat/openchamber-chat-refactor`）：
>    标题应仍有约 10 个字可读，分支 chip 退成 `feat…` 是**预期**，不是 bug。
> 2. **鼠标划过/移开会话行**：时间与操作按钮共用 `w-10` 定宽盒，整行**不应有任何横向抖动**。
> 3. 侧栏拖到 **500px**：三件套都应恢复完整，多出来的宽度全部给标题。
>
> 任一条不符 → 截图带回，这是唯一能推翻本机像素预算的证据。[待实测]

### 步骤 5 — 加密专属（T-11）

| # | 项 | 怎么测 |
|---|---|---|
| ② | GUI 打开已知 TSD 加密文件 | 在文件树里打开，看是明文还是 `%TSD-Header-###%` 开头的垃圾。**关键**：主进程的 `tsdSafeRead` 起的是**裸 `node`**（走 PATH），不是随包 node（`src/main/utils/tsdSafeRead.ts:31`）[实测] → 若机器上没有系统 Node，这条会以 spawn ENOENT 失败。**看到失败先分清是 ENOENT 还是白名单问题，别记混** |
| ③ | 在真实加密工作区跑通对话，让 Agent 用 Read 工具读加密文件 | 读出明文即过 |
| ④ | 权限卡 Allow 后写文件 | 写出的文件之后能不能被 Electron 读出明文（TSD 是否只加密 Node 写出的文件，无证据覆盖，实测即结论） |
| ⑤ | 加密历史 → 显性报 `encrypted_unreadable` 而非静默空 | **分两次跑**：一次在临时 `CLAUDE_CONFIG_DIR` 下，一次指回 `~\.claude`。**取证陷阱**：Host 读的是继承来的 `CLAUDE_CONFIG_DIR`，若指到临时目录，`~\.claude\projects` 的存量文件根本没被读到 |
| ⑥ | **随包 node.exe 是否被白名单认** | 步骤 3 拿到 `source === 'bundled'` 后，直接跑 ③ —— 能读出明文即证明随包 node 被认 |

### 步骤 6 — Codex（本轮**测不到**，但可以顺手取一条证据）

**本版本没有 Codex 功能**——`SUPPORTED_AGENTS` 只有 `claude-code`，
侧栏 chip 恒为「Claude Code」，UI 上没有切换入口。**别指望测 agent 切换。**

但既然你已确认「npm 安装的 codex 在加密机上读文件正常」，可以顺手取一条对后续有用的证据：

```powershell
where codex                       # 记下路径，确认是不是 node 包装器（软链到 bin\codex.js）
codex --version
node --version                    # 记下系统 Node 版本与路径
```

**为什么值得记**：切片 2 要让打包版去起 Codex，届时要决定「用系统 codex 还是随包 codex」。
你现在这台机器上「npm 装的 codex 能读文件」是已知的，把**路径与版本**记下来，
切片 2 就有了一个已知可用的参照点。

---

## 3. 出问题怎么取证

- 每步截图 + 记 `resolveNode()` 的 `execPath`。
- Host 起不来 → DevTools Console 找 spawn 错误码 / `agent_unsupported`。
- **读到密文的典型形态是静默拿到 `%TSD-Header-###%` 开头的垃圾，不是抛异常** ——
  看到空白或乱码先怀疑这条，别怀疑功能坏了。
- 文件树打开加密文件失败 → 先确认是不是 `tsdSafeRead` 那条裸 `node` 的 ENOENT，
  **不要记成白名单问题**。

---

## 4. 三个最可能失败的地方

| # | 风险 | 现场应对 |
|---|---|---|
| R1 | **随包 node.exe 不被白名单认**（白名单实为按路径/签名/哈希） | 用逃生口、**不改码**：`set AICLIENT_NODE24_PATH=<机器上已被白名单的 node.exe 绝对路径>`（优先级压过 bundled），重启复跑 ②③⑤。**出发前先查清这个路径** |
| R2 | **网关连不通**（内网代理 / 防火墙 / TLS 拦截） | 步骤 0 当场止损。仍可只做步骤 3（`resolveNode()`）与 ⑤（历史读取），这两项不需要网关，把结论带回来也不虚此行 |
| R3 | **管控层挡在门口**：未签名 exe 被拒 / EDR 拦 spawn / `%TEMP%` 禁止执行 | 改用 NSIS 安装版；凭证目录换到非 `%TEMP%` 的可写路径（`CLAUDE_CONFIG_DIR` 指哪都行）；若 spawn 被拦，`resolveNode()` 仍能返回（纯路径解析不 spawn），至少把「随包 node 有没有被认到」这半证据拿回来 |

---

## 5. 一条硬提醒

**别拿旧包去。** 上一个已知的 Windows 包是 **157 个提交前的 0.3.4**（2026-07-24），
T-12~T-35 整套壳 / 主题 / 字体 / 压缩重构全不在内。拿它去验的是一个不存在的版本，结论回填不了台账。

版本号**已抬到 `0.4.0-test.1`**，产物名与 About 里都能一眼分辨。
选带 `-test` 的预发布号有两层用意：① 与将来真正的 0.4.0 正式版不撞号；
② `allowPrerelease` 全仓为 false，**即使这个包被误发布，稳定通道用户也不会收到**——
这是压在 §0 三层保险之上的第四层。

**到手第一件事：About 里确认版本是 `0.4.0-test.1`。** 不是就说明拿错包了，别往下测。

> **已知副作用**：`RemoteRuntimeAssets.ts:29` 用 `v${pkg.version}` 拼 GitHub release 资产地址，
> 该 tag 不存在，所以「远程 runtime 自动下载」在这个包里会 404。
> **与本次测试无关**（那是 Linux SSH 远端功能，本次全程不碰），记在这里免得现场误判成新缺陷。
