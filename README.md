功能特性

### 核心功能

- **多智能体对话** — 6 个内置领域智能体协同创作（大纲架构师、人设专家、分镜渲染师、合规审核官、主编统筹官、项目管理官）
- **协同会话** — 多智能体任务分派、循环检测、准入决策，支持问答式协作，SSE 实时事件推送
- **制作流水线** — 大纲 → 剧本 → 章节 → 角色场景 → 关键帧 → 视频，全流程自动化编排
- **AI 图片生成** — 集成 DALL-E 图片生成，支持多模型/多尺寸，内置积分计费
- **资产管理** — 统一管理图片、视频、音频、文档等创作资产
- **运维监控** — 心跳检测、异常发现、通知渠道配置

### 技术亮点

- **流式对话** — SSE 实时推送 AI 回复，支持流式输出
- **JWT 认证** — 安全的 Token 认证机制，自动刷新
- **速率限制** — 通用 API 100 次/分钟，认证端点 20 次/分钟
- **请求追踪** — 全链路 `x-request-id` 请求追踪
- **暗色主题** — 基于 Arco Design 的深色 UI 风格

***

## 技术栈

| 层级       | 技术                             | 说明           |
| -------- | ------------------------------ | ------------ |
| **前端**   | React 18 + TypeScript + Vite 5 | SPA 单页应用     |
| **UI**   | Arco Design + Lucide Icons     | 字节跳动组件库      |
| **状态管理** | Zustand 5                      | 轻量全局状态       |
| **后端**   | Rust (Axum 0.8) + Tokio        | 高性能异步 Web 服务 |
| **数据库**  | SQLite (sqlx 0.8)              | 嵌入式零配置       |
| **认证**   | JWT + bcrypt                   | 安全认证体系       |
| **桌面端**  | Tauri 2.x（可选）                  | 桌面应用封装       |

***

## 架构

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────┐
│  浏览器 / Tauri  │────▶│  Vite Dev :1420  │────▶│  SQLite  │
│   React SPA     │     │  Axum API :8080  │     │  本地存储  │
└─────────────────┘     └──────────────────┘     └──────────┘
                              │
                              ▼
                        ┌──────────┐
                        │  AI API  │
                        │ OpenAI   │
                        └──────────┘
