# 2026-09-07 验证记录

范围：S04 与 S01/S02/S03。实现保留在当前工作区，未提交，未开始 S05。

## 已通过

- 全仓 Biome：`node node_modules/@biomejs/biome/bin/biome check . --diagnostic-level=error --max-diagnostics=10`，检查 1035 文件，退出 0。
- S04 相关三文件五项测试。
- S01 控制器/快捷键/请求生命周期三文件十一项测试；真实 ripgrep 八项集成测试。
- S02 对话框两项测试；会话菜单四项回归。
- S03 mutation 四项测试；Git 缓存键三十一项回归。
- Electron 安装后补跑 PiUtilityService、PiWorkerProcess、ScratchWorkspaceService、WorkerManager、createPiWorkerSlot、LegacyImportService：六文件 113 项通过。
- 所有测试使用 `--maxWorkers=1 --no-file-parallelism`，Node 堆限制 768 MiB。

## 类型检查边界

S04 单独实现后，完整 `tsc --noEmit` 在 896 MiB 堆限制下通过。
S01/S02/S03 加入后，同一命令触及 Node 堆上限退出。没有提高上限或无上限重跑。

随后仍在 896 MiB 上限内串行拆分为两部分，通过：

1. 生产代码：继承根 tsconfig，额外排除 `src/**/__tests__/**`，保留原来的 Agent Host 排除范围。
2. 本次新增六个测试文件：继承根 tsconfig，include 指定这六文件及 `src/preload/types.ts`、`src/shared/env.d.ts`、`src/renderer/vite-env.d.ts`。

临时配置通过绝对 typeRoots 指向本仓 node_modules/@types，保证临时目录不会改变 Node 类型解析。
拆分检查不等价于整套检查通过，现有全部测试文件的类型检查仍需完整门禁补证。

## 全仓测试

294 文件按路径排序，分 25 批，每批最多 12 文件。每批结束检查 RAM/Swap/磁盘，
没有并行运行两个批次或其他重任务。

首轮：4247 个断言通过，10 个失败，8 个跳过；含加载失败在内有 12 个失败文件。
原始 JSON 保留在 `/tmp/settings-cleanup-results-BKQVxy/batch-1.json` 至 `batch-25.json`。

首轮发现的问题及后续处理：

| 原因 | 处理及状态 |
| --- | --- |
| 新增仓库菜单后，会话菜单测试取到了第一个 MenuPopup | 限定到会话 ContextMenu Trigger 之后，四项回归通过 |
| 项目 ripgrep 二进制未安装 | 执行该包的 postinstall，八项真实搜索测试通过 |
| Electron 安装脚本最初被跳过 | 单独执行 Electron install.js，受影响的六个文件 113 项通过 |
| node-pty 缺少 Linux 原生模块 | 未解决；本机缺少 make/g++，系统安装已询问用户 |
| 独立 Agent Host 权限插件未安装 | 未解决；独立 src/agent-host/node_modules 尚未安装 |

仍需复跑的四个文件：

- `src/agent-host/__tests__/permissionPatchScript.test.ts`
- `src/agent-host/__tests__/permissionPolicyIntegration.test.ts`
- `src/main/services/session/__tests__/SessionManager.test.ts`
- `src/main/services/terminal/__tests__/PiTuiPty.test.ts`

## 环境与限制

- 实际主机 RAM 约 1.9 GiB；执行过程中持续串行检查资源。
- 根项目按锁文件安装依赖，跳过统一 postinstall；随后按需单独安装 ripgrep 和 Electron。
- 仅新增 happy-dom 开发依赖及对应锁文件条目，用于真实 React 生命周期与表单交互测试。
- 未运行系统包安装、node-pty 编译、整套生产构建或 Agent Host 打包。
- 未启动开发应用，未进行真实 Electron GUI 点验。`scripts/dev.js` 在缺少缓存时还会自动构建 Linux remote runtime bundle，因此没有直接触发该入口。
- 为满足 lint 门禁，对既有 extensionUiDisplayModel.ts 仅做一行等价格式调整，无行为修改。

继续 S05 前，需要完成补齐线的门禁和合入。GUI 点验仍按原计划并入 UI 对齐累计点验。
