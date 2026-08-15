> D47 S2 规格 rev.1 双盲对抗评审 · B 轨（Codex，证据与可验证性镜头，2026-08-15）。原文归档。

# 1. 问题清单

结论先行：当前 rev.1 还不适合直接写码。主要问题不是方案方向，而是四个会直接产生错误实现或假绿验收的施工缺口：

- `ensureWorkspaceTrusted` 没有规定真实调用点和覆盖矩阵。
- Scanner 的“双根注入”没有解决模块加载时序、现有 API 聚合方式和同 mtime 裁决。
- regenerate 与 `ClaudeHookManager` 仍是无锁整文件覆盖；规格引用的 `writeSettingsWithEnvGuard` 不是安全的读合写原语。
- Provider apply 被指定改成对象返回值，但现有 preload 与两个 renderer 调用方把它当 `boolean`；照规格直写会把“拒绝”当“成功”。

全程只读；未修改、创建或删除任何文件。当前 `git status --short` 与 `git diff --stat` 均为空。

## blocker

### B1. `ensureWorkspaceTrusted` 没有任何施工调用点，且“打开 workspace / 起会话 / resume / 起终端”不是同一条链

- 规格位置

  [S2 规格 §1、§2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:25)，特别是第 28、77–78、86–87 行。规格只定义了 helper 和启动时生成 `.claude.json`，没有规定哪个运行时入口负责调用 `ensureWorkspaceTrusted(homeDir, workspacePath)`。

- 仓内证据

  Chat 新建会话真实入口在 [chat.ts:48](/home/dan/projects/ai-client/src/main/ipc/chat.ts:48)：

  ```ts
  await sessionIndexService.recordCreated(payload);
  const requestId = await agentHostManager.createSession(payload);
  ```

  resume 是另一条独立入口，在 [chat.ts:112](/home/dan/projects/ai-client/src/main/ipc/chat.ts:112)：

  ```ts
  await sessionIndexService.recordResumed(payload);
  const requestId = await agentHostManager.resumeSession(payload);
  ```

  两者最终都会在 [AgentHostManager.ts:115](/home/dan/projects/ai-client/src/main/services/agent-host/AgentHostManager.ts:115) 经 `sendReady()` 先启动 Host、再发送 `session.create` 或 `session.resume`。因此 trust 写入如果晚于该点，就已经错过 CLI 启动前的门禁窗口。

  终端完全不走 `AgentHostManager`。新接口在 [session.ts:27](/home/dan/projects/ai-client/src/main/ipc/session.ts:27)，legacy 包装入口在 [session.ts:63](/home/dan/projects/ai-client/src/main/ipc/session.ts:63)。两者进入 [SessionManager.ts:66](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:66)，再按本地/远程分流；本地 PTY 在 [SessionManager.ts:355](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:355) 创建。

  renderer 的 workspace“选择”也不是一个 Main 侧 open-workspace IPC。比如 [App.tsx:425](/home/dan/projects/ai-client/src/renderer/App.tsx:425) 只是更新 worktree 状态；真正打开终端要到 [App.tsx:904](/home/dan/projects/ai-client/src/renderer/App.tsx:904) 才调用 `session.create({cwd: repoPath})`。

  远程路径还必须排除：`SessionManager.create` 在 [SessionManager.ts:71](/home/dan/projects/ai-client/src/main/services/session/SessionManager.ts:71) 对 `isRemoteVirtualPath(options.cwd)` 走远端，不应把远程虚拟路径写进本机托管 `.claude.json`。

- 问题实质

  规格无法回答实现者最关键的问题：“什么时候写 trust 才保证第一次启动不弹 trust 对话？”

  可能出现的返工分支包括：

  1. 只在 `CHAT_CREATE_SESSION` 调用：resume 冷启动和终端漏掉。
  2. 只在 `AgentHostManager.createSession` 调用：resume 与终端漏掉。
  3. 只在 renderer 选中 workspace 时调用：IPC 不存在，而且后台/恢复路径仍可绕过。
  4. 对所有 `SESSION_CREATE` 无条件调用：把 remote virtual path 写入本地 `.claude.json`。
  5. 在 Host 已经启动后调用：本次 CLI 可能已经做完 trust 判断。

  规格 §3 也没有为这些调用点安排测试，因此 helper 自身的“增量与幂等”测试可以全绿，但生产代码从未调用 helper，形成典型对空集通过。

- 建议改法

  在规格中钉死调用矩阵与顺序，至少应明确：

  1. `CHAT_CREATE_SESSION`：在 `recordCreated` 和 `agentHostManager.createSession` 之前，对本地 `workspacePath` 调用。
  2. `CHAT_RESUME_SESSION`：在 `recordResumed` 和 `agentHostManager.resumeSession` 之前调用。
  3. `SESSION_CREATE`：在 `sessionManager.create` 之前，对本地 `options.cwd` 调用。
  4. `TERMINAL_CREATE`：如果保留 legacy handler，要么它复用已带 trust 的统一 helper，要么单独断言调用；不能假定 renderer 已全部迁移。
  5. remote virtual path 明确 no-op，符合母规格 I8。
  6. 新增生产接缝测试：fake trust helper 必须在 fake Host/PTY create 之前被调用；create、resume、terminal、remote-no-op 四臂均需覆盖。不能只测 `ensureWorkspaceTrusted` 纯函数。

---

