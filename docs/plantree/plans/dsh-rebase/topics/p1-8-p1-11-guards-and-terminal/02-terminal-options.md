Role: detail shard

# P1-8 / P1-11 分片 02 · 内嵌终端：选项、联动与推荐

上位：[P1-8 / P1-11 方案](../p1-8-p1-11-guards-and-terminal.md)。回答调研问题 2、3。现状见[分片 01](01-terminal-inventory.md)，行号约定同该分片。

## 1 社区 TUI 的离线事实（未核实，需联网）

- DSH 官方没有 TUI，`dsh` 命令行只有 web / acp / sdk / headless 几种入口（[决策 001](../../decisions/001-route-b-and-scope.md) 第 5 条；[可行性调研](../../../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)第 167 行）。
- `@deepseek-harness-tui/dsh-tui@0.11.0` 是 2026-09-24 用 `npm search` 找到的第三方前端（调研第 96 行），scope 不是官方的 `@deepseek-ai`。
- P0-2 用 `dsh-plugin-catalog@2026.925.4511` 按下载量取前 150 个、按 app-boot 的准入规则筛（[P0-2 证据](../../evidence/p0-2-goal-and-plugins-2026-09-25.md)第 91 行；data.json 的 `communityPluginSelection.peerRefused[0]`）：
  - 它要求 `dsh-ptc-runtime-node@0.1.7-rc.1` 与 `dsh-agent-preset-registry@0.1.7-rc.1`，被 peer 规则拒绝；
  - 后者在我们钉住的树里根本没有（`src/dsh-host/node_modules/@deepseek-ai/` 下无此包）。
- 同一批里另两个 TUI 类包通过了准入，但都带红线（data.json `hostOnlyCompatible[6]`、`[12]`）：
  - `@aiwayds/dsh-tui-pi@2.23.1`：下载 11,580；能力 shell、fs-write、fs-read、credentials、env；红线「安装时跑代码」。
  - `dsh-ssh-tui@0.7.3`：下载 5,960；能力含 network 与 credentials；红线「读凭据且能联网」。
- 推断：要 PTC 运行时，说明 dsh-tui 在自己的进程里带宿主。那样它要么用独立的 `DSH_HOME`（与 GUI 不共享会话，谈不上互通），要么在我方 `DSH_HOME` 上另起宿主，这是 P1-3 明令禁止的（[P1-3 方案](../p1-3-shared-host.md)第 154 行；[P1-3 分片 02](../p1-3-shared-host/02-design.md) 第 168 行）。
- 不知道的：维护者与发版节奏、兼容 rc.2 的版本、能不能作为客户端连已有宿主、会话格式与 GUI 能否互通。核实要联网 `npm view` 或读源码，本次按约束没做。

## 2 逐项联动

### A 只当普通终端，去掉 pi TUI

- **对 1.0.x 用户**：
  - TUI 按钮与终端里的 pi 助手消失。在 TUI 里用 pi 扩展的用户失去扩展（[决策 064](../../decisions/064-accepted-behavior-differences-extensions.md) 第 7 条已列）。managed 用户失去终端里的公司渠道（runtime-hardening 决策 011 的前提不再存在）。
  - 旧会话，包括 TUI 续聊过的和 `/new` 登记的，一律在 GUI 里续聊，首次继续时迁移（决策 050）。pi v3 文件与「v4 + CLI 行」的混写文件，P1-9 的解码链本来就要覆盖（[P1-9 分片 01](../p1-9-migration/01-pi-format.md) 第 9、12 行）。
  - 回装 1.0.x：TUI、pi 扩展、旧会话都还在（决策 004 第 6 条；扩展文件不动，决策 063 第 2 条）。
- **P1-9（决策 050、051）**：迁移服务不用做 TUI 交接（原计划见 [P1-9 方案](../p1-9-migration.md)第 88 行、[分片 04](../p1-9-migration/04-index-rollback.md) 第 86 行）；也不会有「DSH 构建里 TUI 续聊未迁移行」引起的分叉（[分片 05](../p1-9-migration/05-tests-and-changes.md) 第 97 行）。
- **P1-12**：pi CLI 随 `resources/agent-host` 整体删，两个 pi 包出包，与 roadmap P1-12「删 pi TUI 互通」一致。
- **决策 038**：TUI 去掉后，`auth.json` 只剩 native worker 的回退在读（[P1-5 分片 01](../p1-5-models-and-credentials/01-current-state.md) 第 43 行），P1-15 落地后即可停写，P1-12 收尾；`managedCredentialsStartup` 为 TUI 做的重写一并删掉。
- **决策 063**：按现文执行（不再加载，插件页只读列出）；插件页的 pi CLI 装卸随 P1-10c 下线，用户机上不再有联网的包管理器，与决策 058 同向。
- **其他**：老设置 `presentationMode: 'tui'` 迁成 `gui`；P1-4 的 `reload` 与 worker `reload` RPC 随 native 删除；P1-6 的 C 类旧 pi-permission-system 用例直接删（[P1-6 分片 04](../p1-6-permissions/04-regression-baseline.md) 第 37 行）。
- **工作量**：约 0.5～1 人周，以删除为主（分片 01 §4）；新增约 100 行（设置迁移、静态守卫）与约 200 行测试。
- **安全**：去掉一条不经白名单、不经我方审批的执行路径（pi CLI + 用户从 npm 装的 pi 扩展 + pi 默认权限），与决策 001 第 2 条、058、059 一致。

