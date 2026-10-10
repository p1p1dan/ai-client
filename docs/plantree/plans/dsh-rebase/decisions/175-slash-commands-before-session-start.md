# 决策 175：没有启动的对话里的斜杠命令——首页不提供、手打拦下需要已有对话的命令；没启动时菜单也列出工作区的 skills（GitHub issue #6 后续）

日期：2026-10-10。**状态：第 1 节为用户要求（2026-10-10）；第 2 节起为自主决定，待用户审批。**

来源：[决策 174](174-home-page-and-composer-draft-target.md) §2.8 末行与 §6 风险 8（首页上输入 `/compact`、`/archive` 会当普通消息发出）；用户 2026-10-10 追问「当前对话未启动阶段斜杠命令好像是无法触发 skill 什么的吧？这个怎么修复」。代码提交：`870ff1f0`。

修订关系：

- [决策 174](174-home-page-and-composer-draft-target.md) §2.8 末行、§6 风险 8：本决策修掉——首页菜单不提供这两条，手打时就地提示、不发出。
- [决策 113](113-p1-4d2-commands-and-projection-choices.md)（菜单 = DSH 命令 + 用户可调用的 skills，`/compact` 由窗口自己跑）：不变。本决策只在「宿主上没有这个工作区的就绪会话」时，由 Main 按 DSH 的规则读盘补上 skills。
- main-host-01（`WorkerManager.getSlashCommands` 只认同一工作区的 worker 作替身）：规则不变，扩展为按渲染层报上来的工作区匹配；去掉「不点名时取池里第一个就绪 worker 的整份清单」——首页会因此拿到别的仓库的 skills。
- [决策 101](101-instructions-and-skills-dsh-native.md)（`<agentDir>/skills` 作宿主的 `customSkillDirs`）：不变，Main 读同一套目录。
- [决策 166](166-permission-menu-single-column-and-goal-entry.md)（`/goal <目标>` 发出时切姿态）：不变。首页上的 `/goal <目标>` 照常发出，以这个目标开始新对话。

## 1 用户要求（2026-10-10）

1. **首页上的会话类斜杠命令**：首页（没有当前对话）时，斜杠菜单不提供 `/compact`、`/archive` 这类必须作用于已有对话的命令；用户手打并发送时不当普通消息发给模型，就地提示（例如「这个命令需要先打开一个对话」），样式照输入框现有的提示惯例。穷举所有「需要已有对话」的内置命令，以真实代码为准逐个判定。
2. **没启动阶段的 skills**：先查清命令清单从哪里来、skill 在已启动会话里怎么触发、「未启动」（首页、刚建好还没在宿主上启动的对话、宿主重启后尚未恢复的对话）各缺哪一环，再修：首页与没启动的对话里，菜单也列出该工作区可用的 skills（用户级与项目级，按草稿目标或对话的工作区算），选中或手打 `/skill-name` 发送后，在会话启动后被当作 skill 调用，与已启动会话一致。需要改 bridge 协议、宿主或依赖 DSH 内部行为的先不改、汇报。

## 2 现状与根因（HEAD `7daab4f8` 上逐条核实）

### 2.1 菜单的清单从哪里来

| 环节 | 位置（改前） | 做什么 |
|---|---|---|
| 渲染层 | `ChatComposer.tsx:1725` | 菜单一打开就调 `chat.getSlashCommands(activeSessionId ? { sessionId } : {})`：只带会话 id，不带工作区 |
| | `slashCommands.ts` `buildSlashCatalog` | 宿主的答复 + 窗口的四个内置命令（`new`、`settings`、`archive`、`compact`），同名时宿主的赢 |
| Main | `WorkerManager.ts:1481-1511` | 点名会话的 worker 就绪 → 问它；就绪不了 → 找同一 cwd 的就绪 worker；池里没有这个会话 → 空；**不点名（首页）→ 池里第一个就绪 worker 的整份清单，不管它在哪个仓库** |
| bridge | `dshSessionRuntime.ts:1577-1582` | 还没有 agent（没 bootstrap）就答空；否则 `slashCommandRows(ctx.commands.list(agent), ctx.skills.list({ cwd: 会话的工作区, scope: agent }))` |
| | `commands.ts:118-141` | DSH 命令（去掉 `plan`、`permission`、`feedback`，`compact` 归窗口）+ `user-invocable` 的 skills，用裸名 |
| skills 的来源 | `dsh-skill-filesystem` 0.1.7-rc.2，README「Roots and priority」 | `<项目根>/.dsh/skills`、`<项目根>/.agents/skills`（项目根 = 最近的 `.git` 祖先）、`<agentDir>/skills`（`hostProfile.ts:171`）、`<DSH_HOME>/skills`、`~/.agents/skills` |
| Main 自己 | `src/shared/skills/`、`piResources.ts` | 前者是 1.0.x pi 的规则（`.pi/skills` 等），只给旧资产提示用（`detectLegacyAssets.ts`）；后者只给设置页两个目录。**Main 没有列 skills 的入口** |

