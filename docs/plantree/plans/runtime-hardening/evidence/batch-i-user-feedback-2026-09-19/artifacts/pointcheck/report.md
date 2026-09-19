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

---

# 追记（T103 / T094 删除 / T100），2026-09-19 23:38–23:51

在 `ffd0b841`（删除确认框改自绘）与 `fb120545`（Git 面板外部刷新）两个修复之上复验三项。本轮**不发任何模型请求**，因此没起假网关，也没有改动任何设置项——没有需要还原的状态。探针 `pc-10` ～ `pc-16`，数据 `data/1*.json`，截图 `shots/1[2-6]-*.png`。

## 判定

| 项 | 判定 | 关键数值 |
|---|---|---|
| T103 删除确认框（自绘、中文、不阻塞） | ✅ | `role="alertdialog"` / `data-slot="alert-dialog-popup"`；标题「删除文件？」，正文「将从磁盘删除「beta.txt」，此操作不可撤销。」，按钮「取消」「删除」；弹框开着时 `Runtime.evaluate` 往返 1～2ms（旧版 `window.confirm` 时是 12 秒超时无应答） |
| T094 删除后文件树自动重绘 | ✅ | 点「删除」后**没点刷新**，首个 250ms 采样 `beta.txt` 已从树上消失（从合成鼠标序列开始计 771ms，其中约 400ms 是鼠标事件本身的节奏）；磁盘只剩 `gamma.txt` |
| T100 外部 git 操作自动刷新 | ✅ | `git branch` 后**不开下拉**，分支缓存 7.13s 内出现新分支，提交行徽标在另两轮分别 0.5s / 1.5s 出现；`git branch -D` 后 6.07s 消失（徽标 5.03s）；head-signature 轮询实测 12 秒 3 次（约 5 秒一拍） |
| 窗口重聚焦触发一次刷新 | ✅ | 失焦期间外部建分支，应用看不见（4 秒无任何查询事件）；派发 `focus` 后 **71ms** 内 log-infinite / branches / head-signature 三条查询同时进入 `fetching`，**353ms** 后提交行徽标出现 |

## T103 + T094：删除（`pc-12-t103-delete.mjs`，`data/12-00-result.json`）

样本 `tree-demo/alpha/{beta.txt,gamma.txt}` 用 node 预写在本目录下。文件右键菜单为「重命名 / 复制 / 剪切 / 复制路径 / 复制相对路径 / 在资源管理器中显示 / 删除」。三趟：

1. **文件 → 取消**：弹框如上表；开着弹框连打三次 `1+1` 各 1ms 返回，渲染进程全程有应答。点「取消」后弹框消失，`beta.txt` 仍在树上、仍在磁盘（`shots/12-b-confirm-file.png`、`12-c-after-cancel.png`）。
2. **文件 → 删除**：树上 250ms 内消失，磁盘同步删除，全程没碰刷新按钮（`shots/12-d-after-delete.png`）。
3. **目录 → 取消**：标题变成「删除文件夹？」，正文点名「alpha」，取消后目录仍在（`shots/12-e-confirm-folder.png`）。

## T100：外部 git 操作（`pc-13` / `pc-13b` / `pc-16`，`data/13-00-result.json` 等）

只用**不碰工作区、不碰 HEAD** 的引用操作：`git branch` → `git update-ref … HEAD~1` → `git branch -D`。不做 `git commit --allow-empty`。

测量口径说明：分支下拉自己带 `onOpen` 重取，所以**下拉里看到新分支不能当证据**。本轮的判据是两处「没人点」的地方——React Query 缓存（经 React fiber 拿到 `QueryClientProvider` 的 client，`renderer/index.tsx` 里的实例既没导出也没挂 window）与提交行上的 ref 徽标。

