# D47 GUI 点验报告 — 托管登录链首次全链真跑（2026-08-15）

> 环境：本机 dev（`AICLIENT_MANAGED_CREDENTIALS=1`，codex 臂加 `AICLIENT_AGENT_CODEX=1`；不设
> `AICLIENT_SKIP_AUTH_GATE`）；CDP 工法驱动 + 用户真机配合（真实验证码 ×1、亲手输码登录）。
> 证据截图：`docs/design/refs/d47-gui-20260815/`（01 登录页 / 02 登录结果页 / 03 已登录主界面 /
> 04 Claude 回合 / 05 登出后预填）。报告中密钥一律 `<REDACTED>`。

## 结果总表

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | flag-on 冷启动 → 登录门禁生效（登录页 + 标题栏「Not signed in」） | ✅ | 01 截图 |
| 2 | 真实邮箱+验证码登录（用户亲手输码） | ✅ | 02 截图；user id 14 |
| 3 | vault 落盘：0600 / **safeStorage 加密**（payload 为密文串）/ lastEmail 在 | ✅ | 文件检查 |
| 4 | claude-home 生成：env 三键 + **`~/.claude/CLAUDE.md` 一次性收编生效** + commands/skills 目录 | ✅ | 文件检查 |
| 5 | codex-home：Main 生成 config.toml（env_key 形态）+ **无 auth.json**（I4 动作化成立） | ✅ | 文件检查 |
| 6 | **重启持久化**：重启后直进已登录主界面（authenticated + email） | ✅ | 03 截图 |
| 7 | **auth-probe 实打**：`remoteHealth:'valid'`（真 cch `/api/auth/login` 200） | ✅ | gate 快照 |
| 8 | **用量卡**：标题栏 $31.06 渲染（§0 cookie 载体修复实证——修复前该链必 401） | ✅ | 03 截图 |
| 9 | **Claude 会话真实回合**：「1+1=? 只回答数字」→「2」（claude-sonnet-5，1s） | ✅ | 04 截图 |
| 10 | **终端注入铁证**（app 内 PTY `/proc/environ`）：`CLAUDE_CONFIG_DIR`→托管 home、`CODEX_HOME`→托管 home、`AICLIENT_CODEX_API_KEY` 在、**`ANTHROPIC_* = 0`**（printenv 干净） | ✅ | environ 读取 |
| 11 | **终端 codex 实转**：PTY 内 `codex exec` →「OK」EXIT=0（env_key 认证 + 生成 config 过真网关） | ✅ | 输出文件 |
| 12 | **codex 注册表托管臂**：双 flag 下 `capabilities.agents=['claude-code','codex']`；单 managed flag 时 codex 正确 flag_off 短路 | ✅ | IPC 查询 |
| 13 | **codex 聊天会话全链**（app-server 托管路径，经 IPC 生产接缝——UI 入口属未立项阶段 3）：`session.created`（posture 回显 on-request/workspace-write，H9 链）→ 实转「→ OK」；子进程 env：托管 CODEX_HOME + env_key + **零 ANTHROPIC_***（spawn 收窄实证） | ✅ | 事件流 + environ |
| 14 | **登出全链**（UI 点击）：回登录页；vault payload 清空**留 lastEmail**；claude-home env 归零；codex 进程回收；**重登预填 danyuan@jcdz.cc** | ✅ | 05 截图 + 文件检查 |

## 抓获缺陷（1 条，当场修复）

**登录成功后 gate 快照永远 `signed_out`，用户卡在结果页**——`OnboardingService`/IPC 注册成功路径漏接
`AuthStateService.refresh()`（登出侧第⑦步有、注册侧没有的不对称漏项；S5a 施工遗漏，规格 §1.2 有要求）。
修复 = `createVerifyAndRegisterHandler` 加 `onSuccess` 钩子（纯工厂可测），注册处接
`getAuthStateService().refresh()`；回归 2 例。commit `bf8de41`。
**方法论注记**：五轮 vitest（3874 例）与变异（10/10）都没抓到这条——它是「接线缺席」而非「逻辑错误」，
恰是 GUI 全链真跑的独有价值（layout-invisible-defects 纪律再证）。

## 跳过臂（诚实登记）

- **失效注入臂**（dev `auth.devMarkInvalidated` → expired 路由）：机理已被单测钉死；GUI 实证需再烧一枚
  验证码重登，本轮跳过，随 test.4 真机轮补。
- **locked 臂**（keyring 锁定 → LoadingShell 不踢人）：需模拟 keyring 锁定，本轮跳过（单测覆盖）。
- **flag-off 对照轮**：off 轮等价性由黄金差分/零变异测试钉死，GUI 跳过。
- **close-confirm 双向**、**mac UserProfileCard 缺席**：随 test.4。
- 过程杂音（不影响结论）：dev 进程树清理需精确 kill（electron-vite 会在原树内热重启 electron，
  外层 pkill 模式匹配两次没杀干净——CDP 工法记忆待补一条）。

## 结论

**D47 托管登录链全链真跑 PASS**（14/14 主链项）。S0~S5 全部落地且经真实网关/真实验证码/真实进程环境验证。
残余 = S6（收编存量 + 停双写 + 兼容清理）与 test.4 真机轮补测项。

## 附：点验连带事故（2026-08-15 晚，已复原）

GUI 登出测试触发**现行 flag-on 登出仍跑 legacy `removeCodexConfig` 的 `rmSync` 整删**——用户本机
`~/.codex/{config.toml,auth.json}` 被删（该机器的 codex 日常即走 cch 账号，config 里的 provider 段被抹后
本机 codex 回落官方 api.openai.com 打 401）。靠登录时刻的 `.bak` 完整复原（provider/base_url/key 全对）。
**这正是 S6 §1-3 要修的破坏性 bug 的真机实锤**；S6 停双写 + 外科删除落地后此类事故根除。

## 附二：S6 收编真机双步（2026-08-16 凌晨，分发纪律解除证据）

| 步 | 操作 | 结果 |
|---|---|---|
| 造场 | flag-off 真实登录（用户输码），重建 legacy 五源（claude env 三键 / onboarding registered+email+serverUrl / .claude.json / codex jyw 表+auth.json——rmSync 外科修后 legacy 写手已不再破坏用户自有 OpenAI 表） | ✅ 四文件逐项核对 |
| 初态 | 杀进程 + 删 vault/marker（模拟存量员工首次升级 flag-on 版本） | ✅ 零进程零 vault |
| 证据 | **flag-on 冷启动 → 零重登直进主界面**：authenticated + email + probe valid + 用量卡 $48.79；vault 收编生成（safeStorage 加密 + lastEmail）；marker `.adopted-v1` 写入（adoptedAt 2026-08-16T10:59:47Z）；托管 claude-home env 三键再生成；**legacy `~/.claude/settings.json` mtime 停留登录时刻 = 停双写实证** | ✅ 截图 06 + 落盘四证 |

**分发纪律解除条件全部满足**（S6 落地 + 真机零重登证据）。D47 全链收官。
