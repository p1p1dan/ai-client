# 证据：决策 190 的抓包、真宿主用例与录制门禁对照（2026-10-14）

Role: evidence。对应[决策 190](../../decisions/190-tool-gaps-web-fetch-grep-max-tokens.md)。机器：Windows 10 Pro 19043，Node 24.12.0（本机 `node`，没有 `out-node-runtime`）。基线是 main `79f81cdb`。

只记形状数据，不含提示词正文；抓包原件留在系统临时目录，没有入库。

## 1 抓包：四种开关组合

脚本：[scripts/capture-tool-gaps.ts](scripts/capture-tool-gaps.ts)，从调研分支 `docs/quality-gap-study` 的 `capture-pilab-request.ts` 改出：

- 一个源码宿主、本机假网关（`--capture`）、随包 Claude 路由，外加一个用户自加的 Anthropic 路由：推理与自适应思考开着，没写窗口和输出上限；
- 两个开关照 Main 的方式转发给宿主，第三个开关决定计划的模式；
- 每条路由一轮，打印每个请求的形状。

运行：

```bash
node docs/plantree/plans/dsh-rebase/evidence/tool-gaps-2026-10-14/scripts/capture-tool-gaps.ts
```

结果（每种组合两条请求，工具与系统提示两条相同，只列一次）：

| 组合 | 宿主日志 | 工具数 | grep | web_fetch | 系统提示 | 工具说明合计 | 用户路由 `max_tokens` |
|---|---|---|---|---|---|---|---|
| 默认（全开） | `web_fetch on, grep rich` | 24 | 728 字符，13 个参数 | 74 字符，`url` | 2,511 | 7,617 | 32,000 |
| `RICH_GREP=0` | `web_fetch on, grep dsh` | 24 | 206 字符，`pattern,path,include` | 有 | 2,425 | 7,095 | 32,000 |
| `WEB_FETCH=0` | `web_fetch off, grep rich` | 23 | 728 字符，13 个参数 | 无 | 2,359 | 7,543 | 32,000 |
| 三个都为 `0` | `web_fetch off, grep dsh` | 23 | 206 字符，`pattern,path,include` | 无 | 2,273 | 7,021 | 8,192 |

- 全关的一行与调研的抓包（`request-shapes.txt`）逐项相同：23 个工具、说明合计 7,021、系统提示 2,273。
- 随包 Claude 路由两种模式都是 128,000，托管目录写了输出上限，不受第三个开关影响。
- grep 的 13 个参数：`pattern, path, glob, type, output_mode, -A, -B, -C, -n, -i, multiline, head_limit, offset`。
- 没有 `web_search`。

## 2 真宿主用例

```bash
AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run src/dsh-host/__tests__/toolGaps.integration.test.ts
```

本机 2 例通过（约 4 秒）。假网关脚本 `P1-TOOLGAPS` 依次调用：content 模式加 `-C 1` 的 grep、`-i` 的文件列表 grep、`web_fetch`。会话在 `ask` 档。

- [190-I-1] 默认组合：
  - grep 输出 ripgrep 原样格式与上下文行；
  - `.env` 里的匹配被权限行滤掉，只剩 `notes.md`；
  - 只有 `web_fetch` 弹卡：动作 `fetch_url`，正文是 URL，会话授权范围是主机 `example.com`；答拒绝，请求没有发出。
- [190-I-2] 两个宿主开关都为 `0`：
  - DSH 自己的 grep（`Found 1 match` 的格式，`-C`、`-i` 不起作用，不搜隐藏文件）；
  - 模型拿不到 `web_fetch`。假网关仍硬发一次调用：闸门照样弹卡（按名字判，在 DSH 判定工具不存在之前），允许后 DSH 报 `unknown tool "web_fetch"`。

## 3 录制门禁（`bridge-record.ts --check`）

- Windows 上基线与本分支都通不过，原因与本次改动无关：
  - `--import` 传了 Windows 盘符路径（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。本次改为传 file URL，Linux 上等价；
  - 改完后能录到 job-notice 之前的 11 个场景，job-notice 需要 bash，停在那里；
  - 其余差异来自平台：会话路径用反斜杠、Windows 上没有 bash 工具、本机 skills。
- 对照方法：同一台机器、同样的改动（只改 `--import`），基线 `79f81cdb` 与本分支各跑一次 `--check`，再单独跑 `--only perm-search`。
  - 本分支的录制与基线相比，只多了两类差异：
    1. 每个 `log.*` 的 `request/header` 工具列表多了 `web_fetch`；
    2. `perm-search` 场景的 grep 结果：DSH 的 `Found 1 match …Line 1: …` 变成 `Found 1 file\n\nnotes.txt`，日志里那条 `tool/result` 不再带 DSH grep 的 `meta`。
  - 金样本按这两类改了（36 个 `log.*.json` 共 44 个工具列表，`perm-search` 的 `stream`、`rpc`、`log` 三份）。
  - 改完以后，本分支 `--check` 的差异清单与基线逐字相同（全量 638 行、`perm-search` 63 行）。
- `stream.*` 与 `rpc.*` 中，除 `perm-search` 外没有任何变化。
- 未在 Linux 上复核。预期 Linux 的 `--check` 没有差异。
- `bridge-smoke.ts` 读 `/proc`，只能在 Linux 上跑；本机没有跑。
