# 未决问题

只放未解决的问题；解决后移入决策或 roadmap 并在此删除。

Q001（进程拓扑）已于 2026-09-26 定为共享宿主，见[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md)；补验是 roadmap P0-6。

## Q002 DSH 沙箱能否作为兜底层叠加

- 裁决时点：合入 main 前的加密机关 P1-13（决策 004 把「P2 前」改为「合入前」；[决策 002](decisions/002-defer-encrypted-machine-and-shared-host.md) 把它移出了 P0）。普通 Windows 上沙箱开关能否正常工作由 P0-4 的 CI 实测回答，但那不能代替加密机的结论。
- 依据：加密机上机，`sandbox-windows-acl` 开 / 关各测一次 read / write / edit / grep / glob 与 bash、pwsh 子进程读写。
- 通过则叠加在我方审批之下；不通过则 Windows 上关闭沙箱。Linux / macOS 的 bwrap / landlock 另议。
- 2026-09-27：[决策 044](decisions/044-dsh-sandbox-off-by-default-in-p1.md)（待审批）把 P1 期间的默认值定为三平台都关，叠加能力放在开关后面。本问题照旧在 P1-13 裁决。

## Q003 切换后内嵌终端跑什么

- DSH 官方没有 TUI。候选：社区 `@deepseek-harness-tui/dsh-tui`（需过白名单审查），或内嵌终端不再提供 agent 界面、只当普通终端。
- 合入 main 前定（roadmap P1-11，决策 004）。
- **2026-09-27 方案与推荐**（[P1-8 / P1-11 方案 §2](topics/p1-8-p1-11-guards-and-terminal.md)）：推荐 A1。DSH 版去掉内嵌终端的 pi TUI 和会话栏的 GUI / TUI 开关，不加普通终端入口；在 P1-11 里立即删，排在 P1-9d 之前。
  - 保留 TUI 有五项代价：P1-9 迁移要先做 TUI 交接；`auth.json` 要继续明文写（决策 038）；pi CLI 要带过 P1-12；pi 扩展和插件页的联网装卸要保留（决策 058、063）；pi TUI 不经我方审批。
  - 社区 `dsh-tui@0.11.0` 在 P0-2 已被 peer 规则拒绝，推断它自带宿主，与共享宿主的规则冲突。
- **转给用户的问题**：
  1. 「DSH 版里，内嵌终端的 pi 助手（TUI）去掉，会话栏的 GUI / TUI 切换一起去掉，可以吗？旧会话在 GUI 里继续（第一次继续时自动转成 DSH 格式）；还想用 pi 的，可以回装 1.0.x 或自己装 pi。」
  2. 「去掉之后，原来 TUI 按钮的位置要不要换成一个普通命令行终端（在该会话的目录里开 shell）？您 9 月 4 日让撤掉过顶栏的终端按钮，所以我建议不加。」

Q004（版本通道）已于 2026-09-26 定为钉 `next` 的精确版本 `0.1.7-rc.2`，见[决策 003](decisions/003-p0-closeout-enter-p1.md)。

## Q005 Windows 上 ACL 沙箱默认开不开、工作区权限不够时怎么办

