# ab-eval：PiLab 与 Claude Code 的无头 A/B 评测

同一批编码任务，用 PiLab（本仓库的 DSH 宿主）和 Claude Code 各跑 N 次，输出可对比的结构化记录和 Markdown 报告。用来量化两件事：

- 网关透传修好前后的差距：同一套用例在不同网关上各跑一遍，再用 `report.ts` 合并对比；
- 客户端各项改进（提示词包、工具补齐等）开与关的效果：用变体开关，同一轮里并排对比。

背景见 [2026-10-14 差距调研](../../../../docs/plans/2026-10-14-pilab-vs-claude-code-gap-study.md) §6 T2（文档在 `docs/quality-gap-study` 分支）。工程规范见 [docs/agent-project-engineering.md](../../../../docs/agent-project-engineering.md)。

## 公平性：两边保持一致的东西

| 项 | 做法 |
|---|---|
| 网关、key、模型、档位 | 两边用同一个网关、同一个 key，`--model`、`--effort` 同时传给两边 |
| 审批 | 全自动：PiLab 用 `bypass` 档位；Claude Code 用 `--dangerously-skip-permissions` |
| 仓库 | 每次运行一份干净副本（同一个基准提交），互不影响 |
| 环境 | 每次运行一个临时沙箱：独立的工作区、HOME、临时目录；PiLab 的 `DSH_HOME` 与 agent 目录、Claude Code 的 `CLAUDE_CONFIG_DIR` 都是新建的。环境变量从空白开始，只放 PATH 和系统基本变量（真实网关时再加代理） |
| 预算 | 时间上限与步数上限对两边相同（见「用例格式」的 `budget`） |
| 顺序 | 臂的先后按用例和重复次数轮换，避免谁总是先跑 |

PiLab 侧是真实宿主：`src/dsh-host/host.ts` 经 worker RPC 驱动，和 Main 一样。环境变量用 Main 自己的规则（`buildDshHostEnvironment`），模型计划用产品自己的转换（`buildDshModelPlan`），模型配置取自内置目录里的 Claude 服务。目录里没有的模型（如 `claude-opus-5-5`）按 `claude-opus-5` 那一行复制，记录里的 `client.modelTemplate` 会写明。

## 快速开始

前置条件：

- Node 24（要用 `zlib` 的 zstd 解压，并且直接运行 `.ts`）；
- 在 `src/dsh-host` 里执行过 `npm ci --ignore-scripts`；
- Claude Code：默认依次查 `--claude-bin`、`AB_CLAUDE_BIN`、`CLAUDE_CODE_EXECPATH`，最后找 PATH 上的 `claude`；
- git。Windows 上 Claude Code 还需要 Git Bash：默认在 PATH 里的 `git.exe` 旁边找，也可以用 `--git-bash` 指定。

```bash
node src/dsh-host/tools/ab-eval/selftest.ts
```

自测只连本机假网关，大约两三分钟。它跑的是 PiLab、Claude Code、PiLab+自测变体三个臂，用例是 3 个随附用例再加 4 个自测用例（假模型放弃、步数预算、时间预算、git 来源），然后逐项断言，见「自测验证了什么」。

```bash
node src/dsh-host/tools/ab-eval/run.ts --runs 1
```

这条只对本机假网关跑一遍随附用例，用来检查流程，产出的报告在 `src/dsh-host/tools/ab-eval/out/<运行 id>/report.md`。

### 连真实网关

网关 URL 与 key 只从环境变量读，不写进任何文件：

- `AB_BASE_URL`：网关根地址，不带 `/v1`；
- `AB_API_KEY`。

然后加 `--gateway real`：

```bash
node src/dsh-host/tools/ab-eval/run.ts --gateway real --runs 3 --judge --label rewrite-channel
```

不加 `--gateway real` 时永远只连本机假网关，不会碰真实网关。

