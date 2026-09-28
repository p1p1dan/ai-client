# 决策 047：工具按分类表过闸，未知与插件工具默认询问；plan 模式在调用时拒绝

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-6 方案 §5 D8、D9](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[分片 03 §2](../topics/p1-6-permissions/03-design.md)。

## 规则

1. 分类表：
   - 内部工具（todo、job、subagent、goal 等）直接放行；
   - 读、写、shell、skill、未知工具，构造成 `ToolPermissionRequest` 过闸；
   - 看不透内容的执行类（`workflow`、`run_code` 等 PTC 程序体）一律按「解析不出」处理，auto 档下也问。
2. 未知工具和插件工具走策略 `'*': 'ask'`，与 1.0.x 策略的兜底规则一致。分类表用静态守卫钉住，DSH 升级新增内置工具时会报警。
3. plan 模式：
   - 在 pre-execute 里拒绝写类、非只读 shell 和未知工具，工具目录不变；
   - bundle 关掉 DSH 的 `permission` 行，不让 DSH 的 `/permission` 和预设成为第二套档位入口；
   - `/plan`、`/permission` 从命令列表里隐藏。

## 取舍

- plan 模式不选「按模式隐藏写工具」：请求缓存会随模式变化失效；而且 DSH plan-mode 自己就是在调用时拒绝。
- 行为差异：plan 模式下模型能看到写工具，但调用会被拒。1.0.x 是直接隐藏。
- 未知工具不选「一律放行」（DSH 默认）：插件工具能写文件。
- 开工前要先做小实验：关掉 `permission` 行之后，宿主能否正常启动。
