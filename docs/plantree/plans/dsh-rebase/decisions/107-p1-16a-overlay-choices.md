# 决策 107：P1-16a 覆盖层实现取舍：沿用 P1-6c 的环境变量作单一来源，两行 overlay 放进 `hostProfile.ts`，INS-1 / SKL-1 用两轮 `P0-RECALL` 验证

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [决策 101](101-instructions-and-skills-dsh-native.md)（本任务的规则依据，第 1、2 条）；
- [决策 092](092-p1-6c-grants-and-setters-choices.md) 第 10、11 条（P1-6c 的路径下发实现）；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 16-1、16-2、16-5；
- [P1-10 / P1-16 分片 04](../topics/p1-10-p1-16-extensions/04-changes-and-tests.md)（INS-1、SKL-1 的原始定义、实验 E6）；
- `dsh-agent-instructions/README.md`、`lib/index.js:1271-1285`（baseline 折入 batch 的确切位置）；`dsh-skill-filesystem/README.md:44-77`；`dsh-tool-skill/README.md:52-54,222-234`；`dsh-base/cordis.patch.yml:288-304`。

## 规则

1. **路径下发不改名，沿用 `AICLIENT_PERMISSION_AGENT_DIR`**：本任务范围内不允许改动 `src/dsh-host/bridge/dshSessionRuntime.ts`（另一个代理在做 P1-4d1），而该文件的 `DshBridgeDeps.permissionAgentDir` 字段值就来自这个变量名（经 `bridge/plugin.ts` 的 `PERMISSION_AGENT_DIR_ENV` 读取）。改名收益只是名字更贴切（现在它还喂给指令与技能两行，不只是权限），不足以抵消牵动禁改文件的风险。`host.ts` 一侧新增的读取落在 `src/dsh-host/lib/hostProfile.ts` 的新常量 `AGENT_DIR_ENV`，与 `bridge/plugin.ts` 的 `PERMISSION_AGENT_DIR_ENV`、`src/main/services/agent-host/dshHostEnvironment.ts` 的 `DSH_HOST_PERMISSION_AGENT_DIR_ENV` 三处同值，由 `hostStatic.test.ts` 新增的静态守卫互相钉住；没有引入第二条下发通道（决策 101 第 1 条「一份路径、一个来源」）。
2. **覆盖层函数放进既有的 `hostProfile.ts`，不新建文件**：任务给出的文件范围明确列了 `src/dsh-host/lib/hostProfile.ts`，且这个新函数与文件里已有的 `requiredDisabledOverlays` / `requiredEnabledOverlays` 同属一类东西——host.ts 每次启动都要应用的纯规则、单测直接对拍、打包时随 host.ts 一起被 esbuild 进 `lib/`。`host.ts` 里 `overlays` 数组的新顺序是：
   ```ts
   overlays: [
     ...modelPlanOverlays(modelPlan),
     ...agentDirOverlays(agentDir),
     ...requiredDisabledOverlays(),
     ...requiredEnabledOverlays(),
   ],
   ```
   即「模型计划两行」之后、「必需项收尾两组」之前——延续了原有两组的相对顺序（决策 101 第 2 条要求「像 host.ts 现有的 in-memory overlay 那样放在用户层之后」，这三组本就都在用户层 patch 之后应用）。
3. **两行覆盖的内容**：
   - `agent-instructions`：`{ maxBytes: 65536, dshHome: agentDir }`。`65536` 不是新决定，是复述 `dsh-base/cordis.patch.yml` 里这一行的默认值——因为 `dsh-app-boot` 对同一 `id` 的补丁是整体替换 `config`（决策 101 第 2 条已指出），只写 `dshHome` 会让 `maxBytes`（必填字段）丢失。
   - `skill-filesystem`：`{ customSkillDirs: [\`${agentDir}/skills\`] }`。没有单独设置 `rank`：`rank: 300` 是 `dsh-skill-filesystem` 自己对 `custom` 来源固定分配的显示位次（见其 README 的根表），不是一个可配置字段。
4. **没有下发路径时两行都不生成**：`agentDirOverlays(undefined)` 返回空数组，`agent-instructions` 与 `skill-filesystem` 保持 `dsh-base` 的默认配置（前者仍是 `{maxBytes: 65536}`，落到 `$DSH_HOME/AGENTS.md`；后者 `customSkillDirs` 为空，只扫项目与用户默认根）。打包冒烟不传这个环境变量，符合决策 092 第 10 条「宿主的 bridge 行读取后经 deps 交给每个会话……打包冒烟不传它，就不读用户层」的既有约定，这里原样沿用到指令与技能两行。
5. **INS-1 / SKL-1 用两轮 `P0-RECALL`，没有改假网关**：
   - 第一轮不带任何 P0 / P1 标记，只需要满足两个条件：是会话的第一步（`agent-instructions` 的 baseline 只在「会话第一个可用的 pre-step」组装一次），以及消息里出现 `/ins-skl-smoke`（DSH 的技能手势，决策 101 第 3 条）。假网关对无标记消息的既有兜底是回一句纯文本（`fake gateway: no P0 scenario marker`），回合正常收尾。
   - 第二轮发 `P0-RECALL {"markers":["<AGENTS.md 标记>","<项目 CLAUDE.md 标记>","<技能正文标记>"]}`，复用假网关已有的 `RECALL` 脚本：它把「触发消息之前的全部消息文本」拼成 `history` 并逐个核对标记，回复 `present=…missing=-`。三个标记都要出现，断言 `reply` 精确等于 `present=A,B,C missing=-`。
   - 没有对 `fake-gateway.mjs` 做任何改动（零新增脚本、零新增标记）。
