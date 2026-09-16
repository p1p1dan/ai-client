# 全量 Vitest 失败归因（2026-09-16，Windows 开发机）

Role: evidence。批次 D2 收口时对全量 Vitest 剩余失败的逐文件归因（一名 sonnet 只读代理逐文件读错误输出与测试源码，允许单文件复现运行）。收口结果见 [batch-d2-2026-09-15.md](batch-d2-2026-09-15.md)「批次 D2 收口」节；归因先例是 T045b 前夜发现的 trace.test.ts「假 POSIX 依赖」（提交 `0d507f71`，修正 `ac95352f` 的归因）。

## 口径

- 基线（修复前）：96 failed | 6124 passed | 4 skipped（6224 条，410 文件，30 文件失败）。
- 收口（trace 修复 + T045b 后）：**90 failed | 6153 passed | 1 skipped（6244 条，411 文件，28 文件失败）**。
- 不同负载下同一批超时类用例抖动 ±5 条左右（代理独立复跑得 86，另一轮得 91），非新增回归。
- 一处前期误判已纠正：`panelVisibilityStatic.test.ts` 报的 LeftDock/shellLayoutModel「违规」不是新增违规，是测试白名单用 `path.split('/')` 在 Windows 反斜杠路径上失效。

## 类别汇总（按基线 96 条计）

| 类别 | 条数 | 说明 |
|---|---|---|
| A 假平台依赖（测试侧小改可修） | ~44（含已修的 trace 7 条） | 与 trace 同款「路径分隔符字面量 vs 原生 join」模式 |
| B 真环境依赖 / 安装态 / 负载抖动 | ~40 | 缺 rg.exe（6）、vendored 补丁未跑（7）、Windows 临时目录清理竞态 EBUSY/EPERM（11，可一次系统性修复）、POSIX 权限位、/bin/bash 假设、负载超时等 |
| C 疑似产品 bug | 6-8 | 见下节 |
| D 过时静态测试 | 1 | legacyShellAbsence 正则误伤清理清单里的死键名字符串 |

## 按文件归因（剩余 28 个失败文件）

| 文件 | 条数 | 类别 | 根因 | 工作量 |
|---|---|---|---|---|
| `src/runtime/__tests__/skills.test.ts` | 17 | A | fakeSource 子项匹配硬编码 `${dir}/` 正斜杠前缀，Windows 反斜杠键 `startsWith` 恒 false | 小（trace 同款修法） |
| `src/runtime/__tests__/subagentDefinitions.test.ts` | 5 | A | 同上（:57 `` file.startsWith(`${path}/`) ``） | 小 |
| `src/agent-host/__tests__/agentWireStatic.test.ts` | 8 | A | 5 条分隔符字面量不匹配；3 条共享探测文件被前序用例消费后 ENOENT（夹具生命周期缺陷） | 小 |
| `src/main/services/search/__tests__/SearchServiceRipgrep.test.ts` | 6 | B | `@vscode/ripgrep` postinstall 未跑，`rg.exe` 缺失 | 小（重跑安装） |
| `src/agent-host/__tests__/permissionPolicyIntegration.test.ts` | 6 | B | vendored 包补丁脚本未在本环境 node_modules 上跑过 | 小（与下条合并，一次解决 7 条） |
| `src/agent-host/__tests__/permissionPatchScript.test.ts` | 1 | B | 同上 | — |
| `src/runtime/__tests__/shellPolicy.test.ts` | 5 | 1A+1C+3B | A：一条命令未给 `${outside}` 加引号；**C：symlink 目录 + `..` 组合在检查真实目标前被字符串归一化掉，权限边界存在真实绕过**；B：3 条负载超时 | A 极小；C 中（安全相关，单独立项） |
| `src/agent-host/__tests__/workerEntryWiring.test.ts` | 5 | B | EPERM——Windows 临时资源在子进程退出前被 teardown 删除 | 中（与 host/mcp 合并系统性修复） |
| `src/runtime/__tests__/host.test.ts` | 4 | B | EBUSY rmdir 临时目录，同上根因 | — |
| `src/runtime/__tests__/mcp.test.ts` | 3 | B | 2 条 EBUSY 同上；1 条 600ms 连接预算在冷启动下过紧（待单跑确认） | — |
| `src/main/services/piModelConfig/__tests__/piWorkerEnv.test.ts` | 3 | A | `APP_AGENT_DIR` 常量漏包 `join()` | 极小 |
| `src/agent-host/__tests__/nativeWorkerModuleLoads.test.ts` | 3 | B（2 条建议提级调查） | 2 条「worker did not answer」逼近 28s 超时上限，两次独立复现，不像偶发抖动 | 中 |
| `src/runtime/__tests__/tools.test.ts` | 2 | B | 断言期望 bash 输出原生 Windows 路径，实际 MSYS bash 报虚拟 /tmp 路径 | 中（见「bash 环境假设」） |
| `src/runtime/__tests__/subagentToolsPermissions.test.ts` | 2 | B | 硬编码 `/bin/bash`，Windows ENOENT | 小 |
| `src/runtime/__tests__/sessionInterop.test.ts` | 2 | B 倾向 | 疑似 CRLF 与按字节偏移的断行重建逻辑不兼容，未排除 C | 中（需读实现定论） |
| `src/runtime/__tests__/promptService.test.ts` | 2 | C | ①maxBytes 截断疑似未生效；②hermetic-home 隔离下 symlink 越界读到了开发机真实 `~/.claude/CLAUDE.md`——隔离失效信号，无论 B/C 都该开票 | 中 |
| `src/main/services/agent-host/__tests__/PiWorkerProcess.test.ts` | 2 | A | spy 断言正斜杠字面量 vs 反斜杠实参 | 小 |
| `src/agent-host/__tests__/piCliIsBundledToolOnly.test.ts` | 2 | A | 源码树扫描反斜杠 vs 正斜杠字面量 | 小 |
| `src/main/services/agent-host/__tests__/workerSessionKey.test.ts` | 1 | **C** | `normalizeWorkerPath()` POSIX 分支误用平台原生 `path.resolve`，Windows 下把 `/tmp/...` 解析成 `E:\tmp\...`，影响会话路由 key 正确性 | 极小（`path.posix.normalize`），建议尽快修 |
| `src/main/services/files/__tests__/localFileReadGuard.test.ts` | 1 | **C** | 大小写不敏感比较把返回路径也污染成全小写，安全模块返回值被意外改写 | 小 |
| `src/main/services/auth/__tests__/stopDualWriteMutationTrace.test.ts` | 1 | B/C 待定 | 端到端登录整体失败，非格式问题 | 中（需带日志单跑） |
| `src/renderer/components/workspace-shell/__tests__/panelVisibilityStatic.test.ts` | 1 | A | 白名单 `path.split('/').pop()` 对反斜杠失效，误判本已允许的文件 | 极小（`basename()`） |
| `src/agent-host/__tests__/nativeWorkerDependencyBoundary.test.ts` | 1 | A | `path.relative` 反斜杠 vs 正斜杠断言 | 极小 |
| `src/renderer/App/__tests__/legacyShellAbsence.test.ts` | 1 | D | 静态扫描正则命中 `REMOVED_SETTING_KEYS` 清理清单里的死键名 | 小 |
| `src/main/services/__tests__/appStateMigration.test.ts` | 1 | B | Windows 无 POSIX 权限位，0o600 断言退化 | 小（平台分支） |
| `src/main/services/git/__tests__/tsdWorkingTreeRead.test.ts` | 1 | B | `spawn EFTYPE`，Windows 特有 errno | 中 |
| `src/main/services/agent-host/__tests__/subagentCatalog.test.ts` | 1 | B 倾向 | 疑似 Windows rename 原子替换语义差异，待单跑定位 | — |
| `src/runtime/__tests__/workerEndToEnd.test.ts` | 1 | B | bash 可用性假设，与 tools/subagentToolsPermissions 同族 | — |

