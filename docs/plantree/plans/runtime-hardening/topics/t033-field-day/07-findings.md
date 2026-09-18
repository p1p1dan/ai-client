# T033 分片 07 · 现场反馈与根因（2026-09-18，Build #59）

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。建立：2026-09-18。

本分片记录的不是 [checklist-e.md](../../checklist-e.md) 判据式的逐项签收，是用户在 Windows 测试机上实际使用打包 Build #59 时产生的十条反馈，与对应的只读根因排查（均已在代码里定位到具体行号）。落地任务见 [roadmap.md](../../roadmap.md) 批次 H；两处需要拍板的取舍已结为[决策 023](../../decisions/023-bypass-permissions-tier.md)（第四档权限模式「完全放行」）与[决策 024](../../decisions/024-prompt-cache-ttl-split.md)（prompt cache TTL 分离）；工具耗时数据另结为[决策 025](../../decisions/025-search-tool-native-over-pi-fff.md)。

## Build 范围

**Build #59 = 提交 `13e6cdb7`（2026-09-18 01:30 UTC）**，即 [evidence/batch-e-build-2026-09-18/](../../evidence/batch-e-build-2026-09-18/README.md) 打包验证的那次源码。**不含**其后的 `b24d5c81` / `17eb4581` / `0144320e` / `cd734d61` / `d119da25`——也就是说，本轮反馈里看到的聊天区形态是批次 G 改造**之前**的旧形态（工具行/授权卡穿插在散文中间、无工作组折叠、无浮层单卡），批次 G 已经解决的问题不会在下表出现。

## 反馈与根因

