# E3 — SDK 会话在 HOME 完全重定向下的可用性

D47 S0 抵触验证 · §10 R2（load-bearing 前提）

## 结论

**premise 成立**：`settingSources: []` 驱动的 SDK 会话，在 `HOME` 指向一个全新空目录（`~/.claude`
完全不可见）、凭证只经由 `$CLAUDE_CONFIG_DIR/settings.json` 显式注入 `options.env` 的条件下，
单轮对话正常完成并拿到 assistant 文本。证据：

```
"ok": true, "sawAssistantText": true, "assistantTextPreview": "2"
"resultRaw": { "subtype": "success", "is_error": false, "duration_ms": 5184, "num_turns": 1 }
```

一次直连成功（未触发沙箱网络限制，未需要 `dangerouslyDisableSandbox` 重跑）。事后 `fakehome`
目录树为空——SDK/CLI 没有在被重定向的假 HOME 下静默创建任何 `.claude` / `.claude.json` /
其他文件，凭证与状态确实完全经 `CLAUDE_CONFIG_DIR` 走，不依赖真实 `HOME`。

## 关键输出摘录（打码）

```json
{
  "route": "e3-sdk-fakehome",
  "ok": true,
  "home": "<scratchpad>/fakehome",
  "claudeConfigDir": "<scratchpad>/confdir",
  "eventCount": 3,
  "eventTypes": ["system", "assistant", "result"],
  "sawAssistantText": true,
  "assistantTextPreview": "2",
  "cliPath": "<repo>/src/agent-host/node_modules/@cometix/claude-code/cli.js",
  "cometixVersion": "2.1.212",
  "resultRaw": { "subtype": "success", "is_error": false, "duration_ms": 5184, "num_turns": 1 }
}
```

Notes 摘录（无 token）：

```
loaded settings.json env keys=ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL
sdk.query export found
starting query cwd=<scratchpad>/ws timeout=45000ms
```

无任何 token 形字符串出现在原始输出中（`options.env` 的值只经 `process.env` 流转，脚本从未把
它们拼进字符串字面量或打印语句）。

## fakehome 事后目录树

```
find fakehome -mindepth 1
```

空，无任何文件被创建（`.claude` / `.claude.json` / 其它均不存在）。

## 复现步骤

```bash
# 1. 用最小 dotenv 解析 dev.env，只写入 confdir/settings.json（脚本内部完成，从不打印原值）
python3 seed_settings.py   # 读 dev.env，写 confdir/settings.json { env: { ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL } }

# 2. echo -n "" > ws/README.md 之类占位即可，ws/ 只需存在

# 3. 运行 SDK 驱动脚本，HOME 与 CLAUDE_CONFIG_DIR 均在子进程启动前设定
HOME=<scratchpad>/fakehome CLAUDE_CONFIG_DIR=<scratchpad>/confdir \
  node --experimental-strip-types e3-sdk-fakehome.ts

# 脚本内部：
#   - require.resolve('@cometix/claude-code/package.json', { paths: [HOST_ROOT] }) 解析 cli.js
#   - require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [HOST_ROOT] }) 解析 SDK
#   - 读取 confdir/settings.json 的 env 块，合并进 options.env（settingSources: [] 关闭 CLI 自读）
#   - query({ prompt: '回答 1+1=? 只回数字', options: { cwd: ws, settingSources: [], env: mergedEnv, ... } })

# 4. 事后快照
find <scratchpad>/fakehome -mindepth 1
```

## CLI/SDK 版本

- Cometix (`@cometix/claude-code`) CLI: **2.1.212**（`resolveCometixCli()` pin 一致，`node cli.js --version` → `2.1.212 (Claude Code)`）
- `@anthropic-ai/claude-agent-sdk`: **0.3.218**（`src/agent-host/pin.ts` 的 `CLAUDE_AGENT_SDK_PIN_VERSION`，与 `src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/package.json` 一致）
- Node: v24.18.0，`--experimental-strip-types` 直接跑 `.ts`
