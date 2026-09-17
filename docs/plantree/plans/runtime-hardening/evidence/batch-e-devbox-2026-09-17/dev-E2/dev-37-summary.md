# DEV-37 — 多样路径下的文件点击与编辑器（真机，dev-E2）

工作区 `/tmp/t032/ws-paths`（`git init` 过），用
`node scripts/dev.js --remote-debugging-port=9333 --open-path=/tmp/t032/ws-paths` 注册，
store 里确认 `projects` 多出 `local:/tmp/t032/ws-paths`。
在该仓库下新建会话使工作区生效，再点侧栏「文件」逐个点开。
点击用真鼠标事件（`Input.dispatchMouseEvent`），不是 `.click()`。

| 类别 | 路径 | 编辑器 | 标签页名 | 内容第一行 | 路径提示（breadcrumb） | 报错 |
|---|---|---|---|---|---|---|
| 含空格 | `dir with space/a b.ts` | Monaco 打开 ✅ | `a b.ts` | `export const SPACE_MARKER = "DEV37-A-space-in-both-names";` | `dir with space / a b.ts` | 无 |
| 中文 | `中文目录/文件.ts` | Monaco 打开 ✅ | `文件.ts` | `export const CJK_MARKER = "DEV37-B-中文目录与中文文件名";` | `中文目录 / 文件.ts` | 无 |
| 超长 | `level1-…/…/level8-…/deep.ts`（目录部分 322 字符，全路径 330 字符，文件名 7 字符） | Monaco 打开 ✅ | `deep.ts` | `export const DEEP_MARKER = "DEV37-C-very-long-path";` | 八级目录逐级列全 + `deep.ts` | 无 |
| 软链 | `link.ts -> real/target.ts` | Monaco 打开 ✅ | `link.ts` | `export const LINK_TARGET_MARKER = "DEV37-D-symlink-target";` | `link.ts`（显示链接自身路径，不是解析后的 `real/target.ts`） | 无 |

四个标签页同时开着时标签栏逐字是 `["a b.ts","文件.ts","deep.ts","link.ts"]`
（`dev-37-05-editor-tabs.json` / `dev-37-05-editor-tabs-all-four.png`），
空格、中文、软链名都没有被转义或截断。

两点实现细节，都不是缺陷，记下来免得下一个人当异常：

1. **标签页不是 `role="tab"`**，是 `div[role="button"].h-9`（设计规范里 Tab 栏 `h-9` 那一档）。
   按 `[role="tab"]` 找会一个都找不到，会误判成「没有标签栏」。
2. **单子目录链会被折叠成一行**（VSCode 同款）：八级目录在树里是一行
   `level1-…/level2-…/…/level8-…`，点一次就展开到底，不需要点八次。

日志：`aiclient-2026-09-17.log` 在这四次点击期间除 `worktrees-absent` 噪声外无新增行，
`ENOENT|EACCES|failed to read` 计数为 0。
