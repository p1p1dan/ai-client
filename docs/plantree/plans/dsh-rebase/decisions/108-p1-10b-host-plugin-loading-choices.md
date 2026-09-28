# 决策 108：P1-10b 宿主装载与审计的实现取舍：启用集合经环境变量下发，插件层逐个审计、不合格只剔除，home 层多出的行让打包态拒绝启动

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 023](023-no-dotenv-private-cwd-home-patch-overlay.md) 第 3 条、[025](025-host-lifecycle.md) 第 2、5 条、[058](058-plugins-preinstalled-no-pnpm.md)、[059](059-allowlist-verification-and-audits.md)、[082](082-allowlist-implementation-choices.md) 第 6 条、[090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md) §4.2「启动期审计」、§4.3「启用」、§6 的 P1-10b 行、§8 实验 E1、E3；
- [分片 03](../topics/p1-10-p1-16-extensions/03-design.md) §3.3、§4.2、§4.3，[分片 04](../topics/p1-10-p1-16-extensions/04-changes-and-tests.md) §1 P1-10b、§3、§4.2（PLG-2、PLG-3）；
- DSH 源码：`dsh-app-boot/lib/index.js` 的 `resolveBundleDir`（先安装锚点、再 profile，按 Node 的 node_modules 逐级向上找）、`loadProfileDirectory`（`userLayer: false`）、`readProfilePatches`（bundles → profile 用户层 → home 层 → overlays）、`applyEntryPatches`（补丁只增不删）。

改动留在工作区，由编排者复跑后提交。

## 规则

### 一、profile 的 bundles（决策 058 第 2 条的实现）

1. 宿主每次启动，把 profile 清单的 bundles 重写为：
   - 产品 bundle，顺序固定；
   - 测试 bundle：只有 `@aiclient/dsh-probe`，并且只在源码形态、探针驱动设了 `AICLIENT_DSH_PROBE_BUNDLE=1`、清单里本来就列着它时才保留（见第 4 条）；
   - 启用集合里、白名单上、并且安装目录里有的插件，按白名单顺序；`replaces` 里的旧名启用新名。

   清单里的其他名字一律去掉，逐个告警，并写进 `ready.plugins.dropped`，原因取「not on the allowlist」「not enabled」「replaced by …」「missing: …」之一。Main 启用了、但白名单上已经没有的名字（下架）也写进 `dropped`。目标与现状相同就不写回。
2. 「安装目录里有」的判据：`<宿主目录>/node_modules/<包名>/package.json` 存在，包名、版本与白名单相同，声明了 `dsh.bundle.patch`。
   - 不存在或读不了：`missing`，只告警，不拒绝启动（决策 025 第 5 条）；
   - 版本不对、不是 bundle：`rejected`，同样只告警。
3. 白名单的来源：
   - 打包态读 `dsh-host-manifest.json` 的 `plugins` 段（构建期已审计），只复核宿主要用的形状；
   - 源码态读 `plugins/allowlist.json`，用构建期同一个 `parseAllowlist`；
   - 读不了就当白名单为空并告警。

   为此 host.js 要打进 `src/shared/dshPluginAllowlist.ts` 与新文件 `src/shared/dshPlugins.ts`：构建库的 `HOST_INPUTS` 加这两项，加密机工具包 `tools/p0-4/build-kit.mjs` 的文件清单同步加上它们和 `lib/hostPlugins.ts`、`plugins/allowlist.json`。
4. 探针 bundle 的门槛：源码态加 `AICLIENT_DSH_PROBE_BUNDLE=1`，两个条件都要满足。
   - 工具侧：`tools/lib/kit.ts` 的 `baseEnv` 和 `p0-4-probe.ts` 的 `hostEnv` 都设了这个开关，十个探针驱动不用各自改；
   - Main 侧：`AICLIENT_*` 一律不继承，所以产品的宿主，无论打包还是开发态的 Electron，都不会保留一个被人放进 profile 目录的「探针」。

### 二、启用集合：存在哪、怎么下发

