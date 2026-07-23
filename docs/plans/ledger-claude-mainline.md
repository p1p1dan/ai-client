# Claude 主线台账（🤖）

> 归属：OpenChamber 气泡对话重构 — Claude 主线（复杂/架构攸关任务）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §2
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：Claude（每完成一个 C-xx 任务或重要中间结论加行；里程碑级结果同步总台账）

## 任务状态

| ID | 任务 | 状态 | 备注 |
|---|---|---|---|
| C-01 | agent-host 构建产物与打包配置 | ✅ | 2026-07-23 完成；打包整链验证归 C-02 |
| C-02 | 打包态自动化验证 | ⬜ | → CP2 |
| C-03 | Question 桥 spike | ⬜ | |
| C-04 | Question 桥实现 | ⬜ | |
| C-05 | Thinking 支持度探测 | ⬜ | → CP3 |
| C-06 | Resume 历史重放（协议+Host+Store） | ⬜ | → CP4 协议定稿 |
| C-07 | Session Index（Main + IPC） | ⬜ | 解锁 T-02 |
| C-08 | Store 结构优化 + 批处理 | ⬜ | C-09 先行 |
| C-09 | 测试基建 + lint 恢复绿 | ⬜ | |
| C-10 | Effort/Plan/Build 探测 | ⬜ | Phase 0 遗留 |
| C-11 | stream-json fallback | ⬜ 机动 | 阻塞时提级 |
| C-12 | 旧路径收缩 + 压测 | ⬜ Phase 5 | |

图例：✅ 完成 · 🟡 进行中 · ⬜ 未开始 · ❌ 阻塞

## 过程记录（按时间）

| 日期 | 节点 | 结果 | 证据 / 提交 |
|---|---|---|---|
| 2026-07-23 | 执行计划定稿（CP1），双轨分账结构落库 | ✅ | 本文件 + 执行计划 + 团队台账骨架 |
| 2026-07-23 | C-01 事实摸底：node_modules 424MB 构成与剪枝空间 | ✅ | SDK 平台包 252MB（claude.exe，sdk.mjs 无引用，我方恒传 pathToClaudeCodeExecutable）；Cometix 平台包 26MB（install.cjs 装机时已把 cli.js+vendor 拷入主包，运行时冗余）；node-pty 64MB（prebuilds 58MB 含 4 平台，加载序 build/Release→prebuilds/{platform}-{arch}，根应用先例只留 lib+prebuilds/win32-x64）；@img/sharp-win32-x64 19MB（cometix 可选二进制）。剪后估 ~112MB。SDK 0.3.218 主包无 vendor/cli/wasm（执行计划该备注过时）；`files: out/**/*` 会把产物双打进 asar，产物目录需避开 out/ |
| 2026-07-23 | C-01 评审结论采纳（deep-reasoner GO-WITH-CHANGES） | ✅ | 采纳全部：剪 SDK/Cometix 平台包与 node-pty 子集；保留 `@img/sharp-win32-x64` 兜底（cli.js 加载 sharp 有 try/catch 容错，19MB 保险）；产物用「拷贝开发 node_modules + preflight 断言」而非全新安装（install.cjs 在 `--omit=optional` 下产出无 cli 残包；公司机半离线）；选址仓库根 `out-agent-host/`（避 electron-vite out/ 清理与 `files: out/**` asar 双打）；TSD 修复在 afterPack 端到端收口（electron-builder 复写 extraResources 会再加密，只修中间产物不够）。一处按实调整：评审建议 preflight 校验 cli.js sha256，但 PINNED.md 记录的是 npm tarball hash（无法与拷贝后的 cli.js 直接比对），改用版本 pin + cli.js 存在 + >5MB 断言，防「--omit=optional 残包」目标等效 |
| 2026-07-23 | C-01 完成：构建脚本 + 打包配置 + 产物验收 | ✅ | `scripts/build-agent-host.mjs`：preflight（pin 断言 2.1.212/0.3.218、cli.js>5MB、vendor、node-pty prebuild）→ esbuild bundle（index.ts→out-agent-host/index.js，external SDK+Cometix）→ 剪枝拷贝 424MB→87MB → Windows TSD `.tmp.bin` 修复 → 产物自检；`electron-builder.yml` extraResources `out-agent-host→agent-host`（明文不入 asar）；`afterPack.mjs` 兼扫 `resources/agent-host`。验收：① 产物 initialize→host.ready（cometixVersion=2.1.212，cliPath 解析自产物内 node_modules）；② 产物 PONG smoke ok:true + 产物 permission smoke ok:true + dev 入口回归 ok:true；③ `pnpm build:agent-host` 独立通过（约 4.5s），`dist:prereq` 已挂钩，整链打包验证→C-02。typecheck 绿、改动文件 biome 绿；`pnpm test` 仅 2 个存量失败文件（stash 对照证实与本次无关，归 C-09）。独立验证代理复核 PASS（含 stdin 畸形输入/孤儿会话对抗探测、重建幂等、afterPack 假 pack 功能测试）。hash：`f21fec7` |
| 2026-07-23 | 测试凭证统一约定落库（用户拍板） | ✅ | 执行计划 §4 新增统一约定：测试一律走网关 `cch-jyw.pipidan.qzz.io`（凭证落文档）；Host 侧脚本经 `spikes/testCredentials.ts` 临时 `CLAUDE_CONFIG_DIR` 自动注入，含 onboarding 种子（实测定位：无 `.claude.json` 种子时 cli.js 首跑 onboarding 挂起）；逃生口 `AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1`、`AICLIENT_TEST_AUTH_TOKEN`/`AICLIENT_TEST_BASE_URL` 覆盖。与团队台账「token 不入库」表述的分歧已呈用户裁定 |

## 委派记录

| 日期 | 委派对象 | 任务 | 结论采纳情况 |
|---|---|---|---|
| 2026-07-23 | deep-reasoner（opus） | C-01 依赖剪枝与产物布局策略对抗评审（Q1-Q7：SDK 平台 exe 252MB 可剪性、Cometix 平台包可剪性、node-pty 剪枝、sharp 去留、拷贝 vs 全新安装、产物目录选址、TSD 环境风险） | ✅ 已采纳（GO-WITH-CHANGES，逐条结论见过程记录） |
