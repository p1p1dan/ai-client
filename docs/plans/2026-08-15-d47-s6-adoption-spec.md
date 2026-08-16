# D47 S6 施工规格 — 存量收编与停双写（rev.1 待评审，D47 收官片）

> 2026-08-15。母规格 §6（U1 修订版：收编但永不清理）；S0~S5 已落 + GUI 全链 14/14 PASS（`bf8de41` 修复项
> 一并在链）。本片 = D47 最后一片；落地后解除 baseline 门禁的分发纪律（S6 前分发不得开 flag）。

## §1 范围与交付物

1. **收编（adopt）**：`ensureVaultAdoption()`（Main，`src/main/services/auth/adoption.ts` 纯模块 + electron
   绑定）——触发点 = 启动相 ③（`regenerateFromVault` 之前）：flag on ∧ vault **absent**（注意与
   `cleared` 区分：cleared = 本机曾登录后登出，**不收编**——登出语义优先于收编）∧ marker 缺席 ∧ legacy
   `onboarding.registered===true` 时执行一次：
   - 源：`~/.claude/settings.json` env 两键 + `~/.codex/auth.json` OPENAI_API_KEY + `~/.codex/config.toml`
     `[model_providers.jyw].base_url` + `~/.aiclient/settings.json` onboarding `{email, serverUrl}`；
   - **守卫**（母规格 B-guard）：claude baseUrl 的 host 必须与 legacy `onboarding.serverUrl` 的 host 一致
     （防把员工个人 provider 当公司 key 收编）；codex key 必须与 claude token 相等（同 key 口径实证过）；
     任一不满足 → 不收编，正常走登录页（预填 legacy email）；
   - 成功 → `vault.save`（receivedAt=adoption 时间，identity.userId 未知置 null——schema 允许？payload
     `identity.userId: number|null` 本片放宽并记 as-built；或 adopt 后首次 probe 200 时不回填 id——登记）
     → regenerate 两 home → `refresh()` → **一次 auth-probe 验真**（拒绝 → `markRejected`，员工重登，
     不算收编失败）→ 写 marker `<userData>/credentials/.adopted-v1`；
   - 失败/守卫不过：记诊断，不写 marker（下次启动可重试——marker 只在成功后写）。
2. **停双写**：`OnboardingService.verifyAndRegister` flag-on 时**不再写** `~/.claude/settings.json`、
   `~/.codex/*`、`~/.claude.json`（legacy 三写手 flag 门控化；flag-off 逐字节现状）。`logout()` flag-on 时
   **不再碰** legacy 文件（U1 留置语义：登出只清 vault/托管 home——**修正 S1 以来 flag-on 登出也清
   legacy 的行为**，legacy 从此完全归系统终端用户自有）。
3. **修 flag-off 登出 rmSync bug**（S2 移交件）：`removeCodexConfig` 的 `rmSync` 整删两文件改**外科式**——
   `auth.json` 只删 `OPENAI_API_KEY` 字段保留文件；`config.toml` 只摘 `[model_providers.jyw]` 表与指向它的
   `model_provider` 行。flag-off 登出行为变更（更安全方向），登记非等价。
4. **UsageService serverUrl 权威迁移**（S5 m4 移交）：flag-on 走 `vault.cchBaseUrl`（停双写后 legacy
   `onboarding.serverUrl` 不再有新写入，旧值仍作 flag-off 回退）。
5. **兼容清理**：`checkCredentialsHealth` 的 flag-on 折算分支保留（renderer 契约不动），本片只加注记；
   投影链物理删除**不在本片**（flag-off 回退仍依赖投影——归 flag 转正后的退役批，修正 S34 的归属注记）。
6. **分发纪律解除**：baseline 门禁文档该条标注「S6 已落，解除」；flag 默认值本片**不动**（默认 off，
   何时转 on 属发布决策，用户拍板）。

## §2 关键契约

- 收编与 `cleared` 的判别是本片第一承重线：`read()` 返回 `cleared`（有壳无 payload）绝不触发收编——
  否则「登出」被收编顶回「已登录」，登出语义破产。变异必选。
- marker 幂等：存在即跳过（含 vault 后来被清的情形——不重复收编，用户须真实登录；理由同上）。
- 收编写入的 vault 与真实登录写入的 vault **同 schema 同路径**（复用 S1 `save()`，无旁路写手）。
- 停双写后 flag-on 登录对 `~/.claude*`/`~/.codex` 写调用数 = 0（fs 打桩，S2 断言口径扩展到登录路径）。
- flag-off 全链（登录/登出/健康检查）除 rmSync 修复外逐字节现状。

## §3 验证与变异

测试面：收编五守卫矩阵（absent/cleared/marker/registered/host 匹配 × 各反例）· 收编成功全链
（vault→homes→refresh→probe→marker 顺序断言）· 停双写 fs 打桩双轮 · rmSync 外科回归（预置用户自有键
存活）· UsageService 双轨 serverUrl。
变异 ≥6 对：① cleared 触发收编（登出语义破产）② marker 不幂等 ③ host 守卫放行不匹配 baseUrl
④ 停双写漏 `~/.claude.json` 写手 ⑤ 外科删除退化整删 ⑥ 收编写手绕过 `save()` 旁路写 vault。

## §4 需评审重点攻击的自设裁定

a) 收编在 `regenerateFromVault` **之前**跑（顺序自洽性：adopt→save→regenerate 一体）；
b) `cleared` 不收编 + marker 只成功后写（登出优先语义）；
c) flag-on 登出不再清 legacy（U1 留置语义的延伸——与 S1「clear 无 flag 门控」的 vault 侧不冲突，
   此处说的是 legacy 文件侧）；
d) identity.userId 收编时置 null 的 schema 放宽；
e) 投影链删除归属改判（S34 注记说 S6，本片改判退役批——flag-off 回退依赖论证）。
