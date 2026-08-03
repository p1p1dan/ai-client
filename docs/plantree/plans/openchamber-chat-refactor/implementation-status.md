# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。2026-08-03 前的逐批 Landed/Verified 摘要与已结项点验清单原文已归档 [history/2026-0728-0803-archive.md](./history/2026-0728-0803-archive.md)。

- **Current Phase**: **Phase 0A 基线部分补做（A01 / A05 / A06）→ 观感对齐改造**（2026-07-28 转向）。这三项产品设计基线此前只在可行性文档的候选任务池、从未进执行计划或台账，而下游 F05/H01/H09 已按它们施工——这是「观感不到位 + 死按钮泛滥 + 布局反复卡壳」的同一根因，本日补做并落库（D18 / D19 / D20）。⚠️ **Phase 0A 整体仍 🟡 未收口**：A02 / A03 / A04 仍未立项，且已交付的 A06 依赖列写的正是「A01、A02」（口径以总台账 Phase 总览 0A 行为准）。Phase 3 Chat MVP 的剩余点测与网关阻塞并行不变。
- **Last Landed**:
  - 验收（2026-08-03 第八轮）：**T-31 GUI 点验用户验收通过**（原话「点验完毕，没啥问题」）——0-undecies 十一项全过，**T-31 转 Done**；0-bis / 0-quinquies 随本轮捆绑表态收口，**T-22 / T-05 转 Done**（二~八轮真机连续使用未报异议 + 本轮无异议；T-31 已重排 T-05 挂载结构，其点验面被 0-undecies 覆盖）。§9 六项推荐值与 D26④ 满宽等编排者执行裁定全部获追认
  - 代码+文档（2026-08-03 四批）：**T-31 回复解剖 + 置顶气泡落地 `8109d45`**（36 文件 +4712/−318，测试 1593→1759）——回合层纯推导 + 时间线回合化渲染 / 状态读条迁回合头（turnSendStatus 单槽 owner token + send-begin 基线 × `h:` 前缀双守卫）/ `Worked for Ns ⌄` 折过程段（授权卡强制展开安全红线）/ 置顶气泡 CSS sticky + scroll-state 钉住 3 行截断（η 实测支持；lightningcss 吞规则 → 独立 `styles/scroll-state.css`）/ 尾部条 模型·相对时间·copy / **D26④ 满宽补落（T-30 批2 账实更正）** / §4.5 撤回。Opus+Codex 双轨对抗复核（Opus 2 blocker + 4 major；Codex 4 major 含独有 owner 竞态）+ 修复批三轮 + Codex 终验两轮全闭环；A07 v5 追记 + design-system 连带。红线零改动。**✅ 第八轮 GUI 点验验收通过（2026-08-03）**。明细见主线台账 2026-08-03 T-31 行
  - 验收（2026-08-03）：**第七轮 GUI 点验用户验收通过**（原话「验收完毕，没有问题」）——第六轮两项与全部复核批修复闭环，诊断档结项；实测范围含 aaa 文件夹 New / "+ new chat" / 分支 chip 归属 / 失败退回重发无重复气泡 / 同文连发保留 / 附件与归档关闭对齐。第五轮清单 0-decies 与第四轮失败路径顺延项就此关闭；**0-octies 门槛达成 → T-27/T-28/T-19/T-30批1 转 Done**（见 roadmap）。点验期间一次「No repository registered」经查为 dev server 带病热更新残留态，非代码回归（诊断档附注）
  - 更早批次（2026-07-28 ~ 2026-08-03 三批：五连修/T-21/T-22/T-26/T-27/T-28/T-05/T-19/T-30 批1+批2/第二~六轮点验修复等）：摘要原文见 [history 归档](./history/2026-0728-0803-archive.md)，明细见[主线台账](../../../plans/ledger-claude-mainline.md)各行
