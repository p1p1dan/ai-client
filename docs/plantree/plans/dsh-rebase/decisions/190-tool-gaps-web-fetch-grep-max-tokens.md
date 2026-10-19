# 决策 190：补齐工具层三项差距——web_fetch、增强的 grep、自定义模型的默认输出上限，各带一个开关

日期：2026-10-14。**状态：自主决定，待用户审批。三个开关的默认值（第 5 节）请一并确认。**

来源：

- 调研[《同源同模型下 PiLab 与 Claude Code 的表现差距》](../../../../plans/2026-10-14-pilab-vs-claude-code-gap-study.md) §3.2、§7 第 4、5、7 项。该文件在分支 `docs/quality-gap-study` 上，合入后链接可用。
- 编排会话 2026-10-14 的派工：
  - 补 web_fetch、grep 增强、默认输出上限三项，每项一个开关，供另一个会话的 A/B 评测分别开关；
  - web_search 要另选搜索后端，不在本次范围；
  - 不动 `src/dsh-host/package.json` 与 `package-lock.json`，另一个会话在升级 DSH。
- 相关决策：
  - [047](047-tool-classification-and-plan-mode.md)：工具分类；
  - [048](048-filter-search-results.md)：搜索结果过滤；
  - [146](146-real-gateway-followups.md) 第 9 条：输出上限超过窗口一半时按四分之一；
  - [157](157-outbound-proxy.md)：宿主不装出站代理；
  - [168](168-custom-service-model-settings-panel.md)：模型设置面板；
  - [177](177-auto-compaction-policy-per-model.md)：按模型的自动压缩；
  - [090](090-user-rulings-2026-09-28.md)：默认跟随 DSH。

证据：[tool-gaps-2026-10-14](../evidence/tool-gaps-2026-10-14/README.md)（四种开关组合的抓包、真宿主用例、录制门禁对照）。

## 1 结论

1. **三项都已实现，默认打开。** 每项一个环境变量，值为 `0` 时恢复改动前的行为。四种组合都抓过包，全部为 `0` 时，请求形状与调研的基线逐项相同。
2. **web_fetch**：
   - 只打开 DSH 的匿名 HTTP 抓取，web_search 仍然关闭；
   - 权限上归为「网络访问」：按主机名判定，按现有档位审批；
   - 「本会话允许」只记住这个主机；
   - 计划模式下可用。
3. **grep**：
   - DSH 的 `tool-fs-search` 把 glob 与 grep 放在同一行，没法只去掉 grep；
   - 所以换成我们自己的 `aiclient-fs-search` 行：glob 原样用 DSH 的，grep 是我们的；
   - 我们的 grep 有 13 个参数，带输出模式、上下文、忽略大小写、文件类型、多行、分页。
4. **默认输出上限**：
   - 只改「没写输出上限的推理模型」：anthropic-messages、openai-responses 给 32,000，openai-completions 给 16,384；
   - 都不超过窗口的四分之一，也不低于原来的 8,192；
   - 没写上限时，设置面板提示用户填写。

## 2 web_fetch

### 2.1 组合

改动集中在 `bundle/cordis.patch.yml` 的「Decision 190: tool gaps」一段。原来那段关掉 web 四行的配置，就地改成这一段。

| 行 | 本次 | 说明 |
|---|---|---|
| `web` | 打开，`fetchProvider: http` | id patch 整体替换 config，dsh-base 的 `searchProvider: deepseek-official` 不再写 |
| `web-fetch-http` | 打开，用 DSH 默认 | 只取公网地址：每个解析结果都核对并钉住连接，重定向只能同源，最多 5 次；不带凭据；响应 5 MB、正文 10 万字符、30 秒；UA `deepseek-harness/0.0.1` |
| `tool-web` | 打开，`search: false`、`fetch: true` | 只注册 `web_fetch`，没有 `web_search`；输出上限 20 万字符，超过 spill-policy 的 12,500 token 时转存 |
| `web-search-deepseek` | 仍关 | 官方 DeepSeek 端点（P0-2），本来就在 `REQUIRED_DISABLED` |

- `hostProfile.ts`：
  - 必关清单里只有 `web-search-deepseek`，web 其余三行不在其中，可以打开；
  - 必开清单不变。
