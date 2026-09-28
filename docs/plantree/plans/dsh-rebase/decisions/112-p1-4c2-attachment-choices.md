# 决策 112：P1-4c2 发图、读图、文本附件的实现取舍：统一入库入口、拒绝的形状、附件库可信路径与闸的修正

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 096](096-images-via-dsh-attachments.md)、[097](097-text-attachments-as-dsh-file-blocks.md)、[093](093-interject-via-dsh-steer.md)（用户已批准，[决策 110](110-user-rulings-2026-09-28-batch2.md)）；[决策 010](010-p1-1-scope-boundary.md)、[044](044-dsh-sandbox-off-by-default-in-p1.md)、[090](090-user-rulings-2026-09-28.md) 总原则；[决策 111](111-p1-4c1-turn-semantics-choices.md) 第 4 条；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4c-4～4c-6、§8 第 2 个实验；[分片 04](../topics/p1-4-bridge-parity/04-turn-semantics.md) §3；
- 开工前实验：[evidence/p1-4c2-attachment-experiment-2026-09-28.md](../evidence/p1-4c2-attachment-experiment-2026-09-28.md)（第二次 18 项判定全部通过）；
- `dsh-attachment/lib/index.js`（`admitPromptContent`、`AttachmentError`）；`dsh-attachment-local/lib/index.js`（`fileLeafName`、存放路径）；`dsh-llm/lib/index.js`（`fileHandleText`、`fileReadPath`、`projectImagesForTextModel`）；`dsh-llm-pi-ai/lib/index.js`（`DEFAULT_INPUT = ['text']`）。

改动留在工作区，由编排者复跑后提交。

## 规则

### 一、开工前实验

1. 按重划 §8 第 2 条做了实验，脚本是 `src/dsh-host/tools/attachment-experiments.ts` 和只在实验里装的行 `tools/lib/attachment-experiment-row.mjs`（仿 P1-4c1 的 `steer-experiments.ts`，留在仓库里供复跑，不进产品包）。
   - DSH 这一侧的前提全部成立：沙箱关闭时句柄里的路径就是宿主路径，`read` 能读到；图片入库的成功与失败形状稳定。
   - 我方闸原样**不**满足「不出审批卡」，第一次跑 ask 档下读附件出卡（证据第 3 节）。补上第 5、6 条后第二次全部通过。
   - 缺口在我方代码，不是 DSH 做不到，所以判为「实验成立」，文本附件按决策 097 实现，不退回 1.0.x。**这一判断请用户确认**：决策 097 第 6 条原话是「不成立就退回」。

### 二、统一的入库入口

2. **一个入口**：`src/dsh-host/bridge/attachments.ts` 的 `admitUserContent(store, text, attachments)`，普通发送与插话都走它（决策 093 第 2 条）。
   - 没有附件：只有正文，不碰附件服务。
   - 有附件：先放正文，再按用户选的顺序放附件。正文为空时不放空的文本块（有的 provider 拒收空文本块），一条消息可以只有附件。
   - 图片：原样交给 `admitPromptContent`（base64、声明的类型、文件名）。bridge 不再查 1.0.x 的单个 5 MiB（决策 096 第 3 条）。
   - 文本附件：渲染层送来的是字符串，按 UTF-8 编码成字节交给 `saveFile`，文件名用用户的；DSH 自己清洗文件名（去掉路径、非法字符），没有名字时存成 `file`。
   - 最后一次 `admitPromptContent` 把整条消息交给 DSH：图片换成引用，文件块原样放行。
3. **拒绝**：`ctx.attachments.isAttachmentError()` 认得的错误，都在发任何事件之前改抛 `WORKER_ATTACHMENT_REJECTED`，别的错误原样抛出。
   - 消息格式：`<DSH 错误码> "<文件名>": <DSH 的原句>`，文件名按 JSON 加引号。
   - DSH 的错误不指明是哪一张图（证据 2.1），bridge 自己找：
     - 只有一张图，就是它；
     - `UNSUPPORTED_IMAGE_TYPE`：第一张类型不在 `imageLimits.mediaTypes` 里的；
     - `INVALID_IMAGE_BASE64`：第一张 base64 不规范的；
     - 其余逐张调 `validateImage`，第一张不过的就是。只在拒绝时做，成功路径不多解码一次；
     - `TOO_MANY_IMAGES`、`IMAGES_TOO_LARGE` 是整批的问题，不点名；
     - 存文本文件失败（如 `ATTACHMENT_WRITE_FAILED`）点这个文件的名。
   - 新错误码定义在 `src/shared/types/workerRpc.ts`。Main 不改名，原样带过 IPC（与 `WORKER_DSH_UNSUPPORTED` 当时一样）。
