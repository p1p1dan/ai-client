# 区域：可比性与单测门禁（P2-0 / P2-5 / P2-6 / P1-7）

任务：T030（批次 D 审计覆盖补全）· HEAD：`ebc82f16` · 日期：2026-09-15

## 总评

P2-0（旧后端基线）与 P2-5/P2-6（真实缓存命中率与新旧对比）三个节点的**测量结果本身**是扎实的：六场景在同一网关上对 legacy 与 native 各跑了一遍真实回合，`archive.mjs` 把可比性规则收成纯函数并有专门单测，`compare.mjs` 会把所有不可比原因一次列全而不是抓到第一条就停。批次 C 的 T028 已经把 2026-09-14 审计批评者指出的两个硬伤（`compare.mjs` 强制要求一份永远无法再采的 legacy 归档、`RUNTIME_CONFIG_VERSION` 从 P3 起冻结导致新旧证据无法分代）都修掉了，文档（`scripts/runtime-baseline/README.md`）对"旧后端采集器已删、不可能再采"这件事写得清楚且诚实。

但本轮实测发现两类新的、此前从未被任何区域认领过的问题（P1-7、P2-5/P2-6 在 2026-09-14 审计里明确列在"12 类无人认领节点"里，见 cross-and-critic.md 第 72 行）：

1. **P1-7"单测门禁"名不副实**：仓库里唯一会跑 `pnpm test` 的 CI job 只在推送 `v*` 标签或手动 `workflow_dispatch` 时触发，日常提交和 PR 完全不触发任何测试执行；本地 `pre-commit` 钩子只跑 `lint-staged`（纯格式化），没有 `pre-push` 钩子。这不是我的推测——是直接读 `.github/workflows/build.yml` 的 `on:` 块和 `.husky/` 目录得到的事实，且与项目自己的工程规范文档（`docs/agent-project-engineering.md` 「Main regression: ... before every merge」）正面冲突。
2. **P2-0/P2-5/P2-6 的核心公式单测从未进过自动化流水线**：`scripts/runtime-baseline/metrics.test.mjs`（覆盖 D9 缓存命中率公式、usage 去重、工具边界等 5 条断言）放在 `scripts/runtime-baseline/` 目录下，用的是 `node --test`；根 `vitest.config.ts` 的 `include` 只收 `scripts/__tests__/**/*.test.mjs`，这个文件不在里面，`pnpm test` 永远跳过它，CI 的 "Gate 5/7 — test" 步骤也就永远跳过它。它只以"验证命令"的身份活在 README 和 validation.md 里，靠人手动敲命令。

此外还有两条工具链层面的残留：`evidence/p2-5/README.md` 的"复现"命令仍然照抄一条已经被删除的采集器（`run.mjs`，随 P6-5 于 2026-09-13 随旧引擎一起删除）；`collect.mjs` 生成的报告标题硬编码为"P2-0 旧后端正式基线"，不看 `manifest.backend`，如果按 `scripts/runtime-baseline/README.md` 自己文档化的"`--case` 部分重跑 native 场景 + `collect.mjs` 收尾"这条恢复路径走一遍，产出的归档会带着一个写错后端的标题。

## 优点

- `archive.mjs` 把"两份归档是否可比"从散落在 `compare.mjs` 里的一串 `assert`（错一条就看不到下一条）收成纯函数 `comparabilityReport()`，一次把所有不可比原因列全，并配了 `scripts/__tests__/runtime-baseline-archive.test.mjs`（9 组用例，覆盖真实归档、分代冲突、`settingDeviations` 缺失/不一致、干跑拒绝等场景）。
- `RUNTIME_CONFIG_VERSION` 已从 `runtime_p3_complete_v1` 解冻到 `runtime_p6_hardening_v1`（T028），`archiveGeneration()` 对没有这个字段的旧归档明确报"分代不可判"而不是当作相同，避免了审计当初指出的"新旧证据无法区分"问题。
- `compare.mjs --legacy` 与 `--baseline` 两条路径都有清楚的报错文案，说明为什么 legacy 侧再也采不了、该用什么代替（`compare.mjs:49-63`）；`run-native.mjs --dry-run` 把"采集器的全部离线管线"跑了一遍并用与 `compare.mjs` 相同的规则自检产出骨架，这是一处对"可对比"真正有价值的加固。
- P2-5/README.md 对"这次测到的和没测到的"写得很诚实：明确指出 99.97% 这个数字在这个网关上会饱和、没有分辨力，真正有信息量的是系统提示词字节数与逐轮 `cacheWrite`；也坦白报告了一次采集脚本自己的 PATH 配置错误并保留失败记录而不是删掉重来。

