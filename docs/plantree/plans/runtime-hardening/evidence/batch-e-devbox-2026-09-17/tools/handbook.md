# T032 开发机点验环境手册

面向 `docs/plantree/plans/runtime-hardening/checklist-e.md` 第 4 节「开发机（上机前就能做完）」那张表（DEV-1～DEV-37）。

- 仓库：`/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，HEAD `b3d751e3`
- 本手册的每条路径 / 命令 / 代码位置，要么是我在这台机器上实跑过的，要么是我读过的源码行号。**推断的地方会明写「未实测」。**
- 编写时做过一次完整的启动 → CDP 控制 → 干净退出，全过程记录在最后一节「注意事项」。
- 机器规格：**2 核 / 3.3 GB 内存 / 3.8 GB swap**。这是后面所有时间数字的前提。

---

## 0. 先读这三条，能省一天

1. **别自己从零写探针。** `scripts/run-t37c-gui-probe.mjs`（53 KB）已经是成品，`scripts/h21-cdp.mjs` 是它抽出来的公共 CDP 驱动库（`Cdp` 类、`startDevApp`、`stopDevApp`、`clickByText`）。`run-perm1-probe.mjs` / `run-f2b-probe.mjs` 都直接 import 它。
2. **这台机器的 shell 里设了 `HTTP_PROXY=http://127.0.0.1:7890`，而只有大写 `NO_PROXY`。** Chromium 只认小写 `no_proxy`。`scripts/dev.js` 内部已经用 `withLoopbackProxyBypass()` 兜住了（`scripts/dev-proxy-bypass.mjs`），所以走 dev.js 起是安全的；但你如果绕开 dev.js 直接起 Electron，必须自己 `export no_proxy=localhost,127.0.0.1,::1`，否则窗口永不出现、CDP 端口能连但不回包。
3. **内存是这台机器上的头号伪故障源。** `free -m` 的 available 低于 ~500 MB 时启动会慢到分钟级，探测超时就会读成「端口在听但永不回包」。起 Electron 前一定先看 `free -m`，且**不要同时跑全量测试**。

---

## 1. 启动配方（实测通过）

### 1.1 命令

```bash
cd /home/ai/code/ai-client
DISPLAY=:0 no_proxy=localhost,127.0.0.1,::1 \
  setsid nohup node scripts/dev.js --remote-debugging-port=9333 \
  > /tmp/t032/dev.log 2>&1 &
echo "wrapper pid = $!"
```

- `package.json` 的 `"dev": "node scripts/dev.js"`，**没有别的启动入口**。
- **`--remote-debugging-port` 怎么透传**：`scripts/dev.js:265-276` 把自己 `process.argv.slice(2)` 里除 `--allow-local-credentials` 之外的全部参数，跟在 `--` 后面交给 `electron-vite dev`，electron-vite 再原样递给 Electron。Linux 上 dev.js 还会自动补一个 `--no-sandbox`。所以 `node scripts/dev.js --remote-debugging-port=9333 --open-path=/some/repo` 这种写法是设计内的。
- **`setsid` 的用处**：dev.js 自己 `detached: true` 起 electron-vite（`dev.js:284`），用 setsid 包一层让你手上拿到的 pid 干净、退出时不会被 Bash 工具的会话清理牵连。

### 1.2 环境变量

| 变量 | 本机值 | 说明 |
|---|---|---|
| `DISPLAY` | `:0` | **可用，不需要 xvfb。** 实测窗口能真显示出来。 |
| `WAYLAND_DISPLAY` | `wayland-0`（`XDG_SESSION_TYPE=wayland`） | Electron 走 XWayland，不用管。 |
| `no_proxy`（小写） | 必须包含 `localhost,127.0.0.1,::1` | 见第 0 节第 2 条。dev.js 已兜底，手工起要自己加。 |
| `AICLIENT_DEV_ENV_FILE` | 未设 → 默认 `<repo>/dev.env` | **换凭据 / 换 agentDir 的唯一干净办法**：复制一份 dev.env 改完，再把这个变量指过去（`dev.js:107`）。 |
| `AICLIENT_PROFILE` | 未设 → profile 名固定为 `dev` | 决定 userData 目录后缀，见第 3 节。 |

**dev.env 是启动硬门槛**：`dev.js:180-197` 里，如果 dev.env 不存在就直接 `process.exit(1)`；存在但既没 `ANTHROPIC_AUTH_TOKEN` 也没 `ANTHROPIC_API_KEY` 同样退出。绕过办法是 `node scripts/dev.js --allow-local-credentials`（脚本自己印的「不推荐」）。本机 dev.env 是齐的，直接起即可。

### 1.3 启动到窗口就绪怎么判定

按日志里的这几行推进，**顺序固定**：

| 日志行 | 含义 | 本次实测时刻 |
|---|---|---|
| `[dev] credentials: /home/ai/code/ai-client/dev.env` | dev.env 读到了，后面跟着 BASE_URL 与掩码后的 token | t+0s |
| `✓ built in 15.48s` + `electron main process built successfully` | main 打包完 | ~t+16s |
| `dev server running ... http://localhost:5173/` | **Vite dev server 端口 = 5173**（无自定义配置，vite 默认） | ~t+18s |
| `starting electron app...` | Electron 进程即将起 | ~t+18s |
| `DevTools listening on ws://127.0.0.1:9333/...` | **CDP 端口开始监听** | ~t+45s |
| `Shared state paths { root: '/home/ai/.pilab/jyw-ai-client-dev', ... }` | Main 初始化完 | 04:39:17 |
| `[window] Showing main window via timeout fallback` | **窗口真的显示出来了** | 04:39:46（比上一行晚 28.6s） |

**判定口径**（按重要性排序）：

1. **等日志出现 `Showing main window`**，再去探 CDP。反过来先探 CDP 会被内存压力骗。
   `src/main/windows/MainWindow.ts:267-277`：优先 `ready-to-show`，其次 `did-finish-load`，最后一个 **5000 ms** 的兜底定时器。本机这台 VM 的 `ready-to-show` 基本永远赶不上，走的都是 `timeout` 兜底分支——所以看到 `via timeout fallback` 是正常的，不是故障。
2. **CDP 侧判定就绪**：`document.visibilityState === 'visible'` 且 `#root` 有子节点。截图前必须满足这两条，否则拍到纯背景色。
3. `ss -ltn | grep -E '9333|5173'` 两个端口都在听，只是「进程活着」的下限证据，不等于窗口就绪。

### 1.4 CDP 可控性验证（实测通过）

```bash
curl -s --noproxy '*' http://127.0.0.1:9333/json
```

实测返回**一个** target：

```json
[ { "id": "CB6B25B3...", "title": "AI Client", "type": "page",
    "url": "http://localhost:5173/",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/page/CB6B25B3..." } ]
```

> `curl` 一定要加 `--noproxy '*'`，否则走 7890 代理拿不到。

配套脚本已写好：**`/tmp/t032/cdp-eval.mjs`**

```bash
# 用法：node /tmp/t032/cdp-eval.mjs <端口> '<JS 表达式>' [--await] [--timeout=ms]
node /tmp/t032/cdp-eval.mjs 9333 'document.title'
# → AI Client        ← 实测输出
```

它做的事：`GET /json/list` 挑 `type==='page'` 且 url 是 http 的 target → 用 Node 22 内建的全局 `WebSocket`（不需要 `ws` 包）连 `webSocketDebuggerUrl` → 发 `Runtime.evaluate`（`returnByValue: true`）→ 打印结果 → 关连接退出。

**三条必须遵守的 CDP 纪律**（脚本注释里也写了）：

- `Runtime.evaluate` 跑在**页面全局作用域**。注入 `const x = ...` 会残留，下一次调用直接 `Identifier has already been declared`。**所有注入代码写成自包含 IIFE。**
- **不要 `--await` 一个长 promise**，会拿到 `Promise was collected`。正确姿势是：第一次 evaluate 里 `xxx.then(r => { window.__t032 = r })` 立即返回 `"kicked"`，隔几秒第二次 evaluate 读 `window.__t032`。本手册后面所有异步示例都是这个形状。
- 关弹层别用 `node.remove()`。React 的树会和真实 DOM 对不上，此后设置弹窗 `open` 变 true 却什么都不渲染，**只能重启应用**。

### 1.5 进程在 ps 里长什么样（实测）

一次完整启动的进程树（`ps -eo pid,ppid,rss,args`，本次实测 pid 供参照）：

```
40488 40485   40 MB  node scripts/dev.js --remote-debugging-port=9333
40495 40488   53 MB  npm exec electron-vite dev -- --no-sandbox --remote-debugging-port=9333
40510 40495    2 MB  sh -c electron-vite dev -- --no-sandbox --remote-debugging-port=9333
40511 40510  254 MB  node .../node_modules/.bin/electron-vite dev -- --no-sandbox --remote-debugging-port=9333
40534 40511    2 MB  .../electron-vite/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.25.12 --ping
40558 40511   19 MB  .../vite/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.27.2 --ping
40581 40511  196 MB  .../node_modules/electron/dist/electron . --no-sandbox --remote-debugging-port=9333   ← Electron 主进程
40589 40581   50 MB  .../electron/dist/electron --type=zygote --no-zygote-sandbox --no-sandbox
40590 40581   50 MB  .../electron/dist/electron --type=zygote --no-sandbox
40631 40589  103 MB  .../electron/dist/electron --type=zygote --no-zygote-sandbox --no-sandbox        ← 渲染进程
```

