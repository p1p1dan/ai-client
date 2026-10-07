# 决策 152：P1-5e 管理员 key 移入保险库的实现取舍

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [P1-5 分片 05](../topics/p1-5-models-and-credentials/05-changes-and-tests.md) 的 P1-5e 原方案：把管理员 key 从 `managed-models-source.json` 拆出来，复用保险库的 `VaultCrypto` / safeStorage 加密。
- [方案页 D6](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)；[决策 038](038-no-plaintext-key-scope.md) 第 2 条「管理员 key 的缓存改为加密存储」。
- [决策 149](149-user-rulings-2026-10-07.md) 第 2、5 条（用户裁决）：管理员 key 一律进保险库，与用户自己的 key 同等保护；Linux 没有钥匙串时保险库是 `enc: none`、0600，与现在同级，不另做「只放内存」。
- [决策 034](034-per-request-credential-pull.md)：宿主按引用向 Main 拉 key。

代码提交 `4bd31a2c`。**第 4 条的「关闭托管模式」一项请重点审批。**

背景：公司模型目录可以给某个服务声明 `credentials.apiKey: 'managed'`，并在响应里直接带上 key（管理员 key）。之前客户端把拉到的目录原样缓存为 `managed-models-source.json`（0600），管理员 key 因此明文落盘。目前公司目录不下发管理员 key（09-30 R10 扫描零命中），本次是防潜在风险。

## 规则

### 1. 存在哪里、键名

- **位置**：`credentials/vault.json` 新增一组 `managedProviderKeys`，编码标记是 `managedProviderKeysEnc`。内容是 `{ 服务 id: key }`。
- **怎么区分来源**：
  - 按组区分：这一组只装公司目录下发的管理员 key。用户自己的服务仍在 `userProviders` 组，登录 key 在 `payload`。
  - 组内按服务 id 区分，也就是目录里的 provider id。
  - 不按目录端点地址区分：缓存文件任何时候只对应一份目录，每写一次缓存，这一组就整体替换一次。
- **加密**：与 `userProviders` 一样，用独立的编码标记。
  - 有钥匙串时用 safeStorage 加密。
  - Linux 没有钥匙串时是 `enc: none`，原样存在 0600 的 `vault.json` 里，与登录 key 同级（决策 149 第 2 条）。
  - 不另做「只放内存」。
- **不升保险库 schema 版本**（仍是 2）。
  - 旧版本读到不认识的字段会忽略，下次写保险库时把它丢掉，代价只是重新拉一次目录。
  - 升版本则会让旧版本把整个保险库当成 unsupported，要求用户重新登录。
- **缓存文件**：只去掉 `apiKey`，保留 `credentials.apiKey: 'managed'`，key 轮换后重写时据此判断来源。线上目录格式、IPC 名、设置键都不变。
- **写入顺序**：先存保险库，再写不含 key 的缓存。
  - 这两步放在同一个缓存文件的串行区里执行。串行区是模块级的，因为 `index.ts` 每次调用都新建一个服务实例。
  - 目的是防止迁移和同步交错，导致保险库里的 key 和缓存目录不配套。
- **保险库拒写时**（还没 promote、文件损坏、版本过新）：
  - 缓存照样写成不含 key 的形态，绝不退回明文。
  - 这几个服务下次读取时按第 2 条剔除，等下次同步把 key 存好。
- **保险库文件存在但解析不了时拒写**，新增拒绝原因 `unreadable`，不覆盖。那份文件里可能有 `replaceUnreadableUserProviders` 要保留的用户服务组。
- 保险库的写入会发出 change 通知，类型是新增的 `saveManagedProviderKeys`。

### 2. 读回时保险库里没有 key：单独剔除这个服务

- **参照现有校验语义**：线上目录里「managed 却无 key」属于凭据违规，会让整份目录作废。读缓存时改为只剔除这个服务，其余服务照常。一个 key 丢了，不该让整个目录不可用。
- **不用空 key 保留**：那样菜单里有这个模型，一调用就是 `CREDENTIALS_UNAVAILABLE`。
- **绝不回退到登录 key**：
  - 原来的 `resolveProviderApiKey` 遇到 managed 而无 key 时，会回退到登录 key。那会把本客户端的登录 key 发到管理员为另一个服务配置的地址。
  - 改为：managed 服务只给管理员 key，没有就给空串。空串由 broker 回 `unavailable`，请求不会发出去。
  - 剔除在前，所以这条路实际走不到，留作兜底。
