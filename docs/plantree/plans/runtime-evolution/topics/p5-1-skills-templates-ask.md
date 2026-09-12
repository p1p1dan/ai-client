# 第 7 批 · skills / 模板 / 通用提问 / MCP bridge（P5-1、P5-3）

Role: implementation-plan。日期：2026-09-12。对应[执行顺序](../README.md#执行顺序)第 7 批。
依据：[ARD §5 P5 范围](../../../plans/2026-09-08-runtime-evolution-ard.md)、[F5 定性](../../../plans/2026-09-09-gui-defect-decisions.md#f5--无提问工具questioncard--扩展问答弹不出来)。

## 这一批要补的是「旧后端有、自有 runtime 没有」的四件事

不是四个新点子。除 MCP 外，另外三件在 legacy 后端上**已经能用**，切到 native 就消失了：

| 能力 | legacy | native（本批之前） |
|---|---|---|
| 技能进系统提示词、`/skill:name` 展开 | pi 的 `resourceLoader` 扫盘 + `session.prompt()` 展开 | 无。`segments.ts` 的 `skills` 槽挂着 P5 延期声明 |
| 提示词模板 `/name` 展开 | pi 的 `promptTemplates` | 无 |
| 斜杠菜单列表 | `commandInventory.ts` 汇总三类 | `nativeWorkerRuntime.commands()` 固定返回空表 |
| 通用提问（问答卡） | **也没有**（F5：全仓无生产者） | 同左 |

所以 K1～K3 的验收基准是**与 legacy 对齐**，K3 的基准是[原型/功能定义](../../gui-sdk-experience/TODO.md)里 C/8 那张卡。

## 批内顺序与理由

1. **K1 skills**：填一个**已声明**的空槽（`segments.ts:84` 的 `skills` 延期理由写的就是「加载器与 Skill 工具都是 P5-1」），不需要新宿主能力、不动 GUI，是四块里最独立的一块。
2. **K2 模板与命令表**：与 K1 共用同一套「扫 `.md` + 读 frontmatter」的加载器，产出直接喂已经存在的 `worker.commands` → `chat:getSlashCommands` → 补全菜单，渲染层零改动。
3. **K3 F5 通用提问**：需要 runtime 工具 + 事件 + RPC + IPC + store + 一个渲染位的整条纵切。放在 K1/K2 之后，是因为它照抄 `worker/permissionPrompt.ts` 的形状，而那条链要先稳定。
4. **K4 MCP bridge**：唯一需要**新增宿主能力**的一块——ARD D11 第 4 条点名「MCP stdio bridge」必须收敛到两个 service 出口，而现有 `runtimeExec.run` 是一次性调用，没有长驻子进程。风险最高，排最后；即使它滑期，前三块也已各自可验收。

## K1 · 技能加载、目录段与 `skill` 工具

- **发现位置**（与 pi `docs/skills.md` 一致，路径换成本应用的统一 agent 目录）：
  - 全局：`<agentDir>/skills/`、`~/.agents/skills/`
  - 项目：`.pi/skills/`、`.agents/skills/`，**仅在 `projectTrusted` 为真时**加载
- **读取一律走 `runtimeHostIo`**（D11 第 4 条点名 skills 加载）。不用 pi-agent-core 的 `loadSkills`：它要一个 `ExecutionEnv`，而那条路读文件绕开我们的 TSD 兜底。`Skill` 的字段形状仍与 pi 对齐。
- **提示词段**按 [agentskills.io](https://agentskills.io/integrate-skills) 的 XML 块进 `skills` 槽，`stability: 'session'` 不变，删掉 `SlotDeferral`。
- **`skill` 工具**而不是让模型用 `read` 去读：技能文件在工作区外，`permissions/index.ts` 对 cwd 外的路径判 `ask`，用 `read` 会让每次加载技能都弹一次权限卡。`skill` 工具按**名字**从已扫到的目录取内容，不接受任意路径，注册为 `read` 档。

## K2 · 提示词模板与斜杠命令表

- `<agentDir>/prompts/*.md`、项目 `.pi/prompts/*.md`（同样受 `projectTrusted` 约束），frontmatter 取 `description` 与 `argument-hint`。
- **展开在发送路径**：`/name args` 展开成模板正文，`/skill:name args` 展开成技能正文加 `User: args`（pi 的行为）。展开后的文本才进 `handle.run()`。
- `NativeWorkerRuntime.commands()` 返回真实行，字段沿用 `WorkerSlashCommandInfo`，不新增形状。

## K3 · F5 通用提问

- runtime 侧新增 `ask` 工具，参数与 `QuestionItem` 对齐（question / header / options / multiSelect）。
- worker 侧 `questionPrompt.ts`，与 `permissionPrompt.ts` 同构：发 `question.requested`，等 `worker.question.respond`，超时与 dispose 都按「未作答」收尾并发 `question.resolved`。
- 链路补齐：`worker.question.respond` RPC → `chat:respondQuestion` IPC → preload → store `respondQuestion` → **可作答的卡片渲染位**。
  注意 `QuestionCard` 的 `variant="interactive"` 目前**全仓无渲染点**，`MessageTimeline` 只渲染 `frozen` 与 `permission`；这一半也要补，否则事件到了也看不见。

## K4 · MCP bridge（P5-3）

- 先给 exec 出口加长驻子进程能力（spawn / 双向 stdio / dispose 清理 / Windows 进程树），再写最小 MCP stdio 客户端（`initialize`、`notifications/initialized`、`tools/list`、`tools/call`）。
- 不引 `@modelcontextprotocol/sdk`：它自己 spawn 子进程，正是 D11 第 4 条要收敛掉的那件事。
- MCP 工具注册进 `runtimeTools` 时带命名空间前缀，权限按 `write` 档处理（服务端能做什么由服务端决定，本地无法静态判定）。

## 验收

每块各自可验收，不互相等：

1. K1：真实技能目录扫出目录段；`skill` 工具按名取到内容；工作区外路径不经 `read` 弹卡。
2. K2：补全菜单在 native 后端下列出技能与模板；`/name` 与 `/skill:name` 真实展开后发送。
3. K3：真实回合里模型调用 `ask` → 卡片出现 → 作答 → 模型拿到答案继续。
4. K4：真实 MCP server（stdio）被拉起、`tools/list` 有结果、`tools/call` 真实往返、dispose 后进程不残留。

## 范围外

- P5-2 subagent 整体复刻（第 8 批）。
- 技能/模板的**安装与管理界面**（H/19 的插件面板管的是 pi 包，不是技能目录）。本批只做加载与使用。
- 加密机现场回归：按 2026-09-11 的规矩并入最后一次上机。