**重要陷阱：本机 Electron 39 的渲染进程 cmdline 仍然显示 `--type=zygote`**，我直接读 `/proc/40631/cmdline` 确认过，没有 `--type=renderer` 字样。所以：

- **不能靠 `--type=renderer` 区分渲染进程。** 靠 ppid 是某个 zygote、且 RSS 明显大于 zygote 本体来认。
- **worker（utility）进程**按历史记录应匹配 `/proc/*/cmdline` 里的 `utility-sub-type=node.mojom.NodeService`（本次没开会话，所以没起 worker，这条**未在本次实测中复现**）。
- **数 worker 数量绝对不要用 `ps -ef | grep "关键词"`**：会匹配到你自己那条命令行，数出来是假的。正确做法是遍历 `/proc/*/cmdline` 精确匹配，取「开会话前 / 开会话后 / 关闭后」三次 pid 集合做差。

**按 pid 强杀 / 查残留的命令**：

```bash
# 干净退出：给 dev.js 发 SIGTERM，它自己会收集整棵进程树逐个 SIGTERM→400ms→SIGKILL
kill <dev.js 的 pid>          # 本次是 kill 40488

# 查残留（绝不用 pkill -f，会匹配到你自己这条命令并自杀）
ps -eo pid,ppid,args | grep -E 'dev\.js|electron-vite|dist/electron|esbuild' | grep -v grep
ss -ltn | grep -E '9333|5173'
```

`scripts/dev.js:338-384` 的 `shutdown()` 自己用 `collectProcessTreePids()` 遍历 `ps -A -o pid= -o ppid=` 建父子表，逐个 kill；只有在树收集失败（只拿到 1 个 pid）时才退回 `process.kill(-child.pid)` ——**用的是子进程自己的 pid 作为进程组，不是 `-1`**，安全。

---

## 2. 渲染层 store 直接 import

### 2.1 模块路径与 URL 形态

| 项 | 值 |
|---|---|
| store 源文件 | `/home/ai/code/ai-client/src/renderer/stores/chatSessions.ts` |
| Vite dev server | `http://localhost:5173`（无自定义端口配置，vite 默认） |
| **import URL（推荐）** | `import('/stores/chatSessions.ts')` —— 路径**不带** `src/renderer` 前缀 |
| import URL（绝对形式，等价） | `import('http://localhost:5173/stores/chatSessions.ts')` |
| **绝不要用** | `/@fs/<绝对路径>/...` —— 能 import 成功但拿到**另一份模块实例**，改它对界面毫无影响、也不报错 |

两种可用形态我都实测过，`useChatSessionsStore.getState()` 拿到的是同一份（`sendMessage` 是函数、`activeSessionId` 与界面一致）。

`electron.vite.config.ts` 里 renderer 的 root 由 `input: src/renderer/index.html` 决定，所以 `/stores/...` 就是 `src/renderer/stores/...`。

### 2.2 模块导出与 state 形状（实测）

```
模块导出：applyRuntimeEvent, applyRuntimeEvents, filterRetiredRuntimeEvents, useChatSessionsStore
getState() 键：projects, workspaces, sessions, messages, activeSessionId, recentSessionIds,
              pendingPermissions, pendingQuestions, hostBoundSessionIds, unreadSessionIds,
              runtimeReady, lastError, historyErrors, historyPagination, historyBranchRevisions,
              selectSession, sendMessage, stopActiveSession, respondQuestion, initRuntime
```

**灌 transcript 的入口就是 `messages` 这个 map**（key = sessionId，value = 消息数组），用 zustand 的 `setState` 写。没有单独的 "seedTranscript" 函数。

### 2.3 最小可运行示例

第一步：探明当前会话 id 并灌一条合成消息。

```bash
node /tmp/t032/cdp-eval.mjs 9333 '(() => {
  import("/stores/chatSessions.ts").then(m => {
    const store = m.useChatSessionsStore;
    const sid = store.getState().activeSessionId;      // 关键：读，不要自己指定
    store.setState(prev => ({
      messages: {
        ...prev.messages,
        [sid]: [
          { id: "probe-u1", role: "user",      content: "合成用户消息" },
          { id: "probe-a1", role: "assistant", content: "合成助手回复" },
        ],
      },
    }));
    window.__t032 = { sid, count: store.getState().messages[sid].length };
  }).catch(e => { window.__t032 = { error: String(e) }; });
  return "kicked";
})()'
sleep 2
node /tmp/t032/cdp-eval.mjs 9333 'JSON.stringify(window.__t032)'
```

**为什么必须读 `activeSessionId` 而不是自己指定**：侧栏里已经有一堆真实会话，硬改 `activeSessionId` 会被会话恢复逻辑盖回去，塞进去的对话永远不显示（而且不报错）。

> 合成消息的确切字段形状随 `chatSessions.ts` 的消息类型走。落地成品参照 `scripts/run-batch4-language-probe.mjs`（它就是靠合成 transcript 出图的）。

### 2.4 读 store 而不是读界面

验会话生命周期时**读 store 的三个字段一起看才算断言**：`sessions[id].status` / `hostBoundSessionIds` / `messages[id]`。界面上「Tab 没了」证明不了 worker 停没停。

```bash
node /tmp/t032/cdp-eval.mjs 9333 '(() => { import("/stores/chatSessions.ts").then(m => {
  const s = m.useChatSessionsStore.getState();
  window.__t032 = { active: s.activeSessionId, hostBound: [...s.hostBoundSessionIds],
                    runtimeReady: s.runtimeReady, msgCounts: Object.fromEntries(
                      Object.entries(s.messages).map(([k,v]) => [k, v.length])) };
}); return "kicked"; })()'
```

### 2.5 进主界面的点击序列（实测）

启动后停在登录页，`document.body.innerText` 是：

```
AI Client / PILAB / 一个好用的 AI 编程工具。/ 用工作邮箱登录 / 使用本机已有配置
```

**点「使用本机已有配置」进主界面**（我实测点了，12 秒后主界面出来）。之后：

- 主导航 rail：`nav[aria-label="主导航"]`，按钮是 `聊天 / Git / 文件 / 上下文 / 运行`，外加 `能力`、`设置 (Ctrl+,)`。
  （历史记录里写过还有一个「插件」rail 按钮，**本次实测没有**，能力面板与插件设置页现在是分开的两处。）
- **弹窗是三层、一个比一个晚**：起始页 → 「把你自己的 Pi 配置搬过来」迁移提示（按钮「以后再说」）→ 「公告」（按钮「知道了」）。后两个是异步算出来才弹的，**比 composer 的 textarea 还晚**。本次实测点完登录页后 textarea 已出现，而两个 dialog 还开着（`document.querySelectorAll('[role=dialog]').length === 2`）。
  **可靠做法**：等 textarea 出现后再轮询——每轮挨个试这几个按钮文案，再查 `[role="dialog"]` 还在不在，不在才 break。
- 界面是简体中文，`aria-label` 也是中文：发送是 `[aria-label="发送消息"]`（回合进行中同一按钮变 `[aria-label="Queue message"]`，停止是 `[aria-label="Stop the running turn"]`）。按英文匹配会静默找不到。
- **点击已激活的 rail 图标 = 收起面板**（VSCode 同款 toggle-off），连点两次会把左栏关掉，不是 bug。
- 「弹层关掉了」不能用「节点从 DOM 消失」判断。Base UI 关闭后节点还在，只是 `data-open` 换成 `data-closed`。判据用 `[data-slot="menu-popup"][data-open]`。

### 2.6 右上角 GUI/TUI 开关：CDP 驱动不了

`.click()` 和 `Input.dispatchMouseEvent` 的真鼠标序列都试过，`aria-pressed` 始终停在 GUI，主日志里连一条 TUI 记录都没有。**要验终端就直接打 preload 的 IPC**（见第 6 节）。checklist 的 MODEL-48 明确要求「用户手点开关（不是探针驱动）」，就是因为这个。

---

## 3. 数据落盘位置

### 3.1 一张表

| 东西 | dev 模式实际绝对路径 | 本次实测状态 |
|---|---|---|
| `app.getPath('userData')` | `/home/ai/.config/jyw-ai-client-dev` | 存在，活跃 |
| `session-index.json` | `/home/ai/.config/jyw-ai-client-dev/session-index.json` | 存在，55162 字节 |
| electron-log 按天日志 | `/home/ai/.config/jyw-ai-client-dev/logs/aiclient-YYYY-MM-DD.log` | 实测 `log.getPath()` 返回 `.../logs/aiclient-2026-09-17.log` |
| `main.log`（electron-log 默认名） | `/home/ai/.config/jyw-ai-client-dev/logs/main.log` | 存在，与按天日志**同目录共存** |
| 应用状态根（`~/.pilab/<profile>`） | `/home/ai/.pilab/jyw-ai-client-dev` | 日志里印为 `Shared state paths { root: ... }` |
| 设置文件 | `/home/ai/.pilab/jyw-ai-client-dev/settings.json` | 存在，9384 字节 |
| 凭据 vault | `/home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json` | 存在，1042 字节 |
| `agentDir` | `/home/ai/.pilab/jyw-ai-client-dev/pi-agent` | 存在 |
| 会话 JSONL 目录 | `/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/` | 存在，25 个 cwd 子目录 |
| scratch 根 `unbound-sessions/` | `/home/ai/JYWAI/temporary/unbound-sessions` | 父目录在、子目录**当前不存在**（每次退出/启动都会整根擦） |
| runtime trace `runs.jsonl` | `$AICLIENT_RUNTIME_TRACE_DIR/runs.jsonl` | 变量**默认未设**，trace 只留内存 |

