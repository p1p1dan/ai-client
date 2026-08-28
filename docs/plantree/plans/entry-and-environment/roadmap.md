# Roadmap — 应用入口与环境依赖

> 状态：**主线四件（E1 / A1 / A3 / A2）全部走完（2026-08-27）**，本 plan 的开工范围收口；剩余见 Next。立项时的三条待拍板已全部拍完
> （[D63/D64/D65](../../../plans/openchamber-chat-refactor-ledger.md)），A1 已随
> unified-credentials S3 落地，E1 的前置（`settingSources`）由
> [D67](../../../plans/openchamber-chat-refactor-ledger.md) 解开，E1 本身已跑完并落档。
> 依赖链仍然决定顺序：登录页是**最后一步，不是第一步**。

## 依赖链

```
settingSources 决策（unified-credentials open-q #6）──┐
                                                       ├──► E1 「本机可用」探测 ✅ 已完成
S0' codex 侧（unified-credentials，前置已清）─────────┘              │
        │                                                             │
        └──► S3 翻开关 ──► 「登录」不碰本地环境 ────────────► A2 两按钮登录页 ✅ 已落地
                    │                                                 │
      A1 凭据模式建模 ✅ 已落地 ──────────────────────────────────────┘

（A3 环境检查退役 ✅ 已落地，与上面这条链并行，是 A2 的前置之一）
```

## Done

### ~~E1 — 「本机已有配置可用吗」探测~~ ✅ 已完成（2026-08-27，取证）

**落档**：[E1 取证](../../../plans/2026-08-27-e1-local-credentials/README.md)（Claude 十一臂 + Codex 十四臂，全离线）。
**未改动 `src/` 下任何产品代码。**

**答案**：这个问题**静态探测答不准**。

⚠️ **本段的产品建议已被 [D68](../../../plans/openchamber-chat-refactor-ledger.md) 整体推翻（同日）** ——
用户拍板两条路线彻底分开：**第二个按钮不做任何探测**，也不为它做失败面工程。
下面四条实测结论**保留**，但角色从「设计输入」变成**「为什么不该做探测」的实证依据**（废案理由存档）。

四条承重结论（逐条实测，编号对应取证档的臂）：

1. **凭据来源比预想多，两个 agent 完全不同构。** Claude 有五路各自单独就够用（OAuth 文件 / 用户 settings 的 `env` /
   项目 settings 的 `env` / 进程环境变量 / `apiKeyHelper` 脚本，L1~L5）；且**没有单一优先级链**，是
   `authorization` 与 `x-api-key` 两个头槽位各自解析（L7）。
2. **Codex 侧「文件在不在」本身不说明任何事** —— 同一份 `auth.json`，provider 声明 `requires_openai_auth=true`
   时被读（X6）、不声明时不被读（X1）。判断必须先解析 `config.toml` 的 `model_provider`；
   `env_key` 落空时**不回落**到 `auth.json`（X5）。
3. **两个 agent 的「没凭据」行为方向相反**：Claude 发请求之前就失败并说得出话（L0）；
   Codex 照发不误、一个 auth 头都不带（X8）⇒ **codex 侧不存在离线可判的「没登录」信号**。
4. **静态「有」不等于能用**（过期 OAuth L8 / 坏 JSON L9 / `env_key` 落空 X5），
   **静态「无」更不等于不能用**（`apiKeyHelper` L4 / 进程环境变量 L3 / 项目层 L5 —— 登录页那一刻还没有工作区）。

~~⇒ A2 的按钮文案口径：只能报「在这台机器上找到了什么」~~ —— **D68 作废**：
按钮恒可用、**不带任何说明文字**，因为我们既不承诺它能用，也不承担它坏了的排查。
D68 同时作废的还有：探测器本身（OAuth 文件解析 + 过期判定 · `config.toml` 的
`model_provider`/`env_key`/`requires_openai_auth` 解析链）。

### ~~A1 — 凭据模式建模~~ ✅ 已落地（2026-08-27，与 unified-credentials S3 同轮）