- `git branch t100-probe-branch`：`git|branches|<repo>` 缓存 7.13s 内含新分支；`log-infinite` `dataUpdateCount` 1→2，首条提交仍是 `fb120545`；提交行长出 `t100-probe-branch` 徽标（`shots/13-e-badge-after-create.png`）。随后开下拉确认可见（`shots/16-a-dropdown-with-probe-branch.png`）。
- `git update-ref refs/heads/t100-probe-branch HEAD~1`：3.15s 内 `log-infinite` 重取（`dataUpdateCount` 2→3），**内容不变**——首条仍 `fb120545`、总数仍 30，只是徽标从第一条挪走。这条正是「引用变化 → 失效 → 历史重取」整条链的直证。
- `git branch -D`：分支缓存 6.07s 内移除，徽标 5.03s 消失，下拉里也没有了（`shots/13-f-badge-after-delete.png`、`16-b-dropdown-after-delete.png`）。
- head-signature 轮询在跑：窗口活跃时 12 秒抓到 3 次成功取数（约 5 秒一拍），失焦后 10 秒 0 次。

收尾：`t100-probe-branch` 已删（三个脚本各自的 finally 都兜了一次），`git branch` 只剩原来 5 条，HEAD 仍是 `fb120545`。

## 窗口重聚焦（`pc-15-focus-edge.mjs`，`data/15-00-result.json`）

先用真实 `mouseMoved` 唤醒窗口并确认轮询在跑（12s / 3 次），再派发 `blur` 确认轮询停（10s / 0 次，证明 blur 确实进了 `useWindowFocus`），**在失焦期间**从命令行建分支（应用此时是瞎的：4 秒内零查询事件、徽标仍无），最后派发 `focus`：三条查询 71ms 内同时开始取数，353ms 后徽标出现在界面上。`blur` / `focus` 用合成事件派发，因为 `useWindowFocus.ts` 监听的就是 `window` 上的这两个事件；本项不测「操作系统是否真的换了焦点」。

## 观察（非缺陷，但值得登记）

- **E-1 文件树会压缩单子目录链**：`tree-demo` 与 `alpha` 合成一行「tree-demo/alpha」（深度 8，文件落在 9），右键菜单里多出的「tree-demo」「alpha」两项是「重命名」的分段子菜单。按 `alpha` 单独找行会一无所获，读起来像「展不开」——首轮探针就是这么翻的车。
- **E-2 压缩行上的删除只删最深一段**：在「tree-demo/alpha」上点删除，确认框正文写的是「alpha」（文案诚实），但行上显示的是两段路径，用户可能以为连 `tree-demo` 一起删。属 T103 之外的既有行为，未改。
- **E-3 空闲 90 秒后轮询整体停摆**：`useShouldPoll` 把 90 秒无输入判为 idle，此后 head-signature 不再轮询，外部 git 改动要等用户下一次动鼠标或窗口重新聚焦才追上。这是 `useWindowFocus.ts` 的既有设计，T100 的聚焦沿正好补上「切走再切回」这一路；但「面板开着、人盯着屏幕不动」这一路确实会滞后。本轮 `pc-14` 那次「聚焦后历史没刷新」的假阴性就是撞上它加上采样口径不对（见 E-4）。
- **E-4 缓存里有两条 `branches`**：`git|branches|/home/ai/code/ai-client` 与 `git|branches|/tmp/pc-i/ws`（启动时 `--open-path` 给的那个目录）。键没串，是两个不同工作目录，后者从头到尾不更新。按 scope 聚合读缓存会读到后者并得出错误结论。
- **E-5 探针自杀**：在 `node -e "…"` 里调 `lib.mjs` 的 `stopApp()`，因为 `pidsMatching('scripts/dev.js')` 会匹配到 `node -e` 自己的命令行（脚本正文里含这个字符串），探针把自己 SIGTERM 了。应用确实关掉了，但退出码是信号码。以后写成独立 `.mjs` 文件调用。

## 收尾

`tree-demo/` 已删除；应用按 pid 精确关闭（`/proc/*/cmdline` 遍历，未用 `pkill -f`），9222 / 5173 / 18099 均无监听，无 electron / vite / worker 残留；`git status` 的已跟踪改动仍是开工前那三份文档，未跟踪项为 `contextFX/`、`sharePic/*` 与本轮新增的点验产物；`src/` 零改动。
