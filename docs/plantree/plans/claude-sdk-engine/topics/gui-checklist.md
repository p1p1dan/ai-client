# GUI 点验清单（路线 B）

Role: topic（S-5 R-4，2026-10-16）。上位：[README](../README.md) §4 S-5、[S-5 记录](s5-regression.md)。

把 S-1～S-3 与开始页跳过权限确认做过的 GUI 点验写成一张清单。开发版用 `src/claude-sdk-host/tools/gui-probe.mjs` 走（隔离 profile、只用本机假网关）；打包后（S-6 前）在安装目录上照同一张清单再走一遍。界面上任何地方都不应出现 "Claude Code"。

## 0 准备

1. 起本机假网关：`node src/dsh-host/tools/fake-gateway.mjs --port 18932 --plan claude-sdk --reset --model-id claude-opus-5-5`。
2. `node src/claude-sdk-host/tools/gui-probe.mjs setup`，再在临时工作区里放一个带暗号的 `CLAUDE.md` 与 `.claude/settings.json`（`permissions.allow: ["Bash(touch:*)"]`）。
3. `launch` → `enter` → `seed`（两个假服务：Anthropic 协议带 Claude 模型与一个 GLM，OpenAI 协议带一个 GLM）；有公告弹窗就 `click "知道了"`。
4. 操作菜单的技巧见下方附录：子菜单要用 `eval` 发 `ArrowRight`，菜单项不是按钮。

## 1 清单

| # | 项 | 步骤 | 应看到 | 出处 |
|---|---|---|---|---|
| 1 | 按协议选引擎 | 开始页选 Claude 模型、再选 OpenAI 协议的 GLM | 权限芯片分别是「手动审批」（SDK）与「改动前确认」（DSH） | S-1、S-2 |
| 2 | 五档与中文名 | SDK 会话打开权限菜单 | 手动审批 / 自动编辑 / 计划模式 / 自动模式 / 跳过权限确认，各带中文说明；没有"拒绝规则"之类 DSH 的说法 | 裁决 6、13、14 |
| 3 | 开始页开跳过权限确认 | 开始页选「跳过权限确认」→ 确认框 → 应用 → 发一句会写文件的话 | 确认框单独一行写"只作用于下一句话新建的对话"；新对话芯片红色；写文件不出卡；回到开始页仍是原默认档 | 裁决 16 |
| 4 | 项目 CLAUDE.md 与规则 | 绑定测试工作区发 `CC-ECHO which instructions`，再发会 `touch` 的 `CC-RUN` | 回复里有工作区 CLAUDE.md 的暗号；`touch` 不出卡、写文件出卡 | 裁决 5 |
| 5 | 用户层 | 在 `~/.pilab/<配置名>/claude/CLAUDE.md`（隔离 profile 下是临时 home 里的同名目录）放暗号，新开对话发 `CC-ECHO` | 回复里有这个暗号；`~/.claude` 里的不出现 | 裁决 19 |
| 6 | 回合中切档 | 自动模式下发 `CC-SLOW {"seconds":41}`，命令运行时把芯片切到手动审批，再停止 | 芯片随之改变；停止后命令进程清零 | S-2 A-4 |
| 7 | 计划模式与审阅卡 | 切到计划模式发 `CC-PLAN make a plan`，在审阅卡选"批准，用手动审批继续" | 审阅卡有四个"批准，用……继续"加"继续讨论修改"、没有目标项；批准后芯片为手动审批 | S-2 A-7、裁决 20 |
| 8 | DSH 会话不变 | 新建对话选 OpenAI 协议的 GLM，打开权限菜单 | 计划模式 / 改动前确认 / 自动编辑 / 全自动 / 完全放行 + 设定目标 | S-2 §3.3 |
| 9 | DSH 开始页完全放行 | 开始页选「完全放行」→ 确认 → 发一句话 | 新对话芯片为「完全放行」；默认档不变 | 裁决 16 |

## 2 记录

| 日期 | 版本 | 结果 |
|---|---|---|
| 2026-10-16 | 开发版，隔离 profile | 1、2、4、6、7、8 通过（S-2+S-3 点验，[S-3 设计](s3-project-config.md) §5.2）；3、9 通过（[开始页的跳过权限确认](bypass-before-first-message.md) §2）；5 由探针 `projcfg` 覆盖，GUI 上未单独点 |
| 打包后 | 安装目录 | 待做（S-6 前） |

## 附录：gui-probe 的菜单操作

- `click <文字>` 只找按钮。打开菜单用 `click` 点芯片；选菜单项用 `eval` 找 `[role=menuitem]` / `[role=menuitemradio]` 再 `.click()`。
- 子菜单（「其他模型」）点不开：对它 `focus()` 后派发 `keydown` `ArrowRight`，等约 0.7 秒再点子项。
- 权限卡挂起时卡片占住输入区，这时点不到档位芯片。
