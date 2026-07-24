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
| C-03 | Question 桥 spike | ✅ | 2026-07-24 完成；官方机制 = permission 流 + updatedInput.answers |
| C-04 | Question 桥实现 | ⬜ | 设计输入已齐（C-03 行），CP3 后即做 |
| C-05 | Thinking 支持度探测 | ✅ | 2026-07-24 探测+收尾全完成（CP3 拍板默认开，`8449e88`）；T-04 解锁 |
| C-06 | Resume 历史重放（协议+Host+Store） | ✅ | 2026-07-24 完成；CP4 定稿 + 全链实现 + 网关端到端 smoke 过，T-03 解锁 |
| C-07 | Session Index（Main + IPC） | ✅ | 2026-07-24 完成，T-02 已解锁 |
| C-08 | Store 结构优化 + 批处理 | ⬜ | C-09 先行 |
| C-09 | 测试基建 + lint 恢复绿 | ⬜ | |
| C-10 | Effort/Plan/Build 探测 | ✅ | 2026-07-24 完成；仅 xhigh 有实证、plan 非硬只读；UI 承接待 CP3 |
| C-11 | stream-json fallback | ⬜ 机动 | 阻塞时提级 |
| C-12 | 旧路径收缩 + 压测 | ⬜ Phase 5 | |
| C-13 | 附件协议探测与桥接 | 🟡 | spike ✅（协议方向已定）；桥接实现排 CP3 后 |
| C-14 | Host 挂起看门狗 | ⬜ | CP3 立项（2026-07-24），排 C-04 后；规格见执行计划 §2 |
| C-15 | 随包 Node 运行时 | ⬜ | D17 立项（2026-07-24）；白名单按进程名（用户口径，T-11⑥ 实证）；规格见执行计划 §2 |

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
| 2026-07-24 | vflow 移除 Phase B：运行时代码整体摘除（D16 收口） | ✅ | 用户复确认「彻底摘除」后委派 fast-worker：删 VflowService+测试、shared/types/vflow.ts、VFLOW_PROJECT_INITIALIZED 通道、preload 桥、App toast 监听、onboarding vflow 步骤与文案、设置条目、CliDetector 条目、AgentInstaller 安装/离线兜底分支（净 -89 行）及 4 个专属用例、孤儿脚本 sync-vflow-resources.mjs；类型联合收缩（AgentCliType/InstallAgentId/InstallStepId）。验证（先定标准后动手）：src+scripts+配置 grep vflow 清零（抽查复核 exit 1）、typecheck 绿、测试 20 文件/103 用例全绿（-8 例均为 vflow 专属）。累计净删约 -1360 行。hash：`eac23f7` |
| 2026-07-24 | 用户反馈映射落库（F1-F5）+ 新任务 C-13/T-18 | ✅ | 执行计划新增 §7 映射表：F3/F4/F5 验证重构方向（气泡化/真实文本域/四区并排）、F1 → T-05 验收增强（工具卡路径可点击跳转）+T-13 联动、F2 → 新增 C-13（附件协议 spike+桥接，主线）与 T-18（Composer 粘贴 UI，团队，依赖 C-13）。两条子台账任务表已同步 |
| 2026-07-24 | C-07 完成：SessionIndexService + 3 条 chat IPC（解锁 T-02） | ✅ | Explore 地形扫描定关键设计：① runtime 事件不带 workspacePath/model → 索引在 `CHAT_CREATE/RESUME_SESSION` IPC 入口捕获，事件仅富化 runtimeIdentity；② 持久化镜像 RemoteConnectionManager 成熟模式（原子写 tmp+rename、懒加载在途去重、串行 flush 队列），存 `userData/session-index.json`；损坏 JSON warn 后空索引启动。fast-worker 按逐文件规格实现，8 项单测（round-trip/损坏容错/updatedAt 降序/事件富化/tmp 无残留）全绿；全套 21 文件/111 用例、typecheck 抽查复核通过。store 侧 hydrate（initRuntime 接 listSessions）按计划归 T-02 联调。hash：`f6807c9` |
| 2026-07-24 | C-06 协议草案 + fresh-fable 对抗评审吸收（后经 CP4 定稿） | ✅ | 草案 `2026-07-24-c06-session-history-protocol-draft.md`：`session.history` 批量事件（resumed→history→idle，读失败非致命）+ `session.listHistory`/`session.historyListed`（Main `requestAndWait` promise 化）+ `session.updated`（补身份缺口：SDK session_id 中途发现只写 Host registry 无事件回传，应用内会话索引 runtimeIdentity 恒空，重启 resume 不成立）+ `host.ready.capabilities.history`；Host `historyReader`（resume 按 uuid 文件名定位绕开 munge 有损性、宽容解析、流式双侧裁剪）。协议纯增量不 bump 版本。对抗评审裁定 GO-WITH-CHANGES，12 findings 全采纳，要害：F-1 BLOCKER（running 会话 resume 重入孤儿化运行中 turn + 整段替换吞流式消息 → session_busy 拒绝 + registry merge + store 按 `h:` 前缀替换）、F-2（SDK forkSession 默认 false，分叉叙事降级为防御性覆盖+回归钉子）、F-3（实测最大会话 3.97MB/1293 行，补输入侧 32MB tail + user text 64KB）、F-4（Host 非白名单读到密文会静默空历史 → TSD magic 探测 + `encrypted_unreadable`，入 T-11⑤）、F-5（Host 命令循环串行 → 历史读取异步化；requestAndWait 补进程 exit 即 reject）。评审附真实数据盘点：12 JSONL/1669 行、配对模拟 0 孤儿 0 悬空、munge 3/3 吻合、4 种未记行型补入分类表 |

