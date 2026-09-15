# 批次 D 补审原始报告 — 会话导入的上游六模块

- **区域**：import-upstream
- **任务**：T029（批评者缺口 4 — GAP [P5-4] 上游一半）
- **节点判定对象**：P5-4 上游、H/21 对话导入代码侧
- **基线 HEAD**：`ebc82f16`
- **日期**：2026-09-15
- **方式**：只读。未跑构建 / tsc / vitest / 打包 / Electron。唯一一次执行是 `node -e` 跑脱敏正则的纯函数复刻（见 import-up-06 的 EVIDENCE），不触仓库代码。

---

## 总评

上游六模块（两个扫描器、两个适配器、Codex rollout 解析、脱敏）整体是**保守、可审、失败偏向拒绝而不是偏向写坏数据**的一套代码：源文件字节从头到尾没被改过（有用例钉住）、发布前后各做一次指纹比对、体积与条数都有显式上限、越权路径段在落盘前被 `isLegacyImportPathSegment` 挡住。批次 A/B/C 修掉的四条（清单命名 import-catalog-01、reconcile 连坐 -10、旁车清理 -09、路径片段校验 -07）在当前代码里确实已经不在了。

**交给 native 写入器的条目形状，与退役前 pi 版逐字相同**——这是本次审查最重要的一条正面结论。我把 `git show fe246bd6^:src/agent-host/piLegacyImport.ts` 的 `appendConversation`（第 91～153 行）与 `src/runtime/worker/nativeImport.ts:110-184` 逐行比对：provenance / display 两种 custom 条目的字段集、user / assistant / toolResult 三种消息的角色、时间戳兜底（`timestamp()`）、`usageZero()`、`api`/`provider` 写死 `legacy-import`、model 的三级回落（`entry.model || conversation.model || conversation.sourceKind`）、thinking 块映射成 `{type:'thinking', thinking}`、toolCall 块映射成 `{type:'toolCall', id, name, arguments}`——全部一致。唯一的差别是「给会话起名」的方式（pi 用 `appendSessionInfo`，native 用 `store.rename`）和「校验用哪份快照」（pi 读 branch，native 读 `store.snapshot()`），不改条目形状。**所以缺口 4 里「确认 native 写入器接到的条目形状与 pi 版一致」这一问，答案是：一致。**

但这条结论有一个不容易看见的前提问题：**没有任何一个用例把真实的 Claude / Codex 转写结果喂进 native 写入器**。第 10 批（`fe246bd6`）把 `CodexImportIntegration.test.ts` 里「转写 → 写会话文件 → 读回来」的后半段删掉了，理由写在测试的中文注释里（「写入这一半现在归 runtime 侧」）；而 runtime 侧那一半用的是手写固定装置，其中两种条目形状（`kind:'tool_result'` 与 assistant 的 `tool_call` 块）上游**从来不产出**。两边各测一半，接缝上少了一块（import-up-07）。

弱点集中在三类：一是 **Codex 扫描器的容错口径与全仓不一致**——一个子目录读不动就能让整份 Codex 历史从导入列表里静默消失（import-up-01）；二是 **上游产出与下游校验之间有几处没对齐的边界**——64 MiB 源上限 vs 32 MiB 会话预算（import-up-04）、display 标题长度（import-up-05）；三是 **Codex 的「合成注入」判据过宽**，以 `<` 开头的真实用户消息会被整条丢掉（import-up-02）。

我没有发现安全绕过、数据损坏或进程卡死级别的问题，因此本区域无 high 级发现。

## 优点

1. **源只读这件事被当成硬性质来守。** `readCodexSessionSource`（`CodexSessionScanner.ts:31-77`）读之前 stat、读之后再 stat，size / mtimeMs / ctimeMs / mode 任一变化就拒绝；缓冲区只申请 `size + 1` 字节，明确写了注释解释「并发增长的文件不能把有界导入变成无界分配」。Claude 侧 `snapshotSource` / `assertSameSource`（`ClaudeSourceAdapter.ts:181-222`）另外还比 dev / ino，防的是发布前文件被换掉。两边都有对应用例。
2. **失败偏向「整条拒绝」而不是「写一半」。** 超行长、超源体积、超条数、元数据缺失、会话元数据冲突，全部 throw 而不是截断；`parseConversation` 在没有任何 assistant 条目时直接报错，不让用户拿到半份转录。
3. **脱敏与裁剪走同一组集中常量**（`src/shared/types/legacyImport.ts:6-12`），两个适配器都从这里取，没有各写各的魔数。
4. **H/21 C3（未匹配仓库落为临时对话）在代码里是真的、而且是双端接通的。** 渲染层按项目路径算 `matched` 并随请求下发（`ConversationImportSettings.tsx:99-110`），Main 的 `resolveWorkspace`（`LegacyImportService.ts:139-147`）才决定落哪儿，`unbound` 标记只由 Main 写（U05-c）。三条用例分别覆盖「匹配且目录在」「没匹配」「匹配但目录已删」。
5. **H/21 C4（标题不取斜杠命令）有实现也有用例。** `ClaudeSourceAdapter.ts:461-474` 把「剥掉系统标签后还剩正文」的首条用户消息作为标题首选，斜杠命令回显只作次选；`ClaudeSourceAdapter.test.ts:267` 与 `:302` 两条正反用例钉住。扫描器预览那一层（`ClaudeSessionScanner.ts:594-604`）是同一套逻辑的独立实现，也有用例。
6. **Claude 扫描器的降级口径是对的**：projects 目录、单个项目目录、单个文件 stat、单个会话解析，四层各自 try/catch 并打诊断，一处坏不影响其它（`ClaudeSessionScanner.ts:75-102、126-160、504-517`），有「坏 symlink 不拖垮另一个根」的用例。
7. **多文件 / 断裂 / 乱序 / 未知类型在 Codex 解析器里都有明确答案**：两种磁盘形态（新 `session_meta` 包裹式、旧裸行式）都认（`CodexRollout.ts:38-49、93-107`）、`event_msg` 与 `response_item` 的镜像重复被显式跳过并写了原因（`:112-113`）、未知 item 类型进 diagnostics 而不是静默丢（`:184-186`）、加密 reasoning 记一条诊断（`:149`）、诊断条数自身有上限（`:55-57`）。

## 弱点

