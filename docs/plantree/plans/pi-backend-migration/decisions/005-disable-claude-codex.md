# D5 — 先屏蔽 Claude/Codex 路径，代码不删

**状态**：已拍板（2026-08-28）

## 决策

Phase 1 屏蔽 Claude/Codex 后端路径，走最简洁快速方案。代码保留不删，用配置项控制。

## 实现方式

- `activeBackend` 配置项：`'pi' | 'claude' | 'codex'`，Phase 1 硬编码为 `'pi'`
- `claudeRuntime.ts` / `codexRuntime.ts` 保留在仓库里
- `AgentHostManager` 的 agent 选择逻辑只走 pi 路径
- renderer 层通过 RuntimeEvent 统一事件层工作，零改动

## 切回路径

三个 runtime 都往同一个 RuntimeEvent 层输出。切回只需：
1. 把 `activeBackend` 变成用户可选设置项
2. 恢复 `AgentHostManager` 的多后端选择逻辑
3. renderer 零改动
