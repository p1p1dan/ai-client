# 批次 D 区域补审：agent-host 未读模块与 runtime → agent-host 依赖方向

- **区域**：agent-host-lib
- **任务**：T029（批次 D 审计覆盖补全，只读）
- **节点判定对象**：P3-2、P6-5 尾巴、依赖边界
- **对应批评者缺口**：缺口 5（cross-and-critic.md 第 68 行）、缺口 19（第 82 行）
- **基线 HEAD**：`ebc82f16`
- **日期**：2026-09-15
- **方式**：只读。未改任何文件（本报告除外），未跑构建 / tsc / vitest / Electron。

---

## 总评

批评者缺口 5 点名的四个模块（`piSessionTree.ts`、`stderrRedaction.ts`、`piWorkerErrors.ts`、`userResourcePaths.ts`）与顺带要求的 `piSessionTimeline.ts` 已全部读完。结论分三层：

**会话树这一层是干净的。** P3-2 当初判 complete 的第一条理由「树 / 历史复用 piSessionTree」现在有了代码证据，而且比预期好：`piSessionTree` 的 fork 可用性判定（节点自身或祖先链上有一条 assistant 消息）与 runtime 自己 `createFork` 的准入条件（`branchEntries(document, entryId)` 里必须有 assistant）是同一条规则的两种写法，不会出现「界面给了分叉按钮、后端拒绝」的错位；`seq` 根本不进树（树只走 parentId 链），所以 T003 改 `seq` 口径没有波及；T034 中段坏行跳过之后树也不会出现孤儿，因为解码端在跳行之后仍然强制「父必须在场」，父被跳掉的文件是整体拒绝打开而不是带着断链进树。

**脱敏这一层有真问题。** 仓库现在有三份脱敏实现，规则强弱差了一大截，而最弱的那一份守着最要紧的那条路。更关键的是存在一条**两份都没走**的路：assistant 消息里 pi-ai 折进来的原始 HTTP 错误正文（最多 4000 字符）被原样写进会话文件，T011 只给 trace 和运行结果那一份做了脱敏。

**退役清扫这一层还有尾巴。** 缺口 19 抱怨的那条注释已经被 T025 改对了，`bundledPlugins.mjs` 也确实还有活消费者，这一半可以销账；但同一类「legacy 走了、消费者没了」的残留还有两处没被扫到：一个死模块（`userResourcePaths.ts`），和渲染层一张仍按 pi 时代词汇查表的错误分类表——后者是用户可见的错误行为，不是死代码。

依赖方向本身我判断**不构成 ARD 违规**：ARD 5.1 只写了「在 `src/runtime/` 下新建插件图，与现有 `src/agent-host/` 共存」，没有写单向依赖；实际这条边只有四个模块、全是纯函数、不碰 fs / 子进程，打包时两个目录会被 esbuild 合并进同一个 `worker.js`，所以产物层面这条边根本不存在。它的实际代价不在架构，而在「没人规定谁拥有公共助手」——脱敏那两份重复实现就是这个代价的具体形态。

可信度：会话树、依赖方向、打包路径三块是**静态可证**的；脱敏那条链的**代码路径**静态可证，但「真实 provider 的错误正文里确实会出现凭据」这一步需要真实回合取证，已标 static_inference。

---

## 优点

1. **`piSessionTree` 与 runtime codec 的语义是对齐的，而且是按同一条规则各写一遍，不是巧合。**
   `piSessionTree.ts:186` 的 `forkable` 沿 DFS 路径累积「祖先链上有没有 assistant」，`store.ts:466` 的 `createFork` 用 `branchEntries(document, entryId)` 查同一件事。两者对同一个节点必然给出同一个答案。

2. **树的构建是迭代的，并且自带「不可达就兜底」的防线。**
   `piSessionTree.ts:157` 起用显式栈做前序遍历，`piSessionTree.test.ts:53` 用 10 000 个节点钉住不爆栈；`piSessionTree.ts:203` 的环 / 孤儿兜底保证「任何一条有效条目都还能被看到」。在当前解码规则下这条兜底不可达（解码端不允许孤儿也不可能成环），属于成本极低的保险。

3. **`stderrRedaction.ts` 本身是三份实现里最完整的一份，而且测试很硬。**
   `stderrRedaction.test.ts` 有 40 余条断言，覆盖了 provider 前缀密钥、大小写不敏感的 auth scheme、Basic base64、URL userinfo、JSON 键、带空格 / 撇号的 Windows 用户名、WSL 与 UNC 路径，还有一组「诊断价值必须存活」的反向断言。

4. **缺口 19 的注释半边已修（T025）。**
   `workerStripOnlyCompat.test.ts:114-126` 现在写的是「worker.ts 只通过 `import('../runtime/...')` 到达 runtime，静态走法只能看到 16 个文件」，与实况一致；`bundledPlugins.mjs` 也不再是死数据，`scripts/agent-host-build-lib.mjs:4`、`scripts/verify-packaged-app.mjs`、`src/main/ipc/piResources.ts:10`、`src/main/services/piModelConfig/index.ts:18` 都在读它。

5. **`@earendil-works/pi-coding-agent` 仍留在 `src/agent-host/package.json` 不是漏清。**
   `piCliIsBundledToolOnly.test.ts` 用一条长期守卫把「它是随包可执行文件、不是库」这条口径钉死了，允许名单里只剩一个测试夹具。我一度以为这是 P6-5 的尾巴，读完守卫后判定不是。

