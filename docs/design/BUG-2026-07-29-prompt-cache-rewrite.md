# BUG 2026-07-29 — 对话每条消息全量重写提示词缓存（cache read 恒为 0）

> 状态:**双根因确认**。主因在网关侧(app 无可修,已升级 open-questions #15);
> 次因(Host resume 丢 model/effort)已修 `3622c19`。
> 探针脚本已入库:`src/agent-host/spikes/cache-affinity-probe.mjs` + `spikes/capture-proxy.mjs`。

## 一、现象

用户 GUI 实测(2026-07-29,newapi 面板,ccmax 分组):同一会话连发两条消息,

| | 输入 | 输出 | 缓存写入(1h) | 缓存读取 |
|---|---|---|---|---|
| 第 1 条 | 2 | 13 | 42,435 | 0 |
| 第 2 条 | 2 | 110 | **42,466** | **0** |

按官方规则(前缀字节级匹配,`tools → system → messages` 顺序渲染,断点处查前缀哈希),
第 2 条应读取 42,435 + 只写 ~31 增量。实际全量重写,每条多花 ≈¥0.25(¥6/M × 42k),
且随上下文变长线性恶化。注意 +31 的增量本身说明 **app 发出的前缀是稳定的**——这是排查起点。

## 二、对照实验:网关缓存能力(绕开 app,直连网关)

`cache-affinity-probe.mjs`:固定 ~8.6k token system(带 `cache_control {ephemeral, ttl:1h}`),
对 `claude-sonnet-4-6` 连发。三轮共 10 次请求汇总:

| 请求形态 | 命中 | 未命中 |
|---|---|---|
| 字节级相同的请求重发 | **4** | 0 |
| 前缀增长(多轮形态,前缀字节一致、尾部追加) | **2** | **2** |

**同样的客户端字节,命中与否不确定** ——直连官方 API 不可能出现(缓存组织级、确定性)。
唯一自洽解释:分组后面有多个上游账号,请求随机/轮询分发;落到写过缓存的账号就命中,
落到别的账号(缓存按账号隔离)就全量重写。第三轮恰好连续落同一通道,于是 grown 也命中了 2 次。

这是 new-api 生态已知问题:渠道亲和只到渠道级,渠道内多 Key 仍轮询,上游缓存按 Key 隔离
(new-api issue #5992「API Key 级会话亲和」)。**旁证**:T-04 的 thinking 空文本时有时无、
同模型某日确定性 400(open-q #5/#8),与「多上游异构通道」是同一根因家族。

## 三、拦截取证:app 实际发出的请求(capture-proxy + 真 SDK 链路)

代理挂在 `AICLIENT_TEST_BASE_URL` / `ANTHROPIC_BASE_URL`,cli.js 的 HTTPS 全量落盘,
两轮请求体做字节 diff。

**① 显式传模型(= GUI 实际形态,create 时传 `sonnet`)**:T1 写 38,592、T2(resume)写 38,618 读 0,
面板形态精确复现。diff 结果:`tools` 逐字节相同、`system` 相同、`messages[0]` 相同、
`anthropic-beta` 头相同——**客户端前缀完全可缓存,读 0 纯属网关路由**。
(尾部的 trailing system message 每轮形态有别,但它在最后一个断点附近,影响可忽略。)

**② 不传模型(= Host 重启后 resume 的旧行为)**:fresh 轮 beta 头带 `context-1m-2025-08-07`,
Bash 工具描述落款 `Co-Authored-By: Claude Opus 4.8 (1M context)`;resume 轮 **1m beta 消失**,
落款变 `Claude Opus 4.8`。tools 在缓存前缀最前面,这一处字节差 = **整条缓存必然全量重写**
(与网关无关,100% 复现)。

## 四、双根因与处置

| # | 根因 | 处置 |
|---|---|---|
| 主 | 网关 ccmax 分组多上游、无会话/Key 亲和,缓存命中随路由随机 | **app 无可修**。找网关运营方开渠道亲和 + 渠道内 Key 亲和,或给令牌绑定单上游;开 open-questions **#15** 跟踪 |
| 次 | Host `session.resume` 处理器丢 `model`/`effort`(`src/agent-host/index.ts` resume 分支),Host 重启后续聊回落 cli 默认模型——用户选的 sonnet 被**静默换成 opus 系默认**,且触发 ③ 的 1m/tools 翻转 | 已修 `3622c19`:Renderer→IPC→preload→协议→Host 逐层补可选字段(纯加法不 bump 协议版本,沿 T-20 先例);`claudeRuntimeOptions.test.ts` +3 例钉死 resume→query() 下发 |

**遗留(记录不修)**:cli.js(cometix 2.1.212)对「无显式模型」的会话 fresh/resume 两态 1m beta
不一致,属上游 CLI 行为;GUI 恒显式传模型后不触发。真实仓库工作区下 system prompt 若含
git status 类动态段,提交/改文件后同样会击穿缓存——待网关亲和修复后再实测评估(SDK 有
`systemPrompt: {preset, excludeDynamicSections}` 可作对策,目前未设 systemPrompt,不适用)。

## 五、方法论备忘

- **先做对照实验再拦截**:「字节级相同重发 vs 前缀增长」两组对照,一次就把网关/客户端二分了;
  拦截 diff 只用来收尾定位客户端字节。
- 拦截层必须挂在 **cli.js 那一跳**(每 turn 由 Agent SDK 重新 spawn),挂 agent-host 抓不到。
  最短路径:`AICLIENT_TEST_BASE_URL=http://127.0.0.1:8791` + spikes 冒烟,无需起 GUI。
- 面板上的「写入增量」(42,435→42,466,+31)本身就是前缀稳定性的免费证据,先读它再动手。
- usage 判读口径:总前缀 = `input + cache_creation + cache_read`;`input=2` 说明断点后只有
  极少散量,一切正常,异常只在 write/read 的分布。
