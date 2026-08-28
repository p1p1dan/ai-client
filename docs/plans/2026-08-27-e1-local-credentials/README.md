# 取证 — E1「使用本机已有配置」到底能探到什么

> [entry-and-environment E1](../../plantree/plans/entry-and-environment/roadmap.md) 的取证。
> 前置是 [settingSources 取证](../2026-08-27-settingsources-spike/README.md)（D67）：
> 用户自己配的 url 与密钥现在**在我们软件里是真的生效的**，所以这个探测现在才有意义。
> 只做实验，**未改动 `src/` 下任何产品代码**。
> 离线成立：所有出向请求都打到本机 `127.0.0.1` 的假端点，零外网。

## ⚠️ 读前必看 — 本档的角色在落档当日就变了

**2026-08-27，本档的产品建议被 [D68](../openchamber-chat-refactor-ledger.md) 整体推翻。**
用户拍板**两条路线彻底分开**：走登录 = 注入公司 url+key；走第二个按钮 = **零注入的原始形态**，
**不做任何探测、不置灰、无说明文字**，能不能用与坏了怎么办**全部归用户**（原话「用户选了自己会去解决」「炸了就炸了」）。

⇒ **§4 的探测口径、§5 的两张票在第二条路上的部分，全部作废。**
⇒ 本档**保留**，角色从「设计输入」变成 **「为什么不该做这个探测」的实证依据** ——
下一个想做本机可用性探测的人应该先读 §4 ①②④，那三条就是不做的理由。
⇒ **仍然有效的两处**：§5 两张票**在登录那条路上**（公司 key 被拒时同样是「请登录」+ 约 180 秒，
而那条路的可用性是我们承诺的 —— 记为 T-E1a，低优先级）；
§6 的事实已由 [D69](../openchamber-chat-refactor-ledger.md) 拍板「都读，维持原状」。

---

## 一句话结论

**「本机已有配置能不能用」这个问题，静态探测答不准。**
本档原本的建议是「那就报『找到了什么』，并把失败面修好」；
**D68 走得更远：连报都不报**（见上方读前必看）。下面的实测数据是这两种走法共同的依据。

## 结论（≤12 行）

1. **凭据来源比预想多，而且两个 agent 完全不同构。**
   Claude 有五路（OAuth 文件 / 用户 settings 的 `env` / 项目 settings 的 `env` / 进程环境变量 / `apiKeyHelper` 脚本），每一路单独就够用（L1~L5）。
2. **⚠️ 项目级 `.claude/settings.json` 的 `env` 也能供凭据（L5）** —— 这是 D67 打开三层之后的新后果，
   settingSources 那轮量的是权限/hooks/CLAUDE.md，**没量过凭据**。一个 clone 来的仓库可以把我们的对话指到它自己的网关。见 §6 待拍板。
3. **Claude 侧没有单一优先级链，是两个「头槽位」**：`authorization` 与 `x-api-key` 各自被不同来源填（L7 两个槽位同时被不同来源填满）。
   已测到的一条压制关系：**用户 settings 的 `ANTHROPIC_AUTH_TOKEN` 压过 OAuth 文件**（L6）。
4. **Codex 侧的「有没有凭据」不能只看文件在不在** —— `auth.json` 只在当前 provider **声明要它**时才被读
   （`requires_openai_auth = true`：X6 读了 / X1 同一份文件没读）。判断必须先解析 `config.toml` 里的 `model_provider`。
5. **`config.toml` 的 `env_key` 指到一个没设的变量时，不会回落到 `auth.json`**（X5）—— 直接失败，且错误话说得很清楚。
6. **⚠️ 两个 agent 的「没凭据」行为方向相反**：
   Claude **发请求之前**就失败，一句 `Not logged in · Please run /login`（L0）；
   Codex **照发不误**，一个 auth 头都不带（X8），让服务器去拒。
7. **⚠️ Claude 的失败话术分不清「没登录」和「钥匙被拒」** —— 两种情况**同一句** `Not logged in · Please run /login`（L0 vs L10）。
   能分辨的是 `api_error_status`（`-` vs `401`），而这个字段**被我们的 normalizer 丢掉了**。⇒ 施工票 ①。
