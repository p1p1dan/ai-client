# 容量对账的余项（T031） — 批次 D 区域审查

区域：capacity-leftovers（P3-1 容量面，[capacity-reconciliation-2026-09-15.md](../capacity-reconciliation-2026-09-15.md) 「待落地」段的余项）
任务：T031（对应批评者缺口 16，[cross-and-critic.md:79](../../../runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md)）
基线：HEAD `ebc82f16`（2026-09-15，批次 A/B/C 与 T036 已全部落地）
日期：2026-09-15

## 总评

T024（`8564ba41`）把「谁会往会话文件和 trace 里写字节」这张账基本对清楚了：MCP 工具响应、子代理转录、trace 文件/内存镜像四条主要来源都已经有明确的字节上限并落了地，这部分工作站得住。但 T024 自己的「待落地」表列了五类它明确没碰的来源，理由分别是「本任务禁改 agent-loop」「context 插件不在范围内」「归 T031」。本次复核这五类在当前 HEAD 上是否依旧敞口，结论是：**全部依旧敞口**，而且其中"用户附件无体积上限"这一条比对账表原文描述的更严重——对账表只看了 `plugins/agent-loop/attachments.ts` 一个文件，没有往上游追到 Main 进程的 IPC 处理器和 preload 桥接层；追上去之后发现，附件体积的唯一防线是渲染层一个纯前端函数（`admitAttachment`），从 IPC 到 Main 到 runtime 插件，没有任何一层重新校验过它。更关键的是，触发这条敞口不需要绕过界面——渲染层自己允许的单次发送上限（10 MB 原始字节，图片按 base64 落盘后约 13～14 MB）本身就足以在两三条正常的「发图」消息内把 32 MiB 的会话预算耗尽，耗尽之后会话文件按现状代码会永久打不开（T034 的中段坏行自愈救不了这种情况，因为文件在被读到一半之前就先被字节数上限拦下）。

其余四条（trace 里的工具调用参数全文、压缩摘要正文、会话文件缺单行安全网、多进程并发写同一份 `runs.jsonl`）严重度更低，但同样是「一处声明了『有上限』的模式（MCP/子代理转录已经这样做了），另一处没照做」的同类缺口，与 2026-09-14 审计里反复出现的「一侧声明语义、另一侧没接线」形态一致。

## 优点

- MCP 工具响应（文本+图片）、子代理转录、`runs.jsonl` 文件与内存镜像四条主要容量来源的限额已经落地并有测试覆盖（`trace.test.ts`、`mcp.test.ts`），本轮复核未发现回归。
- `session/store.ts` 的聚合字节检查（`this.bytes + bytes > this.maxBytes`）覆盖了 store 自身的全部五个写入点（新建、追加、lane/fact、fork、legacy 导入转换），这条闸门本身是可靠的、不是敞口。
- `trace.ts` 的轮转设计（重命名不截断、大小从磁盘 stat、失败经 `flush()` 上报而不静默）思路是对的，唯一缺的是跨进程互斥，见 capacity-05。
- 对账表本身（T024 产出）文档质量高，明确标注了「待落地」与「禁区文件」，使这次复核可以直接对着表逐项核实，而不需要重新从零盘点。

## 弱点

- 对账表的视野止步于 `src/runtime`，没有往上游追到 Main 进程 IPC 与 preload——这是本轮发现 capacity-01 比原文档描述更严重的直接原因。
- 附件体积限额只存在于渲染层一个可被绕过的位置，这个模式此前在别的区域（bash 权限分析、审批过滤）已经反复出现过，这次是同一模式在容量维度的实例。
- 「trace 记录工具调用参数全文」「压缩摘要无显式字节上限」两处的注释/常量命名风格（`MAX_TRACE_PREVIEW_CHARS`、各种 `_BYTES` 常量）已经证明团队知道该在哪加上限，但这两处没有对齐这个已有模式。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P3-1（容量面，T031 范围内） | complete-with-gaps | MCP / 子代理转录 / trace 文件与内存四条主要来源（T024、T020）已限额且有测试，是本节点的主体；但用户附件（capacity-01，high）、trace 工具参数全文（capacity-02，medium）、压缩摘要（capacity-03，low-medium）、会话文件单行安全网（capacity-04，low）、多进程并发轮转（capacity-05，medium，仅在手工设置 `AICLIENT_RUNTIME_TRACE_DIR` 时可达）五条对账表明确列出的「待落地」项，在当前 HEAD 上全部依旧敞口，其中 capacity-01 不需要任何绕过手段、在正常 GUI 使用下就可触发会话文件永久打不开这一后果，与既往审计里 high 级的 session-01（GUI/TUI 交替写坏会话文件）属于同一后果等级，故本节点不能判 complete。 |