- 插件审查守卫（`scripts/dsh-plugin-review-guard.mjs`）：
  - 只扫描白名单插件，以及产品 bundle 插入、挂别的包的行；
  - web 三行是 dsh-base 自己的行，这里只是 id patch，不在扫描范围；
  - 新行 `aiclient-fs-search` 挂的是本 bundle 的模块，所以加进 `OWN_PRODUCT_ROWS`。守卫、它的测试与构建脚本的 `BRIDGE_ENTRIES` 三处同步改了。
- **网络**：宿主不装出站代理（决策 157 的现状 A）。web_fetch 与模型请求一样直连，不经过公司网关，也不跟随设置里的代理。
- 工具说明与提示词段都是 DSH 原文，没有改。
  - 说明：「Fetch the content of a specific HTTP(S) URL and return it decoded to text.」
  - 提示词段：结果是不可信的外部内容，引用时附上 URL。

### 2.2 权限：网络访问

- 新分类 `network`（`permissions/classification.ts`），只有 `web_fetch`。`web_search` 不组合，仍是 `generic`。
- 请求（`requestBuilder.ts`）：
  - `policySurface: web_fetch`；
  - `policyValue`：URL 的主机名，小写、不带端口。解析不了的 URL 用原文，抓取本身会拒绝它；
  - `network: true`；
  - 卡片正文是 URL，标签「网址」。
- 闸门（`src/shared/permissions/gate.ts`）：
  - 档位：ask、accept-edits 弹卡；auto、bypass 放行。这与改动前 `generic` 的结果相同。
  - 策略可以按主机写，例如 `"web_fetch": {"*": "ask", "*.python.org": "allow", "evil.test": "deny"}`：
    - `deny` 在任何档位都拒绝；
    - `allow` 在 ask、accept-edits 下也不弹卡；
    - 随包策略没有 `web_fetch` 规则，按 `'*': 'ask'`；
    - 没有策略对象时一律问。
  - 不按工作区路径问：请求里的 path 只是会话的工作区，`~/.pilab` 一类路径规则不适用。
  - **计划模式放行**，仍按档位问：抓网页不改工作区，与读文件同类。改动前 `generic` 在计划模式下被拒绝。
- 会话授权（`grants.ts`）：
  - 「本会话允许」记住的是这个主机，同一站点的其他页面不再问，别的站点照常问；
  - 以前 `generic` 记住的是整个工具，允许一次就等于以后所有网址都放行；
  - 卡片说明：「「本会话内允许」会记住 web_fetch 可访问 example.com 的所有页面」。
- 卡片：新动作 `fetch_url`，标题「web_fetch — 获取网页」。
- 真宿主用例证实：ask 档下只有 `web_fetch` 弹卡，答拒绝时请求不会发出（证据 §2）。

### 2.3 工具行

- 动词「获取」、web 图标、参数为 URL：P1-7c 已经预先映射好，这次没有改。
- 新增结局尾注，位置与语气同退出码：
  - 状态码不是 2xx：「· HTTP 404」；
  - 正文被截断：「· 已截断」；
  - 失败的调用照旧是红色加错误正文。

### 2.4 开关

`AICLIENT_RUNTIME_WEB_FETCH=0`：

- 三行的 `disabled: !!js "process.env.AICLIENT_RUNTIME_WEB_FETCH === '0'"` 生效，组合与改动前相同。
- Main 照决策 173 的做法转发这个变量（`dshHostEnvironment.ts` 的 `FORWARDED_ENV`）。

## 3 grep

### 3.1 为什么换掉 tool-fs-search 这一行

- `dsh-tool-fs-search` 的一行同时注册 glob 与 grep，没有只关 grep 的配置。同名工具再注册一次会直接抛错。
- 所以产品 bundle 关掉 `tool-fs-search`，插入 `aiclient-fs-search`（`src/dsh-host/fsSearch/`）：
  - glob 调用 DSH 导出的 `applyGlobTool`，原样注册，提示词段与超量转存都照旧；
  - grep 是我们的；
  - 配置字段与默认值照搬 `tool-fs-search`，`sampleOverCapGlobResults: false` 与 dsh-base 相同。