1. **Codex 扫描器的错误口径与仓库其余部分不一致**：`walk` 里任何非 ENOENT 的目录错误、以及 10 000 个文件的上限，都会把整份 Codex 源打掉，而 T010 已经给全仓定了「EPERM / EISDIR / ELOOP / EACCES 按跳过处理」的集合（`src/runtime/plugins/tools/index.ts:53`、`skills/index.ts:72`）。
2. **Codex 的「合成注入」判据是前缀猜测**，`text.startsWith('<')` 一条就能吃掉正常用户消息；Claude 侧同一件事是按具名标签精确剥离的，两边不对称。
3. **一次导入要把整个 `~/.codex/sessions` 重扫重解析一遍**，批量导入是 N 遍，而且全在 Main 进程上同步 `JSON.parse`。
4. **上游的体积口径没有跟 32 MiB 会话预算对账**，T024 的表 A 也没有「导入的对话条目」这一行。
5. **上游产出的 display 标题没有长度上限，下游校验却硬卡 256 字符**；空工具名同理。越界的后果是整份对话被 `WORKER_INVALID_PAYLOAD` 拒绝，错误文案说不出是哪一条越界。
6. **脱敏施加的位置与风险的位置错开**：被脱敏的恰好是不进模型上下文的 display 行，真正进上下文的 user / assistant 正文一个字符都不过滤。
7. **写入侧的契约有两条死分支**（`ImportedAssistantBlock.tool_call`、`ImportedConversationEntry.tool_result`），上游没有生产者，只有 runtime 的测试固定装置在用——于是那个固定装置本身不代表生产形状。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| **P5-4 上游（导入内容正确性：脱敏 / 裁剪 / rollout 转换 / 扫描容错）** | complete-with-gaps | 主链路成立且与 pi 版形状一致（见总评的逐行比对），四条已修项（import-catalog-01/07/09/10）在当前代码里确认不存在残留。缺口是本报告的 import-up-01（Codex 扫描容错口径不一致，用户可见地丢整份源）、import-up-02（真实用户消息被误判为合成注入而丢弃）、import-up-03（每条导入全量重扫）、import-up-04（64 MiB / 32 MiB 未对账）、import-up-05（标题长度与校验不匹配）、import-up-06（脱敏覆盖面）、import-up-08（reasoning 只读 summary）。没有一条构成安全绕过或数据损坏，因此不判 incomplete。 |
| **H/21 对话导入代码侧（C1～C6）** | complete-with-gaps | C1（列出项目）、C2（列出会话与首句）、C3（未匹配仓库落临时对话）、C4（标题不取斜杠命令）、C6（可续聊）在当前代码里都有实现且有用例：C3 见 `LegacyImportService.ts:139-147` 三条用例、C4 见 `ClaudeSourceAdapter.test.ts:267/302`、C6 见 `src/runtime/__tests__/nativeImport.test.ts:353-393` 的 faux provider 离线回合。**C5（Codex 旧格式）在代码与构造用例上成立**（`CodexRollout.ts:93-107`、`CodexRollout.test.ts:70/103`），但 H/21 证据自己写明「本机 10 个 rollout 全是新格式」，真实旧格式从未被现场验证过，这一条只能算代码侧成立。缺口另有 import-up-02（以 `<` 开头的用户消息被丢，会同时影响 C2 的首句与 C4 的标题）与 import-up-10（H/21 证据里的落盘路径是 pi 时代的，与 native 扁平目录不符，文档未随 P6-5 更新）。 |

---

## 发现

### [import-up-01] medium robustness | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:89 | 一个读不动的子目录（或超过 1 万个文件）会让整份 Codex 历史从导入列表里静默消失

**DESC**
`CodexSessionScanner.scan()` 对**单个文件**的失败做了隔离（`:113-120` 的 try/catch，注释还写明「一个损坏的会话不应遮住合法的兄弟」），但对**目录遍历本身**没有。`walk` 里的 `readdir` 一旦抛非 ENOENT 的错（EACCES / EPERM / ENOTDIR / ELOOP），异常会沿着递归一路穿到 `:123-127` 的外层 try，那里只放行 ENOENT，其余原样重抛。`++inspectedFiles > 10_000` 这条上限（`:94`）走的是同一条路——它不是「只看前一万个」，而是「超过一万个就整个失败」。

这个异常出去之后被 `scanAllLegacySources` 的空 catch 吞掉（`LegacyImportSources.ts:100-102`，注释写的是「一个坏源不应遮住其它源」），于是用户在导入面板里看到的结果是：Claude 项目正常列出，**Codex 一个项目都没有，也没有任何提示**。

口径上这与仓库其余部分不一致：T010（`1262e3b0`）给遍历容错定的错误码集合是 `['ENOENT','ENOTDIR','EACCES','EPERM','EISDIR','ELOOP']` 按跳过处理，`src/runtime/plugins/tools/index.ts:53` 与 `skills/index.ts:72` 都是这一套。Claude 扫描器也已经是「每层各自降级」（`ClaudeSessionScanner.ts:75-102`）。只有 Codex 扫描器是「一处坏全没」。

需要说明的是，「根目录失败要传播出去」是有意设计并有用例的（`CodexSessionScanner.test.ts:90`「treats a missing root as empty but propagates other root failures for source isolation」，配套 `LegacyImportService.test.ts:649`）。本条说的不是根，而是**根之下的子目录**：Codex 的 sessions 目录是按日期分层的（`walk` 允许 depth < 3），坏的是其中一天，代价却是全部。

**EVIDENCE**
```ts
// src/main/services/legacyImport/CodexSessionScanner.ts:88-128
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });   // :89 非 ENOENT 直接向上抛
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(path, depth + 1); // :92 递归也向上抛
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (++inspectedFiles > 10_000) throw new Error('Codex scan exceeds session limit'); // :94
        try {
          const source = await readCodexSessionSource(path);
          ...
        } catch (error) {
          // A corrupt session does not hide valid siblings. Root/directory
          // failures propagate to the per-source scan isolation boundary.
          console.warn('[CodexSessionScanner] Skipped unreadable session', ...);            // :116
        }
      }
    };
    try {
      await walk(this.resolveRoot(), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;                   // :126
    }
```
```ts
// src/main/services/legacyImport/LegacyImportSources.ts:94-103
  for (const importer of importers) {
    try {
      const result = await importer.scan();
      ...
    } catch {
      // A bad source does not hide other sources from the import picker.
    }
  }
```
```ts
// src/runtime/plugins/tools/index.ts:53  —— T010 定下的全仓口径
const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);
```

**SCENARIO**
用户某次用 `sudo codex` 跑过一回，`~/.codex/sessions/2026/09/12/` 这一天的目录归 root、权限 700。之后打开「设置 · 从 Claude Code / Codex 导入历史对话」：`readdir` 那一天抛 EACCES → `walk` 抛 → `scan` 抛 → `scanAllLegacySources` 静默吞掉 → 面板里只剩 Claude 项目，Codex 的全部会话（包括其它几百天完全可读的）一条都不出现，界面上没有任何错误提示。第二个触发路径：会话数超过 10 000 时同样是「一条都没有」，而不是「只列前一万条」。

**FIX**
把 `walk` 的目录级失败按 T010 的 `OPTIONAL_FILE_ERRORS` 集合处理：`readdir` 包 try/catch，命中集合就跳过该目录并 `console.warn` 一条诊断，其余照抛（保留「根目录彻底不可用要传播」的既有语义，可以只对 `depth > 0` 的子目录降级，这样 `CodexSessionScanner.test.ts:90` 那条用例仍然成立）。`inspectedFiles` 上限改为「达到上限就停止继续遍历并返回已收集的结果 + 一条诊断」，而不是 throw。补两条用例：子目录 EACCES 时其它日期的会话仍被列出；文件数超限时返回上限条数而不是空。

---

### [import-up-02] medium correctness | P5-4 上游 / H/21 C2·C4 | src/main/services/legacyImport/CodexRollout.ts:35 | 以 `<` 开头的真实用户消息被当成合成注入整条丢弃，整段会话可能因此从导入列表里消失

**DESC**
`isSyntheticCodexUserText` 用三条前缀判断一条用户消息是不是 Codex 注入的仓库说明 / 环境上下文，其中第一条是 `text.startsWith('<')`。命中就在 `:127` 直接 `continue`——**该条目不进 entries，也不写 diagnostics**，用户在导入后的转录里完全看不到自己说过这句话。

`<` 是个非常容易被真实内容命中的前缀：贴一段 HTML / XML / JSX、贴一段 `<<<<<<< HEAD` 冲突标记、或者问「`<Foo />` 为什么不渲染」，都会以 `<` 开头。Claude 侧同一件事是精确做的——`stripSystemTags`（`ClaudeSourceAdapter.ts:100-109`）按六个具名标签成对剥离，剥完还剩正文就照常保留。两边口径不对称。

