# 升级后数据不见 — 状态迁移漏掉的三个位置

Role: topic。建立：2026-09-21。**状态：3 项均已修（代码 + 单元测试 + Windows 上的 Chromium 机制实测，2026-09-23）；安装包级别的真机验收（§7）待执行。**
任务身份权威见 [roadmap](../roadmap.md)。

---

## 0. 一句话

从 `1.0.0-test.16` 升级到改名后的版本，用户的**项目列表和对话列表会全部消失**，即使会话文件本身完好。原因是状态迁移只搬了三处位置中的一处，而那一处的目录名还写错了。

---

## 1. 现场

2026-09-21，测试者的 Windows 机器（`C:\Users\Dssaiy`），从 `1.0.0-test.16` 升级。现象：左侧聊天栏完全空白，没有项目也没有对话。

PowerShell 实测（**不是推断**）：

| 探测 | 结果 |
|---|---|
| `~\.pilab\AiClient` | **不存在** |
| `~\.aiclient` | 不存在 |
| `~\.pilab\jyw-ai-client` | **存在**，含 `credentials` / `pi-agent` / `session-state.json`(9543B) / `settings.json` |
| `~\.pilab\jyw-ai-client\pi-agent\sessions` | **11 个 jsonl** |
| `%APPDATA%\jyw-ai-client\Local Storage\leveldb` | 6 个文件 |
| `%APPDATA%\AiClient\` | 不存在 |

手动把 `~\.pilab\jyw-ai-client\*` 复制进 `~\.pilab\PiLabAi\` 之后：会话 jsonl 到位（11 个），**侧栏仍然空白**。再把 `Local Storage` 也复制过去，**仍然空白**。

---

## 2. 三个位置，各装什么

| # | 位置 | 装的什么 | 迁移现状 |
|---|---|---|---|
| 1 | `~/.pilab/<名>/` | 会话 jsonl、`settings.json`、`credentials/vault.json` | 搬，名单已修正（`d4b9445e`） |
| 2 | `<appData>/<名>/Local Storage/` | **项目 / 仓库列表** | **已修**：目标不存在时整目录复制；目标已存在时按键合并（§3.2） |
| 3 | `<appData>/<名>/session-index.json` | **对话列表** | **已修**：按 sessionId 合并，并改写 `runtimeIdentity`（§3.3） |

---

## 3. 逐条根因

### 3.1 目录名写错 —— 已修（`d4b9445e`）

`PRIOR_USER_DATA_DIR_NAMES` 填的是 `AiClient`，来源是 `electron-builder.yml` 的 `productName`。但 Electron 的 `app.getName()` 读的是**打包后的 `package.json`**，改名前那份（见 `git show 68dbc732^:package.json`）**没有 `productName` 字段**，于是 `name: jyw-ai-client` 生效。

`AiClient` 这个目录**从未存在过**，迁移一直在找一个不存在的路径。

讽刺的旁证：`src/shared/__tests__/appStateLayout.test.ts` 通篇用 `jyw-ai-client` 当发布版目录名，这份名单是唯一写反的地方。

已加 `[PRIOR-1..4]` 四条守卫，`[PRIOR-1]` 在旧常量下失败（已反向验证）。

### 3.2 `Local Storage` 不搬 —— 已修（2026-09-23）

项目列表的键是 `aiclient-repositories`，定义在 `src/renderer/App/storage.ts:12`，存在 `window.localStorage`，落盘在 `<userData>/Local Storage/leveldb`。

`migrateAppState` 只搬 `prior.root` 与 `prior.credentialsDir`，从不碰 `<appData>/<名>/Local Storage`。

**⚠️ 实现注意**：不能直接复用 `copyTree`。它是**逐文件**跳过已存在项的，而 leveldb 是一个带 `MANIFEST` / `CURRENT` / `LOG` 的多文件存储 —— 新旧混合会得到一个半合并的坏库，比不复制更糟。这一项必须是**整目录**粒度：**目标目录不存在时才整份复制**，存在就整个跳过。

**为什么 `session-state.json` 里的 `localStorage` 镜像顶不上**：`src/preload/index.ts:677` 暴露了 `sessionStorage.get` / `syncLocalStorage` / `importLocalStorage` 三个桥，但**渲染层没有任何地方调用它们**（全仓搜索零命中）。主进程侧 `LocalSessionManager` 在写，渲染层不读也不写 —— 实测本机 dev profile 的 `session-state.json` 里 `localStorage` 是 **0 个键**，而该 profile 有真实的项目和会话。这个镜像是只写不读的死链路，**它本身也是个待决问题**（接上还是退役）。

### 3.3 `session-index.json` 不搬，且内含绝对路径 —— 已修（2026-09-23）

**对话列表读的就是这个文件**，位置 `<userData>/session-index.json`（`src/main/services/chat/SessionIndexService.ts:95`，`SESSION_INDEX_FILENAME`）。

单条的形状（本机实测）：

```json
{
  "sessionId": "session-1789980129922-044xr4w",
  "runtimeIdentity": "/home/pi/.pilab/jyw-ai-client-dev/pi-agent/sessions/session-1789980129922-044xr4w.jsonl",
  "piLeaf": { "activeEntryId": "…", "fileTailEntryId": "…" },
  "agent": "pi",
  "unbound": true,
  "workspacePath": "…",
  "title": "你好",
  "model": "grok/grok-4.6",
  "updatedAt": 1789980173950,
  "archived": false
}
```

**`runtimeIdentity` 是 jsonl 的绝对路径，里面带着配置档名。** 所以光复制文件不够 —— 每条的 `.pilab/<旧名>/` 必须改写成 `.pilab/<新名>/`，否则新版会一直读旧目录（旧目录还在，表面能用，但用户实际没迁移成功）。

`workspacePath` 指向真实的仓库目录，与改名无关，**不要改写它**。

**修复方案（`migratePriorUserData`，`src/main/services/appStateMigration.ts`）**：

- 按 `PRIOR_USER_DATA_DIR_NAMES` 从新到旧读取各个旧 `session-index.json`，与目标文件**按 sessionId 合并**：目标里已有的行一律不动，只补缺少的行；多个旧名之间，较新的旧名优先。
- 只有补进来的行才改写 `runtimeIdentity`（`rewriteRuntimeIdentity`）：按路径段匹配 `.pilab<分隔符><旧名>` 或 `.aiclient`，大小写不敏感，`\` 和 `/` 都兼容，替换成 `.pilab<分隔符>PiLabAi`，其余部分逐字保留。**只有新路径上的 jsonl 真实存在时才改写**，否则保留原值并计入 `identityKept`。`jyw-ai-client-dev` 这类只是前缀相同的目录名不会被误匹配。
- `workspacePath` 不改。
- 目标文件存在但解析失败时，返回 `failed`，不覆盖、不写标记，交给 `SessionIndexService` 下次加载时另存备份，下次启动再重试。旧文件解析失败时跳过这个来源，计入 `unreadableSources`。
- 写入方式是先写临时文件再 rename；执行时机在 `migrateAppState` 之后（这时 jsonl 已经复制到新根目录，存在性检查才有意义），并且在任何窗口创建之前。

### 3.4 为什么手动复制 `Local Storage` 后侧栏仍然空白

2026-09-23 在 Windows 本机（Electron 39.3，本仓 `node_modules`）实测：

1. **origin 一致，不是原因**：v0.3.4 和当前分支都用 `loadFile` 加载渲染层，都没有设置 `partition`。旧库和新库的键前缀都是 `_file://`，不带安装路径。把本机真实的 `%APPDATA%\jyw-ai-client\Local Storage` 整目录复制进一个全新的 userData，再从**另一个路径**打开 file:// 页面，能读到全部 36 个键，包括 `aiclient-repositories`。
2. **应用运行时目录被锁**：新版运行时，`Remove-Item "...\PiLabAi\Local Storage"` 会因为 leveldb 占着 `LOCK` 报 **EBUSY**，目录删不掉。实测中，应用运行期间复制进去的内容当时读不到，重启后才生效。
3. **§5 脚本会嵌套复制**：目标目录还在的情况下，`Copy-Item "<src>\Local Storage" "<dst>\Local Storage" -Recurse` 会复制成 `Local Storage\Local Storage\leveldb`（已实测），Chromium 读到的仍然是新的空库。

