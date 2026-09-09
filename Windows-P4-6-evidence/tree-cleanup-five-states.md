# 命令树清理五态 · Windows 实测证据（P1-0）

> 生成：2026-09-09 · 主机：Windows 11（本机，TEC 加密域）
> 基座：`src/runtime/host/exec.ts`（`node-runner-pipe-v1`，与生产 bundled-node 同款 IPC runner）+ `src/runtime/host/exec-runner.mjs`
> 契约：P1-0 §4「进程清理」——adapter 必须管理进程组/进程树，**取消/超时/dispose 走同一清理路径**；**单独断言 `child.kill()` 被调用不算数**，树必须真实消失；POSIX 进程组与 Windows 进程树分别验证。

## 清理路径（读码确认）

- 统一入口 `stop(reason)`：`killTree(false)`（SIGTERM / taskkill 不带 /T？→ 实测为 taskkill /PID /T /F）→ 折半宽限后 `killTree(true)`（强制）→ cleanup deadline 兜底。
- 五态触发：正常=根进程退出 + `process.on('message')` 收到 `exit`；超时=`setTimeout(stop('timeout'), timeoutMs)`；取消=`AbortController.abort`；父先退=根提前退出后 `child.on('close')` 仍 `killTree(true)`；应用退出=`ExecPlugin.stop()` → 对所有 active `abort('disposed')`。
- Windows 树杀：`taskkill /PID <runner-pid> /T /F`（exec.ts:195），runner 为 leader（exec-runner.mjs 由 runner 派生 → 命令行、进程组均可回溯）。
- 兜底：exec-runner.mjs `process.on('disconnect')`（Windows）自身再 `taskkill /PID self /T /F`，保证父（exec.ts）异常退出时 runner 仍自清。

## 实测方法

复现生产 runner 形态：`standaloneHost`（node=随包/当前 node，source=current-process）→ 真实 node-runner pipe；命令为 node `-e` 脚本，**脚本内再 spawn 一个持续心跳的孙进程（node -e，写入 ready 标记并每 10ms 更新心跳文件）**，使命令树有 ≥2 层真实后代。
每个状态完成后，用 PowerShell 枚举 `node.exe`，过滤命令行含本次 tag 的进程，**断言残留数为 0**；同时对应用退出态复核 `exec.run()` 后续请求被 `runtime_disposed` 拒绝。

```text
状态         期望 termination      实测
正常根退出      exit                 ✓ 无残留 node.exe
超时 kill      timeout              ✓ 无残留 node.exe（且探索证 timeout 路径在 Windows 生效）
父先退(leader) exit                 ✓ 无残留 node.exe
取消 abort      aborted              ✓ 无残留 node.exe
应用退出 dispose disposed            ✓ 无残留 node.exe；后续请求被拒
```

## 结论

1. **五态清理路径在 Windows 真实命中**：tree 根经 runner（leader）派生，`taskkill /PID /T /F` 强制整树终止，未留下任何带 tag 的 `node.exe`（含孙进程）。
2. **不依赖"断言 child.kill 被调用"**：每个状态都验证"命令行含 tag 的 node 进程数 == 0"，即真实树消失，符合 P1-0 契约。
3. **超时/取消/dispose 同路径**：均走 `stop()` → `killTree`；dispose 额外验证 active 命令全部 settle 且新请求被拒。
4. **exec-runner 兜底**：disconnect 时 runner 自清，覆盖"父先退或异常"的残余场景。

## 备注

- 本探针临时文件 `src/runtime/__tests__/zz-tmp-tree-probe.test.ts`（verification-only），验证后已删除，未留下测试源码改动。
- 已有 `host.test.ts` 13 项（含 retains a runner leader and cleans descendants）在 Windows 全过，与本专项互为印证。
- **探针写入的临时文件**位于系统 tmp（acl-tree-*），已随测试清理，无工作区残留。
