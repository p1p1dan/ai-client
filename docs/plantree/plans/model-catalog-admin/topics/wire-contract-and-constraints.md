# Topic — 线上格式与三条硬约束

本文件是开工前的取证事实与约束。行号是 2026-09-05 的快照，动工时按当时代码复核。

## 一、「不勾就用登录拿到的值」不能靠字段缺席表达

需求：每个渠道两个勾选项分别控制 baseUrl 与 apiKey；不勾则用客户端登录时保存的
`pi: { baseUrl, apiKey }`。四种组合都要成立。

**约束**：本仓有明确先例，「没说」和「说了是默认值」必须是两句不同的话——
权限档的 `permissionGate`（[D10](../../pix-ui-alignment/decisions/010-user-configured-gate-explicit-degradation.md)）、
插件清单的 `null` vs `[]`（[D06](../../pix-ui-alignment/decisions/006-plugin-inventory-source.md)）都栽在这上面。
因此必须给显式标记，不能用「字段不在就是继承」。

建议形状（开工时再定死）：

```jsonc
"providers": {
  "pilab": {
    "credentials": { "baseUrl": "managed" | "onboarding",
                     "apiKey":  "managed" | "onboarding" },
    "baseUrl": "https://…",   // 仅当 credentials.baseUrl === 'managed' 时出现
    "apiKey":  "sk-…"         // 仅当 credentials.apiKey  === 'managed' 时出现
  }
}
```

**客户端连带改动**：

- `PiManagedProviderDefinition.baseUrl` 从必填改可选（`configValidation.ts:121-122` 现在强制非空）；
- `PiModelConfigService.writeAuth()` 现在给**每个渠道写同一把登录 key**
  （`PiModelConfigService.ts:353-359`），要改成按渠道各取各的；
- 写 `models.json` 时把继承项替换成 vault 里的实际值——pi 需要一个具体 URL，不认「继承」。

## 二、启用开关应在服务端过滤，客户端不该知道停用项

pi 本身没有「停用」概念，`models.json` 里出现停用模型只会是噪音。
建议：管理端点返回全部（含停用，供管理员看），客户端端点只返回启用项。

**边界**：客户端现在要求 `models` 非空且至少有一个 provider
（`configValidation.ts:133-135`、`179-181`）。一个渠道模型全停用、或所有渠道全停用时，
服务端过滤后会产出空配置，客户端会判非法 → 落 `stale-cache` 或硬编码 `seed` 兜底。
两条路选一条，见 [Q01](../open-questions.md)。

## 三、含 key 的配置必须走鉴权

见 [D01](../decisions/001-authenticated-catalog-fetch.md)。这里只记两条现存红线的位置，
它们是「放开」时要精确修改的地方，不是要删掉的地方：

- `src/main/services/piModelConfig/configValidation.ts:118` — 渠道含 `apiKey`/`key`/`token`/`oauth` 抛错；
- `scripts/pi-model-admin.mjs` — 同一条黑名单（该脚本去留见 roadmap M05）。

## 四、管理页字段缺口（对照用户截图）

本仓 `scripts/pi-model-admin.mjs` 每个模型只有 ID / 显示名 / 上下文窗口 / 思考·普通四项。
截图里的参考形态还有：

| 字段 | 本仓 schema | 管理页表单 |
|---|---|---|
| 支持的思考强度 `thinkingLevelMap` | 有 | **无**（只能走 JSON 编辑模式手写） |
| 图片输入 `input: ['text','image']` | 有 | 无 |
| 输出上限 `maxTokens` | 有 | 无（新建时写死 16384，之后不可改） |
| 模型级协议 `api` / `compat` | 有 | 无（只有渠道级） |
| 默认思考强度 | **无对应字段** | 有 |
| 工具调用 / 仅思考模式 / 允许关闭思考 | **无对应字段** | 有 |

后三项要先确认 pi 认哪个字段才能落，不能照抄截图的标签。

`thinkingLevelMap` 是其中唯一**卡住既有功能**的一项：[U18](../../pix-ui-alignment/roadmap.md)
之后，模型没在这张表里点名的档位一律不出现在下拉里，所以管理页没有这个输入
= 通过表单添加的模型永远拿不到 Minimal / X-High / Max。