6. **打包路径上这条跨目录依赖是隐形的。**
   `scripts/build-agent-host.mjs:57-67` 用 `outfile` 且没开 `splitting`，字面量动态 import 会被 esbuild 内联进同一个 `worker.js`，所以 `src/runtime → src/agent-host` 在产物里不留任何痕迹，不存在「打包时少拷一个目录」的陷阱。

---

## 弱点

1. **脱敏被写了三遍，强弱不一，而且没有一处说明彼此关系。**
   `src/agent-host/stderrRedaction.ts`（CLI stderr → 渲染层）最全；`src/main/services/auth/redact.ts`（凭据子系统 console）次之，它的模块注释明确说「与 stderrRedaction 同范式」并解释了为什么自己的名单更宽；`src/runtime/plugins/agent-loop/providerErrors.ts` 的 `redactSensitiveErrorText` 最弱，只有三条规则，而且它的注释完全没提到前两份的存在。批评者缺口 5 原文就提醒过「core-host-03 在提出改法前应当先看它」，T011 落地时显然没看。

2. **`NativeWorkerRuntimeError` 是 `PiWorkerSessionError` 的逐字重写。**
   `src/runtime/worker/nativeWorkerRuntime.ts:71-80` 与 `src/agent-host/piWorkerErrors.ts:1-13` 字段、构造签名、默认值完全相同，只差 `name`。runtime 明明已经 import 了 agent-host 的另外四个模块，却在错误类型上另起一份——「哪些东西可以跨这条边」没有成文规则，结果就是同一批代码里两种做法并存。（不立发现：两者行为一致，`errorPayload` 的通用分支把两者都正确摊平成 `{code, message, retryable}`。）

3. **没有任何守卫钉住 `src/runtime → src/agent-host` 这条边。**
   见发现 ah-lib-05。

4. **`piSessionPreflight.ts` 这个文件名现在是错的，而且文件自己承认。**
   `piSessionPreflight.ts:22-24` 写着「保留文件名只是为了让那条 import 不用改，因为另一个代理正在编辑那个文件」。T028 的权宜之计，现在已经没有并发编辑的理由了。（不立发现：属于 T028 已记录的取舍，文件内自述完整。）

5. **两个被 runtime 直接消费的模块，测试覆盖明显落后于它们承担的责任。**
   见发现 ah-lib-06。

---

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| **P3-2**（会话树与互通） | complete-with-gaps | 审计当时「`piSessionTree.ts` 未被读过」的空白已补齐，且没有查出正确性缺陷：fork 可用性、父链、压缩锚点、T034 跳行后的树一致性四条都与 runtime codec 对齐（见优点 1 / 2，以及本报告「审查轴 a」一节的推演）。缺口只有测试面：ah-lib-06。 |
| **P6-5 尾巴**（退役清扫的另一半） | complete-with-gaps | 缺口 19 两个半边都已销账（注释已修 T025；`bundledPlugins.mjs` 与 scripts 侧依赖仍是活的、有守卫）。但同一把扫帚没扫到的残留还有两处：ah-lib-04（死模块 + 它承载的指令没有替身）、ah-lib-03（渲染层仍按 pi 词汇分类恢复失败，用户看到错误的文案与错误的可重试性）。 |
| **依赖边界**（runtime → agent-host） | complete-with-gaps | 这条边符合 ARD 口径（5.1 只要求共存，未规定单向），范围小、全纯函数、打包时被合并，不构成架构违规。缺口是「无人规定、无人守卫」的连带后果：ah-lib-05（守卫可被绕过、这条边本身无守卫）、ah-lib-01 与 ah-lib-02（公共助手无归属，导致脱敏被写三遍且最弱的一份守着最要紧的路）。 |

---

## 发现

### [ah-lib-01] medium security | 依赖边界 | src/runtime/plugins/agent-loop/index.ts:463 | 会话文件落盘的 provider 错误正文两套脱敏都没走

**DESC**
T011 修 core-host-03 时，把 provider 错误正文的脱敏放在了 `TurnCollector.observe`（`index.ts:691`）——它给自己新建的 `CollectedTurn` 做了一份脱敏副本，trace 的 `llm` 便签和 `RuntimeRunResult.error.message` 都吃这份副本。但**同一个事件对象**在这之前一行就已经被原样写进会话文件了：`index.ts:463` 的 `session.appendMessage(event.message)` 早于 `collected.observe(event)` 执行，写的是未脱敏的原件。收集器只造新对象、从不改写 `event.message`，所以两者互不影响。

结果：`runs.jsonl` 是干净的，会话 JSONL 不是。而会话文件恰恰是这条链上生命周期最长、最容易被带走的一件——它与 `pi --session` 互通（H/20），会被导入 / 导出流程读写，也是用户报 bug 时最可能附上的文件。

正文的来源是 pi-ai：`src/runtime/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js` 的 `normalizeProviderError` / `formatProviderError` 会把非 2xx 响应的**原始 body** 折进 `errorMessage`，上限 `MAX_PROVIDER_ERROR_BODY_CHARS = 4000`；`index.ts:686-688` 的注释自己也是这么写的（「pi-ai folds raw HTTP response bodies into this field (up to 4000 chars, unredacted)」）。

