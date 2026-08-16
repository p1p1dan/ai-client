> D47 S6 规格 rev.1 双盲对抗评审 · B 轨（Codex，证据与可验证性镜头，2026-08-15）。原文归档。

## 1. Blocker

### B1. 收编启动编排存在“双重 regenerate / refresh / probe 所有权不明”，现规格无法给出唯一可执行时序

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:8](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:8)、[2026-08-15-d47-s6-adoption-spec.md:17](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:17)、[2026-08-15-d47-s6-adoption-spec.md:47](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:47)、[2026-08-15-d47-s6-adoption-spec.md:55](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:55)

规格同时规定：

- `ensureVaultAdoption()` 在启动相③、现有 `regenerateFromVault()` 之前调用；
- 收编成功后，`ensureVaultAdoption()` 自己执行 `vault.save → regenerate 两 home → refresh → probe → marker`；
- 测试再断言同一顺序。

但当前启动主链已经是：

1. `openLocalWindow()` 构造首个 `BrowserWindow`；
2. `browser-window-created` 同步触发 safeStorage 升格；
3. `await regenerateFromVault()`；
4. `getAuthStateService().refresh()`；
5. refresh 触发 `AuthProbeScheduler` 的即时 probe。

证据：

- safeStorage 升格监听在 [src/main/index.ts:673](/home/dan/projects/ai-client/src/main/index.ts:673)；
- 首窗构造后立即调用 `regenerateFromVault()` 在 [src/main/index.ts:743](/home/dan/projects/ai-client/src/main/index.ts:743)；
- 紧随其后的 auth refresh 在 [src/main/index.ts:746](/home/dan/projects/ai-client/src/main/index.ts:746)；
- 注释明确 refresh 会触发启动 probe，在 [src/main/index.ts:752](/home/dan/projects/ai-client/src/main/index.ts:752)；
- `refresh()` 是同步函数，只负责状态换算和 listener 通知，不等待网络 probe，在 [AuthStateService.ts:157](/home/dan/projects/ai-client/src/main/services/auth/AuthStateService.ts:157)；
- listener 在状态进入 `authenticated` 时调用 scheduler，在 [src/main/ipc/auth.ts:53](/home/dan/projects/ai-client/src/main/ipc/auth.ts:53)；
- scheduler 用 `void this.probeOnce()` 异步启动 probe，在 [AuthProbeScheduler.ts:126](/home/dan/projects/ai-client/src/main/services/auth/AuthProbeScheduler.ts:126)；
- 已有测试证明在状态变化启动 probe 后，再 `await scheduler.probeOnce()` 会加入同一个单飞，而不是发第二次请求，见 [AuthProbeScheduler.test.ts:98](/home/dan/projects/ai-client/src/main/services/auth/__tests__/AuthProbeScheduler.test.ts:98)。

因此，若照规格字面实现：

- adoption 内会 regenerate 一次，返回后现有启动链再 regenerate 一次；
- adoption 内会 refresh 一次，现有启动链再 refresh 一次；
- adoption 若直接显式发 probe，而 refresh 同时触发 scheduler，可能形成重复调用；即使 scheduler 单飞能合并，也没有在规格中指定必须复用同一个 scheduler；
- “marker 必须在 probe 完成后写”无法由单纯调用 `refresh()` 实现，因为 `refresh()` 不等待 probe。

**具体改法：**

必须在 rev.2 中选定一个、且只有一个编排所有者。建议把启动链写成明确伪码，并把现有调用的迁移位置钉死：

```ts
mainWindow = openLocalWindow(...); // BrowserWindow 同步触发 crypto promote

const adoption = await ensureVaultAdoption({
  vault,
  legacyReader,
  marker,
  now,
  // ensureVaultAdoption 到这里最多只负责：
  // read sources → guards → vault.save
});

await regenerateFromVault();       // 唯一一次，两 home 共用同一次 vault read
const state = authStateService.refresh(); // 唯一一次

if (adoption.status === 'adopted' && state.status === 'authenticated') {
  await authProbeScheduler.probeOnce(); // 加入 refresh 已触发的单飞
  await adoptionMarker.write();
}
```

或者让 adoption coordinator 完整拥有 regenerate/refresh/probe/marker，但那就必须明确删除/跳过当前 [src/main/index.ts:750](/home/dan/projects/ai-client/src/main/index.ts:750) 和 [src/main/index.ts:761](/home/dan/projects/ai-client/src/main/index.ts:761) 的重复调用。

规格还必须补 probe 三态对应的 marker 规则：

