# D47 S0-E5 spike：cch 网关无效 key 拒绝形状实测

来源需求：`docs/plans/2026-08-15-login-management-design-spec.md` §4/§10 O3 —— 失效判定链
"业务 401/403 → 一次 `POST {cch}/api/auth/login {key}` auth-probe → probe 明确拒绝才算失效终局证据"
需要一份真实拒绝形状证据。本 spike 只做 HTTP 探测，未改任何产品代码。

## 结论（≤10 行）

1. `dev.env` 的 `ANTHROPIC_BASE_URL=https://api.vllmproxy.com` 经证实是开源 **"New API"**（统一 AI 网关 + 管理面板）的公开实例，不是本项目 `UsageService.ts` / `OnboardingService.ts` 所指的自建 cch 后端——首页 HTML `<title>New API</title>`、响应头 `x-new-api-version` / `x-oneapi-request-id` 均指向 New API 本体。
2. 在该主机上对 `/api/auth/login`（无效 key / 真实 key）、`/api/actions/my-usage/getMyTodayStats`（无效 bearer / 真实 bearer）、`/api/auth/nonexistent`（故意不存在路径）共五次探测，**全部返回完全相同的响应形状**：`HTTP/2 404` + `{"error":{"message":"Invalid URL (METHOD path)","type":"invalid_request_error","param":"","code":""}}`。
3. 因此在当前 `dev.env` 配置下，「key 无效」「路径不存在」「未命中此网关的业务路由」在客户端**不可区分**——五组探测的 status/body 逐字节相同，只有 message 里的 method+path 回显不同。
4. 这不是 auth-probe 语义本身的反例，而是探测目标选错了主机：本项目真正的 cch 后端地址应取自 `OnboardingService.deriveCchBaseUrl`（即注册响应 `config.claude.baseUrl` 去掉 `/v1`），而 `dev.env` 里的 `ANTHROPIC_BASE_URL` 只是喂给 Claude Code CLI 做模型补全用的网关，二者在本机是两个不同主机。
5. 因此本 spike **未能**拿到规格所需的「cch 对无效 key 的真实拒绝形状」证据，也未能实测 login 成功时的 `set-cookie` cookie 名（`UsageService.ts` 里按 `auth-token` 提取，但因拿不到真实 cch 后端无法验证）。
6. 后续动作二选一：(a) 找到本项目自建 cch 后端的真实地址后重跑本文档的 a–e 五组探测；(b) 走通一次真实 onboarding 注册流程拿到 `config.claude.baseUrl` 后再探测。在此之前，O3 的「auth-probe 拒绝形状」假设仍未经真实网关验证。

## 环境

- 探测主机（cch base，按规格公式 `ANTHROPIC_BASE_URL` 去掉末尾 `/v1`；本例无 `/v1` 后缀，故原样使用）：`https://api.vllmproxy.com`
- 结果显示该主机实为 New API 网关本体，非本项目 cch 后端（见结论 1）
- 请求预算：使用 6/10（a–e 五组规定探测 + 1 组诊断性 `GET /` 用于确认主机身份）
- key 处理：全程通过环境变量引用，未在任何命令回显或产出中出现明文；下方 fixture 与命令模板中一律 `<REDACTED>` / `$KEY`

## Fixture（五组，body/header 均已打码）

### a. 无效 key → `/api/auth/login`

```
POST https://api.vllmproxy.com/api/auth/login
Content-Type: application/json
{"key":"sk-bogus-invalid-000"}

→ HTTP/2 404
  content-type: application/json; charset=utf-8
  server: cloudflare
  x-new-api-version: v1.0.0-rc.24
  x-oneapi-request-id: 202608151645422852188548268d9d6FofZ2qpq

{"error":{"message":"Invalid URL (POST /api/auth/login)","type":"invalid_request_error","param":"","code":""}}
```

### b. 真实 key → `/api/auth/login`

```
POST https://api.vllmproxy.com/api/auth/login
Content-Type: application/json
{"key":"<REDACTED>"}

→ HTTP/2 404
  content-type: application/json; charset=utf-8
  server: cloudflare
  x-new-api-version: v1.0.0-rc.24
  x-oneapi-request-id: 202608151645442163364588268d9d6wx8dDU7D
  （无 set-cookie —— 未命中 cch 的登录路由，无法验证 auth-token cookie 名/属性）

{"error":{"message":"Invalid URL (POST /api/auth/login)","type":"invalid_request_error","param":"","code":""}}
```

