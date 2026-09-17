# DEV-36 — cutover-03：native 下「能力」面板与插件页文案（真机，dev-E2）

## 一、侧栏「能力」面板（rail `[aria-label="能力"]`，实现 `LeftDock.tsx:428-520`）

两个时点各截一次，同一条会话 `session-1789655267185-g85qdok`。

### ① 会话未启动（无 worker）— 「未报告」态

```
能力
这个对话启用的 MCP 服务、技能与子智能体。
发送一条消息启动这个对话后，才能看到它启用了什么。
```

一行数字都没有，用整句话说明「还没人回答过」。截图 `dev-36-01-capabilities-not-reported.png`。

### ② 已跑过一回合 — 「报零」态

```
能力
这个对话启用的 MCP 服务、技能与子智能体。
MCP 服务      暂无 MCP 服务器
技能          6
提示词模板     0
子智能体       4
你安装的 pi 扩展只会被内嵌终端加载。
```

截图 `dev-36-02-capabilities-reported.png`。

**两态可区分 ✅**：未报告是一句话、没有任何行；报零是真的把行列出来，
MCP 那行写「暂无 MCP 服务器」（producer 跑过、确实没有），提示词模板那行是数字 `0`。
另外还有第三档 `t('Not reported')`＝「未上报」（某一类完全没有 producer 时才出），
本机四行都有 producer，所以这一档没触发。

> 用词注记：判据写的是「未报告」，实现里的字典键 `'Not reported'` 译文是「**未上报**」
> （`i18n.ts:2361`）。指的是同一件事，字面不同。

列的确实是 native runtime 自己报的东西（技能 6 / 子智能体 4 来自本会话工作目录），
不是 pi 扩展列表 —— cutover-03 要的就是这一条。

## 二、设置 → Pi → 插件页的权限归属文案（`PiPluginsSettings.tsx:245-270`）

界面原文（DOM 逐字）：

```
插件
装在你账户下的扩展。只有内嵌的 Pi 终端会加载它们，本应用里的对话不会。
本应用的每个对话，都由它自带的权限系统审批工具调用。
安装
暂无已安装插件
按包名装一个，给会话加上工具或命令。
设置文件  /home/ai/.pilab/jyw-ai-client-dev/pi-agent/settings.json
```

截图 `dev-36-03-plugin-page-permission-notice.png`，DOM 原文
`dev-36-plugin-section-text.txt` / `dev-36-plugin-page-permission-notice.json`。

对判据「本应用自带权限系统审批每个对话，你装的 pi 权限扩展只影响内嵌终端」：

- 前半句 ✅ ——「本应用的每个对话，都由它自带的权限系统审批工具调用。」
  （info 色卡，`border-info/30 bg-info/10 text-info`，无条件显示）
- 后半句 **在本机不显示，但这是设计内的条件分支**：那句
  「你自己安装的 pi 权限系统只对内嵌终端生效，管不到本应用里的对话。」
  只在 `owner === 'user_configured' | 'unknown'` 时才渲染（`PiPluginsSettings.tsx:255`），
  而本机「暂无已安装插件」，所以 owner 不是这两档。
  同一页顶上的分区说明「装在你账户下的扩展。只有内嵌的 Pi 终端会加载它们，
  本应用里的对话不会。」已经把「pi 扩展只影响内嵌终端」这层意思无条件讲了一遍。
  **要看到判据字面那句，必须先装一个 pi 权限扩展**——见本页「判据问题」。