结论：菜单里的 skills 只可能来自宿主上**这个工作区已经启动并就绪的会话**。

### 2.2 已启动会话里 skill 是怎么被触发的

- **渲染层不做转换**：选中菜单项只是把 `/名字 ` 填进输入框（`replaceSlashCommand`）；发送时 `runBuiltinSlash` 对 skill 返回 false（`resolveSlashAction` 给 `runtime`），原文交给 `runSend`。
- **bridge 不认 skill**：`dshSessionRuntime.ts:1433-1467` 的 `startSend` 先 `bootstrap()`，`commandFor`（1491-1502）只认 DSH 注册过的命令（`commands.find(agent, name)`）；skill 不是命令，于是作为正文 `agent.followup(createUserMessage({ source: { kind: 'user' } }))`（1458-1466）。没有专门的 skill RPC。
- **DSH 的手势**：`dsh-tool-skill` README 第 54、88 行——在被取走（claimed）的用户消息里找空白分隔的 `/名字`，是工作区目录里 `user-invocable` 的 skill，就把它的 `<skill_content>` 注入这一步；不认识的名字照正文。
- **第一条消息同样生效**：`bridge-smoke.ts` 的宿主 H 就是这个场景——新会话的第一轮只发 `Please use /ins-skl-smoke and say hello.`（第 1024 行，skill 放在 `<agentDir>/skills`，955 行），下一轮 `P0-RECALL` 断言 skill 正文进了第一次请求（第 1848 行 `agentDirOverlaysReachedFirstRequest`）；P1-16a 时 42 项全过（看板 `implementation-status.md:285`）。

### 2.3 「没启动」各状态的表现（改前）

| 状态 | 菜单请求 | Main 的答复 | 菜单里看到 | 手打 `/skill 参数` 发出 |
|---|---|---|---|---|
| 首页（没有当前对话） | `{}` | 池里第一个就绪 worker 的整份清单；一个都没有就空 | 冷启动时只有四个内置命令；有别的对话在跑时是**那个对话所在仓库**的命令与 skills，未必是草稿目标；`/archive`、`/compact` 也在 | 在草稿目标上建对话，原文作为第一条消息；DSH 在第一步注入 skill（草稿目标的工作区里有它时） |
| 刚建好、还没在宿主上启动的对话（首发失败留下的、重启后从索引载入的） | `{ sessionId }` | 池里没有这个会话 → 空 | 四个内置命令 | create 后发出，DSH 照样注入 |
| 宿主重启、或闲置 15 分钟被回收（`DEFAULT_IDLE_TIMEOUT_MS`，`retireEntry` 把条目移出，`WorkerManager.ts:436`、`3502-3523`）后还没恢复的对话 | `{ sessionId }` | 条目还在但不就绪 → 找同一 cwd 的就绪 worker；条目已移出 → 空 | 多半只有四个内置命令 | resume 后发出，DSH 照样注入 |

### 2.4 根因

- **触发链路不缺**：skill 的调用发生在 DSH 一侧，按每条用户消息判断，首条消息也算；渲染层与 bridge 都原样转发。
- **缺的是「发现」**：菜单的 skills 只有宿主上就绪的会话答得出；Main 既不知道首页草稿目标或没启动的对话是哪个工作区，也不会自己读 skills；首页那个不点名的请求还拿了任意一个 worker 的清单（可能是别的仓库）。菜单里看不到 skill，用户自然以为用不了。
- **首页的 `/archive`、`/compact`**：`runBuiltinSlash` 在没有当前对话时 `return false`（`ChatComposer.tsx:1263`、`1274`），于是落到 `sendFromHome`（1391 行）：在草稿目标上建对话，作为第一条消息发出。

