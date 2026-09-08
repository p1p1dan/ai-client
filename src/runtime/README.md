# `src/runtime/` — 自有 runtime（Cordis 插件图）

ARD：[`docs/plans/2026-09-08-runtime-evolution-ard.md`](../../docs/plans/2026-09-08-runtime-evolution-ard.md) ·
看板：[`docs/plantree/plans/runtime-evolution/README.md`](../../docs/plantree/plans/runtime-evolution/README.md)

替代 `pi-coding-agent` 整包依赖的自有 runtime。与现有 `src/agent-host/` 并存（ARD §5.1），
后端由 `AICLIENT_RUNTIME_BACKEND` 选择（D8），P4-2 前该开关只被记录、不被消费。

**当前进度：P0（骨架）已落地。** 单轮流式对话跑通，无工具。

## 目录

| 路径 | 内容 |
|---|---|
| `contracts.ts` | P0-3 · 所有 service 契约 + `declare module 'cordis'`；P1–P5 未实现的服务在 `DEFERRED_SERVICES` 里带原因声明 |
| `bootstrap.ts` | P0-2 · Cordis Context 初始化、插件注册、**服务存活断言**、销毁 |
| `flags.ts` | 特性开关（D8 后端开关、目录与 trace 目录） |
| `trace.ts` | 结构化 run trace（工程规范 §2 / §15） |
| `plugins/model-adapter/` | P0-4 · 读 `models.json` + `auth.json`，绑定 pi-ai provider |
| `plugins/agent-loop/` | P0-5 · pi-agent-core `Agent` 驱动单轮流式对话 |
| `smoke/` | P0-6 · 非 UI 运行入口（§1）+ 用例 + 确定性断言（§4） |
| `__tests__/` | 单测，由根 `pnpm test`（vitest）收集 |
| `spikes/` | 一次性探针，不参与 typecheck |

## 独立 npm 包

和 `src/agent-host/` 一样，本目录自带 `package.json` / `package-lock.json` / `node_modules`，
pin 三个依赖：`cordis@4.0.0-rc.9`、`@earendil-works/pi-agent-core@0.84.4`、`@earendil-works/pi-ai@0.84.4`。

pi 两个包 pin 在 **0.84.4**。P2-0 实测旧 `pi-coding-agent` 从自身嵌套依赖加载的是
**0.84.3**。按 [ARD D12](../../docs/plans/2026-09-08-runtime-evolution-ard.md) 不回退对齐，
这个 patch 差在 P2-6 对比结论里记为已知偏差；检查版本时要看嵌套依赖，不能只看顶层。

```bash
cd src/runtime && npm ci --omit=optional
```

根 `tsconfig.json` 排除了 `src/runtime/**`，独立门禁是 `pnpm typecheck:runtime`。

**在 worktree 里跑根门禁（vitest / biome / tsc）而不重装一份根依赖**：把主 checkout 的
`node_modules` 软链过来即可，用完删掉——`.gitignore` 的 `node_modules/` 只匹配目录，
软链会以 `??` 出现在 `git status` 里，忘了删就会被 `git add -A` 提交进去。

```bash
ln -s /path/to/main-checkout/node_modules node_modules
./node_modules/.bin/vitest run src/runtime
rm node_modules
```

## 跑起来

```bash
# 离线冒烟（无凭据、无网络，CI 门禁跑的就是这条）
pnpm smoke:runtime

# 在线冒烟——真正消解 ARD 风险 R1，需要已登录的安装
node --experimental-strip-types src/runtime/smoke/runOnce.ts \
  --agent-dir ~/.pilab/<profile>/pi-agent \
  --model <provider>/<model-id> \
  --trace-dir /tmp/runtime-traces

# 单测
pnpm test src/runtime
```

两条 lane 的差别写在 `smoke/runOnce.ts` 顶部：离线 lane 用 pi-ai 自带的 `fauxProvider()`
顶替网络，**只证明插件图、流式折叠和 trace 成立，不证明真实 endpoint 会回答**。
这个区分会落进 trace 的 `catalog_source`，事后不会被混淆。

## 环境变量

| 变量 | 作用 |
|---|---|
| `AICLIENT_RUNTIME_BACKEND` | `legacy`（默认）/ `native`。D8：只走环境变量，不进设置页 |
| `AICLIENT_RUNTIME_AGENT_DIR` | 目录覆盖；缺省回落到 `PI_CODING_AGENT_DIR`（Main 已导出） |
| `AICLIENT_RUNTIME_TRACE_DIR` | trace 落盘目录；不设则只留在内存 |

## 给下一个 agent 的三条已知事实

1. **`ctx.plugin()` 会在依赖未满足时照样 settle**——插件停在 `FiberState.PENDING`。
   所以 `bootstrap.ts` 结尾必须断言服务真的存在，`await` 全部注册不等于图跑起来了。
   实测见 `spikes/p0-cordis-semantics.ts`。
2. **provider 失败不抛异常**，pi-agent-core 把它编码进流里，要从最后一条 assistant 消息的
   `stopReason` 读。只 catch 异常的 loop 会把上游 500 报成「成功但输出为空」。
3. **`models.json` 里的 header 值全是 `$NAME` 引用**（`configValidation.ts` 强制），
   展开是我们的活——pi-coding-agent 以前替我们做，D2 摘掉它之后就没人做了。
