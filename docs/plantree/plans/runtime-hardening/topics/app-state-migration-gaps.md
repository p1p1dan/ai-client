# 升级后数据不见 — 状态迁移漏掉的三个位置

Role: topic。建立：2026-09-21。**状态：1 项已修，2 项待修，交由 Windows 端执行方处理。**
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
| 1 | `~/.pilab/<名>/` | 会话 jsonl、`settings.json`、`credentials/vault.json` | 搬，但**名单写错**（已修） |
| 2 | `<appData>/<名>/Local Storage/` | **项目 / 仓库列表** | **不搬** |
| 3 | `<appData>/<名>/session-index.json` | **对话列表** | **不搬** |

---

## 3. 逐条根因

### 3.1 目录名写错 —— 已修（`d4b9445e`）

`PRIOR_USER_DATA_DIR_NAMES` 填的是 `AiClient`，来源是 `electron-builder.yml` 的 `productName`。但 Electron 的 `app.getName()` 读的是**打包后的 `package.json`**，改名前那份（见 `git show 68dbc732^:package.json`）**没有 `productName` 字段**，于是 `name: jyw-ai-client` 生效。

`AiClient` 这个目录**从未存在过**，迁移一直在找一个不存在的路径。

讽刺的旁证：`src/shared/__tests__/appStateLayout.test.ts` 通篇用 `jyw-ai-client` 当发布版目录名，这份名单是唯一写反的地方。

已加 `[PRIOR-1..4]` 四条守卫，`[PRIOR-1]` 在旧常量下失败（已反向验证）。

### 3.2 `Local Storage` 不搬 —— 待修

项目列表的键是 `aiclient-repositories`，定义在 `src/renderer/App/storage.ts:12`，存在 `window.localStorage`，落盘在 `<userData>/Local Storage/leveldb`。

`migrateAppState` 只搬 `prior.root` 与 `prior.credentialsDir`，从不碰 `<appData>/<名>/Local Storage`。

**⚠️ 实现注意**：不能直接复用 `copyTree`。它是**逐文件**跳过已存在项的，而 leveldb 是一个带 `MANIFEST` / `CURRENT` / `LOG` 的多文件存储 —— 新旧混合会得到一个半合并的坏库，比不复制更糟。这一项必须是**整目录**粒度：**目标目录不存在时才整份复制**，存在就整个跳过。

**为什么 `session-state.json` 里的 `localStorage` 镜像顶不上**：`src/preload/index.ts:677` 暴露了 `sessionStorage.get` / `syncLocalStorage` / `importLocalStorage` 三个桥，但**渲染层没有任何地方调用它们**（全仓搜索零命中）。主进程侧 `LocalSessionManager` 在写，渲染层不读也不写 —— 实测本机 dev profile 的 `session-state.json` 里 `localStorage` 是 **0 个键**，而该 profile 有真实的项目和会话。这个镜像是只写不读的死链路，**它本身也是个待决问题**（接上还是退役）。

### 3.3 `session-index.json` 不搬，且内含绝对路径 —— 待修

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