## 发现

### [capacity-01] high capacity | P3-1 | src/runtime/plugins/agent-loop/attachments.ts:34-42 | 用户附件无任何服务端体积上限，正常使用即可在个位数消息内顶满 32 MiB 会话预算

DESC: 附件体积的唯一约束是渲染层一个纯前端函数 `admitAttachment`（`src/renderer/components/chat/attachmentLimits.ts:69-100`，`DEFAULT_ATTACHMENT_LIMITS`：单次发送最多 5 个附件、单图 ≤5 MB、单文本 ≤512 KB、总量 ≤10 MB 原始字节）。这个限制只存在于 React 组件状态里，从 IPC 通道到 Main 进程再到 runtime 插件，没有任何一层重新校验附件大小：
- preload 把 `CHAT_SEND` 的 payload 原样转发（`src/preload/index.ts:1045`：`ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload)`），TypeScript 类型在运行时不做任何约束。
- Main 的 IPC 处理器把 `attachments` 原样传给 `workerManager.send()`（`src/main/ipc/chat.ts:471-476` 声明类型、`:487` 调用 `workerManager.send({ ...payload, ownerWebContentsId })`），中间没有一次 `.length` 或字节数检查。
- `WorkerManager.send()` 把 `attachments` 原样塞进发给 worker 的消息（`src/main/services/agent-host/WorkerManager.ts:1648` 类型声明、`:1673` `...(input.attachments ? { attachments: input.attachments } : {})`），同样没有校验。
- runtime 侧 `preparePrompt()`（`src/runtime/plugins/agent-loop/attachments.ts:26-55`）对每个附件只判断 `kind`，图片直接 `images.push({ data: attachment.data, ... })`、文本直接拼进 prompt 字符串，没有任何尺寸判断。

更关键的是，触发这条敞口**不需要绕过界面**：渲染层自己允许的单次发送上限就是 10 MB 原始字节。图片以 base64 形式写进会话文件（`bytesToBase64`，`useComposerAttachments.ts`），base64 膨胀系数 ~1.34，所以一条合规的「附 5 张图」消息落盘约 13～14 MB。会话文件的聚合校验只在 `session/store.ts:288-295` 的 `appendMessage`/`appendCompaction` 汇合点做「已有字节 + 本行字节 > 32 MiB 就整体拒绝这次写入」的检查（不截断），这条检查本身没问题，但它挡不住「单条消息本身就是十几 MB」这件事——它只挡「加上这条会超预算」的写入，不限制单条消息能有多大。

EVIDENCE:
```ts
// src/runtime/plugins/agent-loop/attachments.ts:34-42
for (const attachment of attachments) {
  if (attachment.kind === 'image') {
    images.push({
      type: 'image',
      data: attachment.data,
      mimeType: attachment.mediaType || 'image/png',
    });
  } else if (attachment.kind === 'text') {
    documents.push(`--- ${attachment.name ?? 'attachment'} ---\n${attachment.data}`);
```
```ts
// src/main/ipc/chat.ts:471-476, 487（无附件体积校验，原样转发）
attachments?: Array<{
  kind: 'image' | 'text';
  mediaType: string;
  data: string;
  name?: string;
}>;
...
const requestId = await workerManager.send({ ...payload, ownerWebContentsId });
```

