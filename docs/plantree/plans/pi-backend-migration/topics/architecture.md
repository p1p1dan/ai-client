# Topic — 四层隔离架构方案

## 目标架构

```
React Renderer → Preload (contextBridge) → Electron Main → utilityProcess Agent Host → pi SDK
```

### 与当前架构的差异

| 维度 | 当前 | 目标 |
|------|------|------|
| Agent Host 进程 | 独立 Node 24 进程（fork） | Electron utilityProcess |
| 通信协议 | stdin/stdout NDJSON | MessagePort（或保留 NDJSON 待定，见 Q1） |
| 后端 SDK | `@anthropic-ai/claude-code` Agent SDK | `@earendil-works/pi-coding-agent` |
| Runtime 适配 | `claudeRuntime.ts` + `eventNormalizer.ts` | `piRuntime.ts` + 适配后的 eventNormalizer |
| 权限模型 | Claude canUseTool + permission mode | pi SDK 权限模型（待调研） |
| 配置存储 | `~/.claude/` | `~/.pi/agent/` |

### 保持不变的部分

- Electron 主进程架构（main / preload / renderer）
- Renderer 层组件和状态管理（React + Zustand + TanStack Query）
- `src/shared/types/runtimeEvents.ts` 作为内部统一事件层
- 构建工具链（electron-vite + esbuild）

### 关键设计决策

1. **eventNormalizer 保持为中间层**：pi SDK 事件 → RuntimeEvent，renderer 不直接依赖 pi SDK 类型
2. **utilityProcess 而非独立进程**：崩溃隔离 + 无需管理子进程生命周期 + MessagePort 通信更高效
3. **contracts 提取为独立类型**：renderer ↔ agent-host 的通信协议不耦合在代码里（参考 pix 的 `packages/contracts`）
