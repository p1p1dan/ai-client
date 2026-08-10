# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。
> 逐批 Landed / Verified 摘要与已结项点验清单原文归档：
> [2026-07-28 ~ 08-03](./history/2026-0728-0803-archive.md) ·
> [2026-08-08 全文快照](./history/2026-0808-implementation-status-archive.md)（本文件瘦身前原文，含 0-duodecies ~ 0-novodecies 六份清单）。

- **Current Phase**：**开发线全部收口 → 真机点验期**（2026-08-06 第十二轮点验后）。
  观感对齐批次（2026-07-28 转向，D18/D19/D20）的开发线任务 T-29 / T-12~T-15 / T-23 / T-32 / T-16 / T-33 / T-35 / T-34 全部 Done。
  ⚠️ Phase 0A 整体仍 🟡：A02 / A03 / A04 未立项（口径以总台账 Phase 总览 0A 行为准）。
- **Last Landed**（2026-08-07 施工 / 08-08 提交）：**测试机五问题修复批 `9a6cc01`** ——
  M1 附件历史重放去重（replacement fold）· M2 超时 115→180s（Host stall 195s）· M3 新壳补仓库移除入口
  （提交前修正：取键改 `projectIdForRepo()` 精确匹配）· M4 分支查询加重试 `retry:1`——**2026-08-09 复核判定为空改动**（`retry:1` 本就是全局默认；且 `refetchOnWindowFocus` 默认 true 已使失败查询每次聚焦即重发，「瞬时失败」假说 08-07 当天即被证伪）。真因仍未定，已给出五选一判别器与现场三步取证，见[测试方案「R4 已改判」](../../../plans/2026-08-06-encrypted-machine-test-plan.md)·
  M5 判定为 M1 的视觉后果。随后版本抬 **`0.4.0-test.2`**（`ff63987`）。
  更早各批（08-04 ~ 08-06 各任务与十二轮点验）：一行摘要见 [roadmap Done](./roadmap.md)，
  明细见[主线台账](../../../plans/ledger-claude-mainline.md)，当时活动状态原文见 history 归档。
- **Last Verified**：2026-08-08 `9a6cc01` **四门全绿**（lint / typecheck / typecheck:agent-host / vitest **2481 例 0 红**）。
  3 例 Windows-only 恒红已于 2026-08-06 修复（测试侧 platform 桩），四门口径见 [baseline 门禁](../../baseline/test-and-release-gates.md)。
  历史逐批复核记录（51 文件 590 例起全程只增）见 history 归档。
- **Next Target**：
  1. **T-10 / T-11 真机点验（用户线，当前主项）**：Windows 出包（[T-10 清单「出发前必做」M1~M4](../../../plans/t10-packaged-gui-checklist.md)）
     → 测试机回归（[加密机测试方案](../../../plans/2026-08-06-encrypted-machine-test-plan.md) 步骤 4b R1~R4，重点 M4 分支显示取证）
     → 加密机现场 T-11 六项 → CP2 / CP5。
  2. **开发线下一步待用户裁定**，候选四路（不互斥）：① T-21 收尾截图（唯一残留 In Progress，见 open-q #10）；
     ② multi-agent 支线（已解冻在建，见[该 plan](../multi-agent/README.md)）；
     ③ Deferred 复活（C-17 问答/子 agent 进历史 · T-25 旧模块原色清理 · 后置 6 surface · C-12 压测）；
     ④ backlog 清票（见下）。

> ⚠️ **门禁纪律**：本机内存有限，四门**逐门串行跑**，禁止链式合跑或与子代理/后台任务并行（曾 OOM exit 137）。
> ⚠️ **GUI 启动口径**：填好 `dev.env` 后一律 `node scripts/dev.js`，勿用 `pnpm dev`；
> Linux 机 `pnpm install` 后必须两步复原。命令与细节统一见 [baseline 门禁](../../baseline/test-and-release-gates.md)。

## Active TODO

### 用户线（点测 / 待拍板）

1. **T-04 / T-07 GUI 验收**（用户人工，统一点测）：联调环境见 [baseline 门禁「GUI 联调环境」](../../baseline/test-and-release-gates.md)
   - **T-04 thinking 卡**：🔴 **当前无法点验**——卡在网关（sonnet 空文本 / 默认模型 400，open-q #5/#8）。网关侧修复后再测；仍须在**新发起轮次**验证（旧 fixture 的 153 个 thinking 块文本为空，不可追溯）。
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
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）——实现已落地，唯一完全未测的任务。
3. **T-10 打包版点验**（用户）：[清单](../../../plans/t10-packaged-gui-checklist.md) + [加密机测试方案](../../../plans/2026-08-06-encrypted-machine-test-plan.md) → **CP2 汇报**。
   **2026-08-09 起出包不再必须有 Windows 机器**：Actions → Build → Run workflow → 下载 `windows-unpacked` / `windows-installers`（见清单「CI 出包路径」节）。**限度**：CI 跑 `--skip-smoke`，只关掉 M2 结构半边，全量 25 项仍须真机跑。
   含并入的真机残留：T-24 真机 Windows 项（第 8 项）· A2/0-nonies ⑪ Win10 字重与 D25 §6.2 五项真机指标（第 9 项）。