### B2. Scanner 的“构造注入双根”与现有模块级单例发生启动时序冲突，且规格未定义双根如何映射到现有两段式 IPC API

- 规格位置

  [S2 规格 §1 S2b](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:51)，第 59–60 行；测试要求在第 106、109–110 行。

- 仓内证据

  当前 Scanner 没有显式构造函数。它在每次方法调用时动态读取环境变量：

  [ClaudeSessionScanner.ts:26](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:26)

  ```ts
  function getClaudeProjectsDir(): string {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(claudeDir, 'projects');
  }
  ```

  `scanProjects()` 在 [ClaudeSessionScanner.ts:312](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:312) 只扫描一个 `projectsDir`；`getSessionsForProject(projectId)` 在 [ClaudeSessionScanner.ts:371](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:371) 也只从单根读取该 project。

  生产实例却是在模块加载时直接创建的：

  [claudeSessions.ts:3](/home/dan/projects/ai-client/src/main/ipc/claudeSessions.ts:3)

  ```ts
  const scanner = new ClaudeSessionScanner();
  ```

  `main/index.ts` 的所有静态 import 会先于模块体中的 `app.setPath` 和未来环境重定向执行。当前 `app.setPath` 在 [index.ts:131](/home/dan/projects/ai-client/src/main/index.ts:131)，IPC 注册要到 [index.ts:381](/home/dan/projects/ai-client/src/main/index.ts:381)。

  因此，如果施工按“构造函数默认读取 `process.env.CLAUDE_CONFIG_DIR`”实现，`claudeSessions.ts` 的模块级单例会在 S2 重定向设置之前捕获旧值。S1 规格本身已经识别过同类 ESM import 提升问题：[S1 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s1-vault-spec.md:10) 第 16–18 行。

  现有六个 Scanner 测试全部使用无参构造，并通过修改全局 env 设置单根：

  [ClaudeSessionScanner.test.ts:11](/home/dan/projects/ai-client/src/main/services/claude/__tests__/ClaudeSessionScanner.test.ts:11)

  ```ts
  process.env.CLAUDE_CONFIG_DIR = tempDir;
  ```

  无参构造分布在第 48、72、101、128、165、195 行。这六个测试都会受到必填构造参数或捕获时机变化的影响。

  现有 API 还是两段式：

  - `listProjects()` 返回 project 列表；
  - renderer 随后以单个 `projectId` 调 `getProjectSessions(projectId)`。

  对应 handler 在 [claudeSessions.ts:7](/home/dan/projects/ai-client/src/main/ipc/claudeSessions.ts:7)。

- 问题实质

  规格只写了“注入双根”，没有定义：

  1. 根是在何时解析：模块加载、注册 IPC、还是调用方法时？
  2. `scanProjects()` 如何合并同 slug project 的 `sessionCount` 和 `lastActivityAt`？
  3. `getSessionsForProject(projectId)` 如何保留每个 session 的来源根，供后续 resume 选择正确配置目录？
  4. 两根同一 slug/sessionId、相同 mtime 时谁胜？
  5. 一根 `stat` 失败、另一根成功时如何降级？
  6. 不同 project slug 下相同 sessionId 是否必须保留两条？

  如果只在 `getSessionsForProject` 去重，`scanProjects.sessionCount` 可能重复计数；如果先把 project 去重但不保留来源，resume 又无法稳定定位实际文件。测试即使只断言 `length === 1`，随便返回旧根或新根都能通过。

- 建议改法

  规格应先定义明确的数据模型和生命周期：

  - 禁止 `claudeSessions.ts` 在模块顶层根据 env 构造 Scanner。
  - 推荐把 scanner 工厂放到 `registerClaudeSessionsHandlers()` 内，由已经完成重定向的 bootstrap 显式传入：
    `new ClaudeSessionScanner({primaryProjectsDir, legacyProjectsDir?})`。
  - 或让构造参数是纯路径提供器，方法调用时解析；但必须明确而不是靠默认参数。
  - 定义 project 聚合：
    `projectId` 相同时合并，`sessionCount` 按去重后的 session key 计数，`lastActivityAt` 取胜者中的最大值。
  - 定义 session key 为 `(projectId, sessionId)`，不是只按 `sessionId`。
  - 定义胜者顺序：`mtimeMs` 大者胜；相等时必须有确定 tie-break，例如 primary 胜，不能依赖 `readdir` 顺序。
  - session 元数据需携带内部 `sourceConfigDir`，或 Scanner 提供独立 resolve-source API，避免 App 再做一套重复候选搜索。
  - 把现有六个测试明确列为受影响测试，并保留 flag-off 单根兼容测试。

---

### B3. regenerate 与 Hook 写手之间仍会互相覆盖；规格引用的 `writeSettingsWithEnvGuard` 不是读合写、不是锁，也不会阻止丢数据

- 规格位置

  [S2 规格 §2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:65)，第 79–81 行：

  > 生成器 regenerate 时必须保留非 managed 键……写法照 `writeSettingsWithEnvGuard` 的读-合-写。

  测试计划只在第 99–100、109–110 行要求单次 regenerate 保留外来键和对应变异。

