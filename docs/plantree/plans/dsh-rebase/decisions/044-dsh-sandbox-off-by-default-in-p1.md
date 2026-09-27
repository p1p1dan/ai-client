# 决策 044：P1 期间三个平台默认都关 DSH 沙箱，只靠我方审批；叠加能力放在设置开关后面（请重点审批）

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-6 方案 §5 D5](../topics/p1-6-permissions.md#5-需要拍板的决策点)、[决策 001](001-route-b-and-scope.md) 第 3 条、[Q002](../open-questions.md)。

## 规则

1. 产品 bundle 把 `sandbox-policy` 设为字面值 `danger-full-access`，`approval` 设为字面值 `ask`。这时审批只有我方一处，不会出现同一操作审批两次。
2. 叠加能力照样做完，放在设置开关后面，默认关。子任务 P1-6e 为可选，可以放到合入之后。
   - 开关打开后：ask / accept-edits / auto 用 `workspace-write`；bypass 用 `danger-full-access`；plan 用 `read-only`。
   - 同一个 callId 只出一张卡。
3. 各平台何时默认打开：
   - Linux / macOS：在开发机上实测常见命令的越界率之后再定，例如写 `~/.npm` 这类家目录缓存被拒的比例。
   - Windows：见[决策 045](045-windows-acl-sandbox-default-off.md) 与 P1-13 的加密机结论。

## 与决策 001 的关系

- 决策 001 第 3 条定的是：审批沿用我方模型，DSH 沙箱等实测后再决定是否叠加。本决策没有推翻它，只是把叠加的默认值定为关，并把判断时点推迟到实测之后。
- 暂时放弃的：Linux / macOS 上「验证通过就叠加」的那层兜底。

## 取舍

- DSH 沙箱只管写，不管读，也不管网络。拒读 `.env`、询问工作区外的读取，本来就只能靠我方。
- 默认关与 1.0.x 的审批体验等同，这正是决策 001 第 3 条的主要诉求。同时避开了几种新的失败形态：写家目录缓存被拒（推断）、没有 bwrap / Landlock 时的 `SANDBOX_UNAVAILABLE`、Windows ACL 的副作用。
- 代价：P1 期间没有沙箱这层兜底，与 1.0.x 相同。
