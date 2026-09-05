# Plan — 模型配置页迁入 onboard 并扩展

> **状态**：Completed（2026-09-05）。M01–M05 全部落地，取证见
> [evidence](./evidence/2026-09-05-m01-m05-model-catalog-admin.md)。
> 两个仓库的分支都只提交未推送，onboard 尚未部署；GUI 点验并入下一次累计点验。

## 范围

把模型配置（管理站）从本仓的本地单文件脚本迁到 onboard 服务里，作为 onboard 的一部分部署，
并补上今天做不到的三类能力：

1. **渠道级 URL / Key 覆盖开关**——每个渠道两个勾选项，勾上用管理员填的值，
   不勾用客户端登录 onboard 时拿到并保存的那份 `pi: { baseUrl, apiKey }`。四种组合都要成立。
2. **渠道与模型的启用开关**——管理员可以先添加、暂不启用。
3. **模型字段补齐**——首要是「支持的思考强度」（`thinkingLevelMap`），
   它是 [U18](../pix-ui-alignment/roadmap.md) 之后极端思考档能否出现的唯一开关。

跨两个仓库：`ai-client`（本仓，客户端）与 `jyw-cch-onboarding`（onboard 服务，本机在
`/home/ai/code/jyw-cch-onboarding`）。

## 不在范围

- onboard 现有的注册 / 验证码 / 限流逻辑不动。
- cch 网关本身不动。
- 本仓 `scripts/pi-model-admin.mjs` 不再扩写（[D02](./decisions/002-build-the-admin-page-in-onboard.md)），
  它的去留是迁移完成后的收尾项，见 roadmap M05。

## 阅读顺序

1. 本文件。
2. [Decisions](./decisions/)：[D01 拉取鉴权](./decisions/001-authenticated-catalog-fetch.md) ·
   [D02 施工位置](./decisions/002-build-the-admin-page-in-onboard.md) ·
   [D03 空配置合法·删 seed](./decisions/003-empty-catalog-is-legal-drop-seed.md) ·
   [D04 管理页静态口令](./decisions/004-admin-page-static-token.md) ·
   [D05 端点挂 onboard 域名](./decisions/005-catalog-endpoint-on-onboard-origin.md) ·
   [D06 显式 `pi` 块](./decisions/006-explicit-pi-block-in-register-response.md)。
3. [线上格式与约束](./topics/wire-contract-and-constraints.md)——三条硬约束与现状取证。
4. [Roadmap](./roadmap.md)：任务身份与顺序。
5. [Open questions](./open-questions.md)：四问已答；表单字段的 pi 取证结论见 evidence。
6. [Evidence](./evidence/2026-09-05-m01-m05-model-catalog-admin.md)：门禁、真机点验与跨仓联调。

## 权威

- 本 README 拥有范围与受影响仓库。
- `roadmap.md` 拥有任务 ID、状态与顺序。
- `decisions/` 拥有已拍板方向；`topics/` 拥有取证事实与约束。
- 本计划不覆盖 [Pi-only 计划](../pi-backend-migration/README.md) 与
  [UI 对齐计划](../pix-ui-alignment/README.md) 的任何既有权威。

## 依赖与相邻计划

- 与 [T38](../pi-backend-migration/roadmap.md)（runtime 补字段）**无依赖**，两件事互不阻塞。
- 与 UI 对齐计划的 [U08-2 思考档七档](../pix-ui-alignment/roadmap.md) 同源：
  U08-2 让客户端认得七档，本计划让管理员**声明**某个模型支持哪几档。缺任一半，极端档都出不来。
