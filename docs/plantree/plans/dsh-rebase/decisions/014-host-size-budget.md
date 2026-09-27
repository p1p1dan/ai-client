# 决策 014：宿主体积按 B 档裁剪，硬上限每平台 128 MiB / 1.2 万个文件

日期：2026-09-26。**状态：自主决定，待用户审批。** 依据：[P1-2 方案 §4 D4](../topics/p1-2-host-packaging.md#4-需要拍板的决策点)、[分片 02](../topics/p1-2-host-packaging/02-natives-and-size.md)。

## 规则

1. 在 P0-4 工具包的裁剪之外，B 档再删：`.md`（libvips 的 README 豁免）、`.pdb`、musl 与 wasm32 变体、原生源码。
2. 硬上限：每平台解压后 128 MiB、1.2 万个文件，超过就构建失败。
3. 目标：解压 ≤ 110 MiB，安装包增量 ≤ 30 MB。
4. OpenTelemetry（约 6 MiB）暂时保留。要删它（C 档），得先证明被关掉的行不会 import 它的包，而且 DSH 每次升级都要重新证明。

## 取舍

- B 档在 Linux 上实测 98.5 MiB、约 1.02 万个文件，xz 压缩后 16.7 MB。Windows、macOS 推断为 96～106 MiB。
- 与 agent-host（85 MiB）并存期间，Windows 安装包从约 180～188 MB 涨到约 200～215 MB（推断）。P1-12 删掉 `resources/agent-host` 后，解压净增约 15 MiB（推断）。
- P1-10 加预装插件时，重定这组上限。
