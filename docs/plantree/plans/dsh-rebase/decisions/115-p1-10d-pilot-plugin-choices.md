# 决策 115：P1-10d 试点插件 `dsh-office-tools@1.0.4` 的实现取舍：有条件通过、默认关闭进白名单，读写按审查分类，写类在 accept-edits 下与 write / edit 同等

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 058](058-plugins-preinstalled-no-pnpm.md)～[060](060-first-allowlist-pilot-office-tools.md)（060 首批白名单只有这个试点，默认关）、[082](082-allowlist-implementation-choices.md) 第 3 条（`overrides`）、[108](108-p1-10b-host-plugin-loading-choices.md)（装载与审计，已按 110 改为逐插件开关覆盖）、[110](110-user-rulings-2026-09-28-batch2.md)「联网装包」行、[090](090-user-rulings-2026-09-28.md)「060」行（批准随包）、[042](042-approval-in-pre-execute-plugin.md)、[044](044-dsh-sandbox-off-by-default-in-p1.md)、[047](047-tool-classification-and-plan-mode.md)、[114](114-p1-4d3-ask-user-choices.md)；
- [P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md) §4.5、§5 D5、§6 的 P1-10d 行；[分片 03](../topics/p1-10-p1-16-extensions/03-design.md) §3.4 第 4 步、§6.2 审查单；
- 审查记录：[`src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md`](../../../../../src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md)；装包与验证证据：[p1-10d-office-tools-install-2026-09-28](../evidence/p1-10d-office-tools-install-2026-09-28.md)。

改动留在工作区，由编排者复跑后提交。

## 规则

### 一、装包与白名单条目

1. **peer 用 `overrides` 钉住（决策 082 第 3 条的第一次实际使用）**。
   - 插件的 5 个 dsh peer 写的是 `^0.1.0-rc.6 || … || ^0.1.5-alpha.0`，npm 不按预发布匹配，第一次 `--package-lock-only` 就报 `ERESOLVE`，与实验 E2 相同；
   - `src/dsh-host/package.json` 的 `overrides.dsh-office-tools` 把 `dsh-agent`、`dsh-fs`、`dsh-llm`、`dsh-session`、`dsh-tools` 钉到宿主版本 `0.1.7-rc.2`；`cordis` 的 `^4.0.1` 本来就满足 `4.0.4`，不钉；
   - 锁文件只多一条，已有条目 0 变化；真正的兼容仍由 DSH 自己的 `evaluatePluginCompatibility` 在构建期判，结果兼容、没有豁免。
2. **清单条目**（`src/dsh-host/plugins/allowlist.json`）：
   - `kind: "internal"`：包名不是 `@deepseek-ai/*`，是审过的社区包；
   - `defaultEnabled: false`（D5）；
   - `rows: ["dsh-office-tools"]`，就是它补丁里插的那一行；
   - `tools` 逐个写出 8 个工具的读写分类与路径参数，**不写 `'*'`**：插件注册的工具全部有分类，测试保证以后多出的工具不会悄悄落到 `'*': 'ask'`；
   - 不写 `dependencies`（闭包为空）、`installScripts`（没有）、`limits`（124,685 B / 5 个文件，远低于 5 MiB / 500 个文件的默认额度）；
   - `review.verdict: "conditional"`，`reviewer` 写「代理审查，待用户审批（本决策）」，不写个人名字。
3. **构建离线**：宿主构建用 `npm_config_offline=true`，`npm ci` 全部取自本机缓存。联网只有对这一个包的 `npm view`、`npm pack`、两次 `install`。

### 二、审查结论：有条件通过

4. 按审查单逐项查过，写在审查记录里。要点：
   - 纯宿主 bundle，补丁只插自己的一行；零运行期依赖，没有安装脚本、原生件、`bin`；
   - 构建库的敏感 API 扫描零命中；人工逐行读 `lib/index.js`（2353 行），对外只用 `ctx.tools.register`、`ctx.effect`、`ctx.fs`（读写都在这里，唯一写入点是 `ctx.fs.writeText`）、`ctx.get("sandboxPolicy")`（只读），以及 `node:zlib`、`node:path`。没有凭据、`process`、IPC、子进程、网络、`eval` 或动态 import、`vm`、`worker_threads`、猴子补丁、计时器、上报；
   - 没有注册任何钩子，不会应答审批；
   - 读写都由插件自己限制在会话工作区内（词法检查 + `ctx.fs.contains`）。
