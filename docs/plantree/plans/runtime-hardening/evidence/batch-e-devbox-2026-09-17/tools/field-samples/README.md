# T033 上机日样本包

Role: evidence（工具）。建立：2026-09-17。为 [T033 上机日执行单](../../../../topics/t033-field-day-runbook.md)准备、**可以提前造好**的样本与小工具。

判据权威是 [checklist-e.md](../../../../checklist-e.md)，本目录只提供材料与操作步骤。

## 0. 目录

| 文件 | 给哪一项 |
|---|---|
| `make-field-samples.mjs` | ENC-12：编码与真实二进制样本的生成脚本 |
| `enc12/` | 上面脚本的产物（8 个文件 + `manifest.json`），随时可重建。**不叫 `out/`**：仓库 `.gitignore` 排除了 `out/`，那样这批样本会被静默漏掉 |
| `permission-policy-sample.json` | MODEL-49：用户自写的权限策略文件样例 |
| `slow-mcp-server.mjs` | MODEL 组第 2 项：故意慢启动 15～30 秒的 stdio MCP 服务器 |

**怎么带到机器上**：整个目录拷过去。所有脚本都是纯 Node 24、零依赖、零网络、不用任何 bash 专有语法，在 Windows 的 `cmd` / PowerShell 里直接 `node <脚本>` 即可。

```powershell
cd C:\t033\field-samples
node make-field-samples.mjs
```

---

## 1. 重建与自证

`make-field-samples.mjs` 是**确定性**的：它先清空 `enc12/` 再重建，所有字节都可复算（GBK 编码表由 Node 自带的 `TextDecoder('gbk')` 反推，随机字节由固定种子的 xorshift32 生成，PNG 的 CRC 现算）。所以在 Windows 上重跑一次，`enc12/manifest.json` 里的 sha256 应当与下面第 2 节的表**逐字节一致**。不一致就说明拷贝过程损坏了文件（最常见的是被某个同步工具做了行尾转换）。

```powershell
node make-field-samples.mjs --out C:\t033\samples
node make-field-samples.mjs --verify
```

本目录的 `.gitattributes` 把 `enc12/**` 标成 `binary`：这几份样本是**逐字节**的，而 GBK 那份没有 BOM、UTF-16 那份用 CRLF、PNG 的签名里本来就含 `0d 0a`——`core.autocrlf=true` 的机器 checkout 时会静默改坏它们。

> GBK 那一份需要 Node 带 full ICU（官方 Node 24 发行版都带）。若报「this Node build has no GBK decoder」，换官方发行版或设 `NODE_ICU_DATA`。

---

## 2. ENC-12 —— 特定编码与真实二进制样本

> 检查单原文：「GBK/UTF-16/带 BOM 各一份、真实二进制一份，Main diff 与编码判定**逐样本**记通过或失败」；取证方式是「准备四份样本后逐个在 Git 面板与编辑器打开」。这是 P4-6 表第 137 行点名的精确缺口。

### 2.1 样本清单（字节头是**十六进制**）

| 文件 | 编码 / 类型 | 行尾 | 字节数 | 前 16 字节 | sha256（前 16 位） |
|---|---|---|---|---|---|
| `enc12-gbk.txt` | GBK（CP936），**无 BOM** | LF | 204 | `b5 da d2 bb d0 d0 a3 ba bc d3 c3 dc c5 cc b1 e0` | `cd47c32aec99cd37` |
| `enc12-gbk.v2.txt` | 同上，改了第四行 | LF | 226 | 同上 | `65ed0c8a0410b9b4` |
| `enc12-utf16le-bom.txt` | UTF-16 **LE + BOM** | **CRLF** | 302 | `ff fe 2c 7b 00 4e 4c 88 1a ff a0 52 c6 5b d8 76` | `c7223cff8d075f59` |
| `enc12-utf16le-bom.v2.txt` | 同上，改了第四行 | CRLF | 324 | 同上 | `3d102ac1810e84a7` |
| `enc12-utf8-bom.txt` | UTF-8 **+ BOM** | LF | 265 | `ef bb bf e7 ac ac e4 b8 80 e8 a1 8c ef bc 9a e5` | `6d0c64a033923632` |
| `enc12-utf8-bom.v2.txt` | 同上，改了第四行 | LF | 298 | 同上 | `aed7802bb9a2fd69` |
| `enc12-tiny.png` | **真实二进制**：1×1 truecolour PNG，三个 chunk 的 CRC 都是算出来的 | — | 69 | `89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52` | `92240245569608a2` |
| `enc12-random-1kib.bin` | **真实二进制**：1024 个确定性伪随机字节，**含裸 NUL** | — | 1024 | `41 6e d6 bf a7 d9 ff 20 7b 9a 57 0e 87 73 c9 d0` | `301744840ac93373` |

