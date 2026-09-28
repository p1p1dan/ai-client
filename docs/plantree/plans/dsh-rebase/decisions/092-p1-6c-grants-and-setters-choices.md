# 决策 092：P1-6c 授权记忆、档位 setter 与 P1-6b 收尾的实现取舍

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：[P1-6 方案](../topics/p1-6-permissions.md) §1 第 5、6 条与 §4.4～4.6、[分片 03](../topics/p1-6-permissions/03-design.md) §5、§7、§8、§10；[决策 043](043-grants-sidecar-next-to-stub.md)、[044](044-dsh-sandbox-off-by-default-in-p1.md)、[088](088-permission-gate-wiring-choices.md)「留给后续」、[090](090-user-rulings-2026-09-28.md)。改动留在工作区，由编排器复跑后提交。

## 规则

### 一、授权记忆 sidecar（决策 043）

1. **位置与格式**：
   - 桩旁的 `<桩名>.dsh.grants.json`，按桩文件命名，回退改写桩的指向时路径不变；
   - 内容是 1.0.x 的 v2 编码（`encodeGrants`），紧凑 JSON；
   - 写法与桩相同：临时文件、fsync、改名，同步执行；
   - 由闸门的 `persistGrants` 钩子触发，每次变化都写全量。「本会话允许」写全量，`configure` 写空集，「允许一次」不写。
2. **文件放在 `bridge/grantStore.ts`**，没有按方案放在 `permissions/`：bridge 行的打包输入只允许 `src/dsh-host/bridge/`（`BRIDGE_ENTRIES`），放在别处会打包失败。
3. **读回（失败关闭）**：
   - bootstrap 在建闸门之前就读，恢复、崩溃重启、新建都走这一步。新建会话的桩路径是确定的，所以「新建时发现同一会话已在磁盘上、改为重开」的情形也能读回授权；
   - 没有文件，就是没有授权；
   - 读不了、不是 JSON、版本不认识、或者超过 1 MiB，也按没有授权处理，并记日志。会话照常打开，下一次变化会写回一份合法的文件；
   - 单条坏记录跳过、其余保留，沿用 1.0.x 的 `decodeGrants`。
4. **回退、fork、丢弃、GC**：
   - 回退：还是同一个闸门，重新挂到子会话上，授权留在内存里；sidecar 的路径不变，也不改写；
   - fork：把 sidecar 按字节原子复制到子桩旁。复制失败只记日志，fork 照常完成，子会话从零授权开始，属于失败关闭。原来的 `copyFileSync` 一失败就让整个 fork 失败，现在不会了；
   - 丢弃 fork：删除顺序改为授权、桩、marker。marker 最后删，崩溃时它还在，仍然指向残留的文件；
   - GC：删桩时先删它的授权。桩已经不在的授权文件（例如 Main 启动时清扫暂存 fork，只删桩和 marker，不认识 sidecar），按桩的规则收：属于 `aiclient-`、没人认领、DSH 里没有同名会话、最后写入超过 24 h。删除只记日志，`gc-result` 协议不变。

### 二、三个 setter 与 `permissionGate`

5. **核对了 1.0.x 的清空语义**：
   - 1.0.x 的 `setPermissions` 就是 `configure`，每次调用都清空授权并写空集，不管 mode 变没变；
   - Main 在两轮之间，连只换档位也发 `worker.setPermissions`，只有回合进行中才改发 `worker.setPermissionGear`（`WorkerManager.setPermissions`）。所以 1.0.x 的实际行为是：两轮之间换档位也会清空授权，回合中换档位保留授权。
   - 这里原样沿用。`setPermissionTier` 先用 `migratePermissionTier` 迁移，再走 `setPermissions`。
6. **判断空闲时算上 DSH 自发的回合**：
   - 空闲的条件是：bridge 没有回合，包括收到 `turn/start` 时补登的 synthetic 回合；并且 agent 的状态是 idle。DSH 在写 `turn/start` 之前，就会把 agent 标成 running；
   - 只有后台 job 在跑，不算忙：它不占闸门，它唤醒的那一轮才算。
