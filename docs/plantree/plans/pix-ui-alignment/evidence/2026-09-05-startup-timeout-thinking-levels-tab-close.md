# Evidence — 批次 9：启动 resume 超时、思考强度越界、关 Tab 语义

**日期**：2026-09-05
**分支**：`feat/pi-primary-backend`
**切片**：三件用户报障，两件缺陷 + 一次语义变更
**决策**：[D09](../decisions/009-tab-close-ends-conversation.md)（第三件）

用户给了两张截图（`/home/ai/code/test/20260905/`），前两件的原始报错逐字如下。

---

## 一、启动时 `chat:resumeSession` 十秒超时

### 报错原文

```
Error: Error invoking remote method 'chat:resumeSession': WorkerSlotError:
Worker request worker.bootstrap timed out after 10000ms
```

界面上它出现在两个地方：会话上方一条红条，以及 Composer 底栏挤成一行的省略号文本
（`useResumeSession` 把它同时写进 `lastError` 和 `historyErrors[sessionId]`）。

### 成因

`createPiWorkerSlot` 发 `worker.bootstrap` 时没有传超时，于是吃 `WorkerSlot` 的
`DEFAULT_REQUEST_TIMEOUT_MS = 10_000`——那是给**已经起来的进程**回答请求用的预算。
而 bootstrap 是冷启动本身，一次性成本全在里面：

- `utilityProcess.fork` 起一个新进程；
- 加载 agent-host 模块图（dev 下入口是 `worker.ts`，走 `--experimental-strip-types`
  逐模块剥类型；打包后才是 bundle 过的 `worker.js`）；
- `preflightPiSessionFile` + `SessionManager.open` 读并解析整个会话文件；
- `createAgentSessionServices` 加载 pi 的扩展、校验权限插件、绑定审批 UI。

本机实测（`out-node-runtime/node`，热文件缓存）：只 import `piWorkerRpcServer.ts`
就要 1.0s，而上面四步都在这 10s 里排队。所以它不是「坏了」，是**预算按错了对象**——
慢一点但健康的冷启动，和一个真卡死的 worker，用的是同一条线。

### 改法

`createPiWorkerSlot.ts` 给 bootstrap 单开预算 `BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000`，
暖 RPC 继续用 `requestTimeoutMs`。取舍写在常量的注释里：一个真卡住的 worker 仍然会失败，
只是晚 50 秒；而把一个健康会话卡死在 10 秒线上，用户是没有退路的（界面不给重试入口，
只能自己再点一次）。

### 验证到哪一步（诚实说明）

- **单测覆盖**：`createPiWorkerSlot.test.ts` 新增一例，显式传入 `requestTimeoutMs: 10_000`，
  推进 10s 后请求仍在飞，到 60s 才以 `worker.bootstrap timed out after 60000ms` 失败。
  断言直接写用户看到的那句话。
- **未复现原始现场**：这次没在真机上重现 10s 超时——2026-09-05 02:15 的一次冷启动
  （`no_proxy` 已设）在 1.7s 内就把会话拉起来了。**这条缺陷是按代码路径判定的，
  不是按复现判定的**，所以「修好了」的证据是那条单测，不是一次成功的启动。

---

## 二、思考强度选了 Minimal，供应商直接 502

### 报错原文

```
Network retry 3/3 — the turn is still running
Next attempt in 8s · OpenAI API error (502): {"message":"host_call_failed:
level \"minimal\" not supported, valid levels: low, medium, high, xhigh, max",
"type":"server_error","code":"internal_server_error"}
```

模型是 GPT-5.6 Terra，档位是 Minimal。注意 pi 把这个 502 当网络抖动重试了三次——
错误本身是永久的，重试一次都不会成功。

### 成因：三层，一层比一层深

1. **数据层**：`~/.pilab/t37c-agent/models.json` 里 cx2 / maxapi 的每个模型都只写了
   `reasoning: true`，**没有 `thinkingLevelMap`**。这不是特例，是手写 models.json 的常态。
2. **pi 的规则**：`getSupportedThinkingLevels`（pi-ai `dist/models.js:547`）对无 map 的
   reasoning 模型返回 `off/minimal/low/medium/high`——它**假定 off 与 minimal 处处可用**，
   只对 `xhigh`/`max` 要求显式声明。所以 `setThinkingLevel('minimal')` 的 clamp 不会拦，
   `minimal` 原样发到上游。
3. **本仓的规则更松**：`effortsForModel` 里「有 `reasoning` 但没有 map」直接
   `return CHAT_EFFORTS`，七档全给——连 pi 自己都要求声明的 `xhigh`/`max` 也给了。
   那两档的表现是另一种谎：pi 会静默 clamp 成 `high`，界面却一直显示 `xhigh`。

而用户这套代理（`cx2api.pipidan.qzz.io`）自己报出来的合法档位是
`low, medium, high, xhigh, max`——恰好**不含** `off` 与 `minimal`。

