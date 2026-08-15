# E2 — `.claude.json` 的 onboarding/trust 状态是否从 `$CLAUDE_CONFIG_DIR` 生效

D47 S0 抵触验证 · §10 R1

## 结论

**premise 成立**：`claude` CLI 确实从 `$CLAUDE_CONFIG_DIR/.claude.json` 读取
`hasCompletedOnboarding` 与 `projects[<workspace>].hasTrustDialogAccepted`（而非真实 `HOME`），
即使 `HOME` 被完全重定向到一个空目录。两臂对照证据：

- **臂 (a)**（confdir 只有 `settings.json`，无 `.claude.json`）：交互式 PTY 首屏命中主题选择向导
  ——`Choose the text style that looks best with your terminal` / `1. Auto (match terminal)` 等，
  关键词命中 `Choose` ×1、`theme` ×2。说明"未完成 onboarding"确实会在首次运行时卡在向导。
- **臂 (b)**（写入 `confdir/.claude.json` = `hasCompletedOnboarding: true` +
  `projects["<ws 绝对路径>"].hasTrustDialogAccepted: true`）：同样的 PTY 启动，首屏直接进入 REPL
  提示符（`Welcome back!` / `❯` 输入框 / `manual mode on`），`trust`/`Do you trust`/`theme`/
  `Choose` 四个关键词**零命中**。

两臂除 `confdir/.claude.json` 是否存在外，`HOME`/`CLAUDE_CONFIG_DIR`/`ws` 完全相同，因此差异可
归因于 `.claude.json` 的 onboarding/trust 字段，而它只能来自 `$CLAUDE_CONFIG_DIR`（`HOME` 全程
是空目录，没有 `~/.claude`）。

## 关键输出摘录（打码）

臂 (a)（命中向导，节选，ANSI 已清洗）：

```
Welcome to Claude Code v2.1.212
Let's get started.
Choose the text style that looks best with your terminal
To change this later, run /theme
1. Auto (match terminal)
❯2. Dark mode✔
...
```

关键词命中：`Choose` ×1、`theme` ×2；`trust`/`Do you trust` 未出现。

臂 (b)（直入 REPL，节选，ANSI 已清洗）：

```
✳ Claude Code
Welcome back! │ Run /init to create a CLAUD…
...
❯
⏸ manual mode on · ? for shortcuts ● high · /effort
```

关键词命中：`trust`/`Do you trust`/`theme`/`Choose` 均 **0**。

两臂 `script -qec "timeout 25 node cli.js" capture.txt` 的退出码均为 124（timeout 到期后正常
终止交互式 REPL/向导，非崩溃）；`ps aux | grep cli.js` 确认进程已消失，无需额外 kill。

未发现任何 token 形字符串（`sk-` 前缀 / `ANTHROPIC_AUTH_TOKEN=`/`ANTHROPIC_API_KEY=` 紧跟真实值）
出现在两份原始 capture 中——扫描结果为空。

## fakehome 事后目录树

臂(a)+臂(b) 累计后：

```
find fakehome -mindepth 1
fakehome/.npm/...(auto-update 相关缓存与日志，仅臂(b)阶段出现)
```

**没有** `.claude` / `.claude.json` 出现在 fakehome 下——onboarding/trust 状态确认只写入
`CLAUDE_CONFIG_DIR`，未污染真实 `HOME` 语义位置。但需要留意一个旁支副作用：臂 (b) 进入 REPL 后
CLI 触发了自动更新检查（`Auto-updating…` → `Auto-update failed · Try claude doctor or npm i -g
@cometix/claude-code`），这个动作在 `$HOME/.npm` 下留了 npm 缓存/日志文件（与 onboarding/trust
本身无关，是 npm 客户端的默认缓存位置读取了重定向后的 `HOME`）。对全量迁移方案是一个需要额外确认
的旁支问题（是否要屏蔽/重定向自动更新），但不影响本次 R1 premise 的结论。

## 复现步骤

```bash
# 公共设置（两臂相同）
export HOME=<scratchpad>/fakehome
export CLAUDE_CONFIG_DIR=<scratchpad>/confdir
cd <scratchpad>/ws

# 臂 (a)：confdir 只有 settings.json，无 .claude.json
script -qec "timeout 25 node <repo>/src/agent-host/node_modules/@cometix/claude-code/cli.js" arm-a-capture.txt

# 写入 confdir/.claude.json
python3 -c "
import json
config = {
    'hasCompletedOnboarding': True,
    'projects': { '<ws 绝对路径>': { 'hasTrustDialogAccepted': True } },
}
json.dump(config, open('<scratchpad>/confdir/.claude.json', 'w'), indent=2)
"

# 臂 (b)：重跑同一条 PTY 命令
script -qec "timeout 25 node <repo>/src/agent-host/node_modules/@cometix/claude-code/cli.js" arm-b-capture.txt

# 关键词扫描（ANSI 清洗后）
grep -io "trust\|do you trust\|theme\|choose" arm-a-clean.txt
grep -io "trust\|do you trust\|theme\|choose" arm-b-clean.txt

# 进程确认
ps aux | grep cli.js
```

## CLI/SDK 版本

- Cometix (`@cometix/claude-code`) CLI: **2.1.212**（`node cli.js --version` → `2.1.212 (Claude Code)`）
