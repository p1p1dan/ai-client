# Open questions — 模型配置页迁入 onboard

**四问已于 2026-09-05 全部拍板**，各自的理由与连带改动见对应决策文件。
本文件只保留问题原文与去向，不再是活动 TODO。

| 问题 | 结论 | 决策 |
|---|---|---|
| Q01 全部停用（或未登录）时客户端拿到空配置怎么办？ | 空配置合法，客户端区分「拉到了是空的」与「没拉到」；硬编码的三个 `gpt-5.6-*` seed 兜底删除 | [D03](./decisions/003-empty-catalog-is-legal-drop-seed.md) |
| Q02 onboard 要不要显式返回 `pi: { baseUrl, apiKey }`？ | 要；加字段不改字段，客户端保留从 `codex` 推导作兼容 | [D06](./decisions/006-explicit-pi-block-in-register-response.md) |
| Q03 管理页自身的登录与权限是什么？ | 静态环境变量口令，未配置则整体 fail closed；留痕记不到人，只记时间/改动/IP | [D04](./decisions/004-admin-page-static-token.md) |
| Q04 M04 的默认 URL 具体长什么样？ | 端点挂 onboard 域名 `<onboardServiceUrl>/api/v1/models-config`；默认值按 手填 → 登录记录的 `onboarding.serverUrl` → 编译期注入值 取，不做推导 | [D05](./decisions/005-catalog-endpoint-on-onboard-origin.md) |

## 尚未回答（不阻塞 M01）

**管理页表单里那四个本仓 schema 没有对应字段的项**——默认思考强度、工具调用、
仅思考模式、允许关闭思考（见 [topic §四](./topics/wire-contract-and-constraints.md)）。
要先取证 pi 认不认这些概念、字段叫什么，才能决定是否做进表单；不能照抄截图标签。

本轮先做 `thinkingLevelMap`（它是唯一卡住既有功能的一项，
[U18](../pix-ui-alignment/roadmap.md) 之后没在表里点名的档位不会出现在下拉里）。
取证结果出来后再定其余四项，届时补决策。
