# 决策 114：P1-4d3 提问卡的实现取舍：官方 `dsh-tool-ask-user` 由产品 bundle 挂一行，bridge 应答 `user-questions/request`

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 098](098-ask-user-via-official-tool.md)（本任务，已批准）、[110](110-user-rulings-2026-09-28-batch2.md)「联网装包」行、[108](108-p1-10b-host-plugin-loading-choices.md)、[082](082-allowlist-implementation-choices.md)、[058](058-plugins-preinstalled-no-pnpm.md)～[060](060-first-allowlist-pilot-office-tools.md)、[047](047-tool-classification-and-plan-mode.md)、[090](090-user-rulings-2026-09-28.md) 总原则；[决策 113](113-p1-4d2-commands-and-projection-choices.md) 第 1 条（`/plan` 隐藏）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4d-9 行与 §8 第 3 条；[P1-4 分片 01 §1](../topics/p1-4-bridge-parity/01-event-mapping.md)（问答字段对应）；
- 装包证据：[p1-4d3-ask-user-install-2026-09-28](../evidence/p1-4d3-ask-user-install-2026-09-28.md)；
- DSH 源码：`dsh-tool-ask-user/lib/index.js`（普通 Cordis 插件，`inject: ['tools','userQuestions']`）、`dsh-user-questions/lib/index.js`（`ask()` 先校验调用方，再按 agent 作用域派发 waterfall）、`dsh-user-questions/README.md:33,39,41`、`dsh-plan-mode/lib/index.js`（`exit_plan_mode` 也经 `ctx.userQuestions` 提问）、`dsh-app-boot/lib/index.js` 的安装范围解析（宿主 `package.json` 依赖闭包里的包都能被行名解析到）。

改动留在工作区，由编排者复跑后提交。下面是 098 没有写死、或者与 098 前提不符、由本次实现定下的地方。

## 规则

### 一、装包与挂载（修订决策 098 第 2 条）

1. **不进白名单，由产品 bundle 挂一行**。
   - **事实**：装好之后才看到，`dsh-tool-ask-user` 不是 DSH bundle，没有 `dsh.bundle`、没有 `cordis.patch.yml`，只是一个注册 `ask_user_question` 的普通 Cordis 插件。
   - **白名单收不了它**：P1-10 的白名单只收 bundle，并要求补丁只 insert 自己声明的行。清单的 `rows` 必填；构建期审计会报「not a DSH bundle」；宿主装载审计会判 `rejected`。
   - **做法**：照 DSH 发行版的挂法，由发行版自己的 bundle 插一行。dsh-base 挂 `user-questions`、`plan-mode` 这些普通插件也是这样。具体是：
     - `@aiclient/dsh-app` 的 `cordis.patch.yml` 插入 `id: tool-ask-user`，`name: '@deepseek-ai/dsh-tool-ask-user'`；
     - 包写进宿主 `package.json` 的精确依赖，并列入构建库的 `HOST_DEPENDENCIES`。
   - **原有保障不变**：
     - 版本必须等于 DSH 钉版本，这是构建预检已有的「`@deepseek-ai/dsh-*` 全部等于钉版本」规则；
     - 锁文件带 integrity，`npm ci` 校验；
     - 许可进 `THIRD_PARTY_LICENSES.json`，计入体积预算。
   - **与白名单相比少了三样**：一份审查记录、manifest 里的敏感 API 扫描、设置页的开关。敏感 API 在证据 §4 人工查过，没有命中。
   - **结果**：提问工具**始终开启**，相当于 `defaultEnabled: true` 但没有关闭开关（见「待用户拍板」）。白名单保持为空，`dsh-office-tools` 仍是第一个白名单条目（决策 060）。
2. **行 id 用 DSH 自己的插件名 `tool-ask-user`**，不用 `aiclient-` 前缀，因为这个前缀留给我方自己的模块。
   - 不列入 `REQUIRED_ENABLED`：这一行起不来时宿主照常服务，模型只是没有这个工具，退回决策 098 第 6 条的「用普通文字提问」，不值得为此拒绝启动。
   - 打包态的活动行由 77 变为 78（L1 冒烟的 census）。
