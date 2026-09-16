# 决策 016：Q015 结案——家目录改为独立的 user 层，全局指令对所有项目生效

日期：2026-09-16 · 拍板人：用户 · 状态：已决 · 任务：T059（批次 D3 追加，排在 T032 之前）

> 本决策在同一天内经历一次方向变更：初版为「家目录那一层改按 user 门判断」（A+D，不接 user globals 生产者）；用户看过 Claude Code 与 Codex 的实际做法后推翻了「不接生产者」那条边界，改为下方的最终方案。变更过程保留在下文「方案演进」一节。

## 问题（原 Q015）

`instructionDirectories()`（`projectInstructions.ts:97-110`）从工作区一路向上爬父目录，止于文件系统根之下。本机实测：

```
cwd = C:\Users\JC\projects\myrepo
   -> C:\Users                 <- 多用户共享目录，也在链上
   -> C:\Users\JC              <- 家目录，命中 .claude\CLAUDE.md（3760 字节）
   -> C:\Users\JC\projects
   -> C:\Users\JC\projects\myrepo
```

`INSTRUCTION_FILE_NAMES` 第 4 项是 `.claude/CLAUDE.md`，所以**家目录那一层会把用户的个人全局 CLAUDE.md 当成「项目说明书」读进系统提示**，走的是 project 层门控，而按决策 008 的设计它本该属于 user 层。

## 根源（对照业界实现后才看清）

| | 项目层扫描范围 | 全局层位置 | 是否撞车 |
|---|---|---|---|
| **Codex CLI** | git root **向下**走到 cwd | `~/.codex/AGENTS.override.md` → `AGENTS.md` | 否——根本不往家目录爬 |
| **Claude Code** | 祖先目录（会经过家目录） | `~/.claude/CLAUDE.md` | 否——祖先扫描找的是 `~/CLAUDE.md`，与 `~/.claude/CLAUDE.md` 是**两个不同路径** |
| **本产品（改前）** | 祖先目录（会经过家目录） | 空（无生产者） | **是** |

**一句话根源**：Claude Code 把 `.claude/CLAUDE.md` 当作 **user 层专属路径**，本产品却把它放进了**每一层目录都要找**的 `INSTRUCTION_FILE_NAMES`。于是祖先链爬到家目录时，正好一头撞上 user memory 的位置。这是 Claude Code 爬祖先却不出问题、而我们出问题的全部差别。

### 两处对原 Q015 表述的修正

- **不是 Windows 专属**。Linux `/home/u/code/repo`、macOS `/Users/u/dev/repo` 同样把家目录放在祖先链上。原表述「Windows 上是常态」应读作「绝大多数平台上，把仓库放在家目录下都是常态」。
- **user 层那份在生产中没有生产者**。`bootstrap.ts` 的 `globals` 只有 `<agentDir>/AGENTS.md`（`scope:'managed'`）；`options.prompt?.globals` 生产代码里无人传入。所以 `sources.user` 对指令链是个**没有作用对象的空开关**，唯一实际读到 `~/.claude/CLAUDE.md` 的路径就是 project 层爬升。

## 业界对照：层内择一、层间拼接

- **Claude Code**：`All discovered files are concatenated into context rather than overriding each other`——managed → user → 祖先目录 → 工作目录**全部加载并拼接**，冲突时更具体的赢。
- **Codex CLI**：每一层**只取第一个非空文件**（`AGENTS.override.md` → `AGENTS.md` → 备选名），层与层之间拼接，`cwd > 中间目录 > repo root > 全局`，**同样是 32 KiB 封顶**。

本产品既有实现（层内 first-one-wins + 层间拼接 + 32 KiB 共享预算 + 越近优先级越高）与 Codex 同构，这部分**维持不变**。

## 决定

1. **家目录成为独立的 user 层，对所有项目生效**——包括工作区不在家目录下的情形（如项目在 `E:\code\...` 也读得到）。这是用户的核心诉求：「全局规则本就应该在所有项目都生效」。
2. **家目录那一层从 project 链中整个移除**，改由 user 层统一处理。同一位置只被一条路径处理，双读问题从根上消失。
3. **全局层只取一份**，查找顺序（找到第一个就停，都没有则全局层为空，**不再回落到 `~/AGENTS.md` 等家目录直属文件**）：

   | 顺序 | 路径 | 来历 |
   |---|---|---|
   | 1 | `~/.pilab/AGENTS.md` | 本产品自己的全局指令 |
   | 2 | `~/.claude/CLAUDE.md` | Claude Code 的 user memory |
   | 3 | `~/.codex/AGENTS.md` | Codex CLI 的全局位置 |

   三项都是「家目录下一个文件夹、里面一个文件」的对称结构。**全局指令刻意不进 `<profile>` 层**——`~/.pilab/<profile>/` 的 profile 层是为隔离 dev 版与正式版的凭据和网关而存在，全局指令不需要这种隔离（用户希望两边都生效）。