**static_inference = true**：代码路径静态可证（三处行号可逐行核对）；「真实网关的 4xx body 里确实会回显凭据或 Authorization 头」这一步需要真实 provider 回合或一个会造 body 的假 provider 才能取证，本轮未执行。

**EVIDENCE**

`src/runtime/plugins/agent-loop/index.ts:462-465`
```ts
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === 'message_end' && session) await session.appendMessage(event.message);
      collected.observe(event);
      projected.observe(event);
```

`src/runtime/plugins/agent-loop/index.ts:684-694`（收集器一侧，脱敏只发生在这里）
```ts
      // core-host-03: pi-ai folds raw HTTP response bodies into this field
      // (up to 4000 chars, unredacted) before this collector ever sees it.
      // Sanitized once here so both consumers below — the `llm` trace note
      // and `resolveError`'s `RuntimeRunResult.error.message` — get the same
      // redacted, capped text instead of one going through classification
      // and the other bypassing it.
      ...(message.errorMessage
        ? { errorMessage: sanitizeProviderErrorText(message.errorMessage) }
        : {}),
```

`src/runtime/plugins/session/store.ts:230-232`（落盘端不做任何过滤）
```ts
  appendMessage(message: AgentMessage): Promise<void> {
    return this.appendEntry({ type: 'message', message: structuredClone(message) }).then(() => {});
  }
```

`src/runtime/plugins/session/codec.ts:186-195`（解码端也原样保留未知字段，所以它会一直留在文件里）
```ts
function entry(value: Record<string, unknown>): Entry {
  if (
    typeof value.id !== 'string' ||
```

**SCENARIO**
用户配了一个自建网关 / 代理作为 provider。某一轮请求 401，网关把收到的请求头回显进 body（`{"error":"unauthorized","received":{"authorization":"Bearer sk-ant-api03-xxxx"}}`，这是自建网关常见的调试回显）。pi-ai 把这段 body 折进 assistant 消息的 `errorMessage`；`index.ts:463` 把这条 `stopReason: 'error'` 的 assistant 消息原样追加进会话 JSONL。此后：`runs.jsonl` 里是 `[REDACTED]`，会话文件里是明文密钥，长期驻留；用户把会话文件发给别人排查（或用 `pi --session` 打开）时随之外泄。

**FIX**
在 `index.ts:463` 落盘前也过一次 `sanitizeProviderErrorText`，即把 `event.message` 换成一份 `errorMessage` 已脱敏的副本再 `appendMessage`（`message_end` 的其余字段不变）；或者更彻底，把脱敏提到订阅回调的最上游做一次，让 `appendMessage` / `collected` / `projected` 三个下游天然吃同一份。同时补一条用例：假 provider 产出带 `Authorization: Bearer sk-ant-…` 的 `errorMessage`，断言会话文件里不含该串。

---

### [ah-lib-02] medium security | 依赖边界 | src/runtime/plugins/agent-loop/providerErrors.ts:39 | T011 新写的脱敏规则比仓库既有那份弱，认不出裸密钥形状

**DESC**
批评者缺口 5 提醒过「`stderrRedaction.ts` 是仓库既有的脱敏实现，core-host-03 在提出改法前应当先看它」。T011 没有复用它，而是在 runtime 侧新写了 `redactSensitiveErrorText`，只有三条规则：`authorization: bearer …`、`api_key|access_token|password` 后跟 `=` 或 `:` 的赋值、控制字符。

`stderrRedaction.ts:40-53` 有而它没有的，主要是**按形状识别的裸密钥**这一整类：`sk-ant-*`、`sk-proj-*`、长 `sk-*`、`sk_live_/sk_test_*`、`gh[pousr]_*`、`AIza*`、`AKIA/ASIA*`，外加 `basic` scheme、`x-api-key` 头、URL userinfo。`stderrRedaction.ts:36-39` 的注释写明了这类规则存在的理由：「裸密钥不带任何敏感字段名可供赋值规则挂钩，形状是唯一的抓手」。provider 错误正文正是最容易出现裸密钥的地方，因为服务端回显的措辞通常是散文而不是赋值。

顺带一提，第三份实现 `src/main/services/auth/redact.ts` 反而知道这件事：它的注释明确说「与 `stderrRedaction.ts` 同范式」，并逐条解释自己为什么加 cookie 系、为什么去掉裸 `key`。三份里只有 runtime 这份不知道另外两份存在。

**static_inference = true**：规则差异静态可证；「真实 provider 会以哪种措辞回显密钥」需真实回合取证。

**EVIDENCE**

`src/runtime/plugins/agent-loop/providerErrors.ts:39-47`
```ts
export function redactSensitiveErrorText(message: string): string {
  return message
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(CONTROL_CHARACTERS, '');
}
```

`src/agent-host/stderrRedaction.ts:36-47`（既有实现里这一整类规则）
```ts
  // Key material by shape, wherever it appears. The set is enumerable
  // provider prefixes plus a generic long-sk catchall — bare keys carry no
  // sensitive-field name for the assignment rule to hook, so shape is the
  // only handle (review F2, two rounds).
  { pattern: /sk-ant-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  { pattern: /\bsk-proj-[A-Za-z0-9_-]+/g, replacement: '[redacted]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
```

