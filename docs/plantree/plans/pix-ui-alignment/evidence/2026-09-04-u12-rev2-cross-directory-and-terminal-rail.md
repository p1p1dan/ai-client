# Evidence — U12 rev.2 跨目录门 + 终端入口下线

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**归属**：U12（批次 2.5）第二次修订 + 一项 UI 精简（顶栏终端按钮）
**触发**：用户报「选了 hands-off 写文件还是弹权限请求，切 full access 也一样，权限是不是压根没生效」
**相关**：[U12 首次修复](./2026-09-03-u12-tier-spawn-drift-fix.md)、[evidence-u12](../topics/evidence-u12-session-permission-tier.md)

## 一、先说结论：档位没坏，用户撞的是另一道门

从用户当时那次会话的裁决日志
（`~/.pilab/t37c-agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`，
02:44–02:48 EDT）逐条读出来：

| 时间 (UTC) | 档位 | 门 | 我们的裁决 | 最终 |
|---|---|---|---|---|
| 06:46:07 | handsoff | `external_directory` | defer | 弹窗，用户手批 |
| 06:46:10 | handsoff | `write` | **allow** | 自动通过 |
| 06:47:34 | fullopen | `external_directory` | allow | **仍然弹窗**（`decidedBy: user via select`）|
| 06:47:35 | fullopen | `write` | allow | 自动通过 |

用户写的是 `/home/ai/code/test/ceshi.txt`，**在会话工作目录之外**。这条路径要过两道门：
先 `external_directory`（跨目录访问），再 `write`（写文件）。hands-off 只免第二道，所以第一道照弹。

fullopen 更隐蔽：我们的链**判了 allow**，但上游的 bounded-delegation envelope
（ADR 0007 §5）把任何链对 `path` / `external_directory` 的 allow 一律降级为 defer，
所以那次「移除本对话限制」的二次确认在用户真正撞上的这道门上**一点用都没有**。

## 二、诊断路径（记下来是因为它绕了远路）

一开始查错了目录：dev 运行时的 agentDir 由 `dev.env` 的
`PI_CODING_AGENT_DIR=/home/ai/.pilab/t37c-agent` 决定（T37-c 留下的点验用 agentDir），
不是 `~/.pi/agent`、也不是 `~/.pilab/jyw-ai-client-dev`。前者是用户自己 pi CLI 的日志（开着 yolo），
后者压根没有 permission 插件目录——两处都读不到 app 的真实裁决，一度把结论引向「链没注册」。

**下次直接看这两处**：`~/.config/jyw-ai-client-dev/logs/`（app 自己的日志，只记 error）
和 `$PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs/`（逐条裁决，含 `session-tier` 与 `decidedBy`）。

过程里新增了两个可复跑探针（保留在 `src/agent-host/spikes/`）：

- `u12-tier-probe.ts` — bootstrap 一次，打印 agentDir / gate（bundled 还是 user_configured）/
  链是否注册 / 各 surface 的策略状态与 origin。`FORCE_BUNDLED=1` 可强制注入随包副本。
- `u12-tier-turn-probe.ts` — 跑**真回合**，让 agent 往工作区外写文件，直接看有没有弹对话框。

探针还顺带证实了一件与本次修复无关、但值得记住的事：**当用户自己的 `~/.pi/agent/settings.json`
里装了 `@gotgenes/pi-permission-system` 时，gate 判为 `user_configured`，我们随包的 `config.json`
（含 `authorizerChain`）整份不参与**——那种情况下权限档确实会完全失效。dev 因为
`PI_CODING_AGENT_DIR` 指向干净目录而走 `bundled`，所以本次不受影响。**这是一个已知未修的缺口**，见第五节。

## 三、拍板与修法

用户拍板：**只放开 full access**（hands-off 维持跨目录仍确认）。

`scripts/patch-pi-permission-system.mjs` 增加一条分发者补丁，让
`AuthorizerSelection.resolveConfiguredLinks` 对 `aiclient-session-tier` 这一个名字跳过 envelope：

```ts
links.push({
  name,
  authorize:
    name === AICLIENT_UNENVELOPED_LINK ? authorize : encloseInDelegationEnvelope(authorize),
});
```

理由写在补丁注释里：envelope 防的是**第三方裁判**（模型判官、外部服务），而这条链携带的是
**用户在本应用 UI 里亲手选的档位**，且唯一放行这两个面的 `fullopen` 背后就有一次
「移除本对话限制？」的显式确认。范围刻意只有一个名字——用户自己装的任何链仍在 envelope 内。