5. **存储**：Main 的共享设置里新增一个 Main 持有的键 `dshPlugins: {enabled: [...]}`，值是用户选定的包名列表（去重、排序）。
   - 没有这个键，表示「没人选过」，宿主按白名单的 `defaultEnabled` 启用；
   - 空列表 `[]` 是一个明确的选择，表示全关；
   - `ipc/settings.ts` 的 `MAIN_OWNED_SETTING_KEYS` 加上它，渲染层整对象保存时不会冲掉它，渲染层也伪造不了它。
6. **下发**：走环境变量 `AICLIENT_DSH_PLUGINS`，值是 JSON 包名数组，排序后的规范形式。
   - 没人选过时不设这个变量；
   - `buildDshHostEnvironment` 显式设置它，外部继承来的同名变量照例被剔除；
   - 宿主读到不合法的值（不是 JSON，或者不是包名数组），就一个插件也不启用，并告警（失败关闭）。

   `currentDshHostLaunch` 在每次 spawn 时读一次设置。
7. **切换即重启**（决策 025 第 2 条、059 第 4 条）：
   - supervisor 记下每个宿主启动时的选择键（`status().pluginSelection`，即上面那个变量的值，没有时为 `default`）；
   - `WorkerManager.reconcileHostPlugins(key)` 与模型计划共用一套复查（决策 033 第 4 条）：运行中的宿主选择键不同，且没有会话在跑，就 `invalidateAll`；否则每 2 s 再查。计划与插件同时过期时只重启一次；
   - 没有宿主在跑时不做任何事，下次启动自然用新选择；
   - Main 侧入口是 `src/main/services/agent-host/dshHostPlugins.ts`，提供 `getDshPluginSelection`、`setDshPluginSelection`、`getDshPluginReport`，P1-10c 的 IPC 只调这三个。

### 三、`ready` 回报

8. `ready.plugins` 的形状（`src/shared/dshPlugins.ts` 的 `DshPluginReport`）：

   ```ts
   {
     enabledFrom: 'main' | 'default' | 'invalid',
     plugins: Array<{          // every allowlisted plugin, in allowlist order
       name: string; version: string; defaultEnabled: boolean;
       state: 'loaded' | 'disabled' | 'missing' | 'rejected';
       reason?: string;         // why it is not loaded (clipped to 500 chars)
       inactiveRows?: string[]; // loaded, but these declared rows did not start
     }>,
     dropped: Array<{ name: string; reason: string }>,
   }
   ```

   - 四种状态的定义：`loaded` 已加载；`disabled` 不在启用集合里；`missing` 启用了但安装目录里没有；`rejected` 启用了、装了，但被排除：版本不对、不是 bundle、DSH 因 peer 不兼容跳过它、解析到了安装目录以外、补丁审计不过；
   - 原有的 `skippedPlugins` 字段不变。
9. supervisor 用 `isDshPluginReport` 校验形状后，保留**最近一次** `ready` 的报告，宿主退出后也保留，供设置页读取（`pluginReport()`，返回副本）。形状不对的报告丢弃并告警，保留上一份好的。有 `missing` / `rejected` / `inactiveRows`，或者 `enabledFrom` 为 `invalid` 时，记一条告警。

### 四、启动期组合审计

10. **profile 用户层不参与组合**（决策 058 第 3 条）：改为 `loadProfileDirectory(..., {userLayer: false})`。`profiles/aiclient/cordis.patch.yml` 非空时告警，说明它被忽略。
11. **插件层逐个审计**（决策 059 第 3 条）：DSH 装载之后、组合之前，对计划里要加载的每个插件依次检查：
    - DSH 跳过了它（peer 不兼容、读不到）：记 `rejected`，原因用 DSH 自己的；
    - 它的 `packageDir` 的真实路径不等于 `<宿主目录>/node_modules/<包名>` 的真实路径：记 `rejected`。DSH 按 Node 规则会先找安装锚点，找不到再逐级向上、再到 profile 目录找，这一条挡住 profile 目录和上级 `node_modules`（例如 Windows 上人人可写的 `C:\node_modules`）里的同名包；
    - 补丁审计用构建期同一个 `auditBundlePatches`：只能 insert 白名单 `rows` 里声明过的行，行的模块必须属于本包，不能改任何不是自己插入的行。不过就记 `rejected`。

    被拒的插件从本次组合中去掉，只告警，宿主照常启动（与决策 025 第 5 条「插件出错只告警」一致）。profile 清单里仍保留它，下次启动再判一次。
