# 决策 077：P1-5a 模型计划的实现取舍（目录拼不出来时菜单清空；每个模型显式写上下文窗口等值）

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：P1-5a 实现（`src/shared/dshModelPlan/`）、[P1-5 方案](../topics/p1-5-models-and-credentials.md)、决策 033～036、040。

## 规则

1. **目录拼不出来时菜单清空（行为变化，请重点审批）**：钥匙串锁住、未登录、什么都没配置时，计划为空，菜单也清空，底部给出提示；AI 设置里的补全模型选择同样只剩计划里的模型。不再像 1.0.x 那样退回读磁盘上的 `models.json`，理由与决策 034「不退回读明文 `auth.json`」相同：那些模型在 DSH 下拿不到 key，列出来也用不了。
2. **每个模型都显式写 `contextWindow`、`maxTokens`、`input`**：路由键如果与 pi-ai 内置 provider 同名（例如用户服务叫「OpenAI」，路由键就是 `openai`），DSH 会用内置目录来填模型没写的这几个值，结果与原生的缺省值 128000 / 8192 不一致。显式写出就不受影响。在接线宿主侧时补上。
3. `dropped` 分两类：
   - 模型级（`unsupported_api`、`no_base_url`、`no_api_key`、`credential_header`）：菜单少一行；
   - 字段级（compat、samplingParams、头）：只丢字段，模型保留。
4. 「像凭据的头名」按子串判断（auth、token、secret、password、cookie、api-key 等），命中就丢掉整个 provider，比方案举的例子更严，以免 key 经头部进入计划。
5. 设置映射写进路由：改缓存 TTL、空闲超时、重试设置会改变修订号，由修订号比对触发 `invalidateAll` 重启宿主（决策 033 第 4 条）。
6. provider 的 `authHeader` 字段忽略，原生也忽略。只有 off 一档的档位声明按非推理模型处理，这类模型菜单里原来会显示的「Off」不再出现。