结论：最可能的原因是 2 和 3 叠加，即删除在运行中失败，复制又落进了嵌套目录。测试者当时的具体操作没有留下记录，这一条是根据上述机制实测推断的，不是现场取证。

### 3.2 的修复方案（`migratePriorUserData` + `priorLocalStorageImport.ts`）

- **目标 `Local Storage` 不存在**（v0.3.4 用户首次启动新版）：在 `app.ready` 之前整目录复制。先复制到 `Local Storage.migrating` 暂存目录，再一次 `rename` 换上，这样中途失败不会留下半个库。不使用逐文件合并。
- **目标已存在**（已经启动过 test.17 及以后版本的机器）：不能整目录替换，也不能整个跳过，因为对话挂在仓库树下，仓库列表补不上，对话也就看不见。所以在 `app.ready` 之后、主窗口创建之前**按键合并**：
  - 把旧 `Local Storage` 复制到 `<userData>\.prior-local-storage\<i>`，用 `session.fromPath` 和一个不挂载到任何窗口的 `WebContentsView` 通过 Chromium 读出全部键。旧目录本身从不被 Chromium 打开，所以保持原样；
  - 在默认 session 的 file:// 空白页里写入合并结果（`planLocalStorageMerge`）：`aiclient-repositories` 按规范化路径取并集，`aiclient-repository-groups` 按 id 取并集，新库已有的条目都不动；其他键只在新库没有时才写入；新库里解析失败的列表不碰；
  - 不用 BrowserWindow 的原因：第一个 BrowserWindow 会触发 `browser-window-created`，也就是 vault 加密升级的时机；最后一个窗口关闭会触发 `window-all-closed`，直接退出应用。已实测 `WebContentsView` 不会触发这两个事件，整个过程约 0.4 秒。