- **日志**：剔除时记一行，只写服务 id，不含 key 值。同一组缺失只记一次，避免每次渲染菜单都刷屏。
- **缓存文件里不删这个服务**，留给下次拉取把 key 补回来。
- **同步**：
  - 缺 key 的缓存不算「新鲜」，10 分钟内也重新拉取。
  - 拉取失败走 stale-cache 时，只提供剔除后的目录，`providerCount` 相应减少。
- **保险库读不出**（钥匙串锁定、文件损坏）时同样按缺 key 处理。这时登录 key 也读不出，托管模式下本来就不给内存目录（`nativeCatalog.ts`），行为与以前一致。

### 3. 老文件迁移：首次读取和下次同步都做

- **判据**：缓存文件里还有 `apiKey` 原文，也就是 P1-5e 之前的版本写的。
- **读取时文件里的 key 优先于保险库**。这份文件比本版本存过的任何内容都新，例如降级后又升级回来。
- **两条路径都迁移**：
  - 同步路径（新鲜、stale-cache）里等迁移做完再继续。
  - 读取路径（`buildNativeModelCatalog`、`writeUserProviderConfig`，都是同步函数）里异步启动，同一文件同时只跑一个。
  - 读取路径也要做，是因为本地模式不跑同步。只靠同步的话，本地模式下老文件里的 key 会一直以明文留着。
- **步骤**：
  1. 把文件里的 key 整组存进保险库；
  2. 确认存好了；
  3. 只有文件仍是当初读到的那份字节时，才重写成不含 key 的形态。期间如果同步写过这个文件，以同步的结果为准。
- **保险库拒绝时**（例如还没 promote）：文件原样不动，key 仍从文件读、照常可用，下次读取再试。
- 迁移成功记一行日志，只写服务 id。

### 4. 登出、切换账号、关闭托管模式

- **登出**：`vault.clear()` 一并丢弃这一组，用户服务组照旧保留。
  - 这是 `performLogoutSequence` 的第 ④ 步，不受托管模式开关限制，也就是 R8 证据里「登出后凭据库清空」的那条路径。
- **切换账号**：`vault.save()`（登录、adoption）一律丢弃这一组。
  - 理由：这组 key 是用被替换掉的那份登录凭据拉来的，可能属于另一个账号。登录后的强制同步会重新拉取、重新存入。
  - 不做「同一邮箱就保留」：登出时已经清过一次，`save()` 真能碰到旧组的只有两种情况，「key 被拒后重新登录」和 adoption，两者都应以新凭据重新拉取为准。
- **保留这一组的情况**：`markInvalidated`（登录 key 被拒）、改用户服务。
- **关闭托管模式（切到本地模式）时不清（请重点审批）**：
  - 派工要求里列了这一条，但现有设计明确规定，切模式只记录模式，不碰保险库、不清凭据、不登出（`ipc/auth.ts` 的 `AUTH_ENTER_APP` 注释，D64）。登录 key 在本地模式下也留在保险库里。
  - 按决策 149「跟保险库一致」，管理员 key 与登录 key 走同一个生命周期。
  - 如果单独在切模式时清掉，本地模式下继承型服务（用登录 key）仍可用，管理员 key 的服务却消失，口径不一；切回托管后，也要等到下次启动或手动同步才恢复。
  - 备选：在 `AUTH_ENTER_APP` 切到 `local` 时调用 `saveManagedProviderKeys({})`，约 5 行。用户要这样就改。
- **登出时不删 `managed-models-source.json`**：
  - 它已经不含 key。
  - 删掉会改变「登出后离线重新登录」时退到随包快照的行为。
  - key 被清之后，缓存里的 managed 服务按第 2 条剔除。

### 5. 宿主拉 key、启动顺序

- **`DshCredentialBroker` 仍能取到管理员 key**：
  - 它读的是 `resolveNativeModelCatalog()?.auth`，这份内存目录由 `managedHalf` 用缓存加保险库拼成，管理员 key 仍在里面。启动全链路测试有断言。
  - 存 key 会触发保险库的 change 通知，broker 清掉缓存，下一次请求重新读。