**SCENARIO**
OpenAI 兼容网关对一个错误的密钥返回 `Incorrect API key provided: sk-proj-AbCd1234...`。`redactSensitiveErrorText` 的赋值规则要求名字（`api[_-]?key`）后面紧跟 `=` 或 `:`，而这里名字与冒号之间隔着 `provided`，正则不命中；裸 `sk-proj-` 也没有任何形状规则去抓。于是完整密钥进 `runs.jsonl` 的 `llm` 便签与 `RuntimeRunResult.error.message`，并（叠加 ah-lib-01）进会话文件。同一串字符如果出现在 CLI 的 stderr 里，`redactStderrLine` 会直接把它打成 `[redacted]`——同一个密钥，走两条路两种结局。

**FIX**
把形状规则做成一份共享数据，两侧各自组装：可以从 `stderrRedaction.ts` 抽出 `KEY_SHAPE_RULES` 导出（runtime 已经在 import agent-host 的四个模块，多一个不改变依赖方向），或者反过来把这份规则表下沉到 `src/shared/`，让三份实现都从同一张表取。至少要让 `redactSensitiveErrorText` 覆盖 `sk-ant-*` / `sk-proj-*` / 长 `sk-*` / `gh[pousr]_*` / `AIza*` / `AKIA|ASIA*` 与 URL userinfo；并在 `providerErrors.ts` 的模块注释里写清与另外两份实现的关系，避免第四份再被写出来。

---

### [ah-lib-03] medium correctness | P6-5 尾巴 | src/renderer/components/chat/historyError.ts:27 | 恢复失败的分类表仍查 pi 时代的 `WORKER_SESSION_*` 词汇，native 的错误码一条都不认

**DESC**
`encodePiResumeError` 用 `message.includes('WORKER_SESSION_FILE_NOT_FOUND' | 'WORKER_SESSION_FILE_CORRUPT' | 'WORKER_SESSION_CWD_MISMATCH' | 'WORKER_WORKSPACE_MISSING')` 把恢复失败分到具体文案上。我在 `src/` 内全量检索这四个串：**只有 `WORKER_WORKSPACE_MISSING` 还有生产者**（`src/main/services/agent-host/PiWorkerProcess.ts:72`），另外三个在非测试代码里零生产者。

原因是退役换了词汇：会话的打开与校验现在由 runtime 自己做，抛的是 `RuntimeHostError`，码是小写下划线的 `session_invalid` / `session_cwd_mismatch` / `session_size_limit`，文件不存在时更是直接漏出 Node 的 `ENOENT`。这些码经 `piWorkerRpcServer.errorPayload`（通用 Error 分支取 `.code`）→ `WorkerSlot` 拼成 `` `${code}: ${message}` `` → 渲染层。于是全部落到兜底的 `read_failed`。

`read_failed` 的文案与语义正好和真实情况相反：`retryable: true`、`continuationHint` 是「对话没有中断，你可以继续发消息」。而会话文件损坏 / 工作区不匹配这两种情况下 bootstrap 根本没起来，下一条消息同样会失败。与此同时，`session_file_corrupt`（「会话历史已损坏，原文件未被修改或替换」，不可重试）和 `session_cwd_mismatch`（「这个会话属于另一个工作区」，指引用户换工作区打开）两张写好的卡片变成了不可达代码——`MessageTimeline.tsx:841` 还给 `session_cwd_mismatch` 留着图标。

讽刺的是 runtime 抛的码 `session_cwd_mismatch` 与渲染层的 `HistoryErrorCode` 字面完全相同，只差匹配规则写死了 `WORKER_SESSION_` 前缀。

这与批评者抽查到的 `TOOL_VERBS` 漂移是同一类（查表点还按 Claude / pi 时代的词汇），但那一条已由 T020 修掉，这一条至今无人报过——我在 `docs/` 下检索 `encodePiResumeError` 与 `WORKER_SESSION_FILE_CORRUPT` 无任何命中，不存在已记录的豁免。

**EVIDENCE**

`src/renderer/components/chat/historyError.ts:25-41`
```ts
export function encodePiResumeError(error: unknown): { message: string; encoded: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes('WORKER_SESSION_FILE_NOT_FOUND')
    ? 'jsonl_not_found'
    : message.includes('WORKER_SESSION_FILE_CORRUPT')
      ? 'session_file_corrupt'
      : message.includes('WORKER_SESSION_CWD_MISMATCH')
        ? 'session_cwd_mismatch'
        : message.includes('WORKER_WORKSPACE_MISSING')
          ? 'workspace_missing'
          : ... 'read_failed';
```

`src/runtime/plugins/session/store.ts:162-166`（native 实际抛的码）
```ts
        if (document.header.cwd !== (await io.realpath(config.cwd)))
          throw new RuntimeHostError(
            'session_cwd_mismatch',
            'resume cwd differs from the session workspace'
          );
```

`src/runtime/plugins/session/codec.ts:125-127`（损坏文件抛的码）
```ts
function invalid(message: string): never {
  throw new RuntimeHostError('session_invalid', message);
}
```

`src/main/services/agent-host/WorkerSlot.ts:561-566`（拼成渲染层看到的那句话）
```ts
    pending.reject(
      new WorkerSlotError(
        'WORKER_RPC_REMOTE_ERROR',
        `${message.error.code}: ${message.error.message}`,
        message.error
      )
    );
```

`src/renderer/components/chat/historyError.ts:130-137`（用户实际拿到的文案）
```ts
  read_failed: {
    severity: 'error',
    title: 'Failed to read history',
    guidance:
      'Reading or parsing the history file failed, so the history below may be missing or incomplete.',
    retryable: true,
    continuationHint: HISTORY_ERROR_NON_FATAL_HINT,
  },
```