| # | 现象 | 根因 | 证据 | 对应产出 |
|---|---|---|---|---|
| 1 | 设置「添加 AI 服务」下拉不显示 | 两处 `SelectPopup` 漏传 `zIndex`，默认落到 `DROPDOWN`（40）被 `MODAL_CONTENT`（51）盖住 | `ProviderSetupDialog.tsx:193,237`；`select.tsx:65`；`z-index.ts:14,18,19` | [T079](../../roadmap.md)（H-3） |
| 2 | 全自动仍弹授权卡 | 放行条件是 `gear === 'auto' && !unresolvedPaths` 才放行；`unresolvedPaths` 来自 bash 静态分析对无法解析的路径（`$VAR`、`$(...)`、`for` 循环等）的标记 | `permissions/index.ts:359`；`bash-analysis.ts` | [决策 023](../../decisions/023-bypass-permissions-tier.md) / [T078](../../roadmap.md)（H-2） |
| 3 | 运行中不能切权限档 | 三道锁：`ComposerPermissionTrigger.tsx:126`（sending 时禁用）、`WorkerManager.ts:2085`（activeRequestId）、`nativeWorkerRuntime.ts:889`（assertIdle）；存在理由是保护 `configure()` 的副作用（清空 grants + epoch 递增会让排队中的请求被拒） | 同左 | [T080](../../roadmap.md)（H-4） |
| 4 | 一直重复申请权限 | 只有 allow-session 会写 grants；`grantKey` 是 `[tool, path, command, paths]` 的精确 JSON 串；纯内存，重启即丢 | `permissions/index.ts:574,596-598` | [T081](../../roadmap.md)（H-5） |
| 5 | 委托（子代理）时上下文占用归零 | `projector.ts:520` 调 `buildPiUsagePayload` 时第二个参数硬写 `undefined`；`contextSurfaceModel.ts:576-585` 对上下文做整体替换而非合并 | 同左；对应已有任务 T053 | [T053](../../roadmap.md)（提级批次 H） |
| 6 | TUI 请求不了新增的 claude provider | **T082 落地时更正**：五个保管箱（vault）写入点其实都已挂了 `auth.json` 重写的补救钩子，并非完全没有触发时机；但这些钩子全是不等待、不捕获失败的异步调用（其中自建服务那一处连 `.catch` 都没有），真正的缺口是保管箱写入与 `auth.json` 重写之间没有可靠先后保证的**时序竞态窗口**，TUI 恰好在窗口内读到旧文件；已排除「TUI 读取另一个 agentDir」的备选病因，两侧用的是同一个 `getAppPiAgentDir()` | `PiTuiPty.ts:163-184`；`PiModelConfigService.writeRuntimeConfig():645-661` | [T082](../../roadmap.md)（H-6）已落地（工作区未提交），见[批次 H 证据](../../evidence/batch-h-field-fixes-2026-09-18/README.md) |
| 7 | TUI 执行 `new` 后静默解绑 | pi 自己的 `SessionManager` 切到了新路径；GUI 的 `session-index.json` 侧没有目录扫描、没有 `fs.watch`，感知不到这次切换 | `SessionIndexService.ts:94-96` | [T086](../../roadmap.md)（H-10） |
| 8 | 正常输出慢（本轮现场最疼的一条，主因） | ~~5 分钟无请求后 prompt cache 过期，下一次请求触发全量重写上下文~~；数据见下节「性能深挖」。**2026-09-18 下半场更正**：缓存过期只解释约 2.3 秒延迟，不是「首字 6.8s→29~51s」这个量级落差的成因，真正主因是思考（extended thinking）token 量，见「性能深挖」节末尾的更正小节 | `contextFX/session-1789701613704-i5jfwqz.jsonl` | [决策 024](../../decisions/024-prompt-cache-ttl-split.md) / [T077](../../roadmap.md)（H-1）~~已落地，收益待上机验证（开发机上 `cacheWrite1h` 分桶恒为 0，需 T033 第二轮现场确认中转是否透传 `ttl:'1h'`，见 [Q021](../../open-questions.md)）~~ **2026-09-18 下半场已补完**：真实请求端到端确认中转如实透传 `ttl:'1h'` 且上游按 1 小时处理，[Q021](../../open-questions.md) 已结案；但同一批测试同时推翻了本条「主因是缓存 TTL」的判断，详见 [perf-2026-09-18.md](../../evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md)；工具耗时部分另见[决策 025](../../decisions/025-search-tool-native-over-pi-fff.md) / [T083](../../roadmap.md)（H-7）**已落地，收益待上机验证**（glob 大目录树性能仅在 Linux 开发机测过，见[批次 H 证据](../../evidence/batch-h-field-fixes-2026-09-18/README.md)） |
| 9 | 子 agent 没有独立展示位 | **不是缺陷**：子代理的执行过程当前挂在工具行下，可以展开查看；用户期待的是一个独立的展示位置，不是「看不到」 | `ToolRows.tsx:164-165` 挂载 `SubagentActivity` | [Q019](../../open-questions.md) / [T085](../../roadmap.md)（H-9，阻塞于 Q019） |
| 10 | 网关对 claude 模型 503 / 超时 | 独立问题，与现象 #8 的「慢」无关；两段短测试里 claude provider 一次未成功、142 秒零输出 | `contextFX/2026-09-18T07-28-08-430Z_*.jsonl`、`contextFX/2026-09-18T07-31-10-855Z_*.jsonl` | [T087](../../roadmap.md)（H-11，本批不实现，另行跟进） |

## 性能深挖（对应现象 #8）

样本：`contextFX/session-1789701613704-i5jfwqz.jsonl`（仓库根目录下，未纳入版本库），1.3 MB，261 条消息，跨度 17,759 秒（约 4.9 小时）。

### 按模型分桶

| 模型 | 样本数 | 首字前固定开销 | 吞吐 | 平均 cacheRead |
|---|---|---|---|---|
| claude-opus-4-6 | 45 | 11.7 s | 62.1 tok/s | 69,289 tokens |
| claude-opus-5 | 57 | 7.0 s | 72.9 tok/s | 224,555 tokens |

切换点在整场对话进行到 +15188 秒时，同时思考强度从 medium 切到 high。

**结论**：上下文体积大 3.2 倍（224,555 对 69,289）反而首字前快 4.7 秒——上下文大小不是拖慢输出的主因；思考强度也不是（用户在自己的命令行工具上用更高的 xhigh 强度反而更快）。

### 缓存失效（真正的主因）

全程出现 4 次「完全未命中」（`cacheRead=0` 且 `cacheWrite>50,000` tokens），全部发生在距上一次请求超过 5 分钟之后：

- 停顿 5.7 分钟 → `cacheWrite` 167,123 tokens，首字前 29 秒
- 停顿 5.7 分钟 → `cacheWrite` 178,099 tokens，首字前 51 秒
- 停顿 6.9 分钟 → `cacheWrite` 82,356 tokens，首字前 11 秒
- 停顿 17.8 分钟 → `cacheWrite` 158,567 tokens，首字前 50 秒

