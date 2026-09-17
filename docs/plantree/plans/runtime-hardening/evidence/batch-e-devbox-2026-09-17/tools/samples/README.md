# T032 开发机组 import-upstream 四项样本（DEV-10 / 11 / 12 / 13）

- 仓库：`/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，HEAD `b3d751e3`
- 本目录**全部在 `/tmp` 下**，没有改动仓库任何文件，没有起 Electron，没有跑全量测试或 `pnpm build`
- 生成脚本：`/tmp/t032/samples/make-samples.mjs`（幂等，重跑会先删干净再重建）
- 验证脚本：`/tmp/t032/samples/verify-scan.mjs` → 输出存 `/tmp/t032/samples/verify-scan.txt`
- 磁盘：`/tmp` 是 tmpfs（占内存），本目录总计约 **37 MB**；生成前 `df -h /tmp` 显示 1.6 G 可用

---

## 0. 结论速查（做点验前先看这三条）

1. **DEV-10 的判据按代码读大概率不成立。** `~/.codex/sessions/<某天>/` 不可读时，`CodexSessionScanner.walk()`
   的 `readdir` 抛 `EACCES`，这个异常**没有**被按目录兜住，会一路冒到 `scan()` 外层（只放过 `ENOENT`），
   再被 `scanAllLegacySources` 的 `catch {}` 吞掉 —— 结果是**整个 Codex 源从导入面板消失**，而不是
   「仍能列出其它日期的会话」。我已在离线状态下实跑复现（见 `verify-scan.txt` 的 DEV-10 段）。
   上机时请照常做，但预期是「Codex 项目整条不见」，并把它记成一条缺陷候选而不是操作失误。
2. **DEV-11 的「32 MiB」在 Linux 上不是生效阈值。** 32 MiB（`TSD_BUFFERED_READ_LIMIT`）只管
   Windows 上被 TSD 加密的文件；普通文件走的是 64 MiB 的 `LEGACY_IMPORT_MAX_SOURCE_BYTES`。
   所以 35 MiB 的会话**不会**触发体积守卫，它触发的是 **4000 条目上限**。实测报错原文：
   `Claude session exceeds the 4000-entry import limit`（英文，不是中文文案）。
   想验真正的体积守卫要 >64 MiB，用 `make-samples.mjs --huge`（会再写一份约 65 MiB 的文件）。
3. **DEV-12 本机无真实旧格式样本 → 只能 ⛔。** `~/.codex/sessions/` 现有 12 个 rollout，我逐个读了第一行，
   **全部是新格式**（`{"timestamp":...,"type":"session_meta","payload":{...}}`）。仓库里也没有旧格式的
   夹具文件，只有一份写在测试源码里的**合成**样本。详见第 5 节。

---

## 1. 目录结构

```
/tmp/t032/samples/
├── make-samples.mjs                 # 生成脚本
├── verify-scan.mjs                  # 用真扫描器验证样本
├── verify-scan.txt                  # 验证输出（本次实跑）
├── README.md                        # 本文件
├── claude-home/                     # 当 CLAUDE_CONFIG_DIR 用
│   └── projects/
│       └── -home-ai-code-ai-client/
│           ├── 0a5f2c31-7b44-4d0e-9f61-a1b2c3d4e5f6.jsonl   # 36,748,026 B = 35.05 MiB  ← DEV-11 主角
│           └── b7c81d92-3e40-4a55-8c11-d0e1f2a3b4c5.jsonl   #     48,485 B = 47.3 KiB   ← 对照小会话
├── codex-home/                      # 当 CODEX_HOME 用
│   └── sessions/2026/09/{10,11,12,13,14,15}/rollout-*.jsonl  # 共 320 份，新格式
├── codex-legacy-synthetic/          # ⚠️ 合成旧格式，故意放在 codex-home 之外
│   ├── SYNTHETIC-DO-NOT-CLAIM-AS-REAL.txt
│   └── sessions/2026/09/16/rollout-2026-09-16T09-00-00-*.jsonl
└── .verify-build/                   # verify-scan.mjs 的 esbuild 中间产物，可随时删
```

Codex 每个日期目录的份数：

| 日期目录 | 份数 | 用途 |
|---|---|---|
| `sessions/2026/09/10` | 60 | |
| `sessions/2026/09/11` | 60 | |
| **`sessions/2026/09/12`** | **40** | **← DEV-10 的 `chmod 000` 目标** |
| `sessions/2026/09/13` | 60 | |
| `sessions/2026/09/14` | 60 | |
| `sessions/2026/09/15` | 40 | |
| 合计 | **320** | |

320 份全部写同一个 `cwd`（`/home/ai/code/ai-client`），所以在面板里聚成**一个** Codex 项目，
项目 id `codex-0d0e6f0206d58e1f0134292ef1429440541bc4a15151c0ee0def386951e54b88`。
每份的标题都不同（`T032 bulk rollout #001 2026-09-10 topic=terminal` 这种），方便在列表里辨认与计数。