影响不止「少一条消息」。`CodexSessionScanner.scan()` 用「至少有一条 user 条目 且 至少有一条 assistant 条目」作为「这个会话值得列出来」的门槛（`:97-101`）；`CodexSourceAdapter.read` 又用第一条 user 条目的前 120 字做标题（`CodexSourceAdapter.ts:32`）。所以：首条用户消息以 `<` 开头 → 标题变成后面某一句；**所有**用户消息都以 `<` 开头 → 整个会话在导入面板里根本不出现。

**EVIDENCE**
```ts
// src/main/services/legacyImport/CodexRollout.ts:33-36
/** Injected repo instructions / environment context, not something the user typed. */
function isSyntheticCodexUserText(text: string): boolean {
  return text.startsWith('<') || text.startsWith('# AGENTS.md') || text.startsWith('You are Codex');
}
```
```ts
// src/main/services/legacyImport/CodexRollout.ts:121-131
    if (type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text = readCodexTextContent(payload.content, '\n');
      if (payload.role === 'user' && isSyntheticCodexUserText(text)) continue;   // :127 无诊断，直接丢
      if (!text) {
        diagnose(`Message at line ${index + 1} has no supported text; attachments omitted`);
        continue;
      }
```
```ts
// src/main/services/legacyImport/CodexSessionScanner.ts:97-101 —— 没有 user 条目就不列出来
          const user = source.rollout.entries.find((item) => item.kind === 'user');
          if (
            user?.kind === 'user' &&
            source.rollout.entries.some((item) => item.kind === 'assistant')
          ) {
```

**SCENARIO**
用户在 Codex 里贴了一段组件代码求助，消息正文是 `<Dialog open={open}>…`，然后接着聊了十几轮，中间每次贴代码也都以 `<` 开头。导入这条会话时：所有这些用户消息被静默丢弃，转录里只剩 Codex 的回复，看起来像是模型在自言自语；如果这条会话的用户消息全部以 `<` 开头，`scan()` 的门槛直接把它判为「没有用户消息」，它在导入面板里压根不出现，用户无从得知为什么少了一条会话。

**FIX**
把这条判据收窄成「整条消息是一个闭合的注入标签块」而不是「以 `<` 开头」：参照 Codex 实际注入的标签名（例如 `<environment_context>` / `<user_instructions>` 之类，需按仓库里已有的 fixture `src/agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl` 核定真实标签）做具名匹配，或者复用 Claude 侧 `stripSystemTags` 的「剥掉已知标签后还剩正文就保留」策略。无论采用哪种，被丢掉的条目都应该写一条 diagnostics，让用户在导入结果里看得见。补两条用例：以 `<div>` 开头的真实用户消息必须被保留；只含注入块的消息仍被丢弃并计入诊断。

---

### [import-up-03] medium perf | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:132 | 导入一条 Codex 会话要把整个 `~/.codex/sessions` 重扫重解析一遍，批量导入 N 条就是 N 遍

**DESC**
`CodexSessionScanner.resolveSessionSource` 的第一行是 `await this.scan()`——而 `scan()` 不是「列目录拿元数据」，它对**每一个** `.jsonl` 都调 `readCodexSessionSource`：申请 `size + 1` 字节的缓冲区整份读进内存、两次 stat、算两个 sha256、然后 `parseCodexRollout` 把每一行都 `JSON.parse` 并转成完整的 `ImportedConversationEntry[]`（`:31-77`、`:95-96`）。拿到全量结果之后只用来做一次 `filter`，再对选中的那个文件**再读一遍**（`:136`）。

调用方把这条重活儿排成了乘法：
- `listProjects()` → `scanAllLegacySources` → 一次全量 scan；
- `listSessions(projectId, 'codex')` → `codexSourceImporter.scan(projectId)` → 又一次全量 scan（`LegacyImportSources.ts:53`）；
- `importBatch` 里**每一条** source 都走 `importOne` → `convert` → `adapter.read` → `resolveSessionSource` → **又一次全量 scan**（`LegacyImportService.ts:209-211` 是串行 for 循环）。

`LEGACY_IMPORT_MAX_BATCH` 是 100，单文件上限 64 MiB，文件数上限 10 000。这些都发生在 Main 进程里，`JSON.parse` 是同步的，因此这是实打实的主进程占用。

这一条我只做了静态推断，没有实测耗时（开发机 2 核 / 3.3 GB，且规则禁止跑构建与应用）。

**EVIDENCE**
```ts
// src/main/services/legacyImport/CodexSessionScanner.ts:131-140
  async resolveSessionSource(projectId: string, sessionId: string): Promise<CodexSessionSource> {
    const matches = (await this.scan()).filter(                      // :132 全量重扫
      (item) => item.projectId === projectId && item.sessionId === sessionId
    );
    if (matches.length !== 1) throw new Error('Codex session is missing or ambiguous');
    const source = await readCodexSessionSource(matches[0].filePath); // :136 再读一遍选中的那个
```
```ts
// src/main/services/legacyImport/CodexSessionScanner.ts:95-96 —— scan 对每个文件都做完整解析
          const source = await readCodexSessionSource(path);
          const user = source.rollout.entries.find((item) => item.kind === 'user');
```
```ts
// src/main/services/legacyImport/LegacyImportService.ts:208-211 —— 串行，每条各自重扫
    const results: LegacyImportItemResult[] = [];
    for (const source of unique.values()) {
      results.push(await this.importOne(source));
    }
```

**SCENARIO**
一个用了半年 Codex 的用户，`~/.codex/sessions` 下有 300 份 rollout，合计几百 MB。他在导入面板里勾选 40 条一起导入：面板打开时扫 1 遍（300 份全解析），进项目时扫第 2 遍，点「导入」后每条各扫 1 遍 → 共 42 遍 × 300 份 = 12 600 次「整份读入 + 两次 sha256 + 逐行 JSON.parse」，全部在 Main 进程同步解析。用户看到的是界面长时间无响应，且没有进度反馈。

**FIX**
让 `scan()` 与 `resolveSessionSource` 分层：扫描只收集「文件路径 + stat + 头部若干行足够拿到 session_meta / 首条用户消息」的轻量摘要，不做全量 `parseCodexRollout`、不算 contentHash；`resolveSessionSource` 直接按 `projectId/sessionId` 定位到文件后再做一次完整解析。另外在一次 `importBatch` 内复用同一份扫描结果（把扫描结果作为参数传进 `convert`，或在 scanner 上加一个以「批次」为生命周期的缓存）。注意保留现有的安全性质：路径必须来自扫描结果而不是客户端拼接，`source.projectId/sessionId` 与重读结果的一致性校验（`:137-138`）不能去掉。

---

### [import-up-04] medium contract-gap | P5-4 上游 | src/shared/types/legacyImport.ts:6 | 上游的 64 MiB / 4000 条 / 64 KiB 口径从未与 32 MiB 会话预算对账，越界的后果是走完整条链路后在最后一步失败

**DESC**
导入侧的体积闸门全部设在上游：源文件 ≤ 64 MiB（`LEGACY_IMPORT_MAX_SOURCE_BYTES`）、条目 ≤ 4000（`LEGACY_IMPORT_MAX_ENTRIES`）、单条正文 ≤ 64 KiB（`LEGACY_IMPORT_MAX_TEXT_CHARS`）、工具输入输出 ≤ 16 KiB（`LEGACY_IMPORT_MAX_TOOL_CHARS`）。而**真正写盘的那一侧**用的是另一个预算：`SESSION_MAX_BYTES = 32 MiB`（`src/runtime/plugins/session/codec.ts:20`，T015 集中的那个常量），执行点在 `store.appendEntry` 的「已有字节 + 本行字节 > maxBytes 就抛 `session_size_limit`」（`store.ts:288-295`）。