## 怎么跑：run.ts 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--gateway fake\|real` | `fake` | `real` 读 `AB_BASE_URL`、`AB_API_KEY` |
| `--runs N` | 3 | 每个「用例 × 臂」重复几次 |
| `--arms a,b,...` | `pilab,claude-code` | 臂：`pilab`、`claude-code`，或 `<客户端>+<变体名>` |
| `--model id` | `claude-opus-5-5` | 两边相同 |
| `--effort level` | `high` | `low` / `medium` / `high` / `xhigh` / `max`，两边相同 |
| `--cases 路径` | `cases/` | 用例文件或目录，可以重复写 |
| `--case id,...` | 全部 | 只跑这几个用例 |
| `--judge` | 关 | 对有 `judge` 的用例做 LLM 评分 |
| `--judge-model id` | 同 `--model` | 评分模型。默认走同一个网关；设了 `AB_JUDGE_BASE_URL`、`AB_JUDGE_API_KEY` 就走那里 |
| `--label 名字` | 网关类型 | 写进运行 id，合并报告时用来区分各轮 |
| `--out 目录` | `out/<运行 id>` | 输出目录（`out/` 已被 git 忽略） |
| `--scratch 目录` | 系统临时目录下的 `ab-eval` | 沙箱放在这里，每次运行结束就删 |
| `--keep-workspaces` | 关 | 保留沙箱，便于排查 |
| `--claude-bin`、`--git-bash` | 自动查找 | 见「快速开始」 |
| `--allow-ancestor-instructions` | 关 | 见「凭据与隔离」 |

退出码：跑完就是 0，不管通过率多少；出错或扫描到密钥是 1。

## 用例格式（`cases/*.json`）

以 [cases/fix-median-sort.json](cases/fix-median-sort.json) 为例：

```jsonc
{
  "id": "fix-median-sort",                    // 唯一，字母数字和 ._-
  "title": "修复让单测失败的 bug：median 按字符串排序",
  "tier": "smoke",                            // smoke / main / incident（规范 §7）
  "tags": ["bugfix"],
  "repo": { "fixture": "../fixtures/stats-median" },   // 相对用例文件
  // 或者：  "repo": { "git": "https://…/repo.git", "commit": "<完整 sha>" }
  "prompt": "运行 `node --test` 会有测试失败……",
  "checks": {
    "commands": [{ "id": "tests", "argv": ["node", "--test"], "expectExit": 0, "timeoutMs": 120000 }],
    "mustChange": ["src/stats.js"],           // 每个 glob 都要命中至少一个改动文件
    "mustNotChange": ["test/**"],             // 改动文件不得命中这些 glob
    "forbidden": [{ "id": "…", "pattern": "正则", "in": "added", "paths": ["src/**"] }],
    "required":  [{ "id": "…", "pattern": "正则", "in": "answer" }],
    "ignore": [],                             // 不计入检查和改动行数的路径
    "overlay": "../fixtures/stats-median-hidden"   // 隐藏的验收文件，跑命令前才复制进去
  },
  "budget": { "timeMs": 600000, "maxSteps": 40 },
  "judge": { "rubric": "满分标准……", "dimensions": ["correctness", "minimality"] },
  "fakeModel": { "steps": [ … ], "expect": { … } }   // 可选：见下
}
```

确定性检查（规范 §4）：

| 字段 | 判定 |
|---|---|
| `commands` | 在工作区里执行，退出码必须等于 `expectExit`（默认 0）。用 `argv` 直接执行最可移植；要用 shell 的写 `shell`（Windows 是 cmd.exe，其余是 /bin/sh），比如 `npm test` 要写成 `"shell": "npm test"` |
| `mustChange` / `mustNotChange` | 改动 = 相对基准提交的全部变化，含已提交、未提交与新建文件 |
| `forbidden` | 模式不得出现。`in` 默认是 `added`，即代理新增的行；`content` 查改动文件（或 `paths` 指定文件）的最终内容；`answer` 查最终回复 |
| `required` | 模式必须出现。`in` 默认 `content`，也可以是 `answer` 或 `added` |
| `overlay` | 代理跑完、静态检查做完之后才复制进工作区，再跑 `commands`。适合放代理看不到的验收测试 |

`budget.timeMs` 默认 15 分钟，`budget.maxSteps`（主代理的模型调用次数）默认 60。

- Claude Code 的步数上限就是 `--max-turns`。
- PiLab 在第 maxSteps+1 次模型调用开始时用 `worker.stop` 截停。这次调用已经发出，但它的结果不会被执行。

`judge` 是 LLM 评分（规范 §5），只打分、列问题，不判通过与否。评分模型看到任务、rubric、最终回复和 diff，看不到是哪个客户端做的。提示词固定，版本记在 `ab-eval-judge/1`。

`fakeModel` 是这个用例的 happy path（规范 §3），写成假模型剧本，只在假网关上使用：

- 抽象步骤有 `cwd`、`shell`、`read`、`edit`、`write`、`grep`、`glob`、`call`（任意工具名）和 `answer`；
- 假网关把每步映射成各客户端自己的工具（`Read` / `read`，`Bash` / `pwsh`），同一份剧本能同时驱动两边；
- `expect` 写的是两边都应得到的记录值，供自测断言。