## 3 修法（自主决定，待审批）

### 3.1 首页上需要已有对话的命令（渲染层）

1. 新模块 `components/chat/homeSlashCommands.ts`：`homeSlashMenu`（首页菜单去掉 `source` 为 `builtin` 的 `archive`、`compact`）、`homeSlashRefusal`（逐条判定，见第 4 节）、`homeSlashRefusalToast`（提示文案）。
2. `ChatComposer`：
   - `slashResults` 在首页上先过 `homeSlashMenu`。
   - `runBuiltinSlash` 在 `resolveSlashAction` 与 `runtime` 出口之前判 `homeSlashRefusal`（`/goal` 是 DSH 命令，会从 `runtime` 出口离开，必须在它前面），命中就出 info toast（与 `/compact` 现有的「等这一轮结束后再压缩上下文」同一形态）并返回 true：不建对话、不发送、文字留在输入框里。
   - 标题「这个命令需要先打开一个对话」；说明「/<命令> 作用于打开的对话。请先从侧栏或「最近对话」打开一个对话，再在那里输入。」——不说「再按一次 Enter」，因为打开对话后输入框换成那个对话的草稿，首页的这行字不会跟过去。`/goal` 另一句：「要从这里开始一个目标，把目标写在 /goal 后面；查看、暂停、继续、修改或清除目标，要在目标所在的对话里进行。」
3. 带附件时照旧当消息（`runBuiltinSlash` 第一条规则「`/compact` 加三个文件是一条消息」不变）。
4. 插件或 skill 占了 `archive` / `compact` 的名字时，它照旧赢（`source` 不是 `builtin`）：菜单保留，发送照旧。

### 3.2 没启动时菜单里的 skills（Main + 渲染层；不改 bridge 协议，不改宿主）

1. **渲染层多报一个工作区**：`slashCatalogRequest(activeSessionId, effectiveCwd)`——首页是草稿目标的仓库路径（「不选仓库」时不带）；对话是它的工作目录（临时对话是已分配的临时目录，还没分配就不带）。草稿目标或目录变了就重新请求（effect 依赖加 `effectiveCwd`）。preload 的类型同步加 `workspacePath`。
2. **`WorkerManager.getSlashCommands({ sessionId?, workspacePath? })`** 改为返回 `{ commands, truncated, origin, workspacePath }`：
   - `session`：点名会话自己的 worker 就绪 → 它的清单（与以前相同）；
   - `workspace`：否则找同一工作区的就绪 worker（工作区取点名会话条目的 cwd，池里没有这个会话时取渲染层报的路径；按 `sameWorkerDirectory` 比，Windows 上不分大小写与斜杠）→ 它的清单；
   - `none`：没有这个工作区的 worker → 只取任意一个就绪 worker 清单里的**命令行**（命令注册在宿主上，与工作区无关），去掉它的 skills；一个 worker 都没有就空。