5. **条件**：默认关闭；按第三节分类过闸；插件升版、DSH 升版、`overrides` 变化时重审；改为默认开启前重新评估资源占用。
6. **接受的已知风险**（理由见审查记录第 3、8 节）：
   - 解压与 XML 解析在共享宿主进程里同步执行，构造过的文件能让所有会话停顿几秒、占几百 MiB 内存（单文件 50 MiB 上限，默认关闭，只处理用户工作区的文件）；
   - 插件 `import` 了未声明的 `@deepseek-ai/schemastery`，靠宿主树顶层解析，DSH 升级时复核；
   - `excel_*` 会把 `=` 开头的字符串写成公式；每次写入都出卡、预览完整参数。

### 三、过闸分类（决策 060 第 4 条的实现）

7. **目录标的只读不作数，按实测分类**：`word_read`、`excel_read`、`ppt_read` 为读；`word_create`、`word_update`、`excel_create`、`excel_update`、`ppt_create` 为写；路径参数都是 `path`。
8. **分类放在 `classification.ts` 的第二张静态表 `PLUGIN_TOOL_CLASSES`**，不在运行期读白名单的 `tools`。
   - 理由：闸门按工具名同步判定，权限行不必依赖宿主装载白名单的结果；分类是审查的产物，与 DSH 自带工具的表放在一处维护；
   - 静态测试钉住三件事：表与白名单所有条目的 `tools` 相等；每个白名单插件实际注册（`defineTool`）的工具与它的 `tools` 一一对应；插件工具名不与 DSH 工具重名；
   - 代价：插件没开时这些名字也有分类。只有白名单插件能被组合，名字又有测试防重，所以没有影响。
9. **读类**的请求与 DSH 的 `read` 完全相同（工具名 `read`，路径取 `path` 参数）：工作区内在 ask / accept-edits / auto 档都不出卡，plan 模式可用，`read` 的路径规则和授权与 DSH `read` 共用。
10. **写类**：
    - 工具名保留插件自己的（`word_create` 等），卡片、「本会话允许」都按「这个工具 + 这个文件」；
    - 路径取 `path` 参数，经同样的规范路径解析；`policySurface` 为 `write`，用户策略里 `write` 的路径规则同样作用于它；
    - 卡片预览整份参数（也就是要写进去的内容），标签 `Arguments`；
    - **共享闸门新增一个可选字段 `fileWrite`**（`src/shared/permissions/gate.ts`）：带这个标记的请求，accept-edits 档在工作区内放行，与 `write`、`edit` 相同；ask 档照样出卡，工作区外照样问，plan 模式照样拒绝。只有 `requestBuilder` 给白名单插件的写类设这个标记，DSH 自带工具的请求字节不变。
    - 不选「把工具名改写成 `write`」：卡片会显示成 `write`，与聊天区的工具行对不上，「本会话允许」还会与 DSH 的 `write` 混用；
    - 不选「不改闸门」：accept-edits 下插件写入仍要出卡，与 `write` / `edit` 不一致，也不符合分片 03 §3.4「写类指明路径参数，accept-edits 才能判断」的原意。
11. **`ppt_create` 读取的图片路径不单独过闸**：它在参数的嵌套数组里，插件对它做同样的工作区限制，只读头部取尺寸，不把内容交给模型。

### 四、冒烟与测试

12. **bridge-smoke 加宿主 I**：经 `AICLIENT_DSH_PLUGINS`（Main 的规范写法 `dshHostPluginsEnvValue`）开启试点插件，ask 档会话跑一次 P0-OFFICE：`word_create` 出一张卡、答允许、写出 zip；`word_read` 不出卡、读回正文。宿主 A 的 STREAM 回合同时核对：默认关时 `ready.plugins` 报 `disabled`，模型的工具表里没有任何 office 工具。
    - 假网关**复用 P0-2 已有的 P0-OFFICE 脚本**，只在请求日志里加一个 `toolNames` 字段（原来只记个数），供冒烟判断工具表；
    - bridge-smoke 的 `ready` 记录多存一份 `plugins`。