8. **⚠️ 而且慢**：钥匙被拒时 Claude 要重试 **8~11 发、约 3 分钟**才终止（L10 计时）；同样场景 Codex 约 **6.5 秒**（X13）。
   ⇒ 用户点了第二个按钮、发第一条消息，**卡三分钟再看到一句误导性的「请登录」**。⇒ 施工票 ②。
9. **静态「有」不等于能用**：过期 OAuth（L8）、坏 JSON（L9）、`env_key` 落空（X5）都是「文件在、跑不了」。
10. **静态「无」更不等于不能用**：`apiKeyHelper`（L4）、进程环境变量（L3）、项目层（L5，登录页那一刻还没有工作区）都可能在探测视野之外。
11. ⇒ **探测只能报「找到了什么」，不能报「能不能用」**。文案口径见 §4。
12. 三处 **[未测]** 见 §7，其中最要紧的是 **ChatGPT 登录（`auth.json` 的 tokens 形状）—— 离线构造不出**，不能拿本轮结果当它的答案。

## 环境 / 版本

- SDK：随包 `@anthropic-ai/claude-agent-sdk` **0.3.218**
- Claude CLI：随包 `@cometix/claude-code` **2.1.212**
- Codex：随包原生二进制 **0.149.1**（`@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`），
  按生产形态起 `node <@openai/codex/bin/codex.js> app-server`
- Node：**24.18.0**（`out-node-runtime/node`）—— 与上一轮同一条纪律，系统 Node 22 跑不动随包 cli.js

