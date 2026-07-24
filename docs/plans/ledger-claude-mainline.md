# Claude 主线台账（🤖）

> 归属：OpenChamber 气泡对话重构 — Claude 主线（复杂/架构攸关任务）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §2
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：Claude（每完成一个 C-xx 任务或重要中间结论加行；里程碑级结果同步总台账）

## 任务状态

| ID | 任务 | 状态 | 备注 |
|---|---|---|---|
| C-01 | agent-host 构建产物与打包配置 | ✅ | 2026-07-23 完成；打包整链验证归 C-02 |
| C-02 | 打包态自动化验证 | ✅ | 2026-07-24 完成；M1 自动化半边齐，GUI 点验 → T-10 → CP2 |
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
| 2026-07-23 | 测试凭证统一约定落库（用户拍板） | ✅ | 执行计划 §4 新增统一约定：测试一律走网关 `cch-jyw.pipidan.qzz.io`（凭证落文档）；Host 侧脚本经 `spikes/testCredentials.ts` 临时 `CLAUDE_CONFIG_DIR` 自动注入，含 onboarding 种子（实测定位：无 `.claude.json` 种子时 cli.js 首跑 onboarding 挂起）；逃生口 `AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1`、`AICLIENT_TEST_AUTH_TOKEN`/`AICLIENT_TEST_BASE_URL` 覆盖。与团队台账「token 不入库」表述的分歧已呈用户裁定。hash：`0c868c0` |
| 2026-07-24 | C-02 断言与辅助工具落地 | ✅ | `scripts/verify-packaged-app.mjs`（app 壳/agent-host 结构与剪枝断言、TSD header 哨兵、Node24 寻径复刻、复用 PONG spike 对打包产物冒烟+失败重试一次）——先以「真产物+假 app 壳」自测全绿；`scripts/make-test-claude-config.mjs`（GUI 点验走网关凭证，`pnpm prepare:test-config`，利用 AgentHostProcess `{...process.env}` 透传 + claudeSettings CLAUDE_CONFIG_DIR，兼答复团队台账 T-17 行需求——无需改 Host 代码）；T-10 清单 `t10-packaged-gui-checklist.md`；**CI build.yml 两个打包作业补 agent-host 构建+结构断言步骤（原配置缺失，下次打 tag 必炸）**；build-agent-host.mjs 兼容 Linux node-pty 无 prebuild（npm 包仅带 darwin/win32 prebuilds，Linux 装机编译进 build/Release；仅在无对应 prebuild 时收纳 build/Release，防 Windows 产物误载本机编译版） |
| 2026-07-24 | vflow 移除 Phase A（用户拍板：vflow 不再需要） | ✅ | 背景：本机 dist:prereq 被 prepare:vflow 卡死（GitHub Packages 401；包不在公共 registry；本机无 sibling 仓库）。用户拍板整体移除。委派 fast-worker 执行：package.json 摘 prepare/assert:vflow、`dist:prereq` 简化为 `build && build:agent-host`；electron-builder.yml 摘 vflow/vflow-pkg 两条 extraResources；CI 摘两作业 vflow 步骤；删 prepare/assert 脚本 + 2 个测试文件 + fixtures。副产物：**`pnpm test` 首次全绿（21 文件/111 用例）**——原 2 个存量红文件即 vflow 测试。遗留：`scripts/sync-vflow-resources.mjs` 孤儿脚本删除待用户确认（权限策略要求用户裁定）；运行时代码摘除立项 Phase B（已核实缺资源时优雅降级：AgentInstaller 返 null 走原错误、VflowService 存在性检查，开发机日常即此状态） |
| 2026-07-24 | Host 修复：SDK 流结束无 result 时补发终态（团队红线需求⑤） | ✅ | 团队（Cursor）定位：`claudeRuntime.ts` 流结束无 result 事件时仅静默改 registry 状态、不发事件 → UI 永驻 running。修复：normalizer 增本轮 `sawResult` 标记 + `finishTurn()`（result 已发终态→no-op；有 assistant 输出→补 message/session.completed + status idle；全程无 assistant 输出→session.failed + status failed，把网关挂起显性化）；runtime 该分支集成并清理孤儿 permission。关键陷阱：正常完成后 `session.status` 仍是 'running'（无回写），该分支每轮必走——靠 sawResult 防重复终态。单元 spike `spikes/phase2-stream-end-unit.ts` 三场景绿。协议影响：无新事件类型、无 bump；行为变化已记总台账并通知团队 |
| 2026-07-24 | C-02 断言脚本首战立功：打包产物 node_modules 丢失 | ✅ | 首次真打包后 `verify:packaged` 抓到 `resources/agent-host` 仅 0.0MB（index.js+package.json，node_modules 整树缺失）。根因：electron-builder 对每个 extraResources 拷贝强制注入 `!**/node_modules/**`（app-builder-lib fileMatcher.js:126-138），仅当 filter 显式含 `node_modules/` 模式时该排除被插至其前、由后者重新包含。第一版修复（filter 重新包含）引出第二个问题：87MB/万级文件的 extraResources 并行拷贝与 rcedit 改写 AiClient.exe 版本资源发生竞态（"Unable to commit changes"，加 filter 后 0/3 复现，唯一成功恰是无 node_modules 的那次；手动对静止文件跑 rcedit 正常）。**最终方案：撤销 extraResources 条目，改在 afterPack.mjs 钩子串行拷贝 out-agent-host → resources/agent-host**（打包主流程后执行、无并发争抢，同钩子顺路做 TSD 修复；缺产物时 fail loudly 提示先跑 build:agent-host）。C-01 阶段「假 app 壳」自测测不出此层，正是 C-02 打包态验证的价值所在 |
| 2026-07-24 | **C-02 验收：完整打包链 + 打包态全量断言 PASS** | ✅ | `pnpm dist:prereq`（build + build:agent-host）→ `electron-builder --win portable` → afterPack 串行拷贝 87.0MB 产物 + TSD 修复 2386 文件 → `dist/AiClient-0.3.4-portable.exe`（约 120MB）。`pnpm verify:packaged` 全绿 22 项：app 壳 / agent-host 结构与剪枝 / TSD header 哨兵 / Node24 寻径（nvm v24.18.0）/ **打包产物直跑网关 PONG 冒烟**（host.ready cometixVersion=2.1.212；产物含当日 stream-end 修复，兼作该修复集成回归）。全量回归：typecheck 绿、`pnpm test` 111/111 绿。GUI 手工点验清单移交 T-10（`t10-packaged-gui-checklist.md`）。hash：`dbb20be`（build 链）/ `6a633d6`（Host 修复） |

## 委派记录

| 日期 | 委派对象 | 任务 | 结论采纳情况 |
|---|---|---|---|
| 2026-07-23 | deep-reasoner（opus） | C-01 依赖剪枝与产物布局策略对抗评审（Q1-Q7：SDK 平台 exe 252MB 可剪性、Cometix 平台包可剪性、node-pty 剪枝、sharp 去留、拷贝 vs 全新安装、产物目录选址、TSD 环境风险） | ✅ 已采纳（GO-WITH-CHANGES，逐条结论见过程记录） |