### c. 无效 bearer → `/api/actions/my-usage/getMyTodayStats`

```
POST https://api.vllmproxy.com/api/actions/my-usage/getMyTodayStats
Authorization: Bearer sk-bogus-invalid-000
Content-Type: application/json
{}

→ HTTP/2 404
  content-type: application/json; charset=utf-8
  server: cloudflare
  x-new-api-version: v1.0.0-rc.24
  x-oneapi-request-id: 202608151645460647600398268d9d6Gm002PGx

{"error":{"message":"Invalid URL (POST /api/actions/my-usage/getMyTodayStats)","type":"invalid_request_error","param":"","code":""}}
```

### d. 真实 bearer → `/api/actions/my-usage/getMyTodayStats`

```
POST https://api.vllmproxy.com/api/actions/my-usage/getMyTodayStats
Authorization: Bearer <REDACTED>
Content-Type: application/json
{}

→ HTTP/2 404
  content-type: application/json; charset=utf-8
  server: cloudflare
  x-new-api-version: v1.0.0-rc.24
  x-oneapi-request-id: 202608151645478235381298268d9d6QXWOXxyi

{"error":{"message":"Invalid URL (POST /api/actions/my-usage/getMyTodayStats)","type":"invalid_request_error","param":"","code":""}}
```

### e. 故意不存在的路径 `/api/auth/nonexistent`

```
GET https://api.vllmproxy.com/api/auth/nonexistent

→ HTTP/2 404
  content-type: application/json; charset=utf-8
  server: cloudflare
  x-new-api-version: v1.0.0-rc.24
  x-oneapi-request-id: 202608151645496443686908268d9d6dzUF9cbc

{"error":{"message":"Invalid URL (GET /api/auth/nonexistent)","type":"invalid_request_error","param":"","code":""}}
```

### 附：诊断性第 6 探测 `GET /`（确认主机身份，未计入规定的 a–e）

```
GET https://api.vllmproxy.com/

→ HTTP/2 200, content-type: text/html
<title>New API</title>
<meta name="description" content="Unified AI API gateway and admin dashboard." />
```

结论：五组探测（a–e）status/body 一致，均为 New API 的通用 404 兜底；`GET /` 证实该主机是 New API 管理面板本体，不是本项目自建 cch 后端。

## 复现命令模板（key 用 `$KEY` 占位，绝不回显明文）

```bash
set -a; source dev.env; set +a
CCH="${ANTHROPIC_BASE_URL%/v1}"
KEY="$ANTHROPIC_AUTH_TOKEN"

# a. 无效 key → auth/login
curl -sS -m 15 -D - -X POST "$CCH/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"key":"sk-bogus-invalid-000"}'

# b. 真实 key → auth/login（观察 set-cookie）
curl -sS -m 15 -D - -X POST "$CCH/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$KEY\"}"

# c. 无效 bearer → 业务端点
curl -sS -m 15 -D - -X POST "$CCH/api/actions/my-usage/getMyTodayStats" \
  -H "Authorization: Bearer sk-bogus-invalid-000" \
  -H "Content-Type: application/json" -d '{}'

# d. 真实 bearer → 业务端点
curl -sS -m 15 -D - -X POST "$CCH/api/actions/my-usage/getMyTodayStats" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{}'

# e. 不存在的路径
curl -sS -m 15 -D - -X GET "$CCH/api/auth/nonexistent"
```

## 待回答问题的当前状态

