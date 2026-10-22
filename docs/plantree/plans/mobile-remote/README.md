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

## 3. 建议

**做我们自己的手机端，中继和协议抄 Happy，桌面端结构抄 Orca。**

1. **主进程网关**（#25 原方案 A 不变）：把 `chat.ts` 的处理逻辑抽成和窗口无关的函数；主进程加待处理交互缓存和当前轮次补发缓存。这一步无论最后选哪条路都要做。
2. **连接方式分两档**：
   - 第一档：网关只绑 127.0.0.1，用户自己用 Tailscale / 反代访问。先跑通，验证手机端好不好用。
   - 第二档：每台 PiLab 主动连自建中继，手机连中继看到所有机器。中继协议照 Happy 的「用户 / 机器 / 会话」房间加点对点 RPC，内容端到端加密。
3. **手机端用网页（PWA）**，不做原生 App：复用渲染层的时间线、Markdown、提问卡、计划卡、权限停靠卡；PWA 可以加到主屏、收 Web Push。原生 App 要上架、要另一套技术栈（Expo / Flutter），对内部工具不划算。
4. **借壳 Happy App 作为备选**：如果确认官方 App 能改中继地址，可以先写适配器快速用上；代价是我们特有的卡片在手机上缺失。

## 4. 要用户先定的事

1. 服务器和手机之间的网络：服务器能不能主动连到一台公网机？手机平时能不能开 Tailscale 这类 VPN？——决定先做第一档还是直接做中继。
2. 手机端要做到哪：只看进度 + 批准 + 回复，还是也要新建对话、切模型、看文件/改动？
3. 手机上能不能批准权限、能不能改权限档位（#25 原建议：能批准，档位只在电脑上改）。
4. 走自己的 PWA，还是先试借壳 Happy App。

## 5. 参考位置

- #25 原调研：主进程切入点 `src/main/ipc/chat.ts:76-118`，待处理提示缺失 `src/dsh-host/bridge/panels.ts:14-17`，关窗即退 `src/main/index.ts:908`。
- Happy：`docs/encryption.md`、`docs/session-protocol.md`、`docs/realtime-sync-and-rpc.md`、`docs/deployment.md`。
- Orca：`mobile/README.md`、`src/main/ipc/mobile.ts`、`src/main/runtime/{device-registry,e2ee-keypair,mobile-pairing-qr}.ts`、`src/main/runtime/mobile-cloud-relay/`。
- CC Pocket：根 README「Remote Access」、`packages/bridge/README.md`。
- DSH：`src/dsh-host/node_modules/@deepseek-ai/{dsh-host-webserver,dsh-client-connection,dsh-api-gateway}/README.zh.md`。