---

## 2. 扫描器解析规则摘要（带文件:行号）

### 2.1 Claude 源 —— `src/main/services/legacyImport/ClaudeSessionScanner.ts`

| 规则 | 位置 | 内容 |
|---|---|---|
| 根目录 | `ClaudeSessionScanner.ts:55-60` | `CLAUDE_CONFIG_DIR` 或 `~/.claude`；每次调用重新读环境变量，**没有构造期缓存** |
| 项目目录 | `:62-64`、`:75-88` | `<root>/projects/` 下的**每个子目录**就是一个项目；读不到时 `ENOENT` 返回空，其它错误打日志后也返回空（不抛） |
| 会话文件名 | `:269-277` | 必须以 `.jsonl` 结尾，且**不能以 `agent-` 开头**；`sessionId` = 去掉 `.jsonl` 的文件名 |
| 名字合法性 | `:71-73` + `src/shared/types/legacyImport.ts:321-332` | 项目名/会话名不得含 `/`、`\`、`\0`，不能是 `.` / `..`，长度 ≤ 512 |
| 项目路径怎么来 | `:642-652`、`:398-449` | **优先读会话 JSONL 里的 `cwd`**：先找 `type:"system"` + `subtype:"init"` 的 `cwd`，否则用前 300 行里任意一条的 `cwd`；都没有才退回目录名反解 |
| 目录名反解（兜底） | `:253-267` | `-home-ai-code-ai-client` → `/home/ai/code/ai-client`；首段是单字母时按 Windows 盘符解成 `D:\...` |
| 列表预览读多少 | `:566-612`、`:614-629` | 只读**前 300 行**取标题/模型/创建时间，再从**文件尾部**倒着读 50 行取最后活动时间 |
| 标题 | `:594-604`、`:229-251` | 第一条 `type:"user"` 的正文，剥掉 `<command-name>` / `<system-reminder>` 等包装标签后截到 80 字符；全是斜杠命令时退回 `/命令名` |
| 模型 | `:588-592` | 第一条 `system`+`init` 行的 `model` |
| 单会话失败隔离 | `:504-522` | 某个会话读失败只丢它自己，不影响同项目其它会话 |

导入（真正转换）阶段 —— `ClaudeSourceAdapter.ts`：

| 守卫 | 位置 | 阈值 / 文案 |
|---|---|---|
| 文件体积 | `:186-189` | `> 64 MiB` → `Claude session exceeds the 67108864-byte import limit` |
| 边读边涨 | `:242-244` | 读的过程中超 64 MiB → `Claude session grew beyond the import size limit` |
| 单行长度 | `:229/247/253/261` | `> 2 MiB` → `Claude session contains an oversized JSONL line` |
| 条目数 | `:270-274` | `> 4000` → `Claude session exceeds the 4000-entry import limit` ← **35 MiB 样本撞的是这条** |
| 单条文本 | `:91-94` | `> 64 KiB` **截断**（不报错），标 `truncated:true` |
| 读时被改 | `:333-348` | size/mode/mtime/dev/ino 任一变化 → `Claude session changed while it was being imported; retry the import step` |
| 跳过的行 | `:340-343`、`:72-82` | `isSidechain:true`、`isMeta:true`、`type:"system"`、以及 `mode`/`summary`/`file-history-snapshot` 等 9 种控制行 |

常量表 `src/shared/types/legacyImport.ts:6-12`：
`MAX_SOURCE_BYTES = 64 MiB`、`MAX_ENTRIES = 4000`、`MAX_TEXT_CHARS = 64 KiB`、`MAX_LINE_CHARS = 2 MiB`、
`MAX_DIAGNOSTICS = 100`、`MAX_BATCH = 100`（所以 DEV-13 的「一次 40 条」在上限内）。
另有 `src/main/utils/tsdSafeRead.ts:86` 的 `TSD_BUFFERED_READ_LIMIT = 32 MiB`，**只对 TSD 加密文件生效**。

### 2.2 Codex 源 —— `CodexSessionScanner.ts` / `CodexRollout.ts`

| 规则 | 位置 | 内容 |
|---|---|---|
| 根目录 | `CodexSessionScanner.ts:80-83` | `CODEX_HOME` 或 `~/.codex`，再拼 `sessions/`；也是每次 `scan()` 现读环境变量 |
| 目录深度 | `:88-92` | 从根往下递归**最多 3 层**，正好对上 `YYYY/MM/DD/`；第 4 层只当文件处理 |
| 文件名 | `:93` | 只要求 `.jsonl` 结尾，**不要求 `rollout-` 前缀**（样本仍按真实命名习惯造） |
| 文件上限 | `:94` | 单次扫描超 10000 个文件直接抛错 |
| 单文件体积 | `:35` | `> 64 MiB` 或不是普通文件 → 抛错（被单文件 catch 吞掉，只丢这一份） |
| 读时被改 | `:47-56` | size/mtime/ctime/mode 任一变化 → `Codex source changed while reading; retry the import step` |
| 单文件失败隔离 | `:113-120` | 解析失败只 `console.warn` 跳过，不影响同目录其它文件 |
| **目录失败不隔离** | `:88-92` + `:123-127` | 子目录 `readdir` 抛 `EACCES` 时**没有 try/catch**，冒到最外层；最外层只放过 `ENOENT`，其余重抛 → **整个 Codex 源消失**（DEV-10 的真实表现） |
| 上榜条件 | `:97-101` | 解析结果里**必须同时有** ≥1 条 user 和 ≥1 条 assistant，否则这份 rollout 不出现在列表里 |
| 标题 | `:107` | 第一条 user 正文截到 256 字符 |
| 项目 id | `:27-29` | `codex-<sha256(cwd)>`，所以**按 `cwd` 聚项目** |

新格式 vs 旧格式的判别（`CodexRollout.ts:38-49` 的文档注释 + `:50-193` 实现）：

| | 新格式（current） | 旧格式（legacy / 裸行） |
|---|---|---|
| 每行外壳 | `{timestamp, type, payload}` | **没有外壳**，条目本身就是行 |
| 头行 | `type:"session_meta"`，`payload.id` 与 `payload.cwd` 都必须非空（`:73-81`） | **没有 `type` 字段**，但有字符串 `id` 和字符串 `timestamp`（`:95-107`）；`cwd` 可以缺，缺了只记一条诊断 |
| 条目行 | `type:"response_item"`，内容在 `payload` 里（`:113`） | 行本身的 `type` ∈ `message` / `reasoning` / `function_call` / `function_call_output` / `custom_tool_call` / `custom_tool_call_output`（`:58-65`、`:109-111`） |
| 模型 | `type:"turn_context"` 的 `payload.model`（`:89-92`） | 无 |
| 两者共用 | 文本抽取都走 `readCodexTextContent`（`src/agent-host/codexItemMapper.ts:256-279`），认 `text` / `input_text` / `output_text` / `summary_text` | 同左 |

一个容易踩的坑：`isSyntheticCodexUserText`（`CodexRollout.ts:34-36`）会把以 `<`、`# AGENTS.md`、
`You are Codex` **开头**的 user 正文当成注入的仓库说明丢掉。样本里的标题因此都以 `T032` 开头，
同时故意放了一条 `# AGENTS.md ...` 的 user 行来验证这条丢弃逻辑。

