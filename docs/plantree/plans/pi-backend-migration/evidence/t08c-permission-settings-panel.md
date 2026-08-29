# T08-c 切片 2 — 权限策略设置面

**日期**：2026-08-29
**拍板依据**：[D11](../decisions/011-default-permission-policy.md)（Q9 收口）
**前置**：[切片 1](./t08c-default-permission-policy.md)（默认策略 + 信任边界）
**范围**：设置面 GUI（查看生效策略 + 编辑受管 agentDir 那一层）。至此 T08-c 两个切片都已施工完毕。

## 这个面板解决什么

权限闸是本应用里唯一「不打扰你就看不见」的部件。它出问题有两个方向，症状都不指向原因：

- 「它怎么老弹窗」——某条规则没命中；
- 「它怎么**不**弹窗」——某条规则命中了，而你不知道有这条规则。

两者的答案都是同一句话：三个配置文件里的某一条。此前应用里没有任何地方能读到它。
本切片补上这一面，并且只把**我们有权写的那一层**做成可编辑。

## 落地的东西

| 文件 | 作用 |
|---|---|
| `src/shared/piPermissionPolicy.ts` | 纯模型：解析、按插件语义合并三层、生成带来源归属的生效视图、把一次控件改动变成对可写层的 patch |
| `src/main/services/piPermissionPolicy/policyStore.ts` | 只跟文件打交道：读一层、读原始文档、写一层（空文档=删文件） |
| `src/main/services/piPermissionPolicy/index.ts` | 决定「哪三个路径」和「哪一层可写」，本机路线直接拒写 |
| `src/main/ipc/piPermissions.ts` | 四个 IPC：get / update / reset / reveal |
| `src/renderer/components/settings/permissionPolicyView.ts` | 面板的判断：哪些选择算危险、哪些规则可以删、新规则校验 |
| `src/renderer/components/settings/PermissionPolicySettings.tsx` | 面板本体 |
| `src/renderer/components/settings/constants.ts` | 分类列表改为**单一来源**（见下文「顺手修掉的一个静默 bug」） |

## 三个必须说清楚的设计判断

### 1. 本机路线是只读的，而且是「拒绝」不是「静默不做」

可写层是 `<agentDir>/extensions/pi-permission-system/config.json`。受管路线下
agentDir 是我们自己的隔离目录，随便写；**本机路线下它就是用户自己的
`~/.pi/agent`** ——那是他 `pi` CLI 读的目录，为了让*我们的*应用听话去改*他的*工具，
是 T08-a 定下的红线。

所以 `updatePermissionPolicy` / `resetPermissionPolicy` 在本机路线**抛错**。
选择抛错而不是返回一个没变化的快照：IPC 的 reject 会变成用户能读到的错误，
而一个「保存了但什么都没变」的快照读起来就是保存成功——那会让人相信自己收紧了
一条其实不存在的策略。面板同时把只读原因写在顶部横幅上，并给出「在文件管理器中
显示」的入口。

### 2. 合并语义是照抄插件的，不是「差不多」

插件的 `.ts` 在 `node_modules` 里，Node 拒绝对该位置做类型剥离
（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），所以不可能直接 import 它的
loader。只能镜像。镜像了两条语义，两条都写了断言：

- **最后匹配优先**（`rule.ts`）。`{ "*.env": "deny", "*": "allow" }` 是**放行**
  `.env` 的。所以模型从不排序，新增规则一律追加到末尾。
- **同层同表是浅展开**（`permission-merge.ts` 的 `{ ...base, ...override }`）。
  这条有个反直觉的后果：**重述一条已存在的规则，会拿到新的动作，但保留原来的
  位置**。用户在面板里把 `*.env` 改成 allow，它仍然排在 `*.env.*: deny` 前面，
  于是「我明明改了」和「它明明没变」同时成立。

第二条不是消灭而是**显示**：生效视图给这类规则打 `repositioned` 标记（界面上是
「位置未变」徽章），新增规则时校验器会提示「该规则已存在于第 N 条，它后面还有 M 条
规则，命中时以后面的为准」。

