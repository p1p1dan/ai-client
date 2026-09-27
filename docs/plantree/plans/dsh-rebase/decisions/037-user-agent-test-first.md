# 决策 037：User-Agent 先实测网关再定；默认接受 DSH 的 UA 并加标识头，网关拦截时在宿主内改写（需要用户授权实测）

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-5 方案 §5 D5](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、F08（`claude-cli-pilab/<版本>`，提交 `69576588`）。

## 规则

1. DSH 把 User-Agent 当保留字，固定发 `deepseek-harness/…`，profile 改不了。F08 的 `claude-cli-pilab/<版本>` 因此发不出去。
2. 先按方案 §7.3 的 R9 实测：请管理员看网关日志里的 UA，确认网关是否按 UA 做准入或统计。
   - 不拦截：选 A，接受 DSH 的 UA，另加标识头（如 `X-Pilab-Client: <版本>`），并通知网关管理员。
   - 拦截：选 B，在宿主里用 fetch 拦截器，只改写发往我方网关的 UA。要与 `dsh-http-proxy` 的全局 dispatcher 组合，DSH 升级时要复核。
3. 实测前，开发与点验一律用假网关，不影响施工。

## 取舍

- 不选「给 `llm-pi-ai` 打补丁」：理由同[决策 036](036-filter-unsupported-protocols.md)。
- **需要用户授权**：R9 要用真实网关和公司账号，归入真实网关验证清单 R1～R10 一起授权。