### 3.2 userData 是怎么变成 `-dev` 的

`src/main/index.ts:148-153`：

```ts
if (isDev) {
  const profile = sanitizeProfileName(process.env.AICLIENT_PROFILE || '') || 'dev';
  app.setPath('userData', join(app.getPath('appData'), `${app.getName()}-${profile}`));
}
```

`app.getName()` 读 `package.json` 的 `"name": "jyw-ai-client"`（**不是** electron-builder 的 `productName: AiClient`，那个只影响安装包展示名）。所以 dev = `~/.config/jyw-ai-client-dev`，打包态 = `~/.config/jyw-ai-client`。

`~/.config/jyw-ai-client/`（无 `-dev`）本机只有一个 `Crashpad/` 子目录 —— 打包应用几乎没在这台机器上跑过，**PKG 组的项别指望复用本机现成数据**。

> ⚠️ **`window.electronAPI.app.getPath()` 在渲染层调不通。** 实测返回 `No handler registered for 'app:getPath'`（登录页和进主界面后都一样，Main 日志里也是同一条 error）。preload 声明了这个方法但 Main 从来没注册 handler。**要在 CDP 里拿路径，用 `window.electronAPI.log.getPath()`**（实测可用，返回按天日志的完整路径），userData 就是它的上上级目录。

### 3.3 session-index.json

`src/main/services/chat/SessionIndexService.ts:16`（`SESSION_INDEX_FILENAME = 'session-index.json'`）、`:93-95`：

```ts
function getSessionIndexPath(): string {
  return join(app.getPath('userData'), SESSION_INDEX_FILENAME);
}
```

落在**裸 userData**，不是 `~/.pilab`。DEV-5/6/7/8/9/28 全都要读它，路径记牢：`/home/ai/.config/jyw-ai-client-dev/session-index.json`。

### 3.4 agentDir 与会话 JSONL

解析链：`getActivePiAgentDir()` → `getAppPiAgentDir()`（`src/main/services/piModelConfig/index.ts:40-42`）= `join(getAppStateRoot(), 'pi-agent')`；`getAppStateRoot()`（`src/main/services/appStatePaths.ts:41-43`）= `~/.pilab/<userData 目录的 basename>`。

`sessions/` 下按 cwd 编码成子目录，例如：

- `--home-ai-code-ai-client--/` ← 本仓工作区的会话
- `--home-ai-JYWAI-temporary-unbound-sessions-<uuid>--/` ← scratch 会话（目录留着，源 scratch 目录已被擦）

> **别去 dev.env 的 `PI_CODING_AGENT_DIR` 那个目录找会话文件。** H/19 之后两种模式一律跑在应用自己的 profile 下，dev.env 那个（本机指 `~/.pilab/t37c-agent`）只是**读配置**的来源。去那儿找刚写的会话文件会一无所获，而且不报错。

### 3.5 scratch 根与「保存位置」设置

- 常量：`src/main/services/agent-host/ScratchWorkspaceService.ts:64` → `SCRATCH_ROOT_DIR = 'unbound-sessions'`
- 根拼接：`ScratchWorkspaceService.ts:122-123` → `resolveBasePath() + '/unbound-sessions'`
- 默认 base：`src/shared/defaultPaths.ts:73-75` → `~/JYWAI/temporary`
- **「保存位置」设置项**：文件 `/home/ai/.pilab/jyw-ai-client-dev/settings.json`，键名 **`defaultTemporaryPath`**（字符串，`""` = 用默认值；本机当前就是 `""`）。
  - 键常量：`ScratchWorkspaceService.ts:67` → `TEMPORARY_PATH_SETTING_KEY = 'defaultTemporaryPath'`
  - settings 路径代码：`src/main/services/SharedSessionState.ts:7,32,36`
  - **`TempWorkspaceService`（`temp:workspace:*` 那套用户手动管的临时工作区）读同一个键**，但落在这个 base 的另一层子目录。`ScratchWorkspaceService.ts:56-64` 的注释点明了这个分层就是为了「删临时工作区时删不到 scratch」——**DEV-27 验的就是这一条**。
- 整根擦除时机：`src/main/ipc/workerManager.ts:11`（退出时 `wipeAll()`）与 `:20-22`（`sweepScratchWorkspacesOnStartup`，启动时扫崩溃残留）。**这解释了为什么本机 `~/JYWAI/temporary/` 是空的。**

### 3.6 `AICLIENT_RUNTIME_TRACE_DIR`

- 变量名常量：`src/runtime/flags.ts:33` → `RUNTIME_TRACE_DIR_ENV = 'AICLIENT_RUNTIME_TRACE_DIR'`
- 读取：`flags.ts:49-55`，未设置则 `traceDir: null` ⇒ **trace 只留内存，不落盘**
- 写盘：`src/runtime/trace.ts` 的 `TracePlugin`，`trace.ts:239` → `const path = join(dir, 'runs.jsonl')`
- 滚动：单文件 8 MiB（`TRACE_FILE_MAX_BYTES`，`trace.ts:46`）、保留 3 代（`trace.ts:47`），超限后重命名为 `runs.1.jsonl`…`runs.3.jsonl`（`trace.ts:294-316`），跨进程互斥用 `runs.rotate.lock`（`trace.ts:69`）
- **用法**：起应用前 `export AICLIENT_RUNTIME_TRACE_DIR=/tmp/t032/trace`，worker 继承后就会往那儿写 `runs.jsonl`。dev.env / dev.env.example 里都没有默认值，**所以不手动设就没有 trace 文件**——凡是判据里写「抓 trace 的某某行」的项（ENC-23/24、WIN-37、MODEL-43 等），第一步都是设这个变量。
- 另一处引用：`scripts/packaged-worker-smoke.cjs:110`（给子进程传目录）；文档表在 `src/runtime/README.md:120`。

---

## 4. Main IPC 面

### 4.1 preload 暴露的对象叫 `electronAPI`

**不是 `window.api`。** `src/preload/index.ts:1260-1261`：

```ts
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('Buffer', Buffer);
```

实测 `Object.keys(window)` 里与 API 相关的只有 `__electronLog` 和 `electronAPI`。

顶层命名空间（实测枚举，共 40 个）：
`git · worktree · tempWorkspace · folder · file · terminal · piTui · session · app · dialog · remote · sessionStorage · contextMenu · appDetector · cli · tmux · settings · usage · announcements · onboarding · env · shell · menu · window · notification · updater · piRuntime · auth · legacyImport · search · webInspector · log · utils · chat · piModels · userProviders · piResources · piSubagents · agentMigration · piPlugins · piPermissions`

`electronAPI.chat` 的方法（实测）：
`ensureHost, getHostStatus, createSession, registerSession, ensureScratchWorkspace, resumeSession, reloadSession, send, stop, closeSession, respondPermission, respondQuestion, setPermissions, setPermissionTier, onRuntimeEvent, listSessions, listSessionCapabilities, loadHistoryPage, getSlashCommands, compactSession, getSessionTree, rewindSession, forkSession, renameSession, archiveSession, listPiModels`

### 4.2 CHAT_SEND

- 通道常量：`src/shared/types/ipc.ts:353` → `CHAT_SEND: 'chat:send'`
- Handler：`src/main/ipc/chat.ts:503-522`
- preload：`src/preload/index.ts:1036-1050` → `electronAPI.chat.send(payload)`

payload 形状（`chat.ts:507-521` 原文）：

```ts
{
  sessionId: string;
  attemptId: string;
  text: string;
  attachments?: Array<{ kind: 'image' | 'text'; mediaType: string; data: string; name?: string }>;
  effort?: SessionEffortLevel;   // T-20 每回合覆盖，缺省用会话默认
  model?: string;                // Round-2 P0 每回合覆盖
}
// 返回 Promise<{ requestId: string }>
```

**DEV-34 就是直接拿这个接口绕过 Composer 发超限 payload。** 示例（注意 CDP 纪律：不 await）：

```bash
node /tmp/t032/cdp-eval.mjs 9333 '(() => {
  import("/stores/chatSessions.ts").then(m => {
    const sid = m.useChatSessionsStore.getState().activeSessionId;
    const big = "A".repeat(12 * 1024 * 1024);   // 12 MiB base64，远超任何一档上限
    return window.electronAPI.chat.send({
      sessionId: sid, attemptId: "dev34-" + Date.now(), text: "attachment guard probe",
      attachments: [{ kind: "image", mediaType: "image/png", data: big, name: "huge.png" }],
    });
  }).then(r => { window.__t032 = { ok: true, r }; })
    .catch(e => { window.__t032 = { ok: false, err: String(e) }; });
  return "kicked";
})()'
```

### 4.3 其余要用的通道

