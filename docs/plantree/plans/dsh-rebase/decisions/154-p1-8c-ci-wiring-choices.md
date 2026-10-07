# 决策 154：P1-8c 接 CI 的取舍——dsh-bridge-gate.yml 加防空转冒烟、争用回归硬门槛、插件审查守卫

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [决策 065](065-loop-guard-host-plugin.md)、[066](066-step-limit-500-per-agent.md)、[081](081-loop-guard-implementation-choices.md)（防空转插件的设计与实现，已批准）；
- [决策 067](067-contention-regression-gates.md) 第 5 条（CI 与 P1-4e 共用 `dsh-bridge-gate.yml`，推分支前要用户确认，已批准）；
- [决策 100](100-p1-4e-gate-kept-scenarios-follow-rescope.md)、[133](133-p1-4e-gate-ci-choices.md)（`dsh-bridge-gate.yml` 的由来、现有步骤与超时估算写法）；
- [决策 153](153-e8-a-plugin-review-guard-choices.md) 第 7 节（插件审查守卫要不要进 CI，留给用户定）；
- [P1-8/P1-11 方案分片 05](../topics/p1-8-p1-11-guards-and-terminal/05-regression-tests-changes.md) §4、§5；
- [pre-p1-14-remaining 第 5 步](../topics/pre-p1-14-remaining-2026-10-07.md)（派工原文：「P1-8c 接 CI：`dsh-bridge-gate.yml` 加 loop-guard-smoke 与 LC-0～2 硬门槛…只写工作流，随下一次推送生效」）；
- 代码：`src/dsh-host/tools/loop-guard-smoke.ts`、`src/dsh-host/tools/contention-regression.ts`、`.github/workflows/dsh-bridge-gate.yml`。

提交：①`9748ddef`（防空转冒烟与争用回归）；②`42dddf81`（插件审查守卫，E8-A，待审批）。**不推送**。

## 1 结论先行

1. 两份回归脚本（`loop-guard-smoke.ts`、`contention-regression.ts`）在动工前就已经各自正确区分了「硬门槛决定退出码」与「软门槛只告警」，不需要加开关，也不需要补单测——这条和派工单里「如果脚本没有这个开关就加一个」的预设不一样，属于现场核实后的偏离，原因见 §2。
2. `loop-guard-smoke.ts` 的全部判定都是硬门槛（决策 065 没有给它定软门槛），工作流直接读它的退出码。
3. `contention-regression.ts` 已经把 LC-0～LC-2 的硬门槛（决定退出码）和软门槛（只进 `report.softWarnings`，从不影响退出码）分开，新增一步把软门槛警告写进 job summary，不写进任何会改变 job 结局的地方。
4. 两步失败时都把 `--out` 产生的报告 JSON 作为 artifact 上传，写法照搬现有 `DSH bridge recording (--check)` 步骤的 `--artifacts` 上传。
5. 插件审查守卫（E8-A，决策 153）单独一个提交加进同一个工作流，决策 153 第 7 节写明「要不要加由用户定」，用户还没回复，所以拆开方便撤回这一步而不影响防空转与争用回归两步。
6. **本次没有改 `build.yml`**：决策 067 第 5 条只要求与 P1-4e 共用 `dsh-bridge-gate.yml`，没有要求 `build.yml` 的 gate 也跑这两个回归；`build.yml` 的 gate 只在推 `v*` tag 或手动触发时跑，P1-8/P1-11 分片 05 §5 原文也写「不挂在那里」。没有发现决策 067 或其他已批准决策要求改 `build.yml`，因此没有停下来问，按原计划只改 `dsh-bridge-gate.yml`。

## 2 脚本已有「硬/软分离」的实测核实

现场读代码确认（而不是假设）：