## 弱点

- P1-7「单测门禁」这个名字暗示存在某种机械拦截，但实测（`.github/workflows/*.yml` 全部三个文件 + `.husky/`）证明日常开发流程里不存在任何自动执行测试的机制；README 自己的"不代表包后新改动测试已执行"这句话是准确的，但没人验证过它准确到什么程度——这正是本次要补的审。
- `scripts/runtime-baseline/` 下的验证脚本分裂成两套测试运行时（`node --test` 的 `metrics.test.mjs` vs vitest 的 `runtime-baseline-archive.test.mjs`），前者完全在 CI 视野之外，这类"两套测试跑法"的分裂本身就是「可回归」这条工程规范容易失守的地方。
- `collect.mjs` 是站在"只服务 P2-0 legacy 基线"的假设上写的（报告标题、注释都是这个假设），后来被 README 文档化成也服务 native 部分重跑的恢复路径，但代码本身没有跟着这个用途扩展而更新，T028 自己也承认"未被本次干跑整体覆盖"。
- P2-5/README.md 属于"证据快照"性质的文件，本次没有随 T028 的 `run.mjs` 删除同步更新，导致"复现"这一节现在有一条会直接失败的命令，读者按文档操作会撞墙。

## 节点判定

| 节点 | 判定 | 依据 |
|---|---|---|
| P2-0 | complete | 旧后端基线已在引擎退役前完整采集（2026-09-08，六场景 28 次真实调用），证据齐全、不可再采这件事被文档（`archive.mjs` 注释、`scripts/runtime-baseline/README.md`）反复写清楚，且有明确的替代路径（`--baseline`）。本轮未发现残留缺陷。 |
| P2-5 | complete-with-gaps | 真实网关下 28 次调用全绿、99.97% 达标，口径偏差（网关饱和、缓存温度、系统提示词字节差）交代得很完整。残留：`baseline-03`（复现命令引用已删除脚本，低）、`baseline-02`（支撑这个数字的核心公式单测不在自动化流水线里，中）。两条都不影响已发布结论本身的正确性，但影响"这个结论以后还能不能被机械复核"。 |
| P2-6 | complete-with-gaps | 对比方法论扎实：`archive.mjs` 强制套件版本/哈希/网关/工作目录/模型/settingDeviations 全部一致才出报告，`comparison.md` 本身没有发现问题。残留：`baseline-04`（`collect.mjs` 报告标题不看 backend，若走 README 文档化的 native 部分重跑恢复路径会产出误导性证据来源标注），且该恢复路径本身从未被端到端跑过一次（批次 C 自己的记录）。 |
| P1-7 | incomplete | 这是 2026-09-14 审计的 12 个未认领节点之一，本轮是首次实测评估。结论：`README.md` 里"✅ 历史实现门禁；不代表包后新改动测试已执行"这句话不是保守措辞，而是字面事实——`baseline-01` 证实日常提交/PR 完全没有自动测试执行，`pre-commit` 只 lint；`baseline-02` 证实即使是 tag 触发的那条"门"，也漏掉了 P2-0/P2-5/P2-6 自己的公式单测。"单测门禁"这个词描述的是"仓库里存在会在某个时刻被跑一次的测试"，不是"新改动会被机械拦截"。 |

## 发现

[baseline-01] medium contract-gap | P1-7 | .github/workflows/build.yml:3-7 | 测试执行只挂在 tag 推送/手动 dispatch 上，日常提交与 PR 完全不触发任何自动化测试

DESC: `.github/workflows/build.yml` 是仓库里唯一会跑 `pnpm test`（vitest）、`pnpm typecheck*`、`pnpm lint`、`pnpm smoke:*`、`pnpm verify:packaged`（间接经 `build-windows`/`build-linux`/`build-macos` job）的工作流；它的触发条件是 `push: tags: ['v*']` 与 `workflow_dispatch`。仓库另外两个工作流——`code-review.yml`（`pull_request_target`）与 `claude.yml`（评论里 @claude 触发）——都是调用 Claude Code 做 LLM 阅读式代码审查，不执行任何测试命令。本地钩子只有 `.husky/pre-commit`（内容为 `pnpm exec lint-staged`，对应 `package.json` 里 `lint-staged` 字段只跑 `biome check --write`），没有 `.husky/pre-push` 或等价物。三者叠加的结果是：一次日常提交、一次 PR 打开/更新、一次合并进 `main`，都不会有任何机器自动跑一遍测试套件；唯一会跑测试的时刻是有人推送 `v*` 标签（走完整发版流程）或手动点 `workflow_dispatch`。