- 仓内证据

  `writeSettingsWithEnvGuard` 的实际实现位于 [ClaudeHookManager.ts:115](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:115)：

  ```ts
  const before = readEnvSnapshot(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  ```

  它只读取两个 Anthropic env 键，然后直接把调用者传入的整份 `settings` 覆盖写盘。写完发现 env 变化时仅 `console.error`，不拒绝、不回滚、不重试，见 [ClaudeHookManager.ts:120](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:120)–137。

  `ensureStopHook()` 是典型的读—改—整文件写：

  - 读旧文件：[ClaudeHookManager.ts:371](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:371)–378；
  - 某些 migration 甚至绕过 guard 直接写：[ClaudeHookManager.ts:404](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:404)–409；
  - 最终 guard 写：[ClaudeHookManager.ts:452](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:452)。

  当前 Onboarding 写手同样是无锁整文件读合写：[OnboardingService.ts:333](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:333) 读取旧 settings，[OnboardingService.ts:370](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:370) spread 外来键，[OnboardingService.ts:375](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:375) 直接 `writeFileSync`。它的读回验证只验证两个 env 键，[OnboardingService.ts:380](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:380)–399，不验证 hooks/statusLine 是否同时存活。

- 问题实质

  下面这个真实交错仍会丢数据：

  1. HookManager 读取旧文件 `S`。
  2. generator 读取同一个旧文件 `S`。
  3. HookManager 写 `S + hooks`。
  4. generator 写 `S + managed env`。
  5. 最终 hooks 被抹掉。

  反向交错则可能让旧 env 覆盖新登录/登出生成结果。两个 Hook ensure 并发时也可互相抹掉不同 hook；statusLine 与 hooks 同样如此。

  “单线程 regenerate 保留 sentinel”测试可以全绿，却无法证明生产中的登录 regenerate、登出 regenerate、Hook 初始化、provider 写入之间不会互相覆盖。规格将 `writeSettingsWithEnvGuard` 描述为“读-合-写”证据也与源码不符。

- 建议改法

  在 S2 规格中增加单一 settings 写入所有权：

  - 在 Main 内建立共享的 per-path 串行队列/mutex；generator、HookManager 的所有 settings 写入、ProviderManager 本地写入都必须通过同一入口。
  - 共享入口应在获得锁后重新读取最新文件，再只 patch 自己拥有的键。
  - 使用临时文件、显式 0600、rename 的原子写；不能继续直接 `writeFileSync(settingsPath, ...)`。
  - 明确 managed 所有权仅为 `env` 中指定键、`autoUpdates`、`skipWebFetchPreflight`；hooks/statusLine/未知顶层键由其他写手保留。
  - 测试必须有受控并发交错：用 barrier 让 generator 和 Hook writer 都读到旧值，再释放写入，最终断言 managed env、hooks、statusLine 三类 sentinel 全存在。
  - “regenerate 抹外来键”变异仍保留，但不能代替并发测试。
  - 把 `ClaudeHookManager` 所有绕过 guard 的 direct write 纳入改造清单；否则中央锁只是部分覆盖。

---

### B4. `CLAUDE_PROVIDER_APPLY` 的新返回形状与现有 `Promise<boolean>` 契约冲突；照规格实现会把拒绝对象当成功

- 规格位置

  [S2 规格 §1 S2b](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:51)，第 53–55 行要求 flag-on 返回：

  ```ts
  { ok: false, reason: 'managed' }
  ```

- 仓内证据

  preload 当前把 apply 明确定义为 `Promise<boolean>`：

  [preload/index.ts:1020](/home/dan/projects/ai-client/src/preload/index.ts:1020)

  ```ts
  apply(...): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PROVIDER_APPLY, repoPath, provider)
  ```

  `SessionBar` 直接以 boolean 判断：

  [SessionBar.tsx:497](/home/dan/projects/ai-client/src/renderer/components/chat/SessionBar.tsx:497)

  ```ts
  onSuccess: (success, provider) => {
    if (!success) { ... }
  }
  ```

  `ActionPanel` 同样在 [ActionPanel.tsx:241](/home/dan/projects/ai-client/src/renderer/components/layout/ActionPanel.tsx:241)。

  当前 Main handler 的本地和远程分支也都返回 boolean 语义：[claudeProvider.ts:34](/home/dan/projects/ai-client/src/main/ipc/claudeProvider.ts:34)–47。

- 问题实质

  JavaScript 中 `{ok:false, reason:'managed'}` 是 truthy。若只按规格修改 Main handler而未同步修改 preload 与两个调用方：

  - renderer 会进入成功分支；
  - 可能弹出 “Provider switched”；
  - query 被刷新；
  - 实际写入被拒绝。

  即使 managed 模式正常隐藏按钮，已有窗口状态、IPC 直接调用、异步 flag 切换或遗漏的第三方调用仍可触发。静态类型也不会自动验证 Electron handler 的实际返回值与 preload 声明一致。

- 建议改法

  两种方案必须二选一并写入规格：

  1. 最小改动：继续返回 `boolean`，managed 模式返回 `false`，拒因仅 Main 诊断记录。
  2. 若确实需要 renderer 得知原因：定义共享判别联合，例如
     `{ok:true} | {ok:false; reason:'managed'|'write_failed'}`，同步修改 Main、preload、全体调用方和测试。

  不能只修改 handler。测试应直接驱动真实 handler → preload 形状 → renderer mutation 分支，断言 managed 拒绝不会进入 success toast 路径。

---

### B5. flag-off“逐字节不变”没有可执行的基线定义；现有“env spy”表述不足以证明零改动

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:31) 第 32–35、39–42 行；[§2.3](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:91) 第 93–95 行；测试计划第 101、103、105、109–110 行。

