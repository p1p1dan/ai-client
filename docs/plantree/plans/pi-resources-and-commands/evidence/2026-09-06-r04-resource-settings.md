# Evidence — R04 提示词模板安装入口

**日期**：2026-09-06
**关闭**：roadmap `R04`
**上游决定**：[D01](../decisions/001-borrow-user-pi-resources-not-symlink.md)

## 一、落地形态

设置新增 **Resources / 资源** 页，但没有恢复 pix 式的一级「资源」导航；
既有 [Q03](../../pix-ui-alignment/open-questions.md) 的侧栏 IA 决定保持不变。

页面说明三个安装位置：

1. `~/.agents/skills/`：技能推荐位，跨 Agent，共享且不受托管/本机模式影响。
2. 用户 Pi agent dir（默认 `~/.pi/agent/`，也尊重 `PI_CODING_AGENT_DIR`）：
   本机模式的 GUI/TUI 直接读取；托管 GUI 可通过 R01 的借用开关只读技能与模板。
3. 本应用的 managed Pi agent dir（实际路径由 Main 的 profile resolver 给出）：
   托管 GUI/TUI 读取；不在 renderer 硬编码 `~/.pilab`。

「打开模板目录」只出现一次，并打开**当前凭据模式真实使用的** `<agentDir>/prompts`：
托管模式打开 managed prompts，本机模式打开用户 prompts。目录不存在时 Main 先递归创建，
再调用 Electron `shell.openPath`。

R01 的 `borrowUserPiResources` 开关也在本页补齐。它经专用 IPC 写 Main-owned setting，
避免 renderer 的整对象设置保存把它回滚；托管模式下变更会 `workerManager.invalidateAll()`，
使进程级资源路径立即生效。本机模式已经直接读取用户目录，不重启 worker。

## 二、代码边界

| 层 | 落地 |
|---|---|
| shared | `PiResourceSettings` / update request；3 条窄 IPC channel |
| Main path authority | `getPiResourceSettings()` 与 `getActivePiPromptTemplatesDir()` 复用既有 managed/local resolver |
| Main IPC | `src/main/ipc/piResources.ts`：读设置、更新借用、创建并打开当前模板目录 |
| settings ownership | `PI_BORROW_USER_RESOURCES_SETTING_KEY` 加入 `MAIN_OWNED_SETTING_KEYS` |
| preload | `electronAPI.piResources.{getSettings,updateSettings,openPromptTemplates}` |
| renderer | `PiResourcesSettings.tsx` + `piResources` 设置分类 + 中英词条 |

## 三、门禁

| 项 | 结果 |
|---|---|
| 相关 Vitest（5 文件） | **5 files / 29 tests pass** |
| 恢复变异后的 IPC 复跑 | **1 file / 7 tests pass** |
| `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck` | pass |
| `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host` | pass |
| `pnpm exec biome check src/` | **971 files clean** |
| `git diff --check` | pass |

相关测试文件：

- `src/main/ipc/__tests__/piResources.test.ts`
- `src/main/ipc/__tests__/settingsMainOwnedKeys.test.ts`
- `src/main/services/piModelConfig/__tests__/piWorkerEnv.test.ts`
- `src/renderer/components/settings/__tests__/settingsCategories.test.ts`
- `src/renderer/components/settings/__tests__/piResourcesSettingsStatic.test.ts`

当前主机仅约 3.3 GiB RAM，按仓库资源约束没有一次性运行全量 Vitest；本片覆盖 Main path/IPC、
设置 ownership、preload/renderer 静态接线与两套 typecheck。

## 四、变异验证

临时把 `piResources.ts` 的

```ts
const error = await shell.openPath(promptTemplatesDir);
```

替换成不调用 `shell.openPath` 的空结果，focused IPC suite 立即变为：

```text
3 failed | 4 passed
```

判红项分别是：managed 路径未打开、local 路径未打开、OS 打开失败未向 renderer 抛出。
恢复源码后 `7 passed`。

## 五、GUI 点验

用文档化入口 `node scripts/dev.js` + CDP 启动真 Electron 窗口，进入设置 → 资源：

- 三张卡均出现：共享技能 / 个人 Pi 目录 / 本应用托管的 Pi 目录；
- 推荐位显示为 `/home/ai/.agents/skills`；
- 页面展示的是 Main 返回的真实 profile/custom agentDir 路径，不是 renderer 拼出的字面量；
- 借用开关存在；
- 当前为本机模式时，「打开模板目录」位于个人 Pi 卡片，且只出现一次。

截图：[resources-settings.png](./r04-screenshots/resources-settings.png)。
进程在点验后清理，未留下 dev/vite/Electron/worker 进程。

## 六、剩余边界

- R04 不解决 [Q-R4](../open-questions.md)：托管模式下 R01 的「借用用户目录」仍只对 GUI 生效；
  TUI 只读 managed agent dir。页面已明确说明该差异。
- `pi-workspace-history` 的 peer 版本冲突仍见 [Q-R5](../open-questions.md)，与 R04 无关。