| 能力 | preload 方法 | preload 位置 | 通道常量 | Main handler |
|---|---|---|---|---|
| 发消息 | `chat.send(payload)` | `preload/index.ts:1036-1050` | `CHAT_SEND` = `'chat:send'`（`ipc.ts:353`） | `main/ipc/chat.ts:503` |
| fork 会话 | `chat.forkSession(payload)` | `preload/index.ts:1132-1136` | `CHAT_FORK_SESSION` = `'chat:forkSession'`（`ipc.ts:397`） | `main/ipc/chat.ts:765-777` |
| 归档会话 | `chat.archiveSession({sessionId, archived})` | `preload/index.ts:1139-1140` | `CHAT_ARCHIVE_SESSION` = `'chat:archiveSession'`（`ipc.ts:389`） | `main/ipc/chat.ts:645-650` |
| 删临时工作区 | `tempWorkspace.remove(dirPath, basePath?)` | `preload/index.ts:360-361` | `TEMP_WORKSPACE_REMOVE` = `'temp:workspace:remove'`（`ipc.ts:80`） | `main/ipc/tempWorkspace.ts:178` |
| 导入：列项目 | `legacyImport.listProjects()` | `preload/index.ts:912-920` | `'legacy-import:listProjects'`（`ipc.ts:288`） | `main/services/legacyImport/` |
| 导入：列会话 | `legacyImport.listSessions(projectId, sourceKind?)` | 同上 | `'legacy-import:listSessions'`（`ipc.ts:289`） | 同上 |
| 导入：批量导入 | `legacyImport.importBatch(request)` | 同上 | `'legacy-import:batch'`（`ipc.ts:290`） | 同上 |

同族对照：`TEMP_WORKSPACE_CREATE` = `'temp:workspace:create'`、`TEMP_WORKSPACE_CHECK_PATH` = `'temp:workspace:checkPath'`（`ipc.ts:79-81`）。另有两个名字里带 IMPORT 但不是会话导入的：`SESSION_STORAGE_IMPORT_LOCAL_STORAGE`（`ipc.ts:188`）、`PI_SUBAGENTS_IMPORT_PREVIEW/APPLY`（`ipc.ts:256-257`，子代理导入）。

---

## 5. 模型替身 / 假网关 / 真实凭据

### 5.1 结论先说

| 问题 | 答案 |
|---|---|
| 有没有能让 GUI 免真凭据跑一回合的现成开关？ | **没有现成开关。** offline lane 的 "ready" 替身进不了 GUI。 |
| 那怎么办？ | **起一个本地 HTTP 假网关，配成 GUI 里的一个自定义 AI 服务。** 配方见 5.3。 |
| 本机有没有真实凭据？ | **有，而且是齐的。** 见 5.5。 |

### 5.2 offline lane 的 "ready" 替身为什么进不了 GUI

- 实现：`src/runtime/smoke/runOnce.ts:123-133`，用的是 pi-ai 包自带的 **`fauxProvider()` 对象**（`@earendil-works/pi-ai/providers/faux`），**不是** HTTP 服务、**不是** 环境变量开关：

  ```ts
  const faux = fauxProvider({ provider: 'faux', models: [...], tokensPerSecond: 400 });
  faux.setResponses([fauxAssistantMessage(smokeCase.scripted_output ?? 'ready')]);
  ```
  再经 `createRuntime({ providers: [buildFauxProvider(...)], ... })`（`runOnce.ts:90-96`）注入。

- **GUI 链路上没有注入点**：`src/runtime/worker/nativeWorkerRuntime.ts:185` 的 `createRuntime` 调用**从不传 `providers` 字段**。`src/runtime/flags.ts:35-63` 是 Electron 主进程/worker 唯一读的运行时旋钮集合，只有 `AICLIENT_RUNTIME_AGENT_DIR` / `PI_CODING_AGENT_DIR` / `AICLIENT_RUNTIME_TRACE_DIR`，**没有任何离线/假 provider 开关**（`AICLIENT_RUNTIME_BACKEND` 已在 P6-5 随旧引擎删掉）。`src/main`、`src/agent-host`、`src/runtime/worker` 下 grep `AICLIENT_OFFLINE|AICLIENT_FAKE|AICLIENT_MOCK|FAUX` 全无命中。

所以 GUI 侧必然走真实 model-adapter 读 `models.json` / `auth.json`（或 vault 里的自定义服务）。

### 5.3 把假网关配成一个自定义服务（推荐路径）

**第一步：起假网关。** 直接抄 `scripts/run-f4-retry-probe.mjs:91-129` 的 `startGateway()`：`node:http` 起 server，`listen(0, '127.0.0.1')` 随机端口，**不区分路径**，按请求序号读一个 `plan[]` 数组，用完重复最后一项。

- 成功项返回**手写的 Anthropic Messages SSE**（`successBody()`，`run-f4-retry-probe.mjs:42-82`）：`message_start → content_block_start → content_block_delta(text_delta) → content_block_stop → message_delta(stop_reason) → message_stop`
- 失败项：`res.writeHead(503, headers)` + body `{type:'error', error:{type:'overloaded_error', message:'...'}}`

**第二步：配进 GUI。** 两条路，任选：

- **路 A（走界面）**：设置 → AI services → 新增。字段是 **Service（预设或 Custom）/ Name / Service URL / API style / API key**，保存后点 "Fetch models" 勾模型。代码 `src/renderer/components/settings/ProviderSetupDialog.tsx:130-135`：`canSave` 只要求 name + baseUrl 合法 + apiKey 非空，**不强制 Fetch models 成功**；但不点它 `models` 就是空数组，模型选择器里挑不到东西。
- **路 B（直接改文件，更快）**：编辑 `/home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json`。

  `UserProvider` 类型（`src/main/services/auth/CredentialVault.ts:85-110`）：

  ```ts
  interface UserProvider {
    id: string; name: string; baseUrl: string; api: string; apiKey: string;
    headers?: Record<string, string>;
    models?: string[];          // 空 = 未选任何模型
    enabled: boolean; createdAt: string;
    configKey?: string;         // 仅迁移来的服务才有
  }
  ```

  vault 顶层的 `userProviders` 字段**既可以是明文数组，也可以是加密字符串**，由同级的 `userProvidersEnc` 决定（`CredentialVault.ts:455-470`）：`'safeStorage'` → 按字符串解密；**不是 `'safeStorage'`（缺省或 `'none'`）→ 直接当明文数组读**。本机当前是 `version:2, enc:"none", userProvidersEnc:"safeStorage"`（说明 OS keyring 可用）。

  **所以预置办法是**：把 `userProvidersEnc` 改成 `"none"`（或删掉），`userProviders` 写成明文数组：

  ```json
  [{ "id": "probe-1", "name": "Fake Gateway",
     "baseUrl": "http://127.0.0.1:PORT", "api": "anthropic-messages",
     "apiKey": "fake-key", "enabled": true,
     "createdAt": "2026-09-17T00:00:00.000Z", "models": ["fake-1"] }]
  ```

  `checkProviderBaseUrl()`（`src/shared/userProviders.ts:252-265`）只检查协议是 `http:`/`https:`、hostname 合法、无 query/hash/用户名密码 —— **不拒绝 `127.0.0.1`**，本地假网关完全合法。

  `api` 可选 10 种（`src/shared/userProviders.ts:26-37`）：`openai-completions / openai-responses / openai-codex-responses / azure-openai-responses / anthropic-messages / google-generative-ai / google-vertex / bedrock-converse-stream / mistral-conversations / pi-messages`。

  **不需要重开应用**：`resolveNativeModelCatalog()`（`src/main/services/piModelConfig/index.ts:152-160`）每次 worker/会话启动都实时读 vault（调用点 `WorkerManager.ts:3111`、`PiUtilityService.ts:398`）。**注意**：一旦在设置页对任何服务做增删改，`onChange`（`src/main/services/userProviders/index.ts:92-98`）会把 vault 重新序列化覆盖回去，手工塞的明文会被重新加密、脏数据会被清掉。
  （对照：`models.json` 那条老路是 **worker 只在启动时读一次**，改完必须整个重启应用，`location.reload()` 不算。）

**第三步：三个目标场景各要什么报文。**

报文风格由 `api` 值决定：`anthropic-messages` 用 Anthropic 风格（`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:441,483`），`openai-*` 用 OpenAI 风格（`.../openai-completions.js:441-442`）。

| 场景 | 假网关要返回什么 |
|---|---|
| ① 可控长回合（`bash sleep 60` 再给最终文本） | Anthropic 风格：`content_block_start{content_block:{type:"tool_use", id, name:"bash", input:{}}}` → 若干 `content_block_delta{delta:{type:"input_json_delta", partial_json:"...{\"command\":\"sleep 60\"}..."}}` → `content_block_stop` → `message_delta{stop_reason:"tool_use"}`；工具结果回填后再发一轮普通 `text_delta` 收尾。OpenAI 等价物：`choices[0].delta.tool_calls[0] = {index, id, function:{name:"bash", arguments:"..."}}` + `finish_reason:"tool_calls"`。 |
| ② 503 重试 | HTTP 层直接 `res.writeHead(503)` + `{type:'error',error:{type:'overloaded_error'}}`，**与 API style 无关**（还没拿到流就失败了）。`classifyProviderFailure` 只看 status + `Retry-After`。F4 探针里 429 带 `retry-after: 1` 走的是另一条独立预算。 |
| ③ 写文件审批 | 同 ①，把工具名换成 `write` 或 `edit`。签名见 `src/runtime/smoke/p1-host-tools.ts:74,76`：`write{path, content}` / `edit{path, edits:[{oldText,newText}]}`。权限模式非 `accept-edits`/`bypass` 时会弹结构化中文权限卡。 |

> **审批界面按后端不同**：native 是结构化中文权限卡，legacy 是插件自己的英文 `ui.select` 弹窗。只认一张会读成「没弹审批」。

### 5.4 已有的假网关参照实现

`scripts/run-f4-retry-probe.mjs` 是**唯一一个起真 HTTP server 扮演网关的脚本**，而且它已经把「写临时 agentDir」也做了（`writeAgentDir(baseUrl)`，`:131-155`）：临时目录里写 `models.json`（`api: 'anthropic-messages'`, `baseUrl` 指向假网关）+ `auth.json`（`{fakegw:{type:'api_key', key:'fake-key'}}`），然后 `createRuntime({ agentDir, env })` 直接跑，**不起 Electron**。