- **幂等**：两个新步骤各用独立的标记（`<userData>\.migrated-prior-userdata` 和 `<userData>\.migrated-prior-local-storage`），不受 `.migrated-from-aiclient` 影响。合并规则本身也只增不改，去掉标记重跑结果不变，已有测试覆盖。
- **红线**：旧目录只读不写；先写者优先的判断粒度，leveldb 提到整目录或单个键；失败时不抛异常、不写标记，下次启动重试；日志只输出计数，报错经 `redactStderrLine` 脱敏。

---

## 4. 给执行方的要求

**必须在 Windows 真机上验证**，这是本文件存在的原因 —— Linux 开发机没有 `%APPDATA%`，也没有 Chromium 的 Windows profile 布局，任何断言都只能靠推理。

建议的验收方式：准备一个 `1.0.0-test.16` 的安装（或手工造出三个位置的旧目录），装新版，**第一次启动后**检查：

1. 侧栏出现原有的项目列表；
2. 侧栏出现原有的对话，点开能读到内容；
3. 没有被要求重新登录；
4. 旧目录原样保留（`copy never move` 的既有红线，老版本仍可回退）；
5. 重复启动不重复迁移（`.migrated-from-aiclient` 标记的既有职责）。

**既有红线，别动**：

- 只复制不删除、不移动（模块头「Why COPY and never move」两条理由）；
- 先写者优先，目标已存在不覆盖（leveldb 那项把粒度提到目录，理由见 3.2，**不是**放宽这条）；
- 凭据用 `copyFileSync` 保住 0600 权限位（模块头有实测记录）；
- 迁移失败不抛异常、不写标记，下次启动重试。

---

## 5. 临时人工恢复（已给用户，留档）

> ⚠️ 2026-09-23 更正：下面第 2 步在应用运行时不会生效（EBUSY），在目标目录存在时还会嵌套复制，见 §3.4。修复发布后，这段脚本不再需要。

关闭软件后执行。**仅用于救当前这台机器，不是修复方案。**

```powershell
$h = $env:USERPROFILE; $a = $env:APPDATA
# 1 会话 jsonl 与设置、凭据
Copy-Item "$h\.pilab\jyw-ai-client\*" "$h\.pilab\PiLabAi\" -Recurse -Force
# 2 项目列表（整目录替换，不能逐文件合并）
Remove-Item "$a\PiLabAi\Local Storage" -Recurse -Force
Copy-Item "$a\jyw-ai-client\Local Storage" "$a\PiLabAi\Local Storage" -Recurse -Force
# 3 对话列表，并把 runtimeIdentity 的绝对路径改写到新配置档
$t = Get-Content "$a\jyw-ai-client\session-index.json" -Raw
$t = $t.Replace('.pilab\\jyw-ai-client\\', '.pilab\\PiLabAi\\')
Set-Content "$a\PiLabAi\session-index.json" $t -NoNewline -Encoding utf8
```

