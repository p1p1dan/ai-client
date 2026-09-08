# Evidence — A3 模型目录随包快照

**日期**：2026-09-08 · **分支**：`feat/model-catalog-admin` · **环境**：Linux 6.12.94，本机小服务器（资源受限）。

## 落地

| 文件 | 改动 |
|---|---|
| `resources/model-catalog/snapshot.json` | 新建（当前是**空占位**，见下） |
| `resources/model-catalog/README.md` | 新建：谁读、谁写、必须满足的两条规则 |
| `src/main/services/piModelConfig/catalogSnapshot.ts` | 新建：定位 → 读取 → 校验 → 记忆化 |
| `src/main/services/piModelConfig/PiModelConfigService.ts` | `sync` 新增 `bundled` 档；`readState` 单点回落；`readCatalog` 新增 `bundled` 分支；`writeAll` 拆出 `writeRuntimeConfig` |
| `src/shared/piModelConfig.ts` | `PiModelSyncSource` **末尾追加** `'bundled'`（未重排既有取值） |
| `src/shared/types/agentCatalog.ts` | `AgentModelCatalogSource` 追加 `'bundled'` |
| `src/renderer/components/chat/piModelCatalog.ts` | 新增 `BUNDLED_CATALOG_NOTICE` 与 `bundled` 状态行 |
| `src/renderer/components/settings/PiModelManagementSettings.tsx` | `sourceLabel` 新增 `'Shipped baseline'` |
| `src/shared/i18n.ts` | 两条中文（随包基线 / 目录不可达提示） |
| `scripts/refresh-model-catalog.mjs` | 新建：拉取 → 预检 → 原子替换 |
| `scripts/verify-release-metadata.mjs` | 新增快照与打包项的静态门禁 |
| `electron-builder.yml` | `extraResources` 打包快照 |
| `package.json` | 新增 `refresh:model-catalog` |

测试：`catalogSnapshot.test.ts`（10）、`PiModelConfigService.test.ts` 新增 8 条 A3 臂、
`model-catalog-snapshot.test.mjs`（14）、`piModelCatalog.test.ts` 新增 2 条。

## 五条判据的对应用例

| roadmap 判据 | 用例 |
|---|---|
| 1 损坏快照被拒且不使启动失败 | `catalogSnapshot.test.ts` › `rejects a corrupt snapshot without throwing` |
| 2 拉取失败 → 回落快照，`source='bundled'`，`endpointUrl` 如实报告 | `PiModelConfigService.test.ts` › `falls back to the snapshot when the fetch fails and nothing is cached` |
| 3 快照缺失 → 仍是 `unavailable` | 同文件 › `stays unavailable when there is no snapshot to fall back to` |
| 4 拉取成功 → 内存结果覆盖，`source` 回到 `'remote'` | 同文件 › `goes back to remote the moment a fetch succeeds` |
| 5 刷新动作不写盘（断言写盘路径未被调用） | 同文件 › `writes the snapshot where pi reads it, but never into the wire cache` |

另加四条 roadmap 未点名、但决定行为正确性的臂：

- **快照带 provider key 一律拒收**。快照在包内是**全局可读**的，所以读取端用
  `credentialsAllowed: false` 校验——这是唯一一处不用 `true` 的读取点，其余读的都是本机 0600 的
  已鉴权副本。臂：`refuses a snapshot carrying a provider key`。
- **零模型的快照等于没有快照**。否则 `bundled` + 空菜单与「管理端答复了但没启用任何模型」无法区分，
  正是 D03 消除的那种混淆。臂：`treats a snapshot with no models as no snapshot at all`。
- **本机自己的 stale-cache 优先于随包基线**。缓存曾经是这台机器的真实答案，基线从来不是。
  臂：`prefers this client's own stale cache over the shipped baseline`。
- **本地模式不借用随包基线**。local 模式的含义是「由用户自己的 `~/.pi/agent` 决定」，
  把我们的托管基线塞进去是答非所问。臂：`never lends the shipped baseline to a local pi installation`。

## 对判据 5 的口径说明（重要，非全绿粉饰）