**想给 GUI 用的话有两条改法**：把这个临时 agentDir 通过 `AICLIENT_RUNTIME_AGENT_DIR` / `PI_CODING_AGENT_DIR` 喂给应用（改 dev.env 副本 + `AICLIENT_DEV_ENV_FILE`），或者走 5.3 的 vault 自定义服务路。**两条都未在本次实测中验证过**，请按 DEV-24 的第一步做。

`scripts/run-perm1-probe.mjs` 和 `scripts/run-f2b-probe.mjs` **都不起假网关**，它们用 CDP 驱动真实 dev app、依赖本机真实凭据：

- `run-perm1-probe.mjs`：验 PERM-1 权限档弹层的开关，**并且会真的触发审批**——`:250-285` 往输入框注入「用 bash 运行这条命令：echo perm-probe-ok」，等权限卡出现、点「直接允许」、确认命令真执行。运行：`node scripts/run-perm1-probe.mjs`（`PERM1_ATTACH=1` 可接管已运行实例）。
- `run-f2b-probe.mjs`：验临时会话「关闭 / 归档 / 应用退出」三种收尾下 `session-index.json` 与 scratch 目录的真实状态。会真发消息等模型回复来触发 scratch 分配（`:202-220`）。**DEV-26/27 沿用它的两侧读法。**

### 5.5 真实凭据（只报有/无与位置，未打印任何密钥内容）

| 位置 | 有没有 | 说明 |
|---|---|---|
| `~/.pilab/pi-agent/`（裸路径） | **不存在** | 实际是按 profile 分的 `~/.pilab/<profile>/pi-agent/` |
| `/home/ai/.pilab/jyw-ai-client-dev/pi-agent/auth.json` | **有，323 字节，有内容** | 顶层 key 是 `cx2` / `maxapi` / `vllmproxy` 三个 provider，类型均 `api_key` |
| 同目录 `models.json` | **有，1147 字节** | 同三个 provider |
| `/home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json` | **有，1042 字节** | `userProvidersEnc:"safeStorage"`，内容已加密（说明 OS keyring 可用） |
| `/home/ai/.pilab/t37c-agent/auth.json` | 有文件但 **3 字节**（几乎必是 `{}`） | 历史探针用的 agent 目录，无真实凭据；但 `models.json` 有 2364/2769 字节 |
| `/home/ai/code/ai-client/dev.env` | **有，1479 字节，`-rw-------`** | 键名：`ANTHROPIC_BASE_URL` `ANTHROPIC_AUTH_TOKEN` `AICLIENT_DEFAULT_TEST_MODEL` `AICLIENT_MANAGED_CREDENTIALS` `AICLIENT_NODE24_PATH` `PI_CODING_AGENT_DIR` |
| 环境变量 | **没有** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 之类 | 只有一个 `CLAUDE_CODE_MESSAGING_TOKEN`（CLI 自己的，与本仓无关） |

本次启动时 dev.js 自己印出的行（**未打印密钥值，只有掩码**）：

```
[dev]   ANTHROPIC_BASE_URL = https://api.vllmproxy.com
[dev]   ANTHROPIC_AUTH_TOKEN = sk-BRw…***(51 chars)
[dev]   AICLIENT_MANAGED_CREDENTIALS = 0 (dev-only override; '1'=managed, '0'=force local)
[dev]   AICLIENT_SKIP_AUTH_GATE = (unset)
```

**结论：本机 dev profile 已有真实可用凭据，点验真回合直接点「使用本机已有配置」即可，不必额外配置。**

配套的两条历史约束：

- **点验默认模型（用户指定）：`vllmproxy` provider + `claude-sonnet-5`。别再用 `cx2` / `maxapi`** ——那是用户自己的账户且已无余额，症状是回合跑起来后回 `403 Insufficient account balance`。
- **起应用前先 `curl` 一发 `/v1/messages` 探活**。曾经整片 503 `No available accounts` 是上游账号池空了，**这类 503 不要往本地配置上查**。
- **换模型别跟 base-ui 子菜单较劲**。可靠做法是写 `localStorage['aiclient:chat:session-models'][sessionId] = 'provider/modelId'`，重载后 composer 就显示它；发送仍必须走 textarea + `[aria-label="发送消息"]`。

### 5.6 运行模式改不了时看 dev.env

未打包构建里**环境变量压过设置文件**（`resolveCredentialMode` 优先级 1，`src/shared/credentialMode.ts`），而 dev.js 把 dev.env 的键一路带给子进程。所以在应用里调 `auth.enterApp('managed')` 在这台机器上毫无效果（dev.env 写死 `AICLIENT_MANAGED_CREDENTIALS=0`）。**要换模式**：复制一份 dev.env 改完，用 `AICLIENT_DEV_ENV_FILE` 指过去；托管模式还要加 `AICLIENT_SKIP_AUTH_GATE=1`，否则没登录会被挡在主界面外。

---

## 6. pi CLI 与内嵌 TUI

### 6.1 可执行文件（已实跑验证）

| 来源 | 绝对路径 | 版本 |
|---|---|---|
| **随包（dev 模式实际用的）** | `/home/ai/code/ai-client/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | `0.84.4` |
| 全局安装 | `~/.local/bin/pi` → `/home/ai/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | `0.84.4`（**与仓库副本 `diff` 不同，是独立安装**） |
| 打包态 | `<resourcesPath>/agent-host/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | 由 `src/main/services/terminal/PiTuiPty.ts:127-150` `resolvePiCliLaunchPlan()` 解析 |

文件带 `#!/usr/bin/env node` 且有执行位，可直接跑。`resources/` 下**没有**打包的 pi（只有 `ghostty-themes/` 和 `model-catalog/`）。

### 6.2 打开与列会话

来自实跑的 `pi --help`：

| 参数 | 作用 |
|---|---|
| `--session <path\|id>` | 打开指定会话文件或 UUID 前缀 |
| `--session-id <id>` | 用精确的项目会话 ID，不存在就建 |
| `--session-dir <dir>` | 会话存储与查找目录 |
| `--continue, -c` | 续上一个会话 |
| `--resume, -r` | **选一个会话来续** —— 这就是「列会话」的方式，**交互式选择器** |
| `--fork <path\|id>` | fork 指定会话成新会话 |

**没有非交互式打印会话列表的 flag。** 顶层子命令只有 `install/remove/uninstall/update/list/config/auth`，其中 `pi list` 是**列已安装扩展**，不是列会话；也没有 `pi sessions`。

DEV-8 要求「开 pi CLI 列会话」，实操是：

```bash
/home/ai/code/ai-client/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --session-dir '/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/--home-ai-code-ai-client--' \
  --resume
```

仓库自己拼参数的代码（与 help 一致）：`src/main/services/terminal/piTuiSession.ts:48-51`

```ts
export function buildPiTuiArgs(cliPath: string, sessionFile?: string | null): string[] {
  const file = sessionFile?.trim();
  return file ? [cliPath, '--session', file] : [cliPath];
}
```

最终 spawn 是 `<nodePath> <cliPath> --session <file>`（`PiTuiPty.ts:283`）。**DEV-15/16 用 `ps aux | grep -- --session` 数进程就是查这个。**

### 6.3 内嵌 TUI 怎么触发

- **按钮**：`src/renderer/components/workspace-shell/SessionBar.tsx:157`，`<PresentationButton label="TUI" ... />`（同栏 `:151-156` 是 `label="GUI"`，两者组成 `role="group" aria-label={t('Presentation mode')}`，在 `:145-150`）
- 逻辑：`src/renderer/components/chat/usePresentationSwitch.ts:95-158` 的 `openTui`，先用 `piTui.sessionSupport(...)` 探测会话格式 pi 能不能解析
- 真正发 IPC：`src/renderer/hooks/useXterm.ts:758`（挂起后重开在 `:982`）→ `window.electronAPI.piTui.open({...})`
- preload：`src/preload/index.ts:480` → `ipcRenderer.invoke(IPC_CHANNELS.PI_TUI_OPEN, request)`
- 通道常量：`src/shared/types/ipc.ts:132` → `PI_TUI_OPEN: 'piTui:open'`（同组还有 `PI_TUI_WRITE/RESIZE/SUSPEND/DISPOSE/STATUS/SESSION_SUPPORT/DATA/EXIT/STATE`）
- Main handler：`src/main/ipc/piTui.ts:145-176`，经 `PiTuiExclusiveGuard`（`piTuiSession.ts`）做 GUI/TUI 互斥后调 `PiTuiPty.ts:233` 的 `controller.open(request)`

**那个分段开关 CDP 驱动不了（见 2.6）。要验终端直接打 IPC**：

```js
window.electronAPI.piTui.sessionSupport(file)                       // 问入口守卫放不放行
window.electronAPI.piTui.open({ terminalId, cwd, sessionFile, cols, rows })  // 起真 PTY
window.electronAPI.piTui.onData(...)                                // 收输出
window.electronAPI.piTui.dispose(terminalId)                        // 结束
```

**`terminalId` 是必填的**，漏了报 `Cannot read properties of undefined (reading 'trim')`。成品见 `scripts/run-p6-native-default-probe.mjs`。这条链和点按钮走的是同一条，只是少了那一下点击。

### 6.4 writer.lock

**这是本仓自己的 session 层机制，与 pi CLI 无关** —— `src/main/ipc/piTui.ts:121` 明写「the pi CLI never takes the worker's writer lock」。