```

### 后端模块

| 模块              | 路径                           | 说明                 |
| --------------- | ---------------------------- | ------------------ |
| `auth`          | `/api/auth/*`                | 用户注册、登录、Token 验证   |
| `workspace`     | `/api/workspace/*`           | 工作区初始化加载           |
| `project`       | `/api/projects/*`            | 项目 CRUD            |
| `conversation`  | `/api/conversations/*`       | 对话与消息管理            |
| `asset`         | `/api/assets/*`              | 资产上传与管理            |
| `script`        | `/api/projects/*/script`     | 剧本管理               |
| `storyboard`    | `/api/projects/*/storyboard` | 分镜管理               |
| `ai`            | `/api/ai/*`                  | AI 端点、智能体、对话、任务、用量 |
| `pipeline`      | `/api/pipelines/*`           | 流水线编排与执行           |
| `collaboration` | `/api/collaboration/*`       | 多智能体协同会话           |
| `image_gen`     | `/api/image-gen/*`           | AI 图片生成            |
| `billing`       | `/api/billing/*`             | 积分计费               |
| `ops`           | `/api/ops/*`                 | 运维监控               |

***

## 快速开始

### 环境要求

- **Node.js** >= 18
- **Rust** >= 1.75 (推荐 rustup 安装)
- **SQLite** (系统自带或通过 sqlx 内嵌)

### 1. 克隆项目

```bash
git clone https://github.com/lllllxxxxx111/woohoo.git
cd woohoo
```

### 2. 安装前端依赖

```bash
npm install
```

### 3. 配置后端环境变量

```bash
cp server/.env.example server/.env
```

编辑 `server/.env`，至少配置以下项：

```env
JWT_SECRET=your-secret-key-at-least-32-characters-long
DATABASE_URL=sqlite:data/woohoo.db?mode=rwc
```

### 4. 启动开发服务器

**方式一：分别启动（推荐开发时使用）**

```bash
# 终端 1 — 启动后端
npm run dev:server

# 终端 2 — 启动前端
npm run dev:client
```

**方式二：同时启动**

```bash
npm run dev:all
```

> **Git Bash 用户提示**：直接运行 `cargo build` 可能因缺少 MSVC 的
> `INCLUDE`/`LIB` 环境变量而编译失败（cl.exe 报"不包括路径集"）。
> 请改用 `./scripts/cargo.sh <cargo 参数>`，它会自动探测本机 MSVC 与
> Windows SDK 并注入环境后再执行 cargo。

### 5. 访问应用

打开浏览器访问 <http://127.0.0.1:1420>

***

## 项目结构

```
woohoo/
├── src/                          # 前端源码
│   ├── components/               # 通用组件
│   │   ├── ImageGeneration/      # 图片生成面板
│   │   └── Settings/             # 设置面板
│   ├── config/                   # 前端配置（默认智能体等）
│   ├── context/                  # React Context（AppProvider、Toast）
│   ├── features/
│   │   └── studio/               # 核心工作区
│   │       └── components/
│   │           ├── chat/         # 对话模块
│   │           └── workspace/    # 工作区模块
│   ├── lib/                      # 工具库（serverApi、helpers）
│   ├── store/                    # Zustand 全局状态
│   └── types/                    # TypeScript 类型定义
├── server/                       # 后端源码（Rust）
│   ├── src/
│   │   ├── auth/                 # 认证模块
│   │   ├── billing/              # 计费模块
│   │   ├── collaboration/        # 协同会话模块
│   │   ├── image_gen/            # 图片生成模块
│   │   ├── pipeline/             # 流水线模块
│   │   ├── ai/                   # AI 对话与任务模块
│   │   ├── ops/                  # 运维监控模块
│   │   └── main.rs               # 入口与路由注册
│   ├── migrations/               # SQLite 数据库迁移
│   └── Cargo.toml
├── docs/                         # 文档与截图
├── vite.config.ts                # Vite 配置
└── package.json
```

***

## 默认智能体

| 角色     | Agent ID                | 职责          |
| ------ | ----------------------- | ----------- |
| 大纲架构师  | `agent-outline`         | 剧情大纲与结构设计   |
| 人设生成专家 | `agent-character`       | 角色设定与人物弧光   |
| 分镜渲染师  | `agent-storyboard`      | 分镜和画面表达     |
| 合规审核官  | `agent-review`          | 内容风险审视与合规检查 |
| 主编统筹官  | `agent-chief-editor`    | 结构取舍与节奏优化   |
| 项目管理官  | `agent-project-manager` | 任务拆解与进度推进   |

***

## 环境变量

### 后端

| 变量                        | 默认值                              | 说明               |
| ------------------------- | -------------------------------- | ---------------- |
| `PORT`                    | `8080`                           | 服务端口             |
| `HOST`                    | `0.0.0.0`                        | 监听地址             |
| `DATABASE_URL`            | `sqlite:data/woohoo.db?mode=rwc` | 数据库路径            |
| `JWT_SECRET`              | (必填)                             | JWT 签名密钥 (≥32字符) |
| `JWT_EXPIRE_HOURS`        | `72`                             | Token 过期时间       |
| `ASSETS_DIR`              | `./data/assets`                  | 资产存储目录           |
| `UPLOAD_TMP_DIR`          | `./data/uploads-tmp`             | 未完成分片与合并临时目录     |
| `UPLOAD_SESSION_TTL_SECS` | `86400`                          | 分片上传会话有效期（秒）     |
| `AI_BASE_URL`             | `https://api.openai.com`         | AI API 基础 URL    |
| `AI_API_KEY`              | (可选)                             | AI API 密钥        |
| `AI_MAX_CONCURRENT_TASKS` | `10`                             | AI 最大并发任务数       |
| `CORS_ALLOWED_ORIGINS`    | (逗号分隔)                           | CORS 允许的来源       |
| `RUST_LOG`                | `woohoo_server=debug`            | 日志级别             |

### 前端

| 变量                               | 默认值                     | 说明     |
| -------------------------------- | ----------------------- | ------ |
| `VITE_SERVER_BASE_URL`           | `http://127.0.0.1:8080` | 后端服务地址 |
| `VITE_SERVER_PORT`               | `8080`                  | 后端服务端口 |
| `VITE_SERVER_REQUEST_TIMEOUT_MS` | `10000`                 | 请求超时时间 |

***

## 可用脚本

| 命令                   | 说明              |
| -------------------- | --------------- |
| `npm run dev`        | 启动前端开发服务器       |
| `npm run dev:server` | 启动 Rust 后端      |
| `npm run dev:all`    | 同时启动前后端         |
| `npm run build`      | 构建前端生产版本        |
| `npm run lint`       | ESLint 代码检查     |
| `npm run lint:fix`   | ESLint 自动修复     |
| `npm run format`     | Prettier 格式化    |
| `npm run typecheck`  | TypeScript 类型检查 |
| `npm run test`       | 运行测试            |
| `npm run tauri`      | Tauri 桌面端 CLI   |

***

## License

MIT