- **Last Verified**:
  - **2026-08-03 四批复核（T-31 `8109d45` 合并态）**：typecheck 干净 / lint **718 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **97 文件 1759 例**（+7 文件 +166 例；同 3 例 Windows-only 失败）/ `pnpm build` 成功且产物含 `@container scroll-state(stuck: top)` 规则（lightningcss 管线绕行有效性的产物级验证）。
  - **2026-08-03 三批复核（第六轮修复 `fd55a26` 合并态，T-31 开工前基线实测）**：typecheck 干净 / lint **703 文件 0 错误**（29w+3i 既有 a08 豁免）/ vitest **90 文件 1593 例**（+2 文件 +56 例；同 3 例 Windows-only 失败）。
  - 更早复核记录（2026-07-28 基线 51 文件 590 例起，全程只增）与 T-21 复核口径注记：见 [history 归档](./history/2026-0728-0803-archive.md)
- **Next Target**（2026-08-03 八次修订，第八轮验收结项）：开发线下一项 **T-29 Markdown 渲染**（D26，≈2d，任务定义见执行计划 §3 T-29 行；T-31 已为其留出稳定单点替换位）→ **T-24 收尾**（S0：全新机器 GUI 实测 + 台账补登，代码已随 `b38017b` 落库，不改代码）→ **T-12/T-13/T-14/T-15**（四 surface，均依赖 T-22 已清；A08 临时基线正式化随行）→ **T-23** 存量违规清理。**残留**：0-nonies ⑪（a09 改后截图回填 + D25 §6.2 五项真机指标，Win10 必测字重）未采集；网络环境复测（open-q **#22**）；授权 FIX 3（open-q **#23**）；**T-04 网关阻塞**与 **#15 缓存复测裁定**并行。**backlog**：历史侧回合时长源（恢复回合现无 `Worked for` 秒数，头槽降级链有意为之）；`ran N command(s)` 聚合复议（需 A07 :1769-1772 基线修订）。

> ⚠️ **门禁口径依机器而异（2026-07-27 新增，07-28 扩充）**：Linux 检出上「全绿」不成立。3 例
> Windows-only 断言在 Linux 上不可能通过——`ShellDetector.test.ts` 2 例（断言
> `powershell.exe`）、`CliDetector.test.ts` 1 例（cmd fallback）。**Linux 上的三绿口径 =
> typecheck 干净 / lint 0 诊断 / test 只剩这 3 个失败且总例数只增不减**；Windows 上仍应全绿。
> **Linux 机每次 `pnpm install` 后必须两步复原**（否则 app 起不来、T-07 集成 6 例红）：
> ① `npx electron-builder install-app-deps`（重建 sqlite3 等 Electron ABI）；② 把
> `src/agent-host/node_modules/@cometix/claude-code/vendor/ripgrep/x64-linux/rg` 拷进
> `node_modules/@vscode/ripgrep/bin/rg`（postinstall 被 GitHub 403 挡）。下载类脚本另需
> `NODE_USE_ENV_PROXY=1`。联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)。
> **2026-07-29 更正**：第 ① 步原写「必须用可用代理覆盖 `~/.npmrc` 里的 `127.0.0.1:7890`」——
> **实测不需要代理**，Electron 39.2.7 头文件本就缓存在 `~/.electron-gyp/39.2.7`，直接跑即可。
>
> ⚠️ **GUI 启动口径（2026-07-29 变更）**：一律 `node scripts/dev.js`，**不要用 `pnpm dev`**——
> pnpm 10 的 `verifyDepsBeforeRun` 会在跑脚本前重装依赖，冲掉上面两步复原的成果。
> 凭证改由仓库根 **`dev.env`**（gitignore，模板 `dev.env.example`）在启动期注入，dev.js 会剥离
> shell 继承的全部 `ANTHROPIC_*` 并把 `CLAUDE_CONFIG_DIR` 指向隔离目录；**缺文件直接拒绝启动**。
> 这取代了原先手工 `CLAUDE_CONFIG_DIR=... ` 的做法；`pnpm prepare:test-config` 仍可用但不再是主路径。
> 覆盖面缺口（打包版 / preview 不经 dev.js）见 open-q **#14**。

## 2026-07-28 观感对齐转向（摘要，正文见台账）

