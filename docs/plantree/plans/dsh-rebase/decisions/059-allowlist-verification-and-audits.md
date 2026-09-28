# 决策 059：白名单由仓库清单 + 锁文件双键校验，加构建期与启动期审计；启用按宿主级

日期：2026-09-27。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-10 / P1-16 方案 §5 D4、D6](../topics/p1-10-p1-16-extensions.md#5-需要拍板的决策点)、[决策 023](023-no-dotenv-private-cwd-home-patch-overlay.md)。

## 规则

1. 清单 `src/dsh-host/plugins/allowlist.json` 的每一项包括：
   - 名字、精确版本，以及与锁文件相同的 `integrity`；
   - `kind`：`official` 或 `internal`；
   - `defaultEnabled`；
   - 允许插入的 `rows`；
   - 各工具的过闸分类，默认 `'*': 'ask'`，只能按读、写细分；
   - 审查记录，以及可选的 `replaces`。

   清单由工程经 PR 修改，清单与锁文件必须同时改，静态测试核对。
2. 构建期审计：
   - integrity 一致；
   - 对钉住的 DSH 兼容，不许豁免；
   - bundle 补丁只能 insert 自己声明的行，不许改已有的 id；
   - 不带 `dsh.client`，不跑安装脚本；
   - 依赖闭包全部在册；
   - 体积、许可合规；
   - 敏感 API 扫描报告。

   结果写进 `dsh-host-manifest.json` 的 `plugins` 段。
3. 启动期组合审计：
   - bundles 只能是产品 bundle 加已启用的白名单项；
   - 插件管理两行保持关闭；
   - `aiclient-bridge`、`aiclient-permissions`、`aiclient-credentials` 必须启用；
   - **home 层补丁插入了未声明的行，产品态拒绝启动。这一条细化了决策 023。**
4. 启用粒度是宿主级：Main 的设置里存启用集合，切换走 `invalidateAll`（决策 025），有在飞回合就等空闲再重启宿主。
5. 每次插件升版、DSH 升版，都重审白名单（决策 003 第 2 条）。

## 取舍

- 不选「另加签名清单，运行期验签」：安装目录与 `app.asar` 处在同一信任级别，运行期验签没有实质增益。
- 按会话启用不可行：DSH 的组合是宿主级的（决策 019）。
- 代价：审计规则要随 DSH 升级维护；切换插件会让宿主重启一次。