| probe 结果 | vault 后续状态 | 是否写 marker |
|---|---|---|
| 200 | authenticated/valid | 是 |
| `401 KEY_INVALID` | `markRejected` 后 credentials_invalid | 是或否必须明确；现文“拒绝不算收编失败”暗示应写 |
| 网络错、超时、5xx、404、307 | authenticated/unknown | 是否写必须明确；建议写，因为源导入已成功，网络未知不应造成每次启动重复收编 |

相序测试必须直接驱动生产 startup coordinator，断言单一事件 trace，例如：

```text
window-created
crypto-promoted
adoption-read
vault-save
regenerate
auth-refresh
probe-complete
marker-write
```

并断言 `regenerate`、`auth-refresh`、实际 fetch 各恰好一次。

---

### B2. `identity.userId = null` 与当前 Vault schema 直接冲突，按规格实现会 TypeScript 编译失败

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:17](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:17)、[2026-08-15-d47-s6-adoption-spec.md:59](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:59)

当前权威类型是：

```ts
identity: { email: string; userId: number };
```

见 [CredentialVault.ts:41](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:41)。

`CredentialVault.save()` 参数也是严格的 `VaultPayload`，见 [CredentialVault.ts:286](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:286)。现有真实登录写入的是服务端返回的数字 ID，见 [OnboardingService.ts:303](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:303)。

所以规格中的“schema 允许？”不是可留到施工时自由判断的细节；它是当前明确不允许。

另一个必须一起处理的事实是：Vault 的磁盘 envelope 有形状校验，但解密后的 payload 当前只是类型断言，不做深层字段校验：

- safeStorage payload：`JSON.parse(...) as VaultPayload`，见 [CredentialVault.ts:250](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:250)；
- `enc:'none'` payload：直接 cast，见 [CredentialVault.ts:269](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:269)。

这意味着磁盘上出现 `null` 在运行时可能被读成 `ok`，但生产 TypeScript 写入端仍不能合法调用 `save()`，而且“同 schema”也没有运行时深校验可证明。

**具体改法：**

rev.2 必须在开工前拍死一种方案：

1. 推荐：将权威类型改成 `userId: number | null`，同步修改：

   - `VaultPayload`；
   - 所有 payload fixture/helper；
   - adopted roundtrip 测试；
   - 正常登录仍为数字的负回归；
   - 若本片补 payload 深校验，则校验器也必须接受 `number | null`。

2. 如果不接受 schema 放宽，则必须定义可验证的 ID 获取流程，例如 adoption 在保存前通过服务端接口拿到用户 ID；不能继续写“未知置 null”。

需要至少两条测试：

- 收编 payload：`userId:null` 经真实 `save → read` 后保持 `null`；
- 正常登录 payload：现有数字 ID 不变，防止宽化后错误丢掉已知 ID。

---

### B3. flag-on 登出的施工切点未定义；当前 `logout()` 把“清 legacy 凭据”和“更新 app onboarding 状态”绑在一起，简单跳过会留下回退语义错误

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:22](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:22)、[2026-08-15-d47-s6-adoption-spec.md:24](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:24)

当前事实：

- `performLogoutSequence()` 在 flag-on 时先 shutdown、清 vault、再生成托管 homes，但随后仍然**无条件**调用 `onboardingService.logout()`，见 [src/main/ipc/onboarding.ts:95](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:95)、[src/main/ipc/onboarding.ts:105](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:105)、[src/main/ipc/onboarding.ts:112](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:112)；
- `logout()` 内部把三件事捆在一起：

  1. 删除真实 `~/.claude/settings.json` 中的凭据；
  2. 删除真实 `~/.codex/config.toml` / `auth.json`；
  3. 写 `~/.aiclient/settings.json` 的 `onboarding.registered=false` 和 email。

  见 [OnboardingService.ts:325](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:325)、[OnboardingService.ts:347](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:347)。

- 当前 Codex 删除确实是整文件 `rmSync`，见 [OnboardingService.ts:680](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:680)；
- GUI 报告的真机事故与该代码完全吻合：flag-on 登出删除用户真实 Codex 文件，见 [2026-08-15-d47-gui-checklist.md:51](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-gui-checklist.md:51)。

规格要求 flag-on 不再碰 legacy 凭据是正确的；问题是没有说明 `~/.aiclient` 的 onboarding app 状态怎么办。

如果施工者直接在 flag-on 分支跳过整个 `onboardingService.logout()`：

- 真实 CLI 文件会被正确留置；
- 但 `onboarding.registered` 仍为 true；
- 之后如果用户关闭 managed flag，旧链可能把这台已经在 app 内登出的机器重新识别成 registered；
- 收编触发条件也依赖 legacy `registered===true`，会留下语义污染。