### 改法（用户拍板：没声明就只给 low/medium/high）

`efforts.ts` 换成一条规则：`low/medium/high` 是任何 reasoning 模型的默认三档；
`off` / `minimal` / `xhigh` / `max` 四个极端档**必须在 `thinkingLevelMap` 里被点名**
（映射到 `null` 则一律剔除，包括那三档）。这比 pi 自己的规则更严，理由就是上面那个 502：
没人声明过的档位是猜的，而猜错的代价是一整轮对话失败。

配套改了 `reconcileEffortForModel`：模型为 `undefined`（目录还没加载完，或是用户手输的
未验证模型）时**保留**已存档位。它的返回值会被写回 session 与 agent 模板两个存储，
把「还不知道」当成「不支持」，就会在目录到达前的那几帧里把用户合法的 `xhigh` 抹掉。

### 验证

- 单测：`efforts.test.ts` 新增两例（无 map 的 reasoning 模型只出三档且 `minimal`/`off`/`xhigh`
  都被 reconcile 掉；未知模型保留已存档位），并改写两例原有断言。
- **真机**：重启后 Composer 触发器不再显示 `Minimal`（持久化的 `minimal` 被 reconcile 成
  Default），下拉里只有 `Default / Low / Medium / High`。

### 顺带查明、本轮没动的事

- **管理后端拉取是做了的**，但只在**托管凭据模式**下跑：
  `managedCredentialsStartup.regenerateFromVault()`（启动 phase ③）调
  `syncManagedPiModels()`，另有 onboarding 与 `piModels` IPC 两处 force sync。
  本机点验用的是本地模式（`dev.env` 里 `AICLIENT_MANAGED_CREDENTIALS=0`），
  读的是 `PI_CODING_AGENT_DIR` 下的 models.json，**按设计不联网**。
- 因此若把 `thinkingLevelMap` 写进管理后端下发的目录，托管用户开机即可拿到准确档位；
  本地模式用户仍得自己写。`model-admin/models-config.json` 目前是指向 `127.0.0.1:4000`
  的样例数据，本轮没碰。

---

## 三、关闭中栏 Tab = 结束对话

见 [D09](../decisions/009-tab-close-ends-conversation.md)。改前 X 只是把 Tab 从条上摘掉，
worker 继续活着并占着 `WorkerManager` 有上限的 slot。

### 落点

| 层 | 文件 | 改动 |
|---|---|---|
| shell | **新增** `closeSessionTab.ts` | `endSessionForTab`：调 `chat.closeSession`，复位 `hostBoundSessionIds` / `messages` / `historyErrors` / 分页 / 分支版本号，状态置 `disconnected`，**不动左栏那一行** |
| shell | `SessionTabs.tsx` | X 改为开 `AlertDialog`；确认分支才 `closeTab` + `endSessionForTab` |
| shell | `sessionTabsModel.ts` / `stores/sessionTabs.ts` | 注释改口径：纯模型仍不碰会话，断开运行时是上面那一层 |
| shared | `i18n.ts` | 5 个新键（标题 / 正文 / 运行中警告 / 保留说明 / 确认按钮） |

### 真机验证（CDP，真实会话数据）

| 观测点 | 结果 |
|---|---|
| 点 X | 弹出「结束这个对话？」，两个按钮「取消 / 结束对话」 |
| 确认后 Tab | `["Live Agent Host","/clear"]` → `["Live Agent Host"]` |
| 确认后左栏行数 | 78 → **78**（一行没少） |
| 确认后 store | `inSessions: true`，`status: disconnected`，`hostBound: false`，`messages: 0` |
| worker 进程 | 打开会话时新增 `node.mojom.NodeService` pid `68623` / `68656`，确认关闭 8s 后两个都不在了 |

（进程这一条是逐个读 `/proc/*/cmdline` 数的；第一版探针的 grep 匹配到了自己那条命令行，
数出来的 0 是假的，换成按 `utility-sub-type=node.mojom.NodeService` 精确匹配后才是上表的数。）

---

## 四、门禁

| 项 | 结果 |
|---|---|
| 全仓 Vitest（`--maxWorkers=1 --no-file-parallelism`） | **269 files / 4145 tests pass** |
| `tsc --noEmit` | pass |
| `biome check src/` | 干净 |
| `git diff --check` | 干净 |

顺带修了一处**测试自身的盲点**：`deadControlsStatic.test.ts` 的「按钮必须有点击语义」扫描
只认「按钮自己带 `render=`」，不认「按钮**是**某个 `render=` 的值」。
后者正是 `<AlertDialogClose render={<Button>取消</Button>} />` 这个仓库既有写法
（`WorktreePanel.tsx` 一直这么写，只是不在被扫描的目录里）。扫描改为两侧都认，
且只豁免 render 表达式的**直接元素**——藏在包装标记深处的按钮仍要自己交代。
