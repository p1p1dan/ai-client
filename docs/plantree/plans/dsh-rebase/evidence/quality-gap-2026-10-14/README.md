# 证据：同源同模型下 PiLab 与 Claude Code 的请求对照与本机会话统计（2026-10-14）

Role: evidence（指定版本的事实，不滚动更新）。结论与方案见[调研档](../../../../../plans/2026-10-14-pilab-vs-claude-code-gap-study.md)。

- 代码：main `79f81cdb`（`1.1.1-test.1`），DSH `0.1.7-rc.2`，pi-ai `0.85.1`。
- 对照：Claude Code `2.1.295`（本机 Claude 桌面版自带的 `claude.exe`）。
- 机器：Windows 10 Pro 19043，Node 24.12。
- 所有模型请求都只发到本机假网关（`src/dsh-host/tools/fake-gateway.mjs --capture`），没有调用任何真实模型。

## 1 请求抓包

| 脚本 | 做什么 |
|---|---|
| `scripts/capture-pilab-request.ts` | 用源码起一台真实 DSH 宿主，按随包目录建 Claude（anthropic-messages）与 GLM（openai-completions）两条路由，各发一轮，抓下宿主发出的请求体 |
| `scripts/capture-claude-code-request.sh` | 用本机安装的 Claude Code 以 `-p` 无头运行，配置目录、HOME、API key 全部是临时的，抓下它发出的请求体 |
| `scripts/compare-captures.mjs` | 只打印请求的形状：参数、beta 头、系统提示词与工具的字符数、每个工具的说明长度与参数名，**不打印任何提示词正文** |
| `scripts/t1-pilab-real-gateway.ts`、`scripts/t1-claude-code-real-gateway.sh` | 调研档 §6 的 T1 探针：同一句极小提示词，分别以 PiLab 与 Claude Code 的原样经**真实网关**发 N 次，输出每次的计费提示词 token。URL 与 key 只从 `T1_BASE_URL`、`T1_API_KEY` 读取；两个脚本已对本机假网关自测通过，尚未连真实网关 |

两边用同一个工作区（一个 git 仓库，内含 `CLAUDE.md` 与 `src/index.ts`），模型都是 `claude-opus-5-5`，档位都是 `high`。比对输出见 [`request-shapes.txt`](request-shapes.txt)。

抓包得到的请求体含 Claude Code 的提示词原文（Anthropic 版权所有），只留在临时目录，不入库。

复现：

```bash
(cd src/dsh-host && npm ci --ignore-scripts --no-audit --no-fund)
node docs/plantree/plans/dsh-rebase/evidence/quality-gap-2026-10-14/scripts/capture-pilab-request.ts --effort high
bash docs/plantree/plans/dsh-rebase/evidence/quality-gap-2026-10-14/scripts/capture-claude-code-request.sh "$CLAUDE_CODE_EXECPATH" high claude-opus-5-5
node docs/plantree/plans/dsh-rebase/evidence/quality-gap-2026-10-14/scripts/compare-captures.mjs <PiLab 的 1.json> <Claude Code 的 1.json>
```

## 2 本机真实会话统计

数据来自本机 `~/.pilab/PiLabAi/dsh-home/sessions` 下 6 个会话日志（2026-10-06～10-14，`session.v4.jsonl.zstd`）。脚本只统计数字和错误类别，不输出对话内容：

| 脚本 | 做什么 |
|---|---|
| `scripts/readlog.mjs` | 逐帧解压 DSH v4 会话日志（多个 zstd 帧拼接） |
| `scripts/stats.mjs` | 每个会话的模型、档位、步数、各工具调用次数、未知工具、用量 |
| `scripts/errs.mjs` | 工具失败分类、shell 非零退出、输出里的乱码字符 |
| `scripts/residual.mjs` | 每一步计费提示词 token 与我方实际发送量（估算）的差 |

### 2.1 概况