| 编号 | 一行摘要 | 去向 |
|---|---|---|
| **D18**（撤销 D6） | 对齐 OpenChamber 观感 = Flexoki 主题 + 全等宽字体 + 卡片形态三者一并对齐 | 代码落地 **T-21**；风险 open-q **#10 / #11 / #12** |
| **D19**（撤销 D15） | 三列 + 44px 图标导轨 + surface 模型，**废弃底部面板** | 壳改造 **T-22**；连带 T-12/T-13/T-14/T-15 重定义 |
| **D20** | 问答卡保留「就地冻结」，不照搬 OpenChamber「回答后消失」——登记为偏离 | 解除前置 **C-17**（后置） |
| **A01 / A05 / A06** | 三项设计基线补登并交付，产物统一为对齐基线 HTML（**A02 / A03 / A04 未立项，Phase 0A 整体仍 🟡**） | 违规清理 **T-23**；新壳添加仓库 **T-24**（阻断级） |

决策原文与依据一律看[总台账](../../../plans/openchamber-chat-refactor-ledger.md) D18~D20，本树不复制。
架构改口见 ARD 十二节（清单见 [ARD 修订头](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md)，2026-07-28 复验轮更正：原写七节已过期）。

## #8 结论（2026-07-27）

| 项 | 结论 |
|---|---|
| T-04 thinking 空白真凶 | ✅ `display` 默认 `omitted`。实测：裸 `{type:'adaptive'}` → thinking 块 1 个但文本 **0**；加 `display:'summarized'` → 文本 **408** 字符 |
| C-14「400 thinking 格式无效」根因 | ❌ **原假说被推翻**——`{type:'enabled', budgetTokens}` 实测仍返回 200。open-questions #5 **保持 open** |
| `effort` 位置 | ✅ SDK 顶层 `Options.effort`，**不是** `output_config.effort`（更正 C-10 台账行） |
| T-20 协议底座 | ✅ `session.create.effort` / `session.send.effort` 已落（纯可选加法，未 bump 协议版本）；选择器 UI 已于 `4c3f67e` 补齐全链 |

证据：`spikes/c16-thinking-shape-probe.ts`（SDK 层五场景）+ `spikes/c16-thinking-host-smoke.ts`（真 Host NDJSON 全链）+ `__tests__/claudeRuntimeOptions.test.ts`（10 例钉死 options）。

## 首轮 GUI 联调结论（2026-07-26）

| 任务 | 结论 | 说明 |
|---|---|---|
| T-02 会话生命周期 | ✅ Done | 标题 bug 已修并复验通过；归档无 un-archive 入口 = 设计缺口，转 open-questions #6 |
| T-03 Resume 历史 | ✅ Done | 重放机制 2026-07-26 已复验通过；缺的历史读失败 UI 已于 2026-07-27 `7a5c2cd` 补齐（三码可区分 + 非致命表达 + read_failed 可 Retry），等 GUI 点验 |
| T-04 Thinking 卡 | 🔴 **卡在网关**（2026-07-28） | 用户实测无卡。探针实证（各 2/2）：GUI 默认 `sonnet` 在本网关返回**空文本 thinking 块**（不理会 `display:'summarized'`）；#8 验证过的网关默认模型今日**确定性 400**。渲染链逐门核查无 bug。**app 侧无可修**，等网关侧处理（open-questions #5/#8） |
| T-06 元数据/重试 | ⬜ 未测 | 唯一完全未碰的任务，不受上述 bug 影响，可直接补测 |
| T-07 `@` 引用 | ✅ Done | P0 反斜杠已修并复验通过；三项补强（目录 / 隐藏文件 / 截断提示）+ 同分定序已于 2026-07-27 `0f886a8` 落地，等 GUI 点验 |

Tool 卡不折叠 = T-05 未开发，**非 bug**（且 T-05 口径已于 2026-07-28 整体重写：工具行改为**无边框无徽章单行**，见下）。

## Active TODO