EVIDENCE:
```yaml
# .github/workflows/build.yml:3-7
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
```
```
# .husky/pre-commit（全文件内容）
pnpm exec lint-staged
```
```json
// package.json:121-125
"lint-staged": {
  "*.{js,ts,jsx,tsx,json,css}": [
    "biome check --write --no-errors-on-unmatched"
  ]
}
```
对照项目自己的工程规范：
```
# docs/agent-project-engineering.md:102-105
- **Rule:** split cases into three tiers —
  - **Smoke:** 10–20 most-core cases, runs in minutes, after every commit.
  - **Main regression:** covers main functional paths, daily / before every merge.
```

SCENARIO: 一名开发者（人类或代理）在 `feat/runtime-evolution` 或任何非 `main` 分支上做了一处改动，跑完本地 `git commit`（`pre-commit` 只格式化，不测试）后直接 `git push`；即使这个改动让 `pnpm test` 里某条既有用例变红，也不会有任何 GitHub 状态检查显示失败——`build.yml` 根本不会被触发。等到几周后有人推 `v1.2.3` 标签准备发版，`gate` job 才第一次跑测试，此时可能已经在这条坏改动之上叠了几十个提交，定位成本远高于"提交即测"。这正是 `docs/plantree/plans/runtime-evolution/README.md` P1-7 行那句"不代表包后新改动测试已执行"字面所指的风险，只是此前没人把机制核实到这个颗粒度。

FIX: 给 `build.yml` 的 `gate` job（或拆出一个更轻量的新 job，跳过耗时的 Electron 打包步骤）补一个 `pull_request` 触发（至少覆盖 `main` 分支的 PR），让 typecheck/lint/test/smoke 四道门在合并前机械执行；如果出于跑分钟数/并发成本考虑不想对每个 PR 都跑完整矩阵，至少应在仓库 README 或 P1-7 证据里把"目前只有 tag/手动两种触发方式"写成一条明确的已知限制，而不是让"✅ 历史实现门禁"这个措辞被误读成"有门禁"。

---

[baseline-02] medium test-gap | P2-5 / P2-6 / P1-7 | vitest.config.ts:13、scripts/runtime-baseline/metrics.test.mjs:1 | 支撑 D9 缓存命中率公式的单测被排除在 vitest / CI 之外

DESC: 根 `vitest.config.ts` 的 `test.include` 只收 `['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']`。`scripts/runtime-baseline/metrics.test.mjs`（5 条用例：usage 统计、重复累计、缺失 usage、工具边界、edit 数组）物理上放在 `scripts/runtime-baseline/` 目录下，不在 `scripts/__tests__/` 里，不匹配这条 include glob；它用的是 `node --test`，不是 vitest 的 `describe/it`。结果是：`pnpm test`（本地和 `build.yml` 的 "Gate 5/7 — test" 步骤都调用它）永远不会执行这 5 条用例。它们只在 `scripts/runtime-baseline/README.md`、`docs/plantree/plans/runtime-evolution/evidence/p2-0/validation.md` 的"验证命令"清单里以手动 `node --test --test-concurrency=1 scripts/runtime-baseline/metrics.test.mjs` 的形式存在。

EVIDENCE:
```ts
// vitest.config.ts:13
include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs'],
```
```
$ find scripts/runtime-baseline -name '*.test.mjs'
scripts/runtime-baseline/metrics.test.mjs   # 不匹配 scripts/__tests__/**
```
`.github/workflows/build.yml` 的 "Gate 5/7 — test" 步骤只有一行 `run: pnpm test`，没有任何单独调用 `node --test scripts/runtime-baseline/metrics.test.mjs` 的步骤。

