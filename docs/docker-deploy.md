# Docker 部署

Woohoo 封闭 Beta 提供两条明确的 Compose 路径：本地 Demo 使用演示配置；预发布/生产必须显式提供安全配置。不要把根目录的 Demo 配置直接当作生产配置。

## 本地 Demo

```bash
docker compose -f docker-compose.demo.yml up --build
```

也可以直接使用根目录的默认文件：

```bash
docker compose up --build
```

访问：

- 前端：<http://127.0.0.1:18080>
- 后端健康检查：<http://127.0.0.1:18081/health>

Demo 默认使用 `RUST_ENV=development`、本地 CORS 和演示 JWT。开发环境如需访问本机模型服务，可保留 `WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS=true`；不需要时可显式设置为 `false`。

## 预发布/生产

先准备环境变量，再启动生产 Compose：

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export CORS_ALLOWED_ORIGINS="https://woohoo.example.com"
export WOOHOO_API_KEY_ENCRYPTION_KEY="$(openssl rand -hex 32)"
docker compose -f docker-compose.production.yml up --build -d
```

生产启动契约：

- `JWT_SECRET` 必须是足够长且非演示值的随机密钥。
- `CORS_ALLOWED_ORIGINS` 必须是逗号分隔的完整 `http(s)` origin，只允许协议、主机和可选端口，不含路径、查询、凭据或 `*`。
- `WOOHOO_API_KEY_ENCRYPTION_KEY` 必须是 64 位十六进制字符，即 32 字节 AES-256 主密钥。它用于加密数据库中的 AI endpoint API Key，必须通过密钥管理或受保护的环境注入，不能提交到仓库或写入日志。
- `RUST_ENV` 固定为 `production`，`WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS` 固定为 `false`。

生产 Compose 使用 `${VAR:?message}`：缺少必填变量时会在容器启动前失败，不会带着 Demo 密钥运行。

## 常用变量

| 变量 | Demo 默认值 | 生产要求 | 说明 |
| --- | --- | --- | --- |
| `JWT_SECRET` | 演示密钥 | 必填，随机且非演示值 | 登录令牌签名密钥 |
| `JWT_EXPIRE_HOURS` | `72` | 可选 | 登录有效期 |
| `RUST_ENV` | `development` | 固定 `production` | 运行环境 |
| `CORS_ALLOWED_ORIGINS` | 本地前端 origins | 必填，严格 origin 列表 | 浏览器跨域来源 |
| `WOOHOO_API_KEY_ENCRYPTION_KEY` | 不需要 | 必填，64 位 hex | AI endpoint API Key 加密主密钥 |
| `WOOHOO_DEV_ALLOW_PRIVATE_ENDPOINTS` | `true` | 固定 `false` | 是否允许访问私网模型 endpoint |

## 健康检查与发布记录

启动后检查：

```bash
curl -fsS http://127.0.0.1:18081/health
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=100 server
```

每次发布记录镜像/代码版本、启动时间、健康检查结果和数据库快照目录。生产数据位于 `woohoo-production-data` 卷，备份与恢复演练见 [`staging-db-rollback-drill.md`](/C:/Users/lxy/Desktop/work/woohoo/docs/staging-db-rollback-drill.md)。

## 停止与清理

仅停止容器：

```bash
docker compose -f docker-compose.production.yml down
```

删除 Demo 数据卷（会删除 SQLite、上传文件和运行态文件）：

```bash
docker compose -f docker-compose.demo.yml down -v
```

生产环境删除数据卷前必须完成审批和可验证的备份恢复检查。
