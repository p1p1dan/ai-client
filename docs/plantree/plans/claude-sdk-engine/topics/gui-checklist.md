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
| 2026-10-16 | 安装目录（本分支合入 S-4 后打的 `win-unpacked`，1.1.1-test.1），隔离 profile | 1～9 全部通过，见下方 §2.1；README §11.2 #43 |

### 2.1 安装目录这一遍（2026-10-16）

- 怎么起：`PiLabAi.exe --remote-debugging-port=<端口> --open-path=<临时工作区>`，`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 都指向一个临时 home（应用的 `~/.pilab` 与 Electron 的 userData 都落在里面）。安装包强制登录：把本机已登录账号的凭据库 `~/.pilab/<配置名>/credentials/vault.json` 与解它要的 userData `Local State` 复制进临时 home，在登录页点"以 <账号> 继续"。做完退出应用，整个临时 home 连同这两份副本删掉。
- 只用本机假网关：`seed` 加的两个假服务指向它；「其他模型」里还列着这个账号自己的模型（如 `glm-5.2`），点验时只选假服务的模型。`seed` 之后要 `location.reload()`，模型菜单才列出假服务。
- 结果：项目 `CLAUDE.md` 的暗号进了请求；`touch` 按项目规则不出卡，写文件出卡、批准后落盘；五档与中文说明同开发版；计划审阅卡四个"批准，用……继续"加"继续讨论修改"，批准后芯片为手动审批；自动模式下 `sleep` 运行中切到手动审批即时生效，停止后 4 秒内 `sleep` 进程清零；开始页跳过权限确认的确认框范围说明单独成行，第一句话里的建目录与写文件都不出卡，回到开始页仍是手动审批；用户层只读 `~/.pilab/PiLabAi/claude/CLAUDE.md`，临时 home 下 `~/.claude/CLAUDE.md` 的暗号没进请求；DSH 那边芯片、菜单与开始页完全放行同开发版。
- 假网关收到 15 个请求：13 个 SDK 回合（`claude-cli/2.1.300 (external, sdk-ts, agent-sdk/0.3.300, client-app/pilab/1.1.1-test.1)`）、1 个自动模式的安全检查（`claude-sonnet-5`）、1 个 DSH 回合（`glm-fake-1`）；日志里没有 key 原文。
- 退出（标题栏关闭 → "确认退出" → 退出）后 2 秒内应用、两个 SDK 宿主的 node 与 `claude.exe` 全部退出，没有残留进程。

## 附录：gui-probe 的菜单操作

- `click <文字>` 只找按钮。打开菜单用 `click` 点芯片；选菜单项用 `eval` 找 `[role=menuitem]` / `[role=menuitemradio]` 再 `.click()`。
- 子菜单（「其他模型」）点不开：对它 `focus()` 后派发 `keydown` `ArrowRight`，等约 0.7 秒再点子项。
- 权限卡挂起时卡片占住输入区，这时点不到档位芯片。
- 选自动模式、跳过权限确认、完全放行都先弹确认框，要再 `click "应用"`；用 `[role=dialog]` 查不到这个框，看它在不在可在 `eval` 里挂一个 `MutationObserver` 收新加节点的文字。
- 安装目录的页面是 `file://`：`scripts/h21-cdp.mjs` 连接时也认 `file:///` 开头的页面，`gui-probe` 才能连上安装包。