- 依据：[P0-4 普通 Windows CI 证据](evidence/p0-4-windows-ci-2026-09-26.md)。`sandbox-windows-acl` 授权时要同时改 DACL 并写 Low 完整性标签，后者需要 WRITE_OWNER。标准用户在 `C:\` 根下自建的目录、IT 只给 Modify 的共享目录都不满足，沙箱下的 pwsh 每次都失败，并且不会退回无沙箱运行。用户目录和管理员不受影响。
- 另一个代价：沙箱会永久改工作区权限（常驻 ACE、Low 标签、Everyone 拒绝删除子项，沿目录树继承），大目录首次授权可能要几分钟。
- **2026-09-27 建议已落为[决策 045](decisions/045-windows-acl-sandbox-default-off.md)（待用户审批）**：Windows 默认不开，也不预检；以后打开时预检 WRITE_OWNER，不满足就退回并提示。用户批准后，本问题只剩加密机上的 F-on-acl，归 P1-13。
- 原待定项：P1 默认开不开沙箱；是否预检 WRITE_OWNER；不满足时是提示用户、改用 danger-full-access 加我方审批，还是拒绝。与 [Q002](#q002-dsh-沙箱能否作为兜底层叠加)（加密机上能否叠加）一起在 P1 设计权限移植时定，加密机上的 F-on-acl 在 P2 前上机时补看。

Q006（是否另加 Claude SDK 引擎）已于 2026-09-26 定为暂不加，见[决策 003](decisions/003-p0-closeout-enter-p1.md)；调研留在 [Claude SDK 引擎调研](../../../plans/2026-09-26-claude-sdk-engine-study.md)。

## Q007 随包分发 libvips 一组的许可是否可接受（需用户或法务确认）

- 来源：[P1-2 分片 04](topics/p1-2-host-packaging/04-licenses.md)。DSH 的 `read_image` 懒加载 sharp，sharp 带着 libvips 一组共享库：libvips、glib、fribidi 等是 LGPL-3.0-or-later，cairo 是 MPL-2.0，aom 是 BSD-2-Clause 加 AOM 专利许可。这些库以独立的 `.so` / `.dylib` / `.dll` 分发，可以替换。删掉 sharp 会让 DSH 的读图不可用。
- 工程侧会做：保留所有许可文件和 libvips 的 README、`versions.json`；生成逐包许可清单；`THIRD_PARTY_NOTICES.md` 新增 DSH 段。
- 待确认：
  - 是否还需要书面的源码提供承诺；
  - aom 专利许可能否接受；
  - ~~pnpm 的 `dist/pnpm.mjs` 里合进的第三方代码要不要额外声明~~：P1-10a 已经从产物里去掉 pnpm（`ad999a0f`，[决策 082](decisions/082-allowlist-implementation-choices.md)），这一项作废。
- 裁决时点：P1-14 合入发版之前。不阻塞 P1-2 施工。

## Q008 P1-7 界面布局原型请用户确认（决策 068）

- 原型：[evidence/p1-7-prototype-2026-09-27/](evidence/p1-7-prototype-2026-09-27/)，用浏览器打开 `prototype.html`，顶栏可以切换场景 A～E、浅色 / 深色、高度标注；截图在 `shots/`。
- 请确认：
  1. 输入框上方三条窄条（待办 → 目标 → 后台），全部折叠时多占 100 px，可以接受吗？两张卡同时展开时（多占 288 px），要不要给整组设最大高度、组内滚动？
  2. 运行中的可续跑子代理会同时出现在行内泳道、左栏「运行」面板清单、后台条三处，是否需要去重？清单放在左栏状态块下方可以吗？
  3. 目标被插话打断后，条上只写「目标已暂停」，要不要写明是插话导致的（需要渲染层自己记下原因）？「继续」按钮要不要更醒目？后台命令失败时不标红，可以吗？
- 裁决时点：P1-7a 开工前。不阻塞其他任务。


## Q009 加密机上 node.exe 新建的文件不加密，是否可以接受（需用户或 IT 确认）

- **来源**：P1-13 第一轮，见[决策 084](decisions/084-p1-13-round1-reading.md)。
- **现象**：DSH write 新建的文件、会话日志都不加密；PowerShell、Git Bash、pwsh7 新建的文件都会加密；编辑已加密的文件后仍是加密状态。我方沙箱开、关与官方 DSH Desktop 三组的结果一样。
- **范围**：推断 v1.0.x 相同，因为它用的是同一个随包 node.exe。这一点由 P1-13b 直接验证。
- **影响**：模型把加密文件的内容写进一个新文件，这个新文件在盘上就是明文。从加密策略的角度看，这是一个外泄口。
- **可选的处理**：
  - A：接受。与 v1.0.x 一致，产品不做处理；
  - B：请 IT 调整策略，让 node.exe 新建的文件也加密；
  - C：产品里绕行，比如新文件先复制一份已加密文件再覆盖。可行性要看 P1-13b 里「先复制再覆盖」那一项的结果，而且改的是 DSH write 工具本身，维护代价高。
- **裁决时点**：P1-13b 结果回来之后。不阻塞其他任务。

## Q010 加密机能否用普通权限账户补测一次

- **原因**：第一轮两次都是管理员高权限（EnableLUA=0），ACL 沙箱在普通权限下的表现（[Q005](#q005-windows-上-acl-沙箱默认开不开工作区权限不够时怎么办)）以及加密策略对普通账户是否一样，都没有覆盖到。
- **需要用户确认**：这台机器能否临时建一个标准用户、或者借一台普通权限的加密机。做不到的话，合入前的签收要在报告里写明「仅管理员验证」。
- **裁决时点**：合入前的完整上机（P1-13 第二轮）。