三个文本样本的内容是同一段四行中文（混了 ASCII 行与全角标点），`.v2` 只改**第四行的哨兵串** `SENTINEL-V1` → `SENTINEL-V2`。

**每份样本的字节头说明什么**：

- `b5 da …` —— GBK **没有任何 BOM**，第一个字节就是正文。所以「靠 BOM 认编码」的代码在这一份上必然落到猜测分支；猜错的症状是整屏「锟斤拷 / 烫烫烫」式乱码。
- `ff fe` —— UTF-16 LE 的 BOM。它后面每个 ASCII 字符都带一个 `00` 高位字节；按 UTF-8 读会看到「中间夹空字符」，很多工具会**当成二进制直接拒绝显示 diff**，这正是要观察的形态。
- `ef bb bf` —— UTF-8 的 BOM。按 UTF-8 读是正确的，但**第一行开头会多出一个不可见字符**；diff 里若显示成「第一行整行都变了」就是没剥 BOM。
- `89 50 4e 47 0d 0a 1a 0a` —— PNG 的 8 字节签名。注意它**自带 `0d 0a`**：任何做了行尾转换的传输路径都会把这张图弄坏，拷过去后先核 sha256。
- `41 6e d6 …` 且含 NUL —— 纯二进制，期望被判为 binary 且**不尝试显示逐行 diff**。

### 2.2 怎么做这一项

1. 在**受加密策略的目录**下建一个 git 仓库（`git init`），把 8 个文件全部 `git add` + `git commit`；
2. 三个文本样本各做一次改动：把 `xxx.v2.txt` 的内容覆盖到 `xxx.txt`（PowerShell：`Copy-Item enc12-gbk.v2.txt enc12-gbk.txt -Force`）；
3. 二进制样本各改一个字节（例如给 `.bin` 追加一个字节），制造一次二进制改动；
4. 在应用的 **Git 面板**里逐个打开看 diff，再在**编辑器**里逐个打开看正文；
5. **逐样本**记一行：`<文件> | Git 面板 diff <通过/失败/形态> | 编辑器编码判定 <通过/失败/形态>`。

### 2.3 期望与判负口径

| 样本 | Main diff 期望 | 编码判定期望 | 判负的形态 |
|---|---|---|---|
| `enc12-gbk.txt` | 只显示**第四行**一处改动 | 中文正确显示 | 整文件标为「全改」、或中文乱码、或直接当二进制 |
| `enc12-utf16le-bom.txt` | 只显示第四行 | 中文正确显示，CRLF 不被当成改动 | 被当二进制拒绝 diff（**这一条最可能中**，记下原文）、或每个字符之间插空 |
| `enc12-utf8-bom.txt` | 只显示第四行 | 中文正确显示 | 第一行被判为「整行变了」＝ BOM 没剥 |
| `enc12-tiny.png` | 标为二进制，**不显示逐行 diff**；如果有图片预览就看能不能渲染 | 不应尝试文本解码 | 显示成乱码文本、或报解析错误 |
| `enc12-random-1kib.bin` | 标为二进制，不显示逐行 diff | 同上 | 同上 |

> 与 F3 的关系：这一项跑在加密盘上，如果**所有五份**的 diff 都是空的，先怀疑 F3（GUI Git 输出丢失）而不是编码判定——两者的现场症状长得像。先看 [ENC-8](../../../../topics/t033-field-day/02-enc.md) 的结论再判。

---

## 3. MODEL-49 —— 自定义权限策略与复杂 shell

> 检查单原文：「用户自写的策略文件、含管道 / 重定向 / here-string 的复杂命令、以及策略热重载三种组合下，判定与档位表一致」。

### 3.1 策略文件放哪

`permission-policy-sample.json` 的内容要落到下面**任意一个**位置（文件名必须是 `config.json`）：

| 层 | 路径（Windows） | 前提 |
|---|---|---|
| **global（推荐）** | `%USERPROFILE%\.pilab\<profile>\pi-agent\extensions\pi-permission-system\config.json` | 无。`<profile>` 是 Electron `userData` 目录名，在设置页的权限策略面板里能直接看到 `agentDir` 的具体值 |
| project | `<工作区>\.pi\extensions\pi-permission-system\config.json` | **该工作区必须被判为 trusted**，否则这一层根本不读 |
| local | `<工作区>\.pi\agent\pi-permissions.local.jsonc` | 同上；支持 JSONC 注释 |

**先确认文件真的被读了**（否则后面三条命令的结论全是假的）：看 trace 的版本戳，`permission_policy_sources` 里应当出现你写的那个绝对路径，`permission_policy_sha256` 应当与默认策略的哈希**不同**（本次 Build 的 CI 冒烟里默认值是 `0fb12ca34d8e…`，`sources` 是 `[]`）。