4. **全局层不读 `CLAUDE.local.md`**：local 层语义是「项目内的私人配置」，全局层本身已是私人的。
5. **D**：家目录在链上时，其之上的多用户共享目录（`C:\Users` / `/home`）全部跳过。两家实现都不读这一层。
6. **globals 与 project 链之间做文件级 canonical 去重**，作为兜底（主路径已靠第 2 条消除双读）。
7. **baseline 脚本一并修**：`scripts/runtime-baseline/run-native.mjs` 传 `settingSources: []`。它此前的机器无关性是靠 `projectTrusted: false` 顺带挡住家目录那层换来的；新语义下 user 层不受信任约束，不修的话基线会带上开发机的 `~/.claude/CLAUDE.md`，两台机器的基线不再可比。

## 未信任项目（含 unbound 草稿会话）：user 层照读

实测确认这**不是新语义而是既有语义**：整个 runtime 的 user 层从不与信任挂钩——`resolveSettingSources` 只把 `trusted` 折进 project/local；`permissions/policy.ts`、`mcp/config.ts`、`skills/index.ts` 三个消费者全都只看 `enabled.user`；既有用例本就钉着「未信任时 global 仍加载」。依据是：全局规则是用户自己写的文件，不是未信任项目提供的，读它没有安全风险。project 链在未信任时仍然整条不读，该底线未动。

## 边界与已知代价

- **不改**预算消费顺序（`:285-299` 的「一个共享预算、按渲染顺序消费」是有意为之，context-prompt-13 的截断 bug 正出自读序与渲染序不一致）。用户提出的「工作目录的 AGENTS.md 应优先」经核对属于「冲突时谁赢」，现状**已经满足**（工作目录排最后 = 最具体 = 冲突时赢），与两家业界实现一致，无需改动。
- **不动** `instructionTracker.ts` 的按需加载。原先写的理由「只在工作区 root 内走，碰不到家目录」**是事实错误**（独立审阅实测更正）：当工作区**就是**家目录时，`~/.claude` 是工作区的子目录，按需加载器会走进去——工具首次读到 `~/.claude/` 下任意文件时，会把 `~/.claude/CLAUDE.md` 作为 **project 层**按需注入，而它同时已作为 user 层在系统提示里，**内容重复出现两次**（tracker 有独立的 `loaded` 集合，与链的不共享）。「不动 tracker」这个**决定**仍然成立（场景极窄，且 tracker 明确在本次范围外），但理由改为：该重复是有界的、只在"把家目录当工作区"时发生，且后果是重复而非丢失。
- **不动** `~/.pilab/<profile>/`、`pi-agent/` 既有布局——profile 层是凭据隔离的承重件，简化它需要数据迁移，属另一件事。
- **可感知变化（用户已确认接受，2026-09-17）**：直接打开家目录本身作为工作区时，只有三个 dot 路径中命中的那一份以 user 层身份出现；`~/CLAUDE.md`、`~/AGENTS.md` 这类家目录直属文件**哪一层都不读**（user 层列表封闭、project 链从家目录之下才开始）。这是条款 2 与条款 3 的直接算术后果，非疏漏。用户裁定：保持现状，不翻转。
- **已知限制（不修，记录在案）**：`sameDirectory` 比对的是 `resolve` 后的拼写而非 `realpath`，所以当工作区经家目录的**另一种拼法**到达时（Windows `subst H: C:\Users\JC`、`mklink /J`、漫游配置等），家目录整层仍留在 project 链上，`~/CLAUDE.md` 会以 `../CLAUDE.md` 身份进入，且在 `settingSources:['project']`（user 关）时也进——即原 Q015 形态在别名拼法下存活。**这不是本次引入的回归**（改前家目录本来就永远在链上），属"没关干净"。不修的理由：场景窄（需刻意用别名打开家目录），而彻底修需要把比对提到 `realpath` 层面、在热路径上增加 O(n) 次 realpath 调用。
- **残留**：`promptService` 测试的 hermetic 泄漏（tmpdir 位于真实 home 之下）未因本次而改善或恶化——根治需让 hermeticHome 把 tmpdir 一并搬进沙箱，超出本次范围。
- **不可达路径**：`prompt.home` 若被显式传空串，`??` 不拦空串而后续 `options.home ? ... : undefined` 又把它吞成 `undefined`，会静默退回 T059 之前的语义。生产上无调用方传 `home`，`homedir()` 也不返回空串，仅记录。

## 方案演进（保留，供日后追溯）

初版拍板为 **A+D**：家目录那一层仍留在 project 链里、只把门控从 `sources.project` 改为 `sources.user`，并明确**不接** user globals 生产者——理由是接了会带来「全局规则在所有项目生效」的行为变化，超出当时授权。用户随后指出「全局规则本就应该在所有项目都生效」，并追加「只读一份、要有先后顺序」的要求，遂升级为上方的最终方案。升级后家目录从 project 链移除，双读从「靠去重兜住」变为「结构上不可能发生」，去重降级为兜底。
