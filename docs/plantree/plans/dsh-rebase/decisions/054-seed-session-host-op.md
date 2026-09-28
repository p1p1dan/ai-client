# 决策 054：迁移与导入经宿主操作 `seedSession` 生成 DSH 会话；消息 id 复用 pi 条目 id

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-9 方案 §5 D5、D7](../topics/p1-9-migration.md#5-需要拍板的决策点)、[分片 03 §6](../topics/p1-9-migration/03-dsh-facts.md)。

## 规则

1. P1-3 的宿主控制协议新增 `seedSession`，有两种输入：`{kind:'pi-file', …}` 和 `{kind:'imported-conversation', …}`。
2. 宿主内的步骤：
   1. 只读读源，算 sha256。旧格式先找 `.native-v4.jsonl` 副本，规则同 1.0.x。
   2. 解码活动分支，构造种子，图片经 `ctx.attachments` 入库。
   3. `agents.create({seed})` → `sessions.flush`，再用 `observeSession` 核对事件数，然后 dispose。
   4. 写授权 sidecar，原子写桩（加 `origin`），回报告。

   之后按标准恢复路径打开。宿主内一次只做一个迁移，各阶段之间让出事件循环。
3. 不自己拼 zstd 帧，理由有五条：
   - 物理编码是 DSH 私有的，会随代际变化；
   - DSH 的构造器会校验；
   - 内核写锁由 DSH 管；
   - 加密机上只有宿主是白名单载体；
   - 附件库有自己的 fsync 链。
4. 源文件不动，靠三道保证：
   - 只读打开，不走 `JsonlSessionStore.open`；
   - 转换前后比对 size、mtime、sha256；
   - 离线工具对整个 profile 副本做前后哈希清单。
5. 幂等：种子是「源字节 + 转换器版本」的纯函数，id 和时间都取自源文件。已存在同 id 的会话时，事件数与摘要一致就复用，否则改用 `….m<n>`。
6. 消息 id 复用 pi 条目 id：预览时的 `h:<条目 id>` 与迁移后投影出的 `h:<MessageId>` 相同，渲染层合并无缝；合成的消息用「条目 id + 后缀」。

## 取舍

- 不选「在目标 slot 的 bootstrap 里迁移」：迁移耗时会被算进 bootstrap 超时。
- 不选「用低层 persistence 接口」：会绕过 agent 层的校验和插件。
- 不选「Main 自己写日志」：否决，理由同第 3 条。
- 代价：多一次恢复，大会话要多读一遍日志。
- 开工前做实验 E1、E3，与 P1-4b 的开工实验合做一次：E1 验证种子会话创建、释放后能马上恢复；E3 量大会话的耗时与内存。