- **无效 key 在 auth/login 与业务端点各返回什么 status/body？** 在 `dev.env` 当前配置的主机上二者均返回 `404` + New API 通用 `Invalid URL` 错误体，与「路径不存在」「未探测过的路由」完全同形——**这不是 cch 的 auth-probe 拒绝形状，是探测错了主机**。真实 cch 后端的拒绝形状仍未知。
- **「key 无效」与「网络/服务端错/404」在客户端可靠可区分吗？** 在本次实测的主机上**不可区分**（三者返回同一 404 兜底）。真实 cch 后端是否可区分，需换成 `OnboardingService.deriveCchBaseUrl` 得到的真实地址重测后才能回答。
- **login 成功时 set-cookie 的 cookie 名与属性？** 未能实测——未命中 cch 的登录路由，本次响应无 `set-cookie` 头。`UsageService.ts` 源码按 cookie 名 `auth-token` 提取（见 `extractCookieValue(setCookie, 'auth-token')`），但此值本身也需要真实网关验证。

---

## 补测（真 cch 主机，2026-08-15）

上一轮打错主机：`dev.env` 的 `ANTHROPIC_BASE_URL` 实为 New API 网关公开实例，不是本项目自建 cch 后端（见上文结论 1–6，原文不改）。用户提供了真实 cch 公网地址 `https://cch-jyw.pipidan.qzz.io`，本节在该地址上重跑 a–e 探测，更新结论。

### 结论（修订，≤10 行）

1. `https://cch-jyw.pipidan.qzz.io` 是一个真实 claude-code-hub 实例——边缘 `server: openresty`，后端 `x-powered-by: Next.js`（app router），与上一轮误测主机（`server: cloudflare` + New API）在基础设施层面即可区分，反向印证了上一轮"打错主机"的判断是对的。
2. 无效 key → `POST /api/auth/login`：`HTTP/2 401` + JSON `{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}`。结构化、专属、带 `errorCode` 锚点，是可靠的拒绝信号。
3. `dev.env` 的 `ANTHROPIC_AUTH_TOKEN`（New API 网关 key，非 cch key）打到真 cch 登录端点，返回与 #2 逐字节相同的 `401 KEY_INVALID`——**证实它确实不是 cch 的有效 key**，符合预期，如实记录。因未登录成功，无 `set-cookie`；**有效 key 的登录成功形状 / cookie 名本轮仍未验证，欠 valid 臂，留待 E1-lite 注册拿到真实 cch key 后补测**。
4. 无效 bearer → `POST /api/actions/my-usage/getMyTodayStats`：`HTTP/2 401` + JSON `{"ok":false,"error":"认证无效或已过期"}`——与登录端点的错误体 schema **不同**（无 `errorCode`，多 `ok:false`），说明 cch 全站错误体结构不统一，客户端判据不能假设单一 schema。该响应还带 `warning: 299 - "The /api/actions API is deprecated; use /api/v1"` + `sunset: Thu, 31 Dec 2026 00:00:00 GMT`——`/api/actions/*` 已被 cch 标记弃用，继任者是 `/api/v1`；这是 `UsageService.ts` 的技术债，顺带记录，不在本 spike 处理范围内。
5. `GET /api/auth/nonexistent`（`/api` 命名空间内不存在的路径）：`HTTP/2 404` + `content-type: text/html`，返回 Next.js app-router 标准 404 页（HTML，非 JSON）——与"key 无效"的 `401 + application/json` 在 **status 和 content-type 两个维度同时不同**，可靠可区分。
6. `GET /totally-bogus-random-path-xyz123-qwerty`（`/api` 命名空间外的乱路径）：`HTTP/2 307` 重定向到 `/zh-CN/login?from=...`——前端 SPA 未匹配路由的兜底（导到登录页），既非 401 也非 404，与前两种形状都不同，同样可靠可区分。
7. **核心问题结论（修订）**：在真实 cch 主机上，「key 无效」（401 + `application/json` + `errorCode`/`ok:false`）与「路径不存在」（404 + `text/html`）、「未匹配路由」（307 + `Location: /login`）在 status / content-type / body 结构三个维度上**完全可区分**，客户端可用简单判据函数可靠识别；上一轮"同形不可区分"是主机选错导致的假阴性，真 cch 上该假设**不成立**——auth-probe 语义本身是可行的。
8. 仍欠的证据只剩一项：**有效 key 的完整成功路径**（login 200 + `set-cookie` 的 `auth-token` 名/属性 + 业务端点用有效 bearer 的成功体形状），需要 E1-lite 走通一次真实注册后用真实 cch key 补测。

### 探测组 fixture（本轮 5 次请求，均已打码；curl exit 均为 0，无传输层错误）

