# 决策 117：P1-10c 白名单插件设置页与 IPC 的实现取舍：Main 另读一份白名单清单来补齐说明、来源、能力与审查；每次切换只写一条逐插件覆盖；页面只说「引擎下次启动时生效」

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 108](108-p1-10b-host-plugin-loading-choices.md) 第 5～9 条（逐插件覆盖、切换即重启、`ready.plugins`）与「影响与遗留」的 P1-10c 一条；[110](110-user-rulings-2026-09-28-batch2.md)（逐插件开关覆盖）；[115](115-p1-10d-pilot-plugin-choices.md)（试点 `dsh-office-tools` 默认关、有条件通过、读写分类）；[116](116-p1-16e-legacy-asset-notice-choices.md) 第 19、22 条（插件页整页卸下、不留占位，由本任务直接加一节）；[104](104-legacy-asset-notice-and-extension-pages.md) 第 3、5 条；[090](090-user-rulings-2026-09-28.md)「063」行（pi 扩展彻底去掉，不留提示入口）；[025](025-host-lifecycle.md) 第 2 条；[058](058-plugins-preinstalled-no-pnpm.md)、[059](059-allowlist-verification-and-audits.md)；[047](047-tool-classification-and-plan-mode.md)；
- [P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md) §4.4、§4.5 与 §6 的 P1-10c 行；
- 代码：`src/main/services/agent-host/dshHostPlugins.ts`、`dshPluginSelection.ts`、`WorkerManager.reconcileHostPlugins` / `hasWorkInFlight`、`src/shared/dshPlugins.ts`、`src/shared/dshPluginAllowlist.ts`、`src/dsh-host/lib/hostPlugins.ts`（`enabledNames`、`allowlistFromManifest`）、`src/dsh-host/host.ts`（`readHostAllowlist`）、`scripts/dsh-host-build-lib.mjs`（`auditInstalledPlugins`、`displayOf`）。

改动留在工作区，由编排者复跑后提交。下面是方案与既有决策没有写死、由本次实现定下的地方。**第 2、6、10、13 条请重点审批。**

## 规则

### 一、IPC

1. **两条通道**，都在 `src/main/ipc/dshPlugins.ts`：
   - `dshPlugins:list`：只读，返回整页状态 `DshPluginsState`（类型在 `src/shared/dshPluginSettings.ts`）；
   - `dshPlugins:setEnabled {name, enabled}`：写一条覆盖，返回写后的整页状态。
   - 没有安装、删除、刷新、恢复默认的通道。
2. **Main 另读一份白名单清单（补充决策 108 第 7 条）**。
   - 用户的选择与宿主的状态仍然只经 `dshHostPlugins.ts` 的 `getDshPluginSelection`、`setDshPluginSelection`、`getDshPluginReport` 三个函数：IPC 不直接读写设置文件，也不碰 `WorkerManager`、supervisor，重启由 `setDshPluginSelection` 交给 `reconcileHostPlugins`。单测用源码扫描钉住这一点。
   - 但宿主上报只有名字、版本、状态和原因，而且应用启动后第一次对话之前根本没有上报。页面要的说明、来源、能力、审查日期都不在里面，所以 Main 读白名单本身：`src/main/services/dshPlugins/pluginCatalog.ts`。
   - 读法与宿主相同（`host.ts` 的 `readHostAllowlist`）：宿主目录旁有 `dsh-host-manifest.json` 就读它的 `plugins` 段（打包态，构建期已审计）；没有就读 `plugins/allowlist.json`，用构建期同一个 `parseAllowlist`（源码态）。宿主目录由 `DshHostProcess.ts` 的 `DSH_HOST_LAYOUT` 推出，与宿主启动用同一处常量。
   - 只读，只读应用自己的安装目录，不读任何用户数据。
   - 读不了就把原因放进 `catalogError`，页面显示错误，不当作「没有插件」。
3. **入参校验**：payload 必须是对象；`name` 必须是非空字符串，并且在当前清单里；`enabled` 必须是布尔值。任何一项不合格都抛错，不写任何东西。
   - 已下架的名字、产品自己的 bundle 名一律拒绝：页面上没有它们的开关，正常流程不会发这种请求；
   - 清单读不出时，所有 `setEnabled` 都拒绝。

### 二、合并规则（`src/main/services/dshPlugins/pluginsView.ts`，纯函数）

4. **`enabled` 按宿主自己的规则算**（`hostPlugins.ts` 的 `enabledNames`）：有覆盖用覆盖，没有用清单的 `defaultEnabled`。`overridden` 表示用户是否手动改过。
5. **「待重启」的判法**：有上报时，上报状态不是 `disabled`（即 `loaded`、`missing`、`rejected`，都表示宿主上次被要求加载它）与 `enabled` 不一致，就标 `pendingRestart`。没有上报时不判，也不显示宿主状态。
   - 不引入 supervisor 的选择键：IPC 只能经那三个函数，而逐插件比较已经足够说明「哪一个还没生效」。