12. **home 层多出的行**：
    - 判法：只用各 bundle 层和启动 overlay 组合一次，得到「可信组合」，再与完整组合（含 `$DSH_HOME/cordis.patch.yml`）比较。按行 id 计数，含嵌套行（两种 group 形态）和没有 id 的行，完整组合多出来的就是未声明的行。补丁只能增加行，不能删除行，所以多出来的只可能来自 home 层（profile 用户层已不参与组合）；
    - **打包态**拒绝启动，fatal 消息带机器码：
      - 码：`DSH_HOST_UNDECLARED_ROWS`（`{type: 'fatal', message, code}`）；
      - 文案：`DSH_HOST_UNDECLARED_ROWS: <$DSH_HOME/cordis.patch.yml 的路径> inserts rows that no composed bundle declares: <id, …>; remove them from that file`；
      - Main 看到的是 `DSH_HOST_START_FAILED: the DSH host refused to start: DSH_HOST_UNDECLARED_ROWS: …`，计一次启动失败；用户手动发起的操作仍会再试。
    - **源码态**（开发与探针）只打同一句告警，照常启动。「产品态 / 开发态」按宿主形态区分：宿主旁边有 `dsh-host-manifest.json` 就是打包态。
13. 原有检查不变：`aiclient-bridge`、`aiclient-permissions`、`aiclient-credentials`（以及 `aiclient-loop-guard`）必须启用；`plugin-manager`、`tool-plugin-manager` 等 `REQUIRED_DISABLED` 行由 overlay 重申关闭，组合里必须是关闭的。

### 五、实验与测试夹具

14. **E1**（`src/dsh-host/tools/e1-plugin-manager-off.ts`，源码宿主，2026-09-28 本机）：**通过。**
    - 两个宿主：baseline 用全新 profile；hostile 的 profile 用户层要打开两行插件管理、关掉权限行、再插一行；
    - 两个都 ready，组合都是 97 行，两行插件管理都是关闭的，census 都是 77 个活动行、0 个未激活；
    - hostile 打出了「用户层被忽略」的告警，而且没有多出任何行；
    - 两边的 P0-TOOL 回合都跑通（bash 成功），都干净退出。
15. **E3**（`src/dsh-host/tools/e3-readonly-plugin-install.ts`，真实构建产物，2026-09-28 本机）：**通过。**
    - 做法：复制 `out-dsh-host`（82.2 MiB），把夹具插件按产品的方式预装进去（`node_modules` 下的独立目录、宿主 `package.json` 的依赖、manifest 的 `plugins` 段），然后整棵目录设成只读（文件 0444、目录 0555），用 Main 的环境规则起两个打包态宿主；
    - 启用：报 `loaded`，行在活动（78 对 77），插件自报从安装目录加载，模型请求里多一个工具（23 对 22）；
    - 关闭：报 `disabled`，不在组合里；
    - 前后快照相同：安装目录里没有新增、删除或改动任何文件；
    - 结论：插件 bundle 可以从只读的安装目录加载，DSH 不往安装目录写任何东西。
16. **测试夹具插件** `src/dsh-host/tools/plugin-fixture/`：`@aiclient-test/dsh-fixture-plugin@0.0.1`，一行 `fixture-ping`，一个工具 `fixture_ping`，peer 只依赖钉住的 `dsh-tools`，不联网，不装包。
    - 坏变体由 `tools/lib/plugin-install.ts` 在临时目录里现场派生：多插一行、改权限行、peer 不兼容；
    - 真宿主测试放在集成测试的第九个 supervisor 里（PLG-1～5）。它用「临时安装目录」：host.js 按构建期的 esbuild 规则现场打包，`node_modules` 是指向 `src/dsh-host/node_modules` 的软链，插件是真实副本。这样不写共享检出里的 `node_modules`，也不依赖 `out-dsh-host` 是不是最新构建。

## 取舍

- **用环境变量，不用 `configure`**：
  - 这与 P1-6c、P1-16a 的路径下发方式一致；
  - 启用集合本来就要重启才生效（决策 025），spawn 时定下来最合适；
  - `configure` 的类型在 `src/shared/types/dshHostProtocol.ts`，属于另一个代理的改动范围；
  - 这是包名列表，不是密钥，进了工具环境也无害。
