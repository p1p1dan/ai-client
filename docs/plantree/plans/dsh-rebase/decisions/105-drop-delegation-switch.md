# 决策 105：1.0.x 的委派总开关与停用名单在 DSH 版作废，DSH 的子代理始终可用

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md)：总原则；062 / 070 的裁决「只用 DSH 自带的子代理」；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-10；
- `src/main/services/agent-host/nativeSubagentSettings.ts:37-58`；`dsh-base/cordis.patch.yml:348-387`。

修订：取消 P1-10 / P1-16 方案分片 03 §2.4 的「委派总开关关掉时，overlay 关掉 `tool-subagent*` 各行」。

## 规则

1. **作废**：1.0.x 的委派总开关与按定义的停用名单在 DSH 版里不再生效。
   - 总开关：共享设置里 `PI_OPT_IN_FEATURE_SETTINGS_KEY` 的 `subagents` 项，以及旧键 `PI_ENABLE_SUBAGENTS_SETTING_KEY`；
   - 停用名单：`nativeSubagentsDisabled`。
   - DSH 的 `subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents` 照 dsh-base 始终挂载（`dsh-base/cordis.patch.yml:348-387`）。
2. **提示**：用户显式把总开关设成关的，由[决策 104](104-legacy-asset-notice-and-extension-pages.md) 的旧资产提示说明「新版的子代理始终可用」。没设过的，1.0.x 本来就当作开着（`nativeSubagentSettings.ts:52-53`），不提示。
3. **设置键不删**，回装 1.0.x 照旧读到。

## 取舍

- **映射成宿主 overlay**（总开关关着时，关掉 `tool-subagent*` 等行）：
  - 约 30 行；
  - 但开关的入口在要删的「子代理」页上（决策 104），得另找地方放；
  - 切换要重启宿主；DSH 本身也没有这个开关。
- **停用名单**针对的是自定义与内置的 4 个定义。定义不再加载（决策 090），名单自然作废。
- **代价**：极少数关过委派的用户会看到模型开始使用子代理。
- **与「设置能迁移」的关系**：这里的口径是，DSH 版里已经没有对应功能的设置，按「给出提示」处理，不做迁移。请审批时与决策 102、103 一起确认这个口径。

## 影响

- **测试**：Main 里读这组设置的地方只剩旧资产提示的检测；`nativeSubagentSettings.ts` 与相关测试在 P1-12 随 native 删除。
- **P1-7**：子代理面板不需要处理「委派已关闭」的状态。
