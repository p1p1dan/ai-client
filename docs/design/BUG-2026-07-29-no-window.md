# 故障报告：`pnpm dev` 启动后不出窗口（已定位并修复）

> 日期：2026-07-29 · 分支 `feat/openchamber-chat-refactor` · 机器：VMware 虚拟机 / Ubuntu / GNOME Wayland
> 状态：**已修复**（`src/main/windows/MainWindow.ts`）
> ⚠️ 本文第二节曾给出错误结论，2026-07-29 复核后已更正，更正依据见「附录：原诊断错在哪」。

## 一、现象

`pnpm dev` 编译全部成功、Vite dev server 正常（`http://localhost:5173` 返回 HTTP 200）、
Electron 主进程起来了，日志打到 `Shared state paths {...}` 之后**再无输出，窗口始终不出现**。

进程一直活着（47 线程，`State: S (sleeping)`），但**从未退出**。

## 二、根因（实测确认）

**`ready-to-show` 事件在这台机器上从不触发**，而 `MainWindow.ts` 原先只在该事件里调 `win.show()`——
于是 `BrowserWindow` 建好了、页面也加载完了，但**永远不会被 show 出来**。

插桩实测（`console.error` 打点）：

```
[diag] BrowserWindow constructed, state={}
[diag] show() called via did-finish-load          ← ready-to-show 从未触发，走的是兜底
[diag] visible=true minimized=false bounds={"x":0,"y":0,"width":800,"height":600} url=http://localhost:5173/
```

**为什么 `ready-to-show` 不触发**：该事件依赖渲染进程完成首帧绘制并提交。这台 VM 无 3D 加速
（`VMware: No 3D enabled`），GPU 光栅化失败：

```
ERROR:cc/raster/one_copy_raster_buffer_provider.cc:299  Creation of StagingBuffer's SharedImage failed.
```

首帧提交不完成 ⇒ `ready-to-show` 不来 ⇒ 窗口不 show。

## 三、修复

`src/main/windows/MainWindow.ts`：给 show 加两条兜底路径，三条路径共用一个幂等的 `showWindow()`
（`hasShown` 去重 + `isDestroyed()` 守卫 + `closed` 时清理定时器）：

| 触发源 | 作用 |
|---|---|
| `ready-to-show` | 正常路径 |
| `webContents.did-finish-load` | 首帧不提交时的兜底（**本机实际生效的就是这条**） |
| 5s `setTimeout` | 前两者都不来时的最后兜底 |

非 `ready-to-show` 触发时打一行日志。**该日志必须用 `console.error`**——
`initLogger(loggingEnabled=false)` 是默认值，electron-log 会吞掉 warn 及以下级别，
用 `console.warn` 的话这行唯一能说明「兜底生效了」的日志根本看不见。

同轮修复的另一个既有 bug（`MainWindow.ts:120` 附近）：

```js
// 错误写法：replaceWindow 为 null 时，三元走 else 分支得到 {isMaximized: undefined}
// —— 一个「真值对象」，于是 ?? 永不回落
const replacementState = options.replaceWindow?.isDestroyed() ? null : {
  ...options.replaceWindow?.getBounds(),
  isMaximized: options.replaceWindow?.isMaximized(),
};
const state = replacementState ?? loadWindowState();
```

后果：`width/height/x/y` 全为 `undefined`，**窗口状态从来没有被恢复过**，
每次都退化成 Electron 默认 800×600@0,0（上面 diag 里的 `state={}` 就是它）。
已改为先判 `replaceWindow && !isDestroyed()` 再取 bounds。

## 四、已排除的原因

| 假设 | 排除依据 |
|---|---|
| 窗口从未被创建 | **错误假设**，见附录。主进程有 2 条到 `/run/user/1000/wayland-0` 的连接，窗口一直是建好的 |
| GPU 崩溃导致起不来 | 最小 Electron 复现脚本同样报 GPU 错，窗口**正常显示**。GPU 只影响首帧提交（进而影响 `ready-to-show`），不阻止建窗 |
| `autoStartHapi()` 挂起 | `~/.aiclient/settings.json` 里 `hapiSettings.enabled` 已是 `false`，该函数直接返回 |
| sqlite3 原生模块坏了 | 首次启动确实报 `Could not locate the bindings file`；重建后实测 `require('sqlite3')` → `OK`。**已修复，非本次根因** |
| CSS / 渲染层打包失败 | `curl localhost:5173/` 返回完整 HTML；`globals.css` 返回 Vite HMR 包装（Tailwind 编译通过） |
| 单实例锁被占 | 曾发生过（两个主进程并存，`index.ts:222`），清理后问题依旧 |
| 本轮代码改动引入 | 改动全在 `src/renderer/`，`src/main/` 一行未动 |