7. **不空闲时收到 `setPermissions`**：
   - 换 mode：报 `WORKER_SESSION_BUSY`，可重试；
   - mode 不变：按 `setGear` 处理，只挪档位，授权和排队的请求都保留。
   - 理由：Main 的 `activeRequestId` 只记它自己发出的回合，看不见 goal 续跑、job 唤醒，这时会发宽口的 RPC。一律报忙的话，goal 连跑期间用户就改不了档位。这样处理与 Main 对它看得见的回合所用的规则一致，也更接近 DSH 自己回合中可以切换策略的做法（决策 090 总原则）。
8. **`WORKER_PERMISSIONS_UNAVAILABLE`**：以下情形报这个码，与 native 相同：还没 bootstrap、闸门不存在、权限行没有路由本会话的通道、会话已经关闭。
9. **`permissionGate` 按实际情况上报**：
   - bootstrap 收尾时向权限行查询挂载状态，没挂上就拒绝这次 bootstrap，并关掉已打开的东西，不再上报一个没人执行的闸门；
   - 上报值仍是 `'bundled'`。线上类型只有 `bundled` / `user_configured` 两种，而 `user_configured` 指用户自装的 pi 权限扩展，不适用。

### 三、播种与策略目录

10. **环境变量 `AICLIENT_PERMISSION_AGENT_DIR`**：
    - 值是 `<appStateRoot>/pi-agent`，与 `getAppPiAgentDir()` 相同，也就是设置页编辑的那份全局策略所在的目录；
    - 在 `DshHostProcess` 里按常量拼路径，不 import `piModelConfig`，那个模块会拖进 electron、凭据库等；
    - 由 `buildDshHostEnvironment` 显式设置。`AICLIENT_*` 一律不继承，外面传进来的同名变量也会被剔除；
    - 这个目录宿主只读，不算私有目录。打包冒烟不传它，就不读用户层；
    - 宿主的 bridge 行读取后经 deps 交给每个会话。它是路径，不是密钥，与 `AICLIENT_RUNTIME_LOOP_GUARD` 一样，也会出现在宿主派生的工具环境里。
11. **分层规则照 1.0.x**：
    - 随包表；
    - 用户层：`<dir>/pi-permissions.jsonc`、`<dir>/extensions/pi-permission-system/config.json`；
    - 项目层与 local 层（`<cwd>/.pi/…`）：只在 `projectTrusted` 时读。`unbound` 的会话不受信，不读；
    - 不传 `settingSources`，native 也从来没传过；
    - 每次 bootstrap 读一次，`configure` 时不重读，与 1.0.x 相同；
    - 策略文件不合法时，bootstrap 失败，码为 `permission_policy_invalid`；超过 1 MiB 时码为 `io_limit`。这两点都同 1.0.x（见第 20 条）。

### 四、沙箱映射钩子（决策 044）

12. **`bridge/sandboxMode.ts` 只留接口**：
    - `dshSandboxModeFor` 就是决策 044 第 2 条那张表：plan 为 `read-only`，bypass 为 `danger-full-access`，其余档位为 `workspace-write`；
    - `deps.applySandboxMode` 是写入方。产品不提供，所以什么都不写，沙箱保持 `danger-full-access`；
    - bootstrap 之后、每个 setter 之后、回退之后都会调用它；
    - 写入失败只记日志。要不要因此让这次档位变更失败，由 P1-6e 定。

### 五、P1-6b 收尾

13. **`escalate_sandbox`**：
    - DSH 自己发起的询问（`approval/request`）在请求上带 `hostAsk` 标记；
    - 越界升级按 dsh-sandbox 的理由前缀 `escalate sandbox to ` 识别，卡片的 action 为 `escalate_sandbox`。第三方插件的询问沿用工具本身的 action；
    - 两类卡片都只给「允许 / 拒绝」，不带 `sessionGrantScope`。收到卡片没提供的 `allow_session` 时，按「允许一次」处理；
    - 闸门本身也不会记住 `hostAsk` 的授权，这是双保险；
    - 文案：英文 `Run once with wider sandbox permissions`，中文「以更宽的沙箱权限运行一次」，精修归 P1-7；
    - 产品组合关着沙箱，真宿主里不会出现这种卡，只有单测覆盖。