`~/.pilab/<profile>/settings.json` 里的 `credentialMode`，规则在 `@shared/credentialMode`。
**写入口目前只有「登录」** —— 用户可见的二选一正是下面 A2 要补的那一半。
**留给 A2 同轮定**：能否中途切换、切换时在途会话怎么办。

### ~~A1 原文~~（保留作对照）

把「用哪套凭据」从 `AICLIENT_MANAGED_CREDENTIALS` 这个**构建期开关**变成**运行期状态**。
需要决定：存在哪（大概率 `~/.pilab/<profile>/settings.json`）· 能否中途切换 · 切换时已有会话怎么办。

**依赖**：unified-credentials 的 **S3** —— 本项直接改写 S3 的形状，两边必须同轮定。

### ~~A3 — 环境检查退役与重新摆放~~ ✅ 已落地（2026-08-27）

D65 的三件事，本轮做完两件半；第三件半按用户裁定留给 A2。

1. ✅ **清债** —— `resolveGateDecision` 里那条来自系统 `claude --version` 的 `cliMissing` 分量退役。
   连带清掉 `AuthGateCliStatus` 类型、`Root.tsx` 的 `onboardingCliStatus` 查询、`MainWindow` 的入参。
   `cliMissing` 现在只剩 `runtimeStatus.kind === 'not-installed'`，而那一条的含义已经收窄成
   **「我们自己随包的运行时解析不出来」**（安装损坏），不再是「用户机器上没装 claude」。
2. ✅ **git 检查换位置** —— 新组件 `components/layout/GitMissingNotice.tsx`，
   启动查一次（复用既有的 `onboarding.checkPrerequisites()`，无新探测），
   缺 git 时在应用内挂一条**不拦人**的 `Alert`（本轮会话内可关闭，不持久化）。
3. ✅ **补非 Windows 缺口** —— Windows 给「安装 Git」按钮（新增窄 IPC `onboarding:installGit`），
   非 Windows 给「去下载 Git」跳 `git-scm.com/downloads`。这正是 D65 要补的那个缺口：
   此前 mac/Linux 只能探测出来，然后**没有下文**。
4. ⏭ **`cli-check` / `cli-install` 两步未删** —— 用户 2026-08-27 裁定随 A2 重画登录页时一并删除，
   避免同一个组件改两遍。本轮它们已经**不再影响门禁**，只是页面上还在。

**验证**：四门全绿（typecheck 0 含 agent-host · biome 1001 文件 0 · **vitest 248 文件 5015 例**）；
**变异 6 发 6/6 咬红零存活**（摘挂载 · 所有平台都给安装按钮 · 探测失败当成缺 git ·
改用 `installAll([])` · Root 恢复 cliStatus 查询 · authGate 把探测项加回来），md5 逐个对账还原。

**as-built 三条偏差**（施工期实测，规格里没有）：

- **① 负向断言抓到了 review 抓不到的东西**：`Root.tsx` 有 **4 处**在 `invalidateQueries(['onboardingCliStatus'])` ——
  invalidate 一个已经不存在的查询。类型检查绿、lint 绿、人眼也看不出，是 `[A3-01]` 的负向断言把它顶出来的。
- **② 装 git 不能复用 `installAll([])`** —— 空 agent 列表确实会跳过两个 agent 并跑 git 前置，
  但它**同时会装 Node.js**，而 Node **是随包的**（`resources/node-runtime`）。
  为了满足一个我们自己已经满足的依赖，往用户机器上再装一个 Node，是错的。故新增窄 IPC 只装 git。
  ⚠️ **顺带登记**：`installAll` 至今仍会装 Node —— 这条流程 A2 删除 onboarding 时要一并处理。
- **③ 负向源码断言差点自伤** —— 第一版我自己写了两条正则剥注释，而仓内早有 `stripComments`
  （TS parser 实现），它的头注列了**五种**「两条正则会静默删掉代码、且方向恰好让负向断言变绿」的形状。
  已改为复用。这正是 0820 批 §16 那条纪律的第四次撞上。