- 开关关闭时，这一行改为调用 DSH 导出的 `applyGrepTool`，组合与改动前等价。

### 3.2 工具形状

说明文字都是自己写的，没有照抄 Claude Code。

- **参数**：13 个，`pattern`、`path`、`glob`、`type`、`output_mode`、`-A`、`-B`、`-C`、`-n`、`-i`、`multiline`、`head_limit`、`offset`。
  - 名字与 Claude Code 的 Grep 相同，模型熟悉这套名字；
  - 没有做 `-o`；
  - Claude Code 的 `context`（等于 `-C`）不写进 schema，但传了也认，参数根是开放的。
- **默认值**：`output_mode` 为 `files_with_matches`（与 Claude Code 相同），`head_limit` 250，`-n` 开。
- **输出**：
  - 首行是总数：`Found 3 files`、`Found 12 matching lines in 3 files`、`No matches found`；
  - content 模式用 ripgrep 的原样格式：`path:line:text`，上下文行 `path-line-text`，不相邻的组之间是 `--`；
  - count 模式：`path:count`；
  - 超出 `head_limit` 时，末尾写清下一页的 offset：「(Showing lines 1-250 of 600. Call grep again with the same arguments and offset: 250 for the next page, or narrow the search.)」；
  - `offset` 超过总数时也说明总数。
- **顺序**：
  - content 与 count 按路径排，分页需要稳定的顺序；
  - files_with_matches 按修改时间新到旧，与 glob 一致，同一时间再按路径。
- **范围**：
  - 搜隐藏文件，例如 `.github`；遵守 `.gitignore`；
  - VCS 元数据不搜：用 DSH 的 `GLOB_VCS_EXCLUDES`，放在所有 glob 之后，调用方的 glob 盖不过它；
  - DSH 的 grep 不搜隐藏文件。
- **长度**：
  - 每行最多 2000 字节（沿用 `grepMaxLineBytes`），超出时加「(line truncated)」；
  - ripgrep 原始输出仍以 20 MB 为限，超出时提示缩小范围或换用 files_with_matches、count。
- **部分失败**：ripgrep 退出码为 2 但有结果时（例如某个目录没有读权限），照常返回结果，并在末尾附「(Some paths could not be searched: …)」。DSH 的 grep 遇到这种情况整个调用失败。
- **不做转存**：用分页代替。结果过大时仍有 spill-policy 兜底。
- **没有声明** `presentationMeta`：我方界面不读它，日志也更小。没有声明 `isConcurrencySafe`，与 DSH 的 grep 一致。
- **提示词段**：沿用 `tool:grep` 的名字和 `TOOL_GREP` 的位置。文字改为：不要用 shell 的 grep、rg 或 Select-String；大范围搜索先用 files_with_matches 或 count，再用 content 加 `-C` 看需要的行。

### 3.3 权限

- 闸门不变：grep 仍是 `search` 类，按 path 判定；随包策略是 `grep: allow`。
- 结果过滤（决策 048）扩展到新的值形状 `entries`。每一条都带 path，三种模式通用：
  - `.env`、`*.key` 等在结果里删掉，首行总数与分页都按删完以后计算；
  - 隐藏文件进入搜索以后，`.env` 的内容靠这一步挡住，与 glob 的做法相同；
  - 真宿主用例证实了这一点（证据 §2）。

### 3.4 工具行

- 参数摘要在 pattern 后接文件过滤（`glob`、DSH 的 `include` 或 `type`），例如「搜索 TODO · *.ts」。路径、模式、上下文与分页参数在展开的输入里。
- 结局尾注：「3 个文件」「12 处匹配」「无匹配」。DSH grep 的「Found 7 matches」也认，开关关闭时同样有尾注。
- 命中列表浮层（`toolHits.ts`）新认：
  - count 行；
  - 上下文行，只认本输出里匹配行用过的路径，因为 `a-1-b.ts` 本身可能就是文件名；
  - 新的首行与括号说明。

### 3.5 开关

`AICLIENT_RUNTIME_RICH_GREP=0`：`aiclient-fs-search` 改为注册 DSH 的三参数 grep。Main 转发这个变量。

## 4 默认输出上限

### 4.1 规则

