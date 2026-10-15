# 证据：T2 三方对照：PiLab（DSH）、PiLab+SDK、Claude Code 在同一真实网关上做编码任务（2026-10-15）

Role: evidence（指定版本的事实，不滚动更新）。背景见[差距调研](../../../../../plans/2026-10-14-pilab-vs-claude-code-gap-study.md) §6 T2 与[路线 B 原型结论](../../../../../plans/2026-10-14-claude-agent-sdk-prototype.md) §10 第 3 步。T1 的网关透传检查（SDK 引擎原样通过，PiLab 仍被改写）见 `docs/quality-gap-study` 分支 `a48d1935` 的 `quality-gap-2026-10-14/README.md` §4。

## 1 问什么

路线 B 是让 Claude 模型改由官方 Claude Agent SDK 驱动。T2 要回答：在同一网关、同一 key、同一模型和档位、全自动审批下，PiLab+SDK 做真实编码任务的效果是否接近 Claude Code，是否明显好过 PiLab+DSH。

## 2 版本与环境

- harness：本分支 `f67db392`（A/B 评测框架 `src/dsh-host/tools/ab-eval/`，已合入路线 B 原型 `proto/claude-agent-sdk-engine` 的 `5d013c0f`），工作树干净；应用 `1.1.1-test.1`。
- PiLab（`pilab`）：DSH `0.1.7-rc.2`，源码宿主 `src/dsh-host/host.ts`。
- PiLab+SDK（`pilab-sdk`）：原型宿主 `src/claude-sdk-host/host.ts`，`@anthropic-ai/claude-agent-sdk@0.3.300`，随包 CLI `2.1.300`。
- Claude Code（`claude-code`）：`claude -p`，用 `--claude-bin` 指向 SDK 随包的同一个 `claude.exe`（`2.1.300`），这样两臂 CLI 版本相同，差别只在谁来驱动 CLI。T1 的 CLI 对照组也是这么做的。
- 机器：Windows 10 Pro 19043，Node 24.12.0，Git Bash 在 PATH 上。
- 网关：公司的真实网关。PiLab 每步的计费与 T1 相符（见 §4.5），应是同一网关。地址和临时 key 由用户在对话中提供，只放在运行命令的环境变量里，没有写进任何文件。

## 3 跑法

1. 假网关自测：`node src/dsh-host/tools/ab-eval/selftest.ts`，四个臂（`pilab`、`pilab-sdk`、`claude-code`、`pilab+selftest-persona`）× 9 个用例，再加续跑测试，共 38 次运行，全部断言成立。其中三方的计费 token 逐个用例完全相同；步数截停用例三方都正好 3 步；`pilab-sdk` 的宿主事件与 SDK 消息数出的步数和工具调用一致。
2. 预检：`run.ts --gateway real --dry-run --probe`，没有问题；探针 HTTP 200，2.5 s，模型 `claude-opus-5-5`。
3. 正式跑：

   ```bash
   # AB_BASE_URL、AB_API_KEY 只在本条命令的环境里设置
   NODE_USE_ENV_PROXY=1 node src/dsh-host/tools/ab-eval/run.ts --gateway real \
     --arms pilab,pilab-sdk,claude-code --model claude-opus-5-5 --effort high --runs 2 \
     --label t2-three-way --claude-bin <src/claude-sdk-host 里随包的 claude.exe>
   ```

   - 用例：3 个随附用例。`fix-median-sort`（修 bug），`retry-total-sleep`（读代码回答问题），`slugify-max-length`（跨文件加功能并补测试）。
   - 次数：每个「用例 × 臂」2 次，共 18 次，一次只跑一个，臂的先后轮换。
   - 判定：只用确定性检查，没开 LLM 评分（评分请求同样经过这个网关，可能被改写）。
   - 用时：08:13:44～08:22:43（UTC），约 9 分钟。没有出错，没有用 `--retry-errors`。

各臂一致的东西：同一网关、key、模型、档位（`high`）；全自动审批（两个 PiLab 臂用 `bypass` 档位，Claude Code 用 `--dangerously-skip-permissions`）；每次运行一份干净的仓库副本和新沙箱（独立的 HOME、临时目录、`DSH_HOME` 或 `CLAUDE_CONFIG_DIR`）；时间与步数上限相同（`pilab-sdk` 的步数上限经 SDK 的 `maxTurns` 传给 CLI，与 `--max-turns` 同一机制）。