**未做**：**GUI 点验** —— 这条提示条还没在屏幕上看过（缺 git 的机器要现造）。
按既有优先级（功能优先于点验）不阻塞 A2，但 A2 出图时应一并目视。

### ~~A2 — 两按钮登录页~~ ✅ 已落地（2026-08-27，rev.2）

> ⚠️ **rev.1 的门禁形状当日被 [D71](../../../plans/openchamber-chat-refactor-ledger.md) 推翻**，见下方 as-built ①。
> 本段描述的是**最终形态**。

**登录页是启动首屏，每次启动都出现**（D71）。点一颗按钮才进主界面；关掉再开，同样两颗按钮回到眼前。

| 状态 | 判据 | 主按钮 | 次按钮 |
|---|---|---|---|
| 登录过 | `AuthState.authenticated` | `Continue as <email>` | `Use my own setup` |
| 没登录 / 主动退出 / 登录失效 | `signed_out` · `credentials_invalid`（另加一行「登录已失效」） | `Log in with work email` | `Use my own setup` |

**主按钮只由账号决定，凭据模式不参与**。模式回到 [D64](../../../plans/openchamber-chat-refactor-ledger.md)
给它的唯一职责：决定 spawn 注入哪套凭据。

每个按钮下一行小字（**静态产品描述，不是探测结果**，与 D68 收窄后的口径一致）：

- 主按钮 —— `Runs on the managed gateway. Nothing is written to your machine.`
- 次按钮 —— `Runs on the Claude Code and Codex configuration already on this machine.`

**三条进门路径走同一个调用** `auth:enterApp(mode)`：Continue → `managed` · 登录完成 → `managed` ·
使用本机配置 → `local`。一次调用同时**记模式**与**落会话闩**，两半不可能各自成立
（只记模式不落闩 = 用户盯着自己刚回答过的那一屏；只落闩不记模式 = 会话按文件里碰巧写着的那套凭据起）。

**会话闩刻意不持久化**（`services/auth/appEntry.ts`）：持久化就等于把这屏悄悄变回「只出现一次」，
正是 D71 推翻的那个形状。它也是**为什么不需要单独的「切换凭据来源」入口** —— 重启就是切换。

**验证**：四门全绿（typecheck 0 含 agent-host · biome 1004 文件 0 · **vitest 248 文件 5029 例**）
+ **`electron-vite build` 通过**；**变异两轮共 15 发全咬红零存活**，md5 逐个对账还原。

**as-built 七条偏差**：

- **① rev.1 被用户一句话问倒，而他是对的。** 我把「登录过就别再要求登录」实现成**跳过这一屏**，
  他的原话是「**显示**进入公司配置和 BYOK」。他追问「跟选不选使用本机已有配置有啥关系？」——
  按钮文案本来就只由账号决定，模式只影响「这屏出不出现」，**而那条是我自己加的**。
  改完之后**代码比改之前简单**：门禁少一个入参，`resolveCredentialModeChoice` 与
  `getRecordedCredentialMode` 双双作废删除，`T-A2a` 连带作废。
- **② 换轴仍修掉一个真回归**：`resolveManagedCredentialsEnabled()` 把 `local` 与「没选过」折成同一个 `false`，
  旧门禁会让**刚点了「使用本机已有配置」的用户被要求去注册** —— 与他刚选的东西正好相反
  （D64/S3 留下、A2 才暴露）。现在整条 legacy 分支不参与路由，只用来喂用户头像那颗芯片。
- **③ `vscode-only` shell 退役**：自 2026-08-26 起它与 `not-installed` 是同一件事（随包 bundle 缺失），
  而它提供的「去装 Claude CLI」**修不好它被显示出来的那个问题** —— 不只是死代码，是错的。
  两者合并为 `runtime-unavailable`。
- **④ 文案落选 `Bring Your Own Key`**（用户口述用词）：比这条路的语义窄。
  [E1 §L1](../../../plans/2026-08-27-e1-local-credentials/README.md) 实测官方**订阅登录**单独就够用。