---

## 6. 附带发现，未处理

- **`sessionStorage` 桥是死链路**（见 3.2）。接上还是退役需要一个决定。
- **`app:setLanguage` 没有主进程 handler**。`src/preload/index.ts:605` 与 `src/renderer/stores/settings/index.ts:131`/`:269` 都在调，`src/main/` 下没有任何 `handle`，每次启动都抛一次 `No handler registered for 'app:setLanguage'`。与本主题无关，单独记录。
- **`src/runtime/__tests__/sessionWriterLock.test.ts` 在 CI 上会抖**。2026-09-21 的 `35604442339` 因它变红（「期望 1 个赢家，实际 2 个」），同一份代码在 `35597486859` 是绿的。`28d66abf` 修的正是这个形态，可能没修干净。

---

## 7. 验证状态（2026-09-23）

### 已完成

| 项 | 结果 |
|---|---|
| 单元测试 `appStateMigration.test.ts` + `priorLocalStorageMerge.test.ts` | 40 个用例，39 个通过。唯一失败的是原有的 vault 0600 权限位用例：Windows 没有 POSIX 权限位，这个用例在基线 `a05aaff9` 上同样失败，与本次改动无关 |
| 反向验证（逐个去掉关键逻辑后重跑测试） | 14/14 全部被测试抓到：leveldb 逐文件合并、暂存目录残留、jsonl 存在性检查、大小写、分隔符、`.aiclient` 改写、受旧标记拦截、旧行覆盖新行、覆盖坏索引、仓库/分组不取并集、路径未规范化、普通键被覆盖、并集顺序 |
| `tsc --noEmit` | 本次改动没有新增错误；`src/runtime/host/httpDispatcher.ts` 缺少 `undici` 是本地 node_modules 的原有问题 |
| `biome check`（本次改动的 7 个文件） | 通过 |
| Windows Chromium 机制实测（§3.4） | origin 一致；整目录复制后能读回；应用运行时删除报 EBUSY；`Copy-Item` 嵌套；`WebContentsView` 方案可行，旧目录文件列表不变 |

### 待执行：安装包级别真机验收

本地开发机有加密环境，编译和打包不稳定，所以没有在本地打包。另外本地正在运行同一 appId 的 PiLabAi，直接安装会覆盖它。**以下各项都没有实测**，需要用 CI 的 workflow_dispatch 产物在干净的 Windows 机器上执行：

- 场景 A（v0.3.4 → 本分支）：侧栏出现原来的仓库；不要求重新登录；`%APPDATA%\jyw-ai-client` 和 `~\.aiclient` 原样保留；重启后不重复、不丢失。
- 场景 B（test.16 布局）：以上各项，另外确认原来的对话出现在列表里，点开能读到内容。
- 已经启动过 test.17 及以后版本的机器：已有标记的情况下，新步骤能补上仓库和对话。
- 需要查看的日志行：`[appState] prior userData: …`、`[appState] prior local storage: …`（只包含计数）。

### 未决 / 已知限制

- **旧 identity 指向的目录可能已经不存在**：本开发机的旧 `session-index.json` 有 42 行指向 `~\.pilab\jyw-ai-client\…`，但这个目录在本机上已经不存在（对应的 jsonl 去向不明）。这类行按规则保留原值，会出现在列表里，但点开读不到内容。测试者机器上这个目录是存在的（§1），不受影响。
- **旧 index 里有 13 行的 `runtimeIdentity` 是 UUID**（旧 Claude/Codex 运行时），不是路径，按设计不改写。
- **用户在新版里删掉的仓库**，如果旧库里还有，会在按键合并时被补回来一次（只发生一次，之后有标记）。
- `flushStorageData()` 只是发起落盘请求，不会等写完。写入标记后如果立刻崩溃，理论上可能丢失这一次的合并结果，窗口期是毫秒级。
