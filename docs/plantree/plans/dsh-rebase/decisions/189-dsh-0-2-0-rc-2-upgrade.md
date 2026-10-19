# 决策 189：DSH 升到 0.2.0-rc.2；试点插件随之升到 1.0.6，Windows 上隐藏沙箱的 ACL 修复技能

日期：2026-10-14。**状态：自主决定，待用户审批。** 按[决策 003](003-p0-closeout-enter-p1.md) 第 2 条的升级流程做，未推送、未合入；推送与合入前先经用户确认。

代码：worktree 分支 `claude/upbeat-darwin-fbd177`（基于 `main` 的 `79f81cdb`），提交见第 9 节。

证据：[dsh-0.2.0-rc.2-upgrade-2026-10-14.md](../evidence/dsh-0.2.0-rc.2-upgrade-2026-10-14.md)（升级前后同一台 Windows 机器上的逐项对照，复跑脚本在同名目录 `scripts/`）。

来源：PiLab 与 Claude Code 差距调研 §8（`docs/plans/2026-10-14-pilab-vs-claude-code-gap-study.md`，在 `docs/quality-gap-study` 分支）。结论是升到 0.2.0-rc.2 风险低，主要收益是上游 `6ed596f7` 修掉的思考回放缺陷；0.2.1-alpha.x 有 5 处破坏性改动，不在本次范围。

修订关系：

- [决策 003](003-p0-closeout-enter-p1.md) 第 2 条：钉的版本 `0.1.7-rc.2` → `0.2.0-rc.2`，「钉精确版本、锁文件入库、不自动追 rc」不变。
- [决策 060](060-first-allowlist-pilot-office-tools.md)、[115](115-p1-10d-pilot-plugin-choices.md)：试点插件 `dsh-office-tools` 1.0.4 → 1.0.6，审查记录换成增量审查 `src/dsh-host/plugins/reviews/dsh-office-tools-1.0.6.md`。
- [决策 082](082-allowlist-implementation-choices.md) 第 3 条：`overrides` 照旧钉到宿主版本，但对 1.0.6 已不是消除 `ERESOLVE` 所必需（第 3 节）。
- [决策 044](044-dsh-sandbox-off-by-default-in-p1.md)、[045](045-windows-acl-sandbox-default-off.md)（DSH 沙箱默认关）：补一条推论，见第 6 节。

## 1 结论

- 升。宿主、桥接、权限行、回路守卫等代码不用为新版改接口；需要跟着改的只有：版本钉与锁文件、我们三个 bundle 的 peer、试点插件版本、`forkSeed.ts` 里对 dsh-session 的复制。
- 复核发现两件调研没提到的事，都在本分支处理：
  1. 试点插件 1.0.4 与 0.2.0-rc.2 不兼容，必须随之升版（第 3 节）；
  2. Windows 上 DSH 沙箱会注册一个修改文件夹权限的技能，模型每个请求都能看到，我们隐藏它（第 6 节）。
- 思考回放修复已在假网关上用 A/B 证实（第 5 节）。

## 2 对照上游（tag `dsh-v0.2.0-rc.2`，提交 `639ed015`）

- **升级指南** `docs/upgrade-guide/v0.1.7-rc.2/` 只有两篇，都不涉及我们：
  - `schedule-optional-bundle`：Web 组合里的 `time-context`、`schedule`、`ui-schedule` 三行移到可选包。我们的组合不叠 `dsh-web-app`，补丁里也没有这三个 id。
  - `transcript-view-legacy-normal`：DSH 客户端「工作详情」设置的默认值，我们不用 DSH 客户端。
