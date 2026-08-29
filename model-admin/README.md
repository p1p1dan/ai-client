# PILAB Pi Model Admin

Phase 5 的轻量模型元数据管理端。它只管理 `models.json` 所需的通用配置，**不保存、不返回 API key**。

## 本地启动

```bash
pnpm model-admin
```

- 管理页：<http://127.0.0.1:3210>
- 客户端同步端点：<http://127.0.0.1:3210/api/v1/models-config>
- 数据文件：`model-admin/models-config.json`

## 部署到服务器

```bash
PILAB_MODEL_ADMIN_HOST=0.0.0.0 \
PILAB_MODEL_ADMIN_PORT=3210 \
PILAB_MODEL_ADMIN_TOKEN='replace-me' \
PILAB_MODEL_ADMIN_DATA=/var/lib/pilab/models-config.json \
node scripts/pi-model-admin.mjs
```

建议在生产环境前面放 HTTPS 反向代理，并设置 `PILAB_MODEL_ADMIN_TOKEN`。Token 只保护管理页的 `PUT` 写接口；客户端使用的 `GET /api/v1/models-config` 只返回非敏感模型元数据。

客户端设置页 **Pi Models** 可以修改同步 URL、打开管理页并立即同步。也可以通过环境变量 `PILAB_MODEL_CONFIG_URL` 覆盖同步端点。

## API

- `GET /health` — 健康检查
- `GET /api/v1/models-config` — 获取模型元数据
- `PUT /api/v1/models-config` — 保存模型元数据；设置了 `PILAB_MODEL_ADMIN_TOKEN` 时需 `Authorization: Bearer <token>`

服务端与客户端都会拒绝 provider/model 中的 `apiKey`、`key`、`token` 等凭据字段。客户端登录后的公司 key 进入隔离目录的 `auth.json`，不会进入 `models.json`。
