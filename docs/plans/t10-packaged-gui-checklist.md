# T-10 打包版 GUI 手工点验清单（M1 后半）

> 由 C-02 移交。执行人：👥 团队。完成后逐项勾选，结果（含截图/记录位置）回填 [`ledger-team-track.md`](./ledger-team-track.md)，达成 M1 → CP2。
> 前置：C-02 自动化断言已绿（`pnpm verify:packaged`，产物在 `dist/win-unpacked`；便携版为 `dist/AiClient-<version>-portable.exe`）。

## 凭证准备（统一约定，见执行计划 §4）

```powershell
# 生成测试网关配置目录（可附加要信任的工作区路径作为参数）
pnpm prepare:test-config D:\你的\测试工作区

# 按脚本输出设置 CLAUDE_CONFIG_DIR 后再启动应用，例如：
$env:CLAUDE_CONFIG_DIR='C:\Users\<你>\AppData\Local\Temp\aiclient-gui-test-config'
.\dist\AiClient-<version>-portable.exe
```

原理：Main 进程以 `{...process.env}` 启动 Host，Host 认 `CLAUDE_CONFIG_DIR`——无需改动 `~/.claude/settings.json`。

## 点验项

| # | 项 | 操作 | 通过标准 | ✔ |
|---|---|---|---|---|
| 1 | 启动 | 双击便携版（或安装版装完启动） | 应用正常启动，无白屏/报错弹窗 | |
| 2 | Beta 壳 | Settings → Appearance → 打开 **OpenChamber Workspace Shell** | 四区壳出现 | |
| 3 | Host 就绪 + PONG | 选 **Live Agent Host** 新建会话，发 `Reply with exactly: PONG. Do not use tools.` | 时间线出现 user + assistant 流式文本，内容含 PONG | |
| 4 | 权限卡 Allow | 发 `Create PING.txt with content pong`（工作区内） | tool_call → 权限卡 → Allow → tool_result；`PING.txt` 真实生成且内容为 pong | |
| 5 | 权限卡 Deny | 再次触发写文件请求 → Deny | 会话不崩，模型收到拒绝并正常收尾 | |
| 6 | Stop | 发长任务（如「Count from 1 to 200 slowly」）→ 运行中点 Stop | 流终止，状态回 idle，可继续发新消息 | |
| 7 | 退出无孤儿 | 关闭应用 → 任务管理器搜 `node.exe` | 无残留 Host/cli 进程（对比启动前快照） | |
| 8 | 全新机器添加仓库（T-24 真机残留，2026-08-04 并入） | 无既有仓库状态首启（不带 `--open-path`）：① 左栏空态 CTA / 头部入口添加本地仓库；② 从资源管理器拖文件夹到窗口 | ① 弹窗添加成功；② 出「Add Repository」高亮遮罩、松手弹窗预填路径；两路添加后左栏均立现 Project/Workspace | |
| 9 | Win10 字重真机核（T-23/T-32 点验残留，2026-08-05 并入；开发机为 Linux 无法采集） | 顶栏会话标题（15px semibold）与正文并列对比；另核 0-nonies ⑪ 的 D25 §6.2 五项真机指标 | 标题明显比正文醒目；**粗细无差即字重回退 bug**（Win10 常缺 500 字重，故用 semibold） | |

## 出发前必做（2026-08-06 打包体检新增，见 [体检裁定](./2026-08-06-packaging-readiness-verdict.md)）

| # | 事项 | 工时 | 为什么 |
|---|---|---|---|
| M1 | **换 Windows 机器出包**，或给 CI `build-windows` 补 `upload-artifact`（≈6 行） | 机器 1.5–2h 首次 / CI 0.5h 改 + 20–30min 跑 | Linux 本机三处硬断：`fetch:node-runtime` 用 GNU tar 解 zip 必失败、`afterPack` 缺 `out-node-runtime/node.exe` 中止、根 node_modules 的 sqlite3/ripgrep/node-pty/@parcel-watcher 全是 Linux ELF 且 `npmRebuild:false` [实测] |
| M2 | 在 Windows 上跑 `pnpm verify:packaged`（25 项全绿） | 10min | 本清单抬头写明的前置。**Linux 上跑没意义**——exe / 随包 node.exe / node-pty 三处断言被 platform 门控等于放行 [实测] |
| M3 | 定死凭证注入方案 | 0.5h | `prepare:test-config` 是 node 脚本，在「无用户 Node」的加密机上鸡生蛋。可用随包 node 直跑：`resources\node-runtime\node.exe scripts\make-test-claude-config.mjs`（只用 node 内置模块）。**禁止混用 GUI onboarding**（写死 `~\.claude`，与 `CLAUDE_CONFIG_DIR` 打架） |
| M4 | 出发前查清加密机上**是否已有被白名单的 node.exe 及其绝对路径** | 10min | T-11⑥ 失败时的唯一逃生口 `AICLIENT_NODE24_PATH`（优先级压过 bundled）。不查清则 ⑥ 一失败整轮作废 |
| M5 | ~~修侧栏 agent chip 宽度挤压~~ **已完成** | — | 本清单第 9 项要看的正是侧栏标题。已改让位顺序：标题 `min-w-20` 下限 → 分支 chip 唯一让位者 → 时间/操作 `w-10` 定宽盒消抖。5 组变异实验钉死静态不变量（`sidebarRowBudgetStatic.test.ts`）。**仍需现场三看**，见[测试方案](./2026-08-06-encrypted-machine-test-plan.md) 步骤 4 第 9 项 |
| M6 | ~~版本号抬档~~ **已完成** | — | 已从 0.3.4 抬到 `0.4.0-test.1`，2026-08-08 再抬到 **`0.4.0-test.2`**（08-07 测试机跑的是 test.1，带五问题修复的包须与之可分辨）。预发布号既不与将来的正式 0.4.0 撞号，又因 `allowPrerelease=false` 成为误发布时的第四层保险。**到手先在 About 里核对版本** |

**版本新鲜度警告**：上一个已知 Windows 包是 **157 个提交前的 0.3.4**（2026-07-24），
T-12~T-35 整套壳/主题/字体/压缩重构全不在内。**不要拿旧包去加密机**——验的是一个不存在的版本，结论无法回填台账。

**3 例 Linux 门禁失败已修（2026-08-06）**：根因如原判——`ShellDetector.ts:7` / `CliDetector.ts:6`
的模块级 `const isWindows` 在 import 期求值。但**原结论「非产品缺陷、不进必做」只对了一半**：
这三例并不是「在 Linux 上无意义」，而是**从来没有模拟过 Windows**——它们依赖宿主真的是 Windows，
在别的平台上恒红。两个测试文件本就用 `vi.resetModules()` + 动态 `import()`，
所以只要在 `beforeEach` 里 `Object.defineProperty(process, 'platform', …)` 抢在模块求值之前，
**无需改任何产品代码**就能让 Windows 分支在任意宿主上真跑起来。已如此修复：
把 stub 改成 `'linux'` 会让三例重新变红，证明桩是承重的、不是空过。
**门禁现状：四门全绿（lint 0 / typecheck 0 / typecheck:agent-host 0 / vitest 2479 例 0 红）。**

## 注意

- 全程走测试网关（第 3 项时间线正常即证明凭证注入生效；如需核对可看诊断/日志中 `baseHost: cch-jyw.pipidan.qzz.io`）。
- 加密机相关项**不在本清单**：T-11 现场执行，开发机不得代标通过。
- 任一项不过：截图 + 复现步骤记入团队台账，@主线（Claude）跟进。
