# Implementation Status — OpenChamber Chat Refactor

> 短操作交接。历史证据勿堆此处，进台账档案。

- **Current Phase**: Phase 3 Chat MVP 收口（2026-07-24 双轨合一，单线推进）
- **Last Landed**: 2026-07-27 四连落地——**#8 thinking 形态修正** `bfd4f6b` · **T-07 补强四项 + open-q#7** `0f886a8` · **T-20 Effort 选择器** `4c3f67e` · **T-03 收尾（历史读失败 UI）** `7a5c2cd`
- **Last Verified**: 2026-07-27 三绿——typecheck 干净 / lint 596 文件 0 诊断 / vitest **45 文件 455 例**
- **Next Target**: 用户统一 GUI 点测（T-04 / T-07 / T-20 / T-06 / T-03 五项均已就绪）；并行推 T-18（进行中）与 T-05

> ⚠️ **门禁口径依机器而异（2026-07-27 新增）**：Linux 检出上「全绿」不成立。3 例
> Windows-only 断言在 Linux 上不可能通过——`ShellDetector.test.ts` 2 例（断言
> `powershell.exe`）、`CliDetector.test.ts` 1 例（cmd fallback）。**Linux 上的三绿口径 =
> typecheck 干净 / lint 0 诊断 / test 只剩这 3 个失败且总例数只增不减**；Windows 上仍应全绿。
> 另：`@vscode/ripgrep` 的 postinstall 会被 GitHub 403 挡掉，需手工把一个 rg 二进制放进
> `node_modules/@vscode/ripgrep/bin/rg`，否则 T-07 那 8 例真跑 ripgrep 的集成测试有 6 例红。

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
| T-04 Thinking 卡 | 🟡 **已解除阻塞** | 代码链逐环验证正确；#8 落地后 `display:'summarized'` 使文本非空，**可观测对象已就位**，等 GUI 人工点验 |
| T-06 元数据/重试 | ⬜ 未测 | 唯一完全未碰的任务，不受上述 bug 影响，可直接补测 |
| T-07 `@` 引用 | ✅ Done | P0 反斜杠已修并复验通过；三项补强（目录 / 隐藏文件 / 截断提示）+ 同分定序已于 2026-07-27 `0f886a8` 落地，等 GUI 点验 |

Tool 卡不折叠 = T-05 未开发，**非 bug**。

## Active TODO

1. **T-04 / T-07 GUI 验收**（用户人工，统一点测）：联调环境
   `CLAUDE_CONFIG_DIR='C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config' pnpm dev`
   - **T-04 thinking 卡**：历史 fixture 的 153 个 thinking 块**文本仍是空串**（旧会话录制时 display=omitted，不可追溯补全）——**只能在新发起的轮次上验证**，resume 旧会话看不到 thinking 属预期。
   - **T-07 补强**：`@` 输入 `src/` 应见目录条目（黄色文件夹图标 + 尾随 `/`）；输入 `git` 应见 `.gitignore` 等隐藏文件；输入 `chat` 右下角应显示 `10/319`。
   - **T-20 Effort 选择器**：Composer 右下角 ModelSelect 旁应见新的档位下拉（默认显示 `Default`）。选 `X-High` 后重启应仍保持；**`Default` 与 `High` 是不同选项**——前者不下发 `effort`、保持模型默认。
   - **T-03 历史读失败提示**：造错的最快办法是把 `session-index.json` 里某条的 `runtimeIdentity` 改成一个不存在的 uuid 再 resume → 应见黄色告警「History file not found」，且**不再显示** "No messages yet"，输入框仍可用。`read_failed` 档才有 Retry 按钮；会话进行中时 Retry 应为禁用并说明原因。
2. **T-06 补测**（网关已恢复，元数据行 / 红色 Stop / 失败卡 + Retry 无重影）
3. **T-05 开发**（工具卡 + Question 卡）——**开工前需用户定交互口径**：默认折叠？input/output 截断阈值？路径点击是开编辑器还是定位文件树？
4. **T-18 Composer 粘贴图片/文件**（C-13 协议已就绪）——**进行中**
5. T-10 打包版点验（用户，[清单](../../../plans/t10-packaged-gui-checklist.md)）→ **CP2 汇报**
6. C-15 体积 141MB（+21MB）可接受性——等用户拍板
7. T-19 消息队列提案——等用户落库
8. **给主线的需求（T-03 评审衍生）**：`session.history` 的 `truncated` / `omittedCount` 全链路无展示——store 未保留这两个字段，超长历史被静默裁掉且界面无标记。详见[主线台账](../../../plans/ledger-claude-mainline.md)同日行。

## Blocked By

- GUI/打包点验类均需**用户人工操作**（联调命令见 [baseline 门禁](../../baseline/test-and-release-gates.md)）
- T-11 需**加密机现场**（→ CP5）

## Handoff Notes

- 提交习惯：pathspec 提交保留（非强制）；三绿后再提交；台账先行、状态文件随后。
- 联调 fixture：测试配置 `projects/` 下播了 3 条真实 CLI 会话，索引条目在 `%APPDATA%/jyw-ai-client-dev/session-index.json`（备份 `.bak-before-seed`）。会话列表**只读索引、不扫 JSONL**——播 fixture 必须同时补索引条目。
- 同事交接词两处过时勿信：「biome CRLF 行尾债」（C-09 后 lint 0 诊断）、「T-05 Question 等 C-04」（C-04 已 ✅）。
- **`ui/alert.tsx` 的 variant 是 `error` / `warning` / `info` / `success` / `default`，没有 `destructive`**（那个只存在于 button.tsx 与 badge.tsx）。写「借鉴 destructive 错误条」的交接词时要注意这一点，照字面写会编译不过。
- **UI 逻辑一律下沉纯函数**：vitest 是 `node` 环境且 include 只收 `.ts`，`.tsx` 里的逻辑零覆盖。现成范式 `hostStatus.ts` / `fileMention.ts` / `sessionEffortStore.ts` / `historyError.ts`。