**具体改法：**

规格必须要求拆开现有方法，至少形成两个独立操作：

```ts
removeLegacyCliCredentialsSurgically()
markLegacyOnboardingSignedOut({ keepEmail: true })
```

推荐分支：

- flag-on：

  - 清 vault；
  - regenerate 托管 homes；
  - **不调用任何 `~/.claude*` / `~/.codex` 写手**；
  - 仍更新 app 自己的 `~/.aiclient` onboarding metadata 为 `registered:false`，并明确 email/serverUrl 的保留策略。

- flag-off：

  - 清 vault；
  - 执行外科式 legacy CLI 凭据删除；
  - 更新 onboarding metadata。

测试需要同时断言：

- flag-on：legacy CLI 文件逐字节不变，但 onboarding app 状态按规格更新；
- flag-off：legacy 文件只删除 app 所有的键/表，onboarding 状态更新；
- flag-on 登出后再把 flag 切到 off，不得重新判为已注册。

---

### B4. “写调用数 = 0”目前没有可执行的打桩定义；只数 `writeFileSync` 会形成假绿

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:42](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:42)、[2026-08-15-d47-s6-adoption-spec.md:47](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:47)、[2026-08-15-d47-s6-adoption-spec.md:50](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:50)

当前 flag-on 登录仍然先无条件执行 `persistCredentialFiles()`，然后才进入 managed 分支：

- 无条件 legacy 调用点见 [OnboardingService.ts:165](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:165)；
- legacy 三写手序列见 [OnboardingService.ts:413](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:413)；
- Claude 路径会执行 `mkdirSync`、`copyFileSync`、`writeFileSync`，见 [OnboardingService.ts:431](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:431)；
- Codex 路径也会执行 mkdir、备份 copy、两个 write，见 [OnboardingService.ts:526](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:526)；
- `.claude.json` 写手见 [OnboardingService.ts:642](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:642)。

因此“写调用数”不能只定义成 `writeFileSync` 次数。即使实现发生以下错误，单一 `writeFileSync=0` 也可能绿：

- 仍创建 `~/.claude` 或 `~/.codex` 目录；
- 仍创建 `.bak`；
- 仍 chmod、rename、unlink 或 rm；
- `.claude.json` 预先已经 `hasCompletedOnboarding:true`，导致写手天然 no-op，测试根本没有咬到它；
- 整个登录链在更早位置失败，因而所有写调用自然为零。

现有 S2 黄金差分也不能原样视为完整复用证明。它只比较了一个 `~/.claude/settings.json`：

- 非空比较数量与 Buffer golden 范式见 [OnboardingServiceFlagOffGoldenDiff.test.ts:6](/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingServiceFlagOffGoldenDiff.test.ts:6)；
- 实际 `comparedFiles` 只有 `settingsPath` 一项，见 [OnboardingServiceFlagOffGoldenDiff.test.ts:103](/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingServiceFlagOffGoldenDiff.test.ts:103)。

它没有覆盖 `.claude.json`、Codex 两文件以及所有写类调用。

**具体改法：**

规格必须钉死一个双轮生产接缝测试：

#### flag-on 轮

- fake fetch 返回完整、非空凭据；
- 预置以下非空文件，使旧写手每个分支都必然执行：

  - `~/.claude/settings.json`；
  - `~/.claude.json`，且 `hasCompletedOnboarding:false`；
  - `~/.codex/config.toml`；
  - `~/.codex/auth.json`。

- 对目标路径记录所有 mutating fs 调用，至少包括当前生产使用的：

  - `mkdirSync`；
  - `copyFileSync`；
  - `writeFileSync`；
  - `renameSync`；
  - `chmodSync`；
  - `rmSync`；
  - `unlinkSync`。

- 路径范围必须是：

  - `~/.claude/**`；
  - 精确 `~/.claude.json`；
  - `~/.codex/**`。

- 唯一核心断言应是路径过滤后的 mutation trace：

```ts
expect(legacyMutationTrace).toEqual([]);
```

- 同时用独立成功证明排除“登录提前失败导致零写”：

  - `verifyAndRegister().ok === true`；
  - `vault.save` 恰好一次；
  - managed Claude/Codex home 实际生成且非空；
  - auth refresh/onSuccess 已发生。

#### flag-off 轮

- 继续跑完整 legacy 登录；
- 对所有四个 legacy 文件做非空文件集断言；
- 做逐文件 Buffer golden，而不只是 Claude settings；
- 明确 `<userData>/credentials` 和 managed homes 不产生新的写入。

