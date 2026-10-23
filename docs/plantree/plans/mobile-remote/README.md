# 手机远程使用对话（issue #25）

分支 `feat/mobile-remote`，从 main `8eaacf18` 开出。阶段清单见 [tasks.md](tasks.md)。

## 1. 需求（用户 2026-10-23）

- 很多台服务器上都在跑 PiLab；想直接在手机上连到这些服务器上的 PiLab，接着对话、看进度、批准权限，**不通过远程桌面**。
- issue #25 原调研（2026-10-18）只考虑了「一台电脑 + 同一局域网的手机」。现在是**一部手机对多台服务器**，而且手机多半不在服务器所在网络里，这一点改变了方案的重心：连通性和多机汇总变成头等问题。

## 2. 调研结论（2026-10-23，只读）

**没有能直接拿来用的现成方案。** 市面上成熟的开源方案都是给 Claude Code / Codex 命令行做的：它们自己起 agent 进程、读 CLI 自己的会话文件。PiLab 的会话在主进程手里，横跨两个引擎（DSH 宿主和 Claude Agent SDK 宿主），外部工具看不到也接不上。

**能借的是三样东西**：多机汇总的中继架构（Happy）、桌面进程里起手机服务加二维码配对的做法（Orca、CC Pocket）、手机端交互的成熟样子（三者都有权限批准、离线重发、推送）。

### 2.1 候选方案一览

