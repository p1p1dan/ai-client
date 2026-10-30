# PiLab Ai 1.2.2

## 问题修复

- **不再往 Cadence / Allegro 的配置目录里写文件。** 装了 Cadence 的 Windows 电脑会设置
  环境变量 HOME（例如 `D:\cadence\Cadence\SPB_Data`），之前的版本因此每次启动都在那里生成
  `.pilab` 文件夹，影响 Allegro 导出 DXF。现在数据一律放在 `C:\Users\<用户名>\.pilab`；
  已经生成在 HOME 里的数据会在第一次启动时自动搬过来，聊天记录和登录都保留，原目录随后删除。
- 扩展页的技能与插件说明文字精简。