**SCENARIO**
用户把 A 仓库的会话文件路径挪到 B 仓库打开（或索引行还在、工作区换了）。runtime 抛 `session_cwd_mismatch`，渲染层拿到的字符串是 `session_cwd_mismatch: resume cwd differs from the session workspace`，`includes('WORKER_SESSION_CWD_MISMATCH')` 为假 → 落 `read_failed` → 卡片显示「Failed to read history … 对话没有中断，你可以继续发消息」并给出 Retry 按钮。用户按 Retry，同样失败；正确的那张卡（「这个会话属于另一个工作区，请从它所属的工作区打开」）永远不出现。同理，会话文件被删掉时 `ENOENT: … stat '/home/dan/.pi/…jsonl'` 也落 `read_failed`，而不是 `jsonl_not_found` 那张「这个对话无法继续，下一次发送就会失败，请新建对话」的卡。

**FIX**
把匹配改成认 native 的码，并且认**码字段**而不是在消息正文里做子串搜索：`WorkerSlotError` 已经带 `remoteError.code`（`remoteCode` getter），`encodePiResumeError` 应当优先读它。映射建议：`session_invalid` → `session_file_corrupt`；`session_cwd_mismatch` → 同名；`ENOENT`（以及 Main 的 `pi_session_not_found`）→ `jsonl_not_found`；`session_size_limit` 需要一张新卡（现有七张都不贴切）。旧的 `WORKER_SESSION_*` 分支只保留 `WORKER_WORKSPACE_MISSING`（唯一还有生产者的那个），其余删掉。补用例：`historyError.test.ts` 现有的码表用例逐条改成 native 码，并加一条「未知码不得落到 `retryable: true` 的文案」的反向断言。

---

### [ah-lib-04] low dead-code | P6-5 尾巴 | src/agent-host/userResourcePaths.ts:23 | 模块零消费者，它承载的「技能装到哪」指令在 native 提示词里没有替身

**DESC**
`userResourcePaths.ts` 现在只导出一个函数 `defaultSkillInstallInstructions`。我在 `src/` 与 `scripts/` 全量检索这个符号与文件名：**零引用**，连测试文件都没有（`src/agent-host/__tests__/` 下没有同名测试）。它是 P6-5 退役后失去消费者的一层，T025 扫掉了五个孤儿模块（`bundledFeaturePlugins` / `extensionInventory` / `commandInventory` / `sessionTierAuthorizer` / `permissionActivity`），这一个不在清单上。

比死代码本身更值得记一笔的是它承载的行为：模块开头写「The one instruction every session appends about where skills get installed」。现在 native 的提示词里没有任何一句告诉模型技能该装到哪——`src/runtime/plugins/skills/prompt.ts` 的 `skillsSegment` 只列出已有技能的 name / description / location，没有安装目的地；`prompt/segments.ts` 的槽位表里也没有对应槽。而扫描端是活的：`src/runtime/plugins/skills/index.ts:223` 仍把 `join(home, '.agents', 'skills')` 作为 user 作用域的扫描根。也就是说「装到哪会被扫到」这条约定只剩下扫描的一半，告知的一半没了。

**EVIDENCE**

`src/agent-host/userResourcePaths.ts:1-2, 23-27`
```ts
/**
 * The one instruction every session appends about where skills get installed.
 ...
export function defaultSkillInstallInstructions(
  home = process.env.HOME || process.env.USERPROFILE || homedir()
): string {
  return `When asked to install a skill, use ${join(home, '.agents', 'skills')} as the default installation directory, with one <skill-name>/SKILL.md per skill. This shared location is loaded by managed GUI, local GUI, and Pi TUI sessions. Use another destination only when the user explicitly requests it.`;
}
```

检索结果（`src` + `scripts`，排除 `node_modules`）：`defaultSkillInstallInstructions` 与 `userResourcePaths` 的唯一命中就是该文件自身，其余命中全在 `docs/` 的历史证据与调研文档里。

`src/runtime/plugins/skills/index.ts:223`（扫描端仍然活着）
```ts
    roots.push({ path: join(home, '.agents', 'skills'), scope: 'user', rootMarkdown: false });
```

**SCENARIO**
用户对着 native 会话说「帮我把这个技能装上」。模型的系统提示词里没有任何关于安装目录的约定，于是它按自己的先验猜一个位置（常见的是工作区内、`~/.claude/skills`、或 `~/.pi/agent/skills`）。写进去之后 `skills/index.ts` 的扫描根不覆盖那个目录，技能列表里不出现这个技能，用户看到的是「装完了但用不了」。旧路径上 `defaultSkillInstallInstructions` 正是为了避免这一幕存在的。

**FIX**
两件事分开做：(1) 删除 `src/agent-host/userResourcePaths.ts`（无消费者、无测试，属于 T025 同一批清扫的漏网）；(2) 决定这句指令要不要在 native 侧复活——若要，把它作为一段静态文本并入 `skills/prompt.ts` 的 `skills` 槽（目录取 `skills/index.ts` 已经算出来的 user 作用域根，不要第二次算 home），并补一条断言「提示词里的安装目录必须等于扫描根之一」，把「告知」与「扫描」这两半绑在一起；若不要，在 P6-5 的落地记录里写明这是有意放弃的行为，别让它默默消失。

