# Q7 (git 面板空结果) 修复核查 — b984b282

核查日期: 2026-09-09  主机: 本机(带 TsdEncrypt 企业加密驱动)
来源提交: b984b282da0b0bec618f0ede2559c8ab0a6d1024  (位于 feat/runtime-evolution HEAD 历史中)
提交说明: fix(main): Q7 git 读不到 stdout 时报错，不再编造一个干净仓库

## 结论
修复正确，三处判据均按提交说明落地，且在本机(有加密驱动)实测通过，不误伤正常仓库。

## 修复内容(静态核对)
1. getBranches: 空列表时先用 'rev-parse --verify HEAD' 区分真 unborn 与列表丢失;
   HEAD 能解析却无分支 => 抛错(noStatusOutputError)；真 unborn => symbolic-ref 标 (no commits yet)。
   位置: GitService.ts:330-366
2. readPorcelainV2Limited / getFileChanges: 拒绝 '0 退出码 + 无 # branch.* 头' 的空壳结果。
   位置: GitService.ts:640-690
3. truncated 与 timedOut 拆成两个变量，close 回调对超时明确 reject(statusTimedOutError)，
   不再把超时当半读成功。位置: GitService.ts:515,649-687

## 测试证据(本机执行)
- gitStatusFailureModes.test.ts: 6 项全过(含'labels a genuinely empty repo'与
   'fails instead of claiming (no commits yet) when the listing is lost')
- 真实仓库 vitest(临时文件, 已清理): 4 项全过
    健康仓库 getBranches 返回分支(不再误标 no commits yet) / 真 unborn 标 no commits yet /
    getStatus current=main clean / 带改动 getFileChanges 报出文件(不变空)

## 边界与提醒
- Q7 修复覆盖的是 'git stdout 拿不到(空/未解析)时被误报为空' 的路径。
  若你仍在受 TSD 加密策略作用的目录观察到 '无变更/空白分支'，那可能是另一成因
  (工作区文件被读成密文, D13/Q5 口径), 需要 Q7 之外的读路径处理;
  但本机实测 GitService 的 getStatus/getBranches/getFileChanges 在真实仓库上已正确返回。

- 本机未在受加密策略的实际工作区复现原始问题(现有临时目录可能不受策略作用);
  现场复测仍归 P4-6/D16, 本核查不代签加密现场。
