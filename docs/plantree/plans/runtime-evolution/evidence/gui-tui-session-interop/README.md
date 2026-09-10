# GUI / TUI 会话互通可行性验证

日期：2026-09-10。基线提交：`3f6a61fd`。触发：用户 2026-09-10 推翻 TUI-1 方案 C，要求会话必须 GUI/TUI 互通，并要求先验证再定方案。

**结论：可行。**双向读写四轮交替全部通过，需补五处容忍度。验证全部在临时目录进行，未改动生产代码（`git diff` 干净）。

## 验证方法

两个方向都用**对方的真实读写器**，不伪造文件：

- CLI 侧用 `@earendil-works/pi-coding-agent` 的 `SessionManager.open` / `appendMessage`——`piTuiSession.ts` 的注释说明 `pi --session` 走的就是这个解析器。
- GUI 侧用本仓 `src/runtime/plugins/session/codec.ts` 的 `decodeSession`。

未使用真实模型：追加内容由 `SessionManager` 的写入 API 产生，与 CLI 实际写入路径同一份代码。

## 方向一：CLI 能否读我们的文件

| 用例 | 结果 |
|---|---|
| 纯 v4（`{"kind":"header","version":4}`） | 拒绝：`Session file is not a valid pi session` |
| 纯 v3（对照） | OK |
| **双格式头**（同时带 `type:"session"` 与 `kind:"header"`） | **OK** |

只要头一行补上 `type:"session"`，CLI 即可打开；我们 entry 行上多出的 `kind` / `lane` / `seq` 它直接忽略，不报错。

## 方向二：我们能否读 CLI 追加的行

初始状态**读不了**。逐字段定位后确认差异五处，其中后三处只有跑真实闭环才暴露：

| # | 差异 | 报错 | 发现方式 |
|---|---|---|---|
| 1 | CLI 行无 `seq` | `non-consecutive seq at line N` | 合成用例 |
| 2 | CLI 行无 `kind` | `unsupported JSONL kind: undefined` | 合成用例 |
| 3 | 外层 `timestamp` 是 ISO 字符串（`"2026-09-10T14:27:32.903Z"`），v4 要毫秒整数。注意内层 `message.timestamp` 仍是数字，只有 entry 外层是字符串 | `invalid entry identity` | 真实闭环 |
| 4 | CLI 追加后 lane 游标不前进，GUI 写下一条时接不上链 | `entry does not chain to lane` | 来回交替第 ② 轮 |
| 5 | CLI 的 `session_info` 类型 v4 没有（v4 用 `fact:'name'` 行表达会话名） | `unsupported entry type: session_info` | 追加会话名时 |

第 4 处最隐蔽：单向读完全正常，一来一回才炸。

`model_change`、`thinking_level_change`、`custom` 三种 CLI 也会写的 entry 类型，v4 侧本来就支持，无需处理。

## 闭环结果（补上 1～4 后）

```
① TUI 追加后，GUI 读:   OK — [GUI-1, TUI-1]
② GUI 追加后，GUI 读:   OK — [GUI-1, TUI-1, GUI-2]
③ GUI 追加后，CLI 读:   OK — GUI-1 → TUI-1 → GUI-2
④ TUI 再追加后，GUI 读: OK — [GUI-1, TUI-1, GUI-2, TUI-2]
```

双方看到的顺序与父子链完全一致。CLI 追加时正确沿用了我们写的 entry 作为 parent。

验证用的容忍逻辑（仅为验证，未提交）：entry 解码前把字符串 `timestamp` 转成毫秒；行级判断「既无 `kind` 又无 `seq`」时补 `kind:'entry'`、`seq: 上一条+1`、`lane:'main'`。

## 尚未验证

- **复杂形态**：压缩（compaction）、分支（branch）、工具调用在双向下的表现。本轮只覆盖纯文本消息与四种简单 entry 类型。
- **真实模型回合**：本轮追加内容由 SessionManager API 产生，未跑真实 provider 的完整轮次。
- **并发写入**：两边同时打开同一文件。这本质上要靠会话写入锁挡（`writerLock.ts`），不是格式能解决的问题。
- **CLI 版本漂移**：本轮针对本仓内置的 pi-coding-agent。CLI 升级改动 v3 写法时此结论需重跑。

## 复现

验证脚本未入仓（一次性探针）。复现要点：用 `SessionManager.open(file)` 打开一份双格式头的 JSONL，调 `appendMessage` 追加，再用 `decodeSession` 读回；来回至少两轮才能覆盖第 4 处差异。