- **⑤ 主按钮不写死域名**：仓内允许后缀有**两个**（`@jcdz.cc` / `@wuhanjingce.com`），
  写死一个会把另一半用户挡在心理门外，以后加第三个还要改按钮。
- **⑥ 删 JSX 组件别用括号配对脚本**：自造的花括号匹配把 `CliRow` / `InstallProgressRow` 截成半个，
  还连带吃掉相邻的 `canSendCode` / `canVerify` —— 靠 typecheck 才顶出来。
- **⑦ 负向源码断言要限定到函数体**：「门禁里不许出现 `managed`」全文件扫会打到同文件的
  `resolveSpawnGateDecision`（它**合法地**保留 `managed` 入参）。已改为只切 `resolveGateDecision`
  的函数体，并加一条空切片守卫。

#### GUI 点验 — 2026-08-28 做掉一半（真机 CDP 截图）

**手法**：`node scripts/dev.js --remote-debugging-port=9222` + 一个极小 CDP 客户端
（`Page.captureScreenshot` / `Runtime.evaluate`，脚本在 scratchpad，未入仓）。

**已验（✅）**：
- 登录页确实是启动首屏，结构与参照一致（logo → 产品名 → 标语 → 两颗等宽纵向按钮 → 各一行小字）。
- **亮暗双主题都正常**，暗色下 logo 转暖调，文字对比度无异常。
- **流光真的在动** —— 隔 2 秒抓三帧，三帧互不相同。`x1.animVal` 在单次 evaluate 内不变会误判成「没动」，
  **必须靠跨帧比对**（`getAttribute` 更不行，SMIL 不反映在基值上）。
- **`use my own setup` 的写入通路端到端成立**：点完 `~/.pilab/<profile>/settings.json` 里
  `credentialMode` 确实变成 `local`。

**观感三条待定（都不是 bug，是取舍）**：
1. **按钮文字被设计系统强制小写** —— 屏幕上是 `log in with work email`，DOM 里是正确的大小写，
   `text-transform: lowercase` 来自 Button 的 cva 基类（仓内别处用 `className="normal-case"` 绕开）。
   参照的 Cursor 用 `Log In` 首字母大写，而这两颗是全屏最重的元素。**要不要加 `normal-case`，待用户定。**
2. **logo 偏小** —— 实测 72px，窗口 1718px 宽，占比约 4%；参照图里约占窗口宽 **1/8**（≈215px）。
   现在更像图标而非品牌标识，流光也因为太小而不易察觉。（2026-08-28 的 logo 改版可一并处理。）
3. **次按钮的说明文字折成两行**，右侧留白参差。

**仍未验**：**B 态（`Continue as <email>`）没在屏幕上看过** —— 需要真的登录一次；
长邮箱会不会把按钮撑破也因此未知。

#### 2026-08-28 补充 — 登录页文案 + logo 动效改版（用户直接拍板，非本 plan 立项）

用户绕过 kickoff 里「品牌口径统一为 Deferred」的范围，直接对**这一屏的可见文案**拍了板
（不是仓库层面的五名统一，`electron-builder.yml` 的 `productName`、组件/文件名、
`AICLIENT_*` 环境变量前缀等一律未动）：

- `WelcomeView.tsx` 的 `PRODUCT_NAME`：`AICLIENT` → **`PILAB`**。
- 标语：`Git worktrees, with agents that work in them.` → **`Just a really good one to code with ai.`**
  （`src/shared/i18n.ts` 里旧标语的中文条目已删——不再被引用；新标语**暂无中文翻译**，
  `t()` 未命中时按设计回落到英文 key，翻译词待用户自己定，不是本次施工的疏漏）。