6. **每次切换只写这一个插件的覆盖**：
   - 新覆盖 = 旧覆盖原样保留，再写上这一个插件的选择；已下架插件的覆盖也保留（它以后重新上架时，用户的选择还在）；
   - **切回与默认值相同的状态，照样记为覆盖**，不删掉这一条。按决策 110「只记用户亲手改过的插件」：用户碰过，就不再跟随以后版本的默认值变化；
   - 页面不提供「恢复默认」。
7. **「已下架」列表**：
   - 用户开着、但当前清单里已经没有的名字；
   - 宿主上次启动时丢掉的、不在清单里的名字（带宿主给的原因，如「not on the allowlist」）；用户关掉过的不列，那已经不是新消息；
   - 只列名字与原因，没有开关、没有删除。代价：这条覆盖一直留在设置里，列表就一直显示，直到以后重新上架。下架由工程经 PR 做、写进发版说明，极少发生，所以不为它加「清除」按钮。
8. **`enabledFrom: 'invalid'`**（宿主读不懂 Main 下发的值，失败关闭）单独给一条警告。

### 三、界面（「设置 > 扩展」里的「插件」一节，`DshPluginsSettings.tsx`）

9. **位置**：「扩展」页三节依次为技能、插件、旧版遗留内容。是一节，不是新页面；不新增对话框（没有 `DialogPopup`）。
10. **说明文字用我方自己的翻译**：
    - 每个白名单插件在页面里有一句自己的中英文说明，写成 `switch` 里的字面 `t('…')`，让目录覆盖扫描看得见；
    - 没有的就退回插件包自己的英文说明，取法与构建期 `displayOf` 相同（`locale/en.json` 的 `description`，否则 `package.json` 的）；
    - 静态测试要求白名单里每个插件在页面里都有对应的 `case`：以后往白名单里加插件，必须同时写它的说明，否则测试不过。
    - 不选「往白名单加一个说明字段」：要改清单模式、构建库、P1-10a 的测试，而且中文文案仍要进 i18n 目录；也不选「直接显示插件包的英文说明」：默认界面是中文，英文上屏按 `i18nCoverage` 的口径算缺陷。
11. **能力标签按过闸分类算**，不看插件自报的能力（决策 115 第 7 条：目录标的「只读」不作数）：
    - 写类工具：`warning` 色的「写入文件」徽章，后面列出全部工具名；
    - 读类工具：描边的「读取文件」徽章，列出工具名；
    - `ask` 类工具与 `'*': 'ask'`：「其他工具（每次先询问）」。
12. **来源与审查**：
    - `official` 显示「DSH 官方插件」，`internal` 显示「第三方插件，已经过本应用审查」；
    - 审查只显示日期与结论（通过 / 有条件通过）。审查人字段（现在是「代理审查，待用户审批」这种内部备注）和审查记录的仓库路径不上屏。
13. **切换后的提示按决策 108 第 7 条的真实行为写，不承诺立即生效**：
    - 文案：「插件的改动在对话引擎下次启动时生效；引擎正在运行时，会等所有对话都没有进行中的工作后自动重启。」这覆盖三种情况：没有宿主（下次启动即生效）、宿主空闲（`invalidateAll` 关停，下次对话启动新宿主）、有会话在忙（每 2 s 复查，含后台任务，即 `hasWorkInFlight`）；
    - 本次访问切换过，或者任何一行 `pendingRestart`，就显示这条；每行另有「待重启生效」徽章；
    - 不轮询：宿主状态在每次打开页面时重新读取。
14. **宿主状态**：已加载（有没启动的行时改为警告色并列出行）、已关闭、安装包中缺失、已拒绝加载；缺失与被拒显示宿主给的原因。原因是宿主写的英文技术信息，原样显示，不翻译。还没有上报时不显示状态徽章，只在列表下方说明一句。
15. **开关**：每行只有一个 `Switch`，用 `aria-labelledby` 指向插件名，不用 `label` 包着（base-ui 的开关是 `span` 加隐藏的 `input`，外层 `label` 会让一次点击切换两次）。保存期间所有开关禁用；保存失败显示错误，开关保持原位。白名单为空时显示空状态「没有可用插件」。
16. **页面上没有任何 pi 扩展的字样**（决策 090），静态测试与挂载测试都钉住。
17. **审批说法**：分节说明写「插件提供的工具和内置工具一样，要经过本应用的审批」。依据是决策 115 第 8～10 条：试点插件的 8 个工具全部在 `PLUGIN_TOOL_CLASSES` 里，读类与 DSH `read` 同等，写类与 `write` / `edit` 同等。只说工具调用，不说插件代码受沙箱约束（它与宿主同进程，方案 §4.5，审查才是防线）。

### 四、`piPluginsPermissionNoticeStatic.test.ts`