4. **发送的顺序**：
   - 先查忙、bootstrap、选路。模型不在计划里时，在任何入库之前就答 `MODEL_NOT_CONFIGURED`；
   - 再入库。入库要等附件服务，之后**再查一次**本 bridge 是否已有自己开的回合，有就答 `WORKER_SESSION_BUSY`；
   - 选路的结果在入库成功之后才应用：被拒的发送不改变会话当前的模型。
   - 文本文件在图片校验之前就存了。图片被拒时，已存的文件副本不回滚：它们按内容寻址，改掉图片再发时是同一个对象，不重复占地方。DSH 自己的宿主也是先收文件回执、再 admit 整条消息。

### 三、插话带附件

5. **放开决策 111 第 4 条的桩**：
   - 插话没附件时照旧同步答复，判「有没有回合」与 steer 之间没有间隙；
   - 有附件时答复是一个 Promise：先判有没有回合（没有就答 `turnActive:false`，不入库），入库，**再判一次**（回合可能在入库期间结束了，这时同样答 `turnActive:false`，渲染层按普通发送重发，附件重新入库，内容寻址不重复），然后 steer；
   - 入库被拒：答 `WORKER_ATTACHMENT_REJECTED`，什么都不 steer。
   - 为此 `PiWorkerRuntime.interject` 的返回类型放宽为「结果或 Promise」，RPC 服务端 await 它。1.0.x 的 native runtime 不变。
   - 代价：RPC 是串行处理的，插话带大图入库的这几百毫秒里，随后到的 Stop 要排在它后面。与普通发送的入库一样。

### 四、权限：附件库是可信路径

6. **可信路径规则**（决策 097 第 3 条）：
   - `permissionHost.ts` 的默认 `isTrustedPath` = spill 目录 **或** `<DSH_HOME>/attachments/v1/` 之下（严格在其下；按宿主启动时 `$DSH_HOME` 的规范路径算）。附件行没有单独配置 `dshHome`，跟随 `$DSH_HOME`。
   - 只对读取与搜索类工具生效（`requestBuilder.ts` 原有的限制）：用 bash `cat` 读附件、往附件库写，照旧出卡；`DSH_HOME` 的其他地方也照旧。
   - 文本文件与规范化后的图片都在这下面，模型对后者 `read_image` 同样不出卡。
7. **闸的修正**（`src/shared/permissions/gate.ts`）：
   - 读取类工具（read / grep / glob）最后一步原来看「全部策略判定里有没有 ask」，其中包括路径表（`~/.pilab/*: ask`，产品的 `DSH_HOME` 正在这下面）和工作区边界（`external_directory: {'*': 'ask'}`）的 ask。这两问正是 `trustedPath` 约定要免掉的，前面也免了，到这一步又回来了（证据第 3 节）。
   - 改为：可信路径只看工具自己的规则有没有 ask（例如用户配了 `read: ask` 仍然问）。所有 deny 照旧，排在前面。
   - 这也修好了现有的 spill 可信规则：此前 ask 档下读 DSH 写的 spill 文件同样会出卡。
   - 这是共享库。1.0.x runtime 只给技能加 `trustedPath`，技能不走读取分支，行为不变（runtime 的权限测试 51 例通过）。
8. **显式 deny 照旧生效**：名字像密钥的附件（随包规则 `*.env`、`*.env.*`、`*.key`、`*.pem`、`id_rsa*`），模型读不到，也不出卡；1.0.x 把文本并进正文，模型看得到。按决策 097 第 3 条接受，属于用户看得见的差异。

### 五、回显与历史

9. **回显**：`message.started`（user）的 `attachments` 用历史投影的同一个函数（`projection.ts` 导出的 `dshMessageAttachments`），直播与重读一致：
   - 图片的 `mediaType` 是 DSH 存下的类型。DSH 会把图片规范化成 JPEG 或 WebP，所以 chip 上的类型可能与用户选的原图不同；
   - 文件一律是 `{kind:'text', mediaType:'text/plain'}`，原来的 `text/markdown` 之类不保留：DSH 的文件块不记类型；
   - 气泡里只有用户自己写的正文，句柄行只在发给模型的请求里。
