# 决策 101：全局指令与技能只用 DSH 原生行读取：`dshHome` 指向 `<agentDir>`，技能目录加上 `<agentDir>/skills`；技能调用改用 DSH 的 `/<name>`；不做兼容报告界面

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [决策 057](057-user-assets-stay-in-place.md)（用户资产原地对接）、[064](064-accepted-behavior-differences-extensions.md) 第 1～3 条；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-1、16-2、16-4～16-7；
- [P1-10 / P1-16 方案 §4.1](../topics/p1-10-p1-16-extensions.md)、[分片 03 §2.1～2.2](../topics/p1-10-p1-16-extensions/03-design.md)；
- `dsh-agent-instructions/README.md:59-66`；`dsh-agent-instructions/lib/index.js:141`；`dsh-skill-filesystem/README.md:44-56`；`dsh-tool-skill/README.md:12,54`。

修订：P1-16a 的范围收窄。原方案里的 `aiclient-instructions` 小插件见[决策 102](102-drop-user-layer-instruction-files.md)，技能兼容报告页与 `/skill:` 改写在本决策里取消。

## 规则

1. **路径下发**：`<agentDir>`（`~/.pilab/<profile>/pi-agent`）与 P1-6c 的 `AICLIENT_PERMISSION_AGENT_DIR` 合成一处下发（`configure` 或环境变量）。一份路径、一个来源。
2. **宿主据此生成两行 overlay**。补丁对同一 id 会整体替换 `config`，所以要把该写的一起写上：
   - `agent-instructions`：`{maxBytes: 65536, dshHome: <agentDir>}`。DSH 把 `<agentDir>/AGENTS.md` 当作用户全局指令，以 user 消息注入（决策 064 第 1 条已接受「不再进系统提示词」）。
   - `skill-filesystem`：`{customSkillDirs: [<agentDir>/skills]}`，rank 300。`~/.agents/skills`、项目根的 `.dsh/skills` 与 `.agents/skills` 本来就是 DSH 的默认根，照旧生效。
3. **技能调用用 DSH 的写法 `/<name>`**：消息任何位置出现都会触发（`dsh-tool-skill/README.md:12,54`）。
   - 不做 `/skill:<name>` → `/<name>` 的改写；
   - 斜杠菜单里技能按 `<name>` 列出（决策 099 第 9 条）。
4. **不做兼容报告界面**：设置页的「检查兼容性」、`capabilities.skillIssues` 都不做。DSH 不会加载的技能（缺 `name`、名字不是小写短横线、多层目录、放在 DSH 不扫的根），由[决策 104](104-legacy-asset-notice-and-extension-pages.md) 的旧资产提示一次性列出。
5. **项目指令链**用 DSH 原生规则，差异按决策 064 第 1 条接受，不做额外工作。
6. **读取都在宿主里做**（ARD D11）；Main 不替宿主读这些文件。

## 取舍

- **为什么指向 `<agentDir>`，而不是复制到 `$DSH_HOME`**：原地对接已由决策 057 批准；一行配置就让用户写过的全局指令和技能继续生效，这正是「设置能迁移」；复制会漂移，回装 1.0.x 时也看不到改动。
- **为什么不做 `/skill:` 改写与兼容报告**：两者都是为与 1.0.x 一致的兼容层，约 180 行加测试。一次性名单已经足够让用户自己改名或挪位置。
- **代价**：
  - `/skill:xxx` 这种写法不再生效；
  - 不合规的技能不加载（决策 064 第 2 条已接受），用户只在一次性提示里看到名单，没有常驻报告页。
- 工作量约 1.5 人日，原 P1-16a 约 400 行产品代码加 600 行测试。

## 影响

- **测试**：宿主的 overlay 生成与 `src/dsh-host/__tests__/hostStatic.test.ts`；bridge-smoke 新增 INS-1（`<agentDir>/AGENTS.md` 与项目 `CLAUDE.md` 进首个请求）、SKL-1（`<agentDir>/skills` 与 `~/.agents/skills` 的技能都在目录里，`/x` 触发注入）。
- **开工前实验**：P1-10 / P1-16 方案里的 E6，确认两行 overlay 生效。
- **不受影响**：`src/shared/skills/*` 纯库不变，旧资产提示按 1.0.x 规则扫技能时要用它。
- **迁移**：文件都不动，回装 1.0.x 照常生效。
