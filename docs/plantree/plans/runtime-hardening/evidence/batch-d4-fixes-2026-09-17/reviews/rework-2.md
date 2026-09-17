# 回炉 R-C 只读二审（2026-09-17）

审阅范围：T061 出网剥键、T066 三处脱敏 + 预算拒绝码、T067 `failureFields()` 接线用例。
方式：只读。未改文件、未跑测试、未起 Electron。唯一执行的命令是一句 `node -e` 打印
`JSON.parse` 的报错文本（见 ② 的反例），它不读仓库、不写盘。

**结论：`blocking`** —— 只有一条，且是一行改动：`CredentialVault.clearInternal()` 把 R-C ①
刚堵上的那个明文回显原样又打了一遍。其余各项质量良好，多数比原审的建议做得更彻底。

---

## ① T061 — 剥键的包装点、拷贝语义、性能

### 包装点确实是所有 provider 的必经点（仓内三条路都过）

`ModelAdapterPlugin` 全仓只被注册一次（`src/runtime/bootstrap.ts:482`），
`register()`（`src/runtime/plugins/model-adapter/index.ts:190-200`）是三条 provider 装配路径的
汇合点，逐条核过：

| provider 来源 | 代码路径 | 是否过 `register()` |
|---|---|---|
| 磁盘目录（`models.json` / `auth.json`） | `bootstrap.ts:480 readPiCatalog(agentDir)` → `bindCatalog`（`index.ts:135-142`）→ `bindProvider`（`:162-171`）→ `register` | 是 |
| 托管/宿主递交的文档（`dir: null`，`kind: 'host'`） | `bootstrap.ts:477 parsePiCatalog(options.modelCatalog, …, { dir: null })` → 同一个 `bindCatalog` → `bindProvider` → `register` | 是 |
| 注入 provider（离线 smoke 的 faux） | `bindInjected`（`index.ts:173-188`）→ `register` | 是 |

出口侧同样唯一：`resolve()`（`index.ts:113-133`）返回的 `models` 就是 `register()` 存下的那个
被包装对象，全仓四个出网调用点全部从它拿注册表——
`plugins/agent-loop/index.ts:436`、`plugins/subagent/run.ts:247`（`model: ResolvedModel`，
来自同一个 `resolve()`）、`worker/nativeUtility.ts:239`（`nativeUtility.ts:95` 先 `runtime.model.resolve(ref)`），
以及压缩路径 `plugins/context/index.ts:463` 把 `request.models` 交给 `pi-agent-core` 的
`compact()`，后者在 `dist/harness/compaction/compaction.js:60` 调 `models.completeSimple(...)`。

`CONTEXT_CALLS` 的四个名字（`stream` / `complete` / `streamSimple` / `completeSimple`）与 pi-ai
`Models` 接口里全部吃 `Context` 的方法**逐一对上**（`pi-ai/dist/models.d.ts`
的 `Models` 定义；`fetchDeferred` / `cancelDeferred` 吃的是 `DeferredHandle` 不是 `Context`）。
没有漏项。

**一条必须记账的残余出口（note，不阻断）**：`pi --session <file>` 的 TUI 交接。
`src/main/services/terminal/piTuiSession.ts:50` 把我们自己写的会话 JSONL 交给真 `pi` CLI，
`:258-272` 的注释写明 H/20 之后原生会话就是奔着能被 CLI 打开去的。那条进程里的出网由 pi 自己
的适配器负责，我们的守卫够不着——用户在 TUI 里续聊且 provider 是 `pi-messages` 时，
`aiclientName` 会随请求上线。这不是本次引入的类别（`aiclientInternal` 早就这样），增量也小
（用户自己的文件名发给用户自己的网关），但 `attachmentRider.ts:23-26` 那句
「The wire never sees it, because the runtime takes it off」读起来像全局保证，实际只覆盖本仓 runtime。
建议在该段补半句限定。

