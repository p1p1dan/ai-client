Role: detail shard

# P1-5 分片 04 · 一次性补全换引擎（P1-15）

上位：[P1-5 方案](../p1-5-models-and-credentials.md)。回答调研问题 5。行号约定同方案页。

## 1 现状

- **三种补全，都在 Main 里拼提示词**，然后调 `piUtilityService.complete()`：

  | 功能 | 入口 | 输入 | 超时 |
  |---|---|---|---|
  | 提交信息 | `GIT_GENERATE_COMMIT_MSG`（`ipc/git.ts:376-402`）→ `commit-message.ts:69-119` | 最近 5 条提交标题、暂存区 `--stat` 与 diff（截到 `maxDiffLines`，`:74-81`）；可用自定义模板 | 设置里的秒数 |
  | 分支名 | `GIT_GENERATE_BRANCH_NAME`（`ipc/git.ts:520-541`）→ `branch-name.ts:17-34` | 渲染层给的提示词 | 120 s |
  | 代码评审 | `GIT_CODE_REVIEW_START / STOP`（`ipc/git.ts:405-467`）→ `code-review.ts:73-122` | `git diff HEAD --submodule=diff`、相对默认分支的 log（`:85-91`）；流式回传（`onDelta`） | 10 min |

- **git 在哪个进程里跑**：由 Main（Electron）派生——非 WSL 仓库走 `execSync('git …')`（`commit-message.ts:20-29`），WSL 仓库与代码评审走 `spawnGit`（`:31-66`、`code-review.ts:17-37`）。读仓库文件的是 git 进程本身；补全 worker 不读任何文件，提示词里已经是 diff 文本。
- **模型与档位**：来自设置页每项功能的选择（`AISettings.tsx:114-194`）。「Automatic」不发 model，原生取目录里的第一个模型；档位里的 `off` 与不选都不发（`nativeUtility.ts:37-50`、`:110`）。系统提示词是一句固定的「tool-free completion service」（`:33-35`）。
- **载体**：`PiUtilityService`（`PiUtilityService.ts:94-392`）。
  - 每个操作 fork 一个原生 worker（`:110-123`），走 worker RPC 的 `utility.start / cancel`，结果经 `utility.delta / terminal` 事件回来（`workerRpc.ts:698-756`）。
  - 容量 2（`:106`）；每个操作带超时（`:168-173`），取消时等回执 3 s（`:78`）。
  - 登出时 `invalidateAll`（`:234-242`，由 `ipc/onboarding.ts:126-134` 调用），退出时 `disposeAll` / `forceKillAllNow`。
  - 目录经 `utility.start.modelCatalog` 下发，含明文 key（`:188-200`、`:398`）。
- **本分支现状**：bridge 的 `createUtilityRuntime` 直接抛 `WORKER_DSH_UNSUPPORTED`（`bundle/lib/bridge.js:64-66`）。`PiWorkerRpcServer` 已经有完整的 `utility.start / cancel` 处理（`piWorkerRpcServer.ts:634-680`），只是没有 DSH 实现。

## 2 候选方案