SCENARIO: 有人改动 `scripts/runtime-baseline/metrics.mjs`（比如调整 `summarizeUsage` 的累计口径或 `deriveCacheHitRate` 的分母公式），改出一个能让 5 条用例里任意一条变红的 bug。`pnpm test` 全绿通过（这个文件根本没跑），`build.yml` 的 tag 触发流水线也全绿通过（同样没跑）。这个 bug 会一路带到下一次 P2-5/P2-6 真实网关采集，因为 `run-native.mjs`/`verify.mjs`/`compare.mjs` 都 import 了同一个 `metrics.mjs`，产出的命中率数字本身就是错的，而且没有任何自动化信号能提前拦住它——只能靠人记得手动敲那条 `node --test` 命令。这正击中 P2-0 计划文档自己写的验收条件："脚本存在、mock 通过、参考仓测试通过均不等于 P2-0 完成"——但反过来说，"P2-0/P2-5/P2-6 完成" 这个状态目前也没有被这份单测持续守护。

FIX: 两选一——① 把 `metrics.test.mjs` 迁移到 vitest（改用 `describe/it` 语法，移到 `scripts/__tests__/` 或把 include glob 扩到 `scripts/runtime-baseline/**/*.test.mjs`），让它进入 `pnpm test`；② 如果要保留 `node --test` 运行时（比如为了不依赖 vitest 的 `--experimental-strip-types` 行为），在 `build.yml` 的 gate job 里单独加一步 `node --test --test-concurrency=1 scripts/runtime-baseline/metrics.test.mjs`。无论哪种，都要同时解决 baseline-01（先让 gate job 本身在日常提交上跑起来），否则加了也是摆设。

---

[baseline-03] low docs | P2-5 / P2-6 | docs/plantree/plans/runtime-evolution/evidence/p2-5/README.md:121 | 「复现」小节的命令引用了已删除的采集器 run.mjs

DESC: `evidence/p2-5/README.md`"复现"一节给出的"旧后端同网关重采"命令是 `node scripts/runtime-baseline/run.mjs --sdk-host src/agent-host ...`。`run.mjs` 已经随 P6-5 旧引擎退役在提交 `fe246bd6`（2026-09-13）一起删除，`scripts/runtime-baseline/README.md` 自己在同一目录下用波浪线划掉了这个脚本并写明"已随 P6-5 删除...无法再跑第二遍"。`evidence/p2-5/README.md` 最后一次改动是 `07f9152e`（2026-09-12，早于删除），此后没有随之更新。

EVIDENCE:
```
# docs/plantree/plans/runtime-evolution/evidence/p2-5/README.md:119-122
# 旧后端同网关重采
P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run.mjs \
  --sdk-host src/agent-host --base-url http://107.173.157.208:23000 --out <新目录>
```
对照：
```
# scripts/runtime-baseline/README.md（当前版本）
| ~~`run.mjs`~~ | **已随 P6-5 删除**：旧后端采集器，而旧后端 2026-09-13 退役...**无法再跑第二遍** |
```
`git log --oneline --follow -- scripts/runtime-baseline/run.mjs` 显示该文件最后一次改动即为删除提交 `fe246bd6`。

SCENARIO: 下一个接手 P2-6 复核或想验证这套证据可复现性的人（人类或代理），按 `evidence/p2-5/README.md` 的"复现"小节从头抄命令，抄到第二条就会拿到 `Error: Cannot find module .../scripts/runtime-baseline/run.mjs`，需要额外去翻 `scripts/runtime-baseline/README.md` 才能明白"这条命令永远跑不通，legacy 侧只能读已存归档"这件事——文档本身没有主动告知。

FIX: 在 `evidence/p2-5/README.md` 的这条命令前后补一句与 `scripts/runtime-baseline/README.md` 一致的说明（"`run.mjs` 已随 P6-5 删除，此命令仅作 2026-09-12 采集时的原始记录，无法再执行；如需新对比请改用 `--baseline` 对已有 native 归档重采"），或者直接把这条命令改写成"历史记录（不可再执行）"的引用块，避免读者当作可执行指令逐字尝试。

---

[baseline-04] medium correctness | P2-6 | scripts/runtime-baseline/collect.mjs:143 | 收集脚本产出的报告标题硬编码为旧后端，不看归档的实际 backend 字段