- 仓内证据

  Vitest 只收集 `src/**/__tests__/**/*.test.ts` 和 scripts 测试，见 [vitest.config.ts:11](/home/dan/projects/ai-client/vitest.config.ts:11)–14。

  现有 Scanner 测试展示了 env 保存/恢复模式，但不是“零写入”证明：[ClaudeSessionScanner.test.ts:11](/home/dan/projects/ai-client/src/main/services/claude/__tests__/ClaudeSessionScanner.test.ts:11)–25。

  现有 `ClaudeRuntimeConfig` 测试仍把 flag-off 路径定义为 fake homedir 下的 `~/.claude/settings.json`，见 [ClaudeRuntimeConfig.test.ts:10](/home/dan/projects/ai-client/src/main/services/cli/__tests__/ClaudeRuntimeConfig.test.ts:10)–23；它只比较该模块自己幂等调用前后的字节，[ClaudeRuntimeConfig.test.ts:52](/home/dan/projects/ai-client/src/main/services/cli/__tests__/ClaudeRuntimeConfig.test.ts:52)–58。

  S1 的 as-built 只证明 flag-off 不创建 vault，并没有给 S2 保存一份“今天完整登录对所有 legacy 文件的黄金字节”供将来差分。S1 规格把该要求写在 [S1 §3](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s1-vault-spec.md:119) 第 142–143 行，但当前 S2 不能仅引用自然语言充当基线。

- 问题实质

  以下弱断言都会假绿：

  ```ts
  expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  ```

  它抓不到：

  - 原值存在但被删除；
  - `ANTHROPIC_AUTH_TOKEN` 被剥离；
  - 无关 env 被改动；
  - 值被先写后恢复；
  - `CLAUDE_CODE_OAUTH_TOKEN` 被改；
  - flag-off 仍生成了托管目录，但测试没检查磁盘。

  “一次登录写调用与今天字节一致”也没有说明：

  - “今天”保存在哪里；
  - clock/registeredAt 如何冻结；
  - 比较哪些文件；
  - 是比较 JSON 对象还是原始字节，包括尾换行、缩进和 key 顺序；
  - 如何确认没有额外写 `<userData>/claude-home`。

- 建议改法

  规格应把验收落为两个独立测试：

  1. 环境零变异测试

     - 把启动早期 env 处理抽成纯函数或接受注入 env 对象。
     - 预置 `CLAUDE_CONFIG_DIR=sentinel`、多个 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、无关变量和空字符串变量。
     - flag off 前后对完整 `Object.entries(env)` 排序后做深比较。
     - 同时 spy 注入层的 `set/delete`，断言调用数为 0。
     - 变异“flag off 误设/删除任意一个键”必须使测试红。

  2. 磁盘差分测试

     - 冻结时间和随机源。
     - 准备同一组初始 legacy 文件，包含未知键、hooks、statusLine、尾换行等。
     - 一臂运行冻结的 legacy reference/golden，另一臂运行 S2 flag-off 实现。
     - 对 `.claude/settings.json`、`.claude.json`、`.codex` 相关旧写入逐文件比较原始 Buffer。
     - 额外断言 `<userData>/claude-home` 不存在，托管路径写调用为 0。
     - 验收记录必须报告比较文件数大于 0，防止 glob 错误导致空集合通过。

---

## major

### M1. §0“主进程 watcher 无视开关恒跑”是明确失实事实，会诱导实现者删除已有正确门控

- 规格位置

  [S2 规格 §0.3](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:17)，第 19 行：

  > 主进程 watcher 无视开关恒跑。

- 仓内证据

  Main 启动明确读取 `enableProviderWatcher`：

  [main/index.ts:773](/home/dan/projects/ai-client/src/main/index.ts:773)

  ```ts
  const providerWatcherEnabled =
    (...)?.enableProviderWatcher !== false;
  initClaudeProviderWatcher(mainWindow, providerWatcherEnabled);
  ```

  handler 初始化只在 `enabled` 时启动 watcher：[claudeProvider.ts:54](/home/dan/projects/ai-client/src/main/ipc/claudeProvider.ts:54)–62。

  动态关闭时还会显式 `unwatchClaudeSettings()`：[claudeProvider.ts:64](/home/dan/projects/ai-client/src/main/ipc/claudeProvider.ts:64)–72。

  renderer 的 `useClaudeProviderListener` 虽然注册订阅，但回调受 `enableProviderWatcher` 门控：[useClaudeProviderListener.ts:16](/home/dan/projects/ai-client/src/renderer/App/hooks/useClaudeProviderListener.ts:16)–24。

  `ProviderList` 的订阅另受窗口活跃状态 `shouldPoll` 门控：[ProviderList.tsx:205](/home/dan/projects/ai-client/src/renderer/components/settings/claude-provider/ProviderList.tsx:205)–215。

- 问题实质

  这是规格的前置事实反了。照此施工可能：

  - 重写已经存在的开关机制；
  - 删除动态 toggle；
  - 为“watcher 当前恒跑”写一个与真实系统相反的测试；
  - 混淆“用户 enableProviderWatcher 开关”和“managed credentials flag”两个不同门控。

