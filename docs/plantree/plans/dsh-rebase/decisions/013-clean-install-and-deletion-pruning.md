# 决策 013：宿主依赖在干净暂存区里 `npm ci`，再按规则删除、按清单校验

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-2 方案 §4 D3](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、[分片 02](../topics/p1-2-host-packaging/02-natives-and-size.md)。

## 规则

1. 依赖以锁文件为准，在 `out-dsh-host/` 暂存区里执行 `npm ci --ignore-scripts --no-audit --no-fund`，默认用构建机平台。**不加 `--omit=optional`**：原生件全在可选依赖里，CI 里 agent-host 的写法照抄过来会把它们全部丢掉。
2. 把 `file:` 链接物化为实拷贝。在 darwin 上，给 `spawn-helper` 补 0755。
3. 删除式裁剪（档位见[决策 014](014-host-size-budget.md)）。所有许可文件都保留，另外保留 libvips 的 README 与 `versions.json`。
4. 校验：
   - 没有符号链接；
   - 原生件按文件头判断是目标平台和架构；
   - 本平台必需的原生件齐全；
   - 可执行位正确；
   - 体积与文件数在上限内；
   - 许可清单齐全。
5. 输出 `dsh-host-manifest.json` 和 `THIRD_PARTY_LICENSES.json`。
6. 冒烟时检查模块加载路径不越出 `resources/dsh-host/`。宿主上一级的 `resources/node_modules/` 里装着 node-pty 等；裁剪误删一个依赖时，Node 会静默用上应用那一份。

## 取舍

- 不选「复用 `src/dsh-host/node_modules` 按白名单拷贝」（agent-host 的做法）：
  - 开发机上的树是 npm 10 装的，带着全平台 prebuilds 和 wasm32。
  - 白名单 walker 有已知的坑：先问目录本身、只答文件时会整包跳过，而测试全绿。
- 删除式裁剪出错时表现为「多带了」，由体积和外平台检查兜住。
- 代价：每次构建联网装一次（约 1 分钟，推断）；按平台维护一份必需件清单。
