# 批次 I 证据：2026-09-19 用户现场反馈（十项）

Role: evidence。记录批次 I（roadmap T091～T102）从反馈到落地的事实，不滚动更新为当前交接。

## 来源

用户 2026-09-19 在 Windows 测试机与开发机上使用 1.0.0-test.14 时的十条口头反馈（对话中陆续提出）。每条先派只读调查，根因查清后再立项；需要拍板的登记为 Q029～Q032，当日全部结案为决策 028 / 029 / 030 与 T099 注记。

| # | 反馈 | 根因（一句话） | 任务 |
|---|---|---|---|
| 1 | 处理中点新建，仍是对话 1 | 发送后 1～3.5 秒握手窗口内防重逻辑把正在发送的会话当空白会话复用；过了窗口则组件级 `sending` 不分会话让新会话继承 Stop | T091 |
| 2 | 新建后侧栏不出现 | 不是渲染延迟：要么没创建（同上），要么搜索框关键字把 `New chat` 过滤掉；另有临时对话首发前无 `unbound` 标记被三处派生过滤 | T091 |
| 3 | 结束对话后历史不见 | `endSessionRuntime` 删 `messages[id]` 当 resume 触发器；重启后看历史必须起 worker | T092 / T102 |
| 4 | 长思考块收起要拖回顶部 | 无吸顶；历史 F10 红线 | T096（决策 028） |
| 5 | grok 渠道一条消息七八分钟 | 退避只 43 秒，主因是无任何自设超时（SDK 默认 600 秒）| T093（决策 029） |
| 6 | 状态行贴气泡、字小 | 上下都是 10px、13px | T097 |
| 7 | 文件树删除后不刷新 | 四个 CRUD 只 invalidate 无订阅者的键；watcher 起停竞态；顺带发现重命名传裸文件名 | T094 / T095 |
| 8 | 思考中无法折叠 | 流式行是纯 `<div>` 无控件（当年刻意去掉） | T098 |
| 9 | Windows 迁移面板冻结 | T089 的 A 轮开关覆盖三处入口未记录；预勾选不看开关 | T099 |
| 10 | 工具调用执行中不显示 | 投影层 `deltas()` 只抽 text / thinking，`toolCall` block 无人看 | T101 |

## 真机复现（#1 / #2）

`artifacts/t091-repro/`：Electron dev + CDP + 本地假网关（`long-turn` plan），真实 provider 零调用，`src/` 零改动。关键文件：

- `shots/A3-new-empty-chat-still-shows-stop.png` — 新会话建出来了仍显示 Stop、无发送按钮
- `data/a8-stop-01-result.json` / `a8-stop-02-stopcalls.json` — 在新会话点 Stop，`stopActiveSession` 读到的是新会话 id，发送方继续 running
- `data/b1-01-sametick.json` — 活动会话为占位标题时点新建，`sessions` 191→191
- `data/b2-results.json` + `shots/b2-new-with-search-query.png` — 搜索框有关键字时新行被过滤，清空后出现
- `data/b3-results.json` — 从已有消息的会话点新建，~300ms 内新行同时出现在「最近」与文件夹，rail 切换前后行数一致

握手窗口实测 1～3.5 秒（取决于 worker 冷启动）。复现代理在 dev profile 留下约 19 个测试会话（`New chat` / `T091 …`），未发送的重启即消失，发送过的需手动归档。

## 方案演示（#4）

`artifacts/q031-collapse-demo.html`：A 吸顶折叠头 / B 底部收起 / C 两者，用户看后选 A 并要求不透明、不穿插（决策 028）。

## 落地验证（Linux 开发机，2026-09-19）

- 三套 tsc（根 / `src/runtime` / `src/agent-host`）退出 0。
- 金样本 5 份重录（`AICLIENT_UPDATE_FIXTURES=1`）：每个工具调用净增一条带摘要输入的 `tool.started`、原事件变 `tool.updated`；重试样本多 `retryAt` / `attemptStartedAt`。
- 全量 Vitest 单 worker：**463 文件 / 7059 条全部通过，313 s**（对比 T090 收口的 450 / 6909）。
- 锁文件：`pnpm install --frozen-lockfile --offline` 通过（只保留新增 `@earendil-works/pi-agent-core`）。
- **真机 GUI 点验**（同日，[artifacts/pointcheck/report.md](artifacts/pointcheck/report.md)，假网关新增 `slow-write` / `long-thinking` / `slow-fail` 三个 plan）：8 项里 7 项 ✅——T091 握手窗口内新建成功且新会话零 Stop、T101 工具行在首个参数片后 ≤250ms 出现并「已收到 N 行」递增、T098/T096 流式可折叠且钉住态背景不透明无穿插、收起精确回原位、T093 逐秒倒计时 + 立即放弃 + 30 秒空闲超时三次尝试各在 30.0 秒被切、T102 看历史 worker 集合不变、T092 结束后 7 条消息一条没少、T097/T099 数值与面板状态与计划一致；T094 新建 282ms 出现 ✅ 而**删除未取证**（原生 `window.confirm` 挡住 CDP，登记 T103）。

## 未处理 / 顺带发现

- T100：Git 面板提交历史与分支列表不自动刷新；左栏三套失效体系互不相通。
- 预览过（T102）或结束过（T092）的会话点「分支」会因无 worker 失败——T092 之后即存在，未立项。
- 侧栏行的归档按钮 `aria-label` 仍是硬编码英文（与 ✕ 同类）。
- `scripts/run-f3-dev-probe.mjs` 与 `src/runtime/__tests__/eventsPlugin.test.ts` 各有一条早于本批的 Biome 报错（提交 `341bcbb8`），预提交钩子只查暂存文件所以未拦住。
- 锁文件：`pnpm install` 顺带把 `@smithy/node-http-handler`（4.7.3→4.11.3）与 `@google/genai` 的 `ws`（8.19.0→8.21.3）两处解析刷新，node_modules 里 `ws` 仍是 8.19.0。