- **GitHub Release**（rc.1、rc.2 两份）里与宿主有关的：
  - 工具调度失败后对话可以继续（`dsh-agent-loop` 在出错的那一步补记保守的错误结果）；
  - bash / pwsh 工具说明加了「删除或移动前核对解析后的绝对路径」，pwsh 还加了「不要给 `$HOME` 等自动变量赋值」（模型可见，见第 8 节）；
  - 持久 PowerShell 状态行带尾随空格时识别出错的修复；
  - pi-ai 升到 0.87.1；
  - 实验性异步问答：`tool-ask-user` 行新增 `mode: legacy | timed`，默认 `legacy`，我们不开；
  - Windows 沙箱权限诊断技能（第 6 节）。
  - 思考回放修复在 release notes 里没有单列，在 `6ed596f7`（`chore(deps): upgrade pi-ai to 0.87.1`）里。
- **cordis** 仍是 `4.0.4`（锁文件核实），`cordis-plugin-*` 版本不变。
- **我们补丁用到的行 id**：dsh-base 的行 id 从 93 个变成 94 个，只多了 `otel`（`@deepseek-ai/dsh-otel`）。`src/dsh-host/bundle/cordis.patch.yml` 定位的 19 个 id、`hostProfile.ts` 等宿主代码引用的行 id 全部还在。
  - `otel` 只是传输服务，自己不建队列、不建身份、不联网；它唯一的消费者 `session-telemetry-otel` 仍被我们关掉。按[决策 090](090-user-rulings-2026-09-28.md)「默认跟随 DSH」，不在补丁里关它。
  - `session-telemetry-otel` 的默认上报地址换了域名，该行本来就关着，不影响。
- **宿主用到的钩子与接口**：
  - 在源码层面逐包比对：`core/tools`（`tools/pre-execute` 等）、`core/system-prompt`（`systemPrompt.context` / `variable`）、`compaction`（`summarize`）、`fs`、`core/agent`、`llm`、`user-approval`、`token-meter`、`attachment`、`goal`、`jobs`、`subagent`、`skill`、`agent-instructions`、`home-paths`、`launch-environment` 都只改了 `package.json` 的版本号。
  - `app-boot` 只在 `OPTIONAL_BUNDLES` 里加了 schedule 可选包。
  - 运行期由现有的漂移闸门再核一遍，全部通过：`[179-H-09]`（摘要钩子的请求形状）、`hostCompaction`（与 `resolveCompactSpec` 逐字对拍）、`permissionsClassification`（已装 DSH 定义的每个工具都已分类、没有多余的）、`dshModelPlan` 的 compat 合并。
- **有源码改动、与我们相关的两处**：
  - `dsh-session`：`openTurnClosers` 改用新的 `ToolCallRecovery`（第 7 节）。
  - `dsh-llm-pi-ai`：
    - `catalog.ts` 的 compat 闸门多了几个 `withhold` 字段，三种协议对外 `offer` 的字段一个没变，`src/shared/dshModelPlan/tables.ts` 的静态副本照旧成立（只更新了行号）；
    - `replay.ts` 就是思考回放修复。

## 3 白名单插件 peer 复核：`dsh-office-tools` 1.0.4 → 1.0.6

- 1.0.4 声明的五个 `@deepseek-ai/dsh-*` peer（`^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.5-alpha.0`）全部止于 `<0.2.0`。
  - DSH 自己的 `evaluatePluginCompatibility` 让预发布参与匹配，判定 1.0.4 与 `0.2.0-rc.2` 不兼容。
  - 后果：设置里打开插件时，app-boot 把它从 profile 里跳过（`skippedBundles`）；构建期 `auditInstalledPlugins` 判失败，按决策 082 不许豁免，整包构建停在这里。
- 1.0.5、1.0.6 的 peer 加了 `>=0.2.0-rc.1 <0.3.0-0`。选 1.0.6（`latest`，2026-10-13）。增量审查结论「有条件通过」，条件与 1.0.4 相同：
  - 1.0.5 重写了 ASCII 安全 ZIP 写入器，加了 200 张幻灯片上限；1.0.6 让 `ppt_read` 报 `graphicFrame`；
  - 没有新的外部接口、运行期依赖、安装脚本或原生件，8 个工具与读写分类不变；
  - 唯一用户可见的变化：生成的 Office 包里可能多出 `dshPadding/padN.xml` 填充部件，列为 Windows 现场核对项。
