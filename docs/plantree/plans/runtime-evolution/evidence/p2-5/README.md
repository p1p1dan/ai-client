# P2-5 / P2-6 · 真实缓存命中率与新旧后端对比

Role: evidence。日期：2026-09-12。对应[执行顺序](../../README.md#执行顺序)第 6 批。
权威口径：[ARD D9](../../../../plans/2026-09-08-runtime-evolution-ard.md)（命中率公式）与 [P2-0 基线](../../topics/p2-0-cache-baseline.md)（固定套件 `p2-0-v3`）。

## 结论

自有 runtime 在真实网关上跑完 P2-0 的同一套六场景，**整套 token 加权命中率 99.97%**，
高于 95.01% 的门禁线。同一网关上重采的旧后端是 **99.97%**，两者相差 **-0.0073 个百分点**。
也就是说：换到自有 runtime 之后，缓存命中率没有可观察的退步。

| 后端 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |
|---|---|---|---|---|---|
| legacy（同网关重采） | 28 | 56 | 214067 | 90783 | 99.9738% |
| native（自有 runtime） | 28 | 56 | 167236 | 68117 | 99.9665% |
| legacy（2026-09-08 历史归档，另一网关） | 28 | 9599 | 182929 | 79406 | 95.01% |

逐场景数字、依赖版本与声明过的口径差异，见[对比报告](comparison.md)（由 `compare.mjs` 生成）。

## 为什么要重采旧后端

命中率主要是**网关**的性质，不是模型本身的性质。2026-09-08 那条 95.01% 是在
`https://maxapi.hanyue.xyz` 上采的；今天那个网关已经不供 `claude-sonnet-5`（只剩 2 个模型，
无任何 Claude）。如果新 runtime 在新网关上跑、然后直接对着 95.01% 比，差值里就同时混了
「换后端」和「换网关」两个变量，结论没法归因。

所以本轮用户拍板的做法是：**两个后端都在同一个网关上重采**，95.01% 退为历史参考值。
本次网关由用户提供（`http://107.173.157.208:23000`）。它的 `/v1/models` 不列任何 Claude 模型，
但 `/v1/messages` 真实转发 `claude-sonnet-5`（HTTP 200、返回真实 message id、模型字段回显），
而这正是套件里写死的 `anthropic-messages` 口径——所以**模型与基线一致，只换网关，且两个后端共用它**。

探测脚本：`scripts/runtime-baseline/preflight.mjs`（凭据只作请求头，不落任何归档）。

## 这次测到的和没测到的

### 测到了

- 六个场景在自有 runtime 上**全部真实跑通**：多轮文件工具、bash 搜索、长文件截断与分页、
  显式压缩后续聊、dispose 后 resume 续聊，断言与旧后端完全同一套（`suite.mjs` 未改一个字节，
  两边 manifest 的 suite SHA-256 相同）。
- 两边的**模型调用次数都是 28 次**，逐场景调用数与工具调用数一一对应（见对比报告表格）。
- 命中率从原始 usage 重算得到，离线复核脚本独立跑通（见下方"复现"）。

### 一个必须讲清楚的前提

在这个网关上，**D9 那个比率会饱和**。旧网关的第一轮要真金白银花 input token（历史归档整套
input 是 9599），新网关几乎把整段前缀直接写进缓存：两个后端整套 input 都只有 56 个 token，
于是 `cacheRead / (input + cacheRead)` 必然逼近 100%。

所以 99.97% 这个数字证明的是「达标」，**不是**「新 runtime 的缓存做得比旧的好 0.0073 个百分点」——
这个量级的差异在这条公式上没有分辨力。真正有分辨力的是下面两个量。

### 更有信息量的信号：前缀是否被打断

每次请求的系统提示词逐字节比对（`trace.jsonl` 里记的 `systemPromptSha256`）：

| 后端 | 每个场景内不同的系统提示词 | 系统提示词字节 | 上到线上的工具数 |
|---|---|---|---|
| native | 1 种（B05 的第 2 种是压缩摘要请求自己的短提示词） | 2260 | 7（read/write/edit/bash/glob/grep/new_context） |
| legacy | 1 种 | 4626 | 5（注册 9 个，按平台过滤后上线 5 个） |

两边在一次会话内都**没有发生过前缀变更**——这正是 P2-8 当初把预算提醒改成尾部消息注入、
而不是追加进 systemPrompt 想要保住的性质，本轮用真实命中率复核通过。

第二个信号是每轮的 `cacheWrite`：首轮写入整段前缀之后，后续每轮只再写几十个 token
（例：B01 三轮分别是 16816 / 33 / 61），说明新增的只有当轮对话内容，缓存前缀本身没被作废。

顺带一个事实：自有 runtime 的前缀更小（系统提示词 2260 字节 vs 4626），整套 cacheRead
与 cacheWrite 都明显低于旧后端（167k/68k vs 214k/91k），也就是同样六场景下，token 总量更省。

## 口径差异清单（采集时就声明，不是事后补注）

`run-native.mjs` 把无法对齐的设置写进 manifest 的 `settingDeviations`，`compare.mjs` 在缺少
这个字段时会拒绝出报告——避免把「没对齐」说成「完全一致」。

1. **pi 协议依赖 patch 差**：native 是 0.84.4，legacy 是 0.84.3。按 [ARD D12](../../../../plans/2026-09-08-runtime-evolution-ard.md) 不回退对齐，记为已知偏差。
2. **压缩阈值不可配**：基线显式设了 `reserveTokens=4096 / keepRecentTokens=1024`；自有 runtime
   的这两个数是**从模型窗口推导**的（`plugins/context/budget.ts`），没有对应旋钮。B05 走的是
   用户显式 `/compact` 的强制路径，不依赖阈值，所以场景本身仍然可比；但"同参数"这句话在
   native 侧不成立，不能这么写。
3. **压缩开关**：基线关掉自动压缩；native 侧必须保持 `context.enabled = true`，否则 B05 的
   强制压缩路径直接不可用。这个上下文规模下自动压缩不可能触发（远低于阈值），行为等价。
4. **工具集不同**：native 是自己的 7 个工具，legacy 是 SDK 的那一套。这是两个后端的**定义差异**，
   不是配置偏差，它直接反映在前缀大小上。
5. **重试**：套件关掉了 legacy 的重试；native 的重试在 loop 里，重试且未走到 `turn_end` 的请求
   不产生 usage 行。本轮没有观察到重试。
6. **Node 版本**：两次采集都是 v22.23.2；历史归档是 v24.20.0。两边一致，不影响本次对比。

## 缓存温度（可比性的最后一个坑）

同一请求体在网关侧有 prompt cache，间隔太短会让第二次"白捡"缓存。实测确认：

- 同一个请求发两次拿到**不同的 message id**，网关**没有**做响应缓存，每次都是真实测量。
- B01 在 run-01 与 run-02 的第 1 次调用都是 `cacheRead=0 / cacheWrite=16816`，即**两次都是冷的**，
  说明间隔 20 分钟以上缓存已过期。
- 唯一受影响的是 **B02**：run-02 的 B02 与 run-01 的 B02 相隔约 8 分钟，前缀仍有残留，
  命中率从 99.8858% 变成 99.9037%，**差 0.018 个百分点**。这是本轮唯一一处"温"的数据，
  量级已量出来，没有藏。
- legacy 只跑了一次，全冷。

## 失败记录

`run-20260912-native-01` 在 B03 失败并保留：模型调了 `grep`，但 bash 返回
`grep: command not found`（exit 127）。原因是**采集脚本自己的配置错误**——照抄 smoke 入口传了
`standaloneHost({})`（空环境），`commandEnvironment` 从 `childEnv` 推导 PATH，于是子进程没有 PATH。
生产里 worker 传的是真实进程环境。修成 `standaloneHost(process.env)` 后重采为 run-02。
**不是 runtime 缺陷**，但按 P2-0 的规矩失败样本原样留档，不删轮次拼成功。

## 复现

```bash
# 网关探测（凭据走环境变量，不进归档）
P2_GATEWAY_API_KEY=<secret> node scripts/runtime-baseline/preflight.mjs \
  --base-url http://107.173.157.208:23000 --model claude-sonnet-5

# 自有 runtime 六场景
P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run-native.mjs \
  --base-url http://107.173.157.208:23000 --out <新目录>

# 旧后端同网关重采
P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run.mjs \
  --sdk-host src/agent-host --base-url http://107.173.157.208:23000 --out <新目录>

# 离线复核（不访问网关）
node scripts/runtime-baseline/verify-native.mjs run-20260912-native-02
node scripts/runtime-baseline/verify.mjs       run-20260912-legacy-01

# 生成对比报告
node scripts/runtime-baseline/compare.mjs \
  --legacy run-20260912-legacy-01 --native run-20260912-native-02 \
  --archive ../p2-0/baseline-20260908 --out comparison.md
```

一处归档精度说明：采集跑完之后 Biome 重排了 `run-native.mjs` 的格式（纯换行，无行为变化），
所以 manifest 的 `files` 里那条摘要是**格式化之前**那一版的；今天重新哈希这个文件会对不上，
不是篡改。两个 verifier 都不依赖这个字段，格式化后重跑仍然全绿。

两个 verifier 都从原始会话 JSONL、逐调用 usage 和执行 trace 重新算一遍比率，并重跑每一步断言；
它们不访问网关。native 侧额外核对 v4 会话头、压缩条目与 retained tail、B04 的截断与续读证据。

## 本轮不能声称的事

- 不能说这是**默认阈值**下的压缩行为验收：B05 是显式 `/compact`，不冒充自动阈值触发。
- 不能说 99.97% 是自有 runtime 的能力上限或某种保证：它是这一个网关、这一个模型、这一套
  固定会话的一次测量。换网关必然换数字（历史归档就是 95.01%）。
- 不能用本轮结论覆盖 Windows / 加密机现场：本轮全部在开发机、纯 Node、无 Electron。
- 不能说费用已知：网关未公布单价，usage 里的零单价是占位值。
