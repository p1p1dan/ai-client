# 第 9 批 · 会话导入适配与模型目录切源（P5-4、P5-5）

Role: evidence。日期：2026-09-12。对应[执行顺序](../../README.md#执行顺序)第 9 批。
施工计划见 [topic](../../topics/p5-4-p5-5-import-and-catalog.md)。

## 结论

两个节点全部落地，三次提交：

| 块 | 内容 | 提交 |
|---|---|---|
| MC01～MC03 | 目录认全 10 种 API 风格、D15 baseUrl 推导、Anthropic 预设修正 | `3b1bb1e3` |
| MC04～MC06 | 切源：native 的模型目录由 Main 交付，不再读派生明文文件 | `d8818725` |
| IM01～IM05 | 会话导入接上自有 session 插件 | `6cec5d2c` |

门禁（最后一次全量）：三套 `tsc --noEmit`（根 / `src/runtime` / `src/agent-host`）全部通过；
`vitest run` **397 文件 / 5634 测试**全绿（批前 382 / 5394）。
`biome check` 在本批改动的文件上干净；`src/runtime/__tests__/workerEndToEnd.test.ts:10`
有一条既有的 `noUnusedImports`，不是本批引入，未一并改动。

**全部只有自动化测试，未打包、未真机点验。** 按 2026-09-11 的规矩并入最后一次上机。

## 开工前的核对：P5-5 到底还剩什么

[未决问题](../../open-questions.md)挂着「H / 17 是否已覆盖 P5-5」。结论是**没覆盖**，
而且判据不是读文档，是往目录里放四个 provider 让 `readPiCatalog` 读一遍：

```
kept:    claude(anthropic-messages) baseUrl=https://gw.example/v1
         my-deepseek(openai-completions) baseUrl=https://api.deepseek.com/v1
dropped: my-mistral, my-azure
```

`my-mistral`（`mistral-conversations`）与 `my-azure`（`azure-openai-responses`）
是 H/17 的设置页允许用户选的风格，被**静默丢弃**：服务存好了、密钥也存了，
切到 native 后端模型选择器里就是没有，没有任何报错。

## MC01 · 六种风格此前被静默丢弃

`CATALOG_APIS` 当初照抄的是 `PI_MODEL_APIS`——那是**校验托管端下发内容**的白名单，
只有四项，因为公司网关只会下发这四种。但目录里还装着用户自己加的服务，
而 `USER_PROVIDER_APIS` 开放了 pi-ai 实现的全部十种。

现在十种全部可绑定；`API_ADAPTERS` 的类型是 `Record<CatalogApi, …>`，
所以往目录加一种风格却忘了加适配器是**编译错误**，不是运行时消失。
认不出的 provider 进 `catalog.dropped`，带 `id:reason` 进 run 的版本戳——
「我存了但看不见」总算有东西可读。

反向验证：把 `asApi` 砍回两种，`binds every API style…` 那条立刻变红（连带两条既有用例）。

## MC02 · D15 的推导规则是怎么定的

不是猜的，两处证据：

- **Anthropic**：pi-ai 自己的 provider 表里 10 个 `anthropic-messages` 条目
  **全部不带 `/v1`**（`dist/providers/data/*.json`），因为 Anthropic SDK 自己补
  `/v1/messages`。
- **OpenAI 两种**：SDK 补 `/chat/completions` 与 `/responses`，所以基址带版本段。

**只对这三种推导，其余原样保留。** 反例就在同一份表里：`openai-completions` 的
deepseek 是 `https://api.deepseek.com`（不带 `/v1`）、z.ai 是 `/paas/v4`。
对没有证据的风格发明一个后缀，等于制造本模块要消灭的那类故障。

落点在 `toPiModelsJson`——继承登录 baseUrl 的那一支。显式写了地址的 provider
（`credentials.baseUrl === 'managed'`）永不改写，这就是 D15 说的逃生口。
两个后端读同一份文件，所以 legacy 也一起修好了。

**用户输入侧只做减法**：`normalizeProviderBaseUrl` 多收一个可选 `api`，
只对 anthropic 去掉多余的 `/v1`（把 curl 例子里的 `…/v1/messages` 削成 `…/v1`
本来就是这个函数干的活，再往前一步而已），绝不追加。

## MC03 · 顺带修掉的一个真缺陷

`src/shared/userProviders.ts` 的 Anthropic 预设写的是 `https://api.anthropic.com/v1`。
pi-ai 的表与 PI-Desktop 的预设表都是不带 `/v1` 的。**用预设加 Anthropic 服务的人
今天必然撞上它**，而失败长相是 503「所有供应商暂时不可用」——读起来像上游宕机。

## MC04 · 切源切的是什么

`models.json` / `auth.json` 是**给 legacy 用的**：pi 只能通过文件配置，
所以应用必须把用户密钥解密后 0600 写出去。H/17 本轮决定第五条写明这是共存期措施，
P6-2 连同 pi-coding-agent 一起删。问题是 native 读的也是这两个文件——
一个准备删掉的东西成了准备留下的后端的承重墙。

做法：Main 用**同一个构造器**在内存里拼好同样两份文档，随 `worker.bootstrap` 交给 native。

- `buildRuntimeConfig` 抽成纯函数，写盘与内存交付共用它。「native 跑的」与
  「legacy 读的」只可能差在组装时刻，不可能差在规则——测试直接断言两者相等。
- 交付的**形状就是 `models.json` 的形状**，不另立新类型：两条路过同一个
  `parsePiCatalog`，少一份会漂移的实现。
- `modelCatalog` 缺省时照旧读目录。这条回落不是摆设：smoke 与固定探针指向 fixture
  目录、没有 Main 可问；钥匙串锁着时也读不出用户组，与其交一份缺了一半的目录，
  不如让 worker 读那份 sync 已经留在盘上的文件。
- `agentDir` 仍然传：技能、模板、子代理定义、会话文件都还在那儿，搬走的只有模型目录。

## IM01 · 导入此前只有 pi 一个实现

`PiImportProcess` 无条件 fork pi worker，`handleImport` 无条件
`new PiLegacyImportWriter(() => import('@earendil-works/pi-coding-agent'))`。
所以**已经切到 native 的安装，导入一次对话照样把 pi-coding-agent 整包拉起来**——
而导入是一个没有模型调用、没有工具、没有回合的纯写入任务。

接线方式与 `createRuntime` 同一条结构规矩：`piWorkerRpcServer` 不 import native，
native 不 import 它，选择只在 worker 入口发生一次，以工厂形式传进去。
`PiImportProcess` 与 Main 一行没改——后端本来就是从环境变量读的，fork 出来的
import worker 继承同一份环境。

**反向验证**：去掉入口那一行注入，端到端用例立刻变红，落盘路径从
`<agentDir>/sessions/import-….jsonl` 变回 `~/.pi/agent/…`——正好说明此前跑的是谁。

## IM02 · 刻意与 pi 版保持一致的三件事

1. **暂存后 rename 发布**：半截的转录绝不能出现在索引即将指向的那个 id 下。
2. **两个 custom 条目类型**（`aiclient.legacy-import.provenance` / `.display`）：
   渲染层的时间线投影已经认得它们，所以导入的会话长什么样与哪个后端写的无关，
   本批之前导入的会话在本批之后照样打得开。
3. **display-only 条目不得进模型上下文**。在这个后端上
   `buildSessionContext` 会丢弃没有 projector 的 custom 条目，所以这条性质是
   **构造保证**的——但仍然断言，因为「构造保证」在有人加 projector 的那天就不成立了。

另外 `SessionConfig` 新增了 `id`：导入会话的 id 是 Main 在 worker 存在之前就分配好的
（manifest、索引行、后续 reconcile 全按它找），自己生成一个 uuid 等于谁也找不到它。

## IM04 · 「可续聊」这半怎么离线证的

H/21 把「可续聊」定为对话导入的硬验收，换后端不能降级。用 pi-ai 的 faux provider
离线跑一回合，断言的是**导入的回合真的变成了模型上下文**：

```
sent roles: ['user', 'assistant', 'toolResult', 'user']
sent 内含「登录页点不动」；不含「截图（未保留）」
```

最后那一条同时是 IM02 第三点的正面证据——display 条目在转录里、不在发出去的内容里。

**真模型下的续聊未验**（需要真实凭据与网关），并入最后一次上机。

## 待现场

| 行 | 内容 |
|---|---|
| MC-a | 用户加一个非四种风格的服务（如 Mistral / Azure），在 native 后端的模型选择器里真的出现并能出话 |
| MC-b | 托管模式下 Anthropic 系与 OpenAI 系模型在同一网关上各出一次话（D15 推导的真机确认） |
| MC-c | 打包版里 native 会话确认不再读 `models.json`（改名该文件后 native 仍可用、legacy 报错） |
| IM-a | 真机导入一条 Claude / Codex 对话，native 后端下打开看历史、接着聊拿到真实回复 |
| IM-b | 中断一次导入（杀进程）后重试，reconcile 真的清干净 |