- 路径公式：`src/runtime/plugins/session/writerLock.ts:128-130`

  ```ts
  export function writerLockPath(file: string): string {
    return `${file}.writer.lock`;
  }
  ```
  即 `<会话 jsonl 全路径>.writer.lock`，sidecar，和 jsonl 同目录。

- 内容（JSON，`claimBytes`，`writerLock.ts:178-188`）：`{ pid, host, token, acquiredAt, startedAt }`
  实盘样例：`{"pid":476193,"host":"ai-VMware-Virtual-Platform","token":"322a8755-...","acquiredAt":1789347896214}`
- 创建：`acquireWriterLock()`（`:438-464`）用 `io.writeFile(path, ..., { createOnly: true, mode: 0o600 })` —— `createOnly` 就是互斥手段。调用方 `src/runtime/plugins/session/store.ts:184`。
- 删除：`releaseWriterLock()`（`:475-483`），先校验 token 属于自己再 unlink。调用方 `store.ts:257` 与 `store.ts:679`。
- 接管：pid 已死的锁由 `stale()`（`:237-248`）判定为可接管，走 `takeOver()` 原子 rename（`:381-429`）。

**本机现状：`/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/` 下有 8 个残留 `.writer.lock`**（pid 37645 / 411159 / 411563 / 411924 / 412298 / 412792 / 413225 / 476193），逐个 `ps -p` 核实**全部进程已不存在**，是之前被杀的 dev 进程留的 stale lock，无害，下次打开对应会话会被自动接管清理。

👉 **点验时如果看到 `session_locked`，先查这个目录下是不是真有活进程占着**，别当成新缺陷。

```bash
find /home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions -name '*.writer.lock'
```

---

## 7. 导入源

### 7.1 磁盘现状（我实测的精确数字）

| 源 | 存在？ | 数量 |
|---|---|---|
| `~/.claude/projects` | **存在** | **2 个项目目录，365 个 `.jsonl`**：`-home-ai-code/` 2 个，`-home-ai-code-ai-client/` **363 个** |
| `~/.codex/sessions` | **存在**，按 `YYYY/MM/DD/` 分层 | **12 个 `rollout-*.jsonl`**，无残留 lock/tmp |

**对 DEV-13（「300 份以上 rollout 时打开导入面板的耗时」）的直接影响**：Claude 源已经有 363 份，样本够了；**Codex 源只有 12 份，远不够 300**，要么造样本，要么把这项的判据落在 Claude 源上。

**对 DEV-12（Codex 旧格式裸行导入）**：本机 12 个 rollout 的格式**未逐个检查**（H/21 当时的记录是「本机 10 个 rollout 全是新格式」）。这项大概率仍然缺样本。

### 7.2 环境变量覆盖：两个都**有**读取

- `CLAUDE_CONFIG_DIR` —— `src/main/services/legacyImport/ClaudeSessionScanner.ts:58`

  ```ts
  export function resolveLegacyClaudeSessionRoot(env: NodeJS.ProcessEnv = process.env): ClaudeSessionRoot {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return { dir, kind: 'legacy' };
  }
  ```
  生产接线：`src/main/services/legacyImport/LegacyImportService.ts:106`
  （`ClaudeSessionRootKind` 还定义了 `'managed'`，但生产只传了一个 `'legacy'` root，`'managed'` 目前只在测试里用到 —— `ClaudeSessionScanner.ts:30,167`）

- `CODEX_HOME` —— `src/main/services/legacyImport/CodexSessionScanner.ts:82`

  ```ts
  constructor(
    private readonly resolveRoot: () => string = () =>
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
  ) {}
  ```

**本机两个变量都未设**（我 `env | grep` 确认过），所以生效路径就是默认的 `~/.claude` 和 `~/.codex`。

👉 **DEV-10（子目录不可读时 Codex 源的表现）可以用 `CODEX_HOME` 指到一份复制出来的样本目录上做**，避免在真目录上 `chmod 000`。**但要注意变量必须在起应用前 export 进 dev.js 的环境**（dev.js 会剥掉凭据形状的变量，`CODEX_HOME` 不在剥除名单里，所以能透传 —— **此点未实测**）。

### 7.3 导入逻辑入口

目录：`/home/ai/code/ai-client/src/main/services/legacyImport/`

| 文件 | 作用 |
|---|---|
| `LegacyImportService.ts` | 顶层服务与单例（`:492` 导出 `legacyImportService`） |
| `ClaudeSessionScanner.ts` / `CodexSessionScanner.ts` | 两个源的扫描器 |
| `ClaudeSourceAdapter.ts` / `CodexSourceAdapter.ts` / `CodexRollout.ts` | 格式读取与转换 |
| `LegacyImportSources.ts` | 汇总接线（`scanAllLegacySources`、`claudeSourceImporter`、`codexSourceImporter`） |
| `PiImportProcess.ts` | 落盘成 pi 会话格式 |
| `LegacyImportManifest.ts` | 去重 / 清单记录（**DEV-11 要查的 `cleanupPending` 在这里**） |

暂存目录：`<agentDir>/sessions/.aiclient-import-staging/`（本机在 `--home-ai-code-ai-client--/` 下实际存在）。

---

## 8. 探针脚本清单

### 8.1 `src/runtime/smoke/`（非 UI，不起 Electron）

| 脚本 | 用途 | 运行 |
|---|---|---|
| `runOnce.ts` | P0 单回合。`--offline` 用 faux 替身，`--model <p>/<id>` 打真模型 | `node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline`（= `pnpm smoke:runtime`） |
| `p1-standalone.ts` | P1 host-tools 探针，standalone Node carrier | `node --experimental-strip-types src/runtime/smoke/p1-standalone.ts`（= `pnpm smoke:runtime-tools`） |
| `p1-bundled-node.ts` | 同上，Windows 打包 `node.exe` 作 carrier | 需传 node 路径 + shell 路径 |
| `p1-utility-worker.ts` | 同一探针在 Electron utility worker carrier 下跑 | 由 `scripts/runtime-smoke/electron-carrier.cjs` 拉起 |
| `p1-host-tools.ts` | 上面三者共用的核心：read/write/edit/bash/glob/grep + 一次 `runtime.run()` | 库文件，不单独跑 |
| `assertions.ts` | 断言层，读 `SmokeCase.expected_assertions` | 库文件 |
| `cases/p0-single-turn.json` / `p0-single-turn-offline.json` | live / offline 两条 lane 的用例定义（offline 版带 `scripted_output: "ready"`） | 数据文件 |

### 8.2 `scripts/`（现场 / GUI）

| 脚本 | 用途 | 运行 |
|---|---|---|
| `h21-cdp.mjs` | **公共 CDP 驱动库**：`Cdp` 类、`startDevApp`/`stopDevApp`、`clickByText` | 被 perm1 / f2b / t37c 等 import |
| `run-t37c-gui-probe.mjs` | 大型 CDP GUI 点验（入口/多会话/队列/历史/旧版导入/GUI-TUI 切换）。**53 KB，先读它** | `node scripts/run-t37c-gui-probe.mjs [--only=... --keep-open]` |
| `run-perm1-probe.mjs` | 权限档弹层开关 + **真的触发 bash 审批链** | `node scripts/run-perm1-probe.mjs`（`PERM1_ATTACH=1` 接管已跑实例） |
| `run-f2b-probe.mjs` | 临时会话关闭/归档/重启后的 scratch 与 session-index 真实状态 | `node scripts/run-f2b-probe.mjs` |
| `run-f4-retry-probe.mjs` | **起真 HTTP 假网关**验 503/429 重试与取消（4 个场景），不起 Electron | `node scripts/run-f4-retry-probe.mjs` |
| `run-f3-dev-probe.mjs` | 验 Electron 主进程 `spawn('git')` 是否丢 stdout | `node scripts/run-f3-dev-probe.mjs` |
| `run-batch4-language-probe.mjs` | **用合成 transcript 查中文界面里的英文硬编码** —— 灌 transcript 的成品参照 | `node scripts/run-batch4-language-probe.mjs` |
| `run-p6-native-default-probe.mjs` | 验默认后端=native、权限卡样式指纹、H/20 会话文件格式。**内嵌 TUI 打 IPC 的成品** | `node scripts/run-p6-native-default-probe.mjs` |
| `run-h19-managed-notice-probe.mjs` | 托管模式下插件页文案（自带专用 dev.env） | `node scripts/run-h19-managed-notice-probe.mjs` |
| `run-h19-plugin-gui-probe.mjs` | 真实控件装/卸 npm 插件 + 会话能力清单联动 | `node scripts/run-h19-plugin-gui-probe.mjs` |
| `run-h19-project-scope-probe.mjs` | 托管模式下项目级插件是否生效 | `node scripts/run-h19-project-scope-probe.mjs` |
| `run-h21-import-scan-probe.mjs`（+ `probes/h21-conversation-import-scan.ts`） | 离线导入扫描，不起 Electron | `node scripts/run-h21-import-scan-probe.mjs` |
| `h21-step.mjs` | 对**已跑起来**的 dev app 逐条提问（迁移弹窗等） | `node scripts/h21-step.mjs look` |
| `h21-import-check.mjs` | 导入面板逐条验证 | `node scripts/h21-import-check.mjs open\|project\|import\|sidebar\|shot` |
| `run-t29c-worker-probe.mjs` / `run-t30-worker-manager-probe.mjs` / `run-t33-tree-rewind-fork-probe.mjs` / `run-t34-legacy-import-probe.mjs` / `run-t37b-longevity-probe.mjs` | 针对打包后 `out-agent-host/worker.js` 的 worker / 管理器 / 回退 / 导入 / 长时稳定性 | `node scripts/run-tNN-*-probe.mjs [worker.js路径]`，**需先 `pnpm build:agent-host`** |
| `packaged-worker-smoke.cjs` | 打包后 app 内用 `utilityProcess` 真跑一次 worker 生命周期 | `electron scripts/packaged-worker-smoke.cjs <worker.js>` |
| `packaged-worker-report.mjs` | 对上面烟测输出做纯函数校验 | 库函数 + 配套测试 |
| `permission-policy-probe.mjs` | 把真实 `pi-permission-system` 的 `PermissionManager` 打包成临时 ESM 加载 | 库函数，被其它探针 import |
| `probes/b1a-shared-skills-probe.mjs` | 真实 pi SDK 验共享技能加载 | `node scripts/probes/b1a-shared-skills-probe.mjs` |
| `verify-context-details.mjs` / `verify-question-layout.mjs` / `verify-repository-menu.mjs` / `verify-timeline-follow.mjs` | 起真 Electron + Tailwind 验具体 UI 交互 | `node scripts/verify-xxx.mjs` |
| `verify-packaged-app.mjs` / `verify-preview-build-probe.mjs` / `verify-release-metadata.mjs` / `verify-renderer-preview-assets.mjs` | 打包产物 / 预览构建 / 发行元数据 / 产物完整性校验 | `node scripts/verify-*.mjs`（也有 `pnpm verify:*` 别名） |
| `runtime-baseline/{collect,compare,preflight,run-native,suite,verify,verify-native,archive}.mjs` | 缓存命中率基线采集/对比/离线复核 | 见 `scripts/runtime-baseline/README.md` |
| `runtime-smoke/electron-carrier.cjs` | 在真 Electron 里用 utilityProcess 跑 `p1-utility-worker.ts`，验 carrier 身份 | 由 P1-8 链路内部调用 |