**一条低概率的脆弱性（note）**：Proxy 的 `get` 只包 `CONTEXT_CALLS`，其余方法原样返回，
于是 `proxy.getModel(...)` 执行时 `this` 是 Proxy 而不是真实例。今天安全——
`pi-ai/dist/models.js:22` 的 `ModelsImpl` 用的是**公有**类字段（`providers = new Map()`），
经 Proxy 读属性没问题。一旦上游哪天改成 `#private` 字段，所有未包装的方法都会当场抛
`Cannot read private member…`。值得在注释里记一句，或把未包装的函数也 `bind(target)`。

### 剥键不是深拷贝，而且不会改到落盘对象

`stripAiclientKeys`（`src/shared/aiclientKeys.ts`）**从不写入入参**：`strip()` 只往新建的 `next`
里写，原对象一个字段没动。而且它是**结构共享**而非深拷贝——子树没变就原样返回同一引用
（`changed` 标志），只有「从带 rider 的节点到根」这一条路径上的对象/数组会被重建。
所以落盘对象、store 内存对象、Agent 自己 state 里的消息全都不受影响。
`providerWireNamespace.test.ts` 第 2 条正是钉这一点（发完之后调用方那份 history 里
`aiclientInternal` / `aiclientName` 都还在），第 5 条钉「无改动返同一引用」。

顺带确认一处容易被误解的：base64 图片数据是**字符串**，`strip` 对字符串直接返回，
不复制、不重编码。`Buffer` / 类实例 / 函数走 `isPlainObject` 的原型判定被整体跳过。

### 性能：代价与出网往返相比可以忽略

每次出网走一趟全量遍历，代价与**节点数**成正比，与**字节数**无关。
一次遍历的实际开销来自两处：每个普通对象一次 `Object.entries()`（分配一个数组 + 每个键一个
二元组），以及沿改动路径重建的少量对象。一段 100 条消息、每条几个块的历史大约是几千个节点，
量级是**毫秒以下到个位毫秒**，对面是一次几百毫秒起步的模型请求。

两个可记账的放大因素，都不构成问题：
- 重试会重跑（`createProviderRetryStream` 每次重试都重新调 `streamSimple`）；
- 一个多步回合每步调一次，历史随步数增长，整回合累计是 O(n²) 的节点遍历——50 步量级下
  总共也就几十到一百多毫秒，分摊在一个通常以分钟计的回合里。

真要优化，可以把「先探测有没有 rider、有才复制」拆成两趟，省掉无改动对象的 `Object.entries`
分配。**不建议现在做**：收益在噪声里，而两趟写法会让这段唯一的安全保证变复杂。

### 用例

`src/runtime/__tests__/providerWireNamespace.test.ts` 是这批里最硬的一份：用真
`ModelAdapterPlugin` + 真 `piMessagesApi`，用 recordingFetch 读**请求体本身**，
正向（线上搜不到 `aiclient` 也搜不到 `holiday.jpg`）与反向（调用方 history 原封不动）各一条，
外加「无 rider 请求逐字不变」「`anthropic-messages` 作控制组而非判据」「同前缀字段
`aiclientele` 不被误吞」「两个 rider 模块产出的键都满足 `isAiclientKey`」。
最后这条是两个互不 import 的模块之间唯一的守法，选得对。
反向验证只判红 1 条且正是 `pi-messages` 那条，与设计相符。

---

## ② T066 — CredentialVault、`[local-image]`

### 【blocking】同一个明文回显在同文件里还有第二份，没改

R-C ① 修的是 `markInvalidated` 里的那一行（`CredentialVault.ts:651-656`），改法本身没问题。
但 **`clearInternal()` 在 40 行之后把同一个 `SyntaxError` 原样又打了一遍**：

```ts
// src/main/services/auth/CredentialVault.ts:686-698
try {
  const raw = readFileSync(this.vaultPath, 'utf-8');
  const validation = validateEnvelopeShape(JSON.parse(raw));   // ← 同一个 JSON.parse
  …
} catch (error) {
  console.warn(
    '[CredentialVault] clear: existing vault unreadable, wiping without lastEmail recovery',
    error                                                      // ← 原始 error，未脱敏
  );
}
```

