# D11 — 默认权限策略（Q9 收口）

> 用户拍板 2026-08-29，四问四答，Q9 就此关闭。施工票 T08-c。
> 提案依据是对 `@gotgenes/pi-permission-system@27.0.1` 的源码与文档实测，
> 不是从文档转述——三条会改变判断的实测事实见文末。

## 拍板内容（四条）

**a. 基线档位 = 务实档。** read / grep / find / ls 放行；write / edit 询问；
bash 默认询问、只读命令白名单放行；mcp 仅发现类（`mcp_status` / `mcp_list` /
`mcp_search` / `mcp_describe`）放行；skill 询问；顶层 `"*"` 兜底 `ask`。

判据是「读是自由的，改是要确认的」。落选的两侧各自有明确代价：**保守档**要求
`grep` / `git status` 也弹窗，而一个回合里 agent 先跑几条只读命令是常态，那会
把用户训练成不看内容就点同意——比少问更危险；**宽松档**放开 write/edit，等于
去掉「一次错误编辑还来得及拦住」的最后一个点。

`write`/`edit` 取 `ask` 而非插件示例配置里的 `deny`：对编码 agent 而言 `deny`
等于让它做不了它存在的目的。

**b. path 横切 deny 面 = 提案原清单。**
`.env` / `.env.*`（`.env.example` 例外，且必须排在两条 deny 之后）、`~/.ssh/*`、
`*.pem`、`*.key`、`id_rsa*`、`~/.aws/credentials`、**`~/.pilab/*`**。

最后一条是拦住 agent 读**我们自己注入给它的公司凭据**——能读到它就能把钥匙带走。

`path` 是横切面且 **deny 不可被单工具 allow 覆盖**，这正是 `cat *` 敢放行的原因：
`cat .env` 在到达 bash 规则之前就被 path 闸拒了。

**c. external_directory 默认 `ask`，不预置缓存白名单。**
对 worktree 管理器而言这条边界就是产品核心——它是阻止 `/repo-a` 的会话去动
`/repo-b` 的最后一道闸。常用缓存目录（`~/.cargo/registry` 之类）留给用户按需加，
不替他预先放开。

**d. 项目级 `.pi/` 配置：受管模式不允许放宽，本机模式允许。**
落地为 pi 的 `projectTrusted`：受管（登录公司账号）路线传 `false`，本机路线传
`true`。与 [D68](../../../plans/openchamber-chat-refactor-ledger.md)「两条路线彻底
分开」同构——公司路线的可用性与它允许什么由我们负责，用户自己的机器上他自己负责。

⚠️ **连带影响必须知道**：`projectTrusted` 是 pi 自己的开关，不只管权限插件。
受管模式下仓库自带的 `.pi/settings.json` 也不再生效——包括 `packages`（装扩展 =
跑代码）与模型配置。这是刻意的：一个克隆来的仓库能往会话里加扩展，是比权限放宽
更大的面。

## 不需要拍的一条（提案时以为要拍）

「`Yes, for this session` 是否允许生成建议 pattern」**插件写死了，没有开关**。
四选项第二项本来就是 `Yes, allow "<pattern>" for this session`，pattern 由
`src/bash-arity.ts` 的词表推导（`git checkout main` → `git checkout *`，
`npm run dev` → `npm run dev*`，未知命令取第一个词），只在内存里，
`session_shutdown` 清空。

## 策略文件放在哪，以及为什么

**随包默认写进 `<产物内插件目录>/config.json`**，构建期生成，运行期只读。

插件读四层，本文件在最低一层：

```
随包默认（本决策）  <  用户 / 受管 agentDir 配置  <  项目 `.pi/` 配置
```

三条理由，每条都排除了一个看起来更直接的做法：

- **绝不写用户的 `~/.pi`。** 那是他自己 `pi` CLI 的目录，改它等于顺手改了一个
  我们不拥有的工具。这与 `permissionPlugin.ts` 里 T08-a 定下的红线是同一条。
- **一份来源。** 顺带往受管 agentDir 再写一份会制造第二个落点和一个将来会写错的
  同步问题——正是 T-CM1 双缓存那个形状。
- **用户永远能压过它。** 他自己 agentDir 里的配置整条覆盖我们的。

⚠️ **已知代价**：插件把这个路径标为 LEGACY，每次加载会经 `ctx.ui.notify` 发一条
「把它移到 …」的警告。今天渲染端丢弃 `notify`（T09 Deferred）所以不可见；**T09 落地
后它会变成一条用户可见、但让他去移动一个只读产物内文件的建议**——届时要么过滤这条
特定警告，要么给策略换个落点。已登记为 T09 的前置注意事项。

⚠️ **2026-08-29 补记（切片 2 发现）**：本决策只说了「写进产物」，而插件是按**运行中
Host 入口**解析插件目录的——dev 下那是 `src/agent-host/`，构建从不写它。于是
**`node scripts/dev.js` 下本决策的默认策略根本不生效**，插件回落到自己的裸默认。那个裸默认安全
（什么都问），所以症状只是弹窗变多，而「`.env` 被直接拒」这一半是静默缺失的。
已由 `ensureDevPermissionPolicy`（`scripts/dev.js` 启动时调用）补齐；构建仍然只写产物，
一致性是 dev 自己的显式步骤。**真机验收若在 dev 下进行，先确认启动日志里有
`[dev] permission policy: …`。**

**升级绊线**：`smoke:permission-plugin` 扫描产物里插件自己的
`src/config-loader.ts`，要求它仍然调用 `getLegacyExtensionConfigPath(`。插件哪天
删掉这条路径，smoke 会红——否则我们的默认策略会变成静默不生效的死文件，而症状
只是「什么都开始弹窗了」。

## 实测事实（会改变判断的三条）

1. **「所有 surface 一律 ask」这句话一直不准确。** 除内建规则外，插件还有一条
   硬编码自动放行：**只读工具（read/find/grep/ls）读 Pi 基础设施目录一律 allow**，
   绕过 external_directory 闸——含 agentDir、全局 node_modules、Pi 自身安装目录、
   项目内 `.pi/npm`。写工具不在此列。
2. **`projectTrusted: true` 此前是硬编码的**（T05 遗留），所以在本决策之前，
   克隆来的仓库确实可以自带 `.pi/extensions/pi-permission-system/config.json`
   把闸放宽，且界面上看不出来。d 条修的就是这个。
3. **模式顺序是 last-match-wins**，所以每张规则表都必须**先写 catch-all 再收窄**，
   而任何对 deny 的豁免（`*.env.example`）必须排在它豁免的那条 deny **之后**。
   `{ "*.env": "deny", "*": "allow" }` 是放行 `.env` 的。这不是风格问题，
   键的顺序就是策略本身。

## 范围声明

本决策 + T08-c 切片 1 覆盖**默认策略与信任边界**。设置面 GUI 是切片 2，已于同日施工，
见 [evidence/t08c-permission-settings-panel.md](../evidence/t08c-permission-settings-panel.md)。
切片 2 未改动本决策的任何一条，只是把结果显示出来，并把**受管 agentDir 那一层**
做成可编辑（本机路线因红线保持只读）。两个切片的**验收**都还欠真机。
