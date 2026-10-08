# 决策 159：GW-16 临时开关——工具定义上的缓存断点，默认关（每请求最多 2 个 `cache_control`）

日期：2026-10-08。**状态：按用户裁决（[决策 149](149-user-rulings-2026-10-07.md) 第 19 条）实现，实现取舍待审批。**

依据：

- [决策 146](146-real-gateway-followups.md) 第 23～27 条（GW-16 调查：我们的 anthropic-messages 请求最多 3 个 `cache_control`，可选降级是给 claude 路由设 `compat.supportsCacheControlOnTools: false`）；
- [决策 149](149-user-rulings-2026-10-07.md) 第 19 条（做临时开关：AI 设置页加「实验」开关，默认 2 个，打开恢复 3 个，下一轮生效，main.log 记当前模式；测试结束后删掉或转正）；
- [决策 040](040-default-effort-and-settings-mapping.md) 第 3 条（我方设置映射到 DSH 路由级参数）、[决策 077](077-model-plan-implementation-choices.md) 第 5 条（设置改变修订号，靠修订号比对重启宿主）、[决策 085](085-model-plan-wiring-implementation-choices.md) 第 5 条（计划只在三处重建）、[决策 141](141-model-plan-adaptive-thinking-hardening.md)（DSH 的 compat 合并：行级逐字段压过路由级）。

代码一个提交（`a62319cd`，`feat(settings)`），本决策一个 `docs(plan)` 提交。没有起 Electron，没有连真实网关；模型请求只发往本地假网关。

## 1 落地了什么

1. **设置键**：`experimentalCacheControlOnTools`（布尔，渲染层设置 store 持久化，与 `promptCacheTtl` 同一条链路：渲染层 store → 设置文件 → Main 经 `readSettingsState` 读）。**默认 `false`**。常量与默认值在 `src/shared/types/cacheControlOnTools.ts`，渲染层 store 的默认值引用同一个常量。
2. **映射**（`src/shared/dshModelPlan/build.ts`）：
   - 关（默认，含设置里显式 `false`、从没碰过、存了非布尔值）：**每条 anthropic-messages 路由**的 `compat` 写 `supportsCacheControlOnTools: false`。pi-ai 于是不给最后一个工具打断点，每个请求只剩 system 1 + 最后一条 user 消息 1 = 2 个。
   - 开：计划里不写这个字段，按 models.json 原样（与开关出现之前完全相同，3 个）。
   - **按协议判，不按名字判**：托管目录的 `claude`、用户自建服务里协议为 anthropic-messages 的路由、同一个 provider 按模型拆出来的 anthropic-messages 子路由（`xxx~2`）都算；openai-completions、openai-responses 两种协议的路由一字不动（openai-completions 自己的 `cacheControlFormat` 也不碰）。
   - **某一行自己在 models.json 里声明了 `supportsCacheControlOnTools`**：关时这一行也写成 `false`。原因是 DSH 的 `resolveModelCompat` 让行级逐字段压过路由级（决策 141 同一规则），只写路由级挡不住一行自己写的 `true`。开时行级声明原样保留。目前随包目录与公司目录都没有行声明这个字段。
3. **修订号**：`compat` 进入 `routes`，修订号随模式变化；计划里没有 anthropic-messages 路由时两种模式修订号相同（没东西要重启）。
4. **生效时机：下一轮，不用重启应用**。
   - **确认结果：现有机制不会因为改设置而触发**。决策 085 第 5 条规定计划只在三处重建（打开模型菜单、托管同步成功、拉起宿主）；渲染层的模型菜单有自己的缓存，只在宿主状态变化时重取。所以改 `promptCacheTtl` 这类设置后，正在跑的宿主要等下一次菜单重取、同步或宿主重启才拿到新计划，并不保证「下一轮」。
   - 因此本开关加了一个 Main 侧的监听：`ipc/settings.ts` 新增 `onRendererSettingsWrite`（渲染层每次保存设置、排进防抖队列的那一刻通知；此时 `readSettingsState()` 已经返回新值，不必等 500 ms 落盘）；`agent-host/cacheControlOnToolsSetting.ts` 的 `watchCacheControlOnTools` 只在这个开关的有效值翻转时调用 `resolveDshModelPlan()`，其余任何设置保存都忽略。
   - 重建后沿用现有链路：`onDshModelPlanBuilt` → `WorkerManager.reconcileModelPlan` → 没有在飞的工作时 `invalidateAll` 重启宿主（每 2 s 复查）→ 下一轮按新计划拉起宿主、`configure` 下发新计划。正在跑的那一轮不受影响，跑完才切。
   - 代价与托管同步换计划时一样：宿主重启时这台宿主上的会话按 `released` 收掉，下一轮再打开。
5. **main.log**（只记模式，不记计划内容）：
   - 每个新修订号记一行（与「left out of the plan」同一个「每个修订号一次」的闸）：`[dsh-plan] cache_control on tools: off (2 breakpoints max), plan 4031e408019a`；开时为 `on (3 breakpoints max)`。
   - 开关翻转时另记一行：`[dsh-plan] cache_control on tools switched on; new plan`（或 `off`）。随后照旧会有 `[worker-manager] the DSH host runs model plan … restarting it`。