两组数字之间没有任何换算关系：
- 源上限 64 MiB 正好是会话预算的 **2 倍**；
- 校验器允许的最坏情况远不止 2 倍——4000 条 user 条目 × 64 KiB = 256 MiB；单条 assistant 允许 256 个块（`legacyImport.ts:248`）× 64 KiB = 16 MiB/条，4000 条就是 64 GiB。

后果不是写坏文件（`store` 是拒绝不是截断，`NativeLegacyImportWriter.create` 的 catch 会 unlink 暂存文件），而是**代价与错误形态都不对**：一次超预算的导入要先完整读盘、算两个 sha256、fork 一个 worker 进程、把整份对话经 RPC 送过去、写到一半才失败，错误正文是面向实现的 `session exceeds the configured size budget`，用户看不出「哪条会话太大了、上限是多少」。

T024（`8564ba41`）的容量对账表我查过了：表 A「写进会话文件的来源」列了 write 参数、toolResult、MCP 文本 / 图片、子代理转录、compaction 摘要等，**没有「导入的对话条目」这一行**；表里出现的唯一 import 字样是 `session/legacy.ts:550-551`，那是 pi v3 → v4 的会话格式转换，不是对话导入。所以这条链路是对账时被漏掉的。

本条是静态推断（按常量与执行点推出），未执行验证。

**EVIDENCE**
```ts
// src/shared/types/legacyImport.ts:6-10
export const LEGACY_IMPORT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const LEGACY_IMPORT_MAX_ENTRIES = 4_000;
export const LEGACY_IMPORT_MAX_TEXT_CHARS = 64 * 1024;
export const LEGACY_IMPORT_MAX_TOOL_CHARS = 16 * 1024;
```
```ts
// src/runtime/plugins/session/codec.ts:20
export const SESSION_MAX_BYTES = 32 * 1024 * 1024;
```
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
```ts
// src/shared/types/legacyImport.ts:246-251 —— 校验器允许单条 assistant 带 256 个块
    case 'assistant':
      return (
        Array.isArray(value.blocks) &&
        value.blocks.length <= 256 &&
        value.blocks.every(isImportedAssistantBlock) &&
```
对账表缺行：`docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md` 第 43 行是全表唯一命中 "import" 的一行，内容是 `| legacy 导入转换后落盘 | session/legacy.ts:550-551 |`（v3→v4 转换），表 A 无导入条目行。

**SCENARIO**
一个在同一个仓库里做了几个月的 Claude Code 会话，JSONL 约 40 MiB（低于 64 MiB 源上限），其中大部分是 assistant 的长回复与用户贴的长文本（工具输出会被裁到 16 KiB，但正文不会）。用户在导入面板里选中它并点导入：上游全部闸门放行 → 完整读盘并算两遍 sha256 → fork 导入 worker → 经 RPC 送整份对话 → 写到第 32 MiB 时 `store.appendEntry` 抛 `session_size_limit` → 暂存文件被 unlink、manifest 记一条 failed → 面板显示「失败 1 个」，错误文本是 `session exceeds the configured size budget`。用户既不知道是体积问题，也不知道界限在哪，重试同样会失败。

**FIX**
在 `ImportedConversation` 组装完成后、送进 worker 之前，在 Main 侧加一道预算预检：按 `JSON.stringify` 估算落盘字节，与 `SESSION_MAX_BYTES` 比较，超出就以一条面向用户的错误直接拒绝（说明「这条会话约 X MB，超过单会话 32 MB 上限」），不要 fork worker。同时把 `LEGACY_IMPORT_MAX_SOURCE_BYTES` 与 `SESSION_MAX_BYTES` 的关系写进常量注释，并把「导入的对话条目」补进 T024 的容量对账表表 A。

---

### [import-up-05] medium contract-gap | P5-4 上游 | src/main/services/legacyImport/ClaudeSourceAdapter.ts:502 | display 条目的 title 在生产侧无上限、在 Codex 侧可为空串，而 worker 校验硬卡「非空且 ≤ 256」，越界即整份对话被拒

**DESC**
worker 侧的 `isWorkerImportConversationPayload` 是导入 RPC 的准入校验（`src/agent-host/piWorkerRpcServer.ts:450`），它对 display 条目的 `title` 有两条硬要求：非空、且长度 ≤ 256（`src/shared/types/legacyImport.ts:262-264`）。上游两个适配器在构造 title 时都没有对应的保证：

- `ClaudeSourceAdapter.ts:502`：`Unsupported Claude entry: ${raw.type}` —— `raw.type` 是直接从 JSONL 里读出来的任意字符串，**完全没有截断**，上界是单行 2 MiB（`LEGACY_IMPORT_MAX_LINE_CHARS`）。
- `ClaudeSourceAdapter.ts:419`：`Unsupported Claude assistant block: ${item.type}` —— 同样未截断。
- `ClaudeSourceAdapter.ts:404` / `:447`：`Legacy tool call: ${name.slice(0,256)}` / `Legacy tool result: ${name.slice(0,256)}` —— 截的是工具名不是标题，前缀分别是 18 / 20 字符，所以标题上界是 274 / 276，**结构性地超过 256**。
- `ClaudeSourceAdapter.ts:487`：`title: attachment.name ?? attachment.mediaType` —— 两者都来自文件（`source.media_type.trim()` / `path.basename(item.title)`），均未截断。
- `CodexRollout.ts:151、166、174`：`name` 取 `payload.name.slice(0,256)`，长度没问题，但 `payload.name` 为**空串**时 `typeof === 'string'` 成立，`name` 就是 `''`，title 变空串，`nonEmptyString` 不过；空名还会经 `calls` 表传染给对应的 output 条目。

校验不过的后果不是「丢一条」，而是 `isImportedConversation` 整体返回 false，worker 回 `WORKER_INVALID_PAYLOAD` / `worker.import requires a valid versioned ImportedConversation`——**整份对话导不进来**，而且错误文案指不出是哪一条越界。这一段路径上，Main 侧在送出前不做同一套校验，所以问题只在跨进程之后才暴露。

**EVIDENCE**
```ts
// src/shared/types/legacyImport.ts:260-273 —— 校验侧
    case 'display':
      return (
        ['tool', 'custom', 'diagnostic', 'attachment'].includes(String(value.displayKind)) &&
        nonEmptyString(value.title) &&
        value.title.length <= 256 &&
```
```ts
// src/main/services/legacyImport/ClaudeSourceAdapter.ts:496-507 —— 生产侧，raw.type 未截断
    if (raw.type) {
      pushBounded(
        entries,
        buildDisplay({
          ...provenance,
          displayKind: 'diagnostic',
          title: `Unsupported Claude entry: ${raw.type}`,
          body: 'Raw legacy entry payload omitted.',
          redacted: true,
        })
      );
    }
```
```ts
// src/main/services/legacyImport/ClaudeSourceAdapter.ts:404 —— 18 + 256 = 274 > 256
              title: `Legacy tool call: ${item.name.slice(0, 256)}`,
```
```ts
// src/main/services/legacyImport/CodexRollout.ts:151 —— 空工具名产生空标题
      const name = typeof payload.name === 'string' ? payload.name.slice(0, 256) : 'Codex tool';
```
```ts
// src/agent-host/piWorkerRpcServer.ts:449-456 —— 越界的后果是整份拒绝
  private async handleImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerImportConversationPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import requires a valid versioned ImportedConversation',
        retryable: false,
      });
```

