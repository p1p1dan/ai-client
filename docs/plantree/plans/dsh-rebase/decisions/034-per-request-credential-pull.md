# 决策 034：key 由宿主每次请求时向 Main 拉取，宿主不缓存；关掉 dsh-base 的明文凭据行

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-5 方案 §5 D2](../topics/p1-5-models-and-credentials.md#5-需要拍板的决策点)、[分片 03](../topics/p1-5-models-and-credentials/03-design.md)。

## 规则

1. 关掉 dsh-base 的 `credentials` 行。它挂的 `dsh-credentials-local` 会把明文写进 `$DSH_HOME/.credentials.yaml`。
2. 宿主侧换成我方只读提供者 `aiclient-credentials`：
   - 只认计划里的引用名，其余一律返回 undefined；
   - 每次请求发 `{host:'credential', id, ref, nonce}`，5 s 超时；
   - 不缓存，写接口全部拒绝。
3. Main 侧 `DshCredentialBroker`：
   - 校验通道、nonce 和引用名；
   - 按现有的归属规则从 vault 取 key，内存缓存到 vault 下次变更为止；
   - 登出或钥匙串锁住时回 `unavailable`（新失败码 `CREDENTIALS_UNAVAILABLE`），不再退回去读 `auth.json`；
   - 永不记录 key 的值。
4. **前置条件：实查工具进程会不会继承宿主的 IPC 句柄**（方案 IT-07，Windows 在 P1-14 的 CI 上补测）。如果会继承，工具就能冒充宿主要 key，nonce 只能防冒充、防不住读走应答。那时要先在 P1-3 的拉起方式上堵住，再落地本决策。

## 取舍

- 这就是 roadmap 写的「按请求注入」：登出、换 key 之后，下一次请求就生效，宿主里不常驻 key。
- 备选：
  - Main 推送、宿主常驻：key 会一直留在宿主内存里。
  - Main 本地反代，宿主只拿一次性令牌：能顺带解决 UA 问题（[决策 037](037-user-agent-test-first.md)），但 Main 要搬运全部流量。
- 代价：
  - 每次请求多一次本机 IPC；依赖 P1-3 的控制通道。
  - Linux 上钥匙串锁住时会话无法请求模型。1.0.x 这时还能用磁盘上的 key。

## 实施补记（2026-09-27，P1-3a 实验）

第 4 条的前置条件在 Linux 上成立：Node 24 给 IPC fd 设了 `O_CLOEXEC`，并在用户代码运行前删掉 `NODE_CHANNEL_FD`。bash 在沙箱内、升级出沙箱、systemd scope、回退路径这四种情况下，都只有 fd 0/1/2。Windows、macOS 留给 P1-14 的 CI 补测。证据见 [p1-3a-shared-host-2026-09-27.md](../evidence/p1-3a-shared-host-2026-09-27.md)。

## 补记（2026-10-07，E8，[决策 150](150-e8-plugin-credential-isolation.md)）

第 4 条只覆盖了工具子进程。E8 实测（[证据](../evidence/e8-plugin-credential-isolation-2026-10-07.md)）补上同进程的一面：宿主里的第三方插件不需要继承句柄，挂 `process.on('message')` 就能看到 Main 发来的凭据应答明文；读到 `configure` 的 nonce 后伪造的凭据请求，Main 也会正常应答。nonce 与引用名两道检查挡不住同进程插件。缓解按[决策 149](149-user-rulings-2026-10-07.md) 第 4 条选 A：审查单必拒三条加静态守卫（[决策 153](153-e8-a-plugin-review-guard-choices.md)），运行期行为不变。Windows 上是否同样成立，留给 P1-14。
