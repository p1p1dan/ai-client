# 决策 103：提示词模板在 DSH 版不再支持，迁移时提示改写为技能；P1-16c 取消（需用户拍板）

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-8、§5；
- [P1-10 / P1-16 分片 01 §4](../topics/p1-10-p1-16-extensions/01-assets.md)、[分片 02 §6](../topics/p1-10-p1-16-extensions/02-dsh-facts.md)、[分片 03 §2.3](../topics/p1-10-p1-16-extensions/03-design.md)；
- [决策 086](086-shared-skills-mcp-move-choices.md)；`dsh-tool-skill/README.md:54`。

修订：取消 P1-10 / P1-16 方案 D10 的 A（bridge 自持模板展开）与 P1-16c 子任务。

## 规则

1. **不再展开模板**：`<agentDir>/prompts/*.md`、`<cwd>/.pi/prompts/*.md` 在 DSH 版里不再展开，斜杠菜单也不再列出。
   - DSH 没有提示词模板：`ctx.commands` 的命令不产生模型消息，已装的包里也没有谁把 `/name` 展开成用户消息（分片 02 §6）。
2. **最接近的 DSH 做法是用户可调的技能**：`/<name>` 把技能正文注入这一步（`dsh-tool-skill/README.md:54`）。
   - [决策 104](104-legacy-asset-notice-and-extension-pages.md) 的旧资产提示列出检测到的模板，并说明怎样改写成技能：
     - 放进 `<agentDir>/skills/<name>/SKILL.md`；
     - frontmatter 写 `name`、`description`；
     - 只想给人用的加 `disable-model-invocation: true`。
   - 产品不自动转换，不改用户文件。
3. **shared 里的模板代码暂留**：`src/shared/skills/templates.ts`、`expand.ts`（`36df9ac9` 已搬进 shared）暂时保留，给旧资产提示检测模板用；P1-12 时如果没有别的调用方再删。

## 取舍

- **保留**（原 P1-16c）：
  - 约 150 行新代码加 350 行测试（约 2.5 人日）；
  - 模板与 DSH 命令同名时要做遮蔽与报告；
  - 是纯为与 1.0.x 一致的自研。
- **自动转换成 DSH 技能**（写进 `$DSH_HOME/skills`）：会生成用户没写过的文件，与原模板漂移；位置参数 `$1`、`$@`、`${@:N}` 的替换语义也对不上。
- **用户看得见的不同**：
  - `/review 123` 这类模板命令不再展开，菜单里也不再列出；
  - 改写成技能以后用 `/review` 触发，但参数不再按位置替换，而是作为消息正文由模型自己理解；
  - 技能在消息任何位置都会触发，不只是行首（决策 064 第 3 条）。

**如果用户不同意**：恢复 P1-16c，照原方案在 bridge 里展开模板，约 0.5 人周，排在 P1-4d2 之后。

## 影响

- **测试**：不新增。`src/shared/skills/__tests__/` 里模板与展开的用例保留（代码暂留）。
- **roadmap**：P1-16 的子任务去掉 16c。
- **发版说明**：加一条「提示词模板不再支持，可改写为技能」。
