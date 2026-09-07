# 批次四实现证据 — F10 本月调用次数改为周限额金额

> 日期：2026-09-07 · 分支：`feat/model-catalog-admin`。

## 判定

**为什么是金额不是次数**：次数回答的是没人问的问题——次数不是会用完的东西，
两次调用的成本可以差三个数量级。账户真正受限于金额（已确认口径），所以卡片改说那个数。

**为什么每个字段都可空、且都不给默认值**：「服务端没说」是一个真实状态，与零不同。
`limitUsd: 0` 是「不许花钱的账户」，`limitUsd` 缺失是「没人给这个账户配额度」，
两者渲染成同一个样子，正是卡片显示 `$0.00 / $0.00` 或 `NaN%` 的成因。
验收要求未配置时显示「暂不可用」，那就必须让「缺失」原样穿过整条链路。

## 接口契约

新增第三个 action：`POST {serverUrl}/api/actions/my-usage/getMyWeeklyQuota`，
返回 `data: { usedUsd, limitUsd, periodEnd }`。

**为什么不是在 `getMyStatsSummary` 上加字段**：那次调用的时间范围是**客户端**选的
（本月一号到今天），而周限额的周期是**服务端**拥有的。合成一个调用会让客户端选的月份范围
看起来也选择了那一周。

**为什么是非致命调用**：这个端点是新的，尚未部署的 onboard 会答 404。
用户自己的邮箱和退出登录按钮不能依赖一次额度查询——失败一律答 `null`，
卡片渲染成「暂不可用」，这对「还没部署」和「没配额度」都是诚实的答案。

## 改动

| 文件 | 内容 |
|---|---|
| `shared/types/usage.ts` | `WeeklyQuota` 类型；`UsageStatsResult` 成功分支增加 `weeklyQuota: WeeklyQuota \| null` |
| `shared/weeklyQuota.ts`（新） | `parseWeeklyQuota` / `formatQuotaUsd` / `deriveWeeklyQuotaView`（四状态） |
| `main/services/usage/UsageService.ts` | `tryFetchQuota` 复用同一份鉴权；排在两次必需调用**之后**，失败不影响已到手的数字 |
| `renderer/components/user/UserProfileCard.tsx` | 用周限额瓦片替换「本月调用次数」；进度条 + 剩余/超出行；四处硬编码 `'暂不可用'` 改走 `t()` |
| `shared/i18n.ts` | 新增四条；删除 `This month calls` 译文（它标注的瓦片已不存在） |

### 四状态

`unavailable`（什么都没到）· `no-limit`（有花费无上限）· `within` · `exceeded`。

中间两个是重点：**`no-limit` 时 `percent` 为 `null`，调用方不画进度条**。
百分比需要分母，用一个不存在的上限去除，就是 `NaN%` 换件衣服。
这条让该缺陷在类型层面不可达，而不只是「不建议」。

**上限恰好为 `0` 视为真实上限**，任何花费都算超出——被限制为零的账户是有人做过的决定，
把它报成无限制是把它反过来了。

**进度条封顶 100%**：溢出轨道的条不比 `exceeded` 状态多说任何东西，却会撑坏布局。

## 紧凑版 `UserFooterPill` 检查

已检查：它只读 `todayCostUsd`，从未显示过本月调用次数，因此**无需改动**。
本轮没有给它加超限提示——验收里的「超额状态可识别」指的是用户卡片，
在 24px 高、已经挤着邮箱和费用的一行里再加一个状态是另一个设计决定。

## 测试

- `shared/__tests__/weeklyQuota.test.ts`（新，11 项）：解析的宽严边界（缺分子答 `null`、
  缺上限保持缺失而不默认、`periodEnd` 不编造）；四状态；**null 输入不产生 NaN 也不产生百分比**；
  超限的溢出金额与封顶；零上限视为真实上限；金额格式与其他账户界面一致。
- `main/services/usage/__tests__/UsageService.test.ts` +2、改 2：
  额度端点 404 时其余数字照常返回、`weeklyQuota: null`；payload 不可用时同样答 `null`；
  两条既有用例补上第三次调用，并断言 cookie 重试路径下额度调用**复用同一份 cookie 鉴权**。
- `renderer/components/user/__tests__/userProfileQuota.test.ts`（新，4 项，happy-dom 真实渲染）：
  瓦片文案与 `$12.40 / $50.00`、`Remaining $37.60`；**「本月调用次数」确已消失**；
  无额度时显示「暂不可用」且页面上没有 `NaN`、没有百分号、没有进度条元素；
  超限着红并写出超出金额；**usage 整体失败时邮箱与退出登录按钮仍在**。

## 执行过的命令

| 命令 | 结果 |
|---|---|
| `npx vitest run src/shared/__tests__/weeklyQuota.test.ts` | 11 项通过 |
| `npx vitest run src/main/services/usage/__tests__` | 20 项通过 |
| `npx vitest run src/renderer/components/user/__tests__` | 4 项通过 |
| `npx vitest run src/shared/__tests__ src/main/services/usage/__tests__ src/renderer/components/user/__tests__ src/renderer/components/workspace-shell/__tests__ src/renderer/components/settings/__tests__ src/main/ipc/__tests__` | 60 文件 / 775 项通过 |
| `NODE_OPTIONS=--max-old-space-size=1200 npx tsc --noEmit` | 通过 |
| `npx biome check .` | 996 文件，0 error |

## 未验证项

1. **联调**：onboard 尚未提供 `getMyWeeklyQuota`。字段名、周期语义、以及真实额度数值
   都未与服务端对齐——本轮实现的是客户端契约段。
2. **登出后清理额度数据**：`UserProfileCard` 的登出已 `invalidateQueries(['usageStats'])`，
   且额度只存在于 query 缓存里（没有独立持久化），所以逻辑上随之失效；但未跑真实登出验证。
3. **周期更新后刷新**：`useUsageStats` 每 5 分钟轮询，周期翻转会在下一轮拿到新数值。
   未在跨周期时点验证。
4. **GUI 点验**：瓦片布局、进度条与超限配色未跑真实 Electron。
