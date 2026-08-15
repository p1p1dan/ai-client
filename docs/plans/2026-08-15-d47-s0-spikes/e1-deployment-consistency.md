# S0-E1（lite）部署一致性实打 — 幂等假定线上实证

> 2026-08-15。方法 = 纯 HTTP 探测（不经 app、不写本地文件）；测试邮箱由用户提供并当场转码。
> 前情：幂等已由 onboard 服务源码定论（母规格 §5，`jc-dannauy/jyw-cch-onboarding` · `verify-and-register.ts:86-120`）；
> 本实打验证**线上部署实例**与仓库代码行为一致。key 明文全程不落盘不进报告，只留 SHA-256 前 16 位指纹。

## 方法与结果

| 步 | 请求 | 结果 |
|---|---|---|
| 1 | `send-code {email:"danyuan@jcdz.cc"}` | `200 {ok:true, expiresInSec:900, resendAfterSec:30}`——已注册邮箱不拒发（仅限流），与源码一致 |
| 2 | `verify-and-register {danyuan@jcdz.cc, code₁}` | `ok:true`；user `{id:14, name:"danyuan@jcdz.cc"}`；`claude.baseUrl = https://cch-jyw.pipidan.qzz.io`（根）、`codex.baseUrl = …/v1`；**apiKey/claude.authToken/codex.apiKey 三值逐字节相同**（指纹 `358fa1f37b03c0b6`，`sk-` 前缀，35 字符） |
| 3 | `verify-and-register {"DanYuan@JCDZ.CC ", code₂}`（**大小写+尾空格变体**，第二枚码） | `ok:true`；**同一 user id 14、同一 key 指纹 `358fa1f37b03c0b6`**——normalize 生效、幂等回发、不轮换 |

旁证：round 1 前该账号当日已有 71 次调用的真实用量（cch `getMyTodayStats`）——说明 round 1 走的就是
源码 `existing user → getKeys → 回发既有 enabled key` 分支，不是新建。

## 结论

1. **幂等假定线上 CONFIRMED**（源码 + 部署双证）：同邮箱（含大小写/空格变体）重复 verify 回发同一把 key，
   多机登录不互踢。登录 = 原两接口重跑，零新接口（S7 删除的裁定成立）。
2. **「同一把 key、两个 URL」口径线上实证**：三处 key 同值；claude = cch 根 URL、codex = `/v1` 变体。
3. 验证码语义：15 分钟有效、30 秒重发冷却、单次使用——登录 UX 文案照此写。

## 复现

```bash
curl -X POST $ONBOARD/api/onboarding/send-code -H 'Content-Type: application/json' -d '{"email":"<test>"}'
curl -X POST $ONBOARD/api/onboarding/verify-and-register -H 'Content-Type: application/json' -d '{"email":"<test>","code":"<code>"}'
# 比对两轮 data.apiKey 的 sha256；ONBOARD = https://onboarding-jyw.pipidan.qzz.io
```