DESC: `collect.mjs` 生成 `report.md` 时，标题行写死为 `# P2-0 旧后端正式基线`，完全不读它自己刚从 `reference.backend` 取出的值。这个脚本最初确实只服务过 legacy（P2-0）采集，但 `scripts/runtime-baseline/README.md` 后来把它文档化成也用来收尾 `run-native.mjs --case B04` 这类"网关不稳定时逐场景重跑"的**native**恢复路径（README 原文："下面的采集流程只适用于 `run-native.mjs`...六场景齐备后收集：`node scripts/runtime-baseline/collect.mjs ...`"）。批次 C（T028）的落地记录也明确写"`collect.mjs` 未被本次干跑整体覆盖（只加了一行 `dryRun` 过滤，未整体验证）"——也就是说这条路径连一次真实跑通都没有，标题这个具体 bug 自然也没被人碰过。

EVIDENCE:
```js
// scripts/runtime-baseline/collect.mjs:140-155
const rate = (value) => `${(value * 100).toFixed(2)}%`;
writeFileSync(
  join(out, 'report.md'),
  `# P2-0 旧后端正式基线\n\n六个独立固定会话已通过原始 JSONL 和 trace 复核。模型：${suite.model.id}；suite：${suite.version}。\n\n` +
  ...
```
`comparable()`（同文件 18-30 行）本身已经在读 `manifest.backend`，说明脚本内部完全拿得到这个值，只是没有用它去决定标题文案。
批次 C 记录原文：
```
docs/plantree/plans/runtime-hardening/evidence/batch-c-2026-09-15.md:66-67
| `scripts/runtime-baseline/preflight.mjs` 无离线形态... | 记录，不做 |
| `scripts/runtime-baseline/collect.mjs` 未被本次干跑整体覆盖（只加了一行 `dryRun` 过滤） | 记录，不做 |
```

SCENARIO: 网关在一次 native 六场景采集中途断线（`evidence/p2-5/README.md` 的"失败记录"一节已经证明这种事真实发生过，B03 就撞过一次 PATH 配置错误），操作者照 README 文档化的路径用 `--case B04` 补采失败场景到新目录，再跑 `collect.mjs docs/.../evidence/p2-0 docs/.../evidence/p2-0/NEW_ID` 收尾。`reference.manifest.backend` 会是 `'native'`（因为 `reference` 取的是"当前 suite 版本"里最早那条匹配记录，这次采集全是 native），但 `report.md` 顶部仍然印着"P2-0 旧后端正式基线"。如果这份 `report.md`（而不是 `manifest.json` 里准确的 `backend` 字段）被当成给人看的证据摘要转手，会让后续读者误判这批数据的来源引擎，而这份工具链存在的全部意义就是保证"可对比"链路上的出处不被搞混。

FIX: 把标题改成读 `reference.backend`（`comparable()` 已经取过这个值，直接复用），例如 `` `# ${reference.backend === 'legacy' ? 'P2-0 旧后端' : 'P2-5 自有 runtime'} 正式基线` ``；顺带把 `collect.mjs` 头部注释（如果有类似"only for legacy"的假设性描述）与 `scripts/runtime-baseline/README.md` 里那条示例命令的目标目录（示例仍写 `evidence/p2-0`，容易被误读成"这条路径只服务 legacy"）一并核对更新。补一条真实网关下的端到端验证，履行批次 C 记录里"记录，不做"这半句债。

## 测试缺口

- `scripts/runtime-baseline/preflight.mjs` 没有离线形态（本质是探网关），`run-native.mjs --dry-run` 不覆盖它；批次 C 已记录为"接受，不做"，本轮复核未发现新情况。
- `scripts/runtime-baseline/collect.mjs` 的主路径（"从多次 `--case` 部分重跑里挑出各场景首次完整成功记录并汇总"）从未在真实网关下端到端跑通过一次，`baseline-04` 是这个盲区里能靠静态阅读直接定位的一个具体后果；其余逻辑（`isDeepStrictEqual` 比对、`sourceRuns`/`attempts` 记账）是否在真实多次重跑数据上表现正确，仍未知。
- `scripts/__tests__/runtime-baseline-archive.test.mjs` 硬编码了 `docs/plantree/plans/runtime-evolution/evidence/p2-5` 下两份真实归档的路径作为测试夹具（见该文件 58-73 行 `readArchive('.../evidence/p2-5/run-20260912-...')`）；证据目录一旦搬家或改名，这条用例会红，批次 C 已记录、本轮确认现状未变。
- `metrics.test.mjs` 不在 `pnpm test` 范围内（见 `baseline-02`），这本身既是一条发现也是一条测试缺口：D9 公式目前没有任何自动化回归覆盖。