- `loop-guard-smoke.ts`：`verdictOf()` 产出一组布尔值（G1～G7、E1～E6 共 31 项），`main()` 最后 `return failed.length === 0 && !['a','b','c'].some(k => report[k]?.error) ? 0 : 1`——任何一项不通过或任一宿主出错都退出 1。没有软门槛的概念，不需要分离。
- `contention-regression.ts`：`judge()` 对每个场景分别产出 `hard`（布尔映射）与 `softWarnings`（字符串数组）；`main()` 汇总 `hardFailures` 与 `softWarnings` 两个数组，最终 `return hardFailures.length === 0 && errors.length === 0 ? 0 : 1`——`softWarnings` 从未参与这个判断。这与决策 067 第 2、3 条（硬门槛决定红绿、软门槛只告警）完全一致。

结论：两份脚本在 P1-8 实现阶段（提交 `72330d1b`，已批准的决策 081）就已经按决策 067/065 的口径写好，CI 接线只是「调用并读结果」，不涉及脚本改动。

## 3 硬门槛 / 软门槛清单（决策 067、分片 05 §4 原文）

| 场景 | 硬门槛（失败即红） | 软门槛（只告警） |
|---|---|---|
| G1～G7、E1～E6（`loop-guard-smoke.ts`） | 全部 31 项判定 | 无 |
| LC-0 | ELD ≤ 50 ms；RSS ≤ 300 MB | ELD ≤ 10 ms；RSS ≤ 230 MB |
| LC-1 | ELD ≤ 150 ms；RSS ≤ 350 MB；8×200 条delta 各自到对的频道；全部回合 completed | ELD ≤ 60 ms；RSS ≤ 260 MB |
| LC-2 | ELD ≤ 1000 ms；RSS ≤ 600 MB；没有宿主报错；受害者 ≥60 条delta 带时间戳；5 个回合全部 completed；受害者最大 delta 间隔 ≤ ELD + 150 ms；全部 ping 都收到 pong；没有 pong 往返超过 2000 ms | ELD ≤ 450 ms；RSS ≤ 450 MB |
| LC-3、LC-4 | 脚本未实现，按决策 067 第 4 条只手动跑；本次不接 CI | — |

软门槛呈现方式：新增步骤「Contention regression soft-gate summary」读 `report.softWarnings`，写进 `$GITHUB_STEP_SUMMARY`（GitHub Actions 的 job summary，Markdown 渲染），没有软门槛时也写一行「没有告警」；这一步不设置失败条件，`!cancelled()` 保证即使前面硬门槛步骤红了也照常跑，把软门槛数据一起摆出来给人看。

## 4 CI 接线细节

- `Loop guard smoke (G1-G7, E1-E6)`：`out-node-runtime/node src/dsh-host/tools/loop-guard-smoke.ts --out "$RUNNER_TEMP/dsh-loop-guard-smoke/report.json"`；失败时上传该目录。
- `Contention regression (LC-0..LC-2)`：同样用随包 node 跑 `contention-regression.ts`（不传 `--only`，默认同时跑 LC-0/LC-1/LC-2，`--runs` 默认 1）；失败时上传该目录。
- 两步都放在 `Replay and projection suites` 之后、`Upload the recording on failure` 之前；都用 `if: ${{ !cancelled() && steps.node.outcome == 'success' }}`，与现有 `Replay and projection suites` 步骤同一写法——即便前面的录制门禁或 typecheck 红了，只要随包 node 取到了，这两步依然跑，一次 CI 多给一些独立信号。
- `Plugin review guard (E8-A)`：放在 `Install dsh-host dependencies` 之后、`Cache bundled Node runtime` 之前，跑在 CI 默认的 Node 24 上（不需要随包 node），因为它只是根 vitest 读 `src/dsh-host/node_modules` 里的源码，不需要起宿主。

### 为什么选 `--runs 1`（不是分片 05 规划阶段写的「跑 3 次」）