4. **T-11 加密机现场六项**（等 T-10；含白名单⑥）→ CP5，Phase 0 转正式 Go。
5. **C-15 体积 141MB（+21MB）可接受性**——等用户拍板（open-q #1）。
6. **T-21 收尾截图**：默认主题下中英混排三场景 + 6 处 `normal-case` 豁免目视（open-q #10），截图入台账后转 Done。
7. **#15 缓存复测裁定**：GUI 重启连发两条看第二条有无缓存读取；裁定前暂缓联系网关运营方。
8. **给主线的需求（T-03 / T-18 / 07-28 衍生，共 8 条）**：① `session.history` 的 `truncated` / `omittedCount` 全链路无展示；② **用户气泡不回显附件**——`beginTurn` 只 emit 文字（Renderer 无法自救）；③ 看门狗把整个上传窗口计入 stall，是未来提高附件上限的硬天花板；④ 协议可选加 `document`(PDF)；⑤ store 的 `sendMessage(text, attachments?)` 无人调用、与 Composer 的 `runSend` 双路径漂移；⑥ `session.create` 应校验 workspacePath 存在性；⑦ ~~resume 重放视觉双份~~（已根治 `fd55a26`）；⑧ thinking 空块要不要渲染「已思考」指示——待用户拍板。详见[主线台账](../../../plans/ledger-claude-mainline.md) 07-27/07-28 各行。

### Backlog（小票，择机清）

- `agentWireStatic.test.ts` AST 扫描超时余量不足（单跑 3057ms / 限 5000ms，满载并发下会假红；2026-08-08 实测二跑即绿）
- 历史侧回合时长源；`ran N command(s)` 聚合复议（需 A07 基线修订）
- T-29 转入四项：全局 `color-scheme` / 三 HighlighterCore 单例 / monacoSetup 懒化 / `isTurnActive` 死导出
- useGitChangeCount 的 useRepositoryStore 全局单槽副作用
- sessionRuntimeFacts 重启会话权限行永「未上报」（已知限制）；gitQueryKeys fileDiff path 未归一化（注释登记）
- 隐藏终端随他人 surface 宽度重排 / compact 跨组拖放静默 no-op（均登记不修）
- macOS 无标题栏行 → 全 app 无 usage 展示（既有缺口显性化）
- 旧壳（legacy 标签页壳）功能完整性从未在 D18~D27 各批回归——发现残缺按「旧壳是回退不是产品」记 backlog 不即时修

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）
- T-04 卡网关侧（open-q #5/#8），app 侧无可修

## Handoff Notes

- **观感对齐的唯一基线**：[`docs/design/phase0a-openchamber-alignment.html`](../../../design/phase0a-openchamber-alignment.html)（A01/A05/A06 统一产物，用户已验收）；右栏骨架基线 = [`a08-final-context-panel-baseline.html`](../../../design/a08-final-context-panel-baseline.html)（D27）。业务组件不得自行发明视觉值；冲突先回台账 D18/D19/D27 核对。
- 提交习惯：pathspec 提交保留（非强制）；四门绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- **`ui/alert.tsx` 的 variant 是 `error` / `warning` / `info` / `success` / `default`，没有 `destructive`**（那个只存在于 button.tsx 与 badge.tsx）。
- **UI 逻辑一律下沉纯函数**：vitest 是 `node` 环境且 include 只收 `.ts`，`.tsx` 里的逻辑零覆盖。现成范式 `hostStatus.ts` / `fileMention.ts` / `sessionEffortStore.ts` / `historyError.ts` / `sendPreamble.ts` / `hostStderr.ts`。
- **新机器首启注册仓库（T-24 后口径）**：新壳已有完整添加仓库通路（LeftNav 四处 + 目标栏三项 + 整壳拖放）；`--open-path` argv 仍可用但**不再是唯一通路**。
- **T-05 / 布局类旧交接词已整体过期（2026-07-28）**：凡提「带边框工具卡 + 状态徽章」「四区壳」「底部终端 Dock」「右栏三 tab」一律作废，以 D18/D19/D20/D27 与基线 HTML 为准。（例外：[baseline/module-map](../../baseline/module-map.md) 的四区表述是代码现状注记。）