SCENARIO: 用户在一次会话里连续发送 2～3 条各附带多张照片（每条落在渲染层允许的 10 MB 原始字节上限内，无需任何特殊操作）。每条消息落盘约 13～14 MB，第三条发送时触发 `session_size_limit`（`store.ts:291`）被拒绝，用户发送失败且不知道原因；如果预算恰好被榨干到某条消息写入成功后文件已逼近或压过 32 MiB（比如外部因素如 pi CLI 并行写入，或本条消息之前已经有工具输出/压缩摘要占用了预算），下次 `store.open()` 走 `io.readFile(file, { maxBytes, overflow: 'error' })`（`store.ts:155`）会直接抛 `io_limit`——T034 的中段坏行自愈完全帮不上忙，因为它的前提是文件能被完整读进内存后再解码，而这里文件本身已经超过读取上限，根本读不到解码那一步。会话从此永久打不开，用户唯一的恢复手段是手工编辑或删除会话文件。

FIX: 在 Main 的 `CHAT_SEND` 处理器（`src/main/ipc/chat.ts`）或 `WorkerManager.send()` 补一道与渲染层 `DEFAULT_ATTACHMENT_LIMITS` 对齐（或更严格）的服务端校验，超限直接拒绝该次发送并返回明确错误，不要让请求触达 runtime；同时在 `preparePrompt()`（runtime 侧）加一道独立的最终防线（哪怕只是与 MCP 图片同量级的每附件/每次发送字节上限），使 runtime 包本身不依赖调用方是否做过校验——这与 MCP 图片本次已经采用的「per-image + per-call 双重上限」模式完全一致，照搬即可。

---

### [capacity-02] medium capacity | P3-1 | src/runtime/plugins/agent-loop/index.ts:467-473 | trace 把每次工具调用的完整参数原文写入，唯一没有走"预览截断"模式的落盘点

DESC: `agent.subscribe` 的事件回调里，`tool_execution_start` 触发时把 `event.args`（工具调用的完整参数对象）整份塞进 `trace.note('tool', { ...args: event.args })`。同一文件里已经有一条明确的截断先例——`MAX_TRACE_PREVIEW_CHARS = 4000`（`index.ts:58`）用于审批预览，且 `write` 工具的内容参数本身允许到 8 MiB（`FILE_EDIT_BYTES`，`plugins/tools/index.ts:24`，同时是 typebox schema 的 `maxLength`）。`trace.note()`（`src/runtime/trace.ts:139-146`）只是把 detail 追加进内存里的 `steps` 数组，这个数组在一次 run 的生命周期内（从 `begin()` 到 `finish()`）没有任何字节上限——T024 新增的 `TRACE_MEMORY_MAX_BYTES`/`TRACE_FILE_MAX_BYTES` 都是在 `finish()` 之后、整条 trace 序列化成一行 JSON 时才生效（`trace.ts:157-160` `sink.remember(trace, line.byteLength)`），对"运行中的 run 累积了多少字节在 `steps` 里"完全不设防。

EVIDENCE:
```ts
// src/runtime/plugins/agent-loop/index.ts:467-473
if (event.type === 'tool_execution_start')
  trace.note('tool', {
    event: event.type,
    tool_call_id: event.toolCallId,
    tool: event.toolName,
    args: event.args,
  });
```
```ts
// src/runtime/trace.ts:139-146（note 无截断，直接 push）
note(type, detail) {
  steps.push({
    step: steps.length + 1,
    type,
    at: new Date(sink.now()).toISOString(),
    detail,
  });
},
```

SCENARIO: 一次 run 中模型连续多次调用 `write` 工具写大文件（例如生成/改写几个较大的源文件或文档，单次 content 在几百 KB 到几 MB 量级，这在真实使用中并不罕见），每次调用都把完整 `content` 字符串原样进 `steps` 数组；`finish()` 之前这些字节完全不受 `TRACE_MEMORY_MAX_BYTES`（4 MiB）约束，一个长 run 可能在内存里临时持有远超 4 MiB 的未序列化 trace 数据。`finish()` 之后序列化成一行写盘时，这一整行如果超过 `TRACE_FILE_MAX_BYTES`（8 MiB）会按文档既定策略整行写入不截断（`trace.ts` 注释「单条超过上限的 trace 照样整行写入」）——这个策略对「一次正常调用」是合理的，但这里的触发条件是"没有任何一次调用受过 4000 字符量级的截断"，与同一份代码里 `MAX_TRACE_PREVIEW_CHARS` 的先例不一致。

