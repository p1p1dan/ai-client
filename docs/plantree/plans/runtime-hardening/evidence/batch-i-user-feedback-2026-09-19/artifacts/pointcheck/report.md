# 批次 I 真机 GUI 点验报告（2026-09-19，Linux 开发机）

环境：dev 模式 + CDP 9222，模型全程走本地假网关（`probe-fake/fake-sonnet`，新增 `slow-write` / `long-thinking` / `slow-fail` 三个按真实时钟逐帧发送的 plan），权限档 fullopen，真实 provider 零调用，`src/` 零改动。探针 `pc-*.mjs`、数据 `data/`、截图 `shots/` 在本目录。

## 判定总表

| 项 | 判定 | 关键数值 / 证据 |
|---|---|---|
| T091 新建对话 | ✅ | 发送后 404ms 点新建：`sessions` 203→204、active 切到新会话；新会话所有采样 Stop 按钮 = 0；S1 running 时 S2 走「发送消息」，两会话同时 running；搜索框不匹配关键字下活动会话仍在侧栏、新建后新行出现（`data/01-*`，`shots/01-*`） |
| T101 工具行流式期出现 | ✅ | 首个 `input_json_delta` 后 ≤250ms 出现「编辑中」，随后「demo/out.html · 已收到 5 行」→ 60 行单调递增，结算「已编辑」；store 里只有 `path` + `__streaming{bytes,lines}`，无正文（`data/03-*`）。保留意见：新建文件无旧内容，展开是工具结果文本不是 diff，改写已有文件的 diff 预览未验 |
| T098 + T096 思考折叠与吸顶 | ✅ | 流式期「思考中」是 `<button>` 带 chevron，折叠 / 展开正常；未点过的结算后自动收起，点开过的跨结算保留；钉住态 `position: sticky; top: 0; z-index: 10; height: 22px`，背景 `oklch(...)` 无 alpha，`triggerTop == viewportTop`，放大截图无正文穿插（`shots/04b-b-sticky-band.png`）；收起后 `scrollTop 8536 → 4194` 精确回原位 |
| T093 倒计时 / 放弃 / 超时 | ✅ | 横幅逐秒递减，3/10/30 秒梯子；「立即放弃」按下 2.5 秒内 idle、假网关计数其后 50 秒不变；设置 → Pi →「模型请求超时」改 30 秒、重启后 `slow-fail` 三次尝试各在 30.0 秒被切（`provider retry n/3 in … after 3000xms (status=none code=TIMEOUT)`）。派工预期 `code=NETWORK_ERROR`，实际 `TIMEOUT` 更准确 |
| T102 无 worker 看历史 | ✅ | 重启后点旧会话：14 次采样 `msgs=2`、`hostBound=false`、worker pid 集合始终 `[]`；发送后 2.5 秒 `hostBound=true`、`workers=[930541]` |
| T092 结束对话保留历史 | ✅ | 弹窗文案为新版；确认后 `disconnected`、`hostBound=false`、`msgs=7` 一条没少；再发一条 2.5 秒内自动 resume |
| T094 文件树 | 部分 | 新建 282ms 出现 ✅；**删除未做**：`FilesSurfaceView.tsx:96` 用 `window.confirm()`（同步阻塞原生框、文案硬编码英文），CDP 无法点掉，三次复现渲染进程停在 futex 等待。非本批引入（最后改动 `deba6cd7`），登记 T103 |
| T097 / T099 观感 | ✅ | `group/turn gap-3`（12px）、状态行 `gap-2`（8px）、14px；迁移面板三项 `aria-checked=false` + `aria-disabled=true`，有「测试期间暂未开放。」（`shots/08-*`） |

## 观察（非缺陷）

- D-2：新建后 1～2.7 秒圆形按钮短暂显示「加入队列」（disabled），store 从始至终正确，疑为 2 核机起 worker 时的一帧陈旧绘制，未见 Stop。
- D-3：工作组头「Worked for 13s · ↑ 36 tokens」是刻意英文（`MessageTimeline.tsx` 的 `englishTranslate` + `[HEAD-EN-1]` 护栏），思考折叠头是中文，两处不一致但都在设计内。
- D-4：探针用 `innerText === '立即放弃'` 全程 false 而 `textContent` 能匹配，读数不可靠，产品侧无结论。

## 环境注记

- `--open-path` 不是稳定的工作区开关；左栏「文件」面板始终以仓库为根。
- 左栏 rail 记住上次面板，停在「文件」时读会话列表会得到 1 个会话 / 0 行，先切回「聊天」。

## 收尾

vault `--restore` 逐字节还原；`providerIdleTimeoutMs` 改回 120000；`chatAgentDefaults` / `default-tier` 还原；应用与假网关关闭，9222 / 5173 / 18099 无监听；`git diff -- src/` sha256 与开工前相同。本轮新建 10 个测试会话（`session-…` 列表见 `data/99-01-sessions.json`），发送过的需手动归档。