#### a. 无效 key → `/api/auth/login`

```
POST https://cch-jyw.pipidan.qzz.io/api/auth/login
Content-Type: application/json
{"key":"sk-bogus-invalid-000"}

→ HTTP/2 401
  server: openresty
  content-type: application/json
  cache-control: no-store, no-cache, must-revalidate
  x-frame-options: DENY
  x-content-type-options: nosniff

{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}
```

#### b. dev.env `ANTHROPIC_AUTH_TOKEN`（非 cch key）→ `/api/auth/login`

```
POST https://cch-jyw.pipidan.qzz.io/api/auth/login
Content-Type: application/json
{"key":"<REDACTED-DEV-KEY>"}

→ HTTP/2 401
  server: openresty
  content-type: application/json
  cache-control: no-store, no-cache, must-revalidate
  x-frame-options: DENY
  （无 set-cookie —— 登录被拒，未触发 cookie 签发）

{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}
```

结论：与 fixture a 逐字节相同 —— dev key 在 cch 侧被当作普通无效 key 处理，两者拒绝形状无区别。

#### c. 无效 bearer → `/api/actions/my-usage/getMyTodayStats`

```
POST https://cch-jyw.pipidan.qzz.io/api/actions/my-usage/getMyTodayStats
Authorization: Bearer sk-bogus-invalid-000
Content-Type: application/json
{}

→ HTTP/2 401
  server: openresty
  content-type: application/json
  cache-control: no-store
  deprecation: @1777420800
  link: </api/v1/openapi.json>; rel="successor-version"
  sunset: Thu, 31 Dec 2026 00:00:00 GMT
  warning: 299 - "The /api/actions API is deprecated; use /api/v1"

{"ok":false,"error":"认证无效或已过期"}
```

#### d1. 不存在的 `/api` 路径 `/api/auth/nonexistent`

```
GET https://cch-jyw.pipidan.qzz.io/api/auth/nonexistent

→ HTTP/2 404
  server: openresty
  content-type: text/html; charset=utf-8
  content-length: 8085
  x-powered-by: Next.js
  x-nextjs-cache: HIT

<!DOCTYPE html>...<title>404: This page could not be found.</title>...
  （Next.js app-router 标准 404 页，HTML 全文 8085 字节，已截断；无 JSON error 体）
```

#### d2. `/api` 命名空间外的乱路径 `/totally-bogus-random-path-xyz123-qwerty`

```
GET https://cch-jyw.pipidan.qzz.io/totally-bogus-random-path-xyz123-qwerty

→ HTTP/2 307
  server: openresty
  location: /zh-CN/login?from=%2Ftotally-bogus-random-path-xyz123-qwerty
  x-served-by: cch-jyw.pipidan.qzz.io

/zh-CN/login?from=%2Ftotally-bogus-random-path-xyz123-qwerty
```

#### e. 有效 key 的 `set-cookie`（欠测）

未触发——fixture b 中的 dev key 被 cch 判定无效（401），登录未成功，响应无 `set-cookie` 头。`auth-token` cookie 名/属性仍需 E1-lite 后用真实 cch key 补测。

### 判据伪码（客户端可实现）

```
function classifyAuthProbe(response):
    if response.transportError:                          # 超时/连接失败/DNS 等
        return NETWORK_ERROR

    if response.status == 401 and startsWith(response.contentType, "application/json"):
        body = tryParseJson(response.body)
        if body and (body.errorCode == "KEY_INVALID" or body.ok == false):
            return KEY_INVALID                            # 可靠：计入 O3 失效终局证据
        return AUTH_REJECTED_UNKNOWN_SHAPE                 # 401+JSON 但 body 形状意外，记录但不轻易终局判定

    if response.status == 404 and startsWith(response.contentType, "text/html"):
        return PATH_NOT_FOUND                              # 绝不计入 key 失效证据——是路由/探测目标问题

    if response.status in (301, 302, 307, 308) and contains(response.headers.location, "/login"):
        return UNMATCHED_ROUTE_REDIRECT                     # 绝不计入 key 失效证据——前端兜底路由

    return UNKNOWN_SHAPE                                    # 未见过的形状，记录上报，不做终局判定
```