**SCENARIO**
两条：(1) 用户的 Claude 会话里有一条 `type` 取值异常的行——例如某次崩溃写坏、或某个未来版本写入的长类型名——`raw.type` 长度超过 238 字符，于是生成的 display 标题超过 256，worker 直接拒收整份对话，用户看到「失败 1 个」，错误文本是 `worker.import requires a valid versioned ImportedConversation`，无从判断原因，重试必然同样失败。(2) 一份 Codex rollout 里的 `function_call` 记录了 `"name": ""`（工具名缺失），该条与其 output 条目的标题都成为空串，同样让整份对话被拒。

**FIX**
在 `buildDisplay` / Codex 的 display 构造处统一收口标题：写一个 `displayTitle(text: string, fallback: string)`，做 `trim` → 空则取 fallback → `slice(0, 256)`，让所有 title 都经过它（Claude 五处、Codex 三处）。同时在 Main 侧送进 worker 之前跑一次 `isImportedConversation`，不过就以「第 N 条条目不合法」的可读错误在本地失败，不要把它留到跨进程之后。补用例：超长 `raw.type`、空 `function_call.name` 两种输入都要能正常导入（标题被截断 / 回落），而不是整份被拒。

---

### [import-up-06] low security | P5-4 上游 | src/main/services/legacyImport/legacyImportSanitization.ts:8 | 脱敏只作用在不进模型上下文的 display 行；进上下文的正文一个字符都不过滤，且正则认不出 JSON 形态的密钥

**DESC**
两件事叠在一起，都与「脱敏」这个模块名给人的印象不符。

**其一，施加的位置与风险的位置错开。** `boundedSanitizedValue` 与 `sanitizedToolOutput` 在两个适配器里只被用在工具输入 / 工具输出上（`ClaudeSourceAdapter.ts:407、451`；`CodexRollout.ts:169、181`），而这些一律落成 `kind: 'display'` 的 custom 条目——按 `nativeImport.ts` 的设计，这类条目**不会进入模型上下文**（`assertUsable` 专门守这条性质）。反过来，真正会成为模型上下文的 user 正文（`ClaudeSourceAdapter.ts:466`、`CodexRollout.ts:136`）和 assistant 的 text / thinking 块（`ClaudeSourceAdapter.ts:376-389`、`CodexRollout.ts:137、146`），只过 `boundedText` 做长度截断，**不过任何脱敏**。也就是说：会被喂回模型的那一半没脱敏，不会被喂回模型的那一半脱了敏。

需要公允地说：这不是新增泄漏面——那些文本本来就在用户自己机器上的 Claude / Codex 日志里，续聊时把它们送回模型，也正是原产品当时做过的事。所以我判 low 而不是 medium。但「脱敏」这个命名与代码注释会让后来人以为导入内容整体过了一道过滤，实际没有。

**其二，`SECRET_TEXT` 认不出 JSON 形态。** 正则的赋值分支是 `(?:api[_-]?key|token|password)\s*[:=]\s*`，键名之后必须紧跟空白或 `:`/`=`；而 JSON 里键名后面是引号，所以 `"api_key": "…"` 完全不匹配。我用等价的纯函数复刻跑了一遍（未触仓库代码）：

**EVIDENCE**
```ts
// src/main/services/legacyImport/legacyImportSanitization.ts:8-23
const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_TEXT =
  /(bearer\s+)[^\s]+|(sk-[A-Za-z0-9_-]{8,})|((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi;
const BASE64_LIKE = /^[A-Za-z0-9+/=_-]{512,}$/;
```
`node -e` 复刻 `SECRET_TEXT` 的替换结果（2026-09-15 本机执行）：
```
"{\"api_key\": \"AKIAIOSFODNN7EXAMPLE\"}"          => 原样，未脱敏
"{\"token\":\"ghp_0123456789abcdefghij\"}"           => 原样，未脱敏
"export GITHUB_TOKEN=ghp_0123456789abcdefghij"       => "export GITHUB_TOKEN=[redacted]"   ← 同一个值，等号形态就认
"Authorization: Bearer abc.def.ghi"                  => "Authorization: Bearer [redacted]"
"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG"        => 原样（键名 secret 只在对象键那条规则里生效，纯文本不认）
"xoxb-<redacted-example>"                  => 原样
"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg"       => 原样（JWT）
"/home/zhangsan/.ssh/id_rsa"                         => 原样（绝对路径 / 用户名）
"zhangsan@example.com"                               => 原样（邮箱）
```
```ts
// src/main/services/legacyImport/ClaudeSourceAdapter.ts:376-380 —— 进上下文的正文，只截长度不脱敏
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          ensureAssistant().blocks.push({
            type: 'text',
            ...boundedText(item.text.trim(), LEGACY_IMPORT_MAX_TEXT_CHARS),
          });
```

**SCENARIO**
用户在 Claude Code 里让模型 `cat ~/.config/app/credentials.json`，工具输出是 `{"api_key": "AKIA…"}`。导入这条会话：工具输出走 `sanitizedToolOutput`，但 JSON 形态不被 `SECRET_TEXT` 命中，明文原样写进会话文件的 display 行（这一行至少不进模型上下文）。同一段密钥如果是用户自己在提问里贴出来的（「我的 key 是 AKIA…，为什么报 403」），它落在 user 正文里，**既不脱敏、又会在续聊时作为上下文发给模型**。绝对路径与邮箱两类同理，任何形态都不被处理。

**FIX**
两件事分开做。(1) 明确并写下脱敏的口径：如果目标是「不把密钥喂回模型」，就应当把 `sanitizeString` 也施加到 user / assistant 的正文上（注意 thinking 与 text 都要），或者在文档里写明「导入保持原文，脱敏只针对 display 行的第三方载荷」，让命名与实际一致。(2) 补 JSON 形态：把赋值分支扩成 `(?:"?(?:api[_-]?key|token|password|secret)"?\s*[:=]\s*"?)`，并按需要补 `ghp_` / `github_pat_` / `xox[baprs]-` / `AKIA[0-9A-Z]{16}` / JWT 四类常见前缀。用例用上面那张表逐行钉。

---

### [import-up-07] low test-gap | P5-4 上游 | src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts:16 | 退役后没有任何用例把真实转写结果喂给 native 写入器，而写入器自己的固定装置用的是上游从不产出的两种形状

**DESC**
`fe246bd6`（第 10 批 P6-5）把 `CodexImportIntegration.test.ts` 的后半段删掉了：改之前它把 `CodexSourceAdapter` 的转写结果交给 `PiLegacyImportWriter` 写成真会话文件、再用 pi 的 `SessionManager.open` 读回来，断言 `fixture_tool` 与 `encrypted_content` **在盘上有、在模型上下文里没有**。改之后只剩「转写结果自身长什么样」，写入那一半的注释说交给 `src/runtime/__tests__/nativeImport.test.ts`。

问题是那边的固定装置不是从上游来的。`nativeImport.test.ts:51-79` 的 `entries` 里有两种形状，上游**没有任何生产者**：
- `kind: 'tool_result'`：全仓非测试代码零处产出（唯一命中是类型定义 `legacyImport.ts:95` 与这个固定装置）；
- assistant 的 `{ type: 'tool_call' }` 块：`legacyImport.ts:76` 定义，上游两个适配器都不产（Claude 把 `tool_use` 落成 display，Codex 把 `function_call` 落成 display）。

