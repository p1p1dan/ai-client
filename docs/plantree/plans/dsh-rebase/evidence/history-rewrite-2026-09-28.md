# 分支历史改写记录（2026-09-28）

- **原因**：仓库是公开的，按用户要求「保持公开 + 脱敏」，推送前从 `feat/dsh-p0-probe` 的历史里删掉加密机第一轮的原始现场报告（`docs/plantree/plans/dsh-rebase/evidence/p1-13-encrypted-2026-09-28/`），换成脱敏摘要 [p1-13-encrypted-2026-09-28.md](p1-13-encrypted-2026-09-28.md)。原始报告只留在开发机本地的 `contextFX/`。
- **做法**：用 `git filter-branch --index-filter`，范围是 `d23d72aa..feat/dsh-p0-probe`（从 main v1.0.3 往后）。改写前，本地打了备份 tag `backup/dsh-p0-probe-before-sanitize-20260928`，只在本地，不推送。
- **影响**：引入那份报告的提交 `76a8be5a` 及其之后的 16 个提交换了编号；更早的提交不变。文档里引用的提交号已经按下表替换。
- **例外**：P1-13b 上机包（sha256 `4a5ea708…b652`）的 manifest 里写的来源提交仍是旧编号 `fd8f2ac9`，对应新编号 `c3eb0068`。

| 旧编号 | 新编号 |
|---|---|
| `76a8be5a` | `5345edda` |
| `c8bcdab1` | `fcaeb8bc` |
| `fd8f2ac9` | `c3eb0068` |
| `d34ee841` | `9a4d8cf5` |
| `fe089adf` | `36df9ac9` |
| `7e6c3093` | `88ccf7bf` |
| `fc6061c6` | `97a41728` |
| `58305a1f` | `24e05d69` |
| `bed30955` | `e5d16e59` |
| `e4d0ef90` | `f7e7884a` |
| `b139e373` | `a44229c9` |
| `ac47a9c8` | `262a240c` |
| `f4f2fff7` | `82eef1e9` |
| `52cd915d` | `867f8606` |
| `1f0d9cda` | `a83caebd` |
| `c999bca6` | `6f3fc233` |