- 建议改法

  将 §0 改为：

  - watcher 当前已经受 `enableProviderWatcher` 控制；
  - S2 要新增的是第二层 managed-mode 强制门控；
  - 启动条件应为 `enableProviderWatcher && !managedMode`；
  - 动态切换时 managedMode 优先，不允许用户设置把 watcher 在 managed 模式重新打开。

  测试矩阵应有四臂：用户开关 on/off × managed on/off，只有 `用户 on + managed off` 能启动 watcher。

---

### M2. 双源 mtime 测试还缺确定的两态构造和同 mtime 规则；只断言数量会对错误胜者放行

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:59) 第 59–60 行；[§3](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:97) 第 106、109–110 行。

- 仓内证据

  当前 Scanner 已读取 `stat.mtimeMs`，但仅用于 project 的 `lastActivityAt`，[ClaudeSessionScanner.ts:339](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:339)–361；没有跨根胜者逻辑。

  现有测试每例只创建一个根和一个文件，例如 [ClaudeSessionScanner.test.ts:56](/home/dan/projects/ai-client/src/main/services/claude/__tests__/ClaudeSessionScanner.test.ts:56)–76。

- 问题实质

  下面的测试不够：

  ```ts
  expect(sessions).toHaveLength(1);
  ```

  无论实现总取主根、总取 legacy 根、随 `readdir` 顺序取第一条，都会通过。

  同 mtime 未定义也会造成跨平台不稳定：某些文件系统或 CI 的时间粒度会让原本想制造的新旧文件得到同一 mtime。

- 建议改法

  用两个 `mkdtemp` 根、同一 `(projectId, sessionId)`，分别写入明显不同的 `firstMessage` sentinel。显式 `utimes`：

  1. A 旧/B 新，断言返回 B 的内容。
  2. A 新/B 旧，断言返回 A 的内容。
  3. mtime 相同，按规格定义的 tie-break 断言。
  4. 不同 projectId、相同 sessionId，断言保留两条。
  5. 同 projectId、不同 sessionId，断言都保留。
  6. 每臂先断言两个输入文件确实存在、mtime 顺序符合预期，最终结果数量大于 0。

  “双源去重取旧”变异必须改变胜者内容，而不仅是数组长度。

---

### M3. 新的 homedir 静态扫描若只沿用 `offenders === []` 范式，会同时存在扫描器空集假绿和白名单过宽假绿

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:43) 第 45–46 行；测试计划第 108 行。

- 仓内证据

  S1 的 `staticImportBans` 递归枚举实际目录并最终只断言 offenders 为空：

  [staticImportBans.test.ts:17](/home/dan/projects/ai-client/src/main/services/auth/__tests__/staticImportBans.test.ts:17)–22、[staticImportBans.test.ts:36](/home/dan/projects/ai-client/src/main/services/auth/__tests__/staticImportBans.test.ts:36)–73。

  如果 `listSources()` 路径错误、过滤器过滤掉全部文件、或白名单匹配过宽，`toEqual([])` 仍然通过。

  S2 当前确实存在两个应保留的非空白名单目标：

  - [OnboardingService.ts:311](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:311)，另有 `.claude.json`/settings 写点在 523、543、654；
  - [RemoteHelperSource.ts:2092](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:2092)–2109。

  也确实存在当前应被施工消除的非白名单目标：

  - [McpManager.ts:14](/home/dan/projects/ai-client/src/main/services/claude/McpManager.ts:14)–15；
  - [PluginsManager.ts:7](/home/dan/projects/ai-client/src/main/services/claude/PluginsManager.ts:7)–12；
  - [PromptsManager.ts:5](/home/dan/projects/ai-client/src/main/services/claude/PromptsManager.ts:5)–6、59；
  - [ClaudeRuntimeConfig.ts:5](/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts:5)–6；
  - [ClaudeSessionScanner.ts:26](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:26)–28。

- 问题实质

  规格没有说明扫描规则本身如何被验证。尤其 `RemoteHelperSource.ts` 的匹配位于远程 helper 模板内容中，如果简单剥字符串或全文件 allowlist，未来该文件本地执行区新增真实硬编码也会被无条件放过。

- 建议改法

  - 把扫描逻辑提成接受 `{relativePath, source}` 的生产测试 helper。
  - 正控 fixture：普通 Main 文件含 `path.join(os.homedir(), '.claude')`，必须报错。
  - 负控 fixture：注释、文档字符串、合法 `CLAUDE_CONFIG_DIR ?? ...` 形状按规则处理。
  - 白名单按精确相对路径和精确命中位置/标记，而不是“整文件跳过”。
  - 断言生产扫描文件数大于 0、候选匹配数大于 0、两个白名单目标各恰好命中预期次数。
  - 对 Onboarding 要求紧邻 `legacy-until-S6` 标记；对 RemoteHelper 要求命中位于 remote template 段。
  - 变异验证应删除白名单标记或把普通文件伪装成白名单，测试必须红。

---

### M4. `auth.managedMode` 与 S1 静态扫描本身相容，但规格必须禁止通过 preload 直接接触 `AuthStateService`

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:53) 第 56–58 行；§4(b) 第 115 行。

- 仓内证据

  S1 静态测试扫描 renderer 和 preload，并禁止出现 `AuthStateService` 文本：

  [staticImportBans.test.ts:56](/home/dan/projects/ai-client/src/main/services/auth/__tests__/staticImportBans.test.ts:56)–65。

  它还禁止 renderer/preload 接触完整 onboarding 返回类型和 `CredentialVault`，见第 36–53、67–73 行。

  但该测试没有禁止普通 IPC channel 或 `Promise<boolean>`。因此以下架构不会让现有 S1 测试变红：

  - Main handler 内读取 `resolveManagedCredentialsEnabled(process.env)`；
  - shared 只增加 channel 常量；
  - preload 只暴露 `managedMode(): Promise<boolean>`；
  - renderer 只消费 boolean。