### 3. 写文件时保留我们不认识的键

插件接受一批本应用没建模的键（`forwardingTimeoutMs`、`shellTools`、
`authorizerChain`、`$schema`）。patch 打在**原始 JSON 文档**上，而不是先过一遍
我们的窄类型再写回去——否则用户手工调过的参数会在他第一次动一个无关下拉框时
被静默删掉。这条有专门的断言。

### 补充：Select 的取值必须严格解析

第一版写的是 `String(next)`。base-ui 的 Select 在取消选择时会发 `null`，
`String(null)` 是字符串 `"null"` ——它不是「跟随默认」的哨兵值，于是会被当成一个动作
**写进策略文件**。插件读到无法识别的动作会回落到 `ask`，所以**症状是弹窗变多，
而用户真正选的那条设置无声消失**。改为 `readActionChoice`：只认三个动作和哨兵，
其余一律返回 `undefined` = 什么都不做。有专门的负向断言。

## 危险选择的二次确认

沿用仓库既有姿态（D48 §5.4：危险档位可选、但要有常驻警告 + 二次确认）。
危险集合是**人工判定后写死的表**，不是从数据推的：`write`、`edit`、`bash` 兜底、
`external_directory` 兜底、`mcp`、`skill`、顶层 `*` —— 在这些面上选「直接允许」
会移除一层没有别的东西接住的限制。测试逐条钉死这个集合；少一个，那个控件仍然
长得一模一样、行为一模一样，只是不再确认了。

只在**放松**时确认。收紧和「恢复默认」都不问——一个正在往更多询问的方向走的用户，
不需要被劝阻。

`yoloMode` **不提供开关**，只在开启时显示一条红色横幅并指出是哪一层开的。
它不是一个档位，而是把包括 `sudo` / `bash -c` 在内的兜底限制整体摘掉的旁路。

## 顺手修掉的一个静默 bug

`SettingsCategory` 的联合类型，和 `useSettingsState.ts` 里那份用于校验
localStorage 恢复值的同名数组，是**两份手写清单**。往其中一份加一个分类、忘了另一份，
类型检查完全通过，症状是：新面板能打开，**重启后再也打不开**——保存的分类被当成
未知值丢弃、回落到 general。

处理不是补上遗漏项，而是改成单一来源：`SETTINGS_CATEGORIES` 是唯一的清单，
类型由它派生，校验函数 `isSettingsCategory` 读它。另加静态扫描
`settingsCategories.test.ts`：每个分类必须在 `SettingsContent.tsx` 里既有导航项
（`id: '<cat>'`）又有渲染分支（`activeCategory === '<cat>'`）——这两半是 JSX，
类型查不到，缺哪一半都是静默失效（无入口 / 空面板）。

## 顺手修掉的一个 dev/打包不一致

**这条会直接影响即将进行的真机验收，所以单独说。**

`permissionPlugin.ts` 按运行中 Host 入口的位置解析插件目录，dev 下是
`src/agent-host/`。而切片 1 的构建脚本**只往产物写** `config.json`
（当时的理由是「跑一次 build 不该改变开发者的 checkout」）。两件事合起来的后果是：

> **`node scripts/dev.js` 下随包默认策略根本不存在**，插件回落到它自己的裸默认。

那个裸默认是**安全的**（什么都问），这正是它能一直没被发现的原因——症状只是弹窗变多，
而缺掉的另一半是静默的：`cat .env` 会变成弹窗询问，而不是直接拒绝。如果验收在
dev 上跑，「`cat .env` 被直接拒」这一条会失败，且失败原因指向策略本身而不是这里。

修法保留了原本的意图：构建**仍然**只写产物，dev 的一致性由 **dev 自己的显式步骤**
提供。`scripts/agent-host-build-lib.mjs` 新增 `ensureDevPermissionPolicy(repoRoot)`，
`scripts/dev.js` 启动时调用并打印结果；插件没装时**返回而不抛错**（缺 node_modules
是一句 `pnpm install` 的事，不值得挡住 `node scripts/dev.js`；何况没有闸门时 Host 本来就拒绝开会话）。