10. **不按模型能力拒图**：模型没声明图片输入时，DSH 把图片换成一行占位文字（`projectImagesForTextModel`），bridge 不拦（跟随 DSH）。渲染层已有「当前模型不支持图片输入」的提示。`dsh-llm-pi-ai` 默认只有文本输入，所以 P1-5 计划里模型的 `input` 必须如实写上 `image`（`build.ts` 的 `planModel` 已原样传递，`index` 里的 `image` 也由它得出，核对无误；录制的 `image` 场景实测，声明了 `image` 的模型收到了图片块）。
11. **读图**：用 DSH 的 `read_image`，不移植 1.0.x `read` 的图片分支。`read_image` 在权限表里本来就归「读取」类（`classification.ts`），本任务不改它。

### 六、渲染层

12. **「附件被拒」的路径**（P1-1 D2 修过的那条）：
    - `sendDispatchError.ts` 的 `isEngineUnsupportedSendError` 换成 `parseAttachmentRejection`：认 `WORKER_ATTACHMENT_REJECTED`，读出 DSH 错误码和文件名；
    - 发送与插话共用 `showAttachmentRejection`：有文件名时「引擎拒收了附件「x」（错误码）。移除或替换它后即可发送。」，没有时「引擎拒收了这些附件（错误码）。…」；
    - 草稿与附件照旧退回输入框（`refusedByRule`），不解绑、不出重试；
    - 提示里直接显示 DSH 的错误码，不逐个翻成中文说明，留给 P1-7；
    - 旧提示「当前引擎暂不支持附件，后续版本恢复…」连同翻译删除，静态测试断言它不再出现。

### 七、录制与假网关

13. 假网关新加 `P1-IMAGE`、`P1-FILEREAD`、`P1-IMAGEREAD` 三个场景；脚本多收第 8 个参数：请求的 messages（数图片块要用）。
14. 录制新加两个场景，放在场景表**末尾**，前面 23 个场景的宿主状态不变：
    - `image`：录制的模型计划在同一路由上加一个声明了图片输入的 `fake-vision`，只有这个场景发给它。一张 2×2 PNG 发出去，模型收到 1 个图片块，回显与历史都有 chip；再发一张 8193×1 的 PNG 被拒（`IMAGE_DIMENSION_TOO_LARGE`，记在 `rpc.rejected`，之后通道上没有事件）。被拒的一张不用「超过 20 MiB」的大图：开发机内存吃紧，像素边长超限是同一条拒绝路径；
    - `file-attach`：ask 档，发一个文本附件，模型按句柄路径 `read` 后作答，不出卡。万一出卡一律答 deny，会在 stream 的差异里看见。
    - 两个场景各录两次（分开录与同一宿主连录），结果逐字节相同；历史投影与 bridge 的答复对得上（在 /tmp 用金样本测试的同一套比对跑过）。`--check`：既有 23 个场景无差异，只报新两个场景缺金样本。
    - `dshHistoryGolden.test.ts` 的场景清单已按字母序加上这两个名字，并各加一条「用户看到什么」的断言；金样本由编排者收口时重录，在那之前这三条会失败。
15. bridge 行的 `inject` 加上 `attachments`：附件行（`dsh-base` 的 `attachment-local`）起来之前 bridge 不接会话。

## 取舍

- **找出该怪的文件，还是只报 DSH 的错误码**：只报码的话，多张图里有一张超限时用户不知道删哪张。逐张校验只在拒绝时做，成功路径不多花。
- **可信路径靠修闸，还是只给附件开一条「永远 allow」的特例**：特例会绕过 deny（密钥名、用户规则）。改闸是让 `trustedPath` 做到它注释里写的约定，deny 全部照旧，也顺带修好了 spill。
- **被拒时回滚已存的文本文件**：DSH 没有删除接口（附件永不删除，决策 096），内容寻址也让重发不重复占用，所以不做。
- **插话一律改成异步**：会让没附件的插话在「判有没有回合」与 steer 之间多出一个间隙，P1-4c1 实验 E2b 说明这个间隙里回合可能已经结束。所以只在有附件时异步。

## 遗留

- 错误码的中文说明、附件 chip 的样式归 P1-7。
- 附件永不自动删除，`DSH_HOME` 会随发图、发文件增长（决策 096 已记）。
- 文本附件原来的 `mediaType` 在历史里丢失，一律显示为 `text/plain`。
- 名字像密钥的文本附件模型读不到（第 8 条），用户可能不明白为什么；可在 P1-7 的附件 chip 上提示。
- P1-9c 迁移旧会话里的图片，可以复用 `admitUserContent`。
- 录制金样本 `image`、`file-attach` 待编排者 `--update` 重录。