| 2026-07-24 | **C-06 完成：Resume 历史重放全链落地（解锁 T-03）** | ✅ | 定稿协议全量实现：shared 三文件（sessionHistory.ts 新建 + runtimeEvents 三事件/capabilities + agentHost 新命令）；Host historyReader（922 行：uuid 文件名定位、宽容解析 controlLines/badLines 分账、合并配对、输入 32MB tail + 流式裁剪、TSD magic → encrypted_unreadable）+ runtime 改造（session_busy 拒绝、registry merge、resumed→history→idle 异步时序、session.updated）；Main requestAndWait（exit 即 reject）+ chat:listHistory IPC/preload + 索引富化；store h: 前缀幂等替换 + historyErrors + 权限卡排除。**实现要点**：tsconfig 排除 agent-host → typecheck 不覆盖 Host 侧，端到端 smoke 是 Host 集成的真实门禁。验证：新增 49 单测（A28/B9/C12）→ 全套 27 文件/181 用例绿、typecheck 干净、改动文件 biome 绿；**验收 smoke `spikes/c06-resume-history-smoke.ts` 真实网关 ok:true**——capabilities.history / session.updated 身份发现 / resumed→history→idle 时序 / 历史含码字 + h: 前缀 / running 会话 resume 拒绝 session_busy / resume 后追问召回码字（ORANGE-42 式）逐项断言通过。工作树中团队 ChatComposer 在途改动已避让未混入。hash：`db41f63` |

| 2026-07-24 | C-05 收尾：thinking 默认开 + capabilities + store thinking 块（CP3 拍板执行） | ✅ | claudeRuntime enabled(budget 4096)；host.ready.capabilities `{history, thinking}`；store ChatBlockType 增 thinking + thinking.started/delta 处理 + 历史 thinking 块入渲染数据（T-04 数据面就位）。验证：28 文件/184 用例绿、typecheck 干净；Host smoke 事件链完整（**thinking 事件网关侧非确定**——两跑均未引出，与 C-05 spike 观测一致，管线以单测+spike SDK 层验证为准，GUI 实证归 T-04 验收）。**附**：首跑 90s 停滞复现「答案已到流不收尾」——C-14 看门狗立项依据+1。hash：`8449e88` |
| 2026-07-24 | 四路支持度探测（C-03/C-05/C-10/C-13 并行，用户要求提并发） | ✅ | **C-03**：AskUserQuestion 走 canUseTool 权限流是**官方机制**（`AskUserQuestionInput.answers` 字段注释即 "User answers collected by the permission component"），三分支实测通过；最大 footgun：bare allow（无 updatedInput）被 cli.js 静默作废重问（仅源码可见）；取消建议映射 allow+空 answers（不产生 denial 记录）；自由文本走 `updatedInput.response`；超时可下沉 SDK `askUserQuestionTimeout`。**C-05**：thinking enabled 单轮+多轮 resume（签名 thinking 历史回放）8 turn 零 400——`claudeRuntime.ts` disable 防御已过时；normalizer 现链路够用（assistant content 路径），stream_event 分支为死代码（未开 includePartialMessages）；注意 disabled 非强保证（对照组一次跑出 thinking 块）+ 延迟上浮（最慢 75s）。**C-10**：effort 仅 xhigh 有可测差异（cache miss + inference_geo=global + 绕过 thinking:disabled），其余档位与非法值签名相同（不校验）；permissionMode 全枚举 default/acceptEdits/auto/bypassPermissions/manual/dontAsk/plan（CLI 层校验）；**plan 非硬只读**——模型照样调 Write，只读约束须 canUseTool 侧识别 plan 自行拒绝；acceptEdits/auto/dontAsk 旁路 canUseTool；bypassPermissions 安全阀非硬约束；**非法 model 不快速失败、会话挂死**（→ 拟立项 C-14 看门狗）。**C-13**：SDK 消息流 prompt 携带 base64 image/document 块全部实测可行（152KB 大图过网关），推荐 `attachments[]={kind:'image'\|'text', mediaType, data, name?}`，path 不进协议；Host 改造是加法（string prompt 包成单元素消息流）；大图延迟显著（152KB→79s），T-18 需发送中状态。四 spike 落库 `9bda9e5`。C-03+C-05+C-10 → CP3 汇报 |

