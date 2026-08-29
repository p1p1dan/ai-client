# T08-c 切片 1 — 默认权限策略与信任边界

**日期**：2026-08-29
**拍板依据**：[D11](../decisions/011-default-permission-policy.md)（Q9 收口，四条）
**范围**：默认策略 + 项目信任边界。**设置面 GUI 未做**（切片 2）。

## 落地了什么

| D11 条目 | 实现 |
|---|---|
| a 务实档基线 | `src/agent-host/permissionPolicy.mjs` —— read/grep/find/ls allow，write/edit ask，bash 默认 ask + 20 条只读命令白名单，mcp 仅四个发现类 allow，skill ask，顶层 `*` ask |
| b path deny 面 | 同文件的 `PATH_RULES`：`.env` 系列（`.env.example` 排在两条 deny 之后）、`~/.ssh/*`、`*.pem`、`*.key`、`id_rsa*`、`~/.aws/credentials`、`~/<APP_STATE_DIR>/*` |
| c external_directory | `{ "*": "ask" }`，键集合被断言恰好只有 `*`（防有人「顺手」加白名单） |
| d 项目信任分叉 | `PI_PROJECT_TRUST_ENV`（`AICLIENT_PI_TRUST_PROJECT_CONFIG`）：main 按凭据模式注入 `'0'`/`'1'`，Host 的 `projectTrusted()` 读它 |

## 策略文件为什么放在产物里的插件目录

插件读四层，随包默认落在最低一层：

```
随包默认（本批）  <  用户 / 受管 agentDir 配置  <  项目 `.pi/` 配置
```

**实测确认**（`config-loader.ts:313` + `:331-346`）：`<extensionRoot>/config.json`
确实被读，在全局配置之前。这让我们不必碰用户的 `~/.pi` —— 那是他自己 `pi` CLI 的
目录，写它等于顺手改了一个我们不拥有的工具（T08-a 的既有红线）。

**已知代价**：插件把这条路径标为 LEGACY，每次加载经 `ctx.ui.notify` 发一条「移到
…」的警告。今天渲染端丢弃 `notify`（T09 Deferred）所以不可见；T09 落地后会变成一条
让用户去移动只读产物内文件的建议 —— 已在 D11 记为 T09 前置注意事项。

**升级绊线**：smoke 扫描产物内插件自己的 `src/config-loader.ts`，要求它仍调用
`getLegacyExtensionConfigPath(`。插件哪天删掉这条路径，smoke 会红；否则我们的默认
策略会变成静默不生效的死文件，而唯一症状是「怎么什么都开始弹窗了」。

## 施工中被既有护栏抓到的一处

`~/.pilab/*` 直接写字面量，被 `src/shared/__tests__/defaultPaths.test.ts` 的
「`APP_STATE_DIR` 单一来源」扫描拦下 —— 这条护栏是对的：应用状态目录改名时，
这条 deny 会静默停止保护凭据库。

处理没有简单地加白名单了事。`permissionPolicy.mjs` 必须是 `.mjs`（构建脚本要
import 它，`.mjs` 不能 import `.ts`），所以确实无法引用那个常量；于是**两处一起改**：
扫描器按 DISPLAY_TEXT 的既有先例把该文件列名放行（列名本身就是「改名时必须来看一眼」
的强制点），同时在 `permissionPolicy.test.ts` 里改用 `` path[`~/${APP_STATE_DIR}/*`] ``
断言 —— 真正的强制点在这里：改名而漏掉策略文件，这条断言会红。

## 新增测试

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `agent-host/__tests__/permissionPolicy.test.ts` | 18（新） | 三条兜底（`*`/bash/yolo）· path deny 面含顺序断言（`.env.example` 必须排在 deny 之后）· 只读白名单负向正则（无 rm/mv/npm/curl/sudo…）· 每条 allow 必须是 ` *` 形式（否则漏掉裸命令）· mcp 恰好四条 allow · external_directory 键集合恰好 `['*']` · 序列化往返与键序保持 |
| `scripts/__tests__/agent-host-build-lib.test.mjs` | +5 | 写入产物且只写产物 · 插件没进产物时拒绝写 · 缺失/坏 JSON 时 verify 报错 · **四条「一词之差变宽松」变异逐个咬红**（`*`→allow、bash→allow、external_directory→allow、yoloMode→true） |
| `agent-host/__tests__/piRuntimeSessions.test.ts` | +4 | 受管 `'0'` → `projectTrusted:false` · 本机 `'1'` → true · 键缺失 → 保持历史姿态 true · 无法识别的值 → 落安全侧 false |
| `main/services/piModelConfig/__tests__/piHostEnv.test.ts` | 3（新） | 受管发 `'0'` 且带隔离 agentDir · 本机发 `'1'` 且零注入 · 两种模式都必须发该键（缺失是「老 Main」信号，不能与受管答案混淆） |

## 验证

```text
pnpm typecheck                     ✅ 0
pnpm typecheck:agent-host          ✅ 0
pnpm test                          ✅ 264 files / 5305 tests（本批前 262/5275）
pnpm exec biome check src scripts  ✅ 0 error / 0 warning
pnpm build:agent-host              ✅ 394.3MB，策略文件已写入产物
pnpm smoke:permission-plugin       ✅ PERMISSION GATE INTACT（含 shipped policy 与升级绊线两查）
```

smoke 实跑输出：

```text
[t08a] handlers: session_start, resources_discover, session_shutdown, before_agent_start, input, tool_call
[t08a] bash parse: ["git status","rm -rf /tmp/definitely-not-real"]
[t08a] shipped policy: universal=ask bash=ask
[t08a] RESULT: PERMISSION GATE INTACT
```

## 未完成

1. **T08-c 切片 2：设置面 GUI** —— 让用户在应用内查看生效策略、编辑受管 agentDir
   那一层。未开工。
2. **真机验证策略实际生效** —— 「`cat .env` 被直接拒而不是弹窗」「`git status`
   不弹窗而 `git commit` 弹窗」「受管模式下仓库自带 `.pi/` 配置无效」三条都只有
   单测与源码依据，没在真机上跑过。按用户安排，与其余点验一起放到关键节点。
3. **T09 落地时的连带处理** —— legacy 警告届时会变成可见噪音，见上。
