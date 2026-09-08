# B1-a — Shared skills discovery

日期：2026-09-08。环境：Linux x64，Node v24.20.0。

## 实际取证

- `npm ci --no-audit --no-fund`（cwd：`src/agent-host`）：锁文件安装 241 packages，权限补丁 postinstall 成功。
- 原有根 node_modules 是另一 checkout 的符号链接，其 Pi 为 0.84.4；本探针明确使用本工作区 Agent Host 锁定的 **0.84.3**，不修改共享依赖。
- `node scripts/probes/b1a-shared-skills-probe.mjs`：exit 0，JSON `ok: true`。
- 探针在独立子进程覆盖 HOME，在临时 HOME 的 `.agents/skills/b1a-shared-skill-probe/SKILL.md` 写最小技能；退出清理。没有读取真实用户凭据或安装目录。

| 配置 | 实际入口 | 结果 |
|---|---|---|
| managed | SDK `createAgentSessionServices`，隔离 agentDir，projectTrusted=false | 技能存在，source=auto，scope=user |
| local | 同上，用户 Pi agentDir，projectTrusted=true | 技能存在，source=auto，scope=user |
| tui-loader | SDK 同类加载器，managed agentDir，无借读配置 | 技能存在，source=auto，scope=user |

这是实际 SDK 加载器证据，不是 Electron utility worker 或真实 TUI PTY 启动证据。报告明确输出 `tuiPtyVerified: false`。
暂不把 B1-a 勾为全部完成。

## 参考与边界

- 本地 Pi SDK `dist/core/package-manager.js` 原生发现用户 `.agents/skills`；不需 additionalSkillPaths 修补共享技能。
- pix：阅读 `apps/desktop/src/main/pi-tui-pty.test.ts` 的 launch/PTY 测试形状，采用其隔离启动思路，本探针独立实现，不直接复制。
- pi-app 的约定目录在本机不存在，尚未取得其参考实现。
- `.agents/subagents` 不能从 skills 结果推导：已安装 subagents 插件的工具描述指向 `<agentDir>/agents`，需要单独确认，不将其当作原生共享目录。

## 未验证

- 真实 utility worker 与 TUI PTY。
- 设置页 GUI、完整 lint/typecheck 与分批回归。
- B1-b 模型安装提示及 B2–B4。

## 真实 utilityProcess 与 TUI PTY 补验（2026-09-08）

扩展后的同一命令 `node scripts/probes/b1a-shared-skills-probe.mjs` exit 0，Pi 0.84.3。
真实 Electron utilityProcess 分别以 managed/local 设置创建 SDK services，两次均 loaded=true、scope=user。
真实 PTY 由系统 script 提供，使用绝对 Node24 与锁定 SDK bundled CLI，符合 PiTuiPty packaged launch 形状；
session_start 探针发现 `skill:b1a-shared-skill-probe`，stdin.isTTY=true，`tuiPtyVerified: true`。
没有发模型请求、没有写入真实用户资源。临时 HOME 和文件退出清理。

首轮 utilityProcess 超时；原因是 probe 输出后没有主动终止 Electron utility 子进程。
改为 stdout flush 回调后退出，重跑通过。产品代码没有为探针改动生命周期逻辑。
此前表中的「未验证 utility/TUI」已被本补验替代；完整 GUI 累计点验另行交接。
