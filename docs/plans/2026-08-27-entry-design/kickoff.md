# 立项 — 应用入口与环境依赖（登录页改造 · 环境检查退役 · 凭据模式）

> 2026-08-27 立项。触发：用户在 S2 收口后提出三件事 ——
> ① 判断「启动时的环境检查已经没必要了，因为 node/claude/codex 都随包了，git 可能要单独处理」；
> ② 想把启动首屏改成 Cursor 那种两按钮登录页（自研光效 logo）；
> ③ 要求「登录」这条路**不影响用户本地环境**，密钥只进我们的目录、以注入方式启动。
>
> 本档是**讨论收口**，不是施工规格。当前状态看
> [plantree/plans/entry-and-environment](../../plantree/plans/entry-and-environment/README.md)。
> 本轮**未改动任何产品代码**。

## 结论摘要（≤8 行）

1. 用户对「三样都随包」的判断**成立**，且 `ClaudeRuntimeChecker` 已在 2026-08-26 按这个方向改过一半。
2. 但**门禁没跟着退役**：`resolveGateDecision` 仍会因为一个**独立的、探测系统 `claude` 的**信号把人踢回 onboarding。这是债。
3. **git 不能一起删** —— 本产品是 worktree 管理器，git 是真依赖；且自动安装能力**只有 Windows 有**。
4. 登录页形态可行，但「直接进入」这个按钮**背后需要一个今天不存在的本机可用性探测**，否则是假承诺。
5. 该探测的前置是 `settingSources: []` 那条 —— 今天我们**主动屏蔽了**用户自己的 `settings.json`。
6. 第 ③ 条**Claude 侧已经做完了**（S0' `77ff5dd4`），codex 侧未做，且默认开关未翻（S3）。
7. `--settings` 的判断要修正：随包 cli.js **确实支持**，但我们**不该用**，现有的 env 通路更干净。
8. 两按钮会把「用哪套凭据」从**构建期开关**变成**运行期状态** —— 这是个新概念，会改写 S3 的形状。

---

## §1 已核实的事实

以下每条都对着仓里的代码核过，不是印象。

### 1.1 三样确实随包

| 组件 | 实际来源 | 证据 |
|---|---|---|
| claude | `@cometix/claude-code` 2.1.212（Node 版 Claude Code 构建） | `src/agent-host/package.json` 依赖；`cometix.ts` 从 Host 的 `node_modules` 解析 `cli.js`，交给 Agent SDK 当 `pathToClaudeCodeExecutable` |
| codex | `@openai/codex` 0.149.1 随包原生二进制 | 同上；打包链见 stage-4 |
| node | `resources/node-runtime` | `NodeRuntimeResolver`：候选顺序 = 显式指定 → 环境变量 → **随包** → nvm/fnm/volta/PATH |

⇒ **用户机器上有没有 `claude` / `codex` / `node`，与对话能不能跑无关。**

### 1.2 这个方向代码里已经走了一半

`ClaudeRuntimeChecker.detect()`（2026-08-26 改）**第一件事**就是看随包的 cometix `cli.js` 在不在，
在就直接判 `installed`，后面整条老探测链根本不走。原注释：

> 用户全局装的 `claude` 从来就不在这条路径上，拿 `claude --version` 卡整个应用，
> 是在问一个答案根本不重要的问题：一个包好好的人，被赶去装一个永远不会被运行的 CLI。

### 1.3 ⚠️ 但门禁还有一条没退役的旧信号（债）

`resolveGateDecision`（`src/shared/authGate.ts`）判「CLI 缺失」用的是**两个来源的或**：

```
cliMissing = runtimeStatus.kind === 'not-installed'          ← 已按 1.2 修好
          || (cliStatus !== null && !cliStatus.claudeInstalled)  ← 没修
```

后者来自 `CliDetector.detectOne('claude')`，跑的是**系统 PATH 上的 `claude --version`**。
⇒ **今天仍存在这条路径：随包一切正常，却因为系统没装 claude 被拦在 onboarding。**

### 1.4 git 是真依赖，且处置不完整

- 本产品是 git worktree 管理器，git 不是可选项 ⇒ **检查要保留，只能换位置**。
- `AgentInstaller` 的自动安装能力**只在 Windows 上存在**（`ensureWindowsOnly` 守着，非 Windows 直接抛错）。
  ⇒ mac / Linux 用户缺 git 时，我们今天只能检测出来、装不了，也没有明确的降级文案。

### 1.5 系统 `claude` 还有一个真用途：应用内终端

用户在我们应用的终端里敲 `claude`，跑的是**他系统上的那个**，不是随包的。
⇒ 「系统有没有 claude」这个信息不是完全无用，只是**与对话无关**。清理探测时别把这层一起清了。

### 1.6 ⚠️ `settingSources: []` 屏蔽了用户自己的 settings.json

`claudeRuntime.ts` 给 SDK 传 `settingSources: []`。SDK 类型文件原文：

> `Pass [] to disable filesystem settings (SDK isolation mode). Must include 'project' to load CLAUDE.md files.`