- 6 个会话：Claude Opus 5.5 3 个（经公司网关），GLM 5.3 4 个（经智谱官方 OpenAI 兼容端点；其中一个会话两种模型都用过）。
- 档位：Claude 会话为 `xhigh` / `high`；GLM 为 `high` / `medium`。
- 工具调用共 418 次：`pwsh` 191、`edit` 78、`read` 75、`grep` 28、`write` 14、`job_output` 11、`todo_write` 7、`ask_user_question` 5、`bash` 4、其他 5。`glob` 只用了 1 次。
- 未知工具调用：0。
- 工具失败 19 次，其中审批超时（无人应答）5 次、编辑前没读文件 6 次、`old_string` 没匹配上 2 次、PowerShell 语法与命令不识别 3 次。shell 返回 195 次，非零退出 12 次，带乱码字符（U+FFFD）的 11 次。
- 最长上下文：Claude 会话约 32 万 token，GLM 会话约 51 万 token。

### 2.2 思考内容的回放（排除项）

- Claude：每条 assistant 消息的思考块都带签名（852～2,116 字符），回放时原样带回。
- GLM：思考块的回放字段是 `reasoning_content`；智谱端点按 zai 格式发 `thinking: {type: "enabled", clear_thinking: false}`。

两者的多步思考连续性都正常，不是差距来源。

### 2.3 上游提示词被加料

两个 Claude 会话的计费提示词 token（缓存读 + 缓存写 + 输入）与我方实际发送量对照：

| 会话 | 步 | 计费提示词 | 其中缓存读 | 我方发送（估） | 说明 |
|---|---|---|---|---|---|
| A（3 步） | 1 | 20,265 | 10,245 | 约 1.2 万 | 新会话第一步就读到 10,245 的缓存 |
| A | 2 | 45,577 | 32,766 | 约 1.2 万（只多一条 80 字符的工具结果） | 比上一步凭空多出约 2.4 万 token；缓存读大于上一步的整个提示词 |
| A | 3 | 46,087 | 45,575 | 约 1.2 万 | 与第 2 步同一条缓存链 |
| B（106 步） | 95 | — | 32,766 | — | 缓存重建，读到的又正好是 32,766 |
| B | 105 | — | 10,245 | — | 缓存重建，读到的又正好是 10,245 |

- 我方每个请求的固定前缀只有工具 + 系统提示词（约 2.3 万字符，约 0.7～0.8 万 token），之后紧跟每个会话各不相同的用户消息。跨会话能共享的缓存前缀只可能落在这一段里。
- 实测却有两个跨会话复用、长度固定的前缀：10,245 与 32,766 token。后者比我方的固定前缀多出约 2.5 万 token，只能是上游加在我方内容前面的固定内容。
- 同一会话第 1 步与第 2 步之间，提示词多出约 2.4 万 token，我方内容几乎没变，说明这两步落在了不同的上游。
- 这与已有记录一致：
  - issue #2（[决策 164](../../decisions/164-environment-context-and-shell-workdir-precheck.md)）里，模型看到一段供应商套上的 Claude Code 风格提示词，带着错误的环境（`/Users/…/monorepo`、`darwin`、`zsh`）和一组我们没有的工具；
  - GW-16（[决策 146](../../decisions/146-real-gateway-followups.md) 第 26 条）里，我们只发 3 个 `cache_control`，上游却报「超过 4 个」；
  - [决策 173](../../decisions/173-prompt-cache-upstream-split.md) 里，同一会话被分到计数口径、思考摘要、签名版本都不同的两个上游。
- [决策 173](../../decisions/173-prompt-cache-upstream-split.md) §1 对 issue #9 那个 89 步会话的独立分析得出同样的形状：同一份工具定义加系统提示词，上游 α 计 36,848 token，β 计 11,489；α 的回复思考摘要全为空（53/53），并会丢弃旧思考块；α 承接了 89 个请求中的 71 个。本表会话 A 的第 2、3 步思考摘要同样全空，与 α 一致。
- 判定：上游 α 在 PiLab 的请求前注入了约 2.5 万 token 的固定内容，并改变了思考的返回与保留方式。这一节写成时是推断；§3 的 T1 实测已证实改写，并看到了改写的内容。