### 2.3 落盘与清单（DEV-11 要查的两处）

- 暂存目录常量：`src/runtime/worker/nativeImport.ts:58` → `.aiclient-import-staging`；
  拼接在 `:264` → `<agentDir>/sessions/.aiclient-import-staging`。
  dev 模式实际路径：**`/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/.aiclient-import-staging/`**
- 清单文件：`LegacyImportManifest.ts:12,60` → `<userData>/legacy-import-manifest.json`，
  dev 模式实际路径：**`/home/ai/.config/jyw-ai-client-dev/legacy-import-manifest.json`**
- `cleanupPending` 字段：`LegacyImportManifest.ts:31`（声明）、`:231-243`（`fail()` 默认写 `true`）、
  `:218`（成功时写 `false`）、`:164` 与 `LegacyImportService.ts:406`（重试/对账时按它判断要不要清理）

---

## 3. 怎么让应用读这些目录

**结论：在起 `dev.js` 的那条命令前 `export` 两个变量就够了，不用改 `dev.env`。**

依据（都是读过的源码，不是推断）：

1. 两个变量都在 **Main 进程**读，且是**每次调用现读**，不是启动时快照：
   - `CLAUDE_CONFIG_DIR`：`ClaudeSessionScanner.ts:55-60`，经 `LegacyImportService.ts:106`
     的 `resolveRoots: () => [resolveLegacyClaudeSessionRoot()]` 懒调用
   - `CODEX_HOME`：`CodexSessionScanner.ts:80-83`，默认 `resolveRoot` 是个箭头函数，`scan()` 时才求值
   - IPC handler 在 Main：`src/main/ipc/legacyImport.ts:10/22/30` → `legacyImportService.*`