---

### [ah-lib-05] low contract-gap | 依赖边界 | src/runtime/__tests__/hostBoundary.test.ts:13 | 宿主边界守卫只扫 `src/runtime`，经 agent-host 模块可绕过；这条边本身无守卫无成文规则

**DESC**
D11 的硬约束是「runtime 内所有 fs 与子进程调用收敛到两个 service 出口」，守卫就是 `hostBoundary.test.ts` 的第一条用例。它的扫描根 `sources(root)` 写死了 `src/runtime`（且跳过 `host` / `smoke` / `spikes` / `__tests__`），对 `src/runtime` 之外的文件一律不看。

而 `src/runtime` 现在有四条指向 `src/agent-host` 的静态 import：`plugins/session/store.ts:11-12`（`piSessionTimeline` / `piSessionTree`）、`plugins/permissions/index.ts:4` 与 `plugins/permissions/policy.ts:3`（`permissionPolicy.mjs`）、`worker/nativeWorkerRuntime.ts:3-4`（`piSessionPreflight` / `piSessionTimeline`）。这四个模块当前都是纯的（我逐个确认：`piSessionTimeline` 只 import shared 类型，`piSessionTree` 只 import shared 类型与 `piWorkerErrors`，`piSessionPreflight` 只 import `node:path`，`permissionPolicy.mjs` 无 import），所以今天没有违规。但守卫管不到它们：任何人给这四个文件之一加一行 `import { readFile } from 'node:fs/promises'`，D11 的守卫仍然全绿。

更上一层的问题是这条边**根本没有被表述过**。ARD 5.1 只写「与现有 `src/agent-host/` 共存」，没写依赖方向；`nativeWorkerDependencyBoundary.test.ts` 管的是反方向（worker 入口不许静态加载 pi 包）；`piCliIsBundledToolOnly.test.ts` 管的是 pi 包；`flags.test.ts` 管的是一个退役环境变量。没有任何一条规则说明「runtime 可以从 agent-host 拿什么、不可以拿什么」，`NativeWorkerRuntimeError` 重写而不是复用 `PiWorkerSessionError`（见弱点 2）就是这个真空的直接产物。

**EVIDENCE**

`src/runtime/__tests__/hostBoundary.test.ts:11-27`
```ts
const root = fileURLToPath(new URL('..', import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'host', 'smoke', 'spikes', '__tests__'].includes(entry.name)) return [];
    ...
describe('runtime host boundary', () => {
  it('keeps filesystem and process APIs inside the host implementation', () => {
    for (const path of sources(root)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(
        /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process|node-pty)['"]/
      );
```

`src/runtime/plugins/session/store.ts:11-12`
```ts
import { projectPiSessionHistory } from '../../../agent-host/piSessionTimeline.ts';
import { buildPiSessionTreeSnapshot } from '../../../agent-host/piSessionTree.ts';
```

**SCENARIO**
有人要给会话树加「按标签过滤」，顺手在 `piSessionTree.ts` 里直接 `readFileSync` 一个配置文件（它就在 `src/agent-host/` 下，那个目录里 `worker.ts`、`piWorkerRpcServer.ts` 都在自由用 fs，看起来完全正常）。这个函数由 `store.ts` 在 worker 内调用，于是 runtime 在两个 IO 出口之外开了第三个口子：加密机上它不会走 TSD 回落路径，Windows 上它不走统一的路径规范化。`pnpm test` 全绿，D11 的守卫全绿，只有到现场才会炸。

**FIX**
两步，都很小：(1) 把 `hostBoundary.test.ts` 的扫描集合从「`src/runtime` 的全部源码」改成「`src/runtime` 的全部源码 **加上** runtime 静态 import 到的 `src/agent-host` 文件」——后者可以直接复用 `workerStripOnlyCompat.test.ts` 已有的图遍历器，从 `src/runtime/bootstrap.ts` 与 `src/runtime/worker/nativeWorkerRuntime.ts` 两个根走一遍，过滤出落在 `src/agent-host/` 的文件；(2) 加一条正向清单用例，把当前允许跨边的四个模块写成数组并断言 runtime 对 `../agent-host/` 的静态 import 集合恰好等于它（新增一个就要改清单、顺带回答「它该不该跨」），同时在 ARD 或 runtime README 写一句成文规则：runtime 只能从 agent-host 取**纯函数与常量**，不取任何带 IO 或进程状态的东西。

---

### [ah-lib-06] low test-gap | P3-2 | src/agent-host/__tests__/piSessionTimeline.test.ts:9 | 两个被 runtime 直接消费的模块缺关键用例：T005 的重开半边、以及 `forkable` 的正例

**DESC**
两处缺口：

其一，`piSessionTimeline.ts:265` 的 `if (isInternalMessage(message)) continue;` 是 T005（审计 high 级「子代理报告被当成用户消息」）的**重开半边**——直播时投影器挡住报告，重开会话时靠这一行挡住。`piSessionTimeline.test.ts` 的 8 条用例里没有任何一条涉及内部消息标记（我在该文件内检索 `internal`，零命中）。这条分支一旦回归，症状是「重开会话后对话顶部多出一条用户从没写过的消息，而且它是最新的那一条」，正是 T005 修的那个形态。同一个标记在 runtime 侧有用例（`subagentSession.test.ts:147`、`instructionOnDemand.test.ts:247`），但那是投影器一侧，不是会话文件重读一侧。