- 分片 05 §4 是 P1-8 立项阶段（2026-09-27）的构想，当时脚本还没写出来；实现后的 `contention-regression.ts` 把「跑几次」做成 `--runs` 参数，硬门槛取「每次跑的最大值都要达标」（`every`），软门槛取中位数——`--runs 1` 时软门槛中位数就是那一次的值，硬门槛语义不变。
- 本机实测单次 LC-0～LC-2 合计约 70 秒；3 次会接近 3.5 分钟，加上两个宿主反复起停的内存压力（LC-2 一次要跑 6 个宿主：1 个 seed、5 次 `startHost`），在开发机上风险更高，CI runner 规格也未核实（分片 05 §5 原话：「runner 规格没有核实…软门槛前 5 次只记录」）。
- 取 `--runs 1` 先用最省的方式把硬门槛接进去，和决策 067 本身「软门槛前 5 次只记录，之后收紧」的渐进式口径一致：先观察几次绿跑，再决定是否要 `--runs 3`。这一条本身是本次新增的取舍，**待审批**（见 §7）。

## 5 本机实测（2 核开发机，`free -m` 确认可用内存 2003～2018 MB，均 > 800 MB 门槛，一次只跑一条）

| 命令 | 耗时 | 结果 |
|---|---|---|
| `loop-guard-smoke.ts --out …`（全部 host A/B/C） | 55.8 s | 31 项全过，`failed: []` |
| `contention-regression.ts --out …`（LC-0+LC-1+LC-2，`--runs 1`，默认） | 69.5 s | LC-0/LC-1 全过；LC-2 的「受害者最大 delta 间隔 ≤ ELD + 150 ms」**失败**（249.6 ms vs 门槛 221.4 ms = ELD 71.4 ms + 150）；另有 LC-1 的 RSS 软告警（279.3 MB > 软门槛 260 MB） |
| `contention-regression.ts --only LC-2 --out …`（复跑） | 38.0 s | LC-2 全过（ELD 39.7 ms，gap 158 ms < 189.7 ms） |
| `pnpm exec vitest run scripts/__tests__/dsh-plugin-review-guard.test.mjs` | 1.25 s（测试本身 99 ms） | 20 例全过 |
| `pnpm exec vitest run scripts/__tests__/packaging-config.test.mjs`（核对工作流没破坏现有结构守卫） | 0.57 s | 53 例全过 |

**LC-2 的那次临界失败是本次实测里唯一一次「硬门槛判定与预期不一致」的结果**，记在 §7「首跑后要看的事项」，不是本次改动引入的新问题——脚本与门槛数值都是已批准决策（067、081）落地时定的，CI 接线没有改动任何判据。

## 6 超时估算

沿用 `dsh-bridge-gate.yml` 现有写法（整数分钟、留足安全边际、写明怎么算的）：

- **Job 级**：原来 30 分钟（决策 133：push 路径约 5 分钟冷启动 ×3 取整到 20，再加 10 分钟给手动 smoke 的 15 分钟步骤级上限留余量）。本次 push 路径新增两步实测合计 56 + 70 = 126 s ≈ 2.1 分钟，原估算的「installs/typecheck/recording/两套测试」部分仍按约 5 分钟估计（本次没有重新测，不在本次改动范围）：新 push 路径原始耗时 ≈ 5 + 2.1 ≈ 7.1 分钟，×3 取整到 10 的倍数 = 30；再加 10 分钟给手动 smoke 留余量（沿用决策 133 的加法），合计 **40 分钟**。
- **步骤级**：`Loop guard smoke` 给 8 分钟（实测 56 s，倍数级留白，与现有 `DSH bridge recording (--check)` 步骤给 51 s 实测配 8 分钟同一尺度）；`Contention regression` 给 15 分钟（实测 70 s，但它一次起停最多 6 个宿主、还要合成/转换/落盘长会话种子数据，比录制检查更重，给更大的余量）；`Plugin review guard` 给 3 分钟（实测约 1.3 s，纯 vitest，几乎不会挂住，给一个保守但不浪费的小上限）。
- 这些都是估算，不是精确公式的产物（`DSH bridge recording` 的 8 分钟本身也不是严格的「×3 取整到 10」，是「给一个显眼的安全边际，宿主卡住时这一步自己先红，不拖累整个 job」的经验判断，本次两个新步骤延续同一判断方式）。**首次 CI 跑绿之后应按实测重算**，这与决策 133 的说法一致。

