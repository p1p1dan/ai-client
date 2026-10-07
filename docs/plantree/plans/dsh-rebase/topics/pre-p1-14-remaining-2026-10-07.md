Role: topic

# P1-14 之前的剩余工作盘点（2026-10-07）

> **状态（2026-10-07 文档收口后）：(a) 类全部完成。**
> - P1-5d `031c10f9`；P1-5e `4bd31a2c`；E8 实验 `f08f0646`、结论 `35af10ab`；E8-A 守卫 `350aa1b1`；P1-3e `4f461ece`（证据 `16cd195e`）；P1-8c 工作流 `9748ddef`、`42dddf81`；阶梯 B 修复 `4ebcfe5a`；界面小修 `5d495e01`、`c568b989`、`e81ea90c`、`d01e8db4`；文档收口（roadmap、看板、审批汇总、决策 157、过期文档与回写）。
> - (b) 类并入 [roadmap](../roadmap.md) 的 P1-14 行与[看板 Next Target](../implementation-status.md#next-target)；(c) 类并入 [decision-review-4.md](../decision-review-4.md)。
> - 第 7 项「文档收口」里有两样没做，转入 P1-14：P1-13 第二轮上机手册；可选的 P1-6 用例数证据。
> - 下文是盘点时的原文，没有改。

上位：[roadmap](../roadmap.md)。背景：P1-12 于 2026-10-07 收口；用户决定暂不推送打包，先做 P1-14 之前本机能做的剩余工作。盘点基于 HEAD `dfef48a8`，由只读代理逐行核对 roadmap 的 🟡 行，编排者抽查了 P1-5d、P1-5e 两条。

性质：(a) 本机可做；(b) 只差 GUI 点验、Windows、CI 或真机（需推送或需用户）；(c) 只差用户审批或裁决。

## 结论

- P1-2、P1-4、P1-6、P1-16 的子任务都已做完或已被裁决取消，只差把 roadmap 改成 ✅。
- P1-5c 已完成（档位规则 `dsh-host` 的 `route.ts`、设置映射 `dshModelPlan/settings.ts`、失败码表 `shared/dshFailureCodes.ts`，R4 实测一致），roadmap 里「剩 P1-5c～e」已过期。
- P1-13d 已合入（`30893b28`、`70956bf7`），看板里「在等 P1-13d」已过期。

## (a) 类工作，按顺序做（本机一次一个代理）

执行顺序以[决策 149](../decisions/149-user-rulings-2026-10-07.md) 末尾为准：P1-3e → P1-5e → E8-A（审查判据与静态守卫，决策 150）→ P1-8c → 界面小修 → 文档收口。已完成：P1-5d `031c10f9`、E8 `35af10ab`、P1-3e `16cd195e`。

1. **P1-5d 协议收口**：`ProviderSetupDialog.tsx` 仍列 10 种协议（来自 `userProviders.ts`），已有服务不标「暂不支持」。按决策 036 第 2 条：新建只能选三种协议并附说明，已有的其他协议标「当前引擎不支持」，预设也过滤。
2. **P1-5e 管理员 key 缓存加密**：`PiModelConfigService.ts` 仍明文 `atomicWriteJson(this.sourcePath, config, 0o600)`，`configValidation.ts` 允许 managed 的 apiKey 进这份配置；R10 零命中说明公司目录目前不下发 managed key，风险是潜伏的。Linux 无钥匙串时的口径已由[决策 149](../decisions/149-user-rulings-2026-10-07.md) 第 2 条裁决：跟保险库一致。
3. **P1-5 E8 实验**：同进程插件能否读到 IPC 上的凭据应答（`p1-10-p1-16-extensions.md` §4.5）；写测试插件在真宿主上跑，结论写进决策。
4. **P1-3e**：给 `tools/probe-bundle` 加「审批处理器不理会 abort」的卡死开关，集成测试 S5 改用它（现在在 IPC 层丢消息模拟）；补 `evidence/p1-3-shared-host-<日期>.md`。
5. **P1-8c 接 CI**：`dsh-bridge-gate.yml` 加 loop-guard-smoke 与 LC-0～2 硬门槛（决策 067 第 5 条）；可顺带写 P1-3e 的 Windows 杀宿主场景。只写工作流，随下一次推送生效。
6. **界面小修**（[决策 149](../decisions/149-user-rulings-2026-10-07.md) 第 3 条：合入前做，#44、`Session xxxxxx`、`Archive` 三条单独问用户）：决策 145「发现（本组没有改）」（`i18n.ts` 仍有「Agent Host」、10 px 中文、读屏原语读英文、DialogPanel 焦点框、error 会话留在「正在活动」、改名 Esc 后焦点不回）；决策 146 第 13 条（指定模型时评审标题是原始 id）、第 22 条（失败回合直播空消息与回放注记并存）。
7. **文档收口**（最后做）：roadmap 各行状态；看板的 Current Phase、Next Target、Blocked By；决策 131～147 的审批汇总；runtime-hardening 回写；出站代理决策（roadmap 写「在 P1-3 定」，没有记录）；P1-13 第二轮上机手册；`CLAUDE.md`、`handoff-2026-09-28.md`、ARD 的过期内容；P1-2 证据补 CI 安装包大小；可选的 P1-6 用例数证据。

## (b) 类（需推送或需用户）

- 第 4 步之后的整包 CI、P1-8c 工作流首跑（推送前升版本到 `1.1.0-dsh.5`）。
- P1-3e GUI 专项（空闲 / 流式 / `sleep 30` 三个会话杀宿主）、Windows 上杀宿主。
- P1-5 R8 重新登录后跑通一次完整回合（GW-16、GW-17）；R9 等网关管理员答复；R10 是否补 Main 侧 canary 扫描待确认。
- P1-7d Windows 实测 W1～W12（清单 J 节）；P1-7e e6（`5e29f08d`）复点验；P1-8 GUI 点验（小上限提示条与「继续」、退化回复的失败卡）。
- P1-13 第二轮上机（GUI、真实模型、插件子进程、迁移）。
- 真实数据离线迁移测试（P1-9 退出判据）仍待授权。

## (c) 类（用户）

- 待审批决策：131～147 中标「待审批」的各条（含 133、136、147 第 1～4 步）。
- Q002 / Q005 关闭（决策 084 第 4 条：只测了管理员，Q010 已裁决管理员即可）。
- GW-16 的 compat 降级选项；决策 145 的问题 #44、`Session xxxxxx`、`Archive`。
- 本地遗留：`out-agent-host/`、`biome.json` 忽略项、根 `package-lock.json`。