- `AiClientMark.tsx`：立方体**形状不变**（期间试过 π 符号 / 光环 / 多棱体 / 磨砂玻璃等好几版，
  用户否掉后**明确要求改回最初的等轴测立方体**，代价是"和 Cursor 撞"那条顾虑也一并接受了）。
  变的是动效机制：原来是一个跑遍三个面的橙/绿/蓝三色渐变（`animate` 跑 `x1`/`x2`）；
  现在每个面画两遍——一层 `var(--primary)` 静态底色（不透明度维持原来的 0.95/0.75/0.55 分层），
  另一层纯白、只动 `opacity`（0→0.5→0），三层顶/右/左依次错开 2 秒（共享 6s 周期的 1/3），
  亮度峰值按这个顺序交棒，观感是一束光顺时针绕立方体转，不是三个面各闪各的。
  `var(--primary)` 仍在用（主题自适应，`authGateWiring.test.ts` 的 `[A2-08]` 断言钉着这条，没有绕开）。
- 全过程先在独立预览文件里迭代到用户明确说"敲定了"才落地产品代码，
  随档留了一份：[`logo-concepts-preview.html`](../../../plans/2026-08-27-entry-design/logo-concepts-preview.html)
  （5 轮改版都在同一个文件里叠代，末版即最终拍板的样子）。

**验证**：typecheck 0 · biome 0（改动的 3 个文件）· **vitest 248 文件 5029 例全绿**
（和 A2 落地时同一组数字，没有回归）。**未做**：GUI 点验——以上全部只在预览文件和自动化测试里看过，
**没在真正跑起来的 Electron 窗口里看过一眼**，和上面 A2/A3 欠的那笔是同一笔债，一并留到点验批次。

### ~~T-A2a — 中途切换的入口~~ ❌ 作废（2026-08-27，[D71](../../../plans/openchamber-chat-refactor-ledger.md)）

它存在的前提是「登录页选过一次就不再出现」，而 D71 把登录页定成**每次启动都出现的首屏**。
⇒ **重启就是切换**：关掉再开，同样两颗按钮回到眼前，不需要另造入口。

留一条记录以免有人再想一遍：**在途会话怎么办**这个问题也一并消失了 ——
模式只能在**还没进门时**改，不存在「运行中切换」这个状态。

### ~~T-A2b — spawn 闸仍按「A2 之前的世界」判人~~ ✅ 已拍板并落地（2026-08-28，[D72](../../../plans/openchamber-chat-refactor-ledger.md)）

立票时写的「产品里今天炸不了」**被用户真机证伪** —— 打包版（`71f9086f`）走「使用本地环境」照样满屏
`auth_required`。真因是另一个 bug（见下面 T-CM1），但它恰好把立票理由演示了一遍：
挡住这条拒绝分支的只有「模式记对了」一个条件，而那个条件被另一处代码单方面改写了。

**已落地**：闸的判据换成**本次运行是从哪颗按钮进来的**。

- `services/auth/appEntry.ts` 的会话闩由 `boolean` 拓宽为 `CredentialMode | null`
  （`markAppEntered(mode)` / 新增 `getAppEntryMode()`，`hasEnteredApp()` 语义不变）。
- `shared/authGate.ts` 新增 `resolveSpawnCredentialMode({entryMode, managed})`：**入口优先，记录的模式只做 fallback**，
  只在「还没进门就发起 spawn」这种启动竞态里回答。`spawnGate.ts` 的零 IO 快路径与门禁本体共用这一个函数，两者不可能答不一样。
- **边界没有被溶解**：从「公司账号」进来的运行，中途登出 / 凭据被拒**照旧拒绝** ——
  否则登出的人会静默改用自己机器上的钥匙继续跑，那正是这道闸存在的理由。

**验证**：typecheck 0 · biome 0 · vitest 249 文件 5038 例全绿。新增 5 条断言
（shared 3 条覆盖规则本身、main 2 条覆盖 Main 有没有真把入口喂进去，取「入口与文件互相矛盾」的两个方向）。

<details><summary>立票时的原文（保留）</summary>

**症状**（真机）：点「使用本机已有配置」进主界面后，**历史对话打不开、切了 agent 也起不来**，
日志里三条一模一样的 `chat:resumeSession → auth_required: Sign-in required before starting an agent session.`

