# F11 RCA：重发后带图片的历史用户消息在时间线重复

- 日期：2026-08-18
- 来源：D48+T-10 点验批第 11 号发现（用户实况报告 ×2）
- 状态：**根因已定案**（探针级复现）；修法设计已派 deep-reasoner，另见修法规格
- 证据基座：RCA 工作流 wf_aab41890-0ce（66 次工具调用，transcript
  `subagents/workflows/wf_aab41890-0ce/agent-a8d6d24cbe96a8f4c.jsonl`）+ 编排者读源核对

## 1. 症状（用户原述两段合并）

1. 45s 超时报错回显输入 → 重发 → 重发消息**上方**出现多条之前带图片附件的历史消息（重复）。
2. 补充：结构固定为「历史输入 n-1 → agent 回复 → 历史输入 a（图）→ 历史输入 b（图）→ 我的输入 n」，
   且**始终**出现在最新消息之前（每次 resume 后都在）。

## 2. 复现证据（探针，非推测）

RCA 代理用 esbuild 把 `src/renderer/stores/historyReplayMerge.ts` 打包为独立探针（/tmp/mergeprobe），
直接驱动 `mergeReplayedHistory`：

- **replay#1**（历史 JSONL 尚未刷入本会话实发消息的副本）：实发回声 `user-s-1003/1005` 无匹配行 → 保留，
  与历史行交错渲染，暂时无重复。
- **replay#2**（完整历史已含 `h:u2/h:u3` = 那两条实发消息的历史副本；快照锚点已推进到 `h:a3`）：
  合并结果 `['h:u1','h:a1','h:u2','h:a2','h:u3','h:a3','h:u4','h:a4','user-s-1003','user-s-1005']`，
  渲染的用户文本出现 `'B look at this','C and this'` **各两次**——历史副本在上、未折叠回声垫底。
- **replay#3**：结构不再自愈，重复恒在——与用户「始终出现」一致。
- 图片附件独立探针：image-only 消息 `coverageText` 为空 → 直接免折 → `['h:x1','h:x2','user-s-3001']` 恒重复。

## 3. 根因链（两个合取的结构洞 + 一个高频触发器)

责任全部在**渲染端合并层** `src/renderer/stores/historyReplayMerge.ts`；
Host 侧 `historyReader` / `eventNormalizer` 只是如实回放，不产生重复。

### 洞 A：锚点盲区（对所有消息类型成立，`:211-218` + `:242` 前向游标）

游标从「快照时最后一条 `h:*`」之后起步（guard 3，防 v1 的早排误吃）。但一条实发回声的历史副本
若落在**下一次 resume 锚点之前**（典型时序：发送→JSONL 未刷完→第一次 replay 折叠失败→锚点随后推进），
前向游标永远够不到它 → 永远 `kept` → 永久重复。`:264` 的 `[...mergedHistory, ...kept]`
把这些回声集中垫在整段历史之后——这就是用户看到的「固定出现在最新输入正上方」的结构成因
（最新输入 n 也是 runtime，按 bucket 序排在 kept 尾部；n 的文本下次能折叠，a/b 永远不能）。

### 洞 B：图片消息的文本身份失配（解释「为什么偏偏是带图的」）

- **image-only / 空文本**：`coverageText` 为空 → `:237-239` 直接免折，无条件 kept，永久重复；
- **图 + 文**：`isReplacementFoldable`（`:171-179`）要求 `role + coverageText` 精确匹配才做替换折叠。
  第一次 replay 因 JSONL 未刷/文本漂移失配一次，锚点推进后落入洞 A，同样永久化。
  纯文本消息在后续 replay 中若仍在锚点之后尚有自愈机会，带图消息的容错半径明显更小。
- 用户实况会话（`94a3769d-*.jsonl`）验证含 `['text','image']` 用户行，与本判定相容。

### 触发器（非根因）：45s 误报路径

45s 挂钟预算 → `unbindHost()` → 重发走 resume 握手 → 触发本合并。F2 批删除 unbind-on-timeout
只是**降频**：应用重启、侧栏重开会话、闲置 revive 等一切 resume 路径仍然踩洞 A/B。F11 必须独立修。

### 叠加项：F8 分支盲（放大器，非本因）

真机扫描：88 个 CLI 转录中 33 个含兄弟分支（183 组）。`historyReader` 平铺回放会把废弃分支行
一并送进合并层，扩大失配面。归 F8 票，不在本票修。

## 4. 修法方向（待 deep-reasoner 出规格后定稿）

候选两层，可能合取（参照双轨分歧裁定纪律——互补反例应合取）：

- **a. 合并层启发式补强**（小修）：附件感知身份（role + 文本 + 附件数/名，空文本但有附件时以附件身份参与匹配）
  ＋ 锚点盲区的候选集内回溯匹配（watermark 已把候选限定为 resume 前消息，回溯不违反 v1 反例的时间边界，
  但须论证不破坏 guard 2/3 的合取语义与 replacement fold 的位置正确性）。
- **b. 身份改道 uuid**（正解候选）：SDK `SDKUserMessageReplay` 携带 `uuid`；Host normalizer 把实发用户消息的
  canonical uuid 透传给渲染端，回声据此改用 `h:<uuid>` 同源身份，折叠从「文本启发式」变「精确 id 等值」。
  涉及 Host 协议面，改动大，可能并入 F2/F8 邻域批。

测试合同底线（修法规格须细化）：正控①图+文消息二次 replay 后单例；正控②image-only 消息 resume 后单例;
正控③锚点前副本（探针 replay#2 场景）可折叠；负控①resume 后新发的同文本消息不被误吃（v1 反例保持）；
负控②replacement fold 后附件 chips 保留。夹具形态：带 `['text','image']` 块的用户行 + 两段式 replay。

## 5. 定案一句话

`historyReplayMerge` 的折叠身份是「role+文本」启发式且游标被锚点单向锁死：带图消息（空文本免折/文本失配）
第一次折叠失败后，其历史副本落入锚点盲区永久无法折叠，未折叠回声被 `[...history, ...kept]`
固定垫在历史块尾——即用户所见「带图历史消息恒在最新输入上方重复」。

## 6. 勘误（2026-08-18 修法规格定稿时回填）

§4 候选 a 中「watermark 已把候选限定为 resume 前消息，回溯不违反 v1 反例的时间边界」一句**不成立**：
P1 反例的受害者（刚重发的同文本消息）本就在 watermark 候选集内（既有钉子
`historyReplayMerge.test.ts:85` 的快照形状可证），guard 1 对 P1 零防御，唯一防线是游标下界。
修法规格据此**不采用回溯**，改用「锚点降格 + 逐行新鲜度准入」（匹配下标仍严格递增，仅起点下放，
且只有 `id ∉ candidateIds` 的历史行有资格吸收回声）。另：洞 A 的第一生产者是 **replacement fold
自伤**（折叠成功即把 `h:*` id 从 bucket 移除，下轮锚点必然跨过它），本档 §3 未写。
以 `2026-08-18-f11-merge-fix-spec.md` 为准。
