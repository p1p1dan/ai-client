# T37-d Release closure — 2026-09-03

**Role**：evidence · **Status**：accepted
**Related**：[roadmap T37](../roadmap.md#t37--pi-only-release-gates--done) · [T37-c](./2026-09-02-t37c-gui-packaged.md) · [T37-d session fix](./2026-09-02-t37d-session-brick-fix.md) · [migration guide](../../../../pi-only-migration.md) · [rollout/rollback](../../../../pi-only-rollout-rollback.md)

## 结论

T37 Pi-only release candidate 门禁关闭。最终候选提交 `f2777d7b` 在分支
`feat/pi-primary-backend` 的手动 Build workflow 中完成 Linux x64、Windows x64 与 macOS arm64
原生打包；三平台均通过 permission policy smoke、bundled Node 检查、license/notices 检查和
packaged worker bootstrap/dispose/exit smoke。

本批只推送分支，没有打 tag、没有创建或发布 GitHub Release，因此不会影响正在使用的已发布版本。
macOS 按用户拍板以 **unsigned native CI candidate** 关闭 T37 结构门禁；Developer ID 签名、公证与
真实 Mac Gatekeeper 验证仍是正式发布条件，由 rollout runbook 管，不把 unsigned 产物描述为正式安装包。

## 发版资料与法务边界

落地：

- 根 `THIRD_PARTY_NOTICES.md`：保留 pi-app（2026 justhil）、pix（2026 Num Scope）和 Pi
  coding agent（2025 Mario Zechner）MIT notice；直接/适配移植文件回链该 notice。
- `electron-builder.yml`：`LICENSE` 与 `THIRD_PARTY_NOTICES.md` 固定进入
  `resources/licenses/`。
- `scripts/verify-packaged-app.mjs`：三平台硬检查 legal resources 与三组 attribution。
- `scripts/verify-release-metadata.mjs`：CI 静态检查 notices、migration、rollback、curated notes、
  builder copy 和单一 release-note owner。
- `docs/pi-only-migration.md`：Pi-only、Claude read-only import、Codex 未开放、`.aiclient → .pilab`、
  GUI/TUI ownership 与 rollback 用户口径。
- `docs/pi-only-rollout-rollback.md`：候选→内部观察→限量→正式发布、blocker 与 rollback runbook。
- `docs/release-notes/unreleased.md`：0.4 curated user-facing notes；tag workflow 只追加实际下载项。
- 删除与 Build workflow 竞争写 release body 的 `.github/workflows/release-notes.yml`。
- `README.md` / `README.zh.md` 改为 Pi-only 当前产品事实，不再宣传已删除的 Claude/Codex/Gemini/
  custom CLI execution runtime。

## CI packaged evidence

成功 run：

- URL: https://github.com/p1p1dan/ai-client/actions/runs/33714362901
- Run ID: `33714362901`
- Head: `f2777d7be1210a99bcabdec266c27b9c1c807088`
- Event: `workflow_dispatch`
- Started: `2026-09-03T04:15:12Z`
- Completed: `2026-09-03T04:36:46Z`
- Result: **success**

| Job | 结果 | 关键证据 |
|---|---|---|
| gate | pass | 两套 typecheck；Biome 960 files；Vitest 256 files / 3911 tests；release metadata pass |
| build-app | pass | Electron/Vite application output uploaded |
| remote runtime Linux x64/arm64 | pass | 两架构 bundle uploaded |
| build-windows | pass | permission gate intact；worker 48.2 MiB；legal + bootstrap/dispose/exit pass |
| build-linux | pass | permission gate intact；Xvfb packaged smoke；worker 48.2 MiB；legal + bootstrap/dispose/exit pass |
| build-macos | pass | native arm64 unsigned package；permission gate intact；worker 48.2 MiB；legal + bootstrap/dispose/exit pass |
| generate-release-notes | skipped | 正确：manual branch run 不发布 release，tag-only job 未执行 |

### Artifact inventory

GitHub artifact IDs / Actions archive size：

| Artifact | ID | Archive bytes |
|---|---:|---:|
| `windows-installer` | `9878161309` | 187,366,686 |
| `windows-portable` | `9878163544` | 186,874,435 |
| `windows-unpacked` | `9878173762` | 273,201,319 |
| `linux-packages` | `9878143088` | 378,073,449 |
| `macos-arm64-packages-unsigned` | `9878375014` | 419,772,329 |
| `macos-arm64-unpacked-unsigned` | `9878388342` | 460,503,456 |

下载四个 package archive 后记录 SHA-256（hash 对象是 GitHub Actions 下载的 zip archive）：

```text
windows-installer               11d71b2cf11e2723e8be0e53ef56e6a73753ded74b237d376fe09d8fd198b04d
windows-portable                abdf2579e6a0a5de55f5ceaa40c85fbb1537d2ce61a1b3b8f957d927ec95b580
linux-packages                  19b5af61cf9a59607b9a7228ae6e9c9ddc1c2d4501b999dfe40ddc09f668f376
macos-arm64-packages-unsigned   950f388a71c5ad66a85444c14db6c2f3d331ab2b05e80b121cd745a4fa6b81af
```

Archive 内文件：

```text
AiClient Setup 0.4.0-test.6.exe
AiClient Setup 0.4.0-test.6.exe.blockmap
AiClient-0.4.0-test.6-portable.exe
AiClient-0.4.0-test.6.AppImage
jyw-ai-client_0.4.0-test.6_amd64.deb
AiClient-0.4.0-test.6-arm64.dmg
AiClient-0.4.0-test.6-arm64-mac.zip
```

## CI 暴露并关闭的门禁缺陷

前三次 manual run 没有被抹掉；它们证明门禁真实找到了问题：

1. `33712651823`：全量 Biome 找到 legacy logo preview 的一个 `var` inner declaration error；改为
   block-scoped `const`。
2. `33712822109`：干净 `npm ci` 不会生成 permission package 根 `config.json`，测试误吃本机旧文件；
   测试改为调用生产 serializer 显式生成 policy；packaging topology 断言加入 macOS job。
3. `33713231062`：
   - Windows smoke 用盘符绝对路径做 ESM import，改为 `pathToFileURL`；
   - Linux headless Electron 缺 DISPLAY，改由 `xvfb-run` 执行；
   - macOS `afterPack` 把 worker/runtime 复制到 app bundle 外层，新增平台化 resources resolver，实际复制到
     `AiClient.app/Contents/Resources`。

最终 run 全绿，说明这些不是通过跳过 smoke 隐藏，而是逐项修复后复跑。

## 本地验证

在低资源 Linux 主机串行执行：

```text
node scripts/verify-release-metadata.mjs                                      → pass
YAML.parse(electron-builder.yml, .github/workflows/build.yml)                 → pass
focused Biome                                                               → pass
Vitest: extensionUiBridge + piTuiSession + piMarkdownSplitComparison          → 3 files / 56 tests pass
Vitest: permissionPolicyIntegration + packaging-config                       → 2 files / 30 tests pass
Vitest: packaging-config after packaged fixes                                → 1 file / 24 tests pass
NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck                         → pass
NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host              → pass
node --experimental-strip-types ...t08a-permission-plugin-smoke.ts out-agent-host → permission gate intact
git diff --check                                                             → pass
```

全量测试、全量 lint、application build 与三平台 packaged smoke 的当前证据取自成功 CI run，不沿抄旧数字。

## T37 关闭后的边界

- 正式发布仍须按 `docs/pi-only-rollout-rollback.md` 完成内部观察、限量扩大和 rollback 记录；这些是
  release operation，不再把已经产出的 release candidate roadmap 保持为 In Progress。
- macOS unsigned candidate 不是正式分发物；签名、公证、Gatekeeper 和真实 Mac 安装点验仍是 release condition。
- 两个已知窄问题未伪装成已修：未 materialize 会话空闲淘汰后的 renderer binding、带 `HTTP_PROXY`
  环境的直接 `pnpm dev` localhost 代理。它们没有破坏本批三平台 packaged gate，后续按独立维护切片处理。
- CI 有 Actions 自身 “Node.js 20 action runtime deprecated” warning（`pnpm/action-setup@v4` 等 action 内部 runtime）；
  job 的项目 Node 仍为 24，warning 不影响本次结果，后续依赖升级时处理。