其二，`piSessionTree.test.ts` 的两条断言里 `forkable` 全是 `false`（夹具的 `message()` 写死 `role: 'user'`）。`forkable` 的正例——assistant 消息自身可分叉、其后代继承可分叉——没有任何断言，而它必须与 `store.createFork` 的 `session_fork_unmaterialized` 准入规则保持一致（见优点 1）。两侧任一改动导致错位，症状是界面给出分叉入口但后端拒绝（或反之）。

**EVIDENCE**

`src/agent-host/piSessionTimeline.ts:258-266`
```ts
    if (message.role === 'user') {
      // A delegation report the runtime fed back to the model is stored as a
      // user message because that is the only shape pi has for it. Live, the
      // projector already keeps it off the timeline; a reopened session has to
      // agree, or the bubble the user never wrote comes back on reload — as the
      // newest thing they appear to have asked for. Legacy sessions never carry
      // the mark, so this is inert for them.
      if (isInternalMessage(message)) continue;
```

`src/agent-host/__tests__/piSessionTree.test.ts:4-12`（夹具只造 user 消息）
```ts
function message(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}
```

`src/agent-host/__tests__/piSessionTree.test.ts:48, 50`（两处断言都是 false）
```ts
      forkable: false,
    });
    expect(snapshot.nodes.find((node) => node.id === 'c')).toMatchObject({ forkable: false });
```

**SCENARIO**
有人重构 `projectPiSessionHistory` 的 user 分支（比如把附件处理提前、或把三个 `continue` 合并），顺手挪掉了 `isInternalMessage` 那一行。全量测试仍然绿（该分支无用例），T005 的 high 级缺陷在「重开会话」这一半悄悄复活。

**FIX**
在 `piSessionTimeline.test.ts` 加两条：一条喂带 `aiclientInternal: 'subagent-report'` 的 user 消息，断言它不出现在投影里；一条喂带 `'project-instructions'` 的，断言同样被挡（两个 origin 分别断言，`internalMessage.ts:36-43` 的注释明确说过「只比一个字面量」正是这条链的历史故障模式）。在 `piSessionTree.test.ts` 加一条：夹具支持 `role`，造 `user → assistant → user` 的链，断言 assistant 自身与其后代 `forkable: true`、assistant 之前的节点 `forkable: false`，并在断言旁注明这条规则必须与 `store.createFork` 的准入条件一致。

---

## 测试缺口

1. `piSessionTimeline`：`isInternalMessage` 跳过（T005 重开半边）零用例；`attachmentMetadata`（图片附件元数据）零用例；`boundedText` 的 4 000 / 2 000 双档截断没有断言（重开会话会把长工具输出截到 4 000 字符，与直播不一致，这条取舍也没有文档）。
2. `piSessionTree`：`forkable: true` 零用例；非 `message` 条目类型（`compaction` / `model_change` / `thinking_level_change` / `session_info` / `label`）的 preview 分支零用例；`type === 'custom'`（含遗留导入溯源条目）在树里既无 preview 也无用例。
3. `piSessionTree` 的环 / 孤儿兜底（`piSessionTree.ts:203-215`）在当前解码规则下不可达，`piSessionTree.test.ts:21` 那条 `orphan` 夹具走的是「parentId 指向不存在的 id → 进 roots」的正常分支，不是兜底分支；兜底分支本身零覆盖。
4. 脱敏：没有任何一条用例断言「会话文件里不含凭据」。`stderrRedaction.test.ts` 覆盖很密，但覆盖的是它自己；`providerErrors` 一侧只有 `providerRetry.test.ts` 的分类用例，没有脱敏断言。
5. 依赖边界：没有任何用例断言 `src/runtime` 对 `src/agent-host` 的 import 集合（见 ah-lib-05）。
6. `userResourcePaths.ts` 无测试文件（它也确实不该有——应当删除）。
7. `historyError` 的码表用例（`historyError.test.ts:237-249`）全部用 `WORKER_SESSION_*` 旧词汇构造输入，等于把已经漂移的映射钉死了；没有一条用 native 实际抛的码。

---

## 未经执行验证的声明

1. ah-lib-01 / ah-lib-02 里「真实 provider 或网关的错误 body 中会出现可用的凭据」——依据是 pi-ai 会把原始 body 折进 `errorMessage`（`error-body.js` 的 `MAX_PROVIDER_ERROR_BODY_CHARS = 4000`，代码事实）加上自建网关常见的请求回显行为（先验，非本仓事实）。代码路径静态可证，凭据是否真的出现在正文里未取证。
2. ah-lib-03 的用户可见表现（卡片标题 / Retry 按钮 / 继续提示）是按 `historyError.ts` 的文案表与 `MessageTimeline` 的消费方式推断的，没有起 Electron 实际看过那张卡。映射落到 `read_failed` 这一步是静态可证的。
3. ah-lib-04 的「模型会把技能装到扫描不到的地方」是行为推断，需要真实模型回合才能确认；「提示词里没有安装目录、扫描根是 `~/.agents/skills`」两件事是静态可证的。
4. 「esbuild 在 `outfile` + 无 `splitting` 时会把字面量动态 import 内联进单一产物」依据的是 esbuild 的通用行为与 `build-agent-host.mjs` 的配置，本轮没有跑打包验证产物里确实只有一个 `worker.js`。
5. `pi --session` 读会话文件时会不会显示 assistant 消息的 `errorMessage` 字段（即 ah-lib-01 的泄漏面是否还包括 CLI 显示），未查证；本报告只声明「字段留在文件里」。
6. ah-lib-05 的绕过场景是构造的（当前四个模块都是纯的），它描述的是守卫覆盖面，不是现存违规。