## C 类清单（建议单独立项，按优先级）

1. **shellPolicy 的 symlink 越界绕过**（`link/../secret` 在检查真实目标前被归一化掉）——权限系统真实缺口，安全相关，优先级最高。
2. **workerSessionKey 的 `normalizeWorkerPath()`**——一行修，影响会话路由/去重正确性。
3. **promptService 的 hermetic-home 隔离泄漏**（测试读到开发机真实全局配置）与 maxBytes 截断疑似未生效。
4. **localFileReadGuard 返回路径大小写污染**——顺带审查同文件其它返回值。
5. mcp 连接预算归因、stopDualWriteMutationTrace 登录失败——待定，先单跑确认。

## 系统性建议

- **A 类 ~37 条**（扣除已修的 trace 7 条）集中在一个 bug 模式：测试用字面量拼路径分隔符、生产代码用原生 `join()`。建议一次专项统一修（或加 lint 规则禁止测试里字面量拼分隔符），而不是逐文件修。其中 skills+subagentDefinitions 22 条同一修法，性价比最高。
- **EBUSY/EPERM 临时目录清理竞态 11 条**（host/mcp/workerEntryWiring）是同一类基础设施问题：teardown 等待子进程真正退出 + 删除重试，一次通用改动可全部解决。
- **bash 环境假设矛盾**：tools / subagentToolsPermissions / workerEndToEnd 三个文件对「Windows 上有没有 bash、bash 是什么行为」假设互相矛盾（没有 / 原生路径 bash / 实际是 MSYS 虚拟路径 bash），建议测试 setup 统一约定。
- vendored 补丁 7 条重跑一次不带 `--ignore-scripts` 的安装即可修，属「P3 但顺手能修」的例外。

## 对「P3/P4 暂不动」立场的结论

A 类不是环境噪音而是已验证修法的测试 bug，每次全量跑制造 ~37 条噪音掩盖真实信号，建议提前修；C 类 5 条（尤其 symlink 绕过）不应与环境噪音同篮「暂不处理」。真正可以继续挂起的只有：缺 rg.exe、POSIX 权限位、EFTYPE、以及负载超时抖动。本轮按既定计划未动 P3/P4，此表留给排期决策。