应用到 O3 的失效判定链：只有 `classifyAuthProbe(loginResponse) == KEY_INVALID` 时才可判定为"probe 明确拒绝"的失效终局证据；`PATH_NOT_FOUND` / `UNMATCHED_ROUTE_REDIRECT` / `NETWORK_ERROR` / `UNKNOWN_SHAPE` 均需转入"探测失败/基础设施异常"分支，不得当作 key 失效处理。

### 待回答问题（修订）

- **无效 key 在 auth/login 与业务端点各返回什么 status/body？** auth/login：`401 {"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}`；业务端点：`401 {"ok":false,"error":"认证无效或已过期"}`。两端点 body schema **不同**（前者有 `errorCode`，后者是 `ok:false`），判据函数需要同时兼容两种形状（见上方伪码），不能假设全站统一 error 体。
- **「key 无效」与「路径不存在/网络错」在真 cch 上是否可靠可区分？** **是**——三种场景在 status（401 / 404 / 307）与 content-type（`application/json` / `text/html` / 无 body 的重定向）两个维度上均不同，逐字节可区分，见结论 7。
- **login 成功时 set-cookie 的 cookie 名与属性？** 仍未验证——本轮唯一可用的 key（dev key）被 cch 判定无效，未触发登录成功路径。欠 valid 臂，需 E1-lite 走通注册拿到真实 cch key 后补测。

### 复现命令模板（真机，key 用 `$KEY` 占位，绝不回显明文）

```bash
CCH="https://cch-jyw.pipidan.qzz.io"
KEY="$ANTHROPIC_AUTH_TOKEN"   # 或 E1-lite 注册后拿到的真实 cch key

# a. 无效 key -> auth/login
curl -sS -m 15 -D - -X POST "$CCH/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"key":"sk-bogus-invalid-000"}'

# b. dev key（非 cch key，预期仍被拒）/ 换真 cch key 后可验证成功路径 + set-cookie
curl -sS -m 15 -D - -X POST "$CCH/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"$KEY\"}"

# c. 无效 bearer -> 业务端点
curl -sS -m 15 -D - -X POST "$CCH/api/actions/my-usage/getMyTodayStats" \
  -H "Authorization: Bearer sk-bogus-invalid-000" \
  -H "Content-Type: application/json" -d '{}'

# d1. /api 命名空间内不存在的路径
curl -sS -m 15 -D - -X GET "$CCH/api/auth/nonexistent"

# d2. /api 命名空间外的乱路径
curl -sS -m 15 -D - -X GET "$CCH/totally-bogus-random-path-xyz123-qwerty"
```

### 请求预算

本轮 5/8（a、b、c、d1、d2）。e（有效 key 的 `set-cookie` 观察）未触发，因 b 未登录成功；未额外消耗诊断请求，主机身份已由响应头（`openresty` + `Next.js` + `x-served-by: cch-jyw.pipidan.qzz.io`）直接坐实，无需再打 `GET /`。

## Valid 臂补齐（2026-08-15，E1-lite 注册后实打）

- `POST /api/auth/login {key:<valid>}` → `200` + `{"ok":true,"user":{"id":14,…,"role":"user"},"redirectTo":"/my-usage","loginType":"readonly_user"}`；
  `Set-Cookie: auth-token=<REDACTED>; Path=/; Max-Age=604800; HttpOnly; SameSite=lax`（7 天）。
- **关键发现**：`POST /api/actions/my-usage/getMyTodayStats` 带**有效** bearer 仍 `401 {"ok":false,"error":"认证无效或已过期"}`
  ——actions 端点只认 cookie 会话，不认裸 key bearer。带 `auth-token` cookie 重试 → `200` + 真实用量体。
- 推论（回写母规格 I6/§4）：UsageService 的「bearer 先试 → 401 → cookie login → 重试」路径**每次都会走到 cookie 分支**，
  业务 401 在 key 有效时也必然出现——**绝不能**把业务 401 直接当失效信号；`/api/auth/login` 的 `401 KEY_INVALID`
  是唯一权威判据（该判据两臂形状现已齐：valid=200+ok:true / invalid=401+KEY_INVALID）。
- E5 全臂收口，无欠账。