| 2026-07-24 | 用户关键信息两条：白名单口径 + 备用网关（风险 #1 降级） | ✅ | ① **TSD 白名单按进程名**——「只要是 node 就是白名单」（待 T-11⑥ 实证）：C-06 加密机风险从「架构级未知」降为「待实证」；据此并依用户意向立项 **C-15 随包 Node**（D17，解 T-09 自装痛点；ARD 查证：D1「独立」原义为独立进程且曾以「白名单未经证明」否决随包路线——该前提已被新口径推翻，Electron 内嵌路线仍不可行因进程名不匹配）。② 备用网关 `api.vllmproxy.com` PONG 实测通过，凭证入执行计划 §4（延迟同级；双端点同时刻齐挂一轮——波动确系环境性，C-14 依据+1）。另：T-19 让号 T-20（`9d37df0`），T-19 留给消息队列提案（内容待用户提供） |

## 委派记录

| 日期 | 委派对象 | 任务 | 结论采纳情况 |
|---|---|---|---|
| 2026-07-23 | deep-reasoner（opus） | C-01 依赖剪枝与产物布局策略对抗评审（Q1-Q7：SDK 平台 exe 252MB 可剪性、Cometix 平台包可剪性、node-pty 剪枝、sharp 去留、拷贝 vs 全新安装、产物目录选址、TSD 环境风险） | ✅ 已采纳（GO-WITH-CHANGES，逐条结论见过程记录） |
| 2026-07-24 | Explore | C-06 地形扫描（Scanner munge 规则、真实 JSONL 行格式、resume 链路、协议 envelope、store reducer、ARD D11） | ✅ 事实报告全量用于草案；发现身份富化缺口（§1.6） |
| 2026-07-24 | fresh-fable（独立无偏见） | C-06 协议草案对抗评审（源码 12 文件 + 真实 JSONL 12 文件/1669 行独立核实 + 解析模拟） | ✅ GO-WITH-CHANGES，12 findings（1 BLOCKER/4 MAJOR/6 MINOR/2 NIT）全采纳，Q1-Q6 逐条裁定（草案 §10） |
| 2026-07-24 | fast-worker ×3 并行（用户要求提并发） | C-06 实现分片：A historyReader+28 测；B Main 侧 requestAndWait/IPC/preload/索引+9 测；C store 灌入分支+12 测（Host runtime 并发敏感部分 Claude 亲做） | ✅ 三片零文件冲突合入；A 报出 tsconfig 排除 agent-host 的坑（typecheck 不覆盖 Host，靠 smoke 补位）；B 顺手修 2 处存量 import 序；偏差均已明报采纳 |
| 2026-07-24 | 探测代理 ×4 并行（claude ×2 + fast-worker ×2） | C-03 Question 形态 / C-05 Thinking 支持度 / C-10 options 逐项 / C-13 附件通道——全部 spikes/ 新文件零冲突、只探测不改运行时、不提交 | ✅ 四份结论全采纳（过程记录同日行）；C-10 顺带挖出运行时挂起缺口（→ C-14 拟立项）与 T-08/T-09 已完结、Effort/Plan 无下游工单的台账缺口 |