18. **删除，要点并进新的 `dshPluginsSettingsStatic.test.ts`**。
    - 它钉的是 `PiPluginsSettings.tsx` 的审批文案，而这个页面已经从「扩展」页卸下（决策 116 第 19 条），没有任何入口。给一个用户看不到的页面钉文案，什么都保护不了，反而让死文件看起来还有人维护；P1-12 删页面时也得一起删它；
    - 它长期有用的那一半是 cutover-02 的教训：插件页必须如实说明谁来审批插件的工具调用。这一半搬进新页面的静态测试（第 17 条的说法），钉在用户现在看得到的页面上；
    - `PiPluginsSettings.tsx` 本身照决策 104 第 5 条留到 P1-12 删；它的翻译随它一起删。

## 取舍

- **Main 另读清单，还是扩展宿主上报（第 2 条）**：备选是让宿主在 `ready.plugins` 里带上来源、工具分类、审查。那样要改宿主与 bridge 协议，而且第一次对话之前页面仍然是空的。清单本来就在安装目录里，Main 按宿主同样的规则读一遍，零协议改动。代价：决策 108 第 7 条「IPC 只调这三个」多了一个只读的补充来源，本决策加注说明。
- **切回默认值仍记覆盖（第 6 条）**：备选是「与默认相同就删掉这条覆盖」，这样以后版本改默认值时会跟着变。但决策 110 的口径是「用户亲手改过的就记下」，而且用户刚刚明确表态过，不应被以后的默认值悄悄推翻。
- **自带说明文案（第 10 条）**：每加一个插件要多写两行文案（中英各一），换来中文界面没有英文句子。
- **提示文案（第 13 条）**：备选是「已保存，立即生效」或「重启应用后生效」，都与 `reconcileHostPlugins` 的真实行为不符。

## 修订

- [决策 108](108-p1-10b-host-plugin-loading-choices.md)：第 7 条末尾与「影响与遗留」的 P1-10c 一条加注：IPC 另外只读白名单清单，见本决策第 2 条。
- [决策 104](104-legacy-asset-notice-and-extension-pages.md)、[决策 116](116-p1-16e-legacy-asset-notice-choices.md)：`piPluginsPermissionNoticeStatic.test.ts` 随 P1-10c 删除，要点并入新静态测试，见本决策第 18 条。

## 影响

- **用户看得见的不同**：「设置 > 扩展」多出「插件」一节，列出 `dsh-office-tools`（默认关）；打开后提示在对话引擎下次启动时生效。
- **改动的文件**：
  - 共享类型：`src/shared/dshPluginSettings.ts`（新）、`src/shared/types/ipc.ts`（两条通道）、`src/shared/i18n.ts`（22 条新文案，复用 4 条已有的：`Plugins`、`Loading plugins...`、`No plugins available`、`Switched off`）；
  - Main：`src/main/services/dshPlugins/pluginCatalog.ts`、`pluginsView.ts`（新）、`src/main/ipc/dshPlugins.ts`（新）、`src/main/ipc/index.ts`；
  - preload：`src/preload/index.ts`（`dshPlugins.list` / `setEnabled`）；
  - 渲染层：`src/renderer/components/settings/DshPluginsSettings.tsx`（新）、`SettingsContent.tsx`；
  - 测试：新增 `src/main/services/dshPlugins/__tests__/pluginCatalog.test.ts`、`pluginsView.test.ts`、`src/main/ipc/__tests__/dshPluginsIpc.test.ts`、`src/renderer/components/settings/__tests__/dshPluginsSettingsMount.test.ts`、`dshPluginsSettingsStatic.test.ts`；改写 `SettingsContent.test.ts`；删除 `piPluginsPermissionNoticeStatic.test.ts`。
  - `settingsMainOwnedKeys`：`dshPlugins` 键在 P1-10b 已归 Main 所有并有测试，本次不用补。
- **没有改**：宿主、bridge、白名单与构建脚本、`dshHostPlugins.ts` 与 `dshPluginSelection.ts`、`implementation-status.md`、`roadmap.md`。

## 遗留

- **`replaces` 的继承在决策 110 之后失效了（P1-10b 的问题，本次没改）**：宿主的 `enabledNames` 只返回白名单上的名字，覆盖里写着旧名时不会传给继任者，`targetProfileBundles` 里按 `replaces` 继承的分支从覆盖这条路走不到。现在白名单里没有插件用 `replaces`，所以没有实际影响；本页照宿主的现行规则算，不自己做继承。第一次有插件改名时要一并修。
- **徽章字号**：共用的 `Badge` 原语在宽屏下是 12px，而 design-system 要求可能出现中文的地方至少 14px。全仓的徽章都这样，本次沿用，不单独改原语。
- **没有做 GUI 点验**（本机不启动 Electron）：挂载测试覆盖了渲染、切换、各状态与空状态，外观需要编排者或用户点验。