FIX: 给 `trace.note('tool', ...)` 的 `args` 字段复用 `truncatePreview()`/`MAX_TRACE_PREVIEW_CHARS` 同款截断（`index.ts:58-68` 已有现成函数，当前只用于审批预览），把工具调用参数的落盘上限对齐到同一常量，与「预览截断」这个已有模式保持一致。

---

### [capacity-03] medium capacity | P3-1 | src/runtime/plugins/context/index.ts:317-334 | 压缩摘要正文没有显式字节上限，唯一约束是压缩后的"事后"硬上限检查

DESC: `compact()`（第三方 pi-agent-core，经 `this.summarize()` 调用，`context/index.ts:425-445`）产出的 `result.summary` 是模型生成的自然语言摘要，代码没有对它设置任何显式的字节/字符上限常量（不同于 tool 结果的 50 KiB、diff 的 64 KiB、MCP 文本的 50 KiB 这些"有名有姓"的常量）。唯一的约束是**摘要生成之后**才做的检查：把 `[summary, ...retainedTail]` 拼成 `candidate`，估算 token 数，若加上 `additionalTokens` 达到 `budget.hardLimit` 才 `giveUp`（不落盘，`context/index.ts:326-341`）；没超过才会 `session.appendCompaction(result)` 把摘要写进会话文件（`:344`）。也就是说，"摘要能有多大"完全由 provider 单次输出的 token 上限和当前模型的上下文窗口大小间接决定——对一个大窗口模型（比如上下文窗口达到几十万到百万 token 级别的模型），这个间接上限可能允许摘要正文达到几百 KB 到几 MB 量级,而这个量级与该模型的 `hardLimit` 设置直接相关，本仓库没有为"摘要正文"单独设一道与模型无关的硬字节顶。

EVIDENCE:
```ts
// src/runtime/plugins/context/index.ts:317-345（摘要生成与落盘之间只有 token 层面的事后检查，无字节上限）
const summarized = await this.summarize(bounded.preparation, request);
...
result = summarized.value;
...
const candidate = [
  createCompactionSummaryMessage(result.summary, result.tokensBefore, Date.now()),
  ...result.retainedTail,
];
if (
  estimateContextTokens(candidate).tokens + (request.additionalTokens ?? 0) >=
  budget.hardLimit
) {
  return this.giveUp(reason, messages, 'compaction_over_budget', ...);
}
const persisted = session ? await session.appendCompaction(result) : undefined;
```

SCENARIO: 配置了大上下文窗口模型（例如上下文窗口远大于常见的 128K-200K 档位）且该模型单次输出上限较高时，一次 `/compact` 或自动压缩可能产出一份远大于其它落盘来源（50 KiB / 64 KiB 量级）的摘要正文，作为单条 `compaction` 记录写入会话文件。这本身不会导致文件损坏（仍受 `session/store.ts:290` 的聚合字节检查约束），但会让单次压缩比预期消耗更多会话预算，且与其它所有落盘来源都"有一个具体的字节常量"这一模式不一致，下一次审计/维护者很容易假设它也有上限而实际没有。

FIX: 在 `boundSummaryInput`/`summarize` 附近为 `result.summary` 补一道与模型无关的字节上限（例如复用 `MAX_TRACE_PREVIEW_CHARS` 量级或单独定一个 `MAX_COMPACTION_SUMMARY_BYTES` 常量），超限时走既有的 `giveUp('compaction_over_budget', ...)` 分支，使这条落盘来源与其它来源在"有没有独立于模型配置的硬顶"这一点上保持一致。

---

### [capacity-04] low capacity | P3-1 | src/runtime/plugins/session/store.ts:288-295 | 会话文件缺少"单行最大字节"安全网，只有聚合字节检查