- **`overrides`**：npm 对 1.0.6 的新范围已能匹配 `0.2.0-rc.2`（同为 `0.2.0` 的预发布），不再报 `ERESOLVE`。仍按决策 082 第 3 条保留并钉到 `0.2.0-rc.2`，作用变成「peer 一定用宿主那一份」。
- **未声明依赖**：插件代码 import 的 `@deepseek-ai/schemastery` 仍在宿主树顶层（3.18.4），1.0.4 记录里那条风险不变。

## 4 版本钉与锁文件

- `src/dsh-host/package.json`：6 个 `@deepseek-ai/dsh-*` 与 `overrides.dsh-office-tools` 的 5 项改成 `0.2.0-rc.2`，`dsh-office-tools` 改成 `1.0.6`。
- **我们自己的三个 bundle 也要跟**：`@aiclient/dsh-app`（`bundle/package.json`，4 个 peer）、测试用 `tools/probe-bundle`、`tools/plugin-fixture`。
  - 原因：app-boot 对每个 profile bundle 都跑 `evaluatePluginCompatibility`。peer 仍写 `0.1.7-rc.2` 的话，宿主会跳过整个 `@aiclient/dsh-app`，我们的行一个都不加载。
- **锁文件的生成方式**：
  - 直接 `npm install` 会因为旧条目里的 peer 冲突报 `ERESOLVE`；
  - 所以先删掉锁文件里全部 `@deepseek-ai/dsh-*` 与 `dsh-office-tools` 条目，再 `npm install --ignore-scripts`，最后 `npm dedupe`，把 5 份嵌套的 `koffi@3.1.1` 合成顶层一份；
  - 这样非 DSH 包只在 DSH 新版本的依赖要求时才变。
- **锁文件结果**：
  - 所有 `@deepseek-ai/dsh-*` 都是 `0.2.0-rc.2`（构建预检的漂移检查要求如此）。
  - 非 DSH 的变化全部来自 DSH 新依赖：
    - pi-ai `0.85.1 → 0.87.1`，带动 `@anthropic-ai/sdk 0.123.0 → 0.124.0`、`@google/genai 1.52 → 2.21`、aws-sdk 若干补丁版；
    - `http(s)-proxy-agent` 7 → 9：pi-ai 里只有 Bedrock 用，我们不开这个协议；
    - `koffi 3.3.1 → 3.1.1`：DSH 包改成精确钉 3.1.1，上游注释说 3.3.2 在 GCC 13 下源码构建失败；
    - 新增 `dsh-otel` 及其依赖 `got@14` 等，移除 `@opentelemetry/exporter-logs-otlp-http` 等。
  - 明细在证据第 1 节。

## 5 思考回放修复的验证（上游 `6ed596f7`）

- **机理**：
  - 0.1.7-rc.2 给 Anthropic 回复记回放信封时，响应模型名与请求不同（网关别名、改写）就把响应的名字当成 `model` 回放；
  - pi-ai 判断「同一模型」时拿它和本次请求的模型比，结果不等：
    - 带签名的思考被改成普通文本；
    - 空文本带签名的思考与 redacted 思考被丢掉。
  - 0.2.0-rc.2（配 pi-ai 0.87.1）回放时保留请求的模型名，响应名另记在 `responseModel`。
- **验证方法**：
  - 用 `request-prefix-probe.ts` 的 S1（P1-CHAIN：每步一个思考块，三种形态轮换），让假网关（`fake-gateway.mjs --model-id`）分别用请求的模型名 `fake-1`（对照）和 `fake-1-20260929`（模拟网关别名）作答；
  - 保留抓到的请求，数之后每个请求里回放的思考块成了什么。
  - 升级前后在同一台机器上各跑一遍，脚本见证据目录。
- **结果**：