**根因**：`assertAgentSpawnAllowed`（`main/services/auth/spawnGate.ts`）问的是
**「是不是托管模式」**：托管 + 未登录 ⇒ 拒。这在 A2 之前永远碰不到 ——
旧门禁根本不让「未登录」的人进主界面。**A2 把「人在主界面里、但没登录」变成了正常可达状态**
（第二颗按钮的全部意义），那条拒绝分支于是第一次被走到。

**产品里今天炸不了**：点第二颗按钮会写 `credentialMode='local'`，
`resolveManagedCredentialsEnabled()` 读到 `local` 返回 false，闸直接放行。
**开发模式里炸了**，因为 `dev.env` 的 `AICLIENT_MANAGED_CREDENTIALS=1` 覆盖了那个记录值
（见 [baseline GUI 联调环境](../../baseline/test-and-release-gates.md) 坑 ②）。

**为什么仍要立票**：挡住它的只剩「模式记对了」这一个条件，离出事只差一次配置不一致；
而失败形态很难受 —— **人已经在主界面里、从没被要求登录过，然后每个动作都回一句
「Sign-in required」，界面上没有任何可点的下一步**。

**建议方向（未拍板）**：闸不该问「是不是托管模式」，而应问「**这次是怎么进来的**」——
复用 A2 已有的会话闩（`services/auth/appEntry.ts` 的 `hasEnteredApp()`），
或把进门时选的模式一并记进会话状态供闸读取。**这属于安全边界的改动，需用户点头再动。**

</details>

### ~~T-CM1 — `settings.json` 双缓存把 `credentialMode` 抹掉~~ ✅ 已修（2026-08-28，用户真机反馈批）

**这一条才是 2026-08-28 两个真机症状的共同根因**，且它比 A2 老得多 —— A2 只是让它第一次有了可见后果。

**机制**：`settings.json` 有两套互不通气的缓存。`main/ipc/settings.ts` 自己存一份，
**由渲染进程第一次读时定格、此后永不刷新**；`credentialMode` 却由 `services/auth/credentialMode.ts`
绕过它、经 `SharedSessionState` 直写。渲染进程的设置持久化是**读整份 → 改一个键 → 整份写回**
（`renderer/stores/settings/storage.ts`，zustand persist），于是任何一次设置保存都把定格的旧值写回磁盘。

- **症状①** 选「使用本地环境」后 codex/claude 全部 `auth_required`：写进去的 `local` 被抹掉 ⇒
  读不到该键 ⇒ 按 D64 默认回 `managed` ⇒ 闸判「托管 + 未登录」⇒ 拒。
- **症状②** 登录后 Claude 报 `Failed to authenticate ... Attention Required! | Cloudflare`：
  上一轮测试留下的 `local` 被写回、覆盖掉登录时写的 `managed` ⇒ Agent Host 起进程时读到 `local` ⇒
  **不注入公司 url+key** ⇒ Claude Code 退回用户本机 `~/.claude` 配置 ⇒ 请求打到 api.anthropic.com ⇒ 境内被 Cloudflare 拦。
  用户自己先判对了这一条（原话「好像是因为用了我本地的环境，而并非注入」）。

**修法**（用户在两个可选口径中选定「消除双缓存 + 主进程私有键写入保护」）：

1. `ipc/settings.ts` 的模块级快照从「文件缓存」改名改义为**渲染进程待落盘负载**（`pendingRendererSettings`），
   读一律经 `SharedSessionState`（那边本来就有 memo 且写时失效，第二层缓存只会制造分歧）。
2. 渲染进程整份写回时，`credentialMode` / `onboarding` 两个主进程私有键**在落盘那一刻**从当前文件重取；
   **缺失也照搬缺失** —— 缺失本身有含义（没记录过 = 首次运行 = 必须登录），所以渲染进程既不能改写、也不能凭空造出这个键。
3. `mergeSettingsPatch` 不走该保护 —— 它正是**设置**这些键的那条路，套上去会把自己要打的补丁盖回去。