对照组：缓存命中时的 98 个样本，首字前时间中位数只要 6.8 秒。

也就是说：停顿超过 5 分钟后，Claude 官方的 prompt cache 过期，下一次请求要把整段对话重新写入缓存，首字前等待时间从 6.8 秒的正常水平涨到 29～51 秒。这是本轮现场「输出变慢」反馈的主因，登记为[决策 024](../../decisions/024-prompt-cache-ttl-split.md)。

### 工具耗时

- 全程工具调用累计耗时 2108 秒。
- bash 工具调用 106 次，中位数 1.7 秒，属正常；但其中模型用 bash 硬跑了 `grep -ran`（单次 183 秒）和 `find .`（单次 120 秒）这类本该用专用搜索工具做的操作。
- 本应用自带的 glob（按路径搜索）工具被调用 2 次，平均耗时 50.8 秒——是在 Windows 的大目录树下测出来的，明显偏慢。

登记为[决策 025](../../decisions/025-search-tool-native-over-pi-fff.md) 与 [T083](../../roadmap.md)（H-7）。

### 已排除的假设

- 默认的 medium 思考强度——方向相反，实测更高强度反而更快。
- 走了代理或额外的网络路径——命令行工具和本应用用的是同一个网络环境。
- 上下文体积大——已用「按模型分桶」的数据反证。
- 「重试提示没显示」——用户确认当时看到了重试提示（对应代码 `projector.ts:427`），这个猜测不成立。

### 仍未能切分的部分

客户端自身的处理开销上限约为 7 秒（用 claude-opus-5 缓存命中时的最快值倒推的地板值）。要进一步拆出「网关排队用了多久」「模型生成用了多久」这些更细的环节，需要在代码里加三个时间点的埋点：请求发出的时刻、网关接单的时刻、返回的第一个正文 token 的时刻。目前没有这些埋点，做不到进一步拆分。

### 2026-09-18 下半场更正：缓存 TTL 不是「输出慢」的主因

上面「缓存失效（真正的主因）」一节的判断已被同日更完整的实测推翻，原文保留不删，更正记在这里。

用真实公司渠道请求（`claude/claude-sonnet-5`，经 `cch-jyw` 中转）做六组对照：我们的 runtime 缓存冷/全命中分别 28.2s / 25.9s，只省 **2.3 秒**——不是「首字 6.8s→29~51s」那个落差的成因；绕开全部应用代码的裸调用在思考开启时反而比走应用慢 5～7 秒（30.7s/33.2s 对 25.9s），说明应用自身代码不是瓶颈；裸调用关闭思考后总时长从 30.7s 降到 11.3s（降 64%）、首字从 25.0s 降到 6.9s，三组裸调用的思考 token 量（976/1,063/0）与耗时完全单调对应——**真正的主因是思考（extended thinking）token 量，不是缓存 TTL**。[决策 024](../../decisions/024-prompt-cache-ttl-split.md) 主对话默认 1 小时依然成立（省成本、省这 2.3 秒），但不再被当作「解决输出慢」的方案，该决策已追加注记更正。同一批测试还端到端确认了中转确实透传 `ttl:'1h'` 且上游按 1 小时处理，[Q021](../../open-questions.md) 已结案。完整数据、测试配置与待拍板线索（系统提示词里家目录 `CLAUDE.md` 的「需求复述」规则对思考量/输出量的影响）见 [evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md](../../evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md)。

## 相关文件

- 判据权威（不含本轮现场反馈）：[checklist-e.md](../../checklist-e.md)
- 上位执行单：[t033-field-day-runbook.md](../t033-field-day-runbook.md)
- 落地任务：[roadmap.md](../../roadmap.md) 批次 H（及其后的「批次 H 追加」T088/T089）
- 决策：[023](../../decisions/023-bypass-permissions-tier.md) · [024](../../decisions/024-prompt-cache-ttl-split.md)（已追加性能主因更正） · [025](../../decisions/025-search-tool-native-over-pi-fff.md)
- 性能重测与主因更正（2026-09-18 下半场）：[evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md](../../evidence/batch-h-field-fixes-2026-09-18/perf-2026-09-18.md)
- 未决问题：[open-questions.md](../../open-questions.md) Q019 / Q020 仍待拍板；~~Q021~~ 已结案