## 新增测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `shared/__tests__/piPermissionPolicy.test.ts` | 28（新） | 解析容错 · 标量层覆盖 · 两表浅展开 · **标量会整表抹掉**（`mergeFlatPermissions` 只在两边都是对象时展开）· 被忽略/解析失败/不存在的层不参与合并 · 来源归属 · **重述规则保留原位置并被标记** · 最后匹配优先（含 `.env.example` 豁免顺序、glob 元字符不当正则用）· patch 追加/原位更新/删除/空表清理/**保留未建模的键**/不改传入对象 |
| `main/services/piPermissionPolicy/__tests__/policyStore.test.ts` | 15（新） | 真实临时目录：读取/缺失/坏 JSON/部分非法 · 原始文档读取 · 写入建目录、缩进与换行 · **空文档删文件而不是写 `{}`** |
| `main/services/piPermissionPolicy/__tests__/permissionPolicyService.test.ts` | 14（新） | 随包层路径取自 Host 入口旁 · **三层顺序** · 无仓库时不含项目层 · 项目层仅受管路线被忽略 · 受管合并与归属 · 仓库策略「读得到但不参与」· **本机路线拒写、拒重置，且文件确实没被创建** · 重写保留未建模键 · reset 删文件后回落随包默认 |
| `renderer/components/settings/__tests__/permissionPolicyView.test.ts` | 29（新） | 四种层状态行（含「被忽略但语法也错」两条信息都留住）· 控件取值与归属 · 表控件读兜底项 · **加了兄弟规则不算覆盖了兜底项** · **危险集合逐条钉死** · 只在放松时确认 · 可删规则仅限可写层 · 新规则校验（空/首尾空格/内部空格合法/重复警告分两级）· **Select 取值严格解析**（见下） |
| `renderer/components/settings/__tests__/settingsCategories.test.ts` | 3（新） | 每个分类都有导航项与渲染分支 · 校验函数与清单一致 |
| `scripts/__tests__/agent-host-build-lib.test.mjs` | +3 | dev 写入的字节与产物一致 · 插件没装时报告而不抛错 · **构建仍然不碰 checkout** |

## 验证

```text
pnpm typecheck                     ✅ 0
pnpm typecheck:agent-host          ✅ 0
pnpm test                          ✅ 269 files / 5397 tests（本批前 264 / 5305）
pnpm exec biome check src scripts  ✅ 0 error / 0 warning
pnpm build:agent-host              ✅ 394.3MB
pnpm smoke:permission-plugin       ✅ PERMISSION GATE INTACT
```

`pnpm build`（完整 Electron）未跑：脚本固定 4 GiB heap，当前 VM 3.3 GiB，沿用
Phase 2/5 既有处置，以 `build:agent-host` + 打包产物 smoke 替代。
`pnpm lint`（全仓）仍有 1 个**既存**错误，来自未跟踪文件
`docs/plans/2026-08-27-entry-design/logo-concepts-preview.html`，与本仓代码无关。

## 未完成

1. **GUI 点验**（按用户安排推迟到关键节点）：面板在浅/深色下的观感、危险二次确认
   弹窗、「位置未变」徽章、规则增删、只读横幅、reveal 按钮。
2. **真机验证策略实际生效**——与 T08-b 的审批 E2E 同一批。本切片新增了一条必测项：
   在 dev 下确认随包默认策略确实生效（`cat .env` 被**直接拒**而不是弹窗）。
3. **面板不覆盖的层**：插件还读两个 legacy 的 `pi-permissions.jsonc`。刻意不做——
   本应用从不写它们，做一个假装能管它们的控件比插件自己的「移到 …」警告更糟。
4. **本机路线下用户自带插件副本的情形**：如果用户在自己的 pi `settings.json` 里
   配了 `@gotgenes/pi-permission-system`，Host 不注入我们的副本，此时面板显示的
   「随包默认」层就不是真正生效的那一层。面板未检测这种情况。
