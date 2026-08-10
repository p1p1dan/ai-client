# Open Questions

> 只放未决问题；决了就移去台账（决策/检查点）并从这里删除。
> 2026-08-08 归档：已关闭条目（#2 被 T-19 落地取代 / #10 主体升 D25 / #11 随 T-21 关闭 / #16 拍板 D21~D23 /
> #17 被 T-34 as-built + C-17 归口取代 / #18 拍板 A→T-19 / #25 三拍板落定 / #28 D27 裁定）
> 结项推导原文见 [history 快照](./history/2026-0808-roadmap-openq-registry-archive.md)。

3. **CI 测试作业缺失**：`build.yml` 仅打包无 `pnpm test/typecheck/lint`（C-09 期间发现）。tag 触发的发布构建要不要加测试门禁？——成本（双平台时长）vs 收益待拍板。
4. **T-09 Node 缺失场景无法真触发**：resolver 容错太好，坏路径仍 fallback 成功。构造「全候选失败」的可行法？（候选想法：mock-resolver 注入容器，见 ideas）
5. **网关「400 thinking 格式无效」——默认模型路径确定性 400**（2026-07-28 升级）：budgetTokens 假说已被实测推翻；`{type:'adaptive', display:'summarized'}` 打网关默认模型 2/2 确定性 400——网关对 thinking 的处理跨模型不一致且随时间漂移。处理口径不变（按 session.failed 显示、不回滚 thinking 默认开），**定位与修复在网关侧**，app 侧无可修。
6. **归档会话无 un-archive 入口**：右键即归档、无确认，`mergeSessionIndex` 把 archived 连 live 镜像一起丢弃 → 彻底不可见，只能手改索引文件恢复。要不要补 UI 入口（或至少加确认）？——等用户拍板。
7. **TSD 白名单口径**（按进程名，任意路径 node.exe 均可读）待 T-11⑥ 现场实证——实证前所有加密机相关能力不得标注通过。
8. **sonnet 空文本 thinking 块要不要渲染「已思考」指示**：GUI 默认 sonnet 在本网关返回带签名但文本为空的 thinking 块，Host 按设计吞空 → 无卡。要不要渲染无文本指示？——产品决策等用户拍板；根治在网关侧。**T-04 在网关修复前无法点验**（连同 #5）。
10. **T-21 验收截图未出**（本条主体已升 D25 结项，唯一遗留 = 截图验收）：默认主题下中英混排三场景（Chat 正文 / 侧栏树中文标题 / 工具行摘要）+ 6 处 `normal-case` 豁免目视（两处渲染动态标识符的关键位：`MergeEditor.tsx:751` 冲突文件 Tab、`AddRepositoryDialog.tsx:1087` SSH 路径 chip；余四处为 onboarding 中文按钮）。截图入台账后本条删除、T-21 转 Done。6 处清单全文见 history 快照。
12. **终端 Ghostty 主题与 Monaco 跟随是否随 D18 一并 Flexoki 化**：`sync-terminal` 模式下 `applyTerminalThemeToApp()` 把 25 个语义变量以 inline hex 写到 documentElement → Flexoki 调色板被 100% 覆盖；且不覆盖 T-21 新增 5 token → 该模式下呈「25 终端色 + 5 Flexoki 色」混色。三种口径待选：① 全保留两套并存；② Monaco 改跟 Flexoki；③ 全部 Flexoki 化。**裁定前 `ghosttyTheme.ts` / `monacoTheme.ts` 原样不动**；T-21 验收必须在默认（非 sync-terminal）主题下进行，混色属本条未决非 bug。
13. **`dark:` 变体与 `.dark` 调色板整体脱钩**（既存 bug、非 T-21 引入，影响全仓）：`globals.css` 未声明 `@custom-variant dark`，Tailwind v4 的 `dark:` 默认走 `prefers-color-scheme`，而应用切换靠 `.dark` class——用户显式选 Light/Dark 时二者互不相干（`theme:'system'` 恰好同步故长期被掩盖）。修法一行 `@custom-variant dark (&:where(.dark, .dark *));` 但会一次性改变全仓 `dark:` 生效条件，需逐屏复验——**属独立任务**；裁定前新代码不得依赖 `dark:` 表达关键可读性差异。
14. **`dev.env` 凭证隔离只覆盖 `scripts/dev.js` 一条启动路径**：打包版 / `pnpm preview` / 裸 `electron-vite dev` / spikes 均仍回落本机 `~/.claude` 登录。下沉 Host 侧强制还是维持「主路径 + 约定」？——等用户拍板。连带缺口：dev.js 的 parseEnvFile/剥离/拒启逻辑零自动化断言。
15. **提示词缓存命中不稳定：网关责任待复测裁定**：用户实测同网关接 CLI 缓存正常，与探针数据（ccmax 分组多上游轮询、按账号隔离，前缀增长 2/4 命中）可同时为真——命中行为可能按模型/通道而异。**裁定步骤**：① `3622c19` 修复后 GUI 复测（第二条消息看缓存读取）；② 仍为 0 则 `spikes/cache-affinity-probe.mjs` 同模型对照。裁定前暂缓联系运营方。证据全文：[`BUG-2026-07-29-prompt-cache-rewrite.md`](../../../design/BUG-2026-07-29-prompt-cache-rewrite.md)。
19. **model/effort 对 hostBound 会话的 direct 发送不生效**（既存）：`sendPreamble` hostBound 走 `'direct'` 不经 createSession，改值仅重启/新会话生效。待裁定：`session.send` 补 model/effort 下发（协议可选加法）或明确「模型仅会话级」口径并在 UI 表达。
20. **stopping 态下手动直发路径未覆盖**（T-19 复核 M6 附带）：`isStoppable` 覆盖四态不含 `stopping`——理论缺口仅在手动直发路径（自动放行 `decideQueueRelease` 独立判定天然安全）。等复现或用户反馈再评估。
21. **T-19b 消息队列后续设计事项**：失败载荷归队需重设计（退避 + 可见出口，非临时规避）· 后台会话自动放行需先抽 `runTurn` · 插队增强 · 持久化口径（只存文本 vs 文本+附件）。暂不阻塞，留待排期。
22. **网络环境复测需用户配合**：排队消息消失/新会话无回复根因已坐实为网络瞬断触发 CLI `api_retry` 静默重试环（app 侧已补可见性）。待用户：① 确认 VPN/代理与瞬断源；② 网关 curl 采样；③ 持续复测偶发频率。
23. **授权 FIX 3（`PendingPermissionDock` UX 打磨）留档未做**：根因已随 `b159e4a` 根治，打磨项范围待后续设计另立。
24. **会话标题来源元数据缺失**：`isPlaceholderTitle` 凭显示字符串判定，无 `titleSource` 持久化；Main 侧 `renameSession` 无条件更新有毫秒窗。方向：`titleSource` + CAS 条件更新，涉主进程与索引 schema。
26. **Host 受理边界 clientTurnId 幂等**（纵深防御第二道）：重试双发已由渲染层 `sawUserEcho` 单一权威根治（`cb2d8d7`）；Codex 主张的 Host 侧去重未采纳（涉协议）。连带 A5（retry-resume 重放）留待现场取证后一并评估。
27. **组件级事故测试基建缺口**：vitest node-only 无 `.tsx` 渲染能力，重试双发类事故只能 inspection-verified 注释入码。方向：jsdom+RTL 或 e2e 冒烟层——排期与选型待评估。
28. **【已裁定 2026-08-10：A 方案，= D29，落地 `e529a55`】工作区归属权威：会话绑定 vs 侧栏选中**（原问题留档如下；裁定全文见总台账 D29 行）：
    背景：右侧 git 面板 / 文件树 / 会话 cwd 三者全跟**当前激活会话的 workspaceId**（T-26/T-27 落地口径，Composer 目标栏是唯一改绑入口）；侧栏点仓库只改 focusedProjectId（决定下一次 New 建到哪），不改当前会话。现场用户心智是「左边栏选中哪个仓库，面板就该跟哪个」。业界两种都有先例：VS Code 窗口=固定工作区；多 root IDE 跟随焦点上下文。
    现状澄清：2026-08-10 批已修掉判据误报（temp 会话也能正确显示 git），此问题不再被误报掩盖，纯剩口径之争；满屏 temp chip 是「新会话继承活动会话工作区」+「用户未先点仓库文件夹」的组合结果，不是绑定 bug（sessionIndexMerge 反向修改已论证否决）。
    候选：(A) 维持「会话即工作区」，补交互——点侧栏仓库自动切到该仓库最近会话（或新建），让点击有可见后果；(B) 改「侧栏选中即工作区」——推翻 T-26/T-27 唯一改绑入口裁定，改动面大。**倾向 (A)**：改动小、不推翻既有裁定，先验证交互补齐是否已满足心智。