3. **`exit_plan_mode` 也会出卡**。应答方接的是根会话的所有提问，包括 dsh-plan-mode 的方案确认（`intent: plan-review`，`detail` 是方案全文）。
   - 这以前是 `NO_PROVIDER` 错误，现在出一张问答卡：方案并在问题正文后面，选项用 DSH 自己的「批准 / 继续规划」标签。
   - 按决策 047 与 113，DSH 的 plan 模式没有接进界面（`/plan` 隐藏），所以这条路径实际上很少走到。

### 二、应答方（决策 098 第 3、5 条的实现）

4. **每个会话运行时各挂一个不带作用域的 listener**，只认领 `request.agent.id` 等于本会话根 agent 的请求，其余一律交给 `next()`。
   - 这与已有的 `session/event`、`agent/assistant-stream` 监听同一个写法：每个运行时一个全局 listener，按 id 过滤。
   - 不带 agent 的请求没有归属的卡，交下去，最后是 DSH 自己的 `NO_PROVIDER`；
   - 子代理提问在 `ask()` 里就被 DSH 拒掉了（`DELEGATED_CALLER`），到不了这里。
5. **字段对应**：基本照分片 01 §1，以下几处由本次定下。
   - **`detail`**：卡上没有这个字段，所以空一行接在问题正文后面，不改渲染层语义。
   - **`intent`**：丢弃。DSH 写明，不认识 intent 的界面就画普通选项列表，答复格式相同。
   - **没有 `options` 的问题**：给 `[]`，卡上只有「其他」可填。
   - **答复的键**：用模型给的 `id`。一次调用里 `id` 重复时，改成 `<id>#<n>` 再交给卡，回答时映射回模型的 `id`。
   - **多选拆分**：卡按「所选标签 + 其他文字」用 `", "` 拼接，其他文字总在最后。bridge 从头开始，每个位置优先匹配最长的标签，标签之后剩下的就是 `custom`。
     - 分片 01 说「标签里带逗号时有损」，这个算法消除了这一点；
     - 仍剩一个边角：「其他」文字本身以「某个标签, 」开头时，会被拆成那个标签加剩余部分。
   - **单选**：答复等于某个标签就是 `selected: [标签]`；否则是 `custom`，`selected` 为空。这是 DSH 的语义：单选时 `custom` 取代选项。
   - **`response`**（整段自由文字；卡目前不会发）：作为 `answers` 里没有的每一题的 `custom`。
6. **跳过**：Skip，或者既没有 `answers` 也没有 `response`，每一题都答 `{id, selected: []}`（`dsh-user-questions/README.md:39`），卡以 `cancelled` 结束。
   - 模型收到的就是这段 JSON；
   - 与 1.0.x 的 `ask` 不同，没有「请自选默认值并说明」的提示。这是跟随 DSH（决策 090）。
7. **卡的 id 是 `dsh-question-<UUID>`**，每次请求一个。waterfall 里没有工具调用 id；录制时 UUID 会被归一化。
8. **撤卡**：
   - 发起方的 signal 中止（Stop、回合取消）时，发 `question.resolved {outcome: 'cancelled'}`，waterfall 以错误结束，DSH 转成 `ASK_ABORTED`；
   - 会话关闭（dispose）时同样撤卡，错误文字是「the chat session closed before the user answered」；
   - 不设超时，与 1.0.x 相同：问题就在眼前，回合自己的中止仍会结束它；
   - 结算之后再答复，一律 `handled: false`。
9. **`question.resolved` 的 `answers` / `response` 原样回传卡发来的内容**，与 1.0.x 的 `questionPrompt` 一致，不用 DSH 答复重新拼。

### 三、权限分类（决策 098 第 4 条）

10. `classification.ts` 加 `ask_user_question: 'internal'`，不过闸。
    - 分类表的静态扫描现在会扫到这个包里的 `ask_user_question`（它扫 `node_modules/@deepseek-ai/*/lib`），不补这一行测试就会失败；
    - 测试里「产品组合的实际工具列表」也加上它，因为产品现在确实挂了这一行；
    - 白名单「插件工具不能归为 internal」的规则（P1-10 分片 03 §3.4）管的是白名单插件，这个包不是，所以不冲突。

