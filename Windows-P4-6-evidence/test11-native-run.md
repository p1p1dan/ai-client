# test.11 native 实测记录（真实安装应用）

> 日期：2026-09-09 · 主机：本机（带 TEC OCular 企业加密驱动）
> 应用：`D:\Program Files\AiClient\AiClient.exe`（1.0.0-test.11，CI 34308304362，源码 `b6aa0844`）
> 启动方式：`launch-native.ps1`（在 PowerShell 会话设 `AICLIENT_RUNTIME_BACKEND` 后启动）
> 配套：`native-trace/runs.jsonl`（完整对话 trace）· 会话 JSONL `session-1788934522673-ljd8bc8.jsonl`

## 产物与载体

| 项 | 值 |
|---|---|
| 应用版本 | 1.0.0-test.11（注册表与 exe 一致） |
| 随包 node.exe | `D:\Program Files\AiClient\resources\node-runtime\node.exe`(v24.18.0, PIN 记录) |
| worker.js | `resources\agent-host\worker.js`，含 native 代码；`runtime-helpers/` 在位 |
| native worker 进程 | PID 268904, ExecutablePath=随包 node.exe（cmdline 显式 worker.js） |
| 模型目录 | `C:\Users\JC\.pilab\jyw-ai-client\pi-agent`（models.json + auth.json） |

## native 生效（trace version_stamp，硬证据）

```
backend: "native"
carrier: "bundled-node"
node_source: "bundled"
node_exec_path: "D:\Program Files\AiClient\resources\node-runtime\node.exe"
exec_adapter: "node-runner-pipe-v1"
exec_stdio: "pipe"
tsd_read_fallback: "disabled"
mode: "agent"     permission_gear: "ask"
compaction: true  compaction_family: "summary"
```
（两份 run 的 stamp 均如此；git_commit=unknown 因 bundle 无工作目录，属预期。）

## 功能点验（新建会话，写 test123.txt）

你在 GUI 里让模型写 `test123.txt` 并批准，完整链路：

| 步骤 | trace/JSONL 证据 |
|---|---|
| 模型调用 | model=`glm-5.2`/`china`(openai-completions)，2 次 LLM（toolUse + stop） |
| 工具调用 | `tool_execution_start` → tool=`write`, path=`test123.txt`, args 含中文+英文内容 |
| **权限询问** | `permission_prompt`(phase:prompt, gear:ask) |
| **权限批准** | `permission_decision`(phase:decision, **decision:allow, source:allow-once**) |
| 工具完成 | `tool_execution_end` → "Wrote 49 bytes", is_error=false |
| 落盘 | `E:\Projects\ChipTestMachine\DIEAlgorithm\.worktrees\bmo-m1\test123.txt` 明文内容正确 |
| 会话存储 | JSONL header v4，`custom.aiclient.permissions` 记 `{mode:agent, gear:ask}` |

## 关键结论

1. **native 后端真实生效**，非 legacy。（D8 明确：不能只看"能聊天"；此处由 version_stamp `backend=native` 二次确认。）
2. **随包 Node 载体正确**：worker 用 `resources\node-runtime\node.exe`，`node_source=bundled`，非系统 PATH node，非仅改 carrier 字符串。（D11）
3. **权限审计完整（P4-5 缺口已验证修复）**：`permission_prompt`+`permission_decision` 两相都在，`source=allow-once`，未丢审计行。
4. **D14 两轴正确**：`mode=agent`、`gear=ask` 进入 prompt segments 与权限记录。
5. **工具执行、写盘、UTF-8 明文**均正确。
6. **缓存命中率**：本会话 `cacheRead:0, cacheWrite:0`（2 次调用）。这是 glm-5.2 走 china 网关的原始值，**不代表缓存优化失效**——P2-5 门禁需 P2-0 同套脚本会话测，不在本包验收范围。

## 待现场项（仍需你/CI）

- 旧会话点开报 `Pi worker did not open the requested exact session file`（`chat:resumeSession`）——需单独排查（可能是旧格式/路径归属问题）。
- 命令树清理五态（正常/超时/取消/父先退/应用退出）需专门触发。
- 企业加密专项（受策略目录下的明文读写/bash/一致性/无残留）——普通 Windows 通过不能代签。
- 主线 GUI A～E 清单。