各臂本来就不同的东西（产品差异，不是评测造成的）：

| | pilab | pilab-sdk | claude-code |
|---|---|---|---|
| 系统提示词 | DSH 自己的 | SDK 的 `claude_code` 预设，加 4 行「# PiLab」 | CLI 自己的 |
| 提供的工具 | 23 个 DSH 工具（`read`、`edit`、`pwsh`……） | 15 个（原型禁用了 11 个宿主工具） | 22 个（`-p` 下没有提问与计划工具） |
| 网关怎么处理请求 | 改写：换系统提示词、加工具、注入预先缓存的前缀（调研 §4、T1） | 原样通过（T1 §4） | 原样通过 |

## 4 结果（report.md 的主要表格）

报告由框架生成，原文在本机 `out/20261015-011344-t2-three-way/report.md`，没有入库，因为输出目录里的轨迹含本地路径和模型输出。

### 4.1 总览（每臂 6 次运行，均值 ± 标准差）

| 臂 | 通过（95% 区间） | 步数 | 工具调用 | 工具失败 | 未知工具 | 非零退出 | 计费 token | 耗时 s | 改动行数 | 自动应答 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pilab | 6/6 · 100%（61–100%） | 4.5 ± 1 | 7.5 ± 4 | 0 | 0 | 0.2 ± 0.4 | 189.8k ± 49.9k | 27.9 ± 17 | 27 ± 42.4 | 0 |
| pilab-sdk | 6/6 · 100%（61–100%） | 3 ± 0.9 | 2.3 ± 1.4 | 0 | 0 | 0 | 58.7k ± 17.3k | 27.4 ± 15.7 | 18 ± 26.4 | 0 |
| claude-code | 6/6 · 100%（61–100%） | 3 ± 0.9 | 2.2 ± 1.2 | 0 | 0 | 0 | 81.3k ± 23.8k | 25.6 ± 15.5 | 18 ± 26.4 | — |

### 4.2 按用例 × 臂（n = 2）

| 用例 | 臂 | 通过 | 步数 | 工具调用 | 缓存读 | 缓存写 | 输出 | 计费 token | 耗时 s | 改动行数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fix-median-sort | pilab | 2/2 | 4 | 5 | 155.4k | 8.9k | 887 | 165.3k | 15.7 | 2 |
| fix-median-sort | pilab-sdk | 2/2 | 4 | 4 | 60.9k | 13.9k | 869 | 75.6k | 16.6 | 2 |
| fix-median-sort | claude-code | 2/2 | 4 | 3.5 | 96.7k | 7.8k | 795 | 105.3k | 15.1 | 2 |
| retry-total-sleep | pilab | 2/2 | 4 | 5 | 153.7k | 8k | 1.3k | 163k | 18.9 | 0 |
| retry-total-sleep | pilab-sdk | 2/2 | 2 | 1 | 29.3k | 7.1k | 1.2k | 37.6k | 20.2 | 0 |
| retry-total-sleep | claude-code | 2/2 | 2 | 1 | 44.2k | 7.2k | 1.2k | 52.6k | 16.7 | 0 |
| slugify-max-length | pilab | 2/2 | 5.5 | 12.5 | 222.9k | 13.2k | 5k | 241.1k | 49.3 | 79 |
| slugify-max-length | pilab-sdk | 2/2 | 3 | 2 | 48.5k | 10.6k | 3.8k | 62.8k | 45.6 | 52 |
| slugify-max-length | claude-code | 2/2 | 3 | 2 | 70.9k | 10.9k | 4.1k | 85.9k | 45.1 | 52 |

计费 token 一列是中位数（n = 2 时即两次的均值）；输入 token 每臂每步都只有 2，略去。

### 4.3 相对基线 `pilab`（各用例差值的平均）

| 臂 | 通过率差 | 步数差 | 工具失败差 | 计费 token 差 | 耗时差 s |
| --- | --- | --- | --- | --- | --- |
| pilab-sdk | 0 | -1.5 | 0 | -131.1k（-68%） | -0.5（+2%） |
| claude-code | 0 | -1.5 | 0 | -108.5k（-56%） | -2.3（-8%） |

逐个用例看，计费 token 的方向一致：`pilab-sdk` 比 `pilab` 少 54%、77%、74%，`claude-code` 少 36%、68%、64%。

