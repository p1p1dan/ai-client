# 决策 011：DSH 宿主以构建产物进包（`host.js` 加 esbuild 打包的 bridge）

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-2 方案 §4 D1](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、[分片 03](../topics/p1-2-host-packaging/03-entry-lock-files.md)。

## 规则

1. 新建 `scripts/build-dsh-host.mjs`，产出 `out-dsh-host/`。afterPack 把整个目录拷到 `resources/dsh-host/`，不进 asar。
2. `host.ts` 只做转译，产出 `host.js`。bridge 从 `bundle/lib/bridge.js` 挪到 `bridge/plugin.ts`，连同它引用的 `src/agent-host/piWorkerRpcServer.ts` 和 `src/shared/types/*` 一起，用 esbuild 打成 `bundle/lib/bridge.js`。npm 包全部外置（`packages: 'external'`）。
3. 开发态继续直接跑 `host.ts`，`bridge.js` 改成开发垫片。开发态和打包态之间，靠打包冒烟（[决策 017](017-packaged-smoke-runs-tool-turns.md)）保持一致。

## 取舍

- 不选「源码直跑」（把 `host.ts`、`bridge/`、`src/agent-host`、`src/shared` 的 TS 拷进包）：`node_modules` 下的 `.ts` 不许类型剥离，已实测报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`；还要把两棵源码树搬进安装包；而且 Windows 的 TSD 修复只认 `.js`（`afterPack.mjs:147`）。
- 复用 agent-host 已有的 esbuild 做法。
- 代价：开发态跑源码、打包态跑产物，是两条路径。

## 影响

- P1-2 施工。决策 009 的打包态入口 `resources/dsh-host/host.js` 与本决策一致。