⇒ **用户自己配在 `~/.claude/settings.json` 里的 url / key，在我们的对话里根本不生效。**
当初这么设有真实理由（防止用户 settings 里的 `permissions.allow` 阴影掉我们的权限卡），
但它直接决定「使用本机已有配置」这个按钮能不能兑现承诺。
已登记在 [unified-credentials open-q #6](../../plantree/plans/unified-credentials/open-questions.md)。

### 1.7 第 ③ 条（不影响本地环境）Claude 侧已经做完

S0' Claude 侧（`77ff5dd4`）落地的正是用户描述的形态：

- 密钥存 vault（S2 后在 `~/.pilab/<profile>/credentials/vault.json`）
- 每次起 Host 从 vault 读 → `AICLIENT_CLAUDE_BASE_URL` / `AICLIENT_CLAUDE_AUTH_TOKEN` 两个私有 env 键
  → Host 侧翻成 `ANTHROPIC_*` 放进子进程 env
- **不写用户任何文件**；关掉软件后用户用官方 CLI 就是他自己的环境
- 唯一还写的用户文件：`~/.claude.json` 的 onboarding + trust 两键，**merge**（用户已有键恒赢）

**两个「还没有」**：codex 侧未施工（S0' 另一半）· 默认开关未翻（S3）。
flag 关着时登录**会**写 `~/.claude/settings.json` 与 `~/.codex/*` ——
⇒ 「不影响本地环境」要真正成立，**S3 必须落**。

### 1.8 `--settings` 判断修正

随包 cli.js **确实支持** `--settings`（二进制里可查到该 flag）。但**不该用**：

- 我们不直接起 CLI，走 Agent SDK；SDK 收的是 `options.env`，凭据经环境变量进去
  ⇒ 没有文件就没有「这文件还会被谁读到」的问题，也没有落盘残留。
- `--settings` 本质是「再造一个 settings 文件」，而
  [D60](../openchamber-chat-refactor-ledger.md) 判定的正是：
  **因为凭据经文件传递，才不得不控制目录；一控制目录就顺带劫持了整棵配置树。**
- codex 侧同理：我们用 `-c`，能力边界已由 [E1](../2026-08-26-s0-spikes/e1-codex-no-home.md) /
  [E2](../2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md) 测清。

⇒ **这条不需要新机制，现有形态比 `--settings` 更好。**

---

## §2 登录页设计参照

用户提供的参照图：[`login-page-reference.png`](./login-page-reference.png)（Cursor 的登录页，
原图由用户放在仓库根的 `sharePic/`，此处留一份**随档副本**以免引用失效）。

**图里的结构**（文字描述，图若丢失仍可施工）：

- 全屏单栏、**垂直居中**、极简。背景近白，带极淡的暖色渐晕（不是纯色块）。
- 顶部只有系统窗口控制（最小化 / 最大化 / 关闭），**无标题栏内容、无菜单、无返回**。
- 视觉重心自上而下四段，间距很松：
  1. **Logo**（约占宽度 1/8，等轴测立方体，表面有流动的彩色光带 —— 用户想要的「光效流动」指的就是这个质感）
  2. **产品名**，全大写、重字重、字距略放开
  3. **一句话标语**，常规字重，明显小于产品名
  4. **两个等宽按钮，纵向堆叠、紧挨着**：主按钮实心强调色（`Log In`）、次按钮浅灰底（`Sign Up`）
- 按钮宽度约为窗口宽度的 1/5，圆角中等，**没有第三个入口、没有「跳过」链接**。

**我们与参照的差异（必须明确，不能照抄）**：

| 项 | Cursor | 我们 |
|---|---|---|
| 第二个按钮 | `Sign Up`（注册） | **「使用本机已有配置」** —— 语义完全不同，见 [open-q #1](../../plantree/plans/entry-and-environment/open-questions.md) |
| 第二按钮可用性 | 恒可用 | **取决于本机探测结果**，探不到应置灰并说明缺什么 |
| 登录方式 | 账号体系 | 工作邮箱 + 验证码（沿用现有 `verifyAndRegister` 通路） |

**实现层面两条硬提醒**：

- 现在的 onboarding 是**四步状态机**（`cli-check → cli-install → register-email → register-code → result`）。
  改成两按钮首屏**不是换皮，是把 `resolveGateDecision` 重画**。
  好消息：它是纯函数、有完整单测，重画可控。
- 打包链有 `assert-no-webfonts.mjs` 这道闸 ⇒ **logo 与字体不得引外部资源**；
  圆角 / 阴影 / 字号 / 动画时长走 [`docs/design-system.md`](../../design-system.md) 的 Token 分档，避免任意值。

---

## §3 三条待拍板

详见 [open-questions](../../plantree/plans/entry-and-environment/open-questions.md)，此处只列题目：

1. **「使用本机已有配置」这个按钮的语义与可用性判据** —— 探测到什么程度才算「可用」？
2. **「用哪套凭据」从构建期开关变成运行期状态** —— 存哪、能不能中途切、与 S3 的关系。
3. **环境检查的去留与摆放** —— agent 探测退役到什么程度，git 检查搬到哪里，非 Windows 缺 git 怎么处置。

---

## §4 依赖链

```
settingSources 决策（unified-credentials open-q #6）──┐
                                                       ├──► 「使用本机配置」按钮的真探测
S0' codex 侧（unified-credentials，前置已清）─────────┘              │
        │                                                             │
        └──► S3 翻开关 ──► 「登录」不碰本地环境 ────────────► 两按钮登录页
                    │                                                 │
      「凭据模式」从开关变运行期状态（本 plan 待拍板 #2）─────────────┘
```

**读法**：登录页是**最后一步，不是第一步**。它下面压着三件事 —— codex 侧收口、翻开关、`settingSources` 决策。
其中 `settingSources` 今天**只登记未立项**，而它直接决定第二个按钮能不能兑现承诺。

**建议顺序**：S0' codex 侧（前置已清，可开工）→ `settingSources` 单独立项取证 → S3 → 登录页。

---

## §5 不在本批范围

- **远端** —— 用户明确本轮不考虑。
- 品牌口径统一（现在是**五个**名字，见 [unified-credentials open-q #4](../../plantree/plans/unified-credentials/open-questions.md)）。
- 登录/注册的**服务端**协议改动。