| 方案 | 做法 | 代价 | 加密机 |
|---|---|---|---|
| **A' 宿主 LLM 直调**（推荐） | bridge 的 `createUtilityRuntime` 换成 `DshUtilityRuntime`：用 `resolveRoute(plan, model, effort, 'utility')` 定路由，调 `ctx.llm.stream({provider, model, system, messages:[user 文本], reasoningEffort?, signal})`（`dsh-llm` README:48-70），把 text-delta 转成 `utility.delta`，把 finish 转成 `utility.terminal`；取消即 abort。Main 的 `PiUtilityService` 只把 `createSlot` 换成 DSH 通道（P1-1 阶段是每个操作一个宿主，P1-3 之后是共享宿主上的虚拟通道），公开接口不变 | 宿主没在跑时，要冷启动约 0.8 s，常驻约 180 MB，空闲 10 min 后关停（决策 025）；共享宿主崩溃会连带在飞的补全失败，与现在 worker 崩溃相同，报 `PI_UTILITY_TRANSPORT_FAILED`；P1-3 要允许 `utility.start` 建通道（它现在规定只有 bootstrap 能建） | 不变：宿主不读文件，git 仍由 Main 派生 |
| A 宿主开临时会话 | `agents.create` 加 `followup` | 带上工具和 DSH 的大段系统提示词，费用更高；diff 会落进 `$DSH_HOME/sessions`，多一份磁盘副本，还要 GC；与原生「不建会话」的约定相反（`workerRpc.ts:694-697`） | 不变 |
| B Main 直调网关 | Main 引入 pi-ai（根目录现在只经 `pi-coding-agent` 间接带着 0.84.4，`package.json:48`），按同一份计划在 Main 里构造模型对象并 `streamSimple` | key 不出 Main；但要在 Main 里再维护一套调用栈，User-Agent、compat、重试、代理都得和 DSH 对齐（pi-ai 在 Node 里用全局 fetch，不走 Electron 的代理设置，推断）；Main 包体积变大，electron-vite 拆块又多一个风险点；P1-12 删 runtime 时这一套要保留下来 | 不变 |
| C 保留极小的补全载体 | 把 `nativeUtility.ts` 和 model-adapter 三个文件留成一个独立入口，仍跑在随包 node 上 | 两套调用栈长期并存；打包还得带 agent-host 的 worker bundle 和 pi-ai 全家；key 继续放在 `utility.start` 负载里进子进程；P1-12 删不干净 | 不变 |

## 3 推荐 A' 的理由

- **只有一条模型路径**：路由、凭据、User-Agent、代理、失败码都与会话共用，界面上的「Automatic」和各档位，与聊天走同一个 `resolveRoute`。
- **协议零新增**：沿用现有的 `utility.*` RPC 与 `PiWorkerRpcServer`；Main 侧只换 transport，改动小。
- **P1-12 能删干净**：不再需要原生 worker、`WorkerModelCatalog` 和 `forkPiWorkerProcess` 的补全用法（导入另归 P1-9）。
- **与原生语义对齐**：不建会话、没有工具、不落盘；只试一次（直调不重试），原生的补全也不走会话的重试链。

## 4 实现要点

- **bridge**：`inject` 加 `llm`（现在是 `bundle/lib/bridge.js:27`）；`DshUtilityRuntime` 放在 `src/dsh-host/bridge/`，系统提示词常量从 `nativeUtility.ts:33-35` 移到 shared，两边共用。
- **Main**：`PiUtilityService` 的默认 `createSlot` 改成 DSH 通道，不再读 `resolveNativeModelCatalog()`（`:398`），`utility.start` 不再带 `modelCatalog`。
- **静态守卫**：`PiUtilityService.ts` 不引用 `forkPiWorkerProcess` 与 `resolveNativeModelCatalog`，写法仿 `chatEngineDshOnly.test.ts`。
- **错误**：`finish.failure.code` 经[分片 03 §5](03-design.md#5-设置与失败码映射)的表映射后放进 `terminal.error`；取消、超时仍由 Main 的计时器决定（`PiUtilityService.ts:168-173`）。
- **依赖**：P1-5a 的计划与 `resolveRoute`、P1-5b 的凭据；P1-3 之后才能改用共享通道。

## 5 测试

- **单测**：`DshUtilityRuntime` 用假的 `ctx.llm.stream`，覆盖增量转发、完成、取消即 abort、失败码映射，以及 Automatic 与各档位经 `resolveRoute` 的结果（`off` 与不选都不带档位）。
- **`PiUtilityService` 现有测试**（`__tests__/PiUtilityService.test.ts`）换一个假 transport 后全部重跑：容量、超时、取消回执、`invalidateAll`、`forceKillAllNow`。
- **bridge-smoke** 加一个场景：假网关回一段流式文本，检查增量顺序、最终文本、`terminal.model` 等于我方 id；再加一次取消。
- **开发机点验**（假网关注册为用户服务）：三种补全各点一次，代码评审中途点停止。
- **真实网关**：见方案页 §7.3 的 R7。
