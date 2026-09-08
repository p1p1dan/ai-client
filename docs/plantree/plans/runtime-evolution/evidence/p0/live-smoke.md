# P0-6 在线冒烟 — ARD 风险 R1 关闭记录

日期：2026-09-08 · 采集时代码：`3ce9702e` + 当时未提交的 `src/runtime/`（`config_version: runtime_p0_v1`）；现已提交至 `8a71c843`
命令：`node --experimental-strip-types src/runtime/smoke/runOnce.ts --agent-dir <dir> --model <provider>/<id>`

目录取自用户提供的 `~/.pilab/pi-agent/`（4 provider / 10 model，网关 `cch-jyw.pipidan.qzz.io`）。
凭据与 baseUrl 不入本文件，也不入 trace——已核对：trace 里既无 key 也无网关地址。

## 结果

三种 wire 协议全部端到端跑通，R1 关闭。

| provider | api | model | 结果 | 输出 | 延迟 | input | cacheRead | 命中率 |
|---|---|---|---|---|---|---|---|---|
| claude | `anthropic-messages` | claude-sonnet-5 | ✅ | `ready` | 4.4s | 53 | 0 | 0% |
| claude | `anthropic-messages` | claude-opus-5 | ✅ | `ready` | 5.5s | 53 | 0 | 0% |
| gpt | `openai-responses` | gpt-5.6-terra | ✅ | `ready` | 98.3s | 889 | 7488 | 89.4% |
| gpt | `openai-responses` | gpt-5.6-sol | ✅ | `ready\n` | 17.4s | 480 | 4608 | 90.6% |
| grok | `openai-completions` | grok-4.6 | ✅ | `ready` | 8.3s | 2041 | 128 | 5.9% |
| china | `openai-completions` | glm-5.2 | ✅ | `ready` | 3.2s | 36 | 0 | 0% |
| gpt | `openai-responses` | gpt-5.6-luna | ❌ | — | 6.9s | — | — | — |

命中率按 ARD D9 的口径算：`cacheRead / (input + cacheRead)`。这些数字只是顺带记录的
单轮样本，**不是 P2-0 的基线**（基线要六场景脚本会话，见 `topics/p2-0-cache-baseline.md`）。

`gpt-5.6-luna` 的失败是网关侧上游不可用（HTTP 503 `service_unavailable_error`，
`所有供应商暂时不可用`），同一 provider 的另外两个 model 同时刻正常，故判定与 runtime 无关。

## 过程中暴露的一个配置事实

第一轮四个 provider 的 `baseUrl` 都是 `https://cch-jyw.pipidan.qzz.io/v1`，
`claude`（`anthropic-messages`）稳定 503 `所有供应商暂时不可用`。用户指出端点按模型族分：

- **Anthropic 系**：`https://cch-jyw.pipidan.qzz.io`（**不带** `/v1`）
- **OpenAI 系**：`https://cch-jyw.pipidan.qzz.io/v1`（**必须带** `/v1`）

原因是两边 SDK 各自追加路径，Anthropic adapter 会补 `/v1/messages`，base 再带 `/v1`
就成了 `/v1/v1/messages`。把 `claude` 的 `/v1` 去掉后立刻通过。

**对 P4/P5 的影响**：`models.json` 的每个 provider 各自带 `baseUrl`，
`toPiModelsJson` 只有在 `credentials.baseUrl === 'managed'` 时才用 provider 自己的值，
否则一律继承登录 baseUrl。所以「所有 provider 共用一个登录 baseUrl」的目录对 Anthropic
provider 必然是错的——这条要在 P5-5「模型目录切源」时确认托管端的下发口径。

失败长相是 503 而不是 404，**读起来像上游宕机而不像配错地址**，排查时先查 baseUrl 再下结论。

## 顺带记录：pi-ai 的 OpenAI 重试阶梯很慢

`gpt-5.6-terra` 那次成功耗时 98s，第一轮 `gpt-5.6-luna` 的失败耗时 110s——
都是 OpenAI SDK 自带的 `maxRetries` 阶梯在跑。P0 没有自己的重试层（PI-Desktop 有
`provider-retry.ts`），这个默认值在 P4-4 端到端和用户可感延迟上会是问题，
搬运 `createProviderRetryStream` 时一并处理。