| 方案 | 许可 | 结构 | 多台机器 | 不在同一网络时 | 能否直接用于 PiLab |
|---|---|---|---|---|---|
| [Happy](https://github.com/slopus/happy)（2.4 万星） | MIT | CLI 包装 agent → **中继服务器**（Fastify + Socket.IO + Postgres + Redis，可自建）→ 手机 App（Expo，iOS/Android/网页） | 支持，按「机器」分组 | 机器主动连中继，不开入站端口 | 不能直接用；但它的会话协议是通用的（见 2.2） |
| [CC Pocket](https://github.com/K9i-0/ccpocket)（1.1k 星） | MIT | 机器上跑 Bridge（Node，WebSocket :8765）→ Flutter 手机 App | 支持，保存多个主机 | 推荐 Tailscale；无中继 | 不能；Bridge 自己起 Claude/Codex 进程 |
| [Orca](https://github.com/stablyai/orca)（10 万星） | MIT | **Electron 桌面应用主进程里起手机 RPC 服务**（WebSocket :6768）+ 二维码配对（设备令牌 + 服务端公钥，端到端加密）+ 官方云中继；手机端 React Native，桌面还能直接托管手机网页包 | 支持 | 官方云中继（有区域调度） | 不能；但结构和我们最像，是主要参考 |
| [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui)（1.4 万星） | — | Node 网页服务，扫 `~/.claude` 等会话目录，响应式网页 | 每台一个网址 | 自己开端口或配隧道 | 不能；只认 CLI 的会话文件 |
| DSH 自带网页界面（`dsh web`） | MIT | DSH 宿主组合 `dsh-host-webserver` + `dsh-client-connection` + `dsh-api-gateway` + `dsh-web-frontend`；令牌换签名 cookie、断线重连、`trustedHosts` | 每台一个网址 | 只绑 127.0.0.1，需隧道或反代 | 不推荐，理由见 2.3 |
| Claude 官方 Remote Control / Codex remote-control | 闭源 | 官方 App 连本机 CLI | 支持 | 官方中继 | 不能；要 claude.ai / ChatGPT 订阅登录，我们走网关密钥 |

### 2.2 Happy 的会话协议值得细看

Happy 把手机端要渲染的东西压成了 9 种事件（`turn-start/turn-end`、`text`、`tool-call-start/end`、`file`、`service` 等），外面套一层端到端加密（AES-256-GCM，每会话/每机器一把数据密钥），共享 schema 发布在 npm `@slopus/happy-wire`。中继服务器看不到明文，只按「用户 / 会话 / 机器」三种房间转发，另有点对点 RPC（`rpc-register` / `rpc-call`）。

这意味着有一条「借壳」路线：在 PiLab 主进程里写一个 Happy 适配器，把我们的 `RuntimeEvent` 译成 Happy 事件、把 Happy 的 RPC 接到发消息/停止/批准权限上，再自建一台 happy-server，就能直接用 Happy 现成的 iOS/Android/网页 App。

**没验证、要先确认的**：官方 App 能不能改中继地址（不能就得自己打包 App）；我们特有的东西（提问卡、计划审阅卡、四档权限、目标/待办面板）在 Happy App 里没有对应界面，只能降级成文本或者丢失；协议还在演进（文档里写着新旧格式并存）。

### 2.3 为什么不直接用 DSH 自带网页界面

- 只看得到 DSH 引擎的会话，**Claude SDK 引擎的会话看不到**。
- 它接在 DSH 宿主那一层，绕过了主进程的会话归属、权限档位和计划审阅状态（#25 原调研已经指出不能接在这一层）。
- 和我们的桌面界面是两套 UI，手机上看到的不是 PiLab 的样子。
- 可取之处是它的连接层设计：一次性令牌换签名 cookie、Host/Origin 校验防 DNS 重绑、按 500ms～10s 抖动退避重连、心跳 Ping。自己做网关时照这些参数来。

### 2.4 连通性：手机怎么够到很多台服务器

| 做法 | 优点 | 缺点 |
|---|---|---|
| 组网：Tailscale，或自建控制面的 Headscale | 不用写代码；加密和穿透都由它负责 | 手机要常开 VPN；每台服务器都要装；多台服务器还得在手机端逐个添加地址 |
| 反向隧道：frp / Cloudflare Tunnel 到一台公网机 | 成熟 | 每台服务器一个入口，要管域名和证书 |
| **自建中继**（Happy、Orca 的做法） | 服务器主动连出去，不开入站端口；手机只连一个地址就能看到所有机器；端到端加密后中继看不到内容 | 要写和运维一台中继；我们已经有公网服务（onboarding），可以放在一起 |

## 3. 用户裁决（2026-10-23）

1. **连接**：手机直接用公网 IP 或网址访问；用户可以自己提供一台专门的服务器做中转。
2. **手机端范围**：基础的对话功能都要支持。
3. **统一进度**：手机上的对话和服务器上实际运行的那一端进度一致。
4. **越直接越好**（同日补充）：不想弄域名。一台有公网 IP 的服务器做中转，手机直接打开 `IP` 或 `IP:端口`，页面上就列出挂在上面的所有机器，选一个对话就能用。
5. **同一个服务两种用法**（同日补充）：部署在公网服务器上，手机用 `IP:端口` 像用一个应用一样打开；部署在本机，就在浏览器里打开 `127.0.0.1:端口` 使用。页面要同时适配手机和电脑浏览器。
6. **按对话接管**（同日补充）：同一个对话同一时间只能由一端操作，另一端只看进度；「接管」把操作权拿回来；停止两边都能按。取代下面 §4.1 里「两端同时操作按到达顺序排队」的说法。
7. **做成插件**（同日补充）：手机远程不打进主体安装包，做成可安装的插件；插件机制要有标准接口，以后别的额外功能按同一格式开发。方案见 [../plugin-system/](../plugin-system/README.md)：PiLab 里只留插件机制和对话接管，手机远程本身是插件 `pilab.remote-access`。

由此定下：不依赖 Tailscale 这类组网；不要求域名；中转是我们自己的轻量服务，用户自己部署；手机端只有中转这一个入口，不做每台机器各自直连；不借壳 Happy App（它的中继要 Postgres + Redis，而且我们特有的卡片在它的 App 里显示不了）。

## 4. 方案

**手机端做成网页（PWA），中继照 Happy 的思路做成轻量版，桌面端照 Orca 的做法在主进程里起服务。**

```text
手机浏览器  打开 https://公网IP 或 http://公网IP:端口，输入登录口令
   │
   ▼
中转服务器 pilab-relay（单个 Node 脚本，无数据库）
   ├─ 页面：机器列表 → 会话列表 → 对话
   └─ 按机器 id 把手机的帧转发给对应的 PiLab
   ▲  每台 PiLab 主动连出去（设置里填中转的 IP:端口 和接入口令；服务器不用开入站端口）
   │
PiLab 主进程「远程网关」── 和桌面窗口走同一套会话服务
```

### 4.1 统一进度：手机就是「又一个窗口」

现状已经有一大半：
- 主进程把运行事件广播给**所有窗口**（`src/main/ipc/chat.ts` `broadcastRuntimeEvent`），注释里写明了第二个窗口要能镜像同一个会话。
- 用户消息有权威回显（`message.started` 带 `role: 'user'`，`src/dsh-host/bridge/liveEvents.ts:1260`），所以从手机发的消息电脑上也会出现，反之亦然。
- 会话归属「跟着最近一次操作的那一端走」（`claimSessionForSender`），手机发消息就是手机驱动，电脑再发就回到电脑。

要补的：
- **中途连上**：已经弹出的权限请求和提问卡、正在进行的这一轮内容，新连上的一端看不到。主进程加「待处理交互缓存」和「当前轮次缓冲」，连上时先补发。
- **断线追赶**：手机网络不稳。每个事件带递增序号，重连时报上最后收到的序号，网关从缓冲里续传；缓冲不够就让手机重新加载这个会话的历史。
- **两端同时操作**：两边同时发消息时按到达主进程的顺序排队，和现在两个窗口的行为一致。草稿不同步。

阶段 1 落地后的情况（2026-10-23）：
- 对话处理函数改收「调用方」（`src/main/services/chat/chatCaller.ts`），窗口和远程客户端走同一套代码（`invokeChatHandler`），远程客户端用负数 owner id，断开时释放归属。
- `SessionLiveJournal`（`src/main/services/remoteAccess/`）从应用启动就记录：每个会话未答的权限和提问、上次停下以来的全部事件，以及跨会话按序号的日志（默认 5000 条），断线重连按序号补，丢了一段答 `gap`。
- 历史和实时事件能合并：DSH 历史行带 `liveMessageId`，就是实时事件里的消息 id（`src/shared/dshHistory` 的 `[D1-LIVEID]` 测试），先读历史再重放这一轮的事件不会重复。
- **缺口**：一轮进行中，续开（`resumeSession` 的 `session_busy`）和翻页（`loadHistoryPage` 的 `assertIdleEntry`）都会被拒，所以手机在别人正跑的时候点进去，拿不到这一轮之前的历史。阶段 2 第一件事是加一条只读、不抢归属、一轮进行中也能用的历史读法。

### 4.2 网页端功能（基础对话全支持，手机和电脑浏览器都能用）

机器列表 → 会话列表（按仓库分组）→ 对话：
- 时间线：用户消息、助手正文（Markdown、代码块）、思考（折叠）、工具卡片、子代理活动、用量
- 输入框：发送、排队、插话、停止、图片附件、切模型和强度、切权限档位
- 交互卡片：权限批准、提问卡、计划审阅
- 新建对话（选这台机器上已有的仓库）、重命名、归档
- **不做**：文件树、编辑器、终端、Git 面板（这些不属于对话本身）

实现上复用渲染层的纯前端部分（`runtimeEventBus`、对话 store、`MessageTimeline`/`ChatMarkdown`、`QuestionCard`、`PlanReviewCard`、`PendingPermissionDock`），另开一个 Vite 入口 `mobile.html`，底下用一个走 WebSocket 的 `electronAPI.chat` 垫片。

### 4.3 中转服务器 pilab-relay

- 一个打包好的 Node 脚本（另给 Docker 镜像），不用数据库。在公网服务器上 `node pilab-relay.js` 就能跑；第一次启动随机生成两个口令打印出来并存进本地配置文件：
  - **登录口令**：手机打开页面时输入一次，换成签名 cookie（照 DSH 的做法：30 天、`HttpOnly`、`SameSite=Strict`）。
  - **接入口令**：填进每台 PiLab 的设置里，PiLab 带着它主动连上来。
- 页面上的机器列表就是当前连着的 PiLab（主机名、在线状态、正在跑的会话数），点进去是那台机器的会话列表，再点进去是对话。
- 两个 WebSocket 入口：`/machine`（PiLab 连进来）、`/client`（手机连进来，指明要去哪台机器）；中转只把两边的帧对接起来。
- PiLab 设置里有一个「允许手机访问」总开关，随时可以断开；连着时设置页显示中转地址和状态。

### 4.4 HTTPS 由服务自己处理，用户不用管

用户只管打开地址，下面这些由服务启动时自动判断：

- **本机部署、用 `127.0.0.1:端口` 打开**：直接走 HTTP。浏览器把 127.0.0.1 当安全来源，功能不受限，也没有被窃听的风险。这时服务默认只监听 127.0.0.1，外面连不进来。
- **公网部署、用 `IP:端口` 打开**：明文 HTTP 在公网上会让登录口令和对话内容在路上被看到，口令被截走就等于别人能在所有挂着的机器上执行命令，所以自动走 HTTPS：
  1. 能开 80 或 443 端口时，自动申请 Let's Encrypt 的 IP 证书（2026-01-15 起正式签发，约 6 天有效，自动续期），打开没有任何警告。
  2. 开不了时用自签证书，手机第一次打开点一次「继续访问」。缺点是不能装成主屏应用、不能离线缓存。
  3. 明文 HTTP 只在显式加参数时允许（比如只在内网用），启动时打印警告。

### 4.5 安全

在手机上批准权限就等于在服务器上执行命令，所以：
- 登录限速，连续失败锁定一段时间；登录口令和接入口令分开，手机端拿不到接入口令。
- 手机端的批准、切档位等操作，PiLab 本机记日志。
- **信任放在中转服务器上**：拿到登录口令或攻破中转服务器，就能操作所有挂着的机器。这是「打开 IP 就看到所有机器」换来的代价；中转服务器是用户自己的，可以接受。以后如果要更严，再加「每台机器第一次被某部手机访问时要在电脑上点确认」。
- 暂不做端到端加密：页面本身就由中转服务器下发，它被攻破时端到端加密也挡不住被换掉的页面脚本。

## 5. 还没定的

- 手机上能不能切到最高的权限档位（完全放行）。默认先放开，和电脑上一致；不影响阶段 1、2。

## 6. 参考位置

- #25 原调研：主进程切入点 `src/main/ipc/chat.ts:76-118`，待处理提示缺失 `src/dsh-host/bridge/panels.ts:14-17`，关窗即退 `src/main/index.ts:908`。
- Happy：`docs/encryption.md`、`docs/session-protocol.md`、`docs/realtime-sync-and-rpc.md`、`docs/deployment.md`。
- Orca：`mobile/README.md`、`src/main/ipc/mobile.ts`、`src/main/runtime/{device-registry,e2ee-keypair,mobile-pairing-qr}.ts`、`src/main/runtime/mobile-cloud-relay/`。
- CC Pocket：根 README「Remote Access」、`packages/bridge/README.md`。
- DSH：`src/dsh-host/node_modules/@deepseek-ai/{dsh-host-webserver,dsh-client-connection,dsh-api-gateway}/README.zh.md`。