另外，测试若通过 `vi.spyOn`/`vi.mock('node:fs')` 实现，规格要要求验证 spy 与被测模块的 `import * as fs` 是同一模块实例，避免 ESM mock 失配造成“调用数始终为 0”的工具链假阴性。

---

### B5. 六个必选变异只列了标题，没有达到“四列可判、唯一红、非空证明”的开工门槛

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:45](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:45)

规格目前只有：

> cleared 触发、marker 不幂等、host 守卫放行、漏 `.claude.json`、外科删除退化、旁路写 vault

没有逐对给出：

- 正确态输入；
- 生产变异；
- 唯一红断言；
- 非空证明。

这低于 S5 已经建立的变异规格纪律；S5 明确要求每对四列，见 [2026-08-15-d47-s5-authstate-spec.md:144](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:144)。

六对当前判定如下：

| 变异 | 当前可判性 | rev.2 应写明的正确态输入 | 生产变异 | 唯一红断言 | 非空证明 |
|---|---|---|---|---|---|
| ① cleared 触发收编 | **不可直接执行**，adoption 尚不存在；但 Vault 已能区分 | 通过真实 `save→clear` 产生 `status:'cleared'`，legacy registered/source 全部有效 | 把 `cleared` 与 `absent` 合并进入 adoption | 生产 trace 精确等于 `read:cleared → skip:cleared` | 先断言真实 `vault.read().status==='cleared'`，且 legacy source 非空 |
| ② marker 不幂等 | **不可直接执行**，marker 尚不存在 | 真实 marker 文件存在、vault absent、registered true、五源有效 | 忽略 marker 继续收编 | trace 精确等于 `marker:present → skip:marker` | 事前 `existsSync(marker)===true` 且 marker 内容非空 |
| ③ host 守卫放行不匹配 | **不可直接执行**，无守卫生产 helper | Claude token/baseUrl、Codex key、onboarding serverUrl 全部存在，但 URL host 不同；两个 key 相同 | 删除/反转 host 比较 | 单一 result/trace 为 `guard_rejected:host_mismatch`，且无 `vault.save` 事件 | 所有源文件存在、所有字段非空；先证明拒绝不是“缺字段”造成 |
| ④ 漏 `.claude.json` 写手 | **现有旧写手存在，但没有 flag-on 零写测试** | flag-on 成功登录；`.claude.json` 预置 `hasCompletedOnboarding:false` | 只门控 Claude settings/Codex，漏门控 `.claude.json` | `legacyMutationTrace=[]` 精确失败 | 登录成功、vault/managed homes 非空，且 fixture 中 `.claude.json` 真实存在 |
| ⑤ 外科删除退化整删 | **当前生产代码就是错误态** | auth 同时有 app key 和用户键；config 同时有用户段、jyw 表和 root 指向行 | 重新使用 `rmSync` 整删 | 建议拆成 ⑤a auth、⑤b config，各自做一个 post-bytes golden | 事前文件存在、长度大于 0、用户哨兵键/段存在 |
| ⑥ adoption 绕过 `save()` | **不可直接执行**，adoption 尚不存在 | vault absent，所有来源完整，crypto 已升格 | 直接写 vault path，不调用 `save()` | `vault.save` 生产 port 恰好一次；结构上 adoption 模块不得获得 vault 路径/fs 写权 | 收编后真实 `vault.read().status==='ok'` 且 payload 完整 |

其中两点必须特别修：

1. ⑤现在写成一对，但一个整删变异会同时让 auth 和 config 多条断言变红，不满足“唯一红”。应拆成：

   - ⑤a `auth.json` 外科删除退化整删；
   - ⑤b `config.toml` 外科删除退化整删。

2. ⑥仅断言 `save()` 被调用还不足以禁止“既调用 save 又旁路再写”。更好的生产结构是：纯 adoption 模块只接收 `vault: {read, save}` port，不接收 vault 路径或通用 fs writer；再用静态 import/符号扫描禁止 adoption 模块直接导入文件写 API。运行时只负责断言 `save` 恰好一次。

在补成上述四列表之前，“变异 ≥6 对”只是目标清单，不是可执行验收计划。

---

## 2. Major

### M1. `~/.aiclient` 收编源和“失败后预填 legacy email”没有定义独立读取接口；现有 `checkRegistration()` 会隐藏登出后的 email/serverUrl

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:11](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:11)、[2026-08-15-d47-s6-adoption-spec.md:16](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:16)

当前 `checkRegistration()` 只有在：