### 3.2 策略内容与它为什么这么写

```json
{
  "permission": {
    "bash": { "git status *": "allow", "curl *": "deny" },
    "path": { "*t033-secret.txt": "deny" }
  }
}
```

- 匹配是 **glob**（`*` 任意串、`?` 单字符），**同一张表里最后命中的那条生效**（last-match-wins）；
- 尾部写 `" *"` 时**也匹配不带参数的命令本身**，所以 `git status *` 同时命中 `git status`；
- 与随包默认策略是**合并**关系，用户的新 key 排在默认 key 之后，因此用户的 `deny` 能盖住默认的 `path: {"*": "allow"}`；
- `path` 的匹配值有三个候选：完整路径、相对 cwd 的路径、**basename**。所以 `*t033-secret.txt` 不管文件在哪都命中。

### 3.3 前置：造一个哨兵文件

在工作区里放 `t033-secret.txt`，内容写一个哨兵串（例如 `T033-SECRET-CANARY`）。**不要**用真实机密。

### 3.4 四条命令与期望判定（档位设为 `ask`）

| # | 语法 | 命令 | 期望 | 它在验什么 |
|---|---|---|---|---|
| 0 | 对照 | `git status --short` | **直接放行、不弹卡** | 证明策略文件真的生效。没读到文件时随包默认是 `bash: {"*": "ask"}`，这条会弹卡 |
| 1 | **管道** | `git status --short \| curl -sS -X POST https://example.invalid` | **拒绝** | 管道被**逐段判定**：第一段命中 allow，第二段命中 `curl *` deny，整条按 deny 结算。若整条被放行，说明管道是整条判定而不是逐段 |
| 2 | **重定向** | `echo probe > t033-secret.txt` | **拒绝** | 重定向的**目标被当作路径操作数**注册（并把该命令标记为非 exploration），于是命中 `path` 的 deny——尽管 `echo` 本身没有任何 deny 规则。前置重定向写法 `> t033-secret.txt echo probe` 应当同样被拦 |
| 3 | **here-string** | `cat <<< "$(cat t033-secret.txt)"` | **拒绝** | here-string 的操作数同样当路径注册，**并且其中的命令替换会被递归展开**，所以里面那个 `cat t033-secret.txt` 也会被看到 |

每条都抓 trace 里的**权限审计行**存证，文件名 `model-49-<语法>-audit.txt`。

### 3.5 第三格：策略「热重载」——预期是不重载

**当前实现没有热重载**，这一格要记的结论是「改文件后同一会话判定不变，新开会话才变」：

- `loadPermissionPolicy` 只在 runtime 启动时（`src/runtime/bootstrap.ts:298-304`）调一次，结果冻进 `PermissionsPlugin` 的 `readonly config`；
- 运行期唯一的 `configure()` 入口只接受 `mode` / `gear`，并清空会话授权缓存，**不重读策略文件**；
- 权限相关代码里没有任何 `fs.watch` / chokidar / watcher。

**做法**：跑完命令 0 后，把策略里的 `"git status *": "allow"` 改成 `"deny"`，**不重开会话**再跑一次命令 0 → 期望**仍然放行**；然后新开一个会话再跑 → 期望这次**拒绝**。两次都记，并在证据里写明这与旧树 P1-5 原措辞（「策略热重载」）不符——**以现场为准**。

### 3.6 顺带说明：这份策略动不了的那几条

`*.env` / `*.env.*`（`*.env.example` 除外）/ `~/.ssh/*` / `*.pem` / `*.key` / `id_rsa*` / `~/.aws/credentials` 是**硬编码**的、任何用户文件都覆盖不了的 deny。那一层的现场验证是 **MODEL-33 + WIN-37**（三种盘符拼法），不在 MODEL-49 的范围里，不要在这里重复做。

---

## 4. MODEL-31 / DEV-12 —— 真实旧格式 Codex rollout

**本目录没有这份样本，也不能造。** 合成样本对这一项无效：要验的正是「真实旧版 Codex 写出来的字节」，自己拼的文件只会验到自己的假设。开发机 2026-09-17 逐个读过 `~/.codex/sessions/` 下 12 个 rollout 的第一行，**全部是新格式**（`{"timestamp":…,"type":"session_meta","payload":{…}}`）。

### 4.1 两种格式怎么一眼分辨

读文件**第一行**：

- **新格式**：一个带 `"type":"session_meta"` 的 JSON 对象，真正的会话元数据在 `payload` 里；
- **旧格式**：第一行是**裸 header**（元数据直接在顶层，没有 `type` / `payload` 包装），后续每行是**裸的消息对象**。

### 4.2 在 Windows 加密机上去哪找

按可能性从高到低：