可复现反例（前置条件与被修的那条**完全相同**，只是入口换成登出）：

1. `safeStorage` 不可用时保存过凭据 → 保险库以 `enc: 'none'` 明文形态落盘
   （`CredentialVault.ts:115 / 525 / 575`）。
2. 文件损坏，且损坏位置落在 payload 附近——即 R-C 自己的新用例构造的那种文件：
   `sk-ant-plaintext-9f3a{"version":2,"enc":"none"}`。
3. 用户登出。`src/main/ipc/onboarding.ts:139` 调
   `getCredentialVault().clear({ keepLastEmail: true })` → `clearInternal()` → 上面那个 catch。
4. 实测 V8 报错文本（本机 `node -e` 打印，非测试）：

   ```
   SyntaxError: Unexpected token 's', "sk-ant-pla"... is not valid JSON
   ```

   electron-log 会把附加参数一并序列化，而本批次刚把 file transport 的门槛从 `error` 降到
   `info`（`src/main/utils/logger.ts` 的 `DISABLED_FILE_LEVEL`），所以这一行**现在会落盘**到
   `logs/aiclient-<date>.log`——改动之前不会。

也就是说：这不是「T066 明确不做的那 ~49 个既有 warn 点」里的一条普通遗留，它是本批次
新造出来的同一个洞的另一半，同文件、同函数族、同触发条件，而登出比「凭据被判失效」更常走。
改法与 ① 完全一致（换成 `parseFailureNote(error, raw.length)` 的单参数模板串），一行。
现有用例抓不到它：新增的那条只调 `markInvalidated`。建议顺手补一条走 `clear()` 的对照用例。

其余 `JSON.parse` 点都核过，没有第三份：`:347`、`:453`、`:552` 是裸 catch 不打日志，
`:398`、`:482` 是解密后的解析、catch 里也不打 error。

### CredentialVault 的诊断信息：够用，两处措辞小瑕

`parseFailureNote` 只留「错误类型 + 读到多少」，足以把**截断文件**和**乱码文件**分开，这是这行
日志实际承担的判别力。两点小账：

- 丢掉了**出错位置**。V8 现代格式里位置是以「引用原文」形式给出的，要留位置就要留原文，
  所以这个取舍我认可——但它确实意味着「文件哪里坏了」从此不可知，值得在注释里说一句。
- `parseFailureNote(error, raw.length)` 传的是 `raw.length`（**字符数**），文案写的是
  `bytes read`。纯 ASCII 时相等，含非 ASCII 时会偏小。要么换 `Buffer.byteLength(raw)`，
  要么把文案改成 `chars`。

### `[local-image]` 降 debug：没有伤到「导入 / 目录诊断」

这两行是渲染层图片协议处理器的每图追踪（`src/main/index.ts:525-531`），和 T066 关心的
导入链路、目录生命周期**不是同一批日志**，核过：

- 导入诊断来自 `LegacyImportService.importBatch` 的三行
  （`[legacy-import] Batch started / Failed … / Batch done …`），级别 `log`/`warn`，**不受影响**；
- 目录诊断来自 `ScratchWorkspaceService.release` 的 `[scratch] Released` / `[scratch] Kept`
  （`log` = info）与失败行 `[scratch] Failed to remove`（`warn`），**不受影响**。

唯一失去的是「默认设置下逐张图片的路径追踪」，用途是排查「图片不显示」。它没有消失，
只是移到了用户可选的 `debug` 档（`src/renderer/components/settings/AdvancedSettings.tsx:54`
明确提供 `error/warn/info/debug` 四档，`src/main/index.ts:388-391` 读它）。
对一条准热路径来说这是正确的交易。

### scratch 单参数脱敏：到位，一处口径不齐