真实用例不写这一段也行：假网关会直接回一句文本，流程照样能跑通。

### 怎么加一个用例

1. **准备仓库**，二选一：
   - 在 `fixtures/` 下放一个小目录。不需要 `.git`，每次运行时会自动初始化并提交，作者和时间固定，所以基准提交在哪台机器上都一样；
   - 用 `"git": "<URL>", "commit": "<sha>"`。仓库会在隔离环境里克隆进缓存，不用本机的 git 凭据。私有仓库请先自己克隆到本地，再把 `git` 写成本地路径。
2. **写 `prompt`**，按真实用户的说法来写，中文没有问题。
3. **写检查**：
   - 能机判的尽量机判，比如测试命令、该改和不该改的文件、禁止的写法、答案里必须有的数字；
   - 代理自己写的测试不可信时，放一份隐藏验收测试到 `overlay`；
   - 项目规范可以放进 fixture 里的 `CLAUDE.md`。两边都会读这个文件，DSH 先找 `AGENTS.md`，没有再读 `CLAUDE.md`。
4. **定预算**和可选的 `judge.rubric`。
5. **先在假网关上验证用例本身**：

   ```bash
   node src/dsh-host/tools/ab-eval/run.ts --case <id> --runs 1
   ```

   - 有 `fakeModel` 时，两边都应该通过；
   - 没有 `fakeModel` 时，应该看到检查失败（因为代理什么都没做），说明检查确实能判出失败。
6. **用真实网关跑**。

现场用例还可以放在别的目录里，用 `--cases <目录>` 指定，不必放进这个公开仓库。

## 变体：改进的开与关（规范 §6）

变体文件是 `variants/<名字>.json`，臂写作 `<客户端>+<名字>`，比如 `pilab+prompt-pack`。也可以直接写变体文件的路径。

```jsonc
{
  "name": "prompt-pack",
  "client": "pilab",
  "description": "自研提示词包",
  "env": { "AICLIENT_DSH_PROMPT_PACK": "1" },          // 宿主环境变量（在 Main 的规则之后叠加）
  "plugins": { "dsh-office-tools": false },            // 同 Main 发给宿主的 AICLIENT_DSH_PLUGINS
  "dshHomeFiles": { "cordis.patch.yml": { "file": "prompt-pack.patch.yml" } },
  "agentDirFiles": { "AGENTS.md": "全局说明……" },       // AICLIENT_PERMISSION_AGENT_DIR 下的文件
  "planSettings": { "cacheControlOnTools": true },     // 模型计划里的请求设置
  "modelRow": { "maxTokens": 64000 },                  // 合并进模型行
  "compat": {}                                         // 合并进路由 compat
}
```

- 文件内容可以直接写字符串，也可以写 `{"file": "相对变体文件的路径"}`。变体的 sha256 连同引用的文件一起算，记在每条记录里。
- `dshHomeFiles` 里的 `cordis.patch.yml` 是宿主的 home patch 层。从源码运行的宿主会应用它（打包后的宿主忽略它），可以用来开关或配置 cordis 行，比如 `system-prompt` 的 `personaPrefix`，或者打开 `tool-web`。隐私与端点相关的行由宿主强制关闭，变体改不回来。
- Claude Code 也能有变体：`"client": "claude-code"`，用 `args`（追加的 CLI 参数）、`env`、`configFiles`（写进临时 `CLAUDE_CONFIG_DIR`，比如 `settings.json`）。
- [variants/selftest-persona.json](variants/selftest-persona.json) 是自测用的示例：用 home patch 在系统提示词里加一个标记。

对比改进开与关：

- **同一轮里并排比**：

  ```bash
  node src/dsh-host/tools/ab-eval/run.ts --arms pilab,pilab+prompt-pack,claude-code
  ```

- **分开跑的几轮合并比**，例如网关改写通道与透传通道：

  ```bash
  node src/dsh-host/tools/ab-eval/report.ts out/<改写那轮> out/<透传那轮> --out compare.md
  ```

  合并后臂名前面会加上各轮的 `--label`；用 `--baseline <臂>` 指定基线。

## 输出与报告

```
out/<运行 id>/
  manifest.json        版本戳与配置（规范 §15）、用例与臂的哈希、密钥扫描结果
  records.jsonl        每次运行一行，与各自的 record.json 内容相同
  report.md            对比报告
  runs/<用例>/<臂>/<第几次>/
    record.json        结构化记录（schema ab-eval.run/1）
    trace.jsonl        统一格式的轨迹：每次模型调用（usage、文本）与每次工具调用（名称、类别、输入、结果、出错、退出码）
    diff.patch         代理的全部改动
    client/            客户端原始产物
                         PiLab：解码后的 DSH 会话日志、bridge 事件、宿主 stderr
                         Claude Code：stream-json、stderr
```