3. **`chat:getSlashCommands`**（`src/main/ipc/chat.ts`）改走 `composerSlashCommands`：`session` / `workspace` 原样返回；`none` 时 Main 按 DSH 的规则读盘，列出该工作区 `user-invocable` 的 skills（`listDshSkillsFromDisk`），排在命令之后，去掉与命令或窗口的 `/compact` 同名的（与 `slashCommandRows` 相同），上限 256。渲染层报的路径先过 `usableWorkspace`（本机绝对路径；远程、相对路径当作没有工作区，只列用户级）。读盘失败只少 skills，菜单照常（与 DSH 的 provider 发现失败时一样）。
4. **新模块 `src/main/services/agent-host/dshSkillCatalog.ts`**（纯函数，读文件走端口）：
   - 根目录与优先级照 `dsh-skill-filesystem`：项目根 = 最近的 `.git` 祖先（目录，或 worktree 的 `.git` 文件），没有就是工作区本身；`<项目根>/.dsh/skills`（100）、`<项目根>/.agents/skills`（200）、`<agentDir>/skills`（300）、`<DSH_HOME>/skills`（400，跳过 `.system`）、`~/.agents/skills`（500）；同名取 rank 小的。宿主环境剥掉了 `DSH_AGENTS_HOME`、`DSH_BUNDLED_SKILL_DIR`，所以没有 bundled 根。后三个目录由 `DshHostProcess.currentDshSkillHomes()` 用启动宿主的同一组函数算（`dshPermissionAgentDir`、`resolveDshHome`、`os.homedir()`）。
   - 条目：根目录的直接子项，`<名>/SKILL.md` 或 `<名>.md`，符号链接跟随，不往下找；按 `localeCompare` 排。
   - 头部：照 DSH 的 `parseFrontmatter` 切 `---` 块；YAML 只读一个子集（plain、单双引号、`|` `>` 块、核心 schema 的 null / bool / 数字），并拒绝 `yaml` 包会拒的写法（重复键、值里的 `: `、保留字符开头、缩进错位、制表符缩进、多余的行）；嵌套块、流式集合、标签、锚点、别名不解读（`name` / `description` 这样写时等于不是字符串）。规则：`name`、`description` 是非空字符串，`name` 是 kebab-case，`user-invocable` / `disable-model-invocation` 是严格布尔，驼峰旧键一出现就丢弃这个 skill。每个文件只读前 16KB（`MAX_SCAN_BYTES`）。
   - 不缓存：每次打开菜单读一次（与 `worker.commands` 不缓存同理：刚装的 skill 立刻能看到）。
5. **发送不改**：选中或手打的 `/skill 参数` 原文发出；会话在宿主上起来后由 DSH 的手势注入（§2.2）。

### 3.3 没有改的

- bridge 协议（`worker.commands` 等 RPC）、宿主（`src/dsh-host/`）、DSH 的任何行为都没动，不用跑 `typecheck:dsh-host`。
- 已启动会话的菜单仍是宿主的答复；Main 读盘的清单只在这个工作区没有就绪 worker 时出现，会话一起来就换成宿主的。

## 4 内置命令逐个判定

| 命令 | 归属 | 需要已有对话 | 首页菜单 | 首页手打并发送（改后） | 改前 |
|---|---|---|---|---|---|
| `/new` | 窗口 | 否 | 保留 | 停在首页、保留首页的选择、清空输入框 | 同 |
| `/settings` | 窗口 | 否 | 保留 | 打开设置 | 同 |
| `/archive` | 窗口 | **是**（归档当前对话） | 不提供 | 提示，不建对话，文字留着 | 建对话，把 `/archive` 当正文发给模型 |
| `/compact`、`/compact 说明` | 窗口（经 `worker.compact` 跑 DSH 的 `/compact`） | **是** | 不提供 | 同上 | 建对话，DSH 在空对话里把它当命令跑，答 "No compactable history yet." |
| `/goal <目标>` | DSH（`dsh-command-goal`） | 否：以这个目标开始新对话，决策 166 的姿态切换照常 | 菜单里有这一行时保留（只有宿主上有会话在跑时才有） | 建对话并设定目标 | 同 |
| `/goal`，`/goal pause / resume / clear / edit …` | DSH | **是**（作用于对话里已有的目标） | 同一行 `goal` | 提示 `/goal` 那一句，不建对话 | 建对话，DSH 答用法或 "No goal is currently set." |
| `/plan …`、`/feedback …` | DSH 注册了，但桥接不当命令（`commands.ts:88`，决策 047、113） | 不是命令，是正文 | 本来就不在菜单 | 作为正文发出，与对话里一致 | 同 |
| `/permission` | DSH 的 `permission` 行被宿主关掉（`hostProfile.ts:46`），桥接也隐藏 | 不存在 | 不在菜单 | 作为正文发出 | 同 |
| `/rewind`、`/fork` | **不存在**：回退、分叉是会话树对话框与时间线上的操作，窗口与 DSH 都没有这两个命令 | — | 不在菜单 | 作为正文发出，与对话里一致 | 同 |
| skills（`/名字`） | DSH（`dsh-tool-skill` 的手势） | 否 | **列出**（§3.2） | 建对话，原文作为第一条消息，DSH 注入 skill | 菜单里没有，或是别的仓库的；手打本来就能用 |
| 其他 `/xxx` | 插件命令或不认识的名字 | 由宿主决定 | 宿主答复里有才有 | 原文发出，由宿主处理 | 同 |

