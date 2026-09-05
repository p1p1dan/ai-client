# Evidence — M01–M05 模型配置迁入 onboard（2026-09-05）

跨两个仓库落地，两边各开分支 `feat/model-catalog-admin`，**只提交不推送**（用户 2026-09-05 拍板）。

## 拍板与取证更正

| 项 | 结论 | 出处 |
|---|---|---|
| Q01 空配置 | 空目录合法；硬编码 seed 删除 | [D03](../decisions/003-empty-catalog-is-legal-drop-seed.md) |
| Q02 `pi` 块 | 服务端显式返回，客户端保留 codex 推导兜底 | [D06](../decisions/006-explicit-pi-block-in-register-response.md) |
| Q03 管理页登录 | 静态环境变量口令，未配置则整体 503 | [D04](../decisions/004-admin-page-static-token.md) |
| Q04 端点地址 | 挂 onboard 域名；默认值取编译期 onboard 地址 | [D05](../decisions/005-catalog-endpoint-on-onboard-origin.md) |
| 管理页形态 | Vite + React 前端子项目（用户选，非推荐项） | 本文件 |
| 截图四字段 | 按 pi 实际支持的做 | 下方「pi 字段取证」 |
| M05 旧脚本 | 下线删除 | 本文件 |

**取证更正（D05）**：初稿写「默认值可取登录时记录的 `onboarding.serverUrl`」。施工时复核发现该字段
写入的是 `cchServerUrl`（cch 网关地址），不是 onboard 服务地址；onboard 地址在客户端只有编译期注入
一个来源。默认值优先级因此从三级缩为两级，已在 D05 内注明。

## pi 字段取证（管理页该做哪些字段）

读 `node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.d.ts` 的模型定义：
`id / name / api / baseUrl / reasoning / thinkingLevelMap / input / cost / contextWindow /
maxTokens / samplingParams / headers / compat`。对照用户截图里本仓 schema 没有的四项：

- **允许关闭思考** — 不是独立字段，就是 `thinkingLevelMap` 里有没有 `off`。做成档位勾选的一项。
- **默认思考强度** — `defaultThinkingLevel` 在 pi 里属于 `settings-manager` / `model-resolver`
  的用户设置，跟着人走不跟着模型走。不进管理页。
- **仅思考模式**、**工具调用** — pi 的模型定义里没有对应概念（最接近的是 `reasoning` 与 `compat`
  里一批细粒度 `supports*Tools`，语义都不是截图那两个）。不做，理由写进 onboard README。

## onboard 侧（M01 + M02）

提交 `5c0326d`（存储与端点）、`8dc988d`（管理页）。

- 存储：`model_providers` / `model_entries` / `model_config_audit` 三表（`bun:sqlite`）。
- 客户端端点 `GET /api/v1/models-config`：Bearer 登录 key，经 cch `pingProxyWithKey` 核实
  （60s 正向缓存，拒绝不缓存）；只返回启用项；返回**裸配置对象**而非 `{ok,data}` 信封。
  cch 不可达返回 **502 而非 401**——没得出结论不等于拒绝，客户端因此保留旧缓存而不是当作登出。
- 管理端点 `/api/admin/model-config`：静态口令；未配置 `MODEL_ADMIN_TOKEN` 时全部 503。
- 管理页 `/admin`：Vite + React + Tailwind v4，产物由 Hono 托管；未构建时 503 并说明要跑
  `bun run build:web`。目录类型抽到 `src/model-config-types.ts`，前后端共用一份声明。
- 门禁：`bun test` **134 通过**（新增 repo/wire/鉴权/两个路由/前端表单映射共 68 条）；
  `typecheck` 覆盖前后端两个工程；`biome check` 干净。顺带修好基线已红的 typecheck
  （三处测试 Config 字面量缺 `DEV_LOG_CODE`，收敛成 `tests/helpers/test-config.ts`）。

### onboard 真机点验（本地服务 + mock-cch）

| 项 | 结果 |
|---|---|
| `GET /admin` | 200，标题「模型配置管理」，截图渲染正常（口令门 / 目录 / 模型编辑三张） |
| 管理接口无口令 | 401 `UNAUTHORIZED` |
| 四种凭据组合建渠道 | 201，客户端目录里 `credentials` 逐项标注，managed 侧才带值 |
| 客户端端点 + 有效 key | 200，含管理员密钥 `sk-vendor-4242`，`Cache-Control: no-store` |
| 客户端端点 + 坏 key | 401 |
| 全部模型停用 | 200 `{"version":1,"providers":{}}` — 空目录是答案不是错误 |
| 管理视图 / 审计 | 都不含明文密钥（只有 `apiKeySet` 与后四位）；审计记时间/对象/改动/IP，记不到人 |