### record.json 的主要字段

| 字段 | 内容 |
|---|---|
| `status` | `completed`、`timeout`、`step_budget` 或 `client_error` |
| `passed` | `completed` 且全部检查通过 |
| `checks[]` | 每项检查的结果和细节，包括命令输出尾部和命中位置 |
| `failureTags` | 失败分类（规范 §14）：状态、`check:<id>`、`empty_answer`、`unknown_tool` |
| `metrics` | `steps`、`toolCalls`、`toolErrors`、`unknownToolCalls`、`nonZeroExits`、`pendingToolCalls`、按工具名与按类别的统计、`tokens`（`input` / `cacheRead` / `cacheWrite` / `output` / `total`）、`durationMs`、`wallMs`、`changes`（文件数、增删行数） |
| `client` | PiLab：请求实际用的模型和档位、系统提示词哈希、轮次结束原因、重试次数；Claude Code：版本、`apiKeySource`、权限模式、`num_turns`、它自估的费用 |
| `judge` | 分数、各维度、问题清单；或者 `error` |

另一个代理接手时（规范 §11），读失败用例的 `record.json`、`trace.jsonl` 和 `diff.patch` 就能复盘。

### 怎么读 report.md

1. **运行信息**：时间、模型和档位、网关类型（真实网关只记 URL 的哈希）、用例集版本、harness 提交（含未提交改动的 diff 哈希）、DSH 与 Claude Code 版本、各臂与变体哈希、密钥扫描结果。比较两份报告前，先确认这些一致。
2. **总览**：每个臂在全部用例上的通过率、步数、工具调用与失败、未知工具、非零退出、计费 token、耗时、改动行数和评分。离散度里混着用例之间的差别，看单个用例的波动要看第 4 节。
3. **相对基线**：其余各臂相对基线臂（默认第一个）的配对差值，逐个用例算差再取平均。一眼看出谁通过率更高、谁更费 token、谁更慢。
4. **按用例 × 臂**：主表，给出均值 ± 样本标准差，n = 1 时只给均值。
5. **工具调用**：按类别（read、edit、shell、search、web……）列出每次运行平均的调用和失败次数，能看出工具用法的差异，比如 PiLab 在 Windows 上走 pwsh。
6. **检查项通过次数**：具体卡在哪一项。
7. **未通过的运行**：失败标签和记录路径，从这里进入复盘。
8. **口径**：各指标的精确定义。

几个容易误读的口径：

- **工具失败** = 工具报错加未知工具。shell 命令跑完了但退出码非零，记为 **非零退出**，不算失败，因为修复前先跑一遍测试就是这样。
- **计费 token**：
  - PiLab 取 DSH 会话日志里每一步 usage 之和，含子代理会话；
  - Claude Code 取 `result.modelUsage` 各模型之和，含它的辅助模型；
  - 被截停的运行，Claude Code 只能用逐条消息的近似值，`metrics.tokensSource` 会写明来源。
- **耗时**：PiLab 从 `worker.send` 算到会话回到 idle，不含宿主启动（产品里宿主常驻）；Claude Code 取它自报的 `duration_ms`。`wallMs` 包含启动时间。
  - Claude Code 在一个会话里第一次调用 Bash 时要建 shell 快照，Windows 上要几秒，偶尔更久（本机见过 23 秒），所以要多跑几次看离散度。

## 凭据与隔离

- **不碰本机任何账户**：
  - PiLab 宿主拿到的 key 只经 IPC 按请求下发，宿主的凭据库没有参与；
  - Claude Code 用临时的 `CLAUDE_CONFIG_DIR` 和 HOME，key 只经 `ANTHROPIC_API_KEY` 传入，记录里的 `apiKeySource` 可以核对；
  - 两边的环境都设了 `GIT_CONFIG_NOSYSTEM=1` 和 `GIT_TERMINAL_PROMPT=0`，git 的凭据管理器不会参与。
- **key 与 URL 不落盘**：
  - 写出的每个文件都先把 key、真实网关 URL 和主机名替换成 `[REDACTED]`；
  - 每次运行结束扫描一遍沙箱，整轮结束再扫描一遍输出目录，结果写进 `manifest.json` 和报告；
  - 发现泄漏时退出码为 1。
