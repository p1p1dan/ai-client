# B 组完成记录

日期：2026-09-08。B1–B4 Done；工作区修改，未提交、未推送。

## 验收映射

| 任务 | 实现与验收证据 |
|---|---|
| B1 | [真实技能加载探针](./b1a-agents-skills-probe.md)、[默认技能目录](./b1b-default-skill-home.md)：Pi 0.84.3，managed/local utilityProcess + TUI PTY；HOME 路径、目录 IPC、默认提示和 UI 静态断言 |
| B2 | [借读边界](./b2-borrow-surface.md)：AGENTS.md 存在/不存在、同目录、源不变、无扩展字段；subagents 经对应源码/测试取证不采用 |
| B3 | [扩展清单](./b3-bundled-extension-registry.md)：合法清单、成本说明、默认值、旧 key 迁移、未知 ID、空清单不下发、部分更新及无变化不重启 |
| B4 | [Codex 导入](./b4-codex-import.md)：真实 rollout fixture、幂等、跨来源同名、坏源隔离、签名 manifest、真实 Pi 写入与重新打开 |

## 最终门禁

- 303 个测试文件分为 38 批，每批最多 8 files；`--maxWorkers=1 --no-file-parallelism`，Node heap 1200 MiB。
- **303 files / 4532 tests 全部通过**。逐批精确文件与结果：[final-batch-gate.json](./final-batch-gate.json)。
- Root：`NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit` 通过。
- Agent Host：`NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json` 通过。
- `biome check .` 无 error（保留现有 27 warnings / 17 infos）；最终 error-level 检查通过。
- `git diff --check`、计划 Markdown 相对链接检查通过。

中途失败均保留取证历史，但已非当前阻塞：

- [native 恢复](./native-gate-recovery.md)：用户缓存解压工具链、单作业编译独立 node-pty，不安装系统包、不改另一 checkout 依赖；SessionManager/PiTuiPty 复验通过。
- worktree 搜索 `.git` 指针文件：用户明确将顺手 bug 纳入本轮，已应用一行排除规则，第 13 批完整重跑通过。此前 proposed patch 是已应用补丁的历史记录。
- 新错误文案末尾 `import` 触发 esm-shim 检查：文案修正，第 5 批通过。

## 交接与验证限度

按原计划，GUI 点验并入 [UI 对齐累计轮次](../../pix-ui-alignment/implementation-status.md)，已登记具体点验项目；实际 GUI 尚未执行。
本轮没有整套生产构建或跨平台打包，未声称这些已通过。
pi-app/pix/PI-Desktop 为参考与适配来源，没有复制新执行 runtime；Claude/Codex 源文件保持只读。
opencode 导入仍 Deferred，不属于本轮交付。

Root registry 已将 B 组移入 Archived，原目录保留供检索。后续活动工作仅为已交接的累计 GUI 轮次。