- **存「用户选定的列表」，缺省时由宿主套用 `defaultEnabled`**：
  - 这是分片 03 §4.3 的字面做法（「首次运行取清单的 defaultEnabled」）；
  - Main 在 P1-10b 不用读白名单，默认值的解释权只在宿主一处；
  - 代价：用户一旦选过，后续版本新加的 `defaultEnabled: true` 插件不会自动为他打开。见待拍板第 1 条。
- **插件审计不过只剔除，不拒绝启动**：构建期审计已经拦过一遍，运行期再出问题意味着安装目录被改过（与 `app.asar` 同一信任级别）或开发失误。为一个插件让所有聊天都起不来，代价太大；决策 025 第 5 条也是这个口径。
- **源码态的 home 层只告警**：开发和探针要用 home 层补丁做实验；产品态才拒绝。
- **夹具测试没放进 bridge-smoke**：
  - 源码形态的安装范围是共享的 `src/dsh-host/node_modules`，放进夹具就得往共享树里写东西，还得给产品代码加测试后门（覆盖白名单路径）；
  - 放进集成测试，用真实的 supervisor 和 WorkerManager 走完「选择变更 → 空闲 → 重启 → 新报告」，覆盖面也更大；
  - 同时没有改动 bridge-smoke 与假网关。

## 待用户拍板

1. **启用集合的语义**（第 5 条）：存「用户选定的列表」时，选过一次的用户不会自动得到新版本里默认开启的插件；没选过的用户始终跟随默认值。另一种做法是存「逐个插件的开关覆盖」：没碰过的插件一律跟随默认值，但这偏离了分片 03 的字面做法。目前试点插件默认关闭，两种做法没有差别。
2. **home 层插入未声明的行时，打包态拒绝启动**（第 12 条，细化决策 023 第 3 条，决策 059 已批准这个方向）：手工往 `$DSH_HOME/cordis.patch.yml` 加过行的用户，升级后聊天引擎会起不来，直到删掉那几行；报错会指明文件。这与「保留 DSH 读取行为」之间的分寸，请确认。
3. **新发现，未处理：home 层的 `!!js` 表达式**。home 层虽然不能新增行，但仍然可以改任意已有行的 `config`，而 `!!js` 表达式在组合时会被求值，等于能在宿主里执行代码。本任务的「未声明行」审计管不到这一点。可选做法：
   - A：照 DSH 保留（现状）；
   - B：打包态遇到 home 层含 `!!js` 时拒绝启动或告警；
   - C：打包态完全不读 home 层，与 profile 用户层同样处理。

   建议 B 或 C。这会改变决策 023 第 3 条，需要用户定。

## 影响与遗留

- **产物**：host.js 从 22.0 KB 增至 47.8 KB；linux-x64 产物 86,219,875 B（+54 KB），9,761 个文件（不变）。白名单仍为空，manifest 的 `plugins` 为 `[]`。
- **探针工具**：十个用 `baseEnv` 的驱动和 `p0-4-probe` 都带上了探针开关。只用 `installProbeBundle`、却另拼环境变量的新驱动，要记得带上这个开关，否则探针 bundle 会被剔除，驱动会卡在第一步（`aiclient-probe` 行不在）。
- **加密机工具包**：文件清单已补，但本次没有重新构建或上机。
- **P1-10c**：设置页与 IPC 只需要调用 `dshHostPlugins.ts` 的三个函数。「已下架」的提示可以用 `dropped` 与 Main 的设置来判断。
- **P1-10d**：试点插件进白名单之后，打包冒烟 L1 带一个已启用插件，可以直接复用 E3 的装配方式（`tools/lib/plugin-install.ts` 的 artifact 形态）。
- **没有做**：
  - 运行期不校验插件的 integrity（安装目录与 `app.asar` 同一信任级别，决策 059）；
  - profile 目录里 DSH 的 `compatibility.json` 豁免仍会被 DSH 读取。对白名单插件没有影响，因为构建期已经判过兼容、不许豁免；不在白名单上的 bundle 根本进不了列表。
