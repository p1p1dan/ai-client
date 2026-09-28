# 决策 085：P1-5 宿主侧接线与凭据注入的实现取舍

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：P1-5 / P1-5b 实现（`c8bcdab1`）、[决策 033](033-model-plan-via-configure-overlay.md)、[034](034-per-request-credential-pull.md)、[037](037-user-agent-test-first.md)、[077](077-model-plan-implementation-choices.md)。

## 规则

1. **宿主等计划再启动**：宿主收到 `configure` 之前不组合配置；10 s 内收不到，就报 `fatal` 退出。Main 每次拉起宿主都会先发 `configure`，而且每次换一个新 nonce。
2. **决策 077 第 2 条在宿主注入时补**：每个模型显式补上 `contextWindow`、`maxTokens`、`input`，这一步放在宿主把计划注入成 overlay 的时候做，不在 Main 生成计划时做。所以 P1-5a 的计划金样本和修订号都不变。
3. **错误文本里回显的 key 要打码**，这是方案之外主动加的：
   - 有的服务商会把 key 原样写进错误文本，不打码的话，key 会跟着失败信息写进会话日志；
   - 打码放在 `aiclient-credentials` 行里，只处理 `llm/stream` 里带失败信息的结束块；
   - 宿主只保留最近 32 个已发 key 的 sha256 和长度，不存 key 本身，靠这个认出回显；
   - 另外叠加仓库已有的按 key 形状打码的规则。
4. **会话所用的模型不在计划里**：
   - 打开会话仍然成功，落在默认模型上，方便查看历史；
   - 发消息时拒绝，失败码 `MODEL_NOT_CONFIGURED`。
5. **计划重建的时机**：打开模型菜单、托管同步成功、拉起宿主，一共三处。每次重建都清掉 broker 的 key 缓存。修订号变了以后，等没有在飞的工作再重启会话，每 2 s 检查一次。
6. **失败码与卡片**：`session.failed` 带上失败码（`src/shared/dshFailureCodes.ts`）。只有 `CREDENTIALS_UNAVAILABLE` 有专门的卡片（「请重新登录或检查 AI 服务的 key」），其余走通用卡片。顺手做了 P1-4d 的两件事：`message.started.model` 改报我方的模型 id；失败码接到了 `session.failed`。
7. **测试用的计划不重试**：冒烟、录制、探针下发的假网关计划不重试，这样录制出的样本稳定、跑得快；集成测试用产品的真实设置（重试 3 次）。
8. **User-Agent**：实测发出的是 `deepseek-harness/0.1.7-rc.2`，另外加了标识头 `X-Pilab-Client: <版本>`，即决策 037 的方案 A。网关会不会按 UA 拦截，要等 R9 实测。

## 取舍

- **KEY-CANARY 门禁**（集成测试 IT-06）：用一个唯一的 `sk-canary-…`，跑了两路由回合、工具打印完整环境、服务商 401 回显 key 三种情况，然后扫描以下位置，全部零命中：
  - `DSH_HOME` 下 79 个文件，其中 19 个按 zstd 解压后再扫；
  - 宿主的 TMPDIR；
  - 宿主的 stderr；
  - Main 的日志；
  - 宿主的 `/proc/<pid>/environ` 和 `cmdline`；
  - 工具进程的环境；
  - 发往界面的事件。

  回显的 key 在日志里落成 `[redacted]`；`.credentials.yaml` 从未出现。
- 仍然要用户授权的：真实网关验证 R1～R10，约 50 次小请求。在那之前，分支上只用本地假网关验证过。