6. **给专用工作区显式建空 `.git` 目录，钉死 project root**：`dsh-agent-instructions` 的 `findProjectRoot` 在找不到 `.git` 时会一路爬到文件系统根、再回退用 cwd 本身（不是报错），理论上不放 `.git` 也能工作，但会让测试的确定性依赖于「从场景 cwd 到 `/` 之间不会意外撞见别的 `.git`」这种环境假设。显式建一个空 `.git` 目录是「典型 checkout」的默认形态，也是本文件其它同类测试惯用的做法，零成本地去掉这个假设。
7. **不改 `src/dsh-host/bundle/cordis.patch.yml`**：`agent-instructions` / `skill-filesystem` 两个 id 从未出现在 ai-client 自己的产品补丁里（`grep` 确认为空），它们完全来自 `dsh-base` 的默认组合；`host.ts` 的 `profileContext.overlays` 机制已经足以覆盖这两行的 `config`，不需要在产品补丁里预先占位或复述。

## 取舍

- **为什么不抓取原始 HTTP 请求体来直接验证「进了首个请求」**：假网关的 `--log` 只记录「请求里最后一条消息」的 200 字符摘要，不足以覆盖注入的指令/技能正文；而且经读编译源码确认，`agent-instructions` 的 baseline 实际上是被插在「已认领的消息之后」（`lib/index.js:1283-1284` 的 `lastClaimedIndex` / `toSpliced(lastClaimedIndex + 1, 0, desired)`），不是之前——这意味着即便在同一请求内做「trigger 之前的文本」检查，也抓不到它。要在同一请求内验证，只能新增假网关抓包机制（比如把完整请求体落盘），这是对 `fake-gateway.mjs` 的实质改动，而这个文件由我与 P1-4d1 的代理共享、约定只许追加。两轮 `P0-RECALL` 完全复用已经跑通的既有机制（P0-4 / P0-6 的 FS/RECALL 就是同一个模式），零新增假网关代码，冲突风险最低。
- **两轮验证是否等价于「首个请求」**：等价。`agent-instructions` 只在会话第一个可用的 pre-step 组装 baseline，此后不会因为「没在第一次请求里」而补发一次；`dsh-tool-skill` 的 `/name` 手势同理，只在包含该 token 的那一步注入一次。两轮验证只是把「观测时点」推迟了一轮，不改变「内容确实是在第一轮请求里被送出去」这个事实。
- **为什么不新建独立的 `agentDirOverlay.ts` 文件**：任务给出的可改文件范围明确写的是 `hostProfile.ts`；且 `hostProfile.ts` 本就是「host.ts 每次启动要应用的纯规则」的聚集地，新增一个概念相近的第三个 id 覆盖函数没有拆分的必要。

## 影响

- **测试**：
  - `src/dsh-host/lib/__tests__/hostProfile.test.ts` 新增 `agentDirOverlays` 的单测（有路径 / 无路径 / 空字符串）；
  - `src/dsh-host/__tests__/hostStatic.test.ts` 更新一条既有正则（`overlays` 数组多了一段），新增一条静态守卫（`hostProfile.ts` 的 `AGENT_DIR_ENV` 与另两处声明同值）；
  - `src/dsh-host/tools/bridge-smoke.ts` 新增专用 host H：一个独立的 `<agentDir>` 临时目录（内含 `AGENTS.md` 与技能）与一个带 `.git` 标记的专用工作区（内含项目 `CLAUDE.md`），验证 INS-1、SKL-1。
- **不受影响**：`src/dsh-host/bridge/dshSessionRuntime.ts`、`src/dsh-host/bundle/cordis.patch.yml`、渲染层、`src/shared/dshHistory`、`src/shared/types` 均未改动。
- **迁移 / 升级**：无行为迁移——这是新增的 DSH 原生读取路径，不改变任何已落盘的用户文件或已有会话。

## 遗留

- 技能出现在斜杠命令列表里（P1-4d2）、`/skill:` 改写与旧资产兼容报告均不在本任务范围内，分别归决策 099、101、104。
- 若将来决定把 `AICLIENT_PERMISSION_AGENT_DIR` 改成更贴切的通用名字，需要同时改 `src/dsh-host/bridge/dshSessionRuntime.ts`（当前由 P1-4d1 占用）与相关测试，建议放在 P1-4d1 合并之后再一起做，一次性改完并更新本决策与决策 092 第 10 条。
