# 决策 003：P0 收口进入 P1；DSH 钉精确版本；暂不加 Claude SDK 引擎

日期：2026-09-26。来源：用户确认 [P0-5 收口](../evidence/p0-5-closeout-2026-09-26.md) 的三项建议。

## 规则

1. **进入 P1。**
   - 按[决策 002](002-defer-encrypted-machine-and-shared-host.md) 修订后的门槛，P0 各项退出判据都已满足（Linux + 普通 Windows）。
   - 加密机仍是 P2 前的否决关。
2. **Q004：钉 `next` 通道的精确版本，目前为 `0.1.7-rc.2`。**
   - 锁文件入库，不用范围版本，不自动追 rc。
   - 升级作为单独任务：升版本 → 重跑 P0 回归（`bridge-smoke.ts`、`goal-probe.ts`、`p0-6-probe.ts`、Windows CI）→ 复核白名单插件的 peer → 合入。
   - 只在需要上游修复或新能力时升级；升级节奏在 P2 定。
3. **Q006：暂不加 Claude Agent SDK 引擎，全力做 DSH。**
   - 依据：用户在自己的 Windows 机上用官方 DSH Desktop + 自家网关的 Claude 试用，「在 DSH 中体验感会好很多」。差距主要在驾驭层（提示词、工具形状、内置工具），DSH 已能明显改善。
   - 省掉的代价：5～7 人周、随包分发第三方重打包的 Claude Code 及其许可风险、每平台约 +55～75 MB、阶段性三引擎。
   - 重议条件：P1 做完后，Claude 在 DSH 引擎下仍有明显差距。到时 P1 的「按会话选引擎」接缝可以直接复用。更轻的备选是做「Claude 专用配置」宿主插件（Claude 风格的提示词段与工具形状，不照抄 Claude Code 的提示词）。
   - 调研留作参考：[Claude SDK 引擎调研](../../../../plans/2026-09-26-claude-sdk-engine-study.md)。

## 影响

- roadmap：P0-5 完成；P1 拆成任务。
- open-questions：Q004、Q006 移出。
- 自有 runtime 上的「提示词 / 工具改良」不做，理由是 P2 冻结后作废（调研 §1）。