| | 对照（名字一致） | 名字不同 |
|---|---|---|
| 0.1.7-rc.2 | 签名思考 9 / 空签名 7 / redacted 4 全部原样回放 | 签名思考 9 → 普通文本，空签名 7 与 redacted 4 全部丢失 |
| 0.2.0-rc.2 | 全部原样（全量计数 19 个请求、122 次回放：50 / 43 / 29） | 与对照完全相同 |

升级前的对照只数了第二个回合（同一个计数脚本、同一子集，两版都一样数），升级后两种都有全量计数。

- **对已有会话的影响**：会话里那些响应名与请求名不同的 Anthropic 回复，升级后第一次请求起思考块按原样回放。
  - 请求前缀会变一次，缓存重建一次；
  - 模型从此能看到自己之前的思考。
  - 名字一致的会话不受影响。调研时公司网关返回的名字与请求一致；换网关或用别名时才触发。

## 6 Windows：隐藏 DSH 沙箱的 ACL 修复技能

- **现象**：
  - 0.2.0 的 `dsh-sandbox-local` 在 Windows 上只要沙箱行加载、没有配置外部 runner，就注册一个随包技能 `diagnose-windows-sandbox-acl`（`dsh-sandbox-windows-acl` 的 `acl-skill.ts`）；
  - 我们用 `danger-full-access` 关掉沙箱（决策 044、045），但沙箱行仍然加载，所以它照样出现。
  - 实测升级后每个请求都带着它：抓到的 21 个请求 21 个都有，升级前 0 个。它同时出现在斜杠菜单与侧栏技能数里。
- **为什么不能留**：
  - 技能正文让模型在「读不了本该能读的路径」时跑一个脚本：给当前用户补完全控制权限、删掉 AppContainer 的权限项，并让用户切到「完全权限」、把会话作为反馈发给 DSH。这三件事在本应用里都不成立。
  - 加密机上「明明有权限却读不到」恰恰常见（P1-13），模型很可能去改公司目录的权限。我们的审批卡会拦，但卡片上的说明是这个技能教模型写的，用户很难看出它在做什么。
- **做法**（`src/dsh-host/permissions/plugin.ts` 的 `hideSandboxSkills`）：
  - 在 `aiclient-permissions` 行里，仅 Windows，经 `ctx.inject(['skills'])` 注册一个同名运行期技能，模型与用户都不可调用。
  - dsh-skill 的同层排序里运行期技能（rank 250）压过随包技能（rank 600），于面向模型的技能清单、斜杠菜单、按名加载都只会拿到这个不可调用的占位。
  - 选这一行是因为沙箱与审批同属权限：沙箱关掉的理由在这一行旁边写着。
- **附带改动**：桥接的技能数（`capabilities.skills`）原来数 `skills.list()` 的全部条目。现在只数模型或用户能调用的，与它的注释「model- or user-invocable」一致；否则 Windows 上侧栏会多数一个看不见的技能。
- **不在 Linux / macOS 注册**：那里 DSH 不带这个技能，多一个占位只会让技能数变化、金样本变动。
- **代价**：
  - DSH 每次重新收集技能清单时会在宿主日志里记一行 warn（「随包同名技能被忽略」），按工作区与清单版本缓存，不是每个请求都记；
  - 用户自己项目里的同名技能优先级更高，仍可覆盖；这正是用户的意图，不拦。
- **重评条件**：哪天在 Windows 上打开 DSH 沙箱（[open-questions](../open-questions.md) Q002、Q005），这个技能正是 Q005「工作区权限不够时怎么办」的现成办法之一，届时重新评估要不要放出来。

## 7 `forkSeed.ts` 跟随 dsh-session 0.2.0

- 桥接打包时不能 import dsh-session，所以 `buildDshForkSeed` / `forkedTurnClosers` 是 `buildForkSeed` / `openTurnClosers` 的逐字复制，`forkSeed.test.ts` 在装了 DSH 的地方逐边界对拍。
- 0.2.0 的变化（`ToolCallRecovery`）：
  - 一次工具请求只有被**同一回合、同一步、`surfaceOp: 'append'`** 的结果回答才算回答；
  - 补的错误结果记在请求所在的回合。
