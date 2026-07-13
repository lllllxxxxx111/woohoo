# Docker 部署

本项目可以用 Docker Compose 启动一个本地 Demo 环境：

- `web`: Nginx 托管前端构建产物，并把 `/backend/*` 反向代理到后端
- `server`: Rust API 服务，使用 SQLite
- `woohoo-data`: 持久化数据库、上传资产和运行时文件

## 启动

从 GitHub 直接运行：

```bash
git clone https://github.com/lllllxxxxx111/woohoo.git
cd woohoo
git checkout codex/agent-eval-good-features
docker compose up --build
```

如果已经在项目目录内：

```bash
docker compose up --build
```

访问：

- 前端 Demo: http://127.0.0.1:18080
- 后端健康检查: http://127.0.0.1:18081/health

## 环境变量

`docker-compose.yml` 内置了演示默认值。正式部署前至少替换：

```bash
JWT_SECRET=replace-with-a-long-random-secret docker compose up --build
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 演示用强密钥 | 生产环境必须替换 |
| `JWT_EXPIRE_HOURS` | `72` | 登录有效期 |
| `RUST_ENV` | `production` | 后端运行环境 |
| `CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:18080,http://localhost:18080` | 允许访问 API 的前端来源 |

## 清理数据

仅停止容器：

```bash
docker compose down
```

同时删除 SQLite 数据卷：

```bash
docker compose down -v
```
