# P2-0 · 旧后端缓存命中率基线

日期：2026-09-08 · 状态：P2-0 完成，六场景在线采集与原始数据复核通过，尚未提交

权威：[ARD D9](../../../../plans/2026-09-08-runtime-evolution-ard.md#d9--缓存命中率沿用现有公式用固定脚本会话采基线) · [任务看板](../README.md)

## 范围与进度

P2-0 可独立于 P0 开展。本轮只负责固定会话、旧后端采集工具与证据，P0 由另一执行者负责。
用户在接口验证后指示继续；执行完成，当前模式为 `status-update`。
正式结果：**95.01%**，六场景、28 次普通模型调用；[报告与验收证据](../evidence/p2-0/validation.md)。

- [x] 核对 D9、当前 usage 生产与累计路径、参考仓源码及测试。
- [x] 明确六个固定场景、采集口径、证据格式与验收条件。
- [x] 用户指示继续；模型与测试凭据已提供，连接已验证。
- [x] 实现独立采集入口；统计、重复累计、缺失 usage、工具边界与 edit 数组五项单测通过。
- [x] 串行完成六个旧后端在线会话；原始 JSONL/trace 独立复核通过，基线已归档。

并行文件边界：本任务新增 [`scripts/runtime-baseline/`](../../../../../scripts/runtime-baseline/README.md)，证据归档在本计划的
`evidence/p2-0/`；任务入口仅局部更新 P2-0 行。`src/runtime/`、依赖清单及锁文件由 P0 负责。

## 已核对的当前代码

- 旧引擎版本：`src/agent-host/package.json` pin `@earendil-works/pi-coding-agent@0.84.3`。
- 实际依赖解析：SDK 自身嵌套 `node_modules` 下的 `pi-ai`、`pi-agent-core` 均为 `0.84.3`，
  并非 P0 新 runtime 的 `0.84.4`；P2-6 前按 [Q4](../open-questions.md)处理版本差异。
- `src/agent-host/piAgentSessionBootstrap.ts` 使用 SDK services/runtime API，加载权限扩展、
  默认随包扩展和追加的技能安装指令。采集应复用这条 bootstrap，保留这些影响请求前缀的组成。
- `src/agent-host/piWorkerSession.ts` 的 `turn_end` 分支是 `usage.updated` 唯一生产者，
  `agent_end` 再累加会重复计算。
- `src/shared/piUsage.ts` 的 `deriveCacheHitRate` 与 D9 一致。
- `src/shared/piTurnRollup.ts` 累加 assistant turn usage，并单独接受带 usage 的工具结果。
- 已安装 SDK 的 `AgentSession.compact()` 会保存 compaction record 及摘要调用 usage；
  当前 Worker 的 turn rollup 没有累计这个摘要调用。采集时单列，保持现有指标边界。

核查工作区 HEAD：`3ce9702e369463339420106280d42188dd24dbd3`；实际采集时重新登记 HEAD、
相关文件哈希与工作区脏状态，不能将其他执行者的未提交变更算成已落地版本。

## 六个固定场景（suite p2-0-v3）

每个场景创建独立合成工作目录和新会话；固定执行顺序。全部提示、文件字节及操作序列须在
首次在线执行前冻结为 [`suite.mjs`](../../../../../scripts/runtime-baseline/suite.mjs)，每次运行展开
存档为 `suite.json` 并计算 SHA-256；P2-6 复用同一版本。以下是对应行为要求。
v1 在 B02 暴露旧 edit 参数与 SDK schema 不符，v2 已修正并完整重采；
[失败与重采证据索引](../evidence/p2-0/README.md)保留两次记录，失败样本不合并进基线。
v3 只为 B05 第二轮补充固定材料，确保 SDK 完整轮次保留策略下仍有可压缩的前缀；
其他五场景字节不变。正式汇总验证逐场景输入一致，可复用其首次完整成功会话。

| ID | 场景 | 固定操作 | 过程断言 |
|---|---|---|---|
| B01 | 纯对话 | 三轮：记住合成项目名称与三个约束 → 按要求复述 → 按约束回答固定问题 | 无工具；三个 prompt 均有成功 assistant 响应；关键信息保留 |
| B02 | 多轮文件工具 | 三轮：read 固定配置 → edit 一个指定字段 → read 核实 | 按步骤核对工具调用；只有目标字段变化；最终文件字节符合预期 |
| B03 | 搜索与读取 | 三轮：bash 执行固定只读搜索 → read 指定命中文件 → 回答固定行中的标记 | 搜索/读取都真实发生；不得写文件；标记正确 |
| B04 | 长文件读取 | 三轮：read 合成大文件起始段 → read 指定后段 → 汇总两处固定标记 | 样本超过 SDK 单次读取上限；截断与分页均有证据；两处标记正确 |
| B05 | 压缩后续聊 | 三轮载入/确认足量固定材料 → 显式 compact → 两轮核对压缩前事实 | 原生 compaction record 存在；摘要非空；压缩后成功续聊；摘要 usage 单列 |
| B06 | resume 续聊 | 两轮建立上下文 → dispose → 从同一 JSONL 新建 runtime → 两轮续聊 | 同一 session id/file；重开前后历史一致；回答保留事实；旧 usage 不重复累计 |

B05 使用现有手工 compact 入口固定触发时点；不依赖模型自行决定是否压缩，不冒充自动阈值
压缩验收。为控制采集成本，六场景统一设置 `reserveTokens=4096`、`keepRecentTokens=1024`，
关闭自动压缩；B05 用固定材料触发真实手工压缩。此设置区别于产品默认值，P2-6 必须同参数
对比，不能将本基线当成默认阈值行为的验收。模型统一 `thinking=off`、输出上限 2048。
工具动作由固定提示驱动，同时验证实际工具序列；偏离要求的会话作为失败证据保存，不进入
有效基线。P2-6 必须同时报告工具调用次数/顺序及有效轮数，不能仅凭相同提示认定结果可比。

## 采集与计算规则

1. 六条会话共用同一 provider、模型、推理档位、请求参数和扩展配置；登记模型 API、
   contextWindow、maxTokens、兼容设置及相关 SDK 版本。不得为凑结果临时切模型。
2. 保存 SDK `turn_end.message.usage` 原始字段。一次 provider 调用只计一次；不累计
   `message_end`、`agent_end` 或 UI 已累计的 session 数字。
3. 每轮比率为 `cacheRead / (input + cacheRead)`；会话和整套比率为
   `sum(cacheRead) / (sum(input) + sum(cacheRead))`，不能平均各轮百分比。
4. `cacheWrite`、output 和 Pi 上报的 cost 单独保存，均不加入上述分母。保存未四舍五入比率，
   展示时再转为百分比。usage 缺字段或分母为零时记为不可测，不能填 0% 或从字符数估算。
5. 压缩摘要 usage 独立归档；门禁比率沿用现有 turn rollup 的范围。需要全调用成本时另列，
   不用增加生产埋点。resume 读取已有 JSONL 只用于校验，不再回灌到本次累计器。
6. 不声称能控制 provider 冷缓存。记录开始时间、会话顺序、每轮间隔、cacheRetention/
   session 缓存标识配置及预热方式（若未显式预热，写明）。首次无命中轮也保留在总比率中。
7. 任何超时、工具错误、压缩失败、provider 错误或缺失 usage 均保留证据并使对应场景失败；
   失败重跑建立新 run id，不能删除失败轮后将同一 run 改成通过。
8. 本次在线采集连续遇到 B04 连接失败，采用逐场景补齐：每个场景按执行时间取首次完整
   成功记录，不按命中率选择，不拼接单个场景的失败轮和成功轮。`collect.mjs` 检查各来源
   逐场景输入字节、provider/model、设置、工作路径、实际依赖及采集器/旧后端源码哈希一致；
   suite 版本变化仅允许复用其中未变的场景。来源 suite/manifest 与 case SHA-256 随六份原始
   会话归档，`summary.attempts` 保留所有版本的完成/失败尝试及 compatible 标记。正式基线
   须通过独立离线复核。

## 产物与验收

每次 run 应含 manifest、六份会话 JSONL、逐调用 usage JSONL、逐步断言结果、机器可读汇总和
Markdown 报告。manifest 至少登记 suite 版本及样本哈希、git HEAD/相关源码哈希、SDK 版本、
模型及请求配置、prompt/工具 schema 快照或可重建内容、执行时间与隔离工作目录规则。
原始模型回答、工具输入输出保留在合成会话证据中；凭据、auth.json 和鉴权请求头不进入归档。

完成条件：六个场景全部在真实旧后端执行成功，usage 可测，证据可从原始记录重新计算，
P2-6 能使用同一套输入重跑。脚本存在、mock 通过、参考仓测试通过均不等于 P2-0 完成。
验收前任务保持进行中；P2-1 至 P2-6 仍遵守各自前置依赖。

## 参考实现取舍

| 来源 | 本轮已读源码与测试 | 取舍 |
|---|---|---|
| PI-Desktop `948ee676` | `apps/desktop/src/lib/context-usage.ts`、`apps/desktop/test/context-usage.test.mjs` | 直接沿用 D9 的公式语义；本仓已有对应实现，无需复制源码 |
| pi-app `77326024`（本地 `/tmp/aiclient-b-reference-pi-app`） | `src/worker/worker-runtime.ts`、`scripts/tests/session-get-messages-disk-fallback.test.mjs`、`scripts/tests/incomplete-session-recovery.test.mjs` | 适配采用 dispose 后用 `SessionManager.open` 重建 runtime 的 resume 方法；不采用 WorkerManager 拓扑改动 |
| pix `da01b3e1`（本地 `/home/pi/code/pix`） | `apps/desktop/src/main/pi-tui-session.ts` 及同名测试 | 采用同一 JSONL 同时只有一个写入者的约束；本轮无 TUI/PTY，不移植 guard 或终端实现 |

## 当前运行条件

2026-09-08 只读检查：本 worktree 无已安装的根/agent-host `node_modules`；相邻
`/home/pi/code/ai-client/src/agent-host/node_modules` 有旧 SDK，可通过显式路径复用，避免重装
及修改 P0 的依赖目录。本机 Node 为 `v24.20.0`。

初始未找到 `~/.pilab`、`~/.pi/agent` 下可用的模型/凭据配置，进程也无模型 API 凭据环境变量。
用户随后指定 `https://maxapi.hanyue.xyz`、`claude-sonnet-5` 并提供本次测试凭据。
已验证 `/v1/models`、`/v1/messages` 和旧 SDK `createAgentSession` 真实调用；
[冒烟原始数据](../evidence/p2-0/endpoint-preflight.json)仅用于证明可测，不计入正式基线。
SDK 单次冒烟上报 input=13、cacheRead=502、cacheWrite=202，比率约 97.48%；
费用未知，探针中的零单价不代表免费。测试使用的模型窗口/输出上限只是探针配置，
不代表提供商公布的能力上限。正式套件需冻结自身参数并在 P2-6 复用。

独立脚本与六场景采集已完成；原始结果可离线重算，密钥扫描和局部检查通过。
生产代码及 P0 文件未由本任务修改。P2-6 的版本对齐限制见 Q4，P2-0 不代表整个 P2 完成。

只读资源快照：RAM 3.8 GiB、available 约 2.0 GiB，Swap 使用约 399 MiB，根分区可用约
6.5 GiB。执行前重新检查，并确认 P0 未在运行重门禁；基线会话和测试均串行，禁止整套构建。