## 五、日志停在 `Shared state paths` 是正常现象

`src/main/index.ts:333 init()` 一开始就调 `initLogger(loggingEnabled, ...)`，
而 `loggingEnabled` 默认 **false**，其后所有 `log.info` 都被静音。
2026-07-28 那次**成功启动**的 `main.log` 同样止于 `Shared state paths`。
**不能靠这条日志判断进度。插桩一律用 `console.error`。**

## 六、两个环境陷阱（本节结论仍然有效）

### 陷阱 1：`pnpm dev` 会自动跑 `pnpm install`，冲掉原生模块

pnpm 10 的 `verifyDepsBeforeRun` 会在跑脚本前校验依赖，认为 node_modules 脏了就重装
（日志里的 `Packages: +766`），**把 `electron-builder install-app-deps` 重建好的原生模块全部覆盖**。
然后 ripgrep 的 postinstall 被 GitHub 403 挡住 → install 失败 → dev 中止。

**解法**：绕开 pnpm 直接跑

```bash
node scripts/dev.js                  # 等价于 pnpm dev，但跳过依赖校验
node scripts/dev.js --disable-gpu    # dev.js:88-89 会把参数透传给 Electron
```

### 陷阱 2：任何 `pnpm install` 之后必须两步复原

```bash
# ① 复原 ripgrep（postinstall 被 GitHub 403 挡）
cp src/agent-host/node_modules/@cometix/claude-code/vendor/ripgrep/x64-linux/rg \
   node_modules/@vscode/ripgrep/bin/rg && chmod +x node_modules/@vscode/ripgrep/bin/rg

# ② 重建原生模块（sqlite3 / node-pty / @parcel/watcher）
npx electron-builder install-app-deps
```

📌 **更正既有交接文档**：`docs/plantree/plans/openchamber-chat-refactor/implementation-status.md`
写着第 ② 步「必须用可用代理覆盖 `~/.npmrc` 里的 `127.0.0.1:7890`」——**实测不需要代理**，
Electron 39.2.7 的头文件本来就缓存在 `~/.electron-gyp/39.2.7`，直接跑即可。

## 附录：原诊断错在哪（留作方法论备忘）

原报告断定「窗口从未被创建，卡点在 `openLocalWindow()`（`index.ts:735`）之前」，依据是：

```bash
ls -l /proc/$P/fd | grep -oE "X11-unix/X[0-9]|wayland-[0-9]"   # → 空
```

**这个方法不成立。** Unix domain socket 在 `/proc/<pid>/fd/` 里的 symlink 目标**永远**是
`socket:[<inode>]`，不含路径——不管它连的是 wayland、X11 还是 D-Bus。所以"grep 不到路径"
是必然结果，与窗口是否创建无关。

正确查法是按 inode 反查 `ss -x`：

```bash
inodes=$(ls -l /proc/$P/fd | grep -oE 'socket:\[[0-9]+\]' | grep -oE '[0-9]+' | tr '\n' '|' | sed 's/|$//')
ss -x -p | awk -v pat="^($inodes)$" 'NR>1 { if ($6 ~ pat || $8 ~ pat) print $5, "<->", $7 }' | sort | uniq -c
```

实测输出含 `2  /run/user/1000/wayland-0 <-> *` —— 主进程与合成器的连接一直在，
**窗口早就建好了**，卡的是 show 而不是建窗。

同理，`xlsclients` / `xwininfo` 看不到 Electron 也是预期的：Electron 在此环境下解析出的
ozone 平台是 **wayland**（见渲染进程命令行的 `--ozone-platform=wayland`），窗口是原生
Wayland surface，不经过 XWayland，X 工具当然枚举不到。

**教训**：判断「窗口是否创建」最省事的证据是**渲染进程是否存在**——
`pgrep -af "type=renderer"` 有输出就说明 `BrowserWindow` 已构造。
