# F3 开发机取证 · 顺带挖出一个让搜索失明的源文件

Role: evidence。日期：2026-09-11。控制字节修复与探针提交 `a189e126`。对应[执行顺序](../../README.md#执行顺序)第 5 批（P4-6 收口）第一步。

用户 2026-09-11 定的规矩：**先把开发机做到完全正常，必须在加密机才能测的留到最后一次上机**。
本记录是按这条规矩做的第一步。

## 结论一：F3 在开发机上不复现，确认为加密机专属

三层都测了，从里到外：

| 层 | 做法 | 结果 |
|---|---|---|
| 纯 Node 进程 | 直接调 `createSimpleGit(repo).branch(['-a','-v'])` 与 `spawnGit` | 11 个分支；`spawnGit` exit 0、stdout 1121 字节、stderr 空 |
| Electron 主进程 → Git | 走应用自己的 IPC（`window.electronAPI.git`），即 GUI 面板用的同一条链 | `getBranches` 11 个、`getStatus` 当前分支 `feat/runtime-evolution`、`getLog(3)` 3 条，渲染层零报错 |
| 界面 | 打开 Git 面板 | 分支、3 个未跟踪改动、历史提交列表全部正常显示（[截图](git-surface-dev.png)） |

所以 Main→Git 这条链**本身没有缺陷**。F3 现场那个「stdout 空、stderr 正常」只发生在加密机上，
按用户的决定整体推迟到最后一次上机；[方向讨论](../../../../plans/2026-09-09-gui-defect-decisions.md#f3--gui-起的-git-子进程输出丢失)不变。

**连带影响**：任务树里 F/13「目录行变更量」原本标着「目标现场受 F3 阻断」。既然开发机上 git 是通的，
这条阻断在开发机不成立，可以直接验收——验收过程里挖出了下面那件事。

## 结论二：F/13 接线是好的；真正的问题是一个源文件让 grep 静默失明

**先说一条订正**：本记录的初稿断言「F/13 的抓取侧从来没接线」，**这是错的**。
抓取侧接得好好的——`useFolderDiffStats.ts` 里有 `useFolderDiffStatsPolling`，
`LeftNav.tsx:79` 导入、`:291` 调用，里面按契约调了
`collectBusyWorkspacePaths` → `withRecentlyBusy` → `fetchDiffStats`。

误判是怎么来的，值得单独记一笔，因为它会再咬人：

```
$ grep -rn "collectBusyWorkspacePaths" src/renderer --include=*.ts --include=*.tsx
（只列出 folderDiffStats.ts 的定义和测试，没有 useFolderDiffStats.ts）

$ file src/renderer/components/workspace-shell/useFolderDiffStats.ts
... : data          ← 不是 text
```

`useFolderDiffStats.ts` 里有两个**裸 NUL 字节**：`busyPaths.join('<NUL>')` 与
`busyKey.split('<NUL>')`。用 NUL 当 effect 依赖键的分隔符本身是对的（路径里
不可能出现这个字节，两组不同的路径永远不会撞成同一个键），但它被写成了源码里的
字面控制字符而不是转义。后果有两层，都很隐蔽：

1. `file(1)` 判定该文件为 `data`，**grep / ripgrep 默认跳过二进制文件且不报错**，
   于是任何针对它所导入符号的搜索都查不到它，整个 hook 读起来像死代码。
2. 用 `cat` 读的时候 NUL 不可见，看起来是 `join(' ')`（空格分隔），
   **连人工复核都会得出错误结论**。

已修：把字面 NUL 换成常量 `const NUL = '\0'`，运行期字节完全相同，文件恢复成
UTF-8 文本，`grep` 立刻能找到它。改动落在 `useFolderDiffStats.ts`。

顺带一提，HEAD 里那个旧 blob 因为含 NUL 被 git 当二进制，所以 `git diff --shortstat`
对它报 `0 insertions, 0 deletions`——这也是 F/13 的数字在这次验证里一度是 0 的原因之一。

### F/13 的实测

在运行中的应用里直接驱动抓取侧（`fetchDiffStats(所有 workspace 路径)`）：
IPC 正常返回，store 写入成功。当时工作区只有**未跟踪**文件，
而 `git diff --shortstat` 本来就不统计未跟踪文件，所以返回 `0/0`、
`sumFolderDiffTotals` 返回 `null`、行上不显示数字——**这是正确行为，不是缺陷**
（该函数的注释明写：全为 0 时返回 null，免得每行挂一个永远存在且无意义的 `+0 -0`）。

「只对有 busy 会话的目录轮询」那一半由 `folderDiffStats.test.ts` 的单测覆盖，
本次未在真实回合下复验——需要一个真的跑起来的会话，归入后续 GUI 点验。

## 复现方法

```bash
node scripts/run-f3-dev-probe.mjs
```

探针走渲染层暴露的 git IPC，也就是 GUI 面板自己用的那条路。原始输出
[f3-dev-report.json](f3-dev-report.json)。

## 一条踩坑记录：冷启动会超过探针的等待上限

这台机器 2026-09-11 被重启并调整过内存。重启后第一次起开发版应用，
**从进程拉起到 CDP `/json/list` 回包花了约 9 分钟**，而 `h21-cdp.mjs` 的 `Cdp.attach`
默认只等 240 秒，于是探针报 `CDP target never appeared`——看起来像通道坏了，其实只是没等够。

判据（用来和真正的故障区分开）：

- 机器负载 0.03、可用内存 1.3 GB 以上 ⇒ **不是**内存压力（那种情况另见笔记：available 低于
  ~500 MB 时窗口要几十秒、CDP 十几秒才回包）。
- `ss -ltn` 能看到 9222 在 LISTEN，curl 能完成 TCP 握手但读不到字节 ⇒ 进程活着、只是还没到
  能应答的阶段。
- `ps` 里已经有 `--type=renderer` 和 `--type=utility --utility-sub-type=network.mojom.NetworkService`
  ⇒ 窗口其实已经在创建了。注意这两个进程的命令行以 `/proc/self/exe` 开头，
  **按 `electron` 这个词去 grep 会漏掉它们**，从而误判成「渲染进程压根没起来」。

再遇到同样现象，先多等几分钟并重试 attach，别急着归因。