- 问题实质

  “新增 auth IPC 会不会导致 S1 测试变红”的答案是：正确实现不会；错误地让 preload import `AuthStateService` 会。

  所以不需要给 S1 的 `AuthStateService` 禁令加宽泛白名单。如果施工者把“显式放宽 auth IPC”误解成允许 preload import Main service，然后修改静态扫描放过该文件，会破坏 S1 的结构性边界。

  此外，S1 测试描述仍写着“S1 wires it into nothing yet”，这是阶段描述而非永久规则；S2 后最好更新描述，但不应削弱断言。

- 建议改法

  在 S2 规格明确写：

  - `auth.managedMode` handler 只在 Main 注册。
  - preload 不得 import `AuthStateService`、`CredentialVault` 或 Main onboarding 类型。
  - renderer/preload 原有 staticImportBans 必须 0 改动继续绿；最多更新测试说明文字。
  - 新增真实 IPC handler 测试，验证返回值严格为 boolean，且返回对象中不存在 auth state、email、token、vault 等字段。
  - 负控：在 preload fixture 中放入 `AuthStateService` import，扫描器必须红。

---

### M5. `ClaudeRuntimeConfig` 改口径会影响现有测试与两个生产调用方，规格只点了 `AgentInstaller`，覆盖清单不完整

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:39) 第 41–42 行；§4(a) 第 114 行。

- 仓内证据

  当前 path helper 硬编码真实 home：[ClaudeRuntimeConfig.ts:5](/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts:5)–6。

  `disableClaudeAutoUpdates()` 在 [ClaudeRuntimeConfig.ts:31](/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts:31)–37 读合写 `autoUpdates:false`。

  `AgentInstaller` 的生产依赖确实存在：[AgentInstaller.ts:376](/home/dan/projects/ai-client/src/main/services/cli/AgentInstaller.ts:376)–383。

  但全仓还有 `main/ipc/claudeRuntime.ts:50` 调用该函数；规格没有把它列入受影响调用面。

  当前测试全部通过 fake `os.homedir()` 建立 `~/.claude`，见 [ClaudeRuntimeConfig.test.ts:10](/home/dan/projects/ai-client/src/main/services/cli/__tests__/ClaudeRuntimeConfig.test.ts:10)–23。改成优先 `CLAUDE_CONFIG_DIR` 后，现有测试必须增加 env 清理，否则测试进程继承的 `CLAUDE_CONFIG_DIR` 会改变落点。

- 问题实质

  “改口径而非删除”的方向有真实生产依赖支撑，但测试/调用影响面写少了。尤其全量测试共用 `process.env`，如果测试未在 beforeEach/afterEach 保存和恢复 `CLAUDE_CONFIG_DIR`，会产生顺序相关失败。

- 建议改法

  在规格受影响清单中补：

  - `src/main/ipc/claudeRuntime.ts` 调用方；
  - `ClaudeRuntimeConfig.test.ts` 全部现有用例；
  - 两臂路径测试：env 有值落 env 根，env 无值落 fake homedir；
  - 每例严格恢复 env；
  - flag-off byte compatibility 继续断言原缩进和尾换行。
  
  若 flag-on 生成器已经写 `autoUpdates:false`，运行时重复调用必须只在值缺失时写，避免无意义触发并发覆盖。

---

### M6. 规格把 “GENERATED 文件” 与 “保留外来键”同时交给施工者裁定，但未定义损坏 JSON、managed 键所有权和无法合并时的行为

- 规格位置

  [S2 规格 §2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:67) 第 69–81 行；§4(d) 第 117 行。

- 仓内证据

  规格允许 `__generated__` 抬头，但又要求 hooks/statusLine 等外来键永久保留。

  当前 Onboarding 的 `readJsonIfExists` 失败行为需要由调用者接受空对象；当前 `ClaudeRuntimeConfig.readJsonSafe` 在解析失败时直接返回 `{}`，[ClaudeRuntimeConfig.ts:9](/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts:9)–16。若生成器照此模式，损坏文件会被静默替换，外来键无法保留。

- 问题实质

  “生成文件勿编辑”通常意味着 app 可覆盖全部内容；“保留外来键”则意味着这是共享、合并所有权文件。两者的恢复策略完全不同。

  没有定义损坏 JSON 时的行为，施工者可能：

  - 清空并覆盖，丢 hooks/statusLine；
  - 因解析失败拒绝 regenerate，导致登录凭据未更新；
  - 写旁路文件，但 CLI 仍读旧损坏文件。

- 建议改法

  明确 settings.json 是“共享合并文件”，不是全文件 app 独占生成物。`__generated__` 文案只能说明 managed 字段，不应声称整文件勿编辑。

  定义损坏 JSON 策略：备份原始字节、记录诊断、原子生成最小 managed 文件；并明确这是唯一允许无法保留外来键的降级场景。测试应覆盖 malformed JSON，不能只测合法未知键。

---

## minor

### m1. §0/§1 指定 file:line 核对结果：主体引用基本属实，但有两处口径需要修正

- 规格位置

  [S2 规格 §0](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:8)–20、§1 第 39–46、59–62 行。