---

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| provider 错误正文是否落进会话文件 | 一轮真实 401 / 400 之后，会话 JSONL 中该 assistant 条目的 `errorMessage` 字段存在且未脱敏，而同一轮 `runs.jsonl` 的 `llm` 便签已脱敏——两者不一致即证实 ah-lib-01 | 用真实 provider（或一个会回显 Authorization 头的本地网关）跑一轮失败回合，`grep -c 'errorMessage' <session>.jsonl` 并对比 `runs.jsonl` | real-model |
| 裸密钥形状是否被 `redactSensitiveErrorText` 漏过 | 让网关返回 `Incorrect API key provided: sk-proj-<40 位>`，检查 `runs.jsonl` 里该串是否原样保留（保留即证实 ah-lib-02） | 同上一项同一轮，另做一条断言 | real-model |
| 会话文件损坏 / 缺失 / 换工作区三种恢复失败的界面文案 | 分别看到「Session history is damaged（不可重试）」「History not found（此对话无法继续）」「Session belongs to another workspace」，而不是三次都看到「Failed to read history（可以继续发送）」 | 起 Electron，造三个会话：① 中段插 65 行坏 JSON（超过 `MAX_SKIPPED_ROWS` 触发拒绝）② 删掉会话文件但保留索引行 ③ 把工作区路径改掉；逐一恢复并截图卡片 | dev-box |
| Windows 路径脱敏规则对真实 stderr 行生效 | 真实 Windows 上 worker stderr 里出现的 `C:\Users\<含空格用户名>\…` 在 Context 面板里显示为 `~\…`；WSL / UNC 两族同理 | Windows 上故意制造一条含用户目录的 stderr（例如指向不存在的随包 node 路径），看 Context 面板的 Host stderr 分组 | windows |
| utility 载体下 `session.stderr` 的转发与 50 行上限 | 一轮内超过 50 行 stderr 时，面板末尾出现「…more stderr this turn is in the worker log only (forwarding capped at 50 lines)」，且前 50 行均已脱敏 | 以 Electron utility 载体起 worker，让子进程刷 60 行 stderr（含一条带假密钥的行） | utility |
| 加密机上会话文件损坏自愈（T034）后树与历史是否一致 | 中段坏行被跳过并原子重写后，会话树节点数 = 文件里存活条目数，历史时间线不缺条目，`session.status` 带 `recovery` rider | 加密机上对一个真实会话文件中段插一行坏 JSON，重开会话并对比树节点与文件行数 | encrypted |

---

## 读过的文件

**必读清单（区域指定）**
- src/agent-host/piSessionTree.ts
- src/agent-host/stderrRedaction.ts
- src/agent-host/piWorkerErrors.ts
- src/agent-host/userResourcePaths.ts
- src/agent-host/piSessionTimeline.ts
- src/agent-host/piSessionPreflight.ts
- src/agent-host/bundledPlugins.mjs
- src/agent-host/bundledPlugins.d.mts
- src/agent-host/package.json
- src/agent-host/tsconfig.json
- src/agent-host/__tests__/piSessionTree.test.ts
- src/agent-host/__tests__/piSessionTimeline.test.ts
- src/agent-host/__tests__/stderrRedaction.test.ts
- src/agent-host/__tests__/nativeWorkerDependencyBoundary.test.ts
- src/agent-host/__tests__/workerStripOnlyCompat.test.ts
- src/agent-host/__tests__/piCliIsBundledToolOnly.test.ts
- src/runtime/__tests__/hostBoundary.test.ts
- docs/plans/2026-09-08-runtime-evolution-ard.md（D6 / 5.1 / 边界段）

**追踪到的相关文件**
- src/runtime/plugins/session/store.ts
- src/runtime/plugins/session/codec.ts
- src/runtime/plugins/agent-loop/index.ts
- src/runtime/plugins/agent-loop/providerErrors.ts
- src/runtime/plugins/agent-loop/providerRetry.ts
- src/runtime/worker/nativeWorkerRuntime.ts
- src/runtime/host/errors.ts
- src/runtime/host/io.ts
- src/runtime/plugins/skills/prompt.ts
- src/runtime/plugins/skills/index.ts
- src/runtime/plugins/skills/loader.ts
- src/runtime/plugins/prompt/segments.ts
- src/runtime/package.json
- src/runtime/tsconfig.json
- src/runtime/__tests__/flags.test.ts
- src/agent-host/piWorkerRpcServer.ts
- src/agent-host/permissionPolicy.mjs
- src/shared/internalMessage.ts
- src/main/services/auth/redact.ts
- src/main/services/agent-host/WorkerManager.ts
- src/main/services/agent-host/WorkerSlot.ts
- src/renderer/components/chat/historyError.ts
- src/renderer/components/chat/sessionIndex/useResumeSession.ts
- scripts/build-agent-host.mjs
- scripts/agent-host-build-lib.mjs
- src/runtime/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js

**计划与审计文档**
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（CRITIC 全段，重点第 68 / 82 行）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段与批次 D 待派段）