- **启动顺序不受影响**：
  - 读加密组和读登录 key 依赖同一次 crypto promote。promote 之前登录 key 也读不出，托管模式下本来就不给内存目录。
  - 所有写入都发生在 promote 之后：启动第 ③ 阶段、登录、手动同步。
  - 没有发现需要改变用户可见行为的地方。
- **KEY-CANARY**：宿主侧的门禁不经过这段代码，本次重跑仍是零命中。

### 6. 不在本次做的

- **key 与缓存版本的绑定**（在两边各记一个引用号或摘要）：没做，只按服务 id 配对。
  - 理论上有一种情况：保险库写成功、缓存写失败（磁盘错误），旧缓存会配上新 key。那仍是同一个管理员、同一个服务 id，最坏结果是 401，不会泄漏。
- 切模式时清 key：见第 4 条的备选。

## 测试

新增 22 个用例，覆盖派工要求的六类：

| 文件 | 用例 |
|---|---|
| `piModelConfig/__tests__/PiModelConfigService.test.ts`（10 个，在「administrator keys in the vault (P1-5e)」组） | 写缓存后目录里没有任何文件含 key 原文、缓存仍有 `credentials.apiKey: 'managed'`、0600、key 在保险库；读回补全，登录 key 只给继承型服务；老明文文件首次读取即迁移；老文件在失败的同步里也迁移；保险库拒绝时老文件不动且照常可用；保险库拒绝时新同步也不落明文、服务被剔除而不是拿登录 key；保险库丢 key 时只剔除该服务、记日志、缓存仍保留它，10 分钟内也重新拉取并补回；stale-cache 时不整份失败；目录不再下发 key 时清空这一组；`resolveProviderApiKey` 不回退到登录 key。混合目录（继承型 + 管理员地址与 key）贯穿全组 |
| 同文件，`validatePiManagedModelsConfig` 组（1 个） | 只有带 `managedKeysDetached` 的自家缓存才接受「managed 无 key」，线上来源仍报凭据违规 |
| `auth/__tests__/CredentialVault.test.ts`（10 个） | 有钥匙串时加密、文件里没有 key 原文；无钥匙串时 `enc: none`、0600；没有组或没有文件时读作空；钥匙串锁定时读作 `locked`；登出丢组、保留用户服务；登录（换账号）丢组；改用户服务、`markInvalidated` 后保留；空集删组且不新建文件；promote 之前拒写、文件损坏时拒写且不覆盖；写入发出 change 通知 |
| `auth/__tests__/managedCredentialsStartup.test.ts`（1 个） | 走真实保险库和 `index.ts` 接线：启动第 ③ 阶段同步后，agent 目录里没有任何文件含管理员 key，保险库有，`resolveNativeModelCatalog().auth` 里两种 key 各归其位；登出后这一组被清空、内存目录不再给出 |

变异检查：把缓存故意写回带 key 的形态，P1-5e 组有 4 个用例失败，复原后全过。

## 验证（最终代码，2026-10-07）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`、`pnpm typecheck:dsh-host` | 通过 |
| `pnpm lint` | 0 错误；8 条警告、1 条提示都在未改动的证据工具脚本与 `scripts/run-f3-dev-probe.mjs` |
| `vitest run Static Scan Wiring` | 75 个文件，759 个用例通过 |
| `vitest run src/shared/__tests__` | 31 个文件，443 个用例通过 |
| `vitest run src/main/services/piModelConfig` | 6 个文件，113 个用例通过 |
| `vitest run src/main/services/agent-host` | 25 个文件通过、1 个跳过；474 个用例通过、35 个跳过 |
| `AICLIENT_DSH_INTEGRATION=1` 共享宿主集成测试 | 35 个用例全部通过；KEY-CANARY 扫描 `DSH_HOME` 下 80 个文件（19 个 zstd 解码）、TMPDIR 0 个文件、宿主 stderr 167 B、Main 日志 5 行，零命中 |
| `vitest run src/main/services/auth` | 15 个文件，245 个用例通过 |
| `userProviders`、`onboarding`，以及 `ipc` 的 auth、登录入口、登出序列、同步接线、onboarding 处理器 | 8 个文件，86 个用例通过 |