⚠️ 两条环境前提照抄上一轮取证，不再复述理由：**必须 Node 24**、**必须设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`**。

## 手法（为什么这些数字可信）

每个凭据来源在夹具里写一个**互不相同的哨兵值**，provider 的 base_url 指向本机假端点，
假端点把每一发请求的 `authorization` / `x-api-key` 头记下来。
于是「**这一发请求带着谁的凭据**」不是推断，是从头里直接读出来的；一发都没发 = 这一路不成立。

`base_url` 每一臂都设，是为了让各臂可比 —— **它本身不提供凭据**，L0 就是钉住这一点的对照臂
（只有 base_url、没有任何凭据 ⇒ 一发都没发）。

---

## L 组 — Claude 侧:随包 CLI 自己能从哪里拿到凭据

`settingSources: ['user','project','local']`（生产同款），我们**不注入任何东西**，模拟 `credentialMode: 'local'`。

| # | 夹具里只有 | 发请求了吗 | `authorization` | `x-api-key` |
|---|---|---|---|---|
| **L0** | 只有 base_url（**对照**） | **否** | — | — |
| L1 | `~/.claude/.credentials.json`（订阅 OAuth） | 是 | **OAuth** | (none) |
| L2 | `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` | 是 | **用户 settings** | (none) |
| L3 | 进程环境变量 `ANTHROPIC_API_KEY` | 是 | (none) | **进程 env** |
| L4 | `apiKeyHelper`（settings 指向一个脚本） | 是 | **helper** | **helper** |
| **L5** | **项目级** `.claude/settings.json` 的 `env` | 是 | **项目 settings** | (none) |
| L6 | OAuth **+** 用户 settings env | 是 | **用户 settings**（OAuth 被压过） | (none) |
| L7 | 用户 settings env **+** 进程 env | 是 | **用户 settings** | **进程 env** |

**L0 是全组的地基**：没有它，「L1 发了请求」只能说明「有东西被发出去了」，不能说明是那份 OAuth 起的作用。

**L7 值得单说**：两个槽位**同时**被两个不同来源填满，一发请求上带着**两份不同的凭据**。
所以 Claude 侧不存在一条「谁压过谁」的总链 —— 是 `ANTHROPIC_AUTH_TOKEN` 一路走 `authorization`、
`ANTHROPIC_API_KEY` 一路走 `x-api-key`，两条各自解析。**L6 才是真正的压制关系**，且只在 `authorization` 这一个槽位里成立。

### L 组续 — 「文件在」不等于「能用」

| # | 夹具 | 发请求了吗 | CLI 自己怎么说 |
|---|---|---|---|
| L8 | `.credentials.json` 在，但 OAuth **已过期**（refresh 也过期） | 否 | `Failed to authenticate: OAuth session expired and could not be refreshed` |
| L9 | `.credentials.json` 在，但**不是合法 JSON** | 否 | `Not logged in · Please run /login` |
| **L10** | 凭据在，**网关回 401** | **是（8~11 发重试）** | `Not logged in · Please run /login`，`api_error_status=401` |

**L8 的那句话很好** —— 具体、可执行。**L9/L10 的那句话不好**：

- L9（文件坏了）与 L0（什么都没有）**同一句**，用户被指去做一件他已经做过的事。
- **L10 是最坏的一个**：用户**确实登录了**、钥匙也确实在，只是被网关拒了，
  而我们告诉他「请登录」。唯一能分辨的是 `api_error_status=401`。

**计时（实测）**：L10 在 90 秒上限下**仍未终止**（被 abort），在 300 秒上限下于**约 180 秒**自行终止。
⇒ **用户要等约三分钟**才等到那句误导性的话。

---

## X 组 — Codex 侧:随包二进制自己能从哪里拿到凭据

夹具 `CODEX_HOME` 里一份 `config.toml`，定义一个自建 provider 指向假网关（生产 fallback 形态：我们**不给** provider）。

| # | provider 声明 | 夹具里只有 | 发请求了吗 | `authorization` |
|---|---|---|---|---|
| X0 | `requires_openai_auth=false`，无 `env_key` | 什么都没有（**对照**） | 是 | (none) |
| **X1** | 同上 | `~/.codex/auth.json` 的 `OPENAI_API_KEY` | 是 | **(none) —— 没被读** |
| X2 | 同上 | 进程 env `OPENAI_API_KEY` | 是 | **(none) —— 没被读** |
| **X3** | `env_key = "PROBE_CUSTOM_KEY"` | 该环境变量 | 是 | **env_key 指的那个变量** |
| X4 | 无 `env_key` | `auth.json` **+** 进程 env 两者都有 | 是 | **(none) —— 都没被读** |
| **X5** | `env_key = "PROBE_CUSTOM_KEY"`，**变量没设** | `auth.json` 在 | **否** | — |
| **X6** | **`requires_openai_auth=true`** | `auth.json` 的 `OPENAI_API_KEY` | 是 | **auth.json** |
| X7 | `requires_openai_auth=true` | 进程 env `OPENAI_API_KEY` | 是 | **(none) —— 没被读** |
| **X8** | `requires_openai_auth=true` | **什么都没有** | **是** | **(none)** |

**X1 与 X6 是同一份 `auth.json`，只差 provider 的一行声明** —— 这一对就是本组最重要的结果：

> **`auth.json` 在不在，本身不说明任何事。** 它只在**当前生效的那个 provider 声明要它**时才被读。

**X5 同样重要**：`env_key` 指到一个没设的变量时，**不会**回落到 `auth.json` —— 直接失败，
错误话是 `Missing environment variable: `PROBE_CUSTOM_KEY`.`（清楚、可执行）。

**X8 是与 Claude 方向相反的那条**：一份凭据都没有，codex **照样把请求发出去**，一个 auth 头都不带。
它没有「发之前先自检」这一步 ⇒ **codex 侧不存在「离线就能判定没登录」的信号**。

### X13 — 凭据缺失 + 网关回 401,用户实际看到什么

5 次 `Reconnecting... N/5`（每次一条 `error` 通知，`willRetry: true`），
然后一条 `willRetry: false` 的终局错误：

```
unexpected status 401 Unauthorized: Incorrect API key provided., url: http://127.0.0.1:…/v1/responses
```

**全程约 6.5 秒**（对比 Claude 的约 180 秒）。这条终局错误**已经被我们的 normalizer 当终局处理**
（`codexNormalizer.ts` 的 `willRetry` 分支），话也说得具体。
⚠️ 但它**把网关 URL 写在正文里** —— 上屏前要过一遍脱敏，否则会把用户的私有网关地址显示出来。

### X10~X12 — 一个测不成的对照,以及它顺带证明的事

想测「内置 `openai` provider + ChatGPT 登录」这条最常见的路，办法是把内置 provider 的 `base_url` 改指到假网关。
**改不了**：codex 0.149.1 直接拒绝加载配置 ——

```
model_providers contains reserved built-in provider IDs: `openai`
```

⇒ **这条路离线构造不出**，本轮**不能**给出它的答案（见 §7 [未测]）。
顺带钉住两件事：① 内置 provider 的 id 是保留字；② 这类配置错误在 **`thread/start` 当场**失败，
错误里带**文件路径 + 行列号**，与 [E2](../2026-08-26-s0-spikes/e2-codex-resume-and-inherited-keys.md) 记的那类
「一行遗留 `profile =` 就起不来」是同一族，也和 `972934d5` 已经兑现的那一半是同一件事。

---

## §4 对设计的含义 — 探测该做成什么样

### ① 判据不是布尔值,是「找到了什么」的清单

D63 已经定了不置灰。剩下的问题是**按钮下面那行字怎么写**。本轮的结果只支持这一种写法：

- ✅ 可以写：**「在这台机器上找到了：Claude 的订阅登录、Codex 的 API key」**
- ❌ 不能写：**「本机配置可用」** —— L8/L9/X5 三臂都是「找到了、但跑不了」
- ❌ 不能写：**「没有找到本机配置，此按钮不可用」** —— L3/L4/L5 三臂都在探测视野之外

### ② Claude 的探测口径(按实测的槽位,不是按想当然的优先级)

`authorization` 槽位候选：用户 `settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`（L2，压过 OAuth L6）·
`~/.claude/.credentials.json` 的 `claudeAiOauth`（L1）· `apiKeyHelper`（L4）。
`x-api-key` 槽位候选：`ANTHROPIC_API_KEY`，来自进程环境或 settings 的 `env`（L3/L7）· `apiKeyHelper`（L4）。

两条必须做的过滤，否则就是 L8/L9 那种假阳性：

- `.credentials.json` 要**解析成功**（L9），且 `expiresAt` / `refreshTokenExpiresAt` **没过期**（L8）。
- 位置受 `CLAUDE_CONFIG_DIR` 影响（读码可见，本轮 [未测]），探测要照它走。

### ③ Codex 的探测口径:必须先解析 config.toml

顺序是固定的，跳过任一步结论就是错的：

1. 读 `CODEX_HOME`（默认 `~/.codex`）的 `config.toml`；**读不了/语法错 ⇒ 直接判「配置有问题」**，不是「没配置」。
2. 找到 `model_provider` 指的那个 provider（缺省 = 内置 `openai`）。
3. 那个 provider 有 `env_key` ⇒ 只看**那个环境变量**（X3），**别看 `auth.json`**（X5 证明不回落）。
4. 否则 `requires_openai_auth = true` ⇒ 看 `auth.json`（X6）。
5. 两者都不是 ⇒ 这个 provider **不需要凭据**（X0/X1/X4）—— 「没找到凭据」在这里是**正常**，不是缺陷。

**明确不要做的**：只判 `~/.codex/auth.json` 在不在。X1 说它会假阳性，X3 说它会假阴性 —— 两个方向都错。

### ④ 登录页那一刻,项目层是不可知的

L5 证明项目级 `.claude/settings.json` 的 `env` 能供凭据，但登录页还没有工作区。
⇒ 登录页的探测**结构上**就看不全，这是又一条「探测不能当闸」的独立理由。

---

## §5 两张施工票(本轮捞出来的,不在 E1 原范围)

D63 的连带要求原文是「首条消息失败必须说清缺什么」。本轮把这句话落到了具体位置：

### 票 ① — `api_error_status` 被丢掉,「没登录」与「钥匙被拒」同一句话

`src/agent-host/eventNormalizer.ts` 的 `result` 分支把 `is_error` 折成 `session.failed`，
`payload.error` 取 `msg.error ?? msg.result` —— **`api_error_status` 没被带上**。
而 L0 与 L10 的 `msg.result` **是同一句** `Not logged in · Please run /login`，
唯一的分辨依据正是被丢掉的那个字段。

⇒ 后果：一个钥匙被网关拒掉的用户，被我们告知去做他已经做过的事。

### 票 ② — Claude 侧要等约三分钟才失败

L10 计时：90 秒上限下未终止，300 秒上限下约 180 秒终止，其间 8~11 发重试。
同场景 codex 约 6.5 秒（X13）。

⇒ 后果：第二个按钮不是「点进去马上炸」，是「**点进去卡三分钟再炸，然后话还说错**」。
这比 roadmap 立项时预想的「假承诺」更难查 —— 用户多半会以为是网络慢。

两张票都**不改探测**，改的是失败面。它们是 D63 那条连带要求成立的**前提**：
不修这两条，「探不到时放行」就等于把排查成本转嫁给用户 —— 正是 open-q #1 当初警告的那件事。

---

## §6 ~~待拍板~~ 已拍板（D69）— 仓库能不能供凭据

L5 是本轮唯一一条**超出既有拍板范围**的发现。

D67 那轮用户拍的是「两个都读，接受这个风险」，当时摆在桌上的风险是
**仓库的 hooks 能跑任意命令**、**仓库的免问规则能让工具静默放行**。
**「仓库能指定用哪个网关、哪把钥匙」不在当时的清单里** —— 那轮取证没量凭据这一路。

事实是：一个 clone 来的仓库，`.claude/settings.json` 里写一段 `env`，
就能让我们的对话带着**它给的钥匙**打到**它给的地址**（L5 实测）。

**不建议自行处置**，理由与上一轮「甲乙丙」同构：能挡住它的手段（按 provenance 只挡项目层）
正是上一轮被用户否掉的那类「我们去干涉配置文件」。

✅ **已拍板（2026-08-27，[D69](../openchamber-chat-refactor-ledger.md)）**：**维持「都读」，一字不动**
（用户原话「都读，这都不是我们要操心的事」）。这是**知情后的重新确认** ——
记在这里是为了让后来人知道「凭据也能被仓库指定」当时**是被看见过并被接受的**，不是没人想到。

---

## §7 [未测] — 三条,以及为什么

- **ChatGPT 登录（`auth.json` 的 tokens 形状）** —— 离线构造不出：内置 `openai` provider 的 `base_url`
  改不动（X10~X12，保留 id）。X9 用自建 provider + 伪 tokens 测出「没上车」，
  **但那可能是伪 token 没通过解析、在被测点之前就失败了** —— 与上一轮 §B 组同型的陷阱，**结论不采信**。
- **Bedrock / Vertex** —— 随包 cli.js 里有 `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` /
  `AWS_BEARER_TOKEN_BEDROCK` 这些串（字符串计数可见），说明这两条路存在，但本轮一臂都没跑。
  它们是「静态探测会漏」的又一类，不影响 §4 的结论方向。
- **`CLAUDE_CONFIG_DIR` 改写位置** —— 读码可见（`claudeSettings.ts` 自己就按它解析），本轮未跑对照臂。

另记一条**观察到但不承重**的噪声：X 组每一臂的 stderr 都有
`Project-local config, hooks, and exec policies are disabled … until the project is trusted`。
夹具里写了 `[projects."<cwd>"] trust_level = "trusted"`，回合照跑、请求照发，
所以它没有影响本组任何一格的判定；未追查。

---

## 复现

```bash
cd docs/plans/2026-08-27-e1-local-credentials
N=<仓库根>/out-node-runtime/node            # 必须 Node 24
PROBE_ROOT=$PWD $N probeL.mjs   # Claude 侧十一臂
PROBE_ROOT=$PWD $N probeX.mjs   # Codex 侧十四臂

# 只跑一臂 + 放宽上限(L10 需要 300 秒才会自行终止)
PROBE_ONLY=L10 PROBE_TIMEOUT_MS=300000 PROBE_TRACE_CAP=1200 PROBE_ROOT=$PWD $N probeL.mjs
```

⚠️ 与上一轮同一条纪律：这些脚本被 `biome.json` 排除在 lint 之外，是**冻结的实验存档** ——
改动之后就不再对应本档记录的那些数字。要重新验证就照上面跑，要改就当成写一个新探针。