```ts
onboarding.registered && onboarding.email
```

同时成立时才返回完整对象；否则一律返回 `{registered:false}`，见 [OnboardingService.ts:35](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:35)。

当前 S5 logout 虽然修复了 email 被浅合并抹掉的问题，但写回的是：

```ts
{ onboarding: { registered: false, email } }
```

见 [OnboardingService.ts:347](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:347)。它没有拼回 serverUrl。因此 logout 后：

- 磁盘可能仍有 email；
- serverUrl 已丢失；
- `checkRegistration()` 因 `registered:false` 连 email 也不会返回。

现有测试只证明磁盘 email 被保留，见 [OnboardingService.test.ts:290](/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingService.test.ts:290)，没有证明调用链能读回它。

更旧版本在 S5 修复前还可能把 email 一并抹掉；S5 规格本身承认该现役缺陷，见 [2026-08-15-d47-s5-authstate-spec.md:18](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s5-authstate-spec.md:18)。仓库中没有旧版本抹除后的自动恢复逻辑，因此“旧机器一定可取得 email/serverUrl”证据不足。

**具体改法：**

新增一个与注册判定解耦的纯读取结果，例如：

```ts
type LegacyOnboardingReadResult =
  | { status: 'absent' }
  | {
      status: 'present';
      registered: boolean;
      email: string | null;
      serverUrl: string | null;
    }
  | { status: 'invalid' };
```

收编触发仍要求 `registered===true`，但登录页预填可独立使用 `email`。测试至少覆盖：

- registered true + email + serverUrl：可进入收编；
- registered false + email、无 serverUrl：不收编，但可预填 email；
- 旧版本抹除后 registered false、email/serverUrl 都无：不收编、无预填，明确要求用户完整重登；
- malformed JSON：不崩溃、不写 marker；
- registered true 但 serverUrl 缺失：守卫失败且不写 marker。

规格应把“升级员工免重登”收窄为“来源仍完整的已注册机器免重登”，不能暗示被旧 logout 抹过的机器仍可恢复。

---

### M2. host 守卫比较语义不够精确，测试无法判断端口、非法 URL 和路径差异

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:14](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:14)

当前代码只有 URL 构造/归一化，没有任何 adoption host 守卫：

- `buildApiBaseUrl()` 见 [OnboardingService.ts:733](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:733)；
- `deriveCchBaseUrl()` 见 [OnboardingService.ts:748](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:748)。

规格写“host 必须一致”，但未说明使用：

- `URL.hostname`，不含端口；
- `URL.host`，含端口；
- `URL.origin`，含协议和端口。

在公司网关场景中，只比 hostname 可能放过错误端口；只比 origin 又会把 http/https 差异纳入拒绝。该差异会直接改变安全守卫行为。

**具体改法：**

钉死生产 helper，例如：

```ts
function compareAdoptionGateway(
  claudeBaseUrl: string,
  onboardingServerUrl: string
): 'match' | 'mismatch' | 'invalid_url' {
  return new URL(claudeBaseUrl).host === new URL(onboardingServerUrl).host
    ? 'match'
    : 'mismatch';
}
```

如果决定协议也必须相同，则明确用 `origin`，不要仍写“host”。

矩阵至少包含：

- 同 host、路径一个带 `/v1`：通过；
- hostname 不同：拒绝；
- hostname 同、端口不同：按明确裁定判定；
- 一个 URL 非法：拒绝；
- username/password URL 或非 http(s) scheme：拒绝；
- Codex key 与 Claude token 不同：独立拒绝，证明不是 host 分支造成。

---

### M3. rmSync 外科修已有测试仍在锁定错误旧行为；规格没有要求替换该断言，也没有钉纯转换函数

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:26](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:26)、[2026-08-15-d47-s6-adoption-spec.md:48](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:48)

当前实现确实整删：

```ts
fs.rmSync(configPath, { force: true });
fs.rmSync(authPath, { force: true });
```

见 [OnboardingService.ts:680](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:680)。

当前测试明确要求两个文件不存在，见 [OnboardingService.test.ts:246](/home/dan/projects/ai-client/src/main/services/onboarding/__tests__/OnboardingService.test.ts:246)。这不是缺测试，而是一个会在正确施工后继续要求错误结果的旧测试锚。

**具体改法：**

规格应明确：

1. 替换现有 `logout removes local CLI credentials` 的两个“不存在”断言，而不是只新增旁路测试。
2. 抽出纯函数：

```ts
removeOpenAiApiKey(authObject)
removeJywProviderFromToml(tomlText)
```

