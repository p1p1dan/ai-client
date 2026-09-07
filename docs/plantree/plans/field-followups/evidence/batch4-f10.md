# 批次四实现证据 — F10 本月调用次数改为周限额金额

> 日期：2026-09-07 · 分支：`feat/model-catalog-admin`。

## 判定

**为什么是金额不是次数**：次数回答的是没人问的问题——次数不是会用完的东西，
两次调用的成本可以差三个数量级。账户真正受限于金额（已确认口径），所以卡片改说那个数。

**为什么每个字段都可空、且都不给默认值**：「服务端没说」是一个真实状态，与零不同。
`limitUsd: 0` 是「不许花钱的账户」，`limitUsd` 缺失是「没人给这个账户配额度」，
两者渲染成同一个样子，正是卡片显示 `$0.00 / $0.00` 或 `NaN%` 的成因。
验收要求未配置时显示「暂不可用」，那就必须让「缺失」原样穿过整条链路。

## 接口契约（2026-09-07 修正：用 cch 自己的端点，不是我们新造的）

初稿写的是自造的 `getMyWeeklyQuota`。用户指出「cch 应该也有周限额的接口」，实测证实了这一点。

**探测方法**：D47 S0 E5 已确认真实 cch 上「路径不存在」与「未认证」在 status + content-type
两个维度可区分。据此对 `my-usage/` 命名空间做无凭据 POST 探测：

| action | 结果 | 判定 |
|---|---|---|
| `getMyTodayStats` | `401 application/json {"ok":false,"error":"未认证"}` | 存在（已知对照） |
| `getMyStatsSummary` | 同上 | 存在（已知对照） |
| **`getMyQuota`** | **同上** | **存在** |
| `getMyUsageLogs` | 同上 | 存在 |
| `getMyWeeklyQuota` · `getMyLimits` · `getMyQuota`(其他命名空间) · `getMyLimit` · `getMyWeeklyStats` · `getMyUsageLimit` · `getMyBudget` · `getMyUserInfo` · `getMyProfile` · 对照乱名 | `404 text/plain` | 不存在 |

**响应体已用真实 key 观测**（2026-09-07，`https://cch-jyw.pipidan.qzz.io`，密钥不入库）。
初稿从管理页文案猜的字段名（`costWeekly` / `limitWeeklyUsd` / `resetAt`）**全部不对**——
按那份代码跑，解析器会一律返回 null，卡片永远显示「暂不可用」。真实形状是**两层作用域**：

| | 5h | daily | **weekly** | monthly | total |
|---|---|---|---|---|---|
| `keyLimit*Usd` | null | null | **null** | null | null |
| `keyCurrent*Usd` | 0 | 0 | **0** | 0 | 2.0878 |
| `userLimit*Usd` | null | null | **1000** | null | null |
| `userCurrent*Usd` | 0 | 0.139 | **0.139** | 0.139 | 2490.4 |

cch 对每个消费窗口都记两遍：一遍算这把 key，一遍算持有它的 user。本 App 手里只有该 user
若干把 key 中的一把。**只读 key 作用域，会把一个明明有 $1000 周限额的账号报成「没配额度」。**

因此两个作用域都是候选，取**先卡住用户的那个**（剩余额度更少者；平手取上限更低者），
且每个候选带自己的已用金额——key 的周消费只算这把 key，user 的算他所有 key，
把一个作用域的上限配另一个的用量，得到的百分比不是任何东西的百分比。
两边都没设上限时，报 **user** 的消费额，因为那描述的是这个人而不是这一台安装。

**没有周期重置时间**：`dailyResetTime` 属于日窗口，`expiresAt` / `userExpiresAt` 是账号到期。
把任何一个读成本周结束，都会在卡片上放一个自信的错日期，所以 `periodEnd` 正常缺失。

**鉴权路径已实测确认**：有效 key 直接当 bearer 打 `getMyQuota` 仍返回
`401 {"ok":false,"error":"认证无效或已过期"}`；必须先 `POST /api/auth/login` 换 `auth-token`
cookie 才能读到——`UsageService` 既有的 401→login→cookie 重试链路是必需的，不是历史包袱。

**为什么仍是独立调用而不是在 `getMyStatsSummary` 上加字段**：那次调用的时间范围是**客户端**选的
（本月一号到今天），而额度窗口是**网关**拥有的。合成一个调用会让客户端选的月份范围
看起来也选择了那一周。

**解析为什么容错多个字段名**：端点的**存在**已由探测坐实，**响应体**未用真实 key 观测过。
每个别名指的都是同一个量；钉死一个猜测的代价是——名字对不上时会静默变成「暂不可用」，
而那与「没配额度」长得一模一样，没人能从界面上分辨。

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

1. ~~`getMyQuota` 的响应体~~ —— **已用真实 key 验证**（见上）。
   端到端跑过一次：live 响应 → `parseWeeklyQuota` → `deriveWeeklyQuotaView`，
   该账号得到 `{"usedUsd":0.13937024,"limitUsd":1000}` →
   卡片显示 `$0.1394 / $1000.00`、进度 0%、剩余 `$999.86`。
2. **登出后清理额度数据**：`UserProfileCard` 的登出已 `invalidateQueries(['usageStats'])`，
   且额度只存在于 query 缓存里（没有独立持久化），所以逻辑上随之失效；但未跑真实登出验证。
3. **周期更新后刷新**：`useUsageStats` 每 5 分钟轮询，周期翻转会在下一轮拿到新数值。
   未在跨周期时点验证；且 cch 的 payload 不含周期结束时间，界面上无法预告下次重置。
4. **GUI 点验**：瓦片布局、进度条与超限配色未跑真实 Electron。