roadmap 口径 3 / ADR 0134 §3 的原文是「既不写包内文件也不写用户缓存」。实现严格遵守这两条：
**包内 `snapshot.json` 在运行期永不被写**，**也不在用户目录留任何快照副本**——
`managed-models-source.json`（wire 缓存）在回落路径上明确**不写**，并有断言钉住。

但回落路径**确实会写 `models.json` 与 `auth.json`**。这是与 ADR 0134 的架构差异，必须记下来：
PI-Desktop 的快照只需进内存，因为它自己解析模型元数据；**我们的 pi Host 是另一个进程，
从 agent dir 的 `models.json` 读模型**。快照只进内存的话，下拉框会有模型、而每一轮对话都会失败——
比现状（下拉框为空、也跑不了）更糟。所以 A3 写的是「pi 要读的两个文件」，不是「快照的第二份副本」。

不写 wire 缓存还有第二个理由：wire 缓存的语义是「本客户端最后一次**拉到**的目录」。
用快照去种它，会让**下一次**失败的 sync 报成 `stale-cache`，从而毁掉口径 4 要求的
「UI 必须能说出这是随包基线」这一唯一信号。

## UI 侧（口径 4）

`PiModelSyncSource` 上的 `'bundled'` 有两个消费点，都已接线：

- 设置页徽标：`Shipped baseline` / 随包基线，与 `Cached`（本机拉过一次）明确区分。
- 模型菜单状态行：`Model catalog unreachable — showing the list this build shipped with`，
  单独一句，不复用 stale 那句。臂：`says a shipped baseline is a shipped baseline, not a cache`。

`bundled` **没有**被加进 `AUTHORITATIVE_CATALOG_SOURCES`，所以：
`isCatalogAuthoritative` 为 false（不会拿基线去给模型贴 `· unverified`），
`shouldRequestCatalog` 返回 true（不会因为菜单有内容就整个进程钉死在基线上）。两点都有臂。

## 发布流程接入点（Active TODO 第 5 项的结论）

**选定：独立的人工发布前步骤 + 静态门禁。明确不接 `dist:prereq`。**

理由：刷新需要一个客户端 API key 和可达的管理端。挂进 `dist:prereq` 会让**每一次离线构建和
每一次 CI 构建**都因为一个它本不该持有的凭据而失败。ADR 0134 把它放在 `release.mjs --tag` 里，
我们没有等价的 tag 脚本（且本项目测试构建走 workflow_dispatch，不推 tag）。

因此：

1. 发布前人工执行 `pnpm refresh:model-catalog --api-key <client key>`，把结果并入 release commit。
2. `pnpm verify:release` 静态校验：`electron-builder.yml` 必须带 `resources/model-catalog/snapshot.json`
   的 extraResources 项；快照必须是 `version: 1` 的合法 JSON；**且不含任何凭据键**。
3. `model-catalog-snapshot.test.mjs` 有一条臂反向钉住「不在 `dist:prereq` 里」，防止以后被顺手加回去。

**脚本预检里踩到并修掉的一个真 bug**：凭据扫描最初按键名匹配 `apiKey`，
会把 D01 每个 provider 都带的 `credentials: { baseUrl, apiKey }`（取值是 `'managed' | 'onboarding'`，
是**来源声明**不是凭据）全部误报——那样的扫描器只会被人关掉。已改为跳过 `credentials` 块，
并加了正反两条臂。`verify-release-metadata.mjs` 直接复用同一个函数，不另写正则（避免第二份权威）。

## 快照当前内容：已是真实目录

**2026-09-08 补记。** 管理端已部署，首份真实快照已用发布脚本对着线上端点拉取并落库：

```
node scripts/refresh-model-catalog.mjs --api-key <测试临时 key>
[model-catalog] fetching https://onboarding-jyw.pipidan.qzz.io/api/v1/models-config
[model-catalog] wrote resources/model-catalog/snapshot.json — 4 providers, 10 models
```