（`afterPack.mjs`、`gen-icons.*`、`fetch-node-runtime.mjs`、`build-*.mjs`、`node-runtime-pin.mjs`、`packaging-budget.mjs`、`assert-*.mjs`、`generate-themes.ts`、`dev.js`、`dev-proxy-bypass.mjs`、`credential-env-keys.mjs`、`refresh-model-catalog.mjs`、`web-inspector.user.js` 是构建 / 打包 / 开发工具链，不属于现场点验。）

---

## 9. 子代理定义目录（DEV-3 用）

### 9.1 三个目录，别搞混

| 目录 | 绝对路径 | 角色 |
|---|---|---|
| **主目录（UI 写这里）** | `/home/ai/.pilab/jyw-ai-client-dev/pi-agent/subagents` | `SubagentCatalogService.directory()`，增删改都落这里 |
| **兼容根（只读）** | `/home/ai/.agents/subagents` | H/19 之前放这儿的定义仍能被看见 |
| **旧目录（只当导入源）** | `/home/ai/.pilab/jyw-ai-client-dev/pi-agent/agents` | **不参与实时扫描**，只在「导入」时读一次 |

> 任务书里写的「`<agentDir>/agents` 主目录」其实是第三方包 `@gotgenes/pi-subagents`（agent-host 侧旧系统）的约定。**ai-client 原生 runtime 用的是 `<agentDir>/subagents`**（没有 `agents` 中间层）。做 DEV-3 时按上表。

**磁盘现状：三个目录目前都不存在。** `~/.agents/` 存在但里面只有 `skills/` 和 `.skill-lock.json`。所以现在能看见的子代理全是内置定义（`BUILTIN_SUBAGENT_DOCUMENTS`，`src/shared/subagentBuiltins.ts`）。做 DEV-3 要自己 `mkdir -p` 造文件。

### 9.2 代码位置

- **Main 侧（GUI 设置页走这条）**：`src/main/services/agent-host/subagentCatalog.ts`
  - `:79-80` `directory()` = `join(this.deps.agentDir(), 'subagents')`
  - `:92` `roots()` = `[this.directory(), join(home, '.agents', 'subagents')]` —— 注释明说「兼容根读它的理由和 P5-1 仍读 `~/.agents/skills` 一样」
  - `:314` / `:354` `readLegacyDocuments(join(agentDir, 'agents'))` —— **只有导入路径才碰 `agents/`**；`:308` 注释「Only the GLOBAL directory is scanned，`.pi/agents` 不管」
  - `:236` / `:386` 写之前 `mkdir(this.directory(), { recursive: true })`
  - `:408` 文件名 = `join(this.directory(), '<name>.md')`
- **IPC 接线**：`src/main/ipc/piSubagents.ts:42-46`，`agentDir: () => getAppPiAgentDir()`；通道 `PI_SUBAGENTS_LIST`（`:129`）等；`PI_SUBAGENTS_REVEAL`（`:193`）不带 name 时**会先创建目录再打开**（`:199`）——这是「我该把定义放哪」的最快答案。
- **Runtime 侧（worker 自己也读一遍）**：`src/runtime/plugins/subagent/catalog.ts:84-89` `subagentRoots()`，同样是 `<agentDir>/subagents` + `~/.agents/subagents`，**不扫项目目录**（安全考量：仓库不能靠「被打开」往用户目录塞子代理）。

### 9.3 优先级 / 合并规则

- **目录顺序**：`<agentDir>/subagents` 在前，`~/.agents/subagents` 在后，同名先到者赢（`catalog.ts:78-89` 注释 "earlier wins a name clash"）。
- **用户 vs 内置**：`src/shared/subagentDefinition.ts:566-586`

  ```ts
  const ordered = [
    ...definitions.filter(d => d.source === 'user'),
    ...definitions.filter(d => d.source === 'builtin'),
  ];
  for (const definition of ordered) {
    if (byName.has(definition.name)) continue;          // 先到先得
    if (byName.size >= MAX_SUBAGENT_DEFINITIONS) { dropped.push(definition.name); continue; }
    byName.set(definition.name, definition);
  }
  ```
  即 `<agentDir>/subagents` > `~/.agents/subagents` > 内置；同名用户文档**整体覆盖**内置定义；**一次最多 16 条**（`MAX_SUBAGENT_DEFINITIONS`），超出的被丢弃并记诊断。

### 9.4 文件格式与最小模板

`.md` + frontmatter。**不是标准 YAML 解析器**，是仓库自写的简化解析：`src/shared/subagentDefinition.ts:253-307`（`splitFrontmatter`/`asScalar`/`asList`），入口 `parseSubagentDefinition`（`:316` 起）。

- key 归一化会抹掉大小写与 `-`/`_`/空格差异（`normalizeKey`，`:222-227`），所以 `max-turns` / `max_turns` / `maxTurns` 是同一个字段。
- 必填：`name`（缺省退回文件名 stem，小写+连字符化）、`description`
- `tools`：逗号或 `[a,b]` 列表，可选 `Read/Glob/Grep/BrowserPreview/Bash/Edit/Write`（大小写不敏感），**省略默认 `Read,Glob,Grep`（只读）**
- 模型 pin：`provider` + `model`，或一行 `model: <provider>/<id>`（`parseModelPin`，`:438-455`）
- 其它：`thinkingLevel`(off/low/medium/high)、`permission`(inherit/ask/accept-edits/auto)、`maxTurns`、`idleTimeout(Seconds)`、`maxDuration(Seconds)`（后两个仅为兼容旧文档解析，**不再驱动任何计时器**）
- frontmatter 之后的正文就是该子代理的 system prompt

DEV-3 用的最小模板（放 `~/.agents/subagents/dev3-probe.md`）：

```markdown
---
name: dev3-probe
description: DEV-3 兼容根删除语义验证用，别真派它干活。
tools: read, grep
permission: ask
maxTurns: 3
---
You are a throwaway probe subagent for checklist item DEV-3.
```

DEV-3 的判据是「编辑后删除，该行应消失而不是回到旧内容」——注意 `<agentDir>/subagents` 里**不要**放同名文件，否则你观察到的是覆盖而不是兼容根本身的行为。

---

## 10. 协议版本常量（DEV-4 用）

### ⚠️ 全仓只有**一处**定义，两侧共用

`/home/ai/code/ai-client/src/shared/types/workerRpc.ts:50`

```ts
export const WORKER_RPC_PROTOCOL_VERSION = 1 as const;
```

当前值 = **1**。

| 侧 | import 位置 | 出站打戳 | 入站校验 |
|---|---|---|---|
| **Main** | `src/main/services/agent-host/WorkerSlot.ts:5` | `WorkerSlot.ts:414-421` | `WorkerSlot.ts:517-529` |
| **Worker** | `src/agent-host/piWorkerRpcServer.ts:43`、`src/agent-host/worker.ts:12` | `piWorkerRpcServer.ts:998,1025,1036,1048`；`worker.ts:176` | `piWorkerRpcServer.ts:336-348` |

**两侧行为不对称**：

- Main 收到版本不对的消息 → **静默丢弃**，只发一个 `{ type: 'protocol-mismatch', generation, received }` 诊断事件，不抛异常、不杀进程。
- Worker 收到版本不对的请求 → **主动回错误响应** `{ code: 'WORKER_PROTOCOL_MISMATCH', message: 'Expected protocolVersion 1, got X', retryable: false }`。

**这对 DEV-4 的直接含义**：checklist 说「故意让打包产物里的 worker.js 与 Main 的常量不一致」。因为两侧从同一个常量 import，**不能靠改一处制造不匹配**——你必须：