DESC: `appendEntry()` 的写入前检查是 `this.bytes + bytes > this.maxBytes`（`store.ts:290`），只保证"写完这次不超预算"，不限制单次写入本身能有多大。当文件当前字节数较小（例如刚创建的会话，或者会话经过 `/compact` 把体积打回较低水位之后）时，单独一行理论上可以逼近整个 32 MiB 预算。这条安全网的缺失本身不是新问题（`capacity-reconciliation-2026-09-15.md` 第六节已经把它列为"待落地"并建议作为独立小任务评估），本次复核确认在当前 HEAD 上依然如此，且它正是 capacity-01（附件无上限）能够造成"文件永久打不开"这个最坏后果的放大器——如果这道单行安全网存在，capacity-01 至少不会在文件几乎为空时被一条消息吃掉大半个预算。

EVIDENCE:
```ts
// src/runtime/plugins/session/store.ts:288-295
const line = `${JSON.stringify({ kind: 'entry', lane: 'main', ...item })}\n`;
const bytes = Buffer.byteLength(line);
if (this.bytes + bytes > this.maxBytes)
  throw new RuntimeHostError(
    'session_size_limit',
    'session exceeds the configured size budget'
  );
```

SCENARIO: 见 capacity-01 的场景——如果同时补上这道单行上限（例如单条 ≤ 4 MiB），capacity-01 描述的"两三条消息顶满会话"的最坏路径会被提前拦在更早的一步，用户会在发送时立刻收到"这条消息太大"的拒绝，而不是在若干条消息之后才发现整个会话打不开了。

FIX: 在 `appendEntry` 的检查里追加一道独立的单行上限（例如 `SESSION_MAX_ENTRY_BYTES`，建议取一个明显小于 32 MiB 的值，比如 4～8 MiB），与聚合检查并列执行，两道检查中任意一道触发都拒绝写入。

---

### [capacity-05] medium concurrency | P3-1 | src/runtime/trace.ts:81,209-244 | 多个 worker 进程共享同一 traceDir 时，runs.jsonl 的轮转没有跨进程互斥

DESC: `TracePlugin` 的写入串行化只在**单个进程内**有效——`private pending: Promise<void> = Promise.resolve()`（`trace.ts:81`）是实例字段，`persist()` 里的 `this.pending = work.catch(() => {})`（`:216`）把同一实例的多次写入排成队列，但每个 worker（每个会话对应一个独立的长驻子进程/utility 进程）都会 new 出自己的一个 `TracePlugin` 实例。`traceDir` 由 `bootstrap.ts:399` 决定，默认取 `flags.traceDir`（`flags.ts:53`），后者直接读单个环境变量 `AICLIENT_RUNTIME_TRACE_DIR`（`flags.ts:33,52`），没有按会话/进程做任何子路径区分，目标文件名固定是 `join(dir, 'runs.jsonl')`（`trace.ts` `persist()` 内）。也就是说：只要这个环境变量被设置（当前没有任何生产代码路径会自动设置它，只有开发者手工开启用于调试），同时打开的多个会话窗口对应的多个 worker 进程，会全部向同一个文件路径追加/轮转，而 `rotate()`（`:244-268`）的"读盘 size → 判断是否需要 rename"这套逻辑完全没有跨进程锁。

EVIDENCE:
```ts
// src/runtime/trace.ts:81
private pending: Promise<void> = Promise.resolve();
```
```ts
// src/runtime/flags.ts:52-53（traceDir 是进程级单一路径，不按会话/worker 区分）
agentDir: firstNonEmpty(env[RUNTIME_AGENT_DIR_ENV], env[PI_AGENT_DIR_ENV]),
traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV]),
```
```ts
// src/runtime/trace.ts:244-249（rotate 判断基于磁盘 stat，两个进程可能同时判定要轮转）
private async rotate(dir: string, path: string, incoming: number): Promise<Error | undefined> {
  if (this.maxFileBytes <= 0) return undefined;
  try {
    const size = await this.size(path);
    if (size === 0 || size + incoming <= this.maxFileBytes) return undefined;
```

DESC 补充：这条影响面被限定在"手工设置了 `AICLIENT_RUNTIME_TRACE_DIR`"这个前提下——打包后的应用默认不写 `runs.jsonl`（T024 对账表已确认这一点），因此普通用户不会触发。但一旦开发者/QA 在排查问题时打开这个开关做多会话联调（这是完全正常的调试操作，不需要构造任何异常输入），多个 worker 进程立刻会指向同一个文件。