`/goal` 在首页一律按 DSH 的目标命令判定，不看菜单里这个名字的来源：行首的 `/goal` 在 DSH 那边永远是命令，同名 skill 不会被调用。

## 5 与 DSH 的一致性

- 复刻的是 DSH 公开文档里的根目录表与头部规则，并有测试钉住：差分测试在同一批临时目录上跑已安装的 `FileSystemSkillProvider`，37 个样本、两种 cwd，逐根逐字段相同；名字语法、根目录表与 rank、`.system` 规则、bridge 的 `WINDOW_OWNED_COMMANDS`、`hostProfile.ts` 的 `customSkillDirs` 各有钉住断言。DSH 升级改了这些就会失败（没装 `src/dsh-host` 依赖时跳过）。
- 已知出入（只影响启动前菜单里显示什么，不影响发出后 DSH 怎么判定）：
  1. YAML 边角写法：标签（`!!str`）、锚点与别名、文档结束标记 `...`、流式集合的缩进校验、嵌套映射里的重复键、超过 16KB 的头部。
  2. 插件用 `ctx.skills.registerProvider` / `register` 提供的 skills（例如默认关闭的 `dsh-skill-badge`）不在 Main 的清单里；目前白名单里唯一的插件 `dsh-office-tools` 不提供 skill。
  3. 启动前的菜单没有 DSH 命令（`/goal`），除非宿主上有任何一个会话在跑；手打 `/goal <目标>` 照常可用。
  4. DSH 不带 fs 服务时（节点路径）不去 BOM；宿主实际走 fs 服务、会去 BOM，Main 与它一致。

## 6 测试与验证

新增与改写：

- `agent-host/__tests__/dshSkillCatalog.test.ts`（71 项）：头部读取（各写法的期望与 `yaml` 包实测一致）、skill 规则、根目录与项目根（`.git` 目录、worktree 的 `.git` 文件、都没有）、整套列举（rank 去重、`.system`、符号链接、项目级与用户级、缺目录）、启动前合并与上限、`composerSlashCommands` 的三种来源与读盘失败、IPC 接线、对已安装 DSH provider 的差分、常量钉住。
- `agent-host/__tests__/WorkerManager.test.ts` 斜杠命令一组：10 项（改写 6、新增 4）。被替换的旧断言：「不点名时答第一个就绪 worker 的整份清单」「池里没有的会话一律答空」。
- `chat/__tests__/homeSlashCommands.test.ts`（23 项）、`homeSlashMount.test.ts`（11 项，挂载真 `ChatComposer`）、`slashCommandWiringStatic.test.ts`（改 1 项、新增 2 项）。

复现与变异：

- 把 `ChatComposer.tsx` 临时换回改前的版本跑 `homeSlashMount`：11 项中 8 项失败（首页菜单不带工作区、带着 `/archive` `/compact`；没启动的对话只带会话 id；`/compact …`、`/archive`、`/goal`、`/goal pause`、`/goal clear` 都建了对话）；另 3 项（「不选仓库」不带路径，skill 与 `/goal <目标>` 原样发出）改前就成立，作回归保护。换回后逐字节一致。
- 把头部读取的数字识别临时去掉：差分测试两项与单测四项失败。

验证（2026-10-10，开发机，一次一个测试进程，每次先看 `free -m`）：

- `pnpm typecheck`：通过。没有改 `src/dsh-host`，没跑 `typecheck:dsh-host`。
- `biome check`（14 个改动文件）：无问题。
- `pnpm exec vitest run src/renderer/components/chat`：164 个文件、3280 项。
- `pnpm exec vitest run Static Scan Wiring`：79 个文件、821 项。
- `pnpm exec vitest run src/shared/__tests__`：37 个文件、606 项（含词条覆盖）。
- `pnpm exec vitest run src/main/services/agent-host src/main/ipc src/main/services/legacyAssets`：54 个文件、894 项通过，41 项跳过（真宿主集成测试，要 `AICLIENT_DSH_INTEGRATION=1`）。
- 未做：Electron 点验；真宿主上「首页发 `/skill`」的现跑（bridge-smoke 宿主 H 覆盖同一条路，最近一次记录见看板第 285 行）；Windows（见第 8 节）。