`defaultMaxTokensFor` 在 `src/shared/dshModelPlan/tables.ts`，计划与设置面板共用。

| 行 | 输出上限 |
|---|---|
| 推理行，没写 `maxTokens`，anthropic-messages | 32,000 |
| 推理行，没写 `maxTokens`，openai-responses | 32,000 |
| 推理行，没写 `maxTokens`，openai-completions | 16,384 |
| 非推理行，没写 `maxTokens` | 8,192（不变） |
| 写了 `maxTokens` | 照写的，超过窗口一半时仍按决策 146 处理 |

- 三个推理默认值都不超过窗口的四分之一（决策 146 的比例），也不低于 8,192。没写窗口时按 128,000 算。
- 「推理行」指计划判为推理的模型（`reasoningEfforts` 不是 `false`）。自适应思考的行也算。
- 计划直接把这个数写进该行的 `maxTokens`。数值等于路由默认的 8,192 时不写，所以计划只在数字真正变化的地方变化。
- 托管目录的模型都写了输出上限，不受影响。随包目录的计划金样本（MP-01）没有变化。
- 为什么是这几个数：
  - 思考与回复共用这个额度。8,192 在高档位思考时，连一次整文件写入都放不下。
  - Anthropic 自 Claude 3.7 起的模型都接受 32,000，Opus 4 / 4.1 的上限正好是 32,000。OpenAI Responses 自 GPT-4.1 与 o 系列起的模型都接受 32,000。
  - OpenAI 兼容服务差别最大：DeepSeek 的非推理模型、部分 Qwen 只到 8K。所以这一类只给推理行，而且只加到 16,384。
  - 非推理行维持 8,192：老模型（Claude 3.5 Haiku 8,192、GPT-4o 16,384、deepseek-chat 8K）不会因为默认值变大而每次都被 400 拒绝。
  - 不跟随 DSH 自己的 32,768 / 262,144：默认窗口调大，会让没写窗口的小窗口模型溢出，这超出本次范围（决策 168 第 5 节「不做」）。

### 4.2 与决策 177 的核对

公式与规则都没改。宿主（`sizedModel`）、Main 的模型菜单（`autoCompactionOf`）都读计划行上的数，设置面板用同一个函数，三处结果一致。按 `autoCompactionPolicy` 实算：

| 窗口 / 原输出上限 → 新输出上限 | 原来 | 现在 |
|---|---|---|
| 128,000（没写）/ 8,192 → 32,000（anthropic 推理） | 约 54,272 触发，摘要 8,192 | 约 39,936 触发（压缩跨度不够 24,576，余量调小），摘要 32,000 |
| 128,000（没写）/ 8,192 → 16,384（completions 推理） | 54,272，摘要 8,192 | 46,080（DSH 默认），摘要 16,384 |
| 200,000 / 8,192 → 32,000 | 126,272，摘要 8,192 | 102,464，摘要 32,000 |
| 64,000 / 8,192 → 16,000（四分之一） | 33,505（余量已调小），摘要 8,192 | 32,256，摘要 15,744（受余量约束） |
| 32,768 / 8,192（四分之一正好 8,192） | 不会自动压缩（窗口太小） | 不变 |
| 1,000,000 / 8,192 → 32,000 | 800,000，摘要 8,192 | 800,000，摘要 32,000 |

- 代价：没写窗口的推理模型，自动压缩从约 54k 提前到约 40k（anthropic）或约 46k（completions）。真实窗口更大的服务，在「模型设置」里填上窗口就能恢复。
- 好处：手动与自动压缩的摘要上限也随之变大，摘要被截断的风险下降（决策 177 风险 1）。

### 4.3 设置面板

- 输出上限的占位文字「默认 N」：N 按当前接口风格、推理开关和窗口实时计算。
- 留空时，输入框下方提示：「留空时按 N 预留，思考和回复共用。请按服务商文档填写输出上限：超过模型允许的值，每次请求都会被拒绝；太小，长回复会被截断。」
- 填了以后，推理开着时仍是原来那句「思考也计入输出上限；高档位建议 32000 以上。」
- 自动压缩说明行按新的默认值计算。
- 面板总是按新规则计算。开关是 Main 读的评测开关，渲染层看不到它。

