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
