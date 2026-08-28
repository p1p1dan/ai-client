# Plan — 应用入口与环境依赖

> 2026-08-27 立项。触发：用户在 S2 收口后提出「启动时的环境检查是不是已经没必要了」，
> 并给出想要的启动首屏形态（两按钮登录页）与一条硬约束（登录不许影响本地环境）。
> 立项讨论与已核实事实的原文：[kickoff](../../../plans/2026-08-27-entry-design/kickoff.md)。

**状态：Planning**（立项时的三条待拍板 **2026-08-27 已全部拍完** → [D63/D64/D65](../../../plans/openchamber-chat-refactor-ledger.md)；
A1 已随 unified-credentials S3 落地；**E1 取证同日已跑完并落档** →
[E1 取证](../../../plans/2026-08-27-e1-local-credentials/README.md)，
但其**产品建议当日即被 [D68](../../../plans/openchamber-chat-refactor-ledger.md) 整体推翻** ——
两条路线彻底分开，**第二个按钮不做任何探测、也不为它做失败面**；
**A3 与 A2 同日亦已落地** —— A3：门禁清债 + git 检查换成不拦人的提示 + 补上非 Windows 缺口；
A2：两按钮登录页 + 门禁换轴 + onboarding 四步收成两步。
⇒ **主线四件全部走完**。登录页按 [D71](../../../plans/openchamber-chat-refactor-ledger.md) 定为
**每次启动都出现的首屏**（凭据模式因此整个退出门禁，T-A2a 连带作废 —— 重启就是切换）；
剩 T-E1a（登录线失败面，低优先级）与全线欠的一笔 **GUI 点验**）

## Scope

**In scope**：启动首屏形态（两按钮登录页）· 环境检查的退役与重新摆放（agent 探测 / git 检查）·
「用哪套凭据」从构建期开关变成**运行期状态**的建模 · 「使用本机已有配置」所需的本机可用性探测。

**Out of scope**：凭据保险库与注入通路本身（属 [unified-credentials](../unified-credentials/README.md)）·
登录/注册的服务端协议 · 远端（用户明确本轮不考虑）· 品牌口径统一。

## 为什么另立一个 plan 而不并进 unified-credentials

`unified-credentials` 的 Out of scope 里写明**「登录/注册流程本身的改动」不在其内**。
本 plan 要动的正是那条流程，以及它上游的环境探测与门禁 —— 两者的承重面不同：
前者管「凭据从哪来、怎么送」，本 plan 管「用户进门看到什么、我们向机器要什么」。

两者有一条**真依赖**（见 [roadmap](./roadmap.md) 的依赖链）：登录页排在最后，
它下面压着 unified-credentials 的 S0' codex 侧、S3，以及那边的 open-q #6。

## 起点认知（2026-08-27 已核实，不是设想）

| 用户的判断 | 仓内实况 | 差距 |
|---|---|---|
| node / claude / codex 都随包了 | ✅ 成立（cometix 2.1.212 · codex 0.149.1 · `resources/node-runtime`） | 无 |
| 所以环境检查没必要了 | ⚠️ 一半 —— `ClaudeRuntimeChecker` 已按此改（2026-08-26），但**门禁里还有一条独立的系统 `claude` 探测没退役** | 清债 |
| git 可能要单独处理 | ✅ 且比预想更偏 —— git 是**真依赖**（worktree 产品），而自动安装**只有 Windows 有** | 补非 Windows 处置 |
| 登录后不影响本地环境 | ✅ **Claude 侧已做完**（S0' `77ff5dd4`）；codex 侧未做、默认开关未翻 | 依赖 unified-credentials |
| 用 `--settings` 注入 | ⚠️ 随包 cli.js 确实支持，但**不该用** —— 现有 env 通路更干净，且 `--settings` 正是 D60 要拿掉的形态 | 判断修正，无需新机制 |

逐条证据见 [kickoff §1](../../../plans/2026-08-27-entry-design/kickoff.md)。

## 文件

- [roadmap.md](./roadmap.md) — 阶段与依赖链（**下一件 = E1**）
- [open-questions.md](./open-questions.md) — **当前无未决**（立项三条 D63/D64/D65，#4 由 D69 关闭）
- [kickoff](../../../plans/2026-08-27-entry-design/kickoff.md) — 立项讨论原文 + 登录页视觉参照
- [E1 取证](../../../plans/2026-08-27-e1-local-credentials/README.md) — 「本机已有配置」能探到什么（Claude 十一臂 + Codex 十四臂，全离线）。
  ⚠️ 读它时注意角色：D68 之后它**不是设计输入**，而是**「为什么不该做这个探测」的实证依据**

## 权威顺序

沿用全树口径：ARD ＞ 执行计划 ＞ 总台账（决策）＞ 本树（当前状态）。