### 4.4 开关

`AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS=0`：

- Main 读它（`piModelConfig/index.ts`），传给计划 `settings.defaultMaxTokens: 'flat'`；
- 计划与改动前逐字节相同：测试断言 flat 计划里没写上限的行仍然没有 `maxTokens`；
- 评测脚本直接给 `buildDshModelPlan` 传 `settings.defaultMaxTokens`；
- Main 每个计划修订号记一行 `[dsh-plan] default output limit: …`。

## 5 开关汇总（请确认默认值）

| 开关 | 默认 | 谁读 | 为 `0` 时 |
|---|---|---|---|
| `AICLIENT_RUNTIME_WEB_FETCH` | 开 | 产品补丁里的 `!!js`（宿主）；Main 转发 | 不组合 web 三行，没有 `web_fetch` |
| `AICLIENT_RUNTIME_RICH_GREP` | 开 | `aiclient-fs-search` 行；Main 转发 | 注册 DSH 的三参数 grep |
| `AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS` | 开（`protocol`） | Main 建计划时 | 没写输出上限的行一律 8,192 |

- 只有确切的值 `0` 才关闭，与 `AICLIENT_RUNTIME_LOOP_GUARD` 等现有开关一致。
- 宿主每次启动记一行，例如 `[dsh-host] tool switches: web_fetch on, grep rich`；关闭时写出变量名。Main 记默认输出上限的模式。评测报告可以据此记录当时用的是哪个版本（工程规范 §15）。
- 三个开关都是环境变量，不进设置页：它们用于评测与回退，用户不需要看到。

## 6 改动的文件

- 宿主：
  - `bundle/cordis.patch.yml`：决策 190 一段；
  - `bundle/package.json`：导出 `./fs-search`，peer 加 `dsh-tool-fs-search`、`dsh-tools`；
  - `bundle/lib/fs-search.js`（新，源码运行的转发）；
  - `fsSearch/`（新：`plugin.ts`、`grep.ts`、`grepTool.ts` 与测试）；
  - `lib/toolSwitches.ts`（新）；
  - `host.ts`：启动时记开关那一行；
  - `tsconfig.json`；
  - `permissions/`：`classification.ts`、`requestBuilder.ts`、`searchFilter.ts`，`permissionHost.ts` 与 `plugin.ts` 只改了注释；
  - `tools/fake-gateway.mjs`：新脚本 `P1-TOOLGAPS`；
  - `tools/bridge-record.ts`：`--import` 改传 file URL，Windows 才能运行。
- 共享：
  - `dshModelPlan/`：`tables.ts`、`build.ts`、`types.ts`、`index.ts`；
  - `permissions/`：`gate.ts`、`grants.ts`、`cardEmitter.ts`；
  - `types/runtimeEvents.ts`：动作 `fetch_url`、授权范围 `host`；
  - `i18n.ts`：文末「Tool gaps (decision 190)」一块，共 10 条。
- Main：
  - `agent-host/dshHostEnvironment.ts`：转发两个开关；
  - `piModelConfig/index.ts`、`dshModelPlan.ts`：读第三个开关、记日志。
- 渲染层：
  - `chat/toolCard.ts`、`ToolRows.tsx`、`toolHits.ts`、`questionCardModel.ts`；
  - `settings/ModelSettingsPanel.tsx`、`autoCompactionText.ts`。
- 构建与守卫：`scripts/dsh-host-build-lib.mjs`（新行与必备文件）、`scripts/dsh-plugin-review-guard.mjs`。
- 金样本：
  - `src/shared/__tests__/fixtures/dsh/` 下 36 个 `log.*.json` 的工具列表加 `web_fetch`；
  - `perm-search` 的三份按新 grep 的输出更新（见 §7）。
- 文档：本决策、证据目录、`CLAUDE.md` 的代码入口。
- 没有改 `src/dsh-host/package.json`、`package-lock.json`，也没有改任何 `@deepseek-ai/` 包的文件。

## 7 验证（2026-10-14，Windows 10，Node 24.12）