- **祖先目录检查**：Claude Code 会沿父目录读 `CLAUDE.md`。如果沙箱目录的某个上级有 `CLAUDE.md`、`AGENTS.md` 或 `.claude/CLAUDE.md`，就拒绝运行，避免这些说明混进每一次评测。可以换一个 `--scratch`。
- **轨迹不要入库**：轨迹里有本地路径和模型输出，`out/` 已被 git 忽略。仓库是公开的，需要分享时只分享 `report.md`，它不含路径和密钥。
- **抓包只在自测时开**：自测会抓假网关收到的请求，用来做隔离断言，抓完随沙箱一起删掉。Claude Code 的系统提示词版权属于 Anthropic，不要保存这些抓包。

## 自测验证了什么

`selftest.ts` 断言以下几点，全部成立才退出 0：

1. 每条记录都与用例的 `fakeModel.expect` 一致：状态、是否通过、步数、工具调用、工具报错、未知工具、非零退出、改动文件数和失败标签。
   - 其中 retry 用例故意读一个不存在的文件、调用一个不存在的工具，用来验证这两个计数在两边都对；
   - 失败、截停和超时的路径都覆盖到了。
2. 同一用例三个臂都正常结束时：
   - 两边报告的计费 token 完全相同且大于 0（假网关按步计费）；
   - 假网关收到的模型请求数等于记录里的步数，没有多出来的请求；
   - 评分请求数等于被评分的记录数。
3. 每个客户端确实按要求运行：
   - Claude Code 用的是环境变量里的 key，权限模式是 bypass，没有加载任何 MCP 服务器，插件也只有内置的；
   - PiLab 的请求用的是指定的模型和档位，宿主正常停止。
4. 变体确实生效：变体臂的系统提示词里有 home patch 加的标记，基线臂的没有。
5. 隔离：
   - 抓到的请求里没有真实的 `~/.claude`、`~/.dsh` 路径；
   - 输出目录和沙箱里都找不到这把 key；
   - 报告覆盖了全部用例和臂。

`__tests__/` 里是不需要宿主的单元测试，覆盖两边轨迹的解析与计数规则、检查引擎、统计、报告、用例与变体校验，以及密钥扫描。它们在根 Vitest 里运行：

```bash
pnpm exec vitest run src/dsh-host/tools/ab-eval
```

## 已知限制

- 一次只跑一个运行，不并发，以免互相影响耗时和限流。
- PiLab 的步数截停比 Claude Code 晚一步发生：多发出的那次调用会被中止（见「用例格式」）。
- `dshHomeFiles` 只对从源码运行的宿主有效。改进项确定以后，要落到 `bundle/cordis.patch.yml` 或正式开关里，再用 `env` 变体做对比。
- 评分默认和被测请求走同一个网关。如果网关会改写请求（调研 §4），评分请求也可能被改写，可以用 `AB_JUDGE_BASE_URL`、`AB_JUDGE_API_KEY` 指定一个干净的端点。
- 评分请求由本进程用 `fetch` 发出，Node 默认不读代理变量。需要代理时，运行前设置 `NODE_USE_ENV_PROXY=1`，或者用 `node --use-env-proxy` 启动。两个客户端本身会照常使用传给它们的代理变量。

## 文件

| 路径 | 作用 |
|---|---|
| `run.ts` | 跑一轮评测 |
| `report.ts` | 由一个或多个输出目录重建报告 |
| `selftest.ts` | 假网关上的端到端自测 |
| `cases/` | 随附用例：修 bug、跨文件加功能、读代码回答问题 |
| `fixtures/` | 用例仓库，`*-hidden` 是隐藏验收文件 |
| `selftest/cases/` | 只给自测用的用例 |
| `variants/` | 变体 |
| `lib/suite.ts` | 编排：沙箱、仓库副本、客户端、检查、记录 |
| `lib/pilab.ts` | PiLab 侧运行器 |
| `lib/claudeCode.ts` | Claude Code 侧运行器 |
| `lib/dshLog.ts` | 解析 DSH 会话日志 |
| `lib/claudeStream.ts` | 解析 Claude Code 的 stream-json |
| `lib/toolMetrics.ts` | 两边共用的计数规则 |
| `lib/checks.ts` | 确定性检查 |
| `lib/judge.ts` | LLM 评分 |
| `lib/summary.ts` | 汇总与报告 |
| `lib/workspace.ts` | 仓库副本与 diff |
| `lib/sandbox.ts` | 隔离环境 |
| `lib/redact.ts` | 密钥替换与扫描 |
| `lib/stamp.ts` | 版本戳 |
| `../fake-gateway.mjs` | 本机假网关，plan `ab-eval` 负责执行 `fakeModel` 剧本 |
