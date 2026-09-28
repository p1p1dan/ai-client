# 决策 098：提问工具改用 DSH 官方的 `dsh-tool-ask-user`，bridge 只做应答方

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [决策 072](072-renderer-data-channels.md)（P1-7 调研补登「DSH 组合里没有提问工具，P1-4d 要提供」）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4d-9；
- `dsh-user-questions/README.md:33,41,50,55`；`dsh-base/cordis.patch.yml:331`；
- `src/shared/dshPluginAllowlist.ts:182-191,485-486`；`src/dsh-host/permissions/classification.ts`。

## 规则

1. **不自研提问工具**。1.0.x 的 `ask`（`src/runtime/plugins/tools/ask.ts`）不移植，改用 DSH 官方的 `@deepseek-ai/dsh-tool-ask-user@0.1.7-rc.2`，工具名 `ask_user_question`。
   - `dsh-user-questions` 的说明里点名它是这个服务的使用方（`dsh-user-questions/README.md:50,55`）；
   - dsh-base 的 plan-mode 提示词也引用这个工具（`dsh-base/cordis.patch.yml:331`）。
2. **装包**：这个包**不在钉住的树里**（`src/dsh-host/node_modules` 与锁文件都没有）。
   - 按 P1-10 的白名单流程以 `official` 类加入：版本必须等于 DSH 的钉版本，审查从简（`src/shared/dshPluginAllowlist.ts:182-191,485-486`）；
   - 装包要联网，在 CI 上或经授权做，与 P1-10 的实验 E2 同类。
3. **应答方**：bridge 挂 `user-questions/request` 应答方，转成 `question.requested`；`respondQuestion` 把回答交回去，字段对应见 [P1-4 分片 01 §1](../topics/p1-4-bridge-parity/01-event-mapping.md)。发起方中止时撤卡。问答卡沿用 1.0.x 的。
4. **权限分类**：分类表加 `ask_user_question: 'internal'`，不过闸。问用户本身就是交互，1.0.x 的 `ask` 也不过闸（`ask.ts` 文件头）；装包后分类表的静态测试会要求补这一行。
5. **只有根会话能问**：这是 DSH 的规则，子代理问会得到明确的错误（`dsh-user-questions/README.md:33,41`）。
6. **装不上时**：如果装包在合入前做不成，本项推迟到合入之后。这段时间模型用普通文字提问，问答卡不出现。

## 取舍

- **自研提问工具**：约 150 行加测试，与总原则相悖，而且 DSH 已有官方实现。
- **只挂应答方、不装工具**：我方组合里唯一现成的发起方是 plan 模式的 `exit_plan_mode`，而决策 047 没有接 DSH 的 plan 模式，应答方会是死代码。
- **代价**：随包多一个官方包（体积很小，要在构建期审计里过一遍），要一次联网装包。工作量约 1.5 人日，另加装包。

## 影响

- **测试**：`src/dsh-host/permissions/__tests__/` 的分类测试；bridge 单测覆盖应答、跳过、中止撤卡。
- **金样本**：新增 `question` 场景（假网关发起一次 `ask_user_question`，回答一次、跳过一次）。
- **P1-7c**：工具行词表加 `ask_user_question`。
- **迁移**：迁移会话里 1.0.x 的 `ask` 行照常显示。