2. **`scripts/dev.js` 不会剥掉这两个变量。** `buildChildEnv()`（`dev.js:162-227`）从 `{...process.env}`
   出发，只删 `ANTHROPIC_` 前缀 + `credential-env-keys.mjs` 里那 6 个键 + `AICLIENT_MANAGED_CREDENTIALS`。
   我用 `grep -an 'CLAUDE\|CODEX' scripts/dev.js` 查过，**整份 dev.js 里这两个词一次都没出现**。
   > ⚠️ 注意：`scripts/credential-env-keys.mjs:19-22` 的注释写着「dev.js 仍会清掉 `CLAUDE_CONFIG_DIR`」，
   > **这条注释已经过期**，代码里没有对应实现。按代码走，不按注释走。
3. `dev.env` 里也没有这两个键（实查键名：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、
   `AICLIENT_DEFAULT_TEST_MODEL`、`AICLIENT_MANAGED_CREDENTIALS`、`AICLIENT_NODE24_PATH`、
   `PI_CODING_AGENT_DIR`），所以 `Object.assign(env, dev.env)`（`dev.js:203`）不会把 shell 里的值盖掉。
4. Main 自己也不动它：`managedCredentialsStartup.ts` 只剥 credential 清单里的键，
   `__tests__/managedCredentialsStartup.test.ts:155-162` 明确断言「用户设的 `CLAUDE_CONFIG_DIR` 原样保留」。
   凭据收养走的是硬编码的 `homedir()`（`src/main/services/auth/adoption.ts:107`），**不受 `CLAUDE_CONFIG_DIR` 影响**。

启动命令（在手册第 1 节配方上加两个 export）：

```bash
cd /home/ai/code/ai-client
DISPLAY=:0 no_proxy=localhost,127.0.0.1,::1 \
  CLAUDE_CONFIG_DIR=/tmp/t032/samples/claude-home \
  CODEX_HOME=/tmp/t032/samples/codex-home \
  setsid nohup node scripts/dev.js --remote-debugging-port=9333 \
  > /tmp/t032/dev-import.log 2>&1 &
```

起来之后先自证变量真的进了 Main（CDP 里问不到 `process.env`，所以从 `/proc` 读）：

```bash
# 找到 Electron 主进程 pid 后
tr '\0' '\n' < /proc/<主进程pid>/environ | grep -E 'CLAUDE_CONFIG_DIR|CODEX_HOME'
```