14. **提示词上下文 `aiclient:permission`**：
    - 由权限行经 `ctx.inject(['systemPrompt'])` 注册。不写进行本身的 `inject`，这样闸门不必等提示词组装就绪；
    - 顺序是 `APPROVAL_POLICY + 1`，即 116；
    - 正文是 1.0.x 的 `modeSegment` 与 `permissionGearSegment`，两句换行拼接；
    - 按发起组装的 agent 所属会话取值，子代理取根会话的档位；没挂闸门的 agent 为空；
    - DSH 在正文变化时追加一份新快照，所以换档从下一步起生效。
15. **`perm-*` 录制场景**：
    - 共 9 个：`perm-card`（S1）、`perm-grants`（S2 / S3）、`perm-deny`（S4）、`perm-plan`（S9）、`perm-gear`（S10 / S14）、`perm-stop`（S13）、`perm-restart`（S15）、`perm-subagent`（S16）、`perm-search`（S17）；
    - 每个场景各用一个子工作区，列目录和搜索的结果不受前面跑了哪些场景影响；
    - 假网关新增两个脚本：`P1-PERM-WRITES`、`P1-PERM-GRANTS`；
    - S5～S8、S11、S12 由纯库自己的用例覆盖；S12 所需的倒计时也没有 RPC 能调。S18 归 Windows CI（P1-6d）；
    - 金样本没有录，留给编排器在收口时录。

## 取舍

- 失败关闭一律朝「多问一次」的方向：sidecar 坏了、fork 没复制成功、授权文件没人认领，结果都是少授权，而不是会话打不开或授权越界。
- 策略文件不合法时，照 1.0.x 让 bootstrap 失败，没有改成跳过这一层：跳过会悄悄丢掉用户写的 deny 规则，属于失败开放。

## 待用户拍板

16. 第 7 条：DSH 自发回合进行中，只换档位的 `setPermissions` 按换档处理，不报忙。这与 RPC 注释里「回合中拒绝」的字面说法不同。
17. 第 5 条：两轮之间只换档位，也会清空「本会话允许」，这是原样沿用 1.0.x 的行为。如果想改成只有换 mode 才清空，改 Main 或 bridge 都行，但会偏离 1.0.x。
18. 第 11 条：策略文件不合法时，会话打不开（沿用 1.0.x）。

## 留给后续

19. P1-6d 做 pwsh 分析；P1-6e 写入 DSH 的 `sandbox/mode`；P1-9 把 pi 会话里的 `aiclient.permissionGrants` 迁移成 sidecar；P1-4c / d 把 `ABORTED_BEFORE_DISPATCH` 显示为「未开始」，`perm-stop` 样本里目前是 `tool call aborted before dispatch`。
20. 加密机（P1-13）：策略文件用普通 node fs 读取。如果加密软件对这些文件返回密文，bootstrap 会报 `permission_policy_invalid`。P1-13c 的读回退也许要覆盖这条路径。
21. sidecar 在 DSH_HOME（0700）里。auto 与 bypass 档下，模型能改写它，要等重开会话才生效。这与 1.0.x 会话文件的信任模型相同，本次没有处理。
22. 金样本：本次改动后，现有 9 个场景的 `log.*.json` 在运行时上下文里都多了 `aiclient:permission` 这一段（rewind 的已退役会话也一样）；`compact` 场景被压缩的历史随之变长，压缩提示里的 token 估计从约 223 变为约 334（`log.compact.json`、`rpc.compact.json`）。各场景的 `stream.*.json` 没有变化，RuntimeEvent 的形状不变。9 个 `perm-*` 场景还没有金样本，已用 `--out-dir` 连录两遍，结果逐字节一致。以上都等编排器收口时重录。