于是接缝两边测的是两套形状：Main 侧证明「转写结果是 display 为主的形状」，runtime 侧证明「toolCall / toolResult 这类进上下文的形状能写能读」。真实导入产生的形状（大量 display custom 条目 + 少量 user/assistant 消息）在写入侧只被 `conversation()` 里那一条 attachment display 覆盖到。批评者缺口 4 点名要确认的那件事（「native 写入器接到的条目形状与 pi 版一致」），当前**没有任何自动化用例守着**——我是靠 `git show` 逐行比对确认的（见总评），下一次有人改上游或改写入器，不会有测试发现漂移。

顺带记一处：`CodexImportIntegration.test.ts:59` 的 `expect(spoken).not.toContain('encrypted_content')` 断言的是「转写结果的 user/assistant 条目里没有这个字符串」。这比原来的「模型上下文里没有」弱一档——原断言证的是写入 + 读回之后的性质，现在证的是转写阶段的性质。

**EVIDENCE**
```ts
// src/runtime/__tests__/nativeImport.test.ts:56-70 —— 上游从不产出的两种形状
        blocks: [
          { type: 'thinking', text: '先看事件绑定' },
          { type: 'text', text: '按钮的 onClick 被覆盖了' },
          { type: 'tool_call', toolCallId: 'call-1', name: 'read', input: { path: 'a.ts' } },
        ],
        ...
      {
        kind: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: 'export const a = 1;',
```
```
$ grep -rn "kind: 'tool_result'" src/ --include=*.ts
src/runtime/__tests__/nativeImport.test.ts:64:        kind: 'tool_result',
src/shared/types/legacyImport.ts:95:      kind: 'tool_result';
```
```ts
// src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts:16-22 —— 交接说明
 * P6-5 之前这个用例还把转写结果交给 `PiLegacyImportWriter` 写成会话文件再读回来。
 * 那个写入方随旧引擎一起删了，而**写入这一半现在归 runtime 侧**：
 * `src/runtime/__tests__/nativeImport.test.ts` 验的是同一件事（发布、重开、两种
 * custom 条目、display 行不进模型上下文），...
```

**SCENARIO**
有人以后调整 `ClaudeSourceAdapter` 的 display 条目字段（例如把 `toolName` 改名、或让工具调用改走 assistant 的 `tool_call` 块以便在时间线上配对），Main 侧用例只断言「有 user、有 assistant、包含 fixture_tool」，runtime 侧用例用的是自己手写的固定装置——两边都绿，而真实导入产出的转录在渲染层少了工具行或多了不该进上下文的行，直到有人真的导一条会话才发现。

**FIX**
把 `CodexImportIntegration.test.ts` 的端到端补回来，但接到 native 写入器上：用真实 fixture → `CodexSourceAdapter.read` → `NativeLegacyImportWriter.create` → `JsonlSessionStore.open(mode:'resume')`，断言三件事——盘上有 `fixture_tool`、`store.snapshot().messages` 里没有、custom 条目的两种 `customType` 齐全。若不愿让 Main 侧测试依赖 runtime 子包，退一步的做法是在 runtime 侧新增一条用例，其 `ImportedConversation` 由 Main 侧适配器的真实输出固化成 JSON fixture（生成脚本可留在 Main 侧），这样至少形状是真的。另外把 `tool_result` / `tool_call` 两条无生产者的契约分支明确标注为「为将来保留」或直接删掉，避免固定装置继续按它们写。

---

### [import-up-08] low correctness | P5-4 上游 | src/main/services/legacyImport/CodexRollout.ts:140 | Codex 的思考块只读 `summary` 不读 `content`，与同仓的 `codexItemMapper` 口径不一致，丢了也不记诊断

**DESC**
`parseCodexRollout` 处理 `reasoning` 条目时只读 `payload.summary`；同一个仓库里读 Codex 的另一处实现 `codexItemMapper.extractReasoningText` 读的是 `summary` **和** `content` 两个数组，并且专门写了注释说明为什么两个都要防御性地读。两处对同一种磁盘记录给出不同答案。

丢失是静默的：`:143` 的 `if (text)` 只有非空才 push，`summary` 为空而 `content` 有内容时既不产生 thinking 块、也不写 diagnostics（对比 `:149` 的加密 reasoning 是记诊断的）。

**EVIDENCE**
```ts
// src/main/services/legacyImport/CodexRollout.ts:139-149
    } else if (type === 'reasoning') {
      const text = readCodexTextContent(payload.summary, '\n');     // 只读 summary
      if (text.length > LEGACY_IMPORT_MAX_TEXT_CHARS)
        throw new Error('Codex reasoning exceeds import text limit');
      if (text)                                                      // 空则静默跳过
        result.entries.push({ kind: 'assistant', blocks: [{ type: 'thinking', text }], ...provenance });
      if (payload.encrypted_content) diagnose(`Encrypted reasoning omitted at line ${index + 1}`);
```
```ts
// src/agent-host/codexItemMapper.ts:281-296 —— 同仓另一处口径
/**
 * Reasoning text: `summary[]` first, then `content[]`.
 * ... `content` was empty in all of them, so it is read the same defensive way
 * rather than assumed to have a shape.
 */
function extractReasoningText(item: Record<string, unknown>): string {
  const chunks: string[] = [];
  const summary = readCodexTextContent(item.summary);
  if (summary) chunks.push(summary);
  const content = readCodexTextContent(item.content);
  if (content) chunks.push(content);
  return chunks.join('\n\n');
}
```

**SCENARIO**
某个版本的 Codex（或某种配置下）把推理正文写在 `reasoning.content` 而不是 `reasoning.summary` 里——这正是 `codexItemMapper` 的注释所防的那种情况。导入这类 rollout 时，思考块全部丢失，转录里只剩消息与工具行，diagnostics 里也没有任何线索说明少了东西。

**FIX**
让 `CodexRollout` 复用 `codexItemMapper` 已有的 `extractReasoningText`（它已经导出了 `readCodexTextContent`，把 `extractReasoningText` 一并导出即可），保持一处口径；并在 `summary`/`content` 都为空但条目存在时写一条 diagnostics。补一条用例：只有 `content` 的 reasoning 条目要产出 thinking 块。

---

### [import-up-09] low correctness | H/21 对话导入代码侧 | src/main/services/legacyImport/ClaudeSourceAdapter.ts:83 | Claude 的 `summary`（压缩 / 续接锚点）行被当控制行静默丢弃，导入的续接会话丢掉「之前发生了什么」

**DESC**
审查轴点名要看「压缩锚点」。当前实现里，Claude JSONL 的 `type: 'summary'` 行被列进 `CONTROL_LINE_TYPES`，在 `:343` 与 `isMeta` / `system` 一起 `continue` 掉——**不进 entries，也不进 diagnostics**。Claude Code 在 `/compact` 之后或续接一段被压缩的历史时，会把「之前那段对话的摘要」写成这种行；把它丢掉意味着导入后的转录从压缩点之后的第一条用户消息开始，读的人（和续聊时的模型）都拿不到前情。

native 会话格式本身是有压缩条目的（`store.appendCompaction`，T024 对账表里也列了 compaction 的 `summary` 与 `retainedTail`），所以这不是「写不进去」，而是上游在转写阶段就丢了。

这条与后端切换无关：退役前的 pi 版写入器逐字相同，丢弃发生在适配器里，不是写入器里。所以它是既有行为而非 P6-5 引入的回归，我按 low 记。