`console.warn(\`… ${redactStderrLine(target)}: ${sanitizeStderrLine(describeError(error))}\`)`
合成一个参数，`describeError` 把 Error 压成 `name: message` 再整句过脱敏，
fs 错误自带的那份未折叠路径被 `PATH_RULES`（`src/agent-host/stderrRedaction.ts:184`
的 `(?:\/home|\/Users)\/[^…]+` → `~`）收掉。用例把断言从「第一个参数」改成
「参数个数必须为 1 + join 全部参数」，正是原审指出的「断言位置绕开了它」的正解；
还加了一条 `expect(line).toMatch(/Error: \w+/)` 防止脱敏把话说没。这一处做得比建议更彻底。

口径小瑕：路径那半走 `redactStderrLine`（只脱敏），原因那半走 `sanitizeStderrLine`（脱敏 + 2000 字截断），
所以超长只裁掉后半句。无害，但同一行里两种口径，建议统一。

---

## ③ `payload.errorCode`：纯加法，三个消费方都兼容

**形状**：`SessionTerminalEvent.payload` 从 `{ error?: string }` 变成
`{ error?: string; errorCode?: string }`（`src/shared/types/runtimeEvents.ts:576-593`），
新字段可选，`error` 语义一字未改。产生点只有一个——`projector.finish()`
（`src/runtime/events/projector.ts:536-546`），且只在 `result.error` 存在时才一起带上。
`RuntimeRunResult['error']` 是 `{ code: string; message: string }`（`src/runtime/contracts.ts:295`），
`code` 是必填，所以不会出现 `errorCode: undefined` 这种半成品键。

**三个消费方逐一核过，全部只读 `payload.error`，没有穷尽解构、没有 schema 校验会剥未知字段：**

| 消费方 | 位置 | 读什么 | 影响 |
|---|---|---|---|
| Main · 日志 | `WorkerManager.logNotableEvent`（`WorkerManager.ts:2790-2812`，本次新增） | `error` + `errorCode` | 新消费方，就是为它加的 |
| Main · 会话索引 | `SessionIndexService.applyRuntimeEvent`（`:567-575`） | 什么都不读，只 bump `updatedAt`（注释写明「Turn end carries no new data, only recency」） | 无 |
| 渲染层 · 会话 store | `chatSessions.ts:979-986` → `lastError: event.payload?.error ?? 'Session failed'`；`sessionActivity.ts:33` 只看 `type` | 只读 `error` | 无 |

另外扫了两处容易被新字段绊到的地方，都没事：`NativeSessionIndexAdapter.ts:162` 自己合成的
`session.failed` 不带码（可选字段，合法）；`queueRelease.ts:405-416` 对 `session.failed` 的
provenance 讨论是关于 `requestId` 的，与本字段无关。全仓也没有对 `session.failed` payload
做整体 `toEqual` 的既有断言（只有 `assistantProgress.test.ts:307` 构造事件，不是断言 payload 形状）。

**日志侧的去重守卫是对的**：`code && !text.startsWith(\`${code}:\`)` ——
抛出路径（`agent-loop/index.ts:158` 的 `thrownRunErrorText`，T062 在飞）已经把码拼进正文了，
这个判断避免印成 `model_not_in_catalog: model_not_in_catalog: …`。

**一条口径 note**：抛出路径把码写进 `error` 正文却**不**填 `errorCode`，结束路径反过来。
类型注释已经把这条不对称写明了（`runtimeEvents.ts:585-591`），所以不算陷阱；但将来任何想
「按码分支」的读者都得同时处理两种形态。抛出路径顺手也填一个 `errorCode` 会更省事，
不阻断，留给后续。

---

## ④ T067：主进程侧的 IPC 边界过了，preload / 渲染层那一跳没过

分两层看：

- **服务层 4 条**（`LegacyImportService.test.ts` 新 describe `coded failures (T067)`）走的是
  `service.importBatch([source])`——确实就是 IPC handler 调的那个方法
  （`src/main/ipc/legacyImport.ts:26-31`），但它**本身不穿过 IPC**，它钉的是
  `failureFields()` 的 `instanceof` 分支还活着。两条正向（entry / byte 两个上限各一条）
  + 两条反向（同类错误但无 `failure`、普通 `Error`）配比合理，反向臂挡的正是
  「给所有失败都编一句中文」这种过修。
