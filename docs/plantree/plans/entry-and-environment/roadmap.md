# Roadmap — 应用入口与环境依赖

> 状态：**Planning**。三条待拍板未清（见 [open-questions](./open-questions.md)），**不可进 execute**。
> 依赖链决定了顺序：登录页是**最后一步，不是第一步**。

## 依赖链

```
settingSources 决策（unified-credentials open-q #6）──┐
                                                       ├──► E1 「本机可用」探测
S0' codex 侧（unified-credentials，前置已清）─────────┘              │
        │                                                             │
        └──► S3 翻开关 ──► 「登录」不碰本地环境 ────────────► A2 两按钮登录页
                    │                                                 │
      A1 凭据模式建模（待拍板 #2）───────────────────────────────────┘
```

## Next（按依赖序）

### E1 — 「本机已有配置可用吗」探测（取证，非施工）

**排最前的理由**：待拍板 #1 没有它就只能靠猜，而猜错的后果是**第二个按钮变成假承诺** ——
用户点进去一切正常，发第一条消息才炸，错误信息还埋在 CLI 里面。

要回答的：不注入的情况下，claude / codex **各自**能不能自己拿到可用凭据。
已知的凭据来源至少三处：`~/.claude/.credentials.json`（官方订阅 OAuth）·
`~/.claude/settings.json` 的 `env` · 进程环境变量。

**已知的两个坑**（都已取证，见 [kickoff §1.6](../../../plans/2026-08-27-entry-design/kickoff.md)）：
- 我们今天传 `settingSources: []`，**主动屏蔽了第二处** ⇒ 这条不解决，探测结论对那类用户无意义。
- codex 侧「检测到有配置」**不等于**「能用」：[E2](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)
  实测用户 config 里一行遗留 `profile =` 就能让会话起不来。

**依赖**：unified-credentials 的 open-q #6 —— ✅ **取证已完成**
（[取证档](../../../plans/2026-08-27-settingsources-spike/README.md)，2026-08-27）：
`settingSources` 可以打开，`managedSettings: { permissions: { ask: ['*'] } }` 一行就能把权限卡摁回来。
**但还剩两条待拍板**（权限卡粒度 · 仓库提交的 hooks 会不会被执行），E1 开工前须定。

### ~~A1 — 凭据模式建模~~ ✅ 已落地（2026-08-27，与 unified-credentials S3 同轮）

`~/.pilab/<profile>/settings.json` 里的 `credentialMode`，规则在 `@shared/credentialMode`。
**写入口目前只有「登录」** —— 用户可见的二选一正是下面 A2 要补的那一半。
**留给 A2 同轮定**：能否中途切换、切换时在途会话怎么办。

### ~~A1 原文~~（保留作对照）

把「用哪套凭据」从 `AICLIENT_MANAGED_CREDENTIALS` 这个**构建期开关**变成**运行期状态**。
需要决定：存在哪（大概率 `~/.pilab/<profile>/settings.json`）· 能否中途切换 · 切换时已有会话怎么办。

**依赖**：unified-credentials 的 **S3** —— 本项直接改写 S3 的形状，两边必须同轮定。

### A3 — 环境检查退役与重新摆放（待拍板 #3 落地）

三件事，**不能混为一谈**：
1. **清债**：`resolveGateDecision` 里那条来自系统 `claude --version` 的 `cliMissing` 分量退役
   （`ClaudeRuntimeChecker` 已在 2026-08-26 退役了它的另一半，门禁没跟上）。
2. **保留但换位置**：git 检查。本产品是 worktree 管理器，git 是真依赖，不是可选项。
3. **补缺口**：非 Windows 缺 git 时，今天只能检测、装不了，也没有明确降级文案。

⚠️ 清理时**不要连带删掉**系统 `claude` 探测的另一个真用途：应用内终端里用户敲 `claude`
跑的是他系统上的那个（[kickoff §1.5](../../../plans/2026-08-27-entry-design/kickoff.md)）。

### A2 — 两按钮登录页

视觉参照与我们必须偏离参照的地方，见
[kickoff §2](../../../plans/2026-08-27-entry-design/kickoff.md)。

⚠️ **不是换皮**：现有 onboarding 是四步状态机（`cli-check → cli-install → register-email →
register-code → result`），改成两按钮首屏等于**重画 `resolveGateDecision`**。
好消息：它是纯函数、有完整单测。

**依赖**：E1（第二个按钮的可用性判据）· ~~A1~~（已落地：两个按钮分别写 `credentialMode` 的两个值）·
A3（门禁不再因系统 CLI 缺失而拦人）· unified-credentials S3（「登录」这条路真的不碰本地环境）。

## Deferred

- **远端** —— 用户 2026-08-27 明确本轮不考虑。
- **品牌口径统一** —— 现在是五个名字，记在
  [unified-credentials open-q #4](../unified-credentials/open-questions.md)，与本 plan 无依赖。