## 7 首次 CI 跑之后要回看的事项

1. **LC-2 受害者延迟门槛的临界失败**（本机实测复现过一次，详见 §5）。如果 CI 首跑也出现同样的临界失败（而不是明显的大幅超标），优先怀疑 `ubuntu-latest` 的 runner 噪声特征与本机不同（2 核开发机本身跑着其他会话/进程，CI 更干净但也可能共享底层主机），不要立刻改门槛数值；按分片 05 §4「超门槛时按这个顺序查」处理：先比对 DSH 升级有没有让拼请求变慢，再看压缩，最后才考虑挪宿主。
2. **`--runs 1` 是否够**：决策正文 §4 的取舍是本次新增判断，待审批；如果用户希望更保守（例如 `--runs 3` 以更稳地取「最大值」作硬门槛），需要重新估算耗时与超时（3 倍粗略估算：push 路径原始耗时会从约 7.1 分钟涨到约 11.1 分钟，×3 取整到 40，job 级可能要从 40 调到 50）。
3. **是否要把插件审查守卫（commit `42dddf81`）保留**：取决于用户对决策 153 第 7 节、本决策 §1 第 5 条的回复；不批准就单独回退这一个提交，不影响另外两步。
4. **job summary 的可读性**：本次只用最简单的 Markdown 列表呈现软门槛警告，没有历史趋势（例如「软门槛前 5 次只记录」提到的「跑满 5 次后收紧」，需要人工翻看多次 CI 运行的 summary 自己汇总，没有自动聚合）。如果用户觉得这样不够用，需要另外的存档/趋势方案，不在本次范围内。
5. **工作流语法只用 `js-yaml` 解析校验过**（`node -e` 加载 `yaml.load`，确认能解析、结构符合预期），没有用 `actionlint`，也没有实际提交到 GitHub Actions 跑过，首次真跑之前这是唯一的本机校验方式。

## 8 取舍

- **不给两份脚本加「只按硬门槛退出」的开关**：现场核实后发现它们已经是这样写的，加开关是无意义的重复代码，原派工单的「如果没有就加」是以防万一的预设，不是既定结论——本决策记录这个偏离及其理由（§2），不再额外问用户。
- **不改 `build.yml`**：没找到要求它也跑这两个回归的已批准决策；按决策 067 第 5 条字面（只提到与 P1-4e 共用 `dsh-bridge-gate.yml`）执行。
- **不用 `--runs 3`**：见 §4「为什么选 `--runs 1`」；代价是软门槛的中位数退化成单次值，统计意义弱于 3 次中位数，首批 CI 跑绿后可以按 §7 第 2 点重新评估。
- **软门槛放进 job summary，不是单独的 artifact**：job summary 在 PR/Actions 页面直接可读，不用下载解压；需要原始数字时报告 JSON 已经在失败时上传，成功时虽然不上传文件，但 summary 里的文字摘要已经够用（decision 067 的要求只是「只告警」，没有要求必须留原始数据）。

## 待用户确认

1. 插件审查守卫（commit `42dddf81`）要不要保留在 `dsh-bridge-gate.yml` 里（决策 153 第 7 节本来就留给用户定）。
2. §4「为什么选 `--runs 1`」与 §7 第 2 点：是否要改成多次跑取更稳的统计量。
3. §6 的超时估算（job 40 分钟、两个新步骤 8/15 分钟）在首次 CI 跑绿后按实测重算。
4. 推送 `feat/dsh-p0-probe` 让这个工作流首次真跑（决策 067 第 5 条、`CLAUDE.md`：推送前需用户确认）。