- 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`）通过。改动文件过 `biome check`。
- vitest：
  - 新增：
    - `fsSearch/__tests__/grep.test.ts`（30）；
    - `grepTool.test.ts`（12，在真实的随包 ripgrep 上跑）；
    - `plugin.test.ts`（7）；
    - `shared/permissions/__tests__/networkGate.test.ts`（9）；
  - 扩展：计划（决策 190 一组 7 例）、Main 计划、设置面板、工具行词表与命中列表、审批卡、权限行、宿主静态、构建与守卫的测试。
  - 按目录跑 `scripts`、`src/dsh-host`、`src/shared`、`src/main/services/piModelConfig`、`agent-host`、`src/renderer/components/chat`、`settings`：
    - 失败的全部能在基线 `79f81cdb` 上同机复现，属于本机环境：符号链接需要权限、8.3 短名、systemd、Linux 专属路径；
    - 另有两例是负载下超时，单独跑时通过。
- 真宿主：`AICLIENT_DSH_INTEGRATION=1` 跑 `src/dsh-host/__tests__/toolGaps.integration.test.ts`，2 例在本机 Windows 上通过（证据 §2）。
- 抓包：四种开关组合，见证据 §1。
- `bridge-record.ts --check`：
  - Windows 上基线与本分支都跑不完，原因是平台：没有 bash、路径分隔符、本机 skills；
  - 同机对照后，金样本只改了本次改动带来的两类差异，改完以后两边的差异清单逐字相同（证据 §3）；
  - **请在 Linux 上复核一次 `--check`**，预期没有差异。
- `bridge-smoke.ts`：读 `/proc`，只能在 Linux 上跑，本机没有跑。
- 没有起 Electron，没有做 GUI 点验，没有连真实网关，也没有抓取真实网页。

## 8 风险与后续

1. **网页内容是不可信输入**：
   - DSH 的说明、提示词段和结果头都写明了「外部内容，当作数据，不当作指令」；
   - ask、accept-edits 下每个新主机都会问；auto、bypass 下不问。
2. **URL 本身可以带出数据**，例如查询参数：卡片显示完整 URL，auto 档下不经确认。
3. **直连**：需要代理才能上网的网络里，web_fetch 取不到页面（决策 157）。
4. **默认输出上限**：上限低于这里默认值的推理模型会被每次 400 拒绝，填写输出上限即可。可能的例子：经 OpenAI 兼容接口的推理模型上限不到 16,384；经 Anthropic 兼容端点、又开了推理的第三方模型上限只有 8K。设置面板留空时的提示就是为这种情况写的。
5. **grep 默认改为列文件**：习惯 DSH grep 的模型，第一次可能要多调用一次。可以用 A/B 评测量化。
6. **关闭 web_fetch 后模型仍调用它**（例如旧会话的历史里有）：
   - 权限行在 DSH 判定工具不存在之前，就按名字判定，所以照样弹卡；允许后 DSH 报 `unknown tool`；
   - 这是既有行为，任何不存在的工具名都一样；
   - 可以另做：没注册的工具不弹卡。
7. **提示词包会话**：若按工具名改写 grep 的说明，要按新的参数来写，已在共享笔记里说明。
8. **DSH 升级**：
   - `aiclient-fs-search` 用到 `dsh-tool-fs-search` 导出的 `applyGlobTool`、`applyGrepTool`、`resolveRgPath`、`SearchError`、`toWorkdirRelative`、`GLOB_VCS_EXCLUDES` 与默认常量；
   - 升级时要核对这些导出；构建测试的桩列出了全部名字，缺了会失败。
9. **没有做 GUI 点验**：工具行尾注、设置面板提示、审批卡的新文案，要在 CI 包上看一眼。

## 9 审批要点

1. web_fetch：
   - 默认打开；
   - 计划模式下可用；
   - 会话授权按主机记住；
   - 策略里按主机写的 `allow` 不弹卡。
2. grep：
   - 默认 files_with_matches；
   - 搜索隐藏文件；
   - 文件列表按修改时间排序；
   - 用分页代替转存。
3. 默认输出上限：
   - 三个数字，以及「只改推理行」；
   - 没写窗口的推理模型，自动压缩提前到约 40k 或 46k。
4. 三个开关的名字与默认值（全开）。
5. 金样本是按 Windows 上的对照手工改的，没有在 Linux 上重录。

## 用户审批

待审批。