**EVIDENCE**
```ts
// src/main/services/legacyImport/ClaudeSourceAdapter.ts:74-84
const CONTROL_LINE_TYPES = new Set([
  'mode',
  'permission-mode',
  'last-prompt',
  'file-history-snapshot',
  'queue-operation',
  'ai-title',
  'file-history-delta',
  'attribution-snapshot',
  'summary',            // ← 压缩 / 续接摘要与纯控制行同等对待
]);
```
```ts
// src/main/services/legacyImport/ClaudeSourceAdapter.ts:343-345
    if (raw.isMeta === true || raw.type === 'system' || CONTROL_LINE_TYPES.has(raw.type ?? '')) {
      continue;
    }
```

**SCENARIO**
用户在一个长会话里执行过 `/compact`，随后又聊了二十轮。导入这条会话：摘要行被丢，转录直接从压缩后的第一条用户消息开始；用户在侧栏打开它，看到的对话以一句没有上文的追问开头；续聊时模型也拿不到压缩前那段历史的任何信息，而它在原产品里是拿得到的。

**FIX**
把 `summary` 从 `CONTROL_LINE_TYPES` 里摘出来单独处理：至少落成一条 `displayKind: 'custom'` 的 display 条目（标题「压缩前的对话摘要」，正文取摘要文本并按 `LEGACY_IMPORT_MAX_TEXT_CHARS` 截断），让用户在转录里看得见；更进一步可以在 native 写入器里落成真正的 compaction 条目，使它同时进入模型上下文。无论选哪种，都补一条 diagnostics。需要先确认当前 Claude Code 写 summary 行的确切字段名（现有 `ClaudeJsonlEntry` 类型里没有 `summary` 字段），建议用仓库已有的 Claude fixture 核定后再改。

---

### [import-up-10] low docs | H/21 对话导入代码侧 | docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md:0 | H/21 C1～C6 的现场证据记录的是 pi 时代的落盘路径，与 native 的扁平 sessions 目录不符，未随 P6-5 更新

**DESC**
H/21 的真机闭环记录（2026-09-11）第 4 条写的是「文件落在统一 sessions 目录 ✅ `…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl`」——按工作区分子目录、文件名是 `<时间戳>_<id>.jsonl`。这是 pi 写入器的布局。当前 native 写入器写的是 `<agentDir>/sessions/<targetPiSessionId>.jsonl`（`src/runtime/worker/nativeImport.ts:255-265`），扁平、无时间戳前缀；这与 native 普通会话的布局一致（`src/runtime/worker/nativeWorkerRuntime.ts:902`），所以代码本身是自洽的，不是缺陷。

问题在证据：任何按这份 H/21 记录去复验「文件落在哪儿」的人，都会在一个不存在的路径下找文件；同一段里「与 GUI/TUI 共用目录，验证案例 6」这句话所依据的目录结构也已经变了。同页「离线探针」小节还写着「`piLegacyImport` 有一条专门的上下文泄漏检查」，该模块已在 `fe246bd6` 删除。

这属于审计 README 第八节点名的那类「判定与验证结果未回写」，只是落在 H/21 的证据页而不是节点判定里。

**EVIDENCE**
`docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md`「真机闭环」表第 4 行：
```
| 4 | 文件落在统一 sessions 目录 | ✅ `…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl`（与 GUI/TUI 共用目录，验证案例 6） |
```
同页「离线探针」小节：
```
| 工具调用 | 作为只读 `display` 条目保留，不进模型上下文（`piLegacyImport` 有一条专门的上下文泄漏检查） |
```
```ts
// src/runtime/worker/nativeImport.ts:255-265 —— 当前布局
  private fileFor(dir: string, targetPiSessionId: string): string {
    return join(dir, `${targetPiSessionId}.jsonl`);
  }
  private get sessionsDir(): string {
    return join(this.agentDir, SESSIONS_DIR);
  }
```

**SCENARIO**
批次 E 上机复验 H/21 时，执行人按这份记录去 `…/pi-agent/sessions/--home-ai-code-ai-client--/` 下找导入产物，找不到，于是把一次正常的导入判成失败；或者反过来，看到扁平目录下的 `import-codex-….jsonl` 与记录不符，误以为出了回归。

**FIX**
在该页加一条时点注记（与 T027 对其它证据页的做法一致）：说明 2026-09-11 的路径是 pi 写入器的布局，`fe246bd6`（P6-5）之后导入产物落在 `<agentDir>/sessions/<targetPiSessionId>.jsonl`，与 native 普通会话同一布局；同时把「`piLegacyImport` 有一条专门的上下文泄漏检查」改写为 `nativeImport.ts` 的 `assertUsable`。不要改结论本身（C1～C6 的验收仍然成立）。

---

## 测试缺口

1. **没有「真实转写结果 → native 写入器 → 读回来」的端到端用例**（见 import-up-07）。这是缺口 4 点名要确认的那件事，目前只有人工 `git show` 比对，没有自动化守护。
2. **`CodexSessionScanner` 的目录级容错没有用例**：现有 `CodexSessionScanner.test.ts:90` 只覆盖「根目录缺失 → 空」与「根目录其它错误 → 传播」，没有「子目录 EACCES」这一档；`inspectedFiles > 10_000` 这条上限一条用例都没有。
3. **`isSyntheticCodexUserText` 没有反向用例**：只证明了合成注入被丢（`CodexRollout.test.ts` 的 fixture 路径），没有「以 `<` 开头的真实用户消息必须保留」这一条。
4. **上游产出与 `isImportedConversation` 之间没有契约用例**：没有任何测试把适配器的输出直接喂给 `isWorkerImportConversationPayload`，所以 import-up-05 那类越界不会被现有测试捕获。
5. **32 MiB 预算在导入路径上没有用例**：既没有「超预算导入被干净拒绝」的用例，也没有「预算内最大导入能成功」的边界用例。
6. **脱敏只有一条「工具输入走了脱敏」的用例**（`CodexRollout.test.ts:52`），没有按密钥形态逐条钉的表格式用例，也没有任何用例断言 user / assistant 正文是否脱敏（即当前行为未被固定，改哪边都不会有测试反对）。
7. **Codex reasoning 的 `content` 分支无用例**（import-up-08）。
8. **Claude `summary` 行的处理无用例**（import-up-09）：它被丢弃这件事既没有被断言，也没有被记录。
9. **非 UTF-8 源没有用例**：`CodexSessionScanner` 用 `content.toString('utf8')`、`ClaudeSourceAdapter` 的非加密路径用 `chunk.toString('utf8')` 按块拼接（`ClaudeSourceAdapter.ts:245`）——**跨块切断的多字节字符会变成替换字符**，而加密路径走的是整份 buffer 一次性 `toString`，两条路的行为不同。这一条我没有构造出确定的用户可见后果（坏掉的行大概率 JSON.parse 失败并计入 `malformedLines`），所以没有立成发现，但它没有任何用例。
10. **`ClaudeSessionScanner.readTailLines` 的分块解码同样按块 `toString('utf-8')`**（`:384`），无用例。

## 未经执行验证的声明

以下几条我读到了、但没能构造出确定的触发路径或确定的用户可见后果，按规则不立为发现：