**副作用提醒**：指了 `CLAUDE_CONFIG_DIR` 之后，面板里就**看不到本机真实的那 363 个 Claude 会话**了，
只剩样本里的 2 个。如果同一轮还想用真实 Claude 数据，要么分两次起，要么先把
`~/.claude/projects/-home-ai-code-ai-client` 复制进 `claude-home/projects/`（约 300 MB，tmpfs 上不建议）。

---

## 4. 四项怎么用这批样本

### DEV-10（import-up-01，子目录不可读）

```bash
chmod 000 /tmp/t032/samples/codex-home/sessions/2026/09/12     # 40 份会被挡住
# → 打开设置里的「导入历史会话」面板，截图
chmod 755 /tmp/t032/samples/codex-home/sessions/2026/09/12     # 务必恢复
```

- 判据原文期望：Codex 项目仍列出其它日期的 280 份
- **代码预期（已离线复现）**：Codex 项目整条消失，面板里只剩 Claude 源；
  Main 日志里应有 `EACCES: permission denied, scandir '.../2026/09/12'` 的痕迹
- 所以这项大概率是 ✗（缺陷），不是操作失败。截图时把「恢复权限后重开面板能看到 320 份」也拍一张作对照

### DEV-11（import-up-04，超大会话）

- 用的文件：`claude-home/projects/-home-ai-code-ai-client/0a5f2c31-7b44-4d0e-9f61-a1b2c3d4e5f6.jsonl`
- **精确字节数：36,748,026 B（35.05 MiB）**，6001 行 = 1 行 `system/init` + 3000 轮 user/assistant
- 对照文件：`b7c81d92-...jsonl`，48,485 B（47.3 KiB），应能正常导入（离线实测 16 条目，5 ms）
- 离线实测的失败原文：`Claude session exceeds the 4000-entry import limit`
  （英文。这句话是**原样**传到界面上的：`ClaudeSourceAdapter.ts:544-556` 的 `safeSourceError()` 对
  已知的 `ClaudeImportSourceError` 直接放行，`LegacyImportService.ts:29,222` 的 `errorMessage()` 取
  `error.message`，渲染层 `ConversationImportSettings.tsx:44-45,221` 再原样显示，全程没有中文映射 ——
  「用户看到的失败文案可理解」这条判据请按这个事实评）
- 失败后要查的两处：
  ```bash
  ls -la /home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/.aiclient-import-staging/ 2>&1
  python3 -m json.tool /home/ai/.config/jyw-ai-client-dev/legacy-import-manifest.json | grep -n cleanupPending
  ```
- 想同时验 64 MiB 体积守卫：`node /tmp/t032/samples/make-samples.mjs --huge`（多约 65 MiB，
  tmpfs 占内存，跑前看 `free -m`），报错文案会变成 `...exceeds the 67108864-byte import limit`

### DEV-12（Codex 旧格式真机导入）

**本机没有真实旧格式样本，只能 ⛔。** 见第 5 节。

### DEV-13（import-up-03，大目录性能）

- `codex-home` 已有 320 份（>300），单项目
- 离线纯扫描耗时参考：**320 份 `scan()` 139 ms**（无 Electron、文件在 tmpfs 且缓存热）。
  GUI 上的数字会明显更大，差额就是 IPC + React 渲染 + 冷缓存
- 注意一个会影响读数的实现细节：`codexSourceImporter.scan()`（`LegacyImportSources.ts:52-53`）
  **每次都全量重扫并完整解析所有 rollout**，列项目和列会话是两次独立全扫，没有缓存
- 批量导入 40 条在 `LEGACY_IMPORT_MAX_BATCH = 100` 以内，合法

---

## 5. 旧格式样本情况（DEV-12）

**真实样本：无。**

- `~/.codex/sessions/` 下现有 **12 份** rollout，我逐份读了第一行，**12/12 都是新格式**
  （`{"timestamp":"...","type":"session_meta","payload":{...}}`）。与 H/21 当时「本机 10 个全是新格式」一致。
