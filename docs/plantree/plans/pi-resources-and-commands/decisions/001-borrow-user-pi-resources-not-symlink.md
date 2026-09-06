# D01 — 借用用户的 pi 资源目录，而不是软链接整个配置目录

**日期**：2026-09-06
**拍板人**：用户（提出软链接方案，看到取证后采纳借用）
**触发**：用户问「是不是创建一个 `.pi` 相关内容的软连接到 `.pilab` 就可以了？」

## 问题

托管模式下 `PI_CODING_AGENT_DIR` 指向 `~/.pilab/pi-agent`，
用户装在 `~/.pi/agent/` 下的技能、模板、插件一律不加载。
而官方文档和模型的既有知识都指向 `~/.pi`，照做的人得不到任何提示。

## 决定

通过 `resourceLoaderOptions.additionalSkillPaths` /
`additionalPromptTemplatePaths` 传**绝对路径**，把用户自己的两个资源目录接进来。

**只借技能与模板，不借插件。**

## 为什么不软链接

五条，前三条是真问题：

1. **会反向写坏用户的 pi。** pi 自己会写 `settings.json`（`lastChangelogVersion`、主题）。
   链过去之后我们改的就是用户 pi 命令行的配置。这正是
   `src/agent-host/permissionPlugin.ts` 注释里点名要避免的：
   「改别人的全局 pi 配置来让我们的应用能跑，会连他的 pi 命令行一起改掉」。

2. **凭据会混。** `auth.json` 与 `models.json` 就在配置目录根下。
   托管模式的整个意义是用我们自己的凭据体系，而它与 `projectTrusted: 0`
   是配套的一整个安全姿态，拆开一半就不成立。

3. **权限插件会被静默顶掉。** 我们随包 27.0.1 且打了补丁
   （`scripts/patch-pi-permission-system.mjs` 加了 `bundled` 策略作用域），
   开发机上是 31.0.0。`settings.json` 一旦链过去，其中的 packages 声明会让 pi
   加载用户那份——补丁没了，基线策略失效，**而且是静默的**。

4. Windows 上符号链接需要管理员权限或开发者模式。

5. 粒度不对：想要的是资源，链过去的是整个目录（含凭据、模型配置、会话记录）。

## 为什么只借技能与模板，不借插件

**技能和模板是纯文本**，进的是上下文；**插件是可执行代码**。

而且插件有一个具体冲突：权限系统那个包必须排除，否则会加载两份或顶掉打过补丁的那份。
借插件要先解决「按包名排除」这件事，而它现在没有需求驱动。

留为 [Q-R2](../open-questions.md)，等 R01 用起来之后再看。

## 硬约束：不能借 settings.json

探针取证：项目配置里一个 `packages` 声明会让 pi **真的去 npm install**
（`npm install <pkg> --prefix <cwd>/.pi/npm`）。

所以借用只能借资源**目录**，绝不能把用户的 `settings.json` 纳入解析路径——
那等于把「信任」这件事又打开了一半。

## 开关

`borrowUserPiResources`，**默认开**。

默认开的理由：这个功能存在的场景就是「用户不知道自己装错了地方」，
默认关等于让不知道的人继续不知道。风险面是纯文本资源，与默认关的收益不成比例。

## 顺带确立：技能的推荐安装位置是 `~/.agents/skills/`

取证发现 pi 从 `join(getHomeDir(), ".agents", "skills")` 读技能
（`core/package-manager.js:1976`）——用的是 HOME 而不是 agentDir，
**不受任何模式影响，永远加载**。

这是 agentskills.io 的跨 agent 标准位置。借用是兜底，这个是「本来就对」，
文档和界面里两个都写，推荐前者（R04）。
