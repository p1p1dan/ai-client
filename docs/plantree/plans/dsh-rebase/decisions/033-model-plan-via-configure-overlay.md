# 决策 033：Main 生成不含 key 的「模型计划」，宿主启动时经控制通道以内存 overlay 注入

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-5 方案 §5 D1](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、[分片 03](../topics/p1-5-models-and-credentials/03-design.md)。

## 规则

1. 纯函数 `src/shared/dshModelPlan.ts` 把现有内存目录（`resolveNativeModelCatalog()` 的 `models` 半）翻成模型计划，包括：
   - `llm-pi-ai` 路由：不含 key，只有 `apiKeyEnv` 引用名；
   - 默认模型；
   - 我方 id 到 `{route, model, efforts, image}` 的索引；
   - 引用名表；
   - 被丢掉的项和原因；
   - 修订号。
2. 宿主启动后的首条控制消息 `configure` 带上计划，宿主以内存 overlay 注入 `llm-pi-ai` 和 `agent-default-model` 两行，不写盘、不进环境；`ready` 回报修订号和路由诊断。
3. 菜单只列计划里的模型，不受支持的计入 `unavailable` 并在菜单底部提示。菜单项带上计划里的 `efforts`，渲染层直接用它。
4. 目录一变就重启宿主（沿用[决策 025](025-host-lifecycle.md) 的 `invalidateAll`）。另加一条兜底：修订号与在跑的宿主不一致时，排一次 `invalidateAll`，有在飞回合就等到空闲。这补上了登录后异步同步、启动同步这两个 1.0.x 也没覆盖的窗口。
5. 删掉 bundle 里的假路由和 `AICLIENT_DSH_GATEWAY_*`。开发与点验改为把假网关登记成用户服务。

## 取舍

- 不选运行中热更新配置：以后可以作为优化，现在只保留一种状态。
- 不选写进 profile 补丁文件：会落盘。
- 不选用环境变量传 JSON：会进工具环境。
- 代价：目录变更要冷启动一次宿主（约 0.8 s）。