3. `auth.json` fixture 必须包含：

```json
{
  "OPENAI_API_KEY": "app-key",
  "tokens": { "userOwned": true },
  "OTHER_PROVIDER_KEY": "keep"
}
```

预期文件继续存在，仅 `OPENAI_API_KEY` 缺失，其余深度相等。

4. `config.toml` fixture 必须包含：

   - root `model_provider = "jyw"`；
   - `[model_providers.jyw]`；
   - 另一个 provider 表；
   - 用户自有 root 键；
   - 注释与空行哨兵。

预期只移除目标 root 行和 jyw 表，其他字节块保持。

5. 增加 `.codex/sentinel-user-file`，证明没有删除目录或旁文件。

GUI 附录的事故证据与当前代码一致，但事故报告本身不能代替上述回归测试。

---

### M4. UsageService 的“serverUrl 权威迁移”测试必须证明 flag-on 完全不依赖 legacy onboarding，而不仅是返回正确 URL

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:29](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:29)、[2026-08-15-d47-s6-adoption-spec.md:49](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:49)

当前状态与规格移交描述一致：

- flag-on key 已从 vault 读取，见 [UsageService.ts:84](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:84)；
- serverUrl 仍无条件来自 `onboardingService.checkRegistration()`，见 [UsageService.ts:202](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:202)；
- 源码注释也明确标记 serverUrl 迁移归 S6，见 [UsageService.ts:84](/home/dan/projects/ai-client/src/main/services/usage/UsageService.ts:84)。

现有 flag-on 测试只证明 key 来自 vault；它仍依赖 legacy onboarding serverUrl。因而不能复用为 S6 权威迁移证明。

**具体改法：**

建议把 key 和 URL 一次性解析成同一权威对象，避免同一次请求跨两个来源：

```ts
type UsageAuthTarget =
  | { status: 'ready'; serverUrl: string; apiKey: string }
  | { status: 'unavailable' };
```

测试双轨：

- flag-on：

  - vault 为 `ok`；
  - legacy onboarding 缺失或故意放一个错误 host；
  - 请求必须走 `vault.doc.payload.cchBaseUrl`；
  - legacy reader 调用数应为 0，或至少其返回值绝不能参与 URL 决策；
  - vault 最好只读一次，保证 key 和 serverUrl 同一快照。

- flag-off：

  - vault fake 设置成一旦读取就抛错；
  - legacy onboarding + auth.json 完整；
  - 请求继续走 legacy serverUrl/key；
  - vault read 为 0。

- flag-on vault 为 cleared/rejected/locked/invalid：

  - 不回退 legacy；
  - 返回 credentials unavailable；
  - 防止停双写后又隐式把旧凭据复活。

---

### M5. `cleared` 与 `absent` 当前真实可区分，但规格应禁止复用 `regenerateFromVault()` 中现有的合并逻辑

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:38](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:38)

这一承重前提在当前代码中是真实可行的：

`VaultReadResult` 当前全部臂为：

- `ok`
- `absent`
- `cleared`
- `rejected`
- `locked`
- `unsupported`
- `invalid`

定义见 [CredentialVault.ts:75](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:75)。

读取顺序也明确：

- 无文件：`absent`，见 [CredentialVault.ts:187](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:187)；
- `invalidatedAt` 非空：优先 `rejected`，见 [CredentialVault.ts:218](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:218)；
- `payload:null`：`cleared`，见 [CredentialVault.ts:228](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:228)；
- locked/invalid/ok 后续分支见 [CredentialVault.ts:236](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:236)。

`clear()` 真实写入 `payload:null`，见 [CredentialVault.ts:389](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:389)，已有真实文件测试见 [CredentialVault.test.ts:117](/home/dan/projects/ai-client/src/main/services/auth/__tests__/CredentialVault.test.ts:117)。

但现有 `regenerateFromVault()` 在 Claude dev-seed 逻辑中故意把 `absent | cleared` 合并，见 [managedClaudeHomeStartup.ts:175](/home/dan/projects/ai-client/src/main/services/auth/managedClaudeHomeStartup.ts:175)。那是 S2 的 dev seed 规则，不可拿来复用为 adoption eligibility。

**具体改法：**

adoption 必须自己对完整 union 做穷举 `switch`，且只有 `absent` 进入 legacy 读取：

```ts
switch (vault.read().status) {
  case 'absent':
    return tryAdopt();
  case 'cleared':
    return skip('cleared');
  case 'rejected':
  case 'locked':
  case 'unsupported':
  case 'invalid':
  case 'ok':
    return skip(status);
}
```