## 3 T1：真实网关实测（2026-10-14）

- 网关与 key 由用户在对话中单独提供，只通过测试进程的环境变量 `T1_BASE_URL`、`T1_API_KEY` 传入。没有使用本机任何账户信息；测试后检查过，临时目录里没有任何文件含有该 key，临时目录已删除。
- 两边用同一个 key，模型 `claude-opus-5-5`，档位 `low`，每次都是全新会话、同一句「Reply with exactly: OK」。

### 3.1 计费对比

| | PiLab（`t1-pilab-real-gateway.ts`） | Claude Code（`t1-claude-code-real-gateway.sh`） |
|---|---|---|
| 实际发送（本机假网关抓包） | 25,050 字符：system 2,273 + tools 20,882 + messages 1,895 | 66,289 字符：system 5,853 + tools 50,466 + messages 9,970 |
| 计费提示词（10 次） | 39,138～39,144，中位 39,140 | 每次 24,428 |
| 其中缓存读 | 第 1 次就读到 33,547，之后每次 35,055 | 第 1 次 0，之后每次 19,264 |
| 其中缓存写 | 约 4,083 | 5,162（第 1 次 24,426） |

- 按 Claude Code 的「字符 / 计费 token」比例（2.71）换算，PiLab 应计约 9,200 token，实际多出约 3 万。按 3～4 字符 / token 估，Claude Code 只多出 0.2～0.8 万，在估算误差和服务端固定开销之内。
- PiLab 全新环境里的第一个请求就命中了 33,547 token 的缓存：这段前缀早已被别的流量写进了缓存，不是我们发出的内容。

### 3.2 模型看到了什么（各 1 次，档位 `low`，问题见脚本参数）

| 问题 | 经 PiLab 发出 | 经 Claude Code 发出 |
|---|---|---|
| 列出能调用的全部工具 | 14 个 Claude Code 与 Claude 桌面版的工具（`Agent`、`Artifact`、`AskUserQuestion`、`Bash`、`Edit`、`ListAgents`、`Read`、`ReportFindings`、`ScheduleWakeup`、`SendFeedback`、`ShareOnboardingGuide`、`Skill`、`Workflow`、`Write`），外加 23 个改了名的工具：`mcp__luban__parse_ask00` … `mcp__luban__parse_wri22`。编号 00～22 与 PiLab 的 23 个工具按字母排序一一对应，例如 `query_pws12` 对应 `pwsh`，`render_rea13` 对应 `read`，`search_edi02` 对应 `edit`，`compute_gre06` 对应 `grep` | 正好是它自己声明的 22 个工具，名字不变 |
| 系统提示词第一句 | 「You are Claude Code, Anthropic's official CLI for Claude.」 | Claude Code 自己的第一句（Agent SDK 身份） |
| 身份与环境 | 模型说看到三处身份：Claude Code（系统提示词）、DeepSeek Harness（「用户消息里的一条提醒」，即 PiLab 的系统提示词被挪进了用户消息）、Opus 5.5。<br>两套环境：注入的是 macOS（Darwin 27.0.0）、zsh、`/Users/jordan/Projects/client`；PiLab 的运行时上下文是 Windows、pwsh、真实工作区。<br>模型还指出：说明里写着没有 bash 工具，它却同时看到了 `Bash` 和 PowerShell | — |

### 3.3 判定

**已证实**：经这个网关，PiLab 的 Claude 请求被上游改写成 Claude Code 的样子。具体做了四件事：

1. 换上 Claude Code 的系统提示词，里面带着别人机器上的 macOS 环境；
2. 加入 PiLab 执行不了的 Claude Code 工具；
3. 把 PiLab 自己的工具改成无意义的名字；
4. 把 PiLab 的系统提示词降成用户消息里的一条提醒。

Claude Code 自己的请求原样通过：计费与发送量相符，工具与身份和声明一致。