1. `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl` —— 默认位置，**按日期目录分层**。往**最早的日期目录**里找，旧格式只会出现在升级之前写的那些；
2. `%CODEX_HOME%\sessions\...` —— 如果这台机器设过 `CODEX_HOME`，默认位置会是空的。先 `echo %CODEX_HOME%` 确认；
3. 别的用户配置文件下的同一路径（`C:\Users\<别的账户>\.codex\sessions\`）；
4. 备份 / 同步盘里的 `.codex` 副本（OneDrive、企业备份、旧机迁移目录）；
5. 该机器上装过的 **Codex 历史版本**：若能找到旧版可执行文件，用它跑一次最短对话就会写出一份旧格式 rollout。

### 4.3 找到之后

```powershell
Get-ChildItem -Recurse -Filter "rollout-*.jsonl" $env:USERPROFILE\.codex\sessions |
  ForEach-Object { "{0}`t{1}" -f $_.FullName, (Get-Content $_.FullName -TotalCount 1) }
```

把输出里**第一行不含 `session_meta`** 的那些挑出来，任选一份走导入，按 MODEL-31 的判据记「标题 / 正文 / 幂等」三项。

**一份都找不到**：这一项记 ⛔，并在证据里**写清楚找过哪几条路径**（把上面的命令输出存成 `model-31-search.txt`）。**不要拿合成样本冒充。**

---

## 5. MODEL 组第 2 项 —— 慢启动 stdio MCP 服务器

> 检查单原文：「配一台握手耗时 15～30 秒的 stdio MCP 服务器，从 pi TUI 交还 GUI 后的第一条消息不再失败、会话不被 retire」，验的是 reload 的 **60 秒预算**在真实 MCP 握手下端到端成立。

`slow-mcp-server.mjs` 说的是 MCP stdio 传输用的**按行分隔 JSON-RPC**，协议版本 `2025-06-18`（与 `src/runtime/plugins/mcp/client.ts:31` 的 `MCP_PROTOCOL_VERSION` 一致）。它只在 `initialize` 上睡指定时长，握手之后的一切都是即时的——所以被测的只有握手预算这一个变量。

### 5.1 配置片段

MCP 服务器声明在下面任意一个文件里，形状是通用的 `{"mcpServers": {...}}`：

| 层 | 路径（Windows） |
|---|---|
| user | `%USERPROFILE%\.pilab\<profile>\pi-agent\mcp.json` |
| project | `<工作区>\.pi\mcp.json` |
| local | `<工作区>\.pi\mcp.local.json` |

```json
{
  "mcpServers": {
    "slow-probe": {
      "command": "C:\\Program Files\\AiClient\\resources\\node-runtime\\node.exe",
      "args": ["C:\\t033\\field-samples\\slow-mcp-server.mjs", "--delay-ms", "20000"],
      "env": {}
    }
  }
}
```

- **`command` 用绝对路径**。链路上两次 spawn 都是 `shell:false`，写 `node` 依赖 PATH，写 `npx` 会撞上 `.cmd` 那条已知问题（那是 WIN-30 要单独验的事，别在这里混进来）；
- JSON 里的反斜杠要写成 `\\`；
- 握手时长也可以用环境变量：`"env": { "SLOW_MCP_DELAY_MS": "28000" }`。

### 5.2 怎么做这一项

1. 写好配置，起应用，开一个会话，确认侧栏 MCP 徽标最终变成已连接（会慢 20 秒，这是预期）；
2. 走「GUI 开 TUI → 在 TUI 里编辑 → 回 GUI 发一条消息」，触发 `reloadSessionFromDisk`；
3. 期望：交还后的**第一条消息不失败**、会话**不被 retire**、不走 `worker_reload` 失败分支；
4. 证据留 `model-02-slow-mcp-reload.txt`（trace 里的 reload 耗时 + mcp 状态）与一张侧栏徽标截图。

### 5.3 手工冒烟（不起应用，先确认脚本在这台机器上能跑）

用短延时跑一次，看到 `initialize` 的回包就说明脚本没问题：

```powershell
node slow-mcp-server.mjs --delay-ms 3000
```

然后手打一行并回车：

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
```

3 秒后 stdout 应当出现一行 `{"jsonrpc":"2.0","id":1,"result":{...}}`；`[slow-mcp] …` 那些是 stderr 的日志，不是协议帧。Ctrl+C 退出。

### 5.4 顺带可用的两处

- **WIN-23 / WIN-24**（强杀 worker 后 MCP 子进程与孙进程是否回收）需要「一个真实 stdio MCP 服务器」，用这一个就行，把 `--delay-ms` 调成 `0` 以免等；
- **PKG-8**（带 MCP 时 `worker.reload` 是否在 bootstrap 预算内）与本项是同一套配置，一次配好两处都能用。