配 `assertNever` 或等价穷举检查，防将来新增状态静默进入收编。

---

## 3. Minor

### m1. “失败/守卫不过不写 marker”中的“失败”范围未枚举

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:21](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:21)

至少需要逐项说明以下结果是否写 marker：

- 某源文件不存在；
- JSON/TOML 解析失败；
- host/key 守卫失败；
- `vault.save` 返回 `{ok:false}`；
- regenerate 某一 home 失败；
- refresh 状态不是 authenticated；
- probe 网络未知；
- probe 明确拒绝；
- marker 自身写失败。

否则“marker 只成功后写”无法转化为测试矩阵，也无法判断下次启动是否应重试。

建议定义一个显式结果联合：

```ts
type AdoptionResult =
  | { status: 'skipped'; reason: ... }
  | { status: 'adopted'; probe: 'valid' | 'rejected' | 'unknown' }
  | { status: 'failed'; stage: 'read' | 'save' | 'regenerate' | 'marker' };
```

---

### m2. marker 写入需要和 vault 相同等级的权限/原子性断言

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:20](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:20)

marker 位于 `<userData>/credentials/.adopted-v1`，但规格只写“写 marker”，没有规定：

- 创建权限；
- 是否原子写；
- 并发启动时的幂等行为；
- 空文件还是带 version；
- marker 写失败是否回滚 vault——通常不应回滚，但必须登记。

建议使用可识别内容，例如 `{"version":1,"adoptedAt":"..."}`，0600、同目录原子 rename，并测试并发两次调用只有一次 `vault.save`。如果只建空文件，非空证明和未来版本迁移都更弱。

---

### m3. “同 schema 同路径”测试不能只检查最终 `vault.read().status==='ok'`

**规格位置：** [2026-08-15-d47-s6-adoption-spec.md:41](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-s6-adoption-spec.md:41)

由于当前 Vault payload 读回存在类型 cast，旁路写出结构不完整的 payload 也可能被报告为 `ok`。因此应同时：

- spy `vault.save` 恰好一次；
- 对传给 `save()` 的 payload 做完整字段断言；
- 收编模块结构上不得获得 vaultPath；
- 对 `identity.email`、`userId:null`、三个 base URL、两把 key、`receivedAt` 全字段断言；
- 再做真实 save/read roundtrip。

只断言 marker 或 `status:'ok'` 不足以证明复用了相同 schema。

---

## 4. §4 裁定 a~e 逐条判定

### a) 收编在 `regenerateFromVault` 之前跑

**判定：真，但当前规格的编排描述不可直接施工。**

依据：

- safeStorage 只有首窗构造后才升格，见 [src/main/index.ts:673](/home/dan/projects/ai-client/src/main/index.ts:673)；
- 现有唯一正确插槽确实是 `openLocalWindow()` 返回后、`await regenerateFromVault()` 之前，见 [src/main/index.ts:743](/home/dan/projects/ai-client/src/main/index.ts:743)；
- 在此之前调用 adoption，`vault.save()` 才不会因 crypto 未升格而拒写；
- 在现有 regenerate 之后调用则首轮 homes 已经按 absent 物化，收编生效要等第二次 regenerate。

所以顺序裁定本身是真。但必须先修 B1，明确 adoption、regenerate、refresh、probe、marker 的唯一所有者，避免重复编排。

---

### b) `cleared` 不收编，marker 只在成功后写

**判定：真。**

依据：

- `cleared` 已是当前真实独立联合臂，见 [CredentialVault.ts:75](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:75)；
- `payload:null` 明确返回 `cleared`，见 [CredentialVault.ts:228](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:228)；
- `clear()` 在登出后写空 payload 壳并保留 email，见 [CredentialVault.ts:389](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:389)；
- 测试已证明 cleared 与 absent 的差异，见 [CredentialVault.test.ts:117](/home/dan/projects/ai-client/src/main/services/auth/__tests__/CredentialVault.test.ts:117)。

若允许 cleared 收编，用户刚登出后下一次启动会从留置 legacy 文件重新登录，直接破坏登出语义。因此该裁定必须保留。

marker 当前尚无生产实现，故“只成功后写”是正确设计裁定，但还没有仓内落地证据；必须按 B1/m1 补齐成功定义和 probe 结果矩阵。

---

### c) flag-on 登出不再清 legacy

**判定：真。**

这是 U1“收编但永不清理”的正确延伸，也与 vault 无 flag 清理不冲突：