6. **设置页**：放在「设置 · 模型」页（id `pi`，决策 144 改名，承载「AI 服务、模型管理、请求设置」；用户说的「AI 设置页」按这一页理解），排在「模型请求超时」之后，独立组件 `ExperimentalCacheControlSection.tsx`。
   - 标题「工具定义缓存断点」，旁边一个 warning 色徽标「实验 · 临时」；
   - 说明：「在 Claude（Anthropic Messages 协议）请求的工具定义上也打一个提示词缓存断点。关：每个请求最多 2 个 cache_control 标记；开：3 个。用于排查公司网关的 cache_limit 报错，测试结束后删除或转正。」
   - 行标签「缓存工具定义」+ @coss/ui `Switch`（`aria-label` 同标签），下方一行 `text-meta` 注记「从下一轮开始生效，无需重启。」
   - 中英词条在 `src/shared/i18n.ts` 文末单独一块。
7. **验证工具**：`fakeGatewayPlan` 新增可选的 `settings`（用户请求设置，Main 怎么读就怎么传）；新增探针 `src/dsh-host/tools/gw16-cache-control-probe.ts`（见第 2 节）。探针与录制工具的计划同样走默认值，即默认关。

## 2 两种模式实测（真宿主 + 假网关）

探针：一个假网关（plan `dsh-p0-2`），先后两台真宿主，各跑一轮 `P0-TOOL`（一次 bash 调用再回文字，所以每轮 2 个请求，每个请求都带 23 个工具），按 `X-Pilab-Client`（`gw16-off` / `gw16-on`）拆假网关请求日志里的 `cacheControl` 计数（决策 146 第 24 条加的，只记数量与位置）。

| 模式 | 计划（`aiclient-gateway` 路由 compat） | 修订号 | 请求 | 工具数 | `cacheControl` 合计 | system | tools | messages | 顶层 |
|---|---|---|---|---|---|---|---|---|---|
| 关（默认） | `{ supportsCacheControlOnTools: false }` | `d290f251ab25…` | #1、#2 | 23 | **2** | 1 | **0** | 1 | 0 |
| 开 | 无 | `1de56f1aedb6…` | #3、#4 | 23 | **3** | 1 | **1** | 1 | 0 |

10 项检查全过（两台宿主就绪、两轮 bash 成功、计划字段、修订号不同、两种计数、两台宿主 `shutdown` 退出码 0）。

手动复跑（不进 CI：要拉起两台真宿主，每台 200～350 MB；可用内存低于 800 MB 时拒绝启动；开发机上单独跑，旁边不开 Electron、不跑 Vitest）：

```bash
cd src/dsh-host && ../../out-node-runtime/node tools/gw16-cache-control-probe.ts [--out /tmp/gw16.json] [--keep]
```

需要 `out-node-runtime/node` 与 `src/dsh-host` 里已 `npm ci`。退出码 0 = 全部检查通过，标准输出是检查表与每个请求的计数。

未覆盖：

- key 含 `sk-ant-oat`（OAuth）时 pi-ai 把 system 拆成两块各带一个断点（决策 146 第 25 条），那时关 = 3、开 = 4。公司网关的 key 是否这种格式仍未读（不读凭据）。
- 一次性补全（提交信息、分支名、代码审查）本来就没有工具，两种模式都是 2 个，不变。

## 3 测试

- `src/shared/__tests__/cacheControlOnTools.test.ts`（新，3）：键名、默认 `false`、只认布尔、日志行文字。
- `src/shared/dshModelPlan/__tests__/dshModelPlan.test.ts`：新增一组 7 条（默认关时 anthropic 路由写 `false`、其他协议不写；显式 `false` 与默认相同；开时不写；行级声明的覆盖；按模型拆出的子路由按协议判；修订号只在有 anthropic 路由时变化；路由级参数不受影响）；MP-04 第一条的路由 compat 期望补上 `supportsCacheControlOnTools: false`（默认值变化的直接结果）。
- `src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts`：新增 2 条（随包目录 + 一个用户 anthropic 服务：关 / 开的路由 compat、其他三条路由两种模式相同、修订号不同；翻转后的计划经 `onDshModelPlanBuilt` 下发、模式日志每修订号一行且不含 key）；原「每个修订号只记一次 left out」那条改为按前缀过滤计数（多了模式行）。
- `src/main/services/agent-host/__tests__/cacheControlOnToolsSetting.test.ts`（新，9）：读设置（缺省 / 布尔 / 非布尔）；监听只在翻转时重建、缺省与 `false` 视为同一模式、重建抛错只记日志、可退订；**经真实 `ipc/settings.ts` 的 `SETTINGS_WRITE`**：保存排队那一刻（防抖还没落盘）就重建，重建时读到的已是新值，其他键的保存不触发；接线静态断言（`dshHostModelSource.ts` 装了监听、`piModelConfig/index.ts` 把设置读进计划）。
- `src/renderer/components/settings/__tests__/experimentalCacheControlSection.test.ts`（新，挂载，1）：store 默认 `false`，标题 / 「实验 · 临时」/ 说明 / 注记都在，开关点开写 `true`、再点写 `false`。`electronAPI.settings` 桩放在 `vi.hoisted`。