### 4.4 工具用法（每次运行的均值：调用 / 失败）

| 臂 | read | edit | shell | search |
| --- | --- | --- | --- | --- |
| pilab | 3.7 / 0 | 2.2 / 0 | 1 / 0 | 0.7 / 0 |
| pilab-sdk | 0 / 0 | 0.3 / 0 | 2 / 0 | 0 / 0 |
| claude-code | 0 / 0 | 0.2 / 0 | 2 / 0 | 0 / 0 |

### 4.5 其他记录

- 全部 18 次都正常结束，没有工具失败、未知工具和自动应答，`pilab` 与 `pilab-sdk` 都没有自启动的后续轮次。
- `pilab-sdk` 6 次运行的 CLI 都用环境变量里的 key（`apiKeySource: ANTHROPIC_API_KEY`），权限模式 `bypassPermissions`，模型 `claude-opus-5-5`。宿主事件与 SDK 消息数出的主代理步数和工具调用 6 次都一致。
- 每步的缓存读：`pilab` 约 38～41k，`pilab-sdk` 约 14～17k，`claude-code` 约 22～24k。与 T1 每次请求的计费提示词（PiLab 约 39.1k、SDK 17.0k、CLI 24.6k）相符。
- 密钥扫描：框架在每次运行后扫描沙箱，整轮结束后扫描输出目录，命中文件数都是 0（`manifest.json` 的 `leakScan.clean: true`，退出码 0）。

## 5 数据支持什么

1. **PiLab+SDK 的做法与 Claude Code 几乎一样。** 三个用例上，两臂的步数逐个相同（4、2、3），工具调用基本相同（4 对 3.5、1 对 1、2 对 2），耗时在误差内（27.4 s 对 25.6 s）。连命令的样子都一样：先用一条 Bash 把文件 `cat` 出来，再用一条 Bash 里的 Python heredoc 改文件、跑测试。它们是同一个 CLI，所以这个结果并不意外。但它说明 PiLab 的宿主层（追加的 4 行、禁用的 11 个工具、卡片与审批的接管）没有让 CLI 的行为走样。
2. **PiLab+SDK 比 PiLab+DSH 省 token、少步数。** 计费 token 少约 68%（三个用例方向一致：-54%、-77%、-74%）；步数平均少 1.5，工具调用从 7.5 降到 2.3。省下的大头是缓存读：DSH 每步约 39k，比它自己实际发送的多出一截，与网关改写时注入的预缓存前缀（调研 §4、T1）对得上。PiLab+SDK 还比 Claude Code 少约 28%，因为 SDK 预设的工具和提示词比 CLI 的少（15 个工具对 22 个）。
3. **成功率分不出高下。** 三臂都是 6/6，Wilson 95% 区间都是 61–100%。这 3 个随附用例是 smoke 级，三方都能做对，所以这组数据既不支持也不否定「PiLab+SDK 在做对任务上明显好过 PiLab+DSH」。耗时三方也没有可分辨的差别。

样本小：每个「用例 × 臂」只有 2 次，同一臂的两次之间也有波动（例如 `pilab` 在 `retry-total-sleep` 上 3 步与 5 步各一次）。上面的步数与 token 差在三个用例上方向一致，可以算作方向性的证据，但区间很宽，不能当作精确的幅度。

## 6 还缺什么

- **更难的任务**：main 或 incident 级的现场用例（多文件、需要排查、会失败的任务），才能看出成功率的差别。框架已支持仓库外的现场用例（README「加现场用例」）。
- **更多次数**：每组 5 次以上，区间才会变窄。
- **质量评分**：需要一个不改写请求的干净端点（`AB_JUDGE_BASE_URL`）才能开 `--judge`。
- **加密机读写矩阵**：用户在加密机上做（原型结论 §5.2），T2 不覆盖。
- **两个 PiLab 侧问题**（不影响本次数据，留作后续）：
  - SDK 宿主的 Stop 先用 PowerShell 采一次进程树再中断 CLI，在 Windows 上要等约半秒以上。假网关的快速循环里，Stop 之后又多跑了 3 步。评测里改用 SDK 的 `maxTurns` 截停步数，产品里的 Stop 延迟还没处理。
  - CLI 用 Bash 里的脚本改文件时，PiLab 窗口只会显示一条 shell 调用，不会出现编辑行和 diff。路线 B 若立项，界面上要考虑怎么呈现这类改动。
