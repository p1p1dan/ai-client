# 第 9 批 · 会话导入适配与模型目录切源（P5-4、P5-5）

Role: implementation-plan。日期：2026-09-12。对应[执行顺序](../README.md#执行顺序)第 9 批。
依据：[ARD §4.2 搬运表](../../../plans/2026-09-08-runtime-evolution-ard.md)、[D15 baseUrl 推导](../../../plans/2026-09-08-runtime-evolution-ard.md#d15--模型目录的-baseurl客户端按-wire-协议推导允许每个-model-显式覆盖)、[H/17 实施计划](local-provider-management.md)、[P0 在线冒烟的端点事实](../evidence/p0/live-smoke.md)。

## 开工前的核对：P5-5 是否已被 H / 17 覆盖

[未决问题](../open-questions.md)里挂着这一条。**结论：没有覆盖，第 9 批是两个节点。**

判据不是读文档得来的，是在真代码上跑探针得到的——往目录里放四个 provider（一个托管 Anthropic、三个 H/17 允许用户选的风格），
让自有 runtime 的 `readPiCatalog` 读一遍：

```
kept:    claude(anthropic-messages) baseUrl=https://gw.example/v1
         my-deepseek(openai-completions) baseUrl=https://api.deepseek.com/v1
dropped: my-mistral, my-azure
```

三条缺口，每条都不在 H/17 的范围里：

1. **风格覆盖面对不上**。H/17 的 `USER_PROVIDER_APIS` 开放了 pi-ai 实现的 10 种风格（`src/shared/userProviders.ts:24`），
   而自有 runtime 的 `CATALOG_APIS` 只有 4 种（`src/runtime/plugins/model-adapter/catalog.ts:32`），
   `asApi()` 认不出的 provider 直接 `continue`。**静默丢弃**：用户在设置页存好了服务，切到 native 后端模型选择器里它就是不见，没有任何报错。
2. **D15 一行未实现**。`baseUrl` 原样照抄（`catalog.ts:109`），没有按 wire 协议推导，也没有「每个 model 显式覆盖」的口子。
3. **切源方向相反**。H/17 为了让 legacy 后端能用用户服务，把用户组**解密后写进** `models.json` / `auth.json`；
   而 native 今天读的正是这两个文件。所以 H/17 是**加深**了对这份共存期派生文件的依赖，P5-5 要做的是把 native 从这份文件上摘下来。

## 顺带查出的一个真缺陷（归入本批）

`src/shared/userProviders.ts:65` 的 Anthropic 预设写的是 `https://api.anthropic.com/v1`。
pi-ai 自己的 provider 数据（`dist/providers/data/anthropic.json`）与 PI-Desktop 的预设表（`provider-presets.ts:36`）都是 **`https://api.anthropic.com`（不带 `/v1`）**，
因为 Anthropic SDK 会自己补 `/v1/messages`。带上就是 `/v1/v1/messages`。
这正是 D15 描述的那个失败长相——**503「所有供应商暂时不可用」，不是 404**，看起来像网关挂了。
用预设加 Anthropic 服务的人今天必然撞上它。

## P5-5 · 模型目录切源

ARD §4.2 对这一节点的原话是「我们 A3 已有随包快照 + 离线回落｜保持｜只需从 pi-coding-agent 的配置切到自有配置」。
展开成四件事：

- **MC01 风格覆盖面**：目录支持 pi-ai 实现的全部 10 种风格。认不出的风格必须**留下诊断**，不能像今天这样静默 `continue`——
  「用户存了但看不见」是最难查的一类缺陷。
- **MC02 D15 推导**：`baseUrl` 由客户端按 wire 协议从服务根推导，provider 与 model 都可显式覆盖，推导结果用单测钉住、不联网。
  推导规则的依据是各家 SDK 自己补什么路径：Anthropic SDK 补 `/v1/messages`（所以基址不带 `/v1`），
  OpenAI SDK 补 `/chat/completions` 与 `/responses`（所以基址带 `/v1`）。
- **MC03 预设修正**：Anthropic 预设去掉 `/v1`（上一节那个真缺陷）。
- **MC04 切源**：应用内 native 的目录由 Main 组装自有配置后交给 worker，不再读 `models.json` / `auth.json`。
  **不是换一个文件名**——换文件解决不了「密钥必须解密落盘」这件事，而那正是 H/17 本轮决定第五条要在 P6-2 删掉的东西。
- **MC05 随包快照与离线回落**对 native 同样生效（今天 native 只能通过 `models.json` 间接拿到 A3 的快照）。
- **MC06 派生文件降级**为 legacy 专用出口，P6-2 随 pi-coding-agent 一并删除。

**范围外**：托管端下发口径本身不改（我们只改客户端怎么解释它）；不做 OAuth；不做价格/能力目录。

## P5-4 · 会话导入适配

ARD §4.2 的原话是「我们现有 `LegacyImportService`（已经比 PI-Desktop 更成熟）｜保持｜只需适配新的 session 插件接口」。
今天的实际情况是：**导入这条链整条只有 pi 一个实现**。

`PiImportProcess.ts` 无条件 fork pi worker，`piWorkerRpcServer.handleImport` 无条件 `new PiLegacyImportWriter(() => import('@earendil-works/pi-coding-agent'))`，
写入走 pi 的 `SessionManager.appendMessage/appendCustomEntry`。所以**即使用户选了 native 后端，导入一次对话也会把 pi-coding-agent 整包拉起来**。

- **IM01**：native 后端下导入不加载 pi-coding-agent。
- **IM02**：导入写入走自有 session 插件（`JsonlSessionStore`，v4），沿用既有的两个 custom 类型
  （`aiclient.legacy-import.provenance` / `.display`），并保留「display-only 条目不得进模型上下文」这条硬校验——
  它在 pi 版里是 `WORKER_IMPORT_CONTEXT_LEAK`，不能在 native 版里消失。
- **IM03**：`inspect` / `reconcile` / `discard` 三个善后动作在 native 下等价（中断的导入要能被清理）。
- **IM04**：导入的会话在 native 下打开能看到完整历史，并且**能续聊**——这是 H/21 对话导入定下的硬验收，换后端不能降级。
- **IM05**：既有 legacy 导入的会话（pi 格式）在 native 下仍可打开（P3-3 的 v3 兼容已覆盖，本批只做回归）。

**范围外**：native 导入的 v4 会话被 legacy/TUI 打开，属 [H/20 会话互通](gui-tui-session-interop.md)，不在本批。
扫描与转写侧（`ClaudeSessionScanner` / `*SourceAdapter`）与后端无关，不动。

## 批内顺序

1. **MC01～MC03**（目录能力与 D15）：纯 runtime + shared，不涉及跨进程契约，先落地并单测钉住。
2. **MC04～MC06**（切源）：动 `worker.bootstrap` 契约与 Main 的组装侧，依赖第 1 步的目录形状。
3. **IM01～IM03**（native 导入写入器）：依赖 session 插件，与目录无关，可并行但排在后面以免同时改两处契约。
4. **IM04～IM05**（打开与续聊）：接线与回归。

每步各自可验收；若第 2 步滑期，第 1 步已经独立修掉「用户服务静默消失」和 Anthropic 预设两个真缺陷。