- 要么改 `workerRpc.ts` 的值后**只重建其中一侧**（例如 `pnpm build:agent-host` 出 `out-agent-host/worker.js` 后再把常量改回来、让 Main 用旧值），
- 要么直接在已构建的 `out-agent-host/worker.js` 里文本替换那个字面量。

DEV-4 的预期结论（`main-host-08`）是「只有 `worker.bootstrap timed out`，无任何协议线索」——上表正好解释了原因：**Main 侧是静默丢弃**，worker 回的错误响应又对不上任何 pending 请求。

---

## 11. 附件限额（DEV-33 / DEV-34 用）

### 11.1 三层限额

**① 渲染层 Composer** —— `src/renderer/components/chat/attachmentLimits.ts`

| 常量 | 行 | 值 | 用途 |
|---|---|---|---|
| `DEFAULT_ATTACHMENT_LIMITS.maxCount` | `:41` | `5` | 单条消息最多 5 个附件 |
| `.maxImageBytes` | `:42` | `5 * 1024 * 1024`（**5 MiB**） | 单张图片原始字节上限 |
| `.maxTextBytes` | `:43` | `512 * 1024`（512 KiB） | 单个文本附件上限 |
| `.maxTotalBytes` | `:44` | `10 * 1024 * 1024`（10 MiB） | 一次发送全部附件总字节 |
| `MAX_IMAGE_EDGE_PX` | `:28` | `8000` | 图片单边像素上限（API 硬限制） |
| `LARGE_SINGLE_HINT_BYTES` / `LARGE_TOTAL_HINT_BYTES` | `:48-49` | 1 MiB / 2 MiB | **只做 UI 提示，不拦截** |

**② Main 读盘侧** —— `src/shared/types/attachmentIo.ts:36`

```ts
export const MAX_ATTACHMENT_READ_BYTES = 5 * 1024 * 1024;
```
`file:readAttachment`（选文件转 base64）时 Main 对单文件读取的硬顶，与渲染层 `maxImageBytes` 镜像（有单测断言两边一致）。消费点 `src/main/ipc/attachmentReadGuard.ts:37-41`。

**③ Runtime（agent-loop）侧** —— `src/runtime/plugins/agent-loop/attachments.ts`

| 常量 | 行 | 值 | 用途 |
|---|---|---|---|
| `ATTACHMENT_MAX_BYTES` | `:37` | `= MAX_ATTACHMENT_READ_BYTES`（5 MiB） | 服务端对单附件原始字节的最终硬顶（防篡改渲染层） |
| `ATTACHMENT_TURN_STORED_BYTES` | `:54` | `Math.floor(SESSION_MAX_BYTES / 4)` = **8 MiB** | 一次发送写进会话 JSONL 的总字节上限（按落盘字节） |
| `SESSION_MAX_BYTES` | `src/runtime/plugins/session/codec.ts:20` | `32 * 1024 * 1024`（**32 MiB**） | 单个会话 JSONL 文件总大小硬顶 = **会话预算** |

超限时抛 `RuntimeHostError('attachment_size_limit', ...)`（`attachments.ts:103-114`）。

### 11.2 Main 层 CHAT_SEND **没有**附件校验 —— 这就是 DEV-34 的靶子

- `src/main/ipc/chat.ts:503-534`（CHAT_SEND handler 本体）对 `payload.attachments` **不做任何长度 / 字节检查**，直接 `workerManager.send({ ...payload, ownerWebContentsId })`。
- `WorkerManager.send()`（`src/main/services/agent-host/WorkerManager.ts:1869-1901`）同样原样透传进 `WorkerSendPayload`，无校验。
- `attachments.ts:22-36` 的注释把这事写死了：*"the IPC hop carries `attachments` through preload, the chat handler and the worker bridge without a single byte check"*。

**校验只在两端**：渲染层 Composer（拦用户操作）与 runtime worker 的 `preparePrompt()`（写盘前硬顶）。**Main 是不设防的透传层。**

👉 DEV-34 的判据「Main 不拒绝、请求原样送达 worker」= 预期为**确认这个缺口存在**，复现代码见 4.2。
👉 DEV-33 的「或在 runtime 包内写构造用例」半边不需要起 Electron，按 3.2 节 checklist 的分批说明可以先做。

---

## 12. 注意事项（本次实测数据）

### 12.1 内存实测

| 时点 | total | used | free | **available** | swap used |
|---|---|---|---|---|---|
| 启动前 | 3350 | 1565 | 395 | **1785** | 1241 |
| CDP 刚可用（窗口已显示，未进主界面） | 3350 | 1850 | 184 | **1499** | 1396 |
| 进主界面后（工作区已加载） | 3350 | 1989 | 305 | **1361** | 1431 |
| 退出后 | 3350 | 1541 | 672 | **1808** | 1368 |

- **整套 dev 栈吃掉约 420～440 MB available**（其中 Electron 系进程 RSS 合计约 **400 MB**，electron-vite 的 node 进程另占约 250 MB）。
- 退出后 available 回到 1808 MB，**比启动前还高一点**（缓存回收），说明没有泄漏。
- **判据**：`free -m` 的 available **低于 ~500 MB 就别指望能点验**。刚跑完全量测试套件、或有没杀干净的旧 Electron 实例时，启动会慢到分钟级，而探测超时只有几秒 ⇒ 会读成「端口在听但永不回包」。这不是代理问题，是内存问题（2026-09-10 已定因：人为占住 950 MB 后重跑，CDP 从 10 秒退化到 37 秒、窗口从 1 秒退化到 42 秒）。

### 12.2 启动耗时实测

| 阶段 | 耗时 |
|---|---|
| 启动 → main 打包完 | ~16 s |
| → Vite dev server 就绪（5173 监听） | ~18 s |
| → CDP 端口 9333 开始监听 | ~45 s |
| → `Shared state paths`（Main 初始化完） | — |
| → `Showing main window`（窗口真显示） | 比上一行晚 **28.6 s** |
| **启动 → CDP `Runtime.evaluate` 实际返回结果** | **~103 s** |
| 点「使用本机已有配置」→ 主界面（rail + textarea 就绪） | **~12 s** |

**给探针留超时余量：启动到可控至少按 120 秒算，别按 30 秒。**

### 12.3 退出与残留检查（实测干净）

```bash
kill <dev.js 的 pid>       # 本次 kill 40488，SIGTERM 一发即可
sleep 6
ps -eo pid,ppid,args | grep -E 'dev\.js|electron-vite|dist/electron|esbuild' | grep -v grep
ss -ltn | grep -E '9333|5173'
```

本次结果：**进程全无、两个端口全部释放、内存归还**。dev.js 的 `shutdown()` 会遍历整棵进程树逐个 SIGTERM → 等 400 ms → SIGKILL（`dev.js:338-384`）。

**三条绝对禁令**：

1. **绝不 `kill -1` / `process.kill(-1, ...)`。** 这会灭掉整个登录会话 —— 2026-09-14 那三次「锁屏 / 窗口全关」的真凶就是某个测试拿假 pid `1` 调了 `process.kill(-1)`。进程组 kill 的测试必须 mock `process.kill`。
2. **绝不 `pkill -f "remote-debugging-port=9333"`。** 它会匹配到你自己那条 bash 命令行并自杀（退出码 144）。**这条已经在 2026-09-11 踩过两次**，因为把 pkill 写进了 Bash 工具的命令串里。要按特征杀，就遍历 `/proc/*/cmdline` 挑 cmdline 含 `ai-client` 的 electron 进程精确杀。
3. **绝不在 CDP 里 `node.remove()` 掉弹层。** React 的树会和真实 DOM 对不上，之后设置弹窗的 `open` 变 true 却什么都不渲染，只能重启应用。要让某块设置页重新挂载，去真点分类导航（`SettingsContent` 给内容区挂了 `key={activeCategory}`，换一个分类再换回来即可）。

### 12.4 本次跑出来的环境噪声（都是正常的，别当缺陷）

| 日志 | 判定 |
|---|---|
| `VMware: No 3D enabled (0, Success).` ×N | 正常，VM 无 3D |
| `vaInitialize failed: unknown libva error` | 正常，无硬件视频加速 |
| `[window] Showing main window via timeout fallback` | 正常，`ready-to-show` 在这台 VM 上基本永远赶不上 |
| `Error occurred in handler for 'app:getPath'` | **真缺口但已知**：preload 声明了 `app.getPath` 而 Main 没注册 handler（见 3.2） |
| `[workspace-tree] worktrees-absent { neverQueried: true }` ×N | 正常，本仓在这台机器上没有额外 worktree |
| `~/.pilab/.../sessions/` 下 8 个 stale `.writer.lock` | 正常，pid 全已不存在，会被自动接管（见 6.4） |

### 12.5 已知会咬人的其它坑

- `src/runtime` 是**独立 npm 子包**，依赖不随根 pnpm 装。报 `Cannot find package 'cordis'` 时去 `src/runtime/` 跑 `npm ci`。
- **grep 会静默跳过含裸 NUL 字节的 `.ts` 源文件**。得出「没人调用 X」这种结论前，换 `grep -a` 或 `rg --text` 复核一遍。
- **base-ui 的复选框在 `<label>` 里会变成 `<span>`**，测试里 `.click()` 不触发。勾选行别用 label 包 Checkbox。
- **展示模式（GUI/TUI）跨重启持久化**：上一轮停在 TUI，下次起来就没有 composer。而且 GUI/TUI 切换按钮要等工作区注册后才渲染，所以归一化只能放在工作区就绪之后。
