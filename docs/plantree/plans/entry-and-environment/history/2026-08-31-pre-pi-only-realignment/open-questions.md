# Open Questions — 应用入口与环境依赖

> 只放未决问题。已定的进 [README](README.md) / [roadmap](roadmap.md)。
> **当前无未决问题**：立项三条已由 D63/D64/D65 拍完，#4 已由 D69 拍完。
> 新问题出现时追加到本文件。

## 已关闭 —— #4 仓库能不能供凭据

由 [E1 取证 §L5](../../../../../plans/2026-08-27-e1-local-credentials/README.md) 提出（2026-08-27），
同日由 **[D69](../../../../../plans/openchamber-chat-refactor-ledger.md) 拍板「都读，维持原状」**（用户原话「都读，这都不是我们要操心的事」）。

存根：一个 clone 来的仓库在 `.claude/settings.json` 里写一段 `env`，就能让我们的对话
**带着它给的钥匙打到它给的地址**（实测 L5）。这一条在 D67 那轮**没有**摆在用户面前
（当时量的是权限 / hooks / CLAUDE.md），故补问了一次 —— **知情后仍然接受**，
`settingSources: ['user','project','local']` 一字不动。理由与 D67 同源：
能挡它的手段正是 D67「甲乙丙」里被否掉的那类「我们去干涉用户的配置文件」。

---

## 已关闭 —— 2026-08-27 立项时的三条

三条立项时的待拍板 **2026-08-27 全部拍完**，原文进总台账
[D63 / D64 / D65](../../../../../plans/openchamber-chat-refactor-ledger.md)，此处只留存根与连带项。

- ~~#1 「使用本机已有配置」的语义与可用性判据~~ —— ✅ **D63：探不到时放行，不置灰**
  （用户原话「探不到时放行，用户自己想办法去」）。
  ⚠️ **连带要求**：既然不拦，**首条消息失败时的错误必须能落到 UI 并说清缺什么** ——
  否则本拍板只是把排查成本转嫁给用户。这与
  [E2 要求的「配置加载失败要带出文件路径+行号」](../../../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)
  是同一件事，合并到 S0' codex 侧处理。
  ✅ **连带简化**：探测不再当闸，可从「能不能起一个空会话」的真探测降级为静态判断。

- ~~#2 凭据模式从构建期开关变成运行期状态~~ —— ✅ **D64：存进 `~/.pilab/<profile>/settings.json`**
  （用户原话「存到我们 pilab 的配置文件」），不进 vault。
  ⚠️ **改写了 [unified-credentials S3](../../../unified-credentials/roadmap.md) 的形状**，两者同轮定。
  **留给 S3 同轮定的余量**：能否中途切换、切换时在途会话怎么办。

- ~~#3 环境检查的去留与摆放~~ —— ✅ **D65：只保留 git；agent 探测退出启动门禁；非 Windows 只给提示**
  （用户原话「目前的探测感觉保留一个 git 就行了，非 windows 给个提示」）。
  ⚠️ **落档时核出的范围修正**：退役的是**启动门禁那条链路**，**不是 `CliDetector` 本身** ——
  `AgentSettings.tsx` 仍在用 `cli.detectOne` 探测第三方与自定义 agent（droid / gemini / auggie / custom），
  那些确实没随包；远端 helper 也暴露同名 RPC。一刀切删会打断设置页。