## ai-client 侧（M03 + M04 + M05）

- `sync()` 带 `Authorization: Bearer <登录 key>`；校验放开为
  **仅鉴权来源允许携带 provider key**（`configValidation.ts` 的 `credentialsAllowed`），
  本地/未鉴权来源仍然一律拒绝。
- 新增线上词汇 `credentials: { baseUrl, apiKey }`（`managed` / `onboarding`）。
  **缺席是第三种情况而不是默认值**：它标识 D01 之前的管理端，那时 `baseUrl` 一定是管理员填的、
  provider 不可能带 key，因此按 `{baseUrl: 'managed', apiKey: 'onboarding'}` 读，老端点继续可用。
- `writeAuth()` 改为按渠道取 key（管理员填的用管理员的，其余用登录 key）；
  写 `models.json` 时把继承项解析成登录 baseUrl——pi 要的是地址，不是「地址从哪来」。
- 新增 `managed-models-source.json`（0600）保存**线上原样**的目录。`models.json` 是 pi 的格式，
  丢了凭据来源，无法回答「这个渠道的 key 是管理员的还是登录的」，而 key 轮换后重写文件正需要这个答案。
- **D03**：删除 `createDefaultManagedConfig` 与三个写死的 `gpt-5.6-*`；
  `PiModelSyncSource` / `AgentModelCatalogSource` 的 `seed` 改为 `unavailable`；
  校验放开空 providers / 空 models；渲染层区分两句话——
  「拉不到目录」`UNAVAILABLE_CATALOG_NOTICE` 与「管理员没有启用任何模型」`MANAGED_EMPTY_CATALOG_NOTICE`。
- **M04**：默认端点 = 编译期 onboard 地址 + `/api/v1/models-config`；
  写死的 `http://127.0.0.1:3210/...` 退役。顺带把 `adoption.ts` 里重复的一份 onboard 地址常量
  合并到新的 `services/onboarding/serviceUrl.ts`。
- **D06**：注册应答的 `config.pi` 优先，缺失才回落 codex 推导。
- **M05**：`scripts/pi-model-admin.mjs` 与 `pnpm model-admin` 删除（用户拍板）；
  设置页文案改为指向 onboard 的 `/admin`，并说明「拉取会带上登录 key，配置里可能含管理员填的密钥」——
  原文案「管理接口不返回任何 key」在 D01 之后已不成立。
- 门禁：全仓 `vitest run` **274 files / 4202 tests 通过**；`tsc --noEmit` 干净；`biome check` 干净。

### 跨仓联调（客户端真实 `sync()` 打真实 onboard）

临时测试文件跑完即删，输出如下：

- `sync` → `source: 'remote'`，2 渠道 2 模型。
- `auth.json` → `pilab` 拿登录 key `sk-mock-…`，`vendor` 拿管理员 key `sk-vendor-4242`。
  这是 M03 第 3 项「按渠道取 key」的正面证据。
- `models.json` → `pilab.baseUrl` 解析为登录值 `http://127.0.0.1:13500/v1`，
  `vendor.baseUrl` 保持管理员填的 `https://vendor.example/v1`；文件内不含 `credentials`、不含任何 key。
- 客户端目录 → `pilab/gpt-5.6-luna` 带 `contextWindow: 272000` 与五档 `thinkingLevelMap`
  （含 `off: null`），`vendor/vendor-pro` 无档位。
- 换一把无效 key 再拉 → `source: 'unavailable'`，`error: management endpoint returned HTTP 401`，
  且**不写任何模型文件**。

## 未做 / 待办

- **GUI 点验**：ai-client 侧的空目录空态、设置页新文案没有在打包客户端里点过，
  按用户既定的「最后一起点验」并入下一次累计点验。
- 两个仓库的分支都**未推送**，onboard 也未部署；`MODEL_ADMIN_TOKEN` 需要在部署环境里配置，
  不配则管理页与管理接口整体 503。
- 管理页参考截图未提供，本轮按字段表排布，形态待用户对照。