- 仓内证据与逐项判定

  | 规格引用 | 判定 | 当前真实证据 |
  |---|---|---|
  | `McpManager.ts:14-15` | 属实 | [McpManager.ts:14](/home/dan/projects/ai-client/src/main/services/claude/McpManager.ts:14)–15：`path.join(os.homedir(), '.claude.json')` |
  | `PluginsManager.ts:7-12` | 属实 | [PluginsManager.ts:7](/home/dan/projects/ai-client/src/main/services/claude/PluginsManager.ts:7)–12：plugins 与 settings 两个硬编码根 |
  | `PromptsManager.ts:5-6,59` | 属实 | [PromptsManager.ts:5](/home/dan/projects/ai-client/src/main/services/claude/PromptsManager.ts:5)–6、59：`CLAUDE.md` 与 backups |
  | `ClaudeRuntimeConfig.disableClaudeAutoUpdates` | 属实 | [ClaudeRuntimeConfig.ts:5](/home/dan/projects/ai-client/src/main/services/cli/ClaudeRuntimeConfig.ts:5)–6、31–37 |
  | `RemoteHelperSource:2092` | 属实 | [RemoteHelperSource.ts:2092](/home/dan/projects/ai-client/src/main/services/remote/RemoteHelperSource.ts:2092)–2109；处于远程 helper 源码模板段，派生远端 plugins/settings 路径 |
  | `SessionBar.tsx:485/500` | 属实 | [SessionBar.tsx:483](/home/dan/projects/ai-client/src/renderer/components/chat/SessionBar.tsx:483)–500 |
  | `ActionPanel.tsx:231/243` | 属实 | [ActionPanel.tsx:229](/home/dan/projects/ai-client/src/renderer/components/layout/ActionPanel.tsx:229)–243 |
  | `ProviderList.tsx:211` | 属实，但有门控 | [ProviderList.tsx:205](/home/dan/projects/ai-client/src/renderer/components/settings/claude-provider/ProviderList.tsx:205)–215；`shouldPoll` false 时不订阅 |
  | `ClaudeSessionScanner.ts:27` | 属实 | [ClaudeSessionScanner.ts:26](/home/dan/projects/ai-client/src/main/services/claude/ClaudeSessionScanner.ts:26)–28 |
  | `App.tsx:131` | 属实 | [App.tsx:122](/home/dan/projects/ai-client/src/renderer/App.tsx:122)–150，候选确为 `claude-null`、`~/.claude` |
  | `App.tsx:1176` | 属实 | [App.tsx:1163](/home/dan/projects/ai-client/src/renderer/App.tsx:1163)–1182，诊断文案确实列两条路径 |
  | `App.tsx:1163 resume` | 属实 | [App.tsx:1163](/home/dan/projects/ai-client/src/renderer/App.tsx:1163) 是真实 resume callback |
  | “Provider 3 查询/变更点” | 属实 | ProviderList、SessionBar、ActionPanel 三面均有 read/apply |
  | “2 订阅点” | 属实但描述需精确 | ProviderList 订阅受 `shouldPoll` 门控；`useClaudeProviderListener` 回调受 `enableProviderWatcher` 门控 |
  | “主进程 watcher 无视开关恒跑” | 失实 | 已列为 M1 |
  | “6 文件 12 处” | 部分属实/计数口径不清 | 六个文件成立；若把 `McpManager:14-15` 的跨行表达式算“两行”，可得 12；按实际 `path.join` 表达式算是一处，合计为 11。应改成明确列举，不使用模糊总数 |

- 问题实质

  引用整体没有大面积漂移，但 watcher 事实反转是实质错误；“12 处”则是行数和表达式数混用。

- 建议改法

  删除总数或列出 12 个精确表达式/符号。Provider 门控分别写清 `shouldPoll`、用户 watcher 设置、managedMode 三层，而不是统称“无视开关”。

---

### m2. `claude-null` 判死的源码事实成立，但规格应把 Scanner 来源与 resume 候选统一，避免两套重复决策

- 规格位置

  [S2 规格 §1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:61)–63。

- 仓内证据

  候选列表只在 [App.tsx:131](/home/dan/projects/ai-client/src/renderer/App.tsx:131)–150；诊断文案只在 [App.tsx:1174](/home/dan/projects/ai-client/src/renderer/App.tsx:1174)–1182。

  Scanner 已经读取了具体 session 文件并取得 mtime。如果 Scanner 合并时选出了胜者，App 再按另一套候选顺序探测可能选择到不同副本。

- 问题实质

  双源去重决定“哪份 session 是权威”，resume 候选又独立决定“从哪个 config dir resume”。两个算法若不共用来源，可能 Scanner 展示新副本内容，resume 却启动旧副本。

- 建议改法

  去重胜者需要把来源根随 session metadata 一并带到 resume，或由 Main 提供 `resolveSessionSource(projectId, sessionId)`。App 不应重新根据固定候选顺序猜来源。

---

### m3. S0 E2/E3 只能证明 CLAUDE_CONFIG_DIR/trust premise，不能证明 S2 的调用时序、并发写入或全量无 HOME 副作用

- 规格位置

  [S2 规格 §2.1](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s2-claude-home-spec.md:67) 声称“照 E2/E3 实证”。

