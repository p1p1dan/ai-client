# Open Questions — 应用入口与环境依赖

> 只放未决问题。已定的进 [README](./README.md) / [roadmap](./roadmap.md)。
> 三条都是**待用户拍板**，不是待调研（调研部分已在
> [kickoff §1](../../../plans/2026-08-27-entry-design/kickoff.md) 做完）。

## 已关闭（存根）

三条立项时的待拍板 **2026-08-27 全部拍完**，原文进总台账
[D63 / D64 / D65](../../../plans/openchamber-chat-refactor-ledger.md)，此处只留存根与连带项。

- ~~#1 「使用本机已有配置」的语义与可用性判据~~ —— ✅ **D63：探不到时放行，不置灰**
  （用户原话「探不到时放行，用户自己想办法去」）。
  ⚠️ **连带要求**：既然不拦，**首条消息失败时的错误必须能落到 UI 并说清缺什么** ——
  否则本拍板只是把排查成本转嫁给用户。这与
  [E2 要求的「配置加载失败要带出文件路径+行号」](../../../plans/2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md)
  是同一件事，合并到 S0' codex 侧处理。
  ✅ **连带简化**：探测不再当闸，可从「能不能起一个空会话」的真探测降级为静态判断。

- ~~#2 凭据模式从构建期开关变成运行期状态~~ —— ✅ **D64：存进 `~/.pilab/<profile>/settings.json`**
  （用户原话「存到我们 pilab 的配置文件」），不进 vault。
  ⚠️ **改写了 [unified-credentials S3](../unified-credentials/roadmap.md) 的形状**，两者同轮定。
  **留给 S3 同轮定的余量**：能否中途切换、切换时在途会话怎么办。

- ~~#3 环境检查的去留与摆放~~ —— ✅ **D65：只保留 git；agent 探测退出启动门禁；非 Windows 只给提示**
  （用户原话「目前的探测感觉保留一个 git 就行了，非 windows 给个提示」）。
  ⚠️ **落档时核出的范围修正**：退役的是**启动门禁那条链路**，**不是 `CliDetector` 本身** ——
  `AgentSettings.tsx` 仍在用 `cli.detectOne` 探测第三方与自定义 agent（droid / gemini / auggie / custom），
  那些确实没随包；远端 helper 也暴露同名 RPC。一刀切删会打断设置页。

---

## 当前无未决问题

三条已全部拍完，本 plan 的阻塞解除；剩下的是施工顺序问题，见 [roadmap](./roadmap.md)。
新问题出现时追加到本文件。
