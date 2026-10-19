# 审查记录：`dsh-office-tools@1.0.6`

- 审查日期：2026-10-14
- 审查人：DSH 升级 0.2.0-rc.2 的实现会话（自主审查，待用户审批，见[决策 189](../../../../docs/plantree/plans/dsh-rebase/decisions/189-dsh-0-2-0-rc-2-upgrade.md)）
- 性质：**增量审查**，对照上一份[`dsh-office-tools@1.0.4` 记录](dsh-office-tools-1.0.4.md)。本记录只写变化与重新核对的结论，没变的部分沿用上一份。
- 审查对象：registry 上的 tarball（`npm pack` 取回 1.0.4、1.0.5、1.0.6 三个版本，逐文件比对哈希、逐行比对 `lib/index.js`），不是 GitHub 源码
- 钉住的 DSH：`0.2.0-rc.2`
- 触发：1.0.4 的复审条件第 2 条（DSH 升版）。1.0.4 声明的五个 `@deepseek-ai/dsh-*` peer 全部止于 `<0.2.0`，DSH 自己的 `evaluatePluginCompatibility`（预发布参与匹配）判定它与 `0.2.0-rc.2` 不兼容：开着插件时 app-boot 会跳过这个 bundle，构建期审计按决策 082 不许豁免。所以插件必须随 DSH 一起升版。

## 结论：有条件通过（条件与 1.0.4 相同）

1. 仍然默认关闭（`defaultEnabled: false`）。
2. 过闸分类不变：3 个读工具按「读」、5 个写工具按「写」。
3. 复审触发条件不变（见 1.0.4 记录第 10 节）。
4. 新增一条已知变化：生成的 Office 文件里可能多出 `dshPadding/padN.xml` 填充部件（第 4 节），需要在 Windows 测试包上用 Office 打开一次生成的文件确认不报修复。

## 1 身份与许可

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-office-tools@1.0.6`（`latest`，发布于 2026-10-13；1.0.5 发布于 2026-10-01） |
| integrity | `sha512-o48Ddpy7AqTLXTIvsTXkN0VST7EaXaNL7VnBQfHqa9/Hu2cGa+gBWpoJDxDMPFXlkUKalKkvLv8d7xV4ZzN67A==`（registry 元数据、锁文件、本地对 tarball 重算三者一致） |
| shasum | `776a1b0c9045e638b453d708455686353a31c26c` |
| 来源 | `https://registry.npmjs.org/dsh-office-tools/-/dsh-office-tools-1.0.6.tgz` |
| 发布者 / 维护者 | 仍是 npm 账号 `kw767`（唯一维护者）；`gitHead 6c9faa36…` |
| 许可 | MIT，`LICENSE` 与 1.0.4 逐字节相同 |

## 2 安装期

与 1.0.4 相同：`scripts` 只有构建与测试脚本，没有 `preinstall` / `install` / `postinstall` / `prepare`；没有原生件、没有 `bin`、没有 `dsh.client`。tarball 仍是 17 个文件，文件清单不变，解包 160,994 B（1.0.4 为 157,076 B）。

## 3 依赖闭包与 peer

- 运行期依赖仍为 0。`devDependencies` 多了 `semver`、`@types/semver`，不进安装树。
- 五个 dsh peer 变成 `^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.5-alpha.0 || >=0.2.0-rc.1 <0.3.0-0`（全部 optional），`cordis ^4.0.1` 不变。
  - DSH 的 `evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')` 判定兼容（构建期审计再判一次）。
  - npm 的匹配：`0.2.0-rc.2` 与比较符 `>=0.2.0-rc.1` 同属 `0.2.0`，本身就满足，不再报 `ERESOLVE`。宿主 `package.json` 的 `overrides` 仍按决策 082 第 3 条保留并钉到 `0.2.0-rc.2`（`checkOverrides` 要求与宿主版本一致），现在只起「peer 一定用宿主那一份」的作用。
- 未声明的 `@deepseek-ai/schemastery` 仍然只靠宿主树顶层提升解析：0.2.0-rc.2 的锁文件里 `node_modules/@deepseek-ai/schemastery` 仍在顶层（版本见决策 189 证据）。
- `dsh.compatibility.dshReleases` 只列到 `0.2.0-rc.1`（DSH 准入不读，只作参考）。

## 4 代码变化（`lib/index.js` 2353 → 2403 行）

1.0.5：

- **ASCII 安全 ZIP 写入器重写**。插件经 `ctx.fs.writeText` 以文本写出 Office 包，所以 ZIP 的每个字节都必须是 ASCII。旧算法在条目末尾补最多 64 KiB 换行去碰一个 ASCII 安全的 CRC 与长度，碰不到就报「cannot lay out an ASCII-safe zip entry」；新算法直接算出 ASCII 安全的长度与偏移（`nextSafeField`），在内容末尾补 8 字节空白来凑 CRC（`safeCrcSuffix`），条目数不安全时补 `dshPadding/padN.xml` 填充部件，并在 `[Content_Types].xml` 里为它们登记 `Override`（已有 `xml` 的 `Default` 时不登记）。
- 新的拒绝条件：条目内容含非 ASCII 字符、条目重名、生成的包超过 50 MiB。
- `ppt_create` 最多 200 张幻灯片（含标题页）。

1.0.6：

- `ppt_read` 把非表格的 `graphicFrame`（OLE 对象、图表等）报成 `graphicFrame`（示意图标签 `FRAME`），以前报成空表格；没有替代文字时不再输出 `alt: undefined`；工具参数说明与 `lib/types/tools/ppt.d.ts` 的元素类型同步加了 `graphicFrame`。

判断：都是插件自身格式处理的修复，不涉及新的外部接口。对用户可见的变化只有生成的包里可能多出填充部件，列为结论第 4 条的现场核对项。

## 5 敏感 API

重新逐项核对，import 集合与 1.0.4 完全相同：`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（`defineTool`）、`node:zlib`（`inflateRawSync`）、`node:path`。用到的宿主接口也相同，只是行号后移约 53 行：

| 接口 | 1.0.6 行号 |
|---|---|
| `ctx.tools.register` | 879、957、1032、1734、1840、1957、2233、2319 |
| `ctx.effect` | 2388 |
| `fs.resolve` / `contains` / `processPath`（工作区检查） | 456–461 |
| `fs.readBytes` | 479、1317 |
| `ctx.fs.writeText`（唯一写入点） | 485 |
| `ctx.fs.sandboxMode`、`sandboxPolicy` | 419–422 |
| `inflateRawSync` | 8、297 |

`process` 的任何属性、`child_process`、网络、`eval` / `new Function` / `require`、计时器、`ctx.on`、凭据、`vm` / `worker_threads`、猴子补丁：在 1.0.4 → 1.0.6 的全部改动行里都没有出现，全文也仍然没有。构建库的静态扫描与 E8-A 审查守卫的结果见决策 189 的验证一节。

## 6 钩子

不变：没有 `ctx.on`，不监听审批、请求或提示词事件。

## 7 工具与过闸分类

8 个工具名不变，读写性质不变，`PLUGIN_TOOL_CLASSES` 与白名单 `tools` 不用改。`ppt_read` 的输出多了一种元素类型，仍是只读。

## 8 数据去向、9 平台与加密机

与 1.0.4 记录相同。补一条：新版仍只经 `ctx.fs.writeText` 写会话工作区内的那一个文件，加密机上的行为与 1.0.4 相同（P1-13 检查单那一项照旧）。

## 10 复审触发条件

同 1.0.4 记录第 10 节。
