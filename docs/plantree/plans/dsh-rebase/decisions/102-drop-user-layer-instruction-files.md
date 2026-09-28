# 决策 102：DSH 版不再读取用户层指令文件（`~/.pilab/AGENTS.md`、`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`）（需用户拍板）

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-3、§5；
- [P1-10 / P1-16 分片 01 §2](../topics/p1-10-p1-16-extensions/01-assets.md)、[分片 03 §2.1](../topics/p1-10-p1-16-extensions/03-design.md)；
- `dsh-agent-instructions/lib/index.js:141`。

修订：取消 P1-10 / P1-16 方案 §4.1 里「用户层指令：对接（小插件 `aiclient-instructions`）」这一行。

## 规则

1. **不再读 1.0.x 的用户层指令**：按 `~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md` 的顺序取第一个存在的（`runtime/plugins/prompt/projectInstructions.ts:95-117`）。原计划的 `aiclient-instructions` 小插件不写。
2. **DSH 的用户全局指令只有一个文件**（`dsh-agent-instructions/lib/index.js:141`）。按[决策 101](101-instructions-and-skills-dsh-native.md)，它是 `<agentDir>/AGENTS.md`。
3. **提示**：检测到上面三个文件里有存在的，由[决策 104](104-legacy-asset-notice-and-extension-pages.md) 的旧资产提示告诉用户：「这些文件在新版里不再生效；需要的规则请放进 `<agentDir>/AGENTS.md`」，并给出打开目录的入口。
4. **文件不动**，回装 1.0.x 照常生效。

## 取舍

- **保留**（写 `aiclient-instructions`）：
  - 约 120 行加测试（约 2 人日）；
  - 要自己处理注入位置、单独的 32 KiB 预算、`</system-reminder>` 转义、回放；
  - 是纯为与 1.0.x 一致的自研。
- **用户看得见的不同**：在 Claude Code、Codex 里写过全局规则、并靠 1.0.x 顺带读到的用户，切到 DSH 版后这些规则不再生效，直到自己搬进 `<agentDir>/AGENTS.md`。
- 这次没有读任何真实用户目录，不知道有多少人依赖这一点。开发者用户里 `~/.claude/CLAUDE.md` 可能不少，所以请用户拍板。

**如果用户不同意**：按原方案写 `aiclient-instructions`，约 0.5 人周，并补 INS-1 的用户层断言。

## 影响

- **测试**：不新增。INS-1（决策 101）只断言 `<agentDir>/AGENTS.md` 与项目指令。
- **发版说明**：加一条「用户层指令文件不再生效」。