> **顺序权威 = [执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3**；任务定义、数值与 `file:line` 只存在于该表，此处只留「ID + 一行目标」。
> 2026-07-28 重排版开发线原文（T-24~T-23 六项，均已落库或后置）见 [history 归档](./history/2026-0728-0803-archive.md)。

### 开发线（按序）

1. **T-29 Markdown 渲染**（D26）：assistant 正文 react-markdown+shiki，chat 专属映射零 XSS 面，流式期纯文本完成后切。→ 执行计划 §3 T-29 行
2. **T-24 收尾**（S0，不改代码）：全新机器 GUI 实测 + 台账补登（实体已随 `b38017b` 落库）。→ 执行计划 §3 T-24 行
3. **T-12 / T-13 / T-14 / T-15 四 surface**（依赖 T-22 已清）：git / editor / context / terminal 各 surface 接线；A08 临时基线正式化随行。→ 执行计划 §3 各行
4. **T-23 存量违规清理**（A06 矩阵产出）：死按钮与假 usage 环逐项接线或 disabled+Tooltip。→ 执行计划 §3 T-23 行

> T-25（旧模块原色清理，依赖 T-21）与 T-16（新旧壳开关）后置，归 [roadmap Deferred](./roadmap.md)。

### 用户线（点测 / 待拍板，与开发线并行）

0. **✅ 点验清单 0 ~ 0-undecies 全部结项**（第二~八轮，2026-07-30 ~ 2026-08-03；唯 **0-nonies ⑪ 真机指标未采集**仍待用户），清单原文见 [history 归档](./history/2026-0728-0803-archive.md)。
1. **T-04 / T-07 GUI 验收**（用户人工，统一点测）：联调环境见
   [baseline 门禁「GUI 联调环境」](../../baseline/test-and-release-gates.md)（2026-07-29 起：填好 `dev.env` 后 `node scripts/dev.js`，勿用 `pnpm dev`、勿硬编码路径）
   - **T-04 thinking 卡**：🔴 **当前无法点验**——卡在网关（sonnet 空文本 / 默认模型 400，见上表）。网关侧修复后再测；仍须在**新发起轮次**验证（旧 fixture 的 153 个 thinking 块文本为空，不可追溯）。
   - **T-07 补强**：`@` 输入 `src/` 应见目录条目（黄色文件夹图标 + 尾随 `/`）；输入 `git` 应见 `.gitignore` 等隐藏文件；输入 `chat` 右下角应显示 `10/319`。
   - **T-20 Effort 选择器**：Composer 右下角 ModelSelect 旁应见新的档位下拉（默认显示 `Default`）。选 `X-High` 后重启应仍保持；**`Default` 与 `High` 是不同选项**——前者不下发 `effort`、保持模型默认。
   - **T-03 历史读失败提示**：造错的最快办法是把 `session-index.json` 里某条的 `runtimeIdentity` 改成一个不存在的 uuid 再 resume → 应见黄色告警「History file not found」，且**不再显示** "No messages yet"，输入框仍可用。`read_failed` 档才有 Retry 按钮；会话进行中时 Retry 应为禁用并说明原因。
   - **T-18 粘贴附件**（`703f981`，**本轮全部为人工待测**，Linux 环境起不了 Electron）：
     ① **纯文本粘贴回归——最重要**：Ctrl+V 普通文本/多行代码必须还是原生插入，一个字不丢；
     ② 截图工具粘贴 → 出现带缩略图的 chip；Explorer 复制文件粘贴 → 出现 chip **且路径文本照常插入**；
     ③ 中文输入法合成态下粘贴不打断候选词；粘贴后 `@` 引用弹窗仍正常；
     ④ 超限提示：>5 MB 图 / >512 KB 文本 / 第 6 个附件 / bmp-tiff-heic 格式 / 8000px 超限，各自应有可读文案；
     ⑤ 发送中：Send 变 Stop、秒数在走、45s 后转警告色；**双击 Send 与连按 Enter 都只发一次**；
     ⑥ **jpeg / gif / webp 至今未过网关实测**（自动化只验了 PNG 与 text/plain），请各发一张确认；
     ⑦ 失败后 chip 保留且 Retry 带着附件重发；健康会话里粘图**不应**出现 Retry 按钮。
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）
3. T-10 打包版点验（用户，[清单](../../../plans/t10-packaged-gui-checklist.md)）→ **CP2 汇报**
4. C-15 体积 141MB（+21MB）可接受性——等用户拍板
5. ~~T-19 消息队列提案——等用户落库~~（**已过期**：T-19 已复活、落地并于第八轮前转 Done，见 roadmap）
5-bis. ~~布局呈现层四点拍板~~（**2026-07-29 已收口**：#16 四点当日拍板 → D21~D23 落总台账，T-26 已落库 `dd23b01`、A07 已定稿）；**#15**（网关缓存亲和）改判「待复测裁定」——GUI 重启连发两条看第二条有无缓存读取，裁定前暂缓联系运营方
6. **给主线的需求（T-03 / T-18 / 07-28 衍生，共 8 条）**：① `session.history` 的 `truncated` / `omittedCount` 全链路无展示；② **用户气泡不回显附件**——`beginTurn` 只 emit 文字，用户发完图后时间线上没有任何证据表明图发出去了（Renderer 无法自救）；③ 看门狗把整个上传窗口计入 stall，是未来提高附件上限的硬天花板；④ 协议可选加 `document`(PDF)；⑤ store 的 `sendMessage(text, attachments?)` 无人调用、无覆盖，与 Composer 的 `runSend` 双路径漂移；⑥ **`session.create` 应校验 workspacePath 存在性**（坏路径现在 created+idle、到 send 才泛化报错）；⑦ ~~resume 重放与存活 live 时间线会视觉双份~~（**已根治**：第六轮 `fd55a26` historyReplayMerge 三重护栏）；⑧ thinking 空块（带签名无文本）要不要渲染「已思考」指示——待用户拍板。详见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27/07-28 各行。

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）

## Handoff Notes

- **观感对齐的唯一基线（2026-07-28 新增）**：[`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（A01 / A05 / A06 统一产物，用户已验收）。颜色、字体、区域尺寸、工具行与问答卡形态一律以它为准，**业务组件不得自行发明视觉值**；与其冲突时先回台账 D18 / D19 核对，不要就地拍脑袋改。
- 提交习惯：pathspec 提交保留（非强制）；三绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- 同事交接词两处过时勿信：「biome CRLF 行尾债」（C-09 后 lint 0 诊断）、「T-05 Question 等 C-04」（C-04 已 ✅）。
- **`ui/alert.tsx` 的 variant 是 `error` / `warning` / `info` / `success` / `default`，没有 `destructive`**（那个只存在于 button.tsx 与 badge.tsx）。写「借鉴 destructive 错误条」的交接词时要注意这一点，照字面写会编译不过。
- **UI 逻辑一律下沉纯函数**：vitest 是 `node` 环境且 include 只收 `.ts`，`.tsx` 里的逻辑零覆盖。现成范式 `hostStatus.ts` / `fileMention.ts` / `sessionEffortStore.ts` / `historyError.ts` / `sendPreamble.ts` / `hostStderr.ts`。
- **新机器首启注册仓库**：OpenChamber 壳内**仍**无添加仓库 UI（`SKIP_ONBOARDING_GATE=true` 硬编码 + 两处覆盖使旧壳不可达）。当前唯一通路：`pnpm dev -- --open-path=<仓库绝对路径>`（`576f3bd` 起 dev.js 透传 argv；`9331d51` 起首启拉取握手保证不丢）。**2026-07-28 起归 T-24（阻断级）+ T-16 处理，open-questions #9 已关闭**；T-16 要拆的是 `App.tsx:450` 与 `Root.tsx:52-59` 两处强制覆盖，`devFlags.ts:10` 是两者的**共同开关**——翻 `false` 能一并解除，但会连带恢复 onboarding 闸门，故**不作为达成手段**（验证时保持 `true`）。口径以[执行计划](../../../plans/2026-07-23-openchamber-chat-refactor-execution-plan.md) §3 T-16 行为准。
- **T-05 / 布局类交接词已整体过期（2026-07-28）**：凡提到「带边框工具卡 + 状态徽章」「按行数截断 + 展开全部」「四区壳」「底部终端 Dock」「右栏三 tab」的旧描述一律作废，以 D18 / D19 / D20 与对齐基线 HTML 为准。（例外：[baseline/module-map](../../baseline/module-map.md) 里的四区表述是**代码现状**，已就地标注 D19 改造去向，不属过期交接词。）
