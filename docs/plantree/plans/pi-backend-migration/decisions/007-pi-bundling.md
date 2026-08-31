# D7 — pi SDK 打包：作为 npm 依赖随包，用户无需安装

> **状态：Revised / historical packaging strategy（2026-08-31）**
>
> “用户无需单独安装 Pi”继续有效；SDK 可留在 asar 且由 singleton host 直接读取的假设不再是目标。Worker bundle、Pi CLI 与 production dependencies 的 Resources/extraction 方案由 [D15](./015-main-owned-worker-manager.md) 及新 roadmap 的 T36/T37 收口。

**原状态**：已拍板（2026-08-28）

## 决策

`@earendil-works/pi-coding-agent` 作为普通 npm 依赖安装，在 `build-agent-host.mjs` 中标记为 external（不打进 esbuild bundle），SDK 的 node_modules 子树随 Electron 打包。用户流程：安装 → 登录 → 使用，无需单独安装 pi。

## 调研依据

两个参考项目的做法：

| | pi-app | pix |
|---|---|---|
| 依赖方式 | 普通 dependencies | 普通 dependencies（pnpm catalog 管版本） |
| 构建处理 | rollup external，不打进 bundle | vite external，不打进 agent-host bundle |
| 打包 | 整棵 node_modules 进 asar | 进 asar，首次启动提取到 userData/pi-cli/（因独立 Node 进程读不了 asar） |
| 运行时拉取 | 无（纯 JS） | 额外拉 Node 24 + Python |
| SDK 升级 | 三级解析：builtin > global > 用户下载 | 双源：builtin / global |

## 我们的方案

1. `package.json` 添加 `@earendil-works/pi-coding-agent` 为 dependencies
2. `build-agent-host.mjs` 将其标记为 external
3. 打包时将 `@earendil-works/` 子树拷入 agent-host 产物目录
4. pi SDK 纯 JS，无需 fetch 脚本拉取平台二进制（与 Codex 不同）
5. 后续如切 utilityProcess（D3），SDK 在 asar 内可直接 require，无需提取

## 体积预估

SDK 本体 ~21MB + 依赖树（pi-agent-core/pi-client/pi-protocol/pi-tui 等 ~20 个包）≈ 40-60MB。相比现有 Codex 二进制（~300MB）显著更轻。