1. **`readTailLines` / `sourceLines` 的跨块 UTF-8 切断**（`ClaudeSessionScanner.ts:384`、`ClaudeSourceAdapter.ts:245`）。理论上会产生替换字符，但两处的下游都是 `JSON.parse`，坏行会被计入 `malformedLines` 或跳过；`readTailLines` 取的是 `slice(-lineCount)`（尾部），而损坏发生在拼接前沿，多数情况下够不到。没有实测。
2. **`ClaudeSessionScanner` 在超大项目下的文件描述符压力**：`getSessionsForProject` 对所有 winner 并发 `Promise.all`，每个都 `createReadStream` + `fs.open`（`:504-517`），没有并发上限；EMFILE 会被 `:508` 的 catch 吞成「这条会话不显示」。需要几千条会话才可能触发，我没有实测，也无法判断真实用户的会话规模。
3. **`workspaceMatched` 的粒度错配**：渲染层按**项目**路径算 `matched`（`ConversationImportSettings.tsx:99`），Main 按**会话**自己记录的 `workspacePath` 判目录是否存在（`LegacyImportService.ts:145`）。Claude 的项目目录名是按 cwd 生成的，同项目内各会话 cwd 通常一致，我没能构造出二者不一致的真实路径。
4. **native 扁平 sessions 目录与 pi CLI 的互通**：H/21 检查 4 声称导入产物与 GUI/TUI 共用目录。native 的扁平布局是否仍被 pi CLI 的会话列表认到，属于 H/20 互通的范围，我没有读 `piSessionTree` / `sessionInterop`，不下结论。
5. **`CodexSourceAdapter.assertUnchanged` 的错误形态**：它重新走一遍 `readCodexSessionSource`，若源文件在期间被追加成「解析不过」的状态，抛出的会是解析错误（如 `Conflicting Codex session metadata`）而不是「源已改变」。后果都是导入失败并回滚，只是文案不准，我没有立成发现。
6. **加密文件系统（TSD）下的导入路径**：`ClaudeSourceAdapter` 有完整的 TSD 分支（`sha256File` / `sourceLines` 各一条），`CodexSessionScanner` **完全没有 TSD 分支**——它用 `fs.open` + 定位读。如果 Windows 加密机上的 `~/.codex` rollout 也是 TSD 加密的，Codex 导入会读到密文并在 `JSON.parse` 处失败。我无法在本机验证 Codex 目录在加密机上是否受策略覆盖，故列为待上机项（见检查单）而不是发现。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| Codex 源在加密机上是否受 TSD 策略覆盖 | `~/.codex/sessions/**/*.jsonl` 的首部是否带 TSD 头；若带，`CodexSessionScanner` 因为没有 TSD 分支会读到密文 | 在加密机上对任一 rollout 跑 `isFileTsdEncrypted`（可用现成工具函数写一个只读小脚本），再打开导入面板看 Codex 项目是否为空 | encrypted |
| Claude 导入在加密机上的完整闭环 | 一条真实 `~/.claude` 会话能被列出、能导入、导入后能打开并续聊 | 走 GUI 完整导入一条，记录 `sessions/` 下产物路径与索引行 | encrypted |
| 子目录不可读时 Codex 源的表现（import-up-01） | 在 `~/.codex/sessions/<某一天>/` 上置 mode 000 后，导入面板里 Codex 项目是否仍能列出其它日期 | 改权限 → 打开导入面板截图 → 恢复权限 | dev-box / windows |
| 超 32 MiB 会话的导入错误形态（import-up-04） | 用户看到的失败文案是否可理解；失败后是否残留暂存文件或 manifest 记录 | 造一份 35 MiB 左右的 Claude JSONL，走 GUI 导入，记录报错文本并检查 `sessions/.aiclient-import-staging/` | dev-box |
| Codex 旧格式（裸行）真机导入（H/21 C5） | 真实旧格式 rollout 能被列出并导入成功 | 需要一台还留着旧格式 rollout 的机器，或从 Codex 历史版本导出一份；H/21 当时「本机 10 个 rollout 全是新格式」 | dev-box |
| 导入产物路径与 pi CLI 互通（import-up-10） | `<agentDir>/sessions/<id>.jsonl` 能被 `pi --session` 打开，并出现在 TUI 的会话列表里 | 起 Electron 导一条，再用随包 CLI 打开同一文件 | utility / dev-box |
| 导入会话的续聊（H/21 C6 真机复验） | 导入的历史真的进了模型上下文，模型据此作答 | 真实模型回合一次，问「上面这段对话在讨论什么」 | real-model |
| 大目录下导入的主进程占用（import-up-03） | 300 份以上 rollout 时，打开导入面板与批量导入 40 条各自的耗时与界面响应 | 起 Electron，用 CDP 记录面板打开到列表渲染的时间；批量导入期间观察界面是否可交互 | dev-box |
| Windows 下的导入路径拼接 | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 取 Windows 路径时扫描与落盘均正常；`decodeProjectDirNameFallback` 的盘符还原（`ClaudeSessionScanner.ts:258-262`）在真实项目目录名上给出正确结果 | 在 Windows 上打开导入面板，核对项目路径显示 | windows |

## 读过的文件

**审查对象（源码）**
- src/main/services/legacyImport/ClaudeSessionScanner.ts
- src/main/services/legacyImport/ClaudeSourceAdapter.ts
- src/main/services/legacyImport/CodexSessionScanner.ts
- src/main/services/legacyImport/CodexSourceAdapter.ts
- src/main/services/legacyImport/CodexRollout.ts
- src/main/services/legacyImport/legacyImportSanitization.ts
- src/main/services/legacyImport/LegacyImportService.ts
- src/main/services/legacyImport/LegacyImportSources.ts
- src/main/services/legacyImport/PiImportProcess.ts
- src/shared/types/legacyImport.ts
- src/runtime/worker/nativeImport.ts
- src/runtime/plugins/session/store.ts（部分：open / appendEntry / mutate 的预算检查）
- src/runtime/plugins/session/codec.ts（部分：SESSION_MAX_BYTES 与注释）
- src/agent-host/piWorkerRpcServer.ts（部分：handleImport）
- src/agent-host/codexItemMapper.ts（部分：readCodexTextContent / extractReasoningText / clampText）
- src/agent-host/codexHistoryReader.ts（部分）
- src/renderer/components/settings/ConversationImportSettings.tsx（部分：runImport / workspaceMatched）
- src/runtime/plugins/tools/index.ts（部分：OPTIONAL_FILE_ERRORS）
- src/runtime/plugins/skills/index.ts（部分：OPTIONAL_FILE_ERRORS）

**测试**
- src/main/services/legacyImport/__tests__/ClaudeSessionScanner.test.ts（用例清单，重点 392 / 443）
- src/main/services/legacyImport/__tests__/ClaudeSourceAdapter.test.ts（用例清单，重点 267 / 302 / 329）
- src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts（全文 + `git show fe246bd6` 的本文件 diff）
- src/main/services/legacyImport/__tests__/CodexRollout.test.ts（用例清单）
- src/main/services/legacyImport/__tests__/CodexSessionScanner.test.ts（用例清单，重点 90）
- src/main/services/legacyImport/__tests__/LegacyImportService.test.ts（用例清单，重点 615～649）
- src/main/services/legacyImport/__tests__/legacyImportStatic.test.ts（用例清单）
- src/runtime/__tests__/nativeImport.test.ts
- src/renderer/components/settings/__tests__/conversationImportInteraction.test.ts（部分：CI-05 / CI-06）

**历史版本（git show，仅比对用）**
- `fe246bd6^:src/agent-host/piLegacyImport.ts`（退役前 pi 写入器，第 1～200 行）

**文档**
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（CRITIC 段与 GAP [P5-4]）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/area-assessments.md（P5-4 / P5-5 段）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-low.md（import-catalog-04～14）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-uncertain-refuted.md（import-catalog-14）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-medium.md（第 634 行 waiver）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段与任务表 T008 / T010 / T015 / T021 / T024 / T029）
- docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md（第一～四节）
- docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md（C1～C6 段）
- docs/plantree/plans/runtime-evolution/evidence/p5-4-p5-5/README.md（部分）