## 7 风险

1. **规则复刻**：见 §5 的已知出入。DSH 升级若改了根目录或头部规则，钉住测试会失败；YAML 解析细节的变化只有差分测试发现得了（需要 `src/dsh-host` 装好依赖）。
2. **每次打开菜单都读盘**：skills 很多或仓库在网络盘上时，菜单里的 skills 会比内置命令晚一点出现。
3. **首页不再借别的对话的清单**：以前首页菜单（有别的对话在跑时）显示那个对话仓库的 skills，现在显示草稿目标仓库的；`/goal` 是否出现取决于宿主上有没有 worker。
4. **`/goal` 按名字判定**：用户若有一个叫 `goal` 的 skill，首页上的 `/goal`（不带目标）也会被拦下——与发出后 DSH 的判定一致（行首 `/goal` 永远是命令）。
5. **设置页的技能目录与宿主可能不一致**（已有问题，本决策没改）：设置页用 `HOME` 优先算 `~/.agents/skills`（`piModelConfig/index.ts:376`），宿主与本决策用 `os.homedir()`（Windows 上是 `USERPROFILE`）；只在 Windows 上设了与 `USERPROFILE` 不同的 `HOME` 时出现。
6. **没启动的已有对话里 `/compact`** 仍报「压缩上下文失败：No ready Pi WorkerSlot exists…」（`WorkerManager.compactSession` 要求会话就绪）；本决策没改。建议后续：先恢复再压缩，或提示「发一条消息启动这个对话后再压缩」。

## 8 Windows 现场清单（下一个测试包起）

1. **首页菜单**：输入 `/`，没有 `/archive`、`/compact`；有当前仓库的项目级 skills（`<仓库>\.agents\skills`、`<仓库>\.dsh\skills`）与用户级 skills（`%USERPROFILE%\.agents\skills`、设置页的应用技能目录）。在首页工作栏换一个仓库再输入 `/`，项目级 skills 跟着换。
2. **不选仓库**：首页选「不选仓库（临时对话）」后输入 `/`，只剩用户级 skills。
3. **拦下**：首页输入 `/compact`、`/compact 保留接口说明`、`/archive` 回车，出提示「这个命令需要先打开一个对话」，字留在输入框，侧栏不出现新对话；`/goal`、`/goal pause` 出 `/goal` 的那句提示。
4. **目标**：首页输入 `/goal 整理发布说明` 回车，建出对话，目标条出现。
5. **skill 生效**：首页从菜单选一个 skill、接一句话发送，新对话里模型按这个 skill 工作。
6. **重启后的旧对话**：重启应用，打开一个旧对话（还没发过消息、没在宿主上恢复）输入 `/`，菜单里有该仓库与用户级的 skills（以前只有四个内置命令）；发送 `/skill 参数` 后生效。
7. **闲置回收**：一个对话闲置超过 15 分钟后输入 `/`，同第 6 条。
8. **别的对话在跑**：有对话在跑时回首页、选另一个仓库再输入 `/`，列出的是首页所选仓库的 skills，不是正在跑的那个对话的。
9. **路径写法**：仓库路径的盘符大小写或斜杠与宿主记的不同时，首页菜单与该仓库里正在跑的对话的菜单一致。
10. **加密机**：首页菜单能列出 skills（Main 只读 `.md` 与目录列表）；若被拦，菜单只少 skills，发送不受影响。
11. 中文界面下两句提示完整、不截断；暗色主题下可读。

## 9 用户审批

- [x] 第 1 节（用户 2026-10-10 的要求）
- [ ] 3.1 首页菜单去掉 `/archive`、`/compact`；手打时 info 提示、不发出、文字留着；带附件仍是消息；插件同名照旧
- [ ] 3.2 Main 按 DSH 的规则读盘列出启动前的 skills；`WorkerManager` 按工作区匹配，`none` 时只借命令行；首页不再借别的仓库的整份清单；不缓存
- [ ] 第 4 节逐个判定（含 `/goal` 按有无目标分开）
- [ ] 第 5 节已知出入的接受程度
- [ ] 第 8 节 Windows 现场清单
