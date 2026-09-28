# 证据：P1-4c2 开工前实验：文件块的只读路径、可信路径与图片入库（2026-09-28）

Role: evidence。上位：[P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §8 第 2 条；验证[决策 097](../decisions/097-text-attachments-as-dsh-file-blocks.md) 第 6 条的前提，顺带确认[决策 096](../decisions/096-images-via-dsh-attachments.md) 的入库错误形状。取舍见[决策 112](../decisions/112-p1-4c2-attachment-choices.md)。

**结论：DSH 这一侧的前提全部成立，文件块方案可行，P1-4c2 按决策 096 / 097 实现。**
- 共享宿主、沙箱关闭（决策 044）时，文件块句柄里的路径就是宿主上的真实路径，`read` 能直接读到（E3）。
- 但**我方权限闸原样不满足「判为可信路径、不出审批卡」**：第一次跑（基线），ask 档下读附件照样出卡（E4、E6）。原因在我方闸，不在 DSH（第 3 节）。补上附件库的可信路径规则、并修正闸对可信路径的读取判定后，第二次跑 18 项判定全部通过：不出卡，显式 deny 照旧生效（E5）。

## 1 怎么跑的

- 基线：分支 `feat/dsh-p0-probe`，HEAD `5a09405f`，加上本任务未提交的改动。两次运行：
  - **第一次（基线）**：只有实验脚本与假网关新场景，权限闸与 bridge 都没改；
  - **第二次**：加上 `permissionHost.ts` 的附件库可信路径规则与 `gate.ts` 的修正（决策 112 第 5、6 条），bridge 仍未改。
- 环境：Linux 开发机，随包 Node v24.18.0，源码态 DSH 宿主（`src/dsh-host/host.ts`），DSH 0.1.7-rc.2（`dsh-attachment`、`dsh-attachment-local`、`dsh-llm`、`dsh-tool-fs`）。
- 模型：只用本地假网关 `src/dsh-host/tools/fake-gateway.mjs`（plan `dsh-p0-2`）。本任务新加三个场景：`P1-IMAGE`（数请求里的图片块）、`P1-FILEREAD`（按文件句柄里的路径发一次 `read`）、`P1-IMAGEREAD`（按图片句柄里的规范化副本路径发一次 `read_image`）。计划里除 `fake-1` 外另有一个声明了图片输入的 `fake-vision`。
- 命令（两次相同）：

  ```bash
  out-node-runtime/node src/dsh-host/tools/attachment-experiments.ts --out /tmp/p1-4c2-scratch/exp-after.json
  ```

  第一次退出码 1（有判定不通过），第二次退出码 0。
- 做法：
  - 会话都是产品 bridge 自己的：走 `worker.bootstrap` 开在通道上。
  - bridge 当时还不带附件，所以附件由一个只在实验里装的行（`tools/lib/attachment-experiment-row.mjs`）处理：它调 DSH 自己的 `ctx.attachments`（`admitPromptContent`、`saveFile`、`fileHostPath`、`imageHostPath`），用 `ctx.agents.get` 拿到 bridge 的 agent，把 `createUserMessage([正文, 附件块…])` followup 进去。审批卡照常经通道发给「Main」（脚本），脚本一律答 deny，免得回合卡住。
  - `DSH_HOME` 放在宿主 HOME 下的 `~/.pilab/<profile>/dsh-home`，与产品一致（`DshHostProcess.ts`），这样随包策略的 `~/.pilab/*: ask` 规则照样适用。

## 2 结果

| 编号 | 场景 | 判定 | 第一次（基线） | 第二次 |
|---|---|---|---|---|
| E1 | `admitPromptContent`：2×2 PNG 入库；超限、类型不符、类型不收、base64 不规范各一张被拒；两张里第二张超限的一批；只有文件块的一批 | 成功得到 image 引用；拒绝都是带稳定错误码的 `AttachmentError`；被拒的一批一个对象都没写；文件块原样放行 | 4/4 通过 | 4/4 通过 |
| E2 | `saveFile` 一个文本文件 | 落在 `<DSH_HOME>/attachments/v1/files/…`；给工具的路径等于宿主路径；句柄行写的就是这条路径 | 3/3 通过 | 3/3 通过 |
| E3 | bypass 档：模型按句柄路径 `read` | 读成功，模型看到文件里的标记 | 2/2 通过 | 2/2 通过 |
| E4 | ask 档：同上 | 不出审批卡，读成功，模型看到标记 | **3 项全不通过**：出卡（读工作区外的路径），被拒 | 3/3 通过 |
| E5 | ask 档：附件名为 `secrets.env` | 不出卡，被随包 `*.env` 规则拒绝 | 2/2 通过 | 2/2 通过 |
| E6 | ask 档、`fake-vision`：图片块到了模型；模型对规范化副本 `read_image` | 路径在附件库下；模型收到 1 个图片块；不出卡；读成功 | 1/4 通过（出卡、被拒；「收到图片块」一项因当时的假网关失败回答里没写块数而判为不通过，第二次前补上了） | 4/4 通过 |

第二次的判定原文：

```json
{
  "E1_admittedImageRef": true,
  "E1_refusalsCarryStableCodes": true,
  "E1_failedBatchStoresNothing": true,
  "E1_fileBlocksPassThrough": true,
  "E2_underAttachmentsV1Files": true,
  "E2_processPathIsHostPath": true,
  "E2_handleNamesThePath": true,
  "E3_readSucceeded": true,
  "E3_modelSawContent": true,
  "E4_noCard": true,
  "E4_readSucceeded": true,
  "E4_modelSawContent": true,
  "E5_noCard": true,
  "E5_refused": true,
  "E6_imagePathUnderAttachmentsV1": true,
  "E6_modelGotImageBlock": true,
  "E6_noCard": true,
  "E6_readImageSucceeded": true
}
```

### 2.1 入库的成功与失败形状（E1）

成功时，`admitPromptContent([{type:'text'}, {type:'image', mediaType, data, name}])` 按原顺序返回，图片换成引用：

```json
{
  "type": "image",
  "attachment": {
    "attachmentId": "sha256:31596a20…",
    "mediaType": "image/png",
    "width": 2,
    "height": 2,
    "bytes": 75,
    "name": "dot.png"
  }
}
```

失败时抛 `AttachmentError`（`name` 与构造器名都是 `AttachmentError`，`ctx.attachments.isAttachmentError()` 认得），`code` 稳定，`message` 不含路径和字节：

| 输入 | `code` | `message` |
|---|---|---|
| 8193×1 的 PNG | `IMAGE_DIMENSION_TOO_LARGE` | Image exceeds the configured per-side pixel limit. |
| PNG 字节，声明 `image/jpeg` | `IMAGE_TYPE_MISMATCH` | Declared image type does not match its bytes. |
| 声明 `image/bmp` | `UNSUPPORTED_IMAGE_TYPE` | Image type image/bmp is not accepted by this deployment. |
| base64 末尾多一个换行 | `INVALID_IMAGE_BASE64` | Image upload is not canonical base64. |
| 3×3 PNG + 8193×1 PNG 一批 | `IMAGE_DIMENSION_TOO_LARGE` | 同第一行；**错误里不说是哪一张** |

- 被拒的每一批，附件库 `objects/` 下的文件数前后不变：先整批校验，再写。
- 错误不指明是哪一张，所以 bridge 要自己找出该怪的文件（决策 112 第 3 条）。

### 2.2 文件与图片落在哪里（E2、E6）

- 文本文件：`<dsh-home>/attachments/v1/files/<摘要前 2 位>/<sha256>/<文件名>`，权限 `0400`（只读）。
- 规范化后的图片：`<dsh-home>/attachments/v1/objects/<摘要前 2 位>/<sha256>`，权限 `0400`。
- 沙箱关闭时，`fs.processPathFromHostPath` 原样返回宿主路径：模型拿到的路径就是磁盘上的路径。
- 模型看到的句柄行（`dsh-llm` 的 `fileHandleText`）：

  ```
  [File "notes.txt" (38 bytes, sha256:b37f8217): verbatim read-only copy saved at "<dsh-home>/attachments/v1/files/b3/b37f8217…/notes.txt". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. …]
  ```

- `read` 的结果（E3、E4）：`<path>…</path>\n<type>file</type>\n<content>\n1: FILE-MARKER-E3 is the only line that matters\n…`。
- `read_image` 的结果（E6）：`<type>image</type>\n<content>\nimage/png image, 4x4 px, 73 bytes\n</content>`。

## 3 第一次为什么出卡：我方闸的两处缺口

1. **可信路径只认 spill**：`permissionHost.ts` 的 `isTrustedPath` 只认 `$TMPDIR/dsh-spill-*`，附件库不在其中。读附件是「工作区外的路径」，ask 档出卡。
2. **即使标成可信，读取也照样出卡**：用随包策略直接问闸（`gate.evaluate`），ask 档下：

   | 路径 | `trustedPath` | 结果 |
   |---|---|---|
   | 附件库里的 `notes.txt`（工作区外） | 否 | `ask` |
   | 同上 | 是 | **`ask`** |
   | 附件库里的 `secrets.env` | 是 | `deny` |
   | 工作区里的文件 | 否 | `allow` |

   `trustedPath` 的约定是「免去工作区边界那一问，deny 照旧」（`gate.ts` 的字段注释）。但读取类工具在最后一步看的是全部策略判定里有没有 `ask`，其中包括 `external_directory: {'*': 'ask'}`（工作区边界）和路径表里的 `~/.pilab/*: ask`（产品的 `DSH_HOME` 正在这下面）。前面已经为可信路径免掉的这两问，在这里又回来了。
   - 1.0.x 只给技能加 `trustedPath`，技能的路径在工作区内、工具名也不是 read，所以一直没暴露。
   - **现有的 spill 可信规则也受影响**：模型在 ask 档读 DSH 写的 spill 文件，同样会出卡。

两处都在我方，改法见决策 112 第 5、6 条。改后 E4、E6 不出卡，E5 的 deny 照旧。

## 4 对实现的影响

1. 决策 097 的前提成立，文本附件按文件块实现，不退回 1.0.x 的并进正文。
2. 权限：`isTrustedPath` 加上 `<DSH_HOME>/attachments/v1/`（规范路径，只认严格在其下的路径）；闸在读取的最后一步，对可信路径只看工具自己的规则，不再看路径表与工作区边界的 `ask`。deny 照旧：名字像密钥的附件（`*.env`、`*.key`、`*.pem`、`id_rsa*`）模型读不到。
3. 入库错误：`AttachmentError` 的 `code` 稳定，可以原样带给渲染层；批量被拒时要自己找出是哪一个文件。
4. 被拒的一批什么都不写，所以 bridge 在 admit 之前不必自己预检。
5. 图片的规范化副本路径同样在附件库下，模型对它 `read_image` 不出卡。

## 5 复现

- 脚本：`src/dsh-host/tools/attachment-experiments.ts`（驱动）、`src/dsh-host/tools/lib/attachment-experiment-row.mjs`（实验行，只装进临时 DSH_HOME 里的探针包副本，不进产品包）、`src/dsh-host/tools/lib/png.ts`（生成纯色 PNG）。
- 要复现「第一次」，把 `permissionHost.ts` 的默认 `isTrustedPath` 与 `gate.ts` 读取分支的改动退回即可。
- 可用内存低于 900 MB 时脚本拒绝启动；只向自己启动的子进程发信号；临时目录在结束时删除；输出里的临时路径、`DSH_HOME`、家目录、主机名与用户名都替换成占位符。