**验证**：新增 `src/main/ipc/__tests__/settingsMainOwnedKeys.test.ts` 4 条。
**反向咬红两发**：把双缓存改回旧写法 ⇒ 红 3；把私有键覆盖改成直通 ⇒ 红 2 —— 两半各自被独立钉住，不是一条断言兼职。

## Next（按依赖序）

### T-M1 — Codex 模型菜单为空 + `opus[1m]` 串到 Codex 会话上（**2026-08-28 用户截图批，已定性未修**）

两条都在同一张截图里，但不是同一件事。

**① `opus[1m] · unverified` 显示在 Codex 会话上。** 这个 id 来自 Host 上报的默认模型，
也就是用户本机 `~/.claude/settings.json` 里的 `model` 字段。跨 agent 守卫
（`shared/models/familyWhitelist.ts` 的 `resolveModelAgentOwner`）只拦**能证明属于另一方**的 id ——
判据是 `claude-` / `gpt-` / `codex-` 前缀加三个 legacy 短名（`opus`/`sonnet`/`haiku`）。
`opus[1m]` 一条都不匹配 ⇒ 判为「无主」⇒ 允许挂到 Codex 上。
守卫的三值设计本身是对的（§4.4-6 要求被过滤掉的历史选择仍能在选它的会话里用），
要改的是**判据够不够认得公司网关的命名**，不是把它改成成员资格测试。

**② `No models offered for this agent — Automatic will be used`。**
这句文案的含义是「网关答了，按 Codex 家族过滤后一个都不剩」（不是「取不到目录」，那是另一句 seed 文案）。
⇒ 网关 `/v1/models` 返回的列表里没有 `gpt-` / `codex-` 形状的 id。

**开工前必须先拿到的东西**：那台机器上网关 `/v1/models` 的**原始返回**。
没有它无法判定是网关侧没配 Codex 模型，还是我们的家族过滤器不认它的命名 —— 两种修法完全相反。

### T-E1a — 失败面两张票（**已由 [D68](../../../plans/openchamber-chat-refactor-ledger.md) 重定范围到登录线，低优先级，不再是 A2 前置**）

**D68 拍掉的是这两张票在「第二个按钮」那条路上的部分** —— 那条路上炸了就炸了，用户自己选的。

**没被拍掉的一半**：同样这两个缺陷**在登录那条路上照样发生** —— 公司 key 过期或被网关拒时，
登录用户看到的也是「请登录」并等约三分钟，而**那条路的可用性是我们承诺的**。
所以票不删，范围收到登录线。

- **票 ①** `api_error_status` 被丢掉 ⇒ 「没登录」与「钥匙被拒」**同一句话**。
  `src/agent-host/eventNormalizer.ts` 的 `result` 分支把 `is_error` 折成 `session.failed`，
  `payload.error` 取 `msg.error ?? msg.result`，而 L0 与 L10 的 `msg.result` 是同一句
  `Not logged in · Please run /login` —— 唯一能分辨的字段正是被丢掉的那个。
- **票 ②** Claude 侧被拒的凭据要等 **约 180 秒 / 8~11 发重试**才终止（L10 计时；同场景 codex 约 6.5 秒，X13）。

⚠️ 上屏前另需脱敏：codex 的终局错误正文里**带网关 URL**（X13）。

## Deferred

- **`agent-host` 的 `process.env` 复制抹不掉删除动作**（2026-08-28 顺手发现，未修，非本次症状成因）——
  `agent-host/index.ts` 把 `loadClaudeSettingsEnv()` 的结果**逐键复制**到 `process.env`，
  而 `claudeSettings.ts` 对托管凭据做的是 `delete env.ANTHROPIC_API_KEY`：**删除复制不过去**。
  CLI 子进程本次不受影响（SDK 实测 `xt ? {...xt} : {...process.env}`，给了 `options.env` 就不合并 `process.env`），
  但 Host 自身环境里用户的 key 仍在，属潜在串号面。
- **远端** —— 用户 2026-08-27 明确本轮不考虑。
- **品牌口径统一** —— 现在是五个名字，记在
  [unified-credentials open-q #4](../unified-credentials/open-questions.md)，与本 plan 无依赖。