**deny 不受影响**：deny 规则在链被咨询之前就已裁决，所以 `permissionPolicy.mjs` 里的密钥文件
deny（`*.env` / `*.pem` / `~/.ssh/*` / `~/.aws/credentials` …）在 `fullopen` 下同样拦得住。

同步改的文案（这才是最初「看起来像坏了」的直接原因）：

| 档 | 旧文案 | 新文案 |
|---|---|---|
| hands-off | 文件修改直接生效；命令仍会询问 | **工作区内**的文件修改直接生效；命令、**以及工作区之外的任何操作**仍会询问 |
| full access | …密钥文件保护**与跨目录确认**仍然生效 | …**包括工作区之外的写入**；密钥文件保护仍然生效 |

## 四、验收

**真回合验证**（`u12-tier-turn-probe.ts`，真模型 `cx2/gpt-5.6-sol`，写 `/tmp/…/probe.txt`，工作区在另一个 `/tmp` 目录）：

| 档 | 对话框 | 文件 | 裁决来源 |
|---|---|---|---|
| `fullopen` | **0** | 已写 | `decidedBy: {kind: authorizer, name: aiclient-session-tier}`，`external_directory` 与 `write` 各一次 |
| `handsoff` | **1**（`external_directory`）| 未写（回合卡在对话框上超时）| 链判 defer，交回人工 |

即：放开的是且仅是 full access，hands-off 的跨目录确认原样保留。

**门禁**：全仓 **261 files / 4067 tests pass**；`pnpm typecheck` pass；`pnpm typecheck:agent-host` pass；
biome 960 files 干净。补丁脚本二次执行输出 `already applied`（幂等）。

## 五、欠项

- **`user_configured` 路线下权限档仍然完全失效**（第二节末）。用户在自己的 `~/.pi` 里装了同一个插件时，
  `authorizerChain` 名字没人配，我们的链注册了也永不被咨询，四个档位一律等同于「务实」。
  不写用户的 `~/.pi` 是既定红线，所以修法要另想（Host 侧自动应答 / 始终注入随包副本 / 明示降级），
  尚未拍板，也未开任务。

  > **2026-09-05 更正 + 已处理**：上面「一律等同于『务实』」**说错了**。等同的是**用户自己的策略**，
  > 而本机用户那份 `~/.pi/agent/extensions/pi-permission-system/config.json` 实测是
  > `{"yoloMode": true, ...}`——比任何一档都宽。用户拍板走**明示降级**
  > （[D10](../decisions/010-user-configured-gate-explicit-degradation.md)），已落为
  > [U20](./2026-09-05-user-configured-gate-degradation.md)：界面不再假装四档可用。
  > 档位在这条路径上**依然没有功能**，真正恢复要走「始终注入随包副本」，前置是双插件加载语义探针。
- **打包侧需重跑 `pnpm build:agent-host`**：`out-agent-host/` 里的插件副本与 `config.json` 仍是 09-02 的旧版
  （连 `authorizerChain` 都没有）。dev 走 `src/agent-host/`，不受影响；发布前必须重建。
- GUI 点验仍与 U09/U12/U02/U03-a/U05/U08-2 合并待做。

## 六、同批的 UI 改动：终端入口下线

用户要求去掉顶栏右侧那组 surface 按钮里的终端图标。做法是把 `surfaceRegistry` 里 `terminal`
的 `registeredOnly` 翻成 `true`——它是 `shellLayoutModel` 每个守卫都读的同一个标志，
一处翻转就同时关掉按钮、面板 tab、rail 数字键，不会留下「看着有绑定、按了没反应」的死键。

连带移除 `Ctrl/Cmd+`` `（`open-terminal` action 整条删除，`useShellShortcuts` 不再取 `openSurface`），
理由同上：目标 surface 已不可选，留着就是死键。`Ctrl/Cmd+1..4` 因此收敛为 `1..3`（git/files/context）。

`TerminalSurfaceView` 与 `surfaceViews.tsx` 的注册**保留**：surface 本身还在，只是没有入口，
一条历史 `lastSurfaceId: 'terminal'` 也仍能被 `getSurface` 解析而不炸。

测试同步更新 4 个文件（`surfaceRegistry` / `panelTabsModel` / `shellShortcuts` / `shellLayoutModel`），
其中新增两条**防回归**断言：陈旧的 `railOrder` 里即使 `terminal` 排在第一位也必须被丢掉；
`isRailSelectableSurface('terminal')` 必须为 `false`。