SCENARIO: 开发者为排查问题设置 `AICLIENT_RUNTIME_TRACE_DIR` 后，同时打开两个会话窗口（两个独立 worker 进程）。两个进程各自的 `finish()` 前后脚调用 `persist()`：进程 A 读到当前 `runs.jsonl` 是 8.1 MiB（超过 `TRACE_FILE_MAX_BYTES`），开始执行 rename 链（`path → runs.1.jsonl → runs.2.jsonl → runs.3.jsonl`）；几乎同时进程 B 也读到同样的旧 size（在 A 的 rename 完成之前 stat），也判定需要轮转，对同一组文件名再执行一次 rename 链。按 T024 文档自己的结论，最坏情况是"多轮转一次，丢一代历史"（不会损坏正在写的文件），本次复核确认这个结论仍然成立、且没有任何代码变化过这部分逻辑；但这仅是"读代码"层面的推论，没有用两个真实 Node 进程构造过这个交织去验证代际丢失之外是否还有其它交织（例如两个 append 恰好落在同一次 rename 窗口内导致某次 append 内容跟着旧代际一起被 rename 走）。

FIX: 若确认这条路径值得在当前优先级下修（考虑到影响面仅限手工开发调试场景），可选方案：(a) 给每个 worker 生成的 traceDir 加进程级子路径（如按 sessionId 或 pid 分子目录），从根本上避免共享同一文件；(b) 给 `rotate()` 加跨进程文件锁（复用会话 store 已有的写锁机制）。若认为当前优先级不值得修（影响面小、后果有限），至少应在 `flags.ts`/`trace.ts` 的注释里显式记录这条已知限制，避免下一个人以为"轮转是安全的"。鉴于触发只需要多开会话 + 设置一个环境变量，且可以在本机用两个 Node 进程直接复现，不需要 Windows/加密机/Electron/真实模型，建议作为一条可在 dev box 上验证的用例补测，而不必等批次 E。

## 测试缺口

- 没有任何测试把"附件体积"这条链路从 IPC 层走到 session 落盘层串起来验证——`attachmentLimits.test.ts` 只测纯函数 `admitAttachment`，`src/runtime/__tests__/session.test.ts` 里唯一出现 `maxBytes` 的用例（第 280 行附近）测的是 resume 时的读取上限，不是"单条消息因附件过大而顶满预算"这个场景。
- `src/runtime/plugins/agent-loop/attachments.ts` 的 `preparePrompt()` 本身没有任何尺寸相关的测试（现有测试只覆盖 kind 分支与 metadata 组装）。
- `trace.test.ts` 没有验证"运行中 `steps` 数组累积超大 `args` 后的内存/序列化行为"，也没有验证多 `TracePlugin` 实例并发写同一文件的交织结果。
- `context/index.ts` 的压缩流程没有"summary 超大触发 `compaction_over_budget`"的直接构造用例（依赖真实 provider 输出大小间接触发，难以在单测里稳定复现）。
- `session/store.ts` 没有"文件几乎为空、单条写入本身逼近 `maxBytes`"的直接构造用例；现有的 `session_size_limit` 相关测试大概率都是靠累积多条写入触发。

## 未经执行验证的声明