13. **打包冒烟 L1 默认开启试点插件**（`scripts/packaged-dsh-host-smoke.mjs`）：L1 宿主经 Main 的覆盖开启它，并在原有回合之后加一回合 P0-OFFICE；L0 仍是默认，核对它报 `disabled`。
    - 这样 Windows CI 跑的同一份打包冒烟就覆盖了试点插件的装载、过闸与读写，符合方案 §7「打包冒烟带一个已启用插件，加断网断言」（断网断言原本就有）；
    - 决策 108「影响与遗留」原说「复用 E3 的装配方式」：现在产物里本来就装着它，只要设一个环境变量，不需要另外装配。
14. **集成测试加 PLG-6**：用已提交白名单里的条目、按构建的方式列进临时安装的 manifest，先默认（报 `disabled`、组合里没有），再由 Main 覆盖开启（报 `loaded`，首个请求的工具多 8 个）。PLG-1～5 的临时安装只列夹具插件，看不到试点，断言不用改；PLG-6 的首次启动会把 PLG-4 留在共享 profile 里的夹具记为 `dropped: not on the allowlist`，这是预期行为，断言照写。
15. **E1、E3 不改，只重跑**：E1 是源码宿主，试点默认关，结论不变；E3 验的是「只读安装目录」这件事，夹具插件足够，试点在产物副本里默认关、不影响它的判据。

### 五、金样本

16. 插件默认关，录制的 26 个场景 `--check` **无差异**，本次没有重录，也没有写 `src/shared/__tests__/fixtures/dsh/`。

## 待用户审批的要点

- **审查结论「有条件通过」本身**（第 4～6 条）：决策 090 已批准「审查通过后随包」，本次的审查人是代理，请用户确认接受第 6 条列出的三项已知风险。
- **第 10 条改了共享闸门**：accept-edits 档下，白名单插件的写类工具在工作区内不再出卡。不同意的话，去掉 `fileWrite` 这一处规则即可退回「accept-edits 下也出卡」。

## 修订

- [决策 060](060-first-allowlist-pilot-office-tools.md)：加实施补记，指向本决策。
- [决策 108](108-p1-10b-host-plugin-loading-choices.md)：「影响与遗留」的 P1-10d 一条加注：打包冒烟直接用产物里的试点插件，不再复用 E3 的装配方式（本决策第 13 条）。

## 影响

- **产物**（linux-x64）：86,261,736 B / 9,765 个文件 / 343 个包 → 86,388,208 B / 9,770 个文件 / 344 个包（+126,472 B、+5 个文件、+1 个包）。插件本身 124,685 B、5 个文件；其余来自 `permissions.js`。manifest 的 `plugins` 段第一次非空。
- **改动的文件**：
  - 宿主包：`src/dsh-host/package.json`（依赖与 `overrides`）、`package-lock.json`；
  - 白名单与审查：`src/dsh-host/plugins/allowlist.json`、`src/dsh-host/plugins/reviews/dsh-office-tools-1.0.4.md`（新）；
  - 过闸：`src/dsh-host/permissions/classification.ts`、`requestBuilder.ts`、`src/shared/permissions/gate.ts`；
  - 工具：`src/dsh-host/tools/bridge-smoke.ts`、`fake-gateway.mjs`、`scripts/packaged-dsh-host-smoke.mjs`；
  - 测试：`permissionsClassification.test.ts`、`permissionHost.test.ts`、`permissionsLibrarySeams.test.ts`、`src/shared/__tests__/dshPluginAllowlist.test.ts`、`scripts/__tests__/dsh-plugin-allowlist.test.mjs`、集成测试。
- **没有做、留给后续**：
  - Windows CI 冒烟：本机跑不了，需要编排者或用户推送后看 CI 结果；
  - 设置页开关（P1-10c）：现在只能经 Main 设置里的 `dshPlugins.overrides` 打开，界面上还没有入口；
  - 聊天区的 office 工具行文案与图标（P1-7c）；审批卡目前是通用卡，显示工具名、路径和参数预览；
    - 修订注记（2026-09-28，P1-7c）：工具行已落地：3 个读「读取」+ 文件图标，5 个写「编辑」+ 编辑图标，参数是 `path` 的短路径；审批卡仍是通用卡。见[决策 120](120-p1-7c-tool-rows-choices.md) 第 10 条（待审批）。
  - P1-13 检查单补一项「开启试点插件后，在加密机上跑一次 `word_create` / `word_read` 与 `excel_create` / `excel_read`」；上机包本次没有重建。按 P1-13b 矩阵，`.docx`、`.pptx` 在加密机上读不出明文，插件会明确报错。
