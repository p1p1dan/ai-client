# Test & Release Gates

## 提交门禁（DoD，执行计划 §4）

- **四绿**（2026-08-06 起，原为三绿）：
  1. `pnpm typecheck`（根 tsconfig，**排除 src/agent-host/**）
  2. `pnpm typecheck:agent-host`（`-p src/agent-host/tsconfig.json`，266 文件）——**S3 切片 1 新增的第四道门**。
     补的正是上一行括号里那个盲区：根门对 `src/agent-host/**` 实测编译 **0 个文件**，
     单独跑立刻暴出 8 个真错，`git stash` 退回 HEAD 复验为 0（即为本轮引入）。
     该盲区此前只靠「Host 门禁」的单测侧面兜底，类型层长期无人看守。
  3. `pnpm lint`（biome，**0 诊断基线**自 C-09 `ce5a577`；`.gitattributes` 锁代码文件 eol=lf）
  4. `pnpm test`（vitest；**2026-08-06 时点 133 文件 2479 例，0 红**）

  > **口径纠正（2026-08-06）**：2026-08-05 之前若干条台账记「三绿」，但 HEAD 上实测**恒有 3 例红**
  > （`ShellDetector` ×2 + `CliDetector` ×1）。它们并非 flaky，也不是「在 Linux 上无意义」——
  > 而是**从未模拟过 Windows**，依赖宿主真的是 Windows，在别的平台上恒红。
  > 已于本日修复（测试侧加 `process.platform` 桩，抢在动态 import 之前；产品代码零改动），
  > 四门首次同时为真。**教训**：「三绿」写进台账前必须是当次实跑输出，不得沿抄上一行。
- 提交规范 Conventional Commits 中文描述（分类表见 `CLAUDE.md`）。
- 加密机相关项**永不**在开发机标注通过。

## Host 门禁（typecheck 盲区的补位）

- vitest 单测：`src/agent-host/__tests__/`（historyReader / eventNormalizer / permissionBridge / **protocolErrors 真子进程 NDJSON**）。
- spikes smoke：`src/agent-host/spikes/*-smoke.ts`（网关凭证由 `testCredentials.ts` 自动注入，零配置）。

## 打包门禁

- `pnpm verify:packaged` 25 项：app 壳 / agent-host 结构与剪枝 / TSD header 哨兵 / Node24 寻径 / **随包 node.exe 直跑网关 PONG**。
- 打包链：`pnpm dist:prereq` → electron-builder → afterPack 串行拷贝（勿回退 extraResources——rcedit 竞态先例见主线台账 C-02 行）。

## CI

- `.github/workflows/build.yml`：tag 触发，双平台打包 + agent-host 构建 + 结构断言。
- **无测试作业**（C-09 期间发现）——是否补 test/lint 步骤见 open-questions。

## GUI 联调环境

> **2026-07-29 变更**：凭证改为启动期从 `dev.env` 注入，启动器统一走 `node scripts/dev.js`。
> 下方旧口径（手工设 `CLAUDE_CONFIG_DIR` + `pnpm dev`）仍能用，但不再是主路径。

一次性准备：把仓库根的 `dev.env.example` 复制成 `dev.env`（已 gitignore），填入自己的网关与 key：

```bash
cp dev.env.example dev.env
# ANTHROPIC_BASE_URL=https://your-gateway.example
# ANTHROPIC_AUTH_TOKEN=sk-...
# AICLIENT_TRUSTED_WORKSPACES=/abs/path/to/other-repo   # 可选，仓库根总是预信任
```

之后每次启动：

```bash
node scripts/dev.js
```

`dev.js` 在拉起 Electron 前做三件事：**剥离** shell 继承的全部 `ANTHROPIC_*` 及
`CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` / bedrock / vertex 变量；**注入**仅 `dev.env`
声明的值；**隔离** `CLAUDE_CONFIG_DIR` 到 `node_modules/.cache/aiclient-dev-credentials/`，
使 cli.js 够不到本机 `~/.claude/settings.json` 与 `.credentials.json`。
**缺 `dev.env` 直接拒绝启动**（否则会用开发者本人的 Claude 登录计费）；确需本机凭证时
显式加 `--allow-local-credentials`。

⚠️ **不要用 `pnpm dev`**：pnpm 10 的 `verifyDepsBeforeRun` 会在跑脚本前重装依赖，
冲掉 `electron-builder install-app-deps` 重建好的原生模块（见下方复原两步）。
覆盖面缺口（打包版 / `pnpm preview` 不经 dev.js，仍走本机登录）见计划树 open-q **#14**。

首启无仓库时用 `node scripts/dev.js --open-path=<仓库绝对路径>` 注册仓库（OpenChamber 壳内无添加仓库 UI）。
Beta 壳入口：Settings → Appearance → OpenChamber Workspace Shell（`SKIP_ONBOARDING_GATE=true` 时强制开启）。