- **IPC 那 1 条**（`src/main/ipc/__tests__/legacyImport.test.ts`）**真的过了主进程侧的 IPC 边界**：
  `beforeEach` 里 `registerLegacyImportHandlers()` 把真 handler 注册进被 mock 的
  `ipcMain.handle`，测试再从 `handlers` map 里取出**真 handler 函数**调用
  （`invokeBatch` → `handler({}, payload)`）。所以「handler 自己加了响应校验把未知字段剥掉」
  这个失效模式会被判红——这正是它声称要挡的那件事。

**缺口（note）**：`preload/index.ts:919` 与 `useLegacyImport.ts:45` 这两跳没有用例覆盖，
测试也不经过真正的 structured-clone 序列化。即「主 → 渲染」这条链只守住了最上游那一段。
落地记录把断言目标说成「the payload that crosses to the renderer」，略微高于实际覆盖，
建议措辞收一收。

另：`resolves.toEqual(failed)` 断言的是同一个对象引用，对「原样透传」这种断言来说
判据偏松（剥字段能判红，克隆后补齐则判不出），但这里要挡的就是剥字段，够用。

---

## ⑤ 范围与注释

**范围克制，没有夹带。** 逐文件核过 hunk：

- `src/main/index.ts` 只有 **1 个 hunk**（`@@ -522,8 +522,14 @@`），就是那两行降 debug；
- `CredentialVault.ts` +22/-1，只有 `parseFailureNote` 与那一行；
- `model-adapter/index.ts` +45/-1，只有守卫与 `register()` 那一行；
- `projector.ts` +8/-1，只有 `finish()` 的 payload。

工作区里其余在飞改动（T060 的 `readStringSetting`、T062 的 `thrownRunErrorText` 与
`piModelConfig/index.ts`、T064/T065/T068 各自的文件）都不属于 R-C，各自的落地记录也点了名。
T066 记录里把「~49 个既有 warn 点未普查 / 渲染层门槛不同档 / 开关打开反而记得更少」三条
明确留在原审账上，态度诚实——只是 ② 那条不属于这个范畴（见上）。

**注释**：英文为主、事实准确，`aiclientKeys.ts` 的头注释把「谁在骑、为什么必须下车、
为什么保证落在 runtime 而不是 adapter」分了三节，是这批里写得最清楚的一份。两条小账：

- **中文混入代码注释**：本批次新引入的「回炉」二字散布在 **26 处**、跨 23 个文件
  （`projector.ts`、`WorkerManager.ts`、`ScratchWorkspaceService.ts`、`runtimeEvents.ts`、
  `CredentialVault.ts`、多个测试文件…）。CLAUDE.md 要求代码注释全英文；这不像 i18n 词典里
  那些被引用的界面原文，够不上「引用原文」豁免。该文件里另有两处中文是**改前就有的**
  （`CredentialVault.ts:55 / :123`），属既有欠账。建议本批次新增的统一换成 `rework`/`R-C`。
- **仍然偏长**，与前两轮审阅的评价一致（`logger.ts` 那 31 行块注释这次没压）。
  本仓既定风格，不阻断。

---

## 收口：要做的事

1. **【blocking，一行】** `CredentialVault.ts:694` 的 `clearInternal` catch 改成
   `parseFailureNote` 单参数形式，并补一条走 `clear()` 的用例（复用新用例的损坏文件即可）。
2. （note）`attachmentRider.ts:23-26` 的「the wire never sees it」补一句限定：
   保证覆盖本仓 runtime 的出网，不覆盖 `pi --session` 交接给真 pi CLI 之后的那条路。
3. （note）`parseFailureNote` 的 `bytes` 与 `raw.length` 对不上，二选一改齐。
4. （note）本批次新增注释里的「回炉」换成英文。
5. （note，可留到后续）抛出路径顺手也填 `errorCode`，让两条失败路径的机器可读字段一致。

除第 1 条外，其余均不阻断落地。
