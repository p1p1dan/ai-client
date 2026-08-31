# Roadmap — Application Entry and Environment

> **状态**：Maintenance。原详细 E1/A1/A2/A3、D63–D72 和 GUI 取证见 [history snapshot](./history/2026-08-31-pre-pi-only-realignment/roadmap.md)。

## Done

| Item | 结果 |
|---|---|
| E1 | 证明 legacy 本机配置静态探测答不准；产品选择“不探测、用户自担 local setup” |
| A1 | credential mode 持久化与 Main-owned setting |
| A3 | legacy CLI 探测退门禁；git 缺失改为非阻断应用内提示 |
| A2 | 每次启动两入口；entry mode 与 spawn gate 同源 |
| T-A2b / T-CM1 | 修复 entry/recorded mode 冲突与 settings 双缓存覆盖 Main-owned keys |

## Maintenance residuals

| Item | 状态 | Pi-only 处理 |
|---|---|---|
| T-E1a credential failure surface | Re-triage | 只保留能复用于 Pi managed login 的错误分类/快速失败，不继续修 Claude retry chain |
| Welcome/git notice GUI smoke | Pending environment check | 可与 T37 packaged GUI matrix 合并 |
| Branding consistency | Deferred | 若需要另立独立 migration plan |

## Superseded

- Codex 模型目录空、Claude model 串到 Codex 等 multi-agent 问题归 T35 删除输入，不再施工。
- “使用本机已有 Claude/Codex 配置”的产品文案将在 Pi-only UI 收口时改为用户自己的 Pi setup。