## 4 金样本

- `bridge-record --check`：28 个场景无差异。录制样本不含路由 compat 与 `cacheControl`，所以默认关不改样本。
- **需要编排者重录一份**：`src/main/services/piModelConfig/__tests__/fixtures/dshModelPlan.snapshot.json`。重录前 MP-01 失败，差异只有两处，都是本决策的预期结果：
  - `routes.claude.compat` 多一项 `"supportsCacheControlOnTools": false`；
  - `revision`：`b8679f8db240dd489388cf3145eb2a4036c97aedab39ecde713a932811d4ed01` → `4031e408019abe07089e2d96f641aa36beae74b17b746c67fab570d46311bb2d`。

  重录命令（文件头已写）：`AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts`，再 `pnpm exec biome format --write src/main/services/piModelConfig/__tests__/fixtures`。

## 5 删除时要动的文件

删除开关、回到 3 个（或转正后去掉开关、固定为 2 个）时：

整文件删除：

- `src/shared/types/cacheControlOnTools.ts`
- `src/shared/__tests__/cacheControlOnTools.test.ts`
- `src/main/services/agent-host/cacheControlOnToolsSetting.ts`
- `src/main/services/agent-host/__tests__/cacheControlOnToolsSetting.test.ts`
- `src/renderer/components/settings/ExperimentalCacheControlSection.tsx`
- `src/renderer/components/settings/__tests__/experimentalCacheControlSection.test.ts`
- `src/dsh-host/tools/gw16-cache-control-probe.ts`

撤回片段（都带「GW-16」或「decision 159」注释，可 `rg -n "decision 159|GW-16|CacheControl|cacheControlOnTools" src` 找齐；其中 `fake-gateway.mjs` 与 `tables.ts` 的命中是决策 146 的计数日志与 DSH 白名单原有内容，不动）：

- `src/shared/dshModelPlan/types.ts`：`DshRouteSettingsInput.cacheControlOnTools`；
- `src/shared/dshModelPlan/build.ts`：导入、`cacheControlOnTools` 常量、`cacheControlCompat` 与两处调用（转正固定为 2 个时，保留 `cacheControlCompat` 去掉开关判断即可）；
- `src/shared/dshModelPlan/__tests__/dshModelPlan.test.ts`：GW-16 一组与 MP-04 的那一项；
- `src/main/services/piModelConfig/dshModelPlan.ts`：模式日志与导入；
- `src/main/services/piModelConfig/index.ts`：`...cacheControlOnToolsSettings()` 与导入；
- `src/main/services/piModelConfig/__tests__/dshModelPlan.test.ts`：GW-16 一组、「left out」那条的计数改回 1；
- `src/main/services/agent-host/dshHostModelSource.ts`：`watchCacheControlOnTools(...)` 与两处导入；
- `src/main/ipc/settings.ts`：`onRendererSettingsWrite` 与保存处理里的通知循环（没有别的用户时一起删）；
- `src/renderer/stores/settings/types.ts`、`index.ts`：字段、默认值、setter、导入；
- `src/renderer/components/settings/PiModelManagementSettings.tsx`：导入与 `<ExperimentalCacheControlSection />`；
- `src/shared/i18n.ts`：文末「decision 159」那一块；
- `src/dsh-host/tools/lib/hostClient.ts`：`fakeGatewayPlan` 的 `settings` 选项（通用，可留）；
- 重录 `dshModelPlan.snapshot.json`（回到 3 个时 compat 与修订号恢复本决策之前的值）；
- 用户设置文件里留下的 `experimentalCacheControlOnTools` 键无害；要清就把它加进 `src/renderer/stores/settings/migration.ts` 的废弃字段清单。

## 6 疑点

1. **`promptCacheTtl`、`providerIdleTimeoutMs` 有同样的「改设置不触发重建」缺口**（第 1 节第 4 条）：它们的设置页注记写「在对话下一次启动运行时生效」，而宿主是共享的、只在三处重建计划，实际要等下一次菜单重取、同步或宿主重启。本次没有把监听扩到这两项（范围外），`onRendererSettingsWrite` 已经可以复用，是否扩展待定。
2. 开关翻转后的宿主重启会收掉这台宿主上所有空闲会话（与托管同步换计划相同）；测试期间来回切换会比较频繁地看到会话重新打开。
3. 开关放在「模型」页而不是 Git 页里的「AI 功能」（后者管提交信息、代码审查这类一次性补全）；如果用户说的「AI 设置页」指后者，挪动只涉及 `PiModelManagementSettings.tsx` 的一行渲染。

## 用户审批

待审批。