### 四、录制与测试

11. **录制场景 `question`**：同一会话两个回合，第一次回答，第二次跳过。
    - 第一次回答：单选选一个；多选选两个，其中一个标签带 `", "`，另加一段「其他」文字；
    - 放在 `file-attach` 之后录，前面的场景仍在原来的宿主状态下录；
    - 假网关新增 `P1-QUESTION`：发一次 `ask_user_question`，然后把工具结果原样说回来；
    - `rpc.respond` 记下两次 `worker.question.respond` 的答复。
12. **`dshHistoryGolden.test.ts` 的场景清单加 `question`**：金样本录好之前，这一例会失败。由编排者收口时用 `--update --only question` 录。
13. **既有 25 个场景的 `--check`**：`rpc`、`stream` 都没有差异；只有 `log` 变了，而且只在 `request/header.tools` 里多了 `ask_user_question`（按名排序在最前）。原因是产品组合多挂了一个工具，模型请求的工具表跟着变。收口重录。
14. **真宿主集成测试**：第七个 supervisor 加 QST-1、QST-2。
    - QST-1：卡经 Main 到达，不出审批卡，Main 的答复到达模型；
    - QST-2：卡在时 Stop，卡以 `cancelled` 撤下，回合停止；
    - PLG 系列的断言不用改，因为白名单没有变。

## 取舍

- **另建「非 bundle 插件」的白名单通道**，由宿主在启用时代插一行。
  - 好处：有开关，设置页会列出它。
  - 代价：要改白名单格式、构建期审计、宿主装载审计、`judgeInstalled` 和测试，约 1～1.5 人日，而且改的是 P1-10 的安全审计设计。
  - DSH 自己也把这类插件当成发行版组合的一部分。这次不做；用户要开关的话，见下条的两个办法。
- **自己包一层 bundle**：白名单只收 registry 上的 tarball（决策 082 第 2 条），包一层就成了仓库内的包，走不通。
- **按 agent 作用域挂 listener**（在 `setup` 里用 agent 自己的 ctx）也行得通，但会依赖 agent 作用域 ctx 的接口，重开 agent（回退、分叉）时还要各挂一次。按 id 过滤与现有写法一致，更简单。

## 待用户拍板

15. **提问工具没有关闭开关**（第 1 条）。
    - 模型任何时候都能出问答卡，与 1.0.x 的 `ask` 相同，1.0.x 也不能关；
    - 如果要能关，可选：
      - A：Main 的设置经 overlay 关掉 `tool-ask-user` 这一行，约 0.5 人日；
      - B：上面「取舍」第一条的白名单通道，约 1～1.5 人日。

## 修订

- **决策 098 第 2 条**（「按 P1-10 的白名单流程以 official 类加入」）改为本决策第 1 条，已在 098 里加修订注记。
- **重划文档 §6.2 的 P1-10c 条目**（「`dsh-tool-ask-user` 会是白名单里第一个 `official` 类条目」）随之失效，已加注。

## 影响

- **产物**：linux-x64 由 86,219,333 B / 9,761 个文件 / 342 个包，变为 86,261,723 B / 9,765 个文件 / 343 个包，即 +42,390 B、+4 个文件、+1 个包。新包本身占 8,651 B。
- **新增文件**：`src/dsh-host/bridge/questions.ts`（纯映射与卡的生命周期），`src/dsh-host/bridge/__tests__/questions.test.ts`。
- **改动的文件**：
  - `dshSessionRuntime.ts`：接 listener、`respondQuestion`、dispose 时撤卡；
  - `classification.ts`；
  - 产品 bundle 的补丁与说明；
  - 宿主 `package.json` 与锁文件；
  - `HOST_DEPENDENCIES`；
  - 录制器与假网关；
  - 测试：`dshSessionRuntime.test.ts`、`permissionsClassification.test.ts`、`hostStatic.test.ts`、`packaging-config.test.mjs`、`dshHistoryGolden.test.ts`、集成测试。
- **渲染层与 Main 不改**：问答卡、`chat:respondQuestion`、`WorkerManager.respondQuestion` 本来就对引擎无感。工具行的 `ask_user_question` 文案归 P1-7c（决策 098「影响」）。
