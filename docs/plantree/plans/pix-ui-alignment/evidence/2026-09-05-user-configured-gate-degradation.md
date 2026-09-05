# Evidence — U20 `user_configured` 权限档明示降级

**日期**：2026-09-05
**分支**：`feat/pi-primary-backend`
**切片**：U20（由 [D10](../decisions/010-user-configured-gate-explicit-degradation.md) 开立）
**关闭的欠项**：[U12 rev.2 evidence](./2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md) 第五节第一条

## 一、取证：旧记录说错了一句

U12 rev.2 把这个缺陷记成「四档一律等同『务实』」。本轮读了本机用户自己的配置，
**这句话不成立**：

```
$ cat ~/.pi/agent/extensions/pi-permission-system/config.json
{
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": true
}
```

没有 `authorizerChain`，而且 `yoloMode: true` 会关掉全部权限检查。
所以这条路径上的实际行为是**用户自己的策略**，本机这份比任何一档都宽。
把它说成「等同务实」等于向用户承诺一层不存在的防护——**降级文案因此不许出现档位名**。

同时确认了触发条件的准确形状：`decidePermissionPlugin` 判的是
`settings.json` 的 `packages` 列表，不是 extensions 目录里有没有那个插件。
本机 `~/.pi/agent/settings.json` 的 `packages` 里确实有
`npm:@gotgenes/pi-permission-system`，所以 gate 判 `user_configured`。

## 二、落点

| 层 | 文件 | 改动 |
|---|---|---|
| shared | `types/runtimeEvents.ts` | `SessionCreatedEvent.payload` 加可选 `permissionGate` |
| main | `WorkerManager.ts` | 新 `gatePayload(entry)`，四个 `session.created` / `session.resumed` dispatch 点都带上；无 bootstrap 应答时**整个字段省略** |
| renderer | **新增** `stores/permissionGate.ts` | 订阅 runtime bus，记 per-session 的门；`isTierControlDegraded` 只对**已报告**的 `user_configured` 返回 true |
| renderer | `App.tsx` | 应用级挂一次 `startPermissionGateWatch()` |
| renderer | `ComposerPermissionTrigger.tsx` | 降级态：标签「你自己的策略」+ `ShieldQuestion`；菜单整体换成两行说明 |
| shared | `i18n.ts` | 3 个新键 |

## 三、两处不能含糊的地方

**① 三值，不是布尔。** 「已报告 bundled」「已报告 user_configured」「还没人报告」是三种状态。
把第三种折进前两种任意一种都是 bug：折进 bundled，界面会在 worker 起来前继续承诺四个能用的档；
折进 user_configured，每个还没启动的会话都会误报降级。所以 payload 里**没有值就省略字段**，
`isTierControlDegraded({}, 's1')` 必须是 `false`，两条都有单测钉住。

**② 监听挂在 App 层，不挂在读它的控件上。** 恢复会话的 `session.created`
可能早于 Composer 渲染；挂在控件里就会漏掉那一批，表现为"有时提示、有时不提示"。

## 四、文案范围（用户中途拍板收窄）

第一版面板写了四段：结论 + 原因 + 配置路径 + 可复制的 `authorizerChain` 片段 + 复制按钮。
用户看后拍板**「就告诉用户降级了就行，不用告诉他怎么去修改」**，砍到两行：

```
当前对话的权限档不生效
它跑在你自己 agent 目录里的权限系统上。
```

第二行说的是**策略来源**，不是修法。补救办法只留在 [D10](../decisions/010-user-configured-gate-explicit-degradation.md) 里，不进 UI。
随之删掉的还有 `permissionGateCopy.ts`（片段常量模块）与它的三条单测。

## 五、真机验证

复现要点：`dev.js` 是 `Object.assign(env, devEnvVars)`，**`dev.env` 会覆盖继承的
`PI_CODING_AGENT_DIR`**——直接 export 环境变量无效，第一次跑就因此拿到了 `bundled`。
改用 `AICLIENT_DEV_ENV_FILE` 指向一份把 `PI_CODING_AGENT_DIR` 改成 `/home/ai/.pi/agent`
的 dev.env 副本，才真的跑在用户自己的 agentDir 上。

| 观测点 | 结果 |
|---|---|
| 渲染层 store | `{"session-1788401661481-cvmdb3h":"user_configured"}` |
| 触发器标签 | 「你自己的策略」（不是任何档位名） |
| 触发器 tooltip | 「这个对话跑在你自己 agent 目录里的权限系统上，这里的档位不生效。」 |
| 展开菜单 | 两行说明，**没有**档位单选组 |
| 对照组 | 同一探针指向 `t37c-agent`（干净目录）时报 `bundled`，档位四项照常 |

## 六、门禁

| 项 | 结果 |
|---|---|
| 全仓 Vitest（`--maxWorkers=1 --no-file-parallelism`） | **271 files / 4162 tests pass** |
| `tsc --noEmit` | pass |
| `biome check src/` | 干净 |
| `git diff --check` | 干净 |

## 七、仍然没解决的

**档位在这条路径上依然没有功能**，只是不再假装有。真正恢复要走 D10 里记的
「始终注入随包副本」，前置是一个探针：pi 同时加载两份同名插件时，
是否每次问两遍、两份 config 怎么合并、用户的 `deny` 会不会被冲掉。三问都没答案前不动。