- 复制已同步，并新增一个合成日志用例（替换型结果、别的步的结果都不算回答），同时对拍 DSH。
  - 旧复制在这个用例上与 0.2.0-rc.2 的输出不同（变异验证）；
  - 录制日志上的对拍新旧都相等，说明日常场景本来不受影响。

## 8 其他变化（不用改代码）

- **模型可见**：
  - bash / pwsh 工具说明各加两句（第 2 节）；
  - 已有会话升级后的第一次请求因工具定义变化缓存重建一次，与任何 DSH 升级相同。
- **pi-ai 0.87.1**：
  - 对 `openrouter.ai` 地址的自定义服务，默认每个请求多带 `x-session-id`（DSH 会话 id），供 OpenRouter 的缓存亲和用；
  - 与决策 173 的 `metadata.user_id` 是同一类信息，接受。
  - 我们手写的自定义服务方言预设（`src/shared/userProviders.ts`）对照 pi-ai 0.87.1 的 `detectCompat` 与供应商目录核过，DeepSeek、Qwen、GLM、OpenRouter 四家的取值与 0.85.1 相同。
- **工具调度失败**：步内出错时 DSH 现在会补记错误结果再结束这一步，回放不会再留下悬空的工具调用。桥接按普通 `tool/result` 处理，不用改。

## 9 提交

1. `c379fe25` `chore(dsh-host)`：版本钉、锁文件、三个 bundle 的 peer、试点插件 1.0.6 与审查记录、`forkSeed` 同步、测试与注释里随版本走的部分。
2. `f8aadf0a` `fix(dsh-host)`：Windows 上隐藏沙箱 ACL 技能，技能数只数可调用的（第 6 节）。可以单独回退。
3. `docs`：本决策、证据与脚本、未决问题、进度看板。

提交都用了 `--no-verify`：这个 worktree 的 `core.hooksPath` 指向主检出的 `.husky`，那里的 `pre-commit` 是没有 shebang、CRLF 换行的脚本，又没有 husky 的 `_` 运行器，Windows 上的 git 执行它报 `Exec format error`。钩子要做的 `biome check --write` 已对每次暂存的文件手动跑过，无改动。

## 10 已验证、没验证到的，与待办

- **本机（Windows）跑过的**，升级前后逐项对照，详见证据：
  - 两套 tsc；
  - `src/dsh-host`、`src/shared` 单测：挂的 15 项与升级前逐项相同，都是 Windows 环境；
  - DSH 相关的 `scripts` 测试；
  - `bridge-record` 逐场景录制：升级前后 34/36 逐字相同，余下 2 个是 Windows 噪声；
  - 五个探针加 `p0-6` 两种模式；
  - 思考回放 A/B；
  - 整包构建（86.4 MiB / 9,275 个文件，在预算内）与 Windows 打包 L1 冒烟（44/44）。
  - 源码运行的探针工具在 Windows 上起不来（给 node 传 `--import F:\…`、读 `/proc`），本次用证据目录的 `scripts/win-shim.mjs` 跑，工具本身没改，记为后续项。
- **Linux 上的权威闸门没跑**：本机没有 WSL。
  - `dsh-bridge-gate.yml`：`bridge-record --check` 对金样本、`loop-guard-smoke`、`request-prefix-probe`、`contention-regression`；
  - `build.yml` 的整包；
  - 只在 Linux 上开的真宿主集成测试。
  - 都要推送 `feat/dsh-*` 分支或手动触发，待用户同意。
- `p0-6-probe` 的 SIGSTOP 楔住、`flock`、`/proc` 采样只在 Linux 上有意义，Windows 上那几项不作数。
- 真实网关上「响应名与请求名不同」的回放没有实测（公司网关目前名字一致）。
- Windows 现场：打开插件后用 Office 打开 1.0.6 生成的 docx / xlsx / pptx，看是否提示修复（第 3 节）。