- 仓库里**没有**旧格式的夹具文件。唯一的旧格式样本是写死在测试源码里的对象字面量：
  **`src/main/services/legacyImport/__tests__/CodexRollout.test.ts:68-115`**
  （`it('reads the legacy bare-row rollout shape')` 与 `it('reports a legacy session with no recorded cwd...')`），
  **是合成的**，不是任何 Codex 版本的真实产物。
- 我按上面那份合成夹具 + `CodexRollout.ts:38-49` 的注释，另写了一份**明确标注为合成**的文件，
  放在 `codex-legacy-synthetic/`（**故意不放进 `codex-home`**，避免被误当成真实样本混进 DEV-13 的计数）：
  - `codex-legacy-synthetic/sessions/2026/09/16/rollout-2026-09-16T09-00-00-*.jsonl`
  - 同目录上层有 `SYNTHETIC-DO-NOT-CLAIM-AS-REAL.txt` 说明它的来历
  - 离线验证过它能被 `CodexSessionScanner` 正常列出（见 `verify-scan.txt` 最后一段）
- **判据写的是「真实旧格式 rollout」，所以 DEV-12 记 ⛔（缺样本），不要用这份合成文件冒充。**
  如果只是想探路「解析器对裸行格式还能不能正常工作」，可以临时
  `CODEX_HOME=/tmp/t032/samples/codex-legacy-synthetic` 起一次，但结论必须标注「合成样本，非 DEV-12 判据」。
- 要拿到真样本的两条路：找一台还留着旧版 Codex rollout 的机器；或装一个足够老的 Codex 版本
  （本机 rollout 里记的 `cli_version` 是 `0.149.1`，已经是新格式）跑一次会话导出。

---

## 6. 验证结果（`verify-scan.txt`）

`verify-scan.mjs` 用仓库自带的 esbuild 把真实扫描器打成一份临时 ESM（alias `@shared` → `src/shared`）再
直接调用 —— 这几个模块只依赖 `node:fs` / `node:crypto`，**不 import electron**，所以能脱离主进程跑。
（因此没有用 vitest，也就没有在仓库里新建任何测试文件。）

本次实跑要点：

| 检查 | 结果 |
|---|---|
| Claude `scanProjects()` | 1 个项目，`path=/home/ai/code/ai-client`，2 个会话，10 ms |
| Claude `getSessionsForProject()` | 2 条，标题与模型都正确解析出来（`model=claude-sonnet-5`），37 ms |
| Claude 导入 35 MiB 样本 | **失败**：`ClaudeImportSourceError: Claude session exceeds the 4000-entry import limit`（364 ms） |
| Claude 导入 47 KiB 样本 | 成功，16 条目 |
| Codex `scan()`（全目录可读） | **320** 份，1 个项目，139 ms，标题各不相同 |
| Codex `scan()`（`09/12` 置 000） | 抛 `EACCES: permission denied, scandir '.../2026/09/12'` |
| `scanAllLegacySources()`（同上） | 只剩 **1** 个项目（Claude），**Codex 整源消失** |
| 恢复权限后同一调用 | 2 个项目：Claude 2 条 + Codex 320 条 |
| 合成旧格式 rollout | 能被列出，`cwd` / 标题解析正确 |

脚本自己会 `chmod 000` → 跑 → `chmod 755` 恢复，退出时目录权限已还原（已确认）。

---

## 7. 重新生成 / 清理

```bash
# 重新生成（幂等）
node /tmp/t032/samples/make-samples.mjs
node /tmp/t032/samples/make-samples.mjs --huge     # 额外多一份 >64 MiB 的 Claude 会话

# 重新验证
T032_HEAD=$(git -C /home/ai/code/ai-client rev-parse --short HEAD) \
  node /tmp/t032/samples/verify-scan.mjs | tee /tmp/t032/samples/verify-scan.txt

# 清理（先确保 chmod 000 已恢复，否则 rm 会失败）
chmod -R u+rwX /tmp/t032/samples
rm -rf /tmp/t032/samples
```

点验结束后记得把启动用的两个环境变量去掉再起应用，否则面板里看到的一直是样本而不是真实历史。