### B 接入社区 dsh-tui

- **对 1.0.x 用户**：换一套界面与命令；pi 扩展同样失效；旧 pi 会话 dsh-tui 打不开，推断要先迁移。
- **P1-9**：dsh-tui 若在我方宿主之外写会话，要设计新的交接协议；与 GUI 的会话互通要按 DSH 格式重做，1.0.x 为交接做过多轮加固（分片 01 §2）。
- **P1-12**：pi CLI 照删；dsh-tui 及依赖进包，计入决策 014 的 128 MiB 上限，走决策 058 的预装流程。
- **决策 038**：自带宿主时要另给它凭据；按决策 034 只能经宿主按请求拉取（推断：要么再做一套注入，要么明文落盘）。
- **决策 063**：pi 扩展照样放弃。
- **与 P1-3**：不许在我方 `DSH_HOME` 上另起宿主；连我方宿主要开客户端通道，而我方组合里没有 webserver 这类行（`dsh-host/bundle/cordis.patch.yml:4-7`）。
- **工作量**：推断 3～5 人周以上：审查、兼容版本、宿主关系、互通、打包、测试；另加上游节奏这个不可控项。
- **安全**：第三方包，按[决策 059](../../decisions/059-allowlist-verification-and-audits.md) 的审查单全审（安装脚本、依赖闭包、敏感 API、钩子）；同类包都带红线；若与宿主同进程则同权，审查是唯一防线（[决策 060](../../decisions/060-first-allowlist-pilot-office-tools.md) 的理由）。

### C 过渡期保留 pi TUI，只开未迁移的旧会话

- **两个时点**：
  - C1 合入前删：对用户与 A 完全相同，只是删得晚，期间 P1-9、P1-5 要为 TUI 做特判。
  - C2 合入后下个版本再删：首个 DSH 版仍带 pi 引擎。
- **对 1.0.x 用户（C2）**：旧会话可以在 TUI 续聊，直到在 GUI 里首次继续触发迁移；已迁移的会话与所有新会话点 TUI 都会被拒（P1-1 R6；迁移后的 pi 行被隐藏，[P1-9 分片 04](../p1-9-migration/04-index-rollback.md) 第 73 行），同一个按钮时灵时不灵；以后还要再经历一次移除。
- **P1-9**：迁移前必须先让 TUI 交出文件，沿用 `handOverFromTui` 的释放半段，读前后 stat 比对兜底；TUI 在未迁移行上续聊，会让逻辑会话进入「1.0.x 里有新内容」的分叉态（决策 051 第 2 条）。
- **P1-12**：要保留 pi CLI 产物（`agent-host` 去掉 worker 后的部分，推断仍是其中大头）；`piCliIsBundledToolOnly`、TUI 各测试与起真 pi CLI 的端到端测试都要留；roadmap P1-12 的「删 pi TUI 互通」要改写。
- **决策 038**：明文 `auth.json` 留到删 TUI 为止，「key 不以明文落盘」在这期间只对 DSH 路径成立。
- **决策 063**：改为选项 B，TUI 里照常加载；插件页保留 pi CLI 装卸，也就是用户机上仍会联网跑包管理器，方向与决策 058 相反。
- **与已批准的决策**：C2 与决策 001 第 5 条、004「合入后只有一个引擎」都冲突，要先修订。
- **工作量**：现在近 0；P1-9d 交接约 0.5 天，P1-12 拆出 pi CLI 产物约 1～2 天（推断）；日后再删一遍，成本同 A；测试矩阵变大。
- **安全**：保留 npm 任意 pi 扩展、pi 默认权限、明文 key。

## 3 推荐

> **2026-09-28 用户裁决选 A2**（[决策 090](../../decisions/090-user-rulings-2026-09-28.md) 的 Q003 行）：去掉 pi TUI 与 GUI / TUI 开关，原位置加一个终端按钮，在该会话目录开普通 shell。下面「推荐 A1」是调研时的原结论，已被取代；shell 出现的位置见 [P1-7 / P1-11 原型 09-28](../../evidence/p1-7-prototype-2026-09-28/)。

- 推荐 A1。C1 对用户等价，但删得晚要多付特判的成本。理由与代价见方案页 §2.3。
- A 的两种形态：
  - A1：去掉开关，不加新入口。
  - A2：开关改成「对话 / 终端」，终端按钮在会话目录打开普通 shell，复用 `PtyManager` 与 `ShellTerminal`，约多 1 天。
  - 用户 09-04 刚撤掉顶栏的终端按钮（`5fbc12b2`），所以推荐 A1；A2 的删除工作与 A1 相同，只多一个入口，用户想要时再加。
- B 记入想法池，与 L2 / P3 一起在合入之后再议；前提是先联网核实 §1 的未知项。
- 转给用户的问题见方案页 §2.4。
