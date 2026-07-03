
## 2026-07-03T15:13:21

Gotcha(Windows 路径分隔符塌陷)：Electron 主进程 FILE_LIST(src/main/ipc/files.ts)用 node:path.join 返回路径,win32 下为反斜杠(C:\repo\a.txt);渲染层建树(useFileTree)不规范化分隔符。因此渲染层任何用 path.substring(0, path.lastIndexOf('/')) 求父目录的写法,在 Windows 上 lastIndexOf('/') 返回 -1 → substring(0,-1) 得空串 → 拼出 '/name' → fs.rename/move 把文件挪到盘符根(表现为文件消失,数据丢失级)。已复现两次:重命名/拖拽(P-001)、新建/粘贴(P-009)。Pattern(强制)：渲染层求父目录/basename 一律用分隔符无关工具 src/shared/utils/path.ts 的 getParentPath()/getPathBasename()(双 lastIndexOf 取 / 与 \ 较大索引),getParentPath 无父段返回 ''、调用方须 || rootPath 兜底;禁止裸用 lastIndexOf('/')。

> Reason: 跨平台数据丢失级陷阱,同类已复现两次,须成文防止第三次回归;固化分隔符无关工具为唯一入口

## 2026-07-03T16:32:01

Pattern(测试 env 相关的主进程持久化,无需 mock fs):(1) 路径/写入用真实临时目录,beforeEach 设 process.env.HOME/USERPROFILE=tmpdir、afterEach 恢复;getSharedRoot 等在调用时读 env,故改 env 即可切换落点。(2) 缓存隔离用被测模块导出的 clearSharedStateCache() 而非 vi.resetModules(更快更稳)。(3) electron app.getPath 这类 last-resort 回退,用 env 变量回填 mock(app:{getPath:()=>process.env.X}),规避 vi.mock 工厂 hoist/闭包限制。(4) 磁盘写失败注入:令 HOME 指向一个『文件』,getSharedRoot 下 mkdirSync(recursive) 触发 ENOTDIR 真实抛错,验证上层 catch→返回 false;win32/posix 行为一致。参考 src/main/services/__tests__/SharedSessionState.test.ts、src/main/ipc/__tests__/settings.test.ts。

> Reason: 仓库测试护栏弱、持久化层 env 相关难测;固化可复用的失败注入与缓存隔离手法,降低后续 main 进程持久化测试门槛