## 未经执行验证的声明

- 无法确认 GitHub 仓库的分支保护规则（`main` 是否要求某条状态检查通过才能合并）——本地只能读工作流定义文件，读不到仓库 Settings；`baseline-01` 的结论仅限于"现有工作流定义在什么事件上触发"，不代表"有没有其它机制间接堵住坏代码"。
- `collect.mjs` 收尾 native 部分重跑这条路径，除了标题 bug 之外是否还有其它未暴露的问题（比如 `comparable()` 用于去重筛选的字段集合是否适配 native 归档的实际字段形状），受限于"不执行脚本"的规则，只做了字段级静态核对，未做实际数据流验证。
- 仓库里没有任何 `run-*` 目录是通过 "`--case` 部分重跑 + `collect.mjs`" 这条路径产出的（`evidence/p2-0` 与 `evidence/p2-5` 下现存的 run 目录都是单次完整六场景跑出来的），无法确认这条路径此前是否被真实用过一次。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| CI 在日常 push/PR 上确实不触发任何测试 job | 向非 tag 分支推送一次提交或开一个测试 PR，GitHub Actions 页面里除 `code-review.yml`/`claude.yml` 外没有任何 workflow run 被创建 | 用有仓库权限的账号实际推送/开 PR 并观察 Actions 列表；或 `gh run list --branch <分支>` | dev-box |
| `run-native.mjs --case` 部分重跑 + `collect.mjs` 收尾这条恢复路径端到端可用 | 真实网关下故意只跑 1-2 个 `--case`，用不同目录跑另外几个，最后 `collect.mjs` 收尾产出的 `summary.json`/`report.md` 字段正确、标题反映真实 backend | 需要 `P20_BASELINE_API_KEY` 与可用网关，实跑一次并人工核对产物 | real-model |
| `archive.mjs` 的分代拒绝逻辑在两次真实 native 采集（跨越一次 `RUNTIME_CONFIG_VERSION` 升级）之间确实产出"不可比"而不是误判为可比 | 在升级 `RUNTIME_CONFIG_VERSION` 前后各真实采集一次，`compare.mjs --baseline <升级前> --native <升级后>` 必须在 `failures` 里报 "behaviour generation differs"，而不是被单测里模拟的 manifest 掩盖真实字段形状差异 | 需要两次真实网关采集，跨一次代码升级 | real-model |

## 读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（GAP 第 72、73 行及其上下文）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段全文）
- docs/plantree/plans/runtime-hardening/evidence/batch-c-2026-09-15.md（T028 逐波记录、转移表）
- docs/plantree/plans/runtime-evolution/README.md（P1-7、P2-0、P2-5、P2-6 行及上下文）
- docs/plantree/plans/runtime-evolution/topics/p2-0-cache-baseline.md
- docs/plantree/plans/runtime-evolution/evidence/p2-0/validation.md
- docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908/manifest.json
- docs/plantree/plans/runtime-evolution/evidence/p2-5/README.md
- docs/plantree/plans/runtime-evolution/evidence/p2-5/comparison.md
- docs/plantree/plans/runtime-evolution/evidence/p2-5/run-20260912-legacy-01/manifest.json
- docs/plantree/plans/runtime-evolution/evidence/p2-5/run-20260912-native-01/manifest.json
- docs/plantree/plans/runtime-evolution/evidence/p2-5/run-20260912-native-02/manifest.json
- scripts/runtime-baseline/README.md
- scripts/runtime-baseline/archive.mjs
- scripts/runtime-baseline/compare.mjs
- scripts/runtime-baseline/collect.mjs
- scripts/runtime-baseline/run-native.mjs
- scripts/runtime-baseline/preflight.mjs
- scripts/__tests__/runtime-baseline-archive.test.mjs（结构核对，未执行）
- docs/agent-project-engineering.md（Group D「7. Build a layered regression set」）
- package.json（scripts、lint-staged 字段）
- .github/workflows/build.yml
- .github/workflows/code-review.yml
- .github/workflows/claude.yml
- .husky/pre-commit、.husky/ 目录结构
- vitest.config.ts
- scripts/verify-packaged-app.mjs（backend 相关片段，核对 T009 已修状态）
- git log/show：fe246bd6（run.mjs 删除提交）、a11ccbe0（T028 提交，--stat）、07f9152e（p2-5/README.md 最后改动）