- vault 在当前 `performLogoutSequence()` 中仍应无条件 clear，见 [src/main/ipc/onboarding.ts:105](/home/dan/projects/ai-client/src/main/ipc/onboarding.ts:105)；
- legacy CLI 文件当前则仍被 `logout()` 清理，见 [OnboardingService.ts:347](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:347)；
- Codex 当前整删实现见 [OnboardingService.ts:680](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:680)；
- GUI 真机事故见 [2026-08-15-d47-gui-checklist.md:51](/home/dan/projects/ai-client/docs/plans/2026-08-15-d47-gui-checklist.md:51)。

所以该项不是对现状的描述，而是 S6 必须执行的正确行为变更。需要按 B3 拆开 CLI 清理和 `.aiclient` app 状态更新，不能简单跳过整个 `logout()`。

---

### d) identity.userId 收编时置 null 的 schema 放宽

**判定：伪。**

当前 schema 明确是 `number`，不是 `number|null`，见 [CredentialVault.ts:41](/home/dan/projects/ai-client/src/main/services/auth/CredentialVault.ts:41)。真实登录也写数字 ID，见 [OnboardingService.ts:303](/home/dan/projects/ai-client/src/main/services/onboarding/OnboardingService.ts:303)。

因此“收编时置 null”按当前代码不能编译，必须先完成 B2 中的类型、测试和可选运行时校验修改，之后该设计才可能变真。

---

### e) 投影链物理删除改归 flag 转正后的退役批，而不是 S6

**判定：真。**

当前 agent-host Codex home 明确有两条分支：

- managed 分支不投影；
- fallback 分支仍执行真实 config projection 和 auth copy。

分支点在 [src/agent-host/codexHome.ts:640](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:640)；fallback 投影写入与 auth copy 在 [src/agent-host/codexHome.ts:651](/home/dan/projects/ai-client/src/agent-host/codexHome.ts:651)。

而 S6 明确不改变 flag 默认 off，并保留 flag-off 回退。只要 fallback 仍受支持，就不能在 S6 物理删除 projection chain，否则 flag-off Codex session 会失去现有 home 隔离/配置生成能力。

所以应修正 S34 的“S6 删除”归属，改为 flag 正式转正、fallback 退役后的独立批次。S6 本片最多补注释和回退依赖测试，不应删除生产链。

---

## 5. 开工判语

**结论：当前 rev.1 不可以按此规格直接开工。**

现状核对结果是：

1. `CredentialVault.read()` 的七臂联合已经真实落地，`absent` 与 `cleared` 可以可靠区分；
2. flag-on 登录当前确实仍然执行全部 legacy 三写手，双写现状成立；
3. flag-on 登出当前确实仍调用 legacy cleanup，并会整删 `~/.codex/config.toml` 与 `auth.json`；GUI 事故与源码一致；
4. adoption 的正确插槽是首窗构造/crypto 升格之后、现有 `regenerateFromVault()` 之前；
5. `~/.aiclient` 的 email/serverUrl 并非所有存量机器都可取得，尤其旧 logout 可能已经抹除，当前读取 API 还会隐藏 `registered:false` 下留存的 email；
6. S2 黄金差分提供了 Buffer 比较和非空证明范式，但只覆盖一个 Claude 文件，不能直接证明“登录 legacy 全路径写调用数=0”；
7. rmSync 现有测试仍要求整删文件，必须重锚；
8. 六个必选变异目前都没有完整四列表，其中 ⑤还必须拆成 auth/config 两个变异；
9. §4 的 a、b、c、e 裁定成立，d 明确为伪。

开工前至少必须修完以下四组：

- **B1：** 唯一 startup/adoption/regenerate/refresh/probe/marker 编排与 probe 结果矩阵；
- **B2：** `userId:null` schema 裁定及类型/测试改动面；
- **B3：** flag-on logout 的方法拆分和 `.aiclient` 状态语义；
- **B4+B5：** 完整 legacy fs mutation trace 断言，以及六必选变异四列表。

同时建议把 M1～M4 一并写入 rev.2，否则即使能开始编码，验收阶段仍会遇到“收编源读不到、host 守卫口径漂移、旧 rmSync 测试冲突、UsageService 混合权威”四类可预见返工。

本次仅进行了仓库阅读和搜索，没有修改、创建或删除任何文件；检查时工作树为 clean，当前 HEAD 为 `b5ec5a4`。受“只允许阅读/搜索”约束，本轮没有执行会生成缓存或测试产物的测试命令。

Codex session ID: 01a0081d-a140-7a30-9e8e-bb834ce2b7e8
Resume in Codex: codex resume 01a0081d-a140-7a30-9e8e-bb834ce2b7e8
