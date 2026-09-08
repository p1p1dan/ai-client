# Native 门禁恢复

> 历史检查点。最终状态见 [完成记录](./completion.md)，下文的当时未完成项或阻塞已由后续证据替代。

日期：2026-09-08。

## 无管理员权限的处理

系统没有 make/g++，sudo -n 需要密码。没有安装或升级系统包。
`apt-get -s --no-install-recommends install g++ make libc6-dev` 得到 32 个缺失包；
仅用 `apt-get download` 下载（59.4 MB），`dpkg-deb -x` 解压至
`/home/pi/.cache/aiclient-b-native/sysroot`。
临时 GCC/G++ 14.2.0 wrappers 使用该 sysroot，make 单作业运行。

原 node-gyp@8.4.1 不兼容 Python 3.13 的 distutils 删除；改用系统 npm 自带
node-gyp@12.4.0，Node v24.20.0 官方 headers。首个链接错误缺少 sysroot 的 libmvec，
补指向现有系统运行库的链接后 `node-gyp build --jobs=1` 成功。
Node PTY 实际执行 `/bin/sh -c 'printf native-ok'` 输出 native-ok、exit 0。

源码来自 `npm pack node-pty@1.1.0 --ignore-scripts` 的官方包。
独立模块位于缓存 node_modules/node-pty；本工作区 `src/main/node_modules/node-pty`
链接到它（Git 忽略），没有改动另一 checkout 的共享 node_modules。

## 实际复验

`NODE_OPTIONS=--max-old-space-size=1200 ./node_modules/.bin/vitest run src/main/services/session/__tests__/SessionManager.test.ts src/main/services/terminal/__tests__/PiTuiPty.test.ts --maxWorkers=1 --no-file-parallelism`
→ 2 files / 12 tests 通过。

随后按原文件清单重跑第 13 批：7 files 通过 / 1 failed，82 tests 通过 / 1 failed。
38 批汇总更新为 **302 files 通过 / 1 failed；4531 tests 通过 / 1 failed**。
[完整批次证据](./final-batch-gate.json) 已更新。

## 仍待处理

唯一失败是既有 SearchService 的 worktree `.git` 指针文件泄入搜索结果。
已准备 [一行排除规则补丁](./proposed-worktree-git-exclusion.patch)，`git apply --check` 通过，
但没有修改 SearchService 源码。该文件不在 B 组边界内，范围确认已提出，尚未收到回答。
GUI 点验保持交接状态；不将全仓门禁标成通过，也不归档计划。