- 仓内证据

  E2 只证明 CLI 从 `$CLAUDE_CONFIG_DIR/.claude.json` 读取 onboarding/trust：[e2-claude-json-trust.md:5](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e2-claude-json-trust.md:5)–21。

  E2 同时记录 CLI 自动更新仍在 fake HOME 下创建 `.npm` 文件：[e2-claude-json-trust.md:57](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e2-claude-json-trust.md:57)–71。

  E3 证明 `settingSources:[]` + 注入 env 的单轮 SDK 会话可工作，并且该次 fake HOME 为空：[e3-sdk-no-home-session.md:5](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s0-spikes/e3-sdk-no-home-session.md:5)–18。

- 问题实质

  E2/E3 不支持以下更强结论：

  - `ensureWorkspaceTrusted` 已接入所有生产入口；
  - HookManager 与 generator 并发不会覆盖；
  - PTY 手敲 Claude 的整条链已验证；
  - “一次 SDK 会话期间真实 `~/.claude*` 写调用数=0”已经有自动测试。

- 建议改法

  保留 E2/E3 作为 premise 证据，但 S2 必须新增生产接缝和 fs spy 测试，不能把 spike 报告当成施工验收替代品。

---

# 2. 规格 §4 自设裁定 a–f 判真伪

| 项 | 裁定原文 | 判定 | 依据 |
|---|---|---|---|
| a | `ClaudeRuntimeConfig.disableClaudeAutoUpdates` 改口径而非删除 | **成立，但受 M5 约束** | 生产依赖真实存在：安装 Claude 后 [AgentInstaller.ts:376](/home/dan/projects/ai-client/src/main/services/cli/AgentInstaller.ts:376)–383 调用；另有 `claudeRuntime.ts:50` 调用。母规格“删除”若立即执行会破坏 flag-off 安装后的自动更新禁用。应改为 `CLAUDE_CONFIG_DIR ?? ~/.claude`，并补齐调用方/测试影响。 |
| b | renderer 通过只读 `auth.managedMode` IPC 感知 flag；显式放宽 S1“不注册 auth IPC” | **成立，条件成立** | boolean 查询本身不泄密，也不会触发现有 S1 静态禁令。现有禁令只禁止 renderer/preload 接触完整 onboarding 类型、`AuthStateService`、`CredentialVault`，[staticImportBans.test.ts:36](/home/dan/projects/ai-client/src/main/services/auth/__tests__/staticImportBans.test.ts:36)–73。前提是 preload 仅 invoke channel，不直接 import Main service；不应新增宽泛豁免。 |
| c | Main 在 flag on 时无条件覆盖 dev.js 已设 `CLAUDE_CONFIG_DIR` | **成立，但必须配合启动时序修订** | S2 目标是 app 托管 home，显式开 flag 意味着验证托管链；覆盖 dev 旧值是可判定行为。问题在于静态 import 已先创建 `claudeSessions.ts` 单例，[claudeSessions.ts:5](/home/dan/projects/ai-client/src/main/ipc/claudeSessions.ts:5)，所以仅在 `index.ts` 设 env 不足以保证所有“构造注入”消费者看见新值。 |
| d | regenerate 读合写保留外来键 | **部分成立** | “保留外来键”是必要契约，Onboarding 当前确实通过 spread 保留合法 JSON 中的未知键，[OnboardingService.ts:333](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:333)–374。但“照 `writeSettingsWithEnvGuard`”不成立：该函数不是读合写，仅整文件写后报警，[ClaudeHookManager.ts:115](/home/dan/projects/ai-client/src/main/services/claude/ClaudeHookManager.ts:115)–137。并发覆盖、损坏 JSON 和共享所有权仍未裁定。 |
| e | 双源按 `projects/<slug>/<sessionId>` 去重，mtime 新者胜 | **部分成立** | key 应准确表述为 `(projectId/slug, sessionId)`，否则不同项目同 sessionId 会误合并；mtime 新者胜可实现、可两态测试。但同 mtime tie-break、project 聚合、来源传给 resume、错误降级均未定义，因此当前裁定不足以施工。 |
| f | PromptsManager 跟随重定向后，员工现有 `~/.claude/CLAUDE.md` 在 flag-on 不可见；当前裁定接受 | **成立** | 影响事实真实：当前全局 prompt 与 backup 都固定在真实 home，[PromptsManager.ts:5](/home/dan/projects/ai-client/src/main/services/claude/PromptsManager.ts:5)–6、59；改为跟随 `CLAUDE_CONFIG_DIR` 后不会读取旧文件。母规格允许托管 home 隔离，因此“接受并登记”是有效产品裁定，不是实现错误。但应在 managed-mode UI/迁移说明中明确，且加测试证明 flag-on 不偷读真实 home、flag-off 仍读原路径。 |

# 3. 只改 blocker 能否开工

**只改 blocker 后，可以开始 S2a 的有限施工，但不能把整片视为可验收开工；至少还必须同时修正 M1 的 watcher 失实前提。**理由是 B1–B5 决定了生产调用覆盖、启动时序、数据不丢、IPC 返回契约和 flag-off 核心验收，属于写码前必须钉死的施工边界；而 M1 虽列 major，却是一个已被源码直接反驳的前置事实，若不先改，Provider watcher 子任务会按错误现状施工并必然返工。

Codex session ID: 01a0062c-88ba-7f00-a7b8-05c3a4909d0d
Resume in Codex: codex resume 01a0062c-88ba-7f00-a7b8-05c3a4909d0d
