# Open Questions — 统一凭据目录与托管凭据转默认

> 只放未决问题。已定的进 [README](./README.md) / [roadmap](./roadmap.md)，
> 已拍板的进总台账 [D59](../../../plans/openchamber-chat-refactor-ledger.md) / **[D60](../../../plans/openchamber-chat-refactor-ledger.md)**。

## 已关闭（存根）

- ~~#1 凭据脱离 `<userData>` 后 dev 与 prod 要不要共用~~ —— ✅ 2026-08-26 关闭：**按 profile 分子目录**（用户拍板「可以按 profile 分子目录」）。
  即新目录下再按 profile 分层，保住今天靠 `jyw-ai-client` / `jyw-ai-client-dev` 后缀取得的隔离性 ——
  开发版的实验改动不会写到正式凭据上，`cchBaseUrl` 也不会在测试网关与真网关之间横跳。
  代价是与「一个目录」的直觉有一层落差，用户已知悉并接受。

- ~~#2 存量用户 `~/.claude/settings.json` 里的非凭据配置怎么办~~ —— ✅ 2026-08-26 **随 D60 自动消失**：
  本问题的全部前提是「S3 一开，`CLAUDE_CONFIG_DIR` 切走，那份 settings.json 被 Main 重写而非合并」。
  D60 拍板取消整体重定向后，**用户的 `~/.claude/settings.json` 根本没被换掉**，hooks / permissions / statusLine / model 原地生效，
  收养与合并都不必发生。原文见 [history 说明](#附-2-原文存档)。

- ~~#3 远端已连机器的 `~/.aiclient/` 孤儿：接受还是搬运~~ —— ✅ 2026-08-26 拍板 **选项①「接受 + 写进发布说明」**
  ([D62](../../../plans/openchamber-chat-refactor-ledger.md)，用户原话「接受孤儿目录，写进发布说明」)。
  改名后已连过的远端机会留下旧 `~/.aiclient/`：远端设置回默认 + runtime 缓存重下一次。
  **不会坏** —— helper 是我们自己下发的，不是第三方契约 —— 只是观感像「远端配置被重置了」。
  落选②「远端也做一次搬运」：helper 里要加一份长期维护的迁移逻辑，
  而远端 runtime 本就是缓存、设置面也小，不值这个代价。
  ⚠️ **S2 的交付物里因此多一条：发布说明必须写明这一项**，否则用户会当成 bug 报上来。

- ~~#5 隔离 home 丢掉的不止凭据：codex 的 `AGENTS.md` 与整棵配置树~~ —— ✅ 2026-08-26 **修法已定（D60）**：
  取证结论保留（见 [附-5](#附-5-取证原文)），但三个候选修法里**不选①扩大投影、不选③UI 明示，选「取消隔离」**。
  剩余的是施工而非问题：codex 侧今天已在失效，止血归 roadmap 的 **S0'**。

## #4 品牌口径四不像（原「目录名最终是不是 `.pilab`」）

**状态**：目录名那半 ✅ **已随 S2 落地**（2026-08-27，`~/.pilab/<profile>/`）；
**品牌口径统一仍未决**，本条改为只跟这半

改名本身办完了。剩下的是当初记这条时提醒的另一半，S2 **刻意没动**：

| 名字 | 出处 | S2 后 |
|---|---|---|
| `.pilab` | `APP_STATE_DIR` | 新 |
| `com.aiclient.app` | `electron-builder.yml` 的 `appId` | 未动 |
| `AiClient` | `electron-builder.yml` 的 `productName` | 未动 |
| `jyw-ai-client` | package `name`（也是 `<userData>` 与 profile 段的名字） | 未动 |
| `.aiclient-generated` | codex 托管 home 的 sidecar 文件名 | 未动 |

S2 没动它们是对的：`appId` 改了等于换一个应用（旧安装不再被认作同一个），
package `name` 改了会连带换掉 `<userData>` 和刚定下来的 profile 段名。
**这两件都是各自独立的迁移，不该搭在目录改名这一批里。**
留在这里是为了别忘：现在是**五个**名字，不是四个。

## ~~#8 应用内终端的 codex 不再走公司网关，要不要补~~ ✅ 已关闭

**状态**：✅ 2026-08-27 拍板 **选项①「接受」**（[D66](../../../plans/openchamber-chat-refactor-ledger.md)，
用户原话「终端不走公司网关也没事」）。

取证与三个选项的原文见 D66。要点：这两半（`CODEX_HOME` + key）**拆不开**，
而 codex 没有任何环境变量能改 `base_url` —— 所以不是「补不补」的取舍，是「补的代价是把 D60 刚拿掉的东西请回来」。
**分界清楚**：agent 会话走公司网关，终端走用户自己的环境。

## #6 `settingSources: []` 让 CLAUDE.md 完全不进上下文，要不要改

**状态**：✅ **取证已完成**（2026-08-27，[取证档](../../../plans/2026-08-27-settingsources-spike/README.md)）
—— 结论是**可以改**，但**剩两条待拍板**，所以本条仍未关闭。

**取证结论**：

1. **当初设它的理由是对的，今天仍成立** —— 仓库里提交的 `.claude/settings.json` 中一条
   `permissions.allow`，**确实会整个跳过 `canUseTool`**（C3/D0 实测：工具直接执行，权限卡从不出现）。
2. **代价也是真的** —— `[]` 之下什么都不载入：用户与项目的 `CLAUDE.md` 都不进模型上下文，
   用户 `settings.json` 里的 `env` / `hooks` / `model` 也全不生效（A① / B1 实测）。
3. **替代品成立，且只要一行** —— `managedSettings: { permissions: { ask: ['*'] } }`
   把被 allow 跳过的工具**摁回 `canUseTool`**（D2/D3/D4 实测）。通配 `'*'` 就够，**不必枚举规则名** ——
   原先记的「需要另找压制手段」比预想便宜得多。
   `deny` 也能挡，但方式是**硬拒**、`canUseTool` 根本不被调用（D1），不是我们要的。

**剩下的两条待拍板**（施工前必须定）：

- **① 权限卡的粒度**：`ask:['*']` 让**每一次**工具调用都弹卡，比今天更严 ——
  今天连我们自己也让内置安全清单自动放行一部分（E 组实测：`echo` 今天 0 次卡，候选方案下 1 次）。
  接受这个更严的形态？还是收窄成 `['Bash','Write','Edit']` 这种「有副作用的才弹」？
- **② 开 `project` 会一并载入仓库提交的 `hooks`** —— 那是会执行的命令，来自 git。
  `defaultMode` 有 SDK 的信任过滤兜着（A③ 实测 `bypassPermissions` 被丢弃），**`hooks` 没有**。
  **本轮未测 hooks 是否真的会被执行**，这是开工前该补的一发。

⚠️ **另有一条文档与实测不一致**：SDK 文档称 `managedSettings` 被 restrictive-only 过滤、
`permissions.allow` 会被丢弃；`resolveSettings` 显示**没有被丢弃**（A⑥）。
文档同时声明 `resolveSettings` 报告的是「原始层叠、不是安全判定」，所以两者不一定矛盾 ——
但**在把 `managedSettings` 当安全边界用之前，须单独测一次执行期行为**。

**下游**：本条是 [entry-and-environment E1](../entry-and-environment/roadmap.md)
（「使用本机已有配置」按钮的真探测）的前置 —— 不解决它，对「自己在 `~/.claude/settings.json` 里配了
url+key」的用户，那个探测的结论必然是错的。

## ~~#7 取消隔离后，用户的 `mcp_servers` / `developer_instructions` 要不要继承~~ ✅ 已关闭

**状态**：✅ 2026-08-26 拍板 **选项①「全部继承」**（[D61](../../../plans/openchamber-chat-refactor-ledger.md)，用户原话「让它生效」）。
下面的取证与选项原文保留，作为该决策的依据。

今天 `ensureCodexHome` 的 deny-by-default projection **刻意丢弃**用户 config 里的
`developer_instructions` / `mcp_servers` / `notify` / `profiles` / `history`（生成文件头原文如此）。
D60 取消隔离后，这些**会流回来生效** —— E1 R8 实测：用户 `[mcp_servers.usermcp]` 被真实拉起（sentinel 落地）。

**posture 那半补得回来，这半补不回来**：
- `-c approval_policy` / `-c sandbox_mode` 能盖住用户的 `never` / `danger-full-access`（R5 ✅）
- `-c mcp_servers={}` **整表清空无效**（R9 ❌）——`-c` 是合并进表不是替换表
- 只有 `-c mcp_servers.<name>.enabled=false` 逐条有效（R10 ✅），**但需要先读用户 config 枚举名字**

**三个选项**：
1. **全部继承** —— 与「用户环境原样生效」的方向一致，也正是取消隔离的初衷；
   风险面由 codex 自己的 `approval_policy=on-request`（我们强制）兜底，工具调用仍过审批。
2. **逐条压制 MCP** —— 做得到，但等于又开始读用户配置来生成覆盖参数，
   把刚拿掉的「读写用户配置」语义换个形式请回来。
3. **继承但在 UI 明示** —— 折中。

**拍板结果 = ①**。理由：projection 丢弃这些键是**隔离 home 时代的产物**（那时无法区分「用户的」和「我们的」），
而 D60 已经判定隔离本身是错的定位；继续保留 deny 清单等于保留半个隔离。
用户已知悉「本条扩大了运行时实际会执行的东西」并拍板通过。

---

## 附：已关闭问题的原文存档

### 附-2 原文存档

> `adoption.ts` 解决的是**凭据**免重登。但 S3 一开，`CLAUDE_CONFIG_DIR` 切到 `<userData>/claude-home`，
> 而那份 `settings.json` 是 Main 从 vault **重写**的，不是合并 —— 用户原来在
> `~/.claude/settings.json` 里的 hooks、permissions、statusLine、model 等**不会跟过去**。
> 已知仓内只做了一处收养：`CLAUDE.md` 一次性 copy（`managedClaudeHomeStartup.ts:99-105`）。

### 附-5 取证原文

用户 2026-08-26 追问「难道 claude/codex 不会自己从 `~/.claude`、`~/.codex` 读 CLAUDE.md / AGENTS.md 吗」——
**会，而且我们漏了。**

`strings` 扫随包 codex 0.149.1 二进制，实测命中：

```
Failed to read global AGENTS.md instructions from `
.codex/config.toml   .codex/agents   .codex/hooks   .agents   .agents/skills
```

⇒ codex 从 `CODEX_HOME` 读**全局 `AGENTS.md`**，另有 `agents/` / `hooks/` / `skills/` / `plugins/` 一整棵树。
而 `ensureCodexHome`（`src/agent-host/codexHome.ts:652-672`）只搬 **`config.toml` + `auth.json` 两个文件** ——
隔离 home 一启用，用户的全局 AGENTS.md 与这棵树**静默消失，无任何提示**。

Claude 侧同源但已补了一小半：`managedClaudeHomeStartup.ts:99-105` 一次性收养 `CLAUDE.md`。
**这解释了用户的疑问「为什么要收养 CLAUDE.md」** —— 正因为 `CLAUDE_CONFIG_DIR` 一改，
`~/.claude/CLAUDE.md` 就读不到了。但 Claude 侧也只补了这一个文件，
`commands/` / `skills/` 只建空目录不收养（同文件 §phase ①）。

⚠️ **本条不是 S3 引入的**：只要隔离 home 存在就成立，而 codex 的隔离 home **今天已经在跑**
（`ensureCodexHome` 不受托管 flag 控制，fallback 分支照样建）。⇒ **已经在影响用户，不是未来风险。**

当时列的三个候选修法：① 扩大投影范围；② 只搬 AGENTS.md（最小止血）；③ 不搬但在 UI 明示。
当时留的根因判断 —— 「**须先决定隔离 home 的定位**：是『我们完全接管的干净环境』还是『用户环境的投影』
—— 今天两边都不像，这才是根因」—— **正是 D60 回答的那个问题**，答案是第三种：**根本不要隔离 home，只隔离凭据**。