内容：`updatedAt: 2026-09-07T06:55:27.909Z`，4 个 provider（`claude` / `gpt` / `grok` /
`china`），10 个模型。**每个 provider 都是 `credentials: { baseUrl: 'onboarding',
apiKey: 'onboarding' }`**，文件里没有任何密钥——这正是它能进全局可读的安装包的前提，
脚本预检与 `verify:release` 都对此有断言。使用的临时 key 只出现在命令行，未写入任何文件。

**onboard 侧一行代码都没改**：`/api/v1/models-config` 返回的就是快照需要的形状
（`toClientCatalog` 吐裸 catalog 对象，正是 `validatePiManagedModelsConfig` 吃的东西）。
缺的一直只是部署和数据。

**由此新增一条发布门禁**：`verify:release` 现在拒绝零模型的快照
（「carries no models, so the offline catalog fallback would be inert」）。
理由是空快照会被读取端当作没有快照，从而**在其它检查全绿的情况下悄悄让离线兜底失效**。
只在发布期检查——对一个管理端尚未部署的工作树来说，空占位是合法状态。
已实测该门禁会失败并给出可执行的修复建议（临时替换成空快照跑了一次，随后还原）。

**格式化例外**：`biome.json` 排除了 `resources/model-catalog/snapshot.json`。
它是发布脚本逐字写出的生成物（`JSON.stringify(config, null, 2)`），
让发布步骤去复刻格式化器的数组折叠启发式，只会让下一次 biome 升级把构建搞挂。

**副作用与修复**：真实快照落库后，一条 D03 时代的老用例
（`reports the catalog as unavailable when neither remote nor cache exists`）开始失败——
它构造 service 时没注入快照读取器，于是拿到了仓库里真实的那份。这不是回归，而是新行为生效。
已把该 describe 块共用的 `service()` 助手显式改为 `readBundledCatalog: () => null`：
那些臂讲的是「remote → cache → 什么都没有」这条梯子，让仓库里的一个文件决定它们的成败，
等于让它们的结果取决于「上一次有没有人跑过发布刷新脚本」。

## 门禁执行记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| lint | `node_modules/.bin/biome check <20 个改动/新增文件>` | **通过**，`Checked 20 files. No fixes applied.` |
| typecheck | `NODE_OPTIONS=--max-old-space-size=1200 node_modules/.bin/tsc --noEmit` | **通过**，无输出 |
| test | `node_modules/.bin/vitest run scripts/__tests__/ src/main/services/piModelConfig/__tests__/ src/renderer/components/chat/__tests__/piModelCatalog.test.ts src/shared/__tests__/piUsage.test.ts src/renderer/components/workspace-shell/__tests__/runPanelModel.test.ts --maxWorkers=1 --no-file-parallelism` | **通过**，15 files / 199 tests，2.07s |
| release 门禁 | `node scripts/verify-release-metadata.mjs` | **通过** |

## 未跑到的门禁（如实记录）

- **未跑整套 `pnpm test`**，只跑了上述五个批次。本机资源受限，按 roadmap 小批次约定；整套以 CI 为准。
- **未跑 `pnpm lint`（全仓）**，只对改动文件跑了 `biome check`。
- **未跑 `pnpm build` / `dist:prereq` / electron-builder**。所以
  **「快照真的进了打包产物」只有静态证据**（`electron-builder.yml` 的 extraResources 项 +
  `packaging-config` 风格的 YAML 断言），**没有拆包实测**。这是 A3 最主要的未验证项，
  需要一次真实打包（或 CI 产物）确认 `<resources>/model-catalog/snapshot.json` 存在。
- ~~未对真实管理端跑过 `refresh:model-catalog`~~ —— **已跑通**（2026-09-08，见上一节）。
  真实 HTTP 路径、鉴权、预检与原子写全部实测通过。
- **未启动 Electron GUI**。设置页徽标与菜单状态行的新文案没有渲染层自动化覆盖
  （vitest 是 `environment: 'node'` 且只收 `*.test.ts`）。待点验项：
  拔网启动后模型菜单出现「随包基线」文案而非「缓存」；设置页徽标同上。
  按 roadmap 并入 [UI 对齐计划](../../pix-ui-alignment/README.md) 的累计点验。
- `process.resourcesPath` 分支只有构造候选路径的单测，**未在真实 packaged 进程里验证过**。