- capacity-01 的"两三条消息即可顶满会话"是按 `DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes`（10 MiB 原始字节）与 base64 膨胀系数 ~1.34 算出来的估算，没有真实跑一遍"发送若干条带图片消息直到会话打不开"的端到端复现。
- capacity-01 中"渲染层是唯一防线、绕过 UI 可注入任意大小附件"这一结论基于代码路径追踪（preload/IPC/WorkerManager/runtime 四层均未见校验代码），没有实际发起过一次绕开 Composer 的 `CHAT_SEND` 调用去验证 Main 确实会放行。
- capacity-05 的"多进程并发轮转最坏情况是丢一代历史、不损坏正在写的文件"沿用的是 T024 对账表自己的静态结论，本轮没有用两个真实 Node 进程构造这个交织去复验，也没有排除"append 恰好落在 rename 窗口内"这类更细的交织可能性。
- capacity-03 中"大上下文窗口模型可能产出远超其它落盘来源量级的摘要正文"依赖于"存在配置了大窗口模型"这一前提，本轮没有核实当前产品实际接入的模型目录里是否真的有这类模型、以及它们的默认 `hardLimit` 配置数值。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| 附件顶满会话文件后打不开 | 连续发送 2~3 条各含多张图片附件（贴渲染层允许上限）的消息后，会话文件字节数是否逼近/超过 32 MiB；重开该会话是否抛 `io_limit` | 用真实 Electron GUI 走一遍 Composer 发送流程，观察会话文件大小与重开结果；或在 runtime 包内写一个直接调用 `preparePrompt` + `session.appendMessage` 的构造用例模拟同等字节量 | dev-box |
| Main IPC 层缺失附件校验 | 绕开 Composer，直接向 `CHAT_SEND` 传超过 `DEFAULT_ATTACHMENT_LIMITS` 的 attachments payload，确认 Main 不拒绝、请求原样送达 worker | 起 Electron 应用，在渲染层 devtools 控制台直接调用 `window.api` 暴露的发送接口并传构造好的超限 payload | dev-box |
| 多进程并发轮转同一 runs.jsonl | 设置 `AICLIENT_RUNTIME_TRACE_DIR` 指向同一目录，起两个独立的 runtime worker 进程各自产生接近 `TRACE_FILE_MAX_BYTES` 的 trace 并几乎同时 `finish()`，检查是否出现代际丢失或写入交织/损坏 | 用两个 Node 子进程直接跑 runtime 包的 bootstrap（不需要 Electron），共享同一 `AICLIENT_RUNTIME_TRACE_DIR` | dev-box |
| 压缩摘要真实体积上限 | 用一个大上下文窗口的真实模型触发 `/compact`，测量 `summary` 实际字节数，判断是否需要独立硬顶 | 真实模型回合 + 读会话文件里的 compaction 条目字节数 | real-model |
| MCP 图片字节假设 | 核实 1 MiB/张、2 MiB/次的假设是否贴合真实 MCP 截图服务器的输出分布（T024 已列为未验证，本区域一并确认仍未验证） | 接入真实 MCP 截图/图片服务器，观察实际返回的图片字节分布 | real-model |

## 读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md
- docs/plantree/plans/runtime-hardening/roadmap.md
- docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md
- src/renderer/components/chat/attachmentLimits.ts
- src/renderer/components/chat/useComposerAttachments.ts
- src/renderer/components/chat/attachments.ts（部分，`bytesToBase64` 等辅助函数引用点）
- src/main/ipc/chat.ts
- src/main/ipc/attachmentReadGuard.ts
- src/main/services/agent-host/WorkerManager.ts（部分，`send()` 附近）
- src/preload/index.ts（部分，`CHAT_SEND` 绑定处）
- src/runtime/plugins/agent-loop/attachments.ts
- src/runtime/plugins/agent-loop/index.ts（部分，事件订阅、trace.note 调用点、compaction 处理）
- src/runtime/plugins/context/index.ts（部分，压缩流程 `prepareTurn`/`summarize`/`installCheckpoint`）
- src/runtime/plugins/session/store.ts（部分，`open`/`appendEntry` 等写入检查点）
- src/runtime/plugins/session/codec.ts（`SESSION_MAX_BYTES` 定义处）
- src/runtime/plugins/subagent/records.ts（部分，`MAX_RECORDED_TEXT_CHARS` 与字段裁剪）
- src/runtime/plugins/subagent/index.ts（部分，`MAX_DELEGATION_TRANSCRIPT_BYTES` 定义与使用点）
- src/runtime/trace.ts
- src/runtime/flags.ts
- src/runtime/bootstrap.ts（部分，`traceDir` 组装处）
- src/runtime/host/io.ts（部分，`readResult` 的 `overflow: 'error'` 语义）
- src/shared/types/agentHost.ts（部分，`SessionAttachment` 类型定义）
- src/runtime/__tests__/session.test.ts（部分，`maxBytes` 相关用例）
- src/runtime/__tests__/trace.test.ts（确认覆盖范围，未逐行通读）
- src/renderer/components/chat/__tests__/attachmentLimits.test.ts（确认覆盖范围，未逐行通读）
