# 〖学习工作赛道〗Woohoo Studio：AI 多智能体短剧创作工作台 Demo

> 发帖标签请选择：`学习工作`
>
> 提交前请替换：体验地址、报名帖链接、Session ID、截图。

## 1. Demo 简介

Woohoo Studio 是一个面向短剧、短视频和创意内容团队的 AI 多智能体创作工作台。它把「创意对话」「多智能体分工」「制作流水线」「AI 图片生成」「资产管理」「工程导出」放进同一个工作区，帮助创作者从一句想法快速推进到可交付的策划包和素材资产。

面向用户：

- 短剧创作者、短视频团队、自媒体运营者
- 需要快速完成创意策划、脚本拆解、分镜规划的学生或小型内容团队
- 希望把 AI 从单轮问答变成协同生产流程的创作者

核心功能：

- 多智能体创意对话：内置大纲架构师、人设生成专家、分镜渲染师、合规审核官、主编统筹官、项目管理官。
- 制作流水线：覆盖大纲、剧本、章节、角色场景、关键帧、视频等阶段。
- 资产库与导出：统一管理图片、视频、音频、文档资产，并支持导出完整工程包或核心策划包。

## 2. Demo 创作思路

短剧创作通常会在多个工具之间来回切换：聊天工具里想创意，文档里写大纲和剧本，表格里管分镜，网盘里堆素材，最后再手动整理交付包。这个过程容易丢上下文、丢版本，也很难让不同角色的意见形成结构化产出。

Woohoo Studio 的判断是：AI 创作工具不应该只停留在「聊天框」，而应该变成一条可运行的创意产线。创作者先用对话探索想法，再让不同智能体分工补齐结构、人设、分镜、合规和项目推进，最后沉淀到制作流程和资产库里。

我做这个方向的原因：

- 创意团队真实需要「从想法到交付」的一体化工作台，而不是多个零散工具。
- 多智能体协作适合短剧这种角色分工明确、产物阶段清晰的场景。
- 初赛 Demo 阶段先保证核心体验闭环：登录、对话、智能体、流程、资产、导出都能跑通。

## 3. Demo 体验地址

推荐直接从 GitHub 拉取后用 Docker 体验：

```bash
git clone https://github.com/lllllxxxxx111/woohoo.git
cd woohoo
git checkout codex/agent-eval-good-features
docker compose up --build
```

访问：

- 前端：http://127.0.0.1:18080
- 后端健康检查：http://127.0.0.1:18081/health

源码分支：

- https://github.com/lllllxxxxx111/woohoo/tree/codex/agent-eval-good-features

也可以下载附件 `woohoo-studio-trae-demo-20260703.zip` 后解压运行：

```bash
docker compose up --build
```

开发模式：


```bash
npm install
npm run dev:all
```

访问：

- 前端：http://127.0.0.1:1420
- 后端健康检查：http://127.0.0.1:8080/health

如需要上传附件，可上传 `woohoo-studio-trae-demo-20260703.zip`。如果社区附件超过限制，请上传到 GitHub、飞书云文档或其他可公开访问的位置，并在这里填写公开链接：

- 体验/源码附件链接：https://github.com/lllllxxxxx111/woohoo/tree/codex/agent-eval-good-features

演示账号：

- 邮箱：`trae-demo@woohoo.local`
- 密码：`Woohoo2026`

如果在新环境运行，也可以直接注册新账号。

## 4. TRAE 实践过程

本 Demo 使用 TRAE 辅助完成需求拆解、UI 工作台、后端服务、数据持久化、AI 任务、Docker 部署和提交材料整理。

关键步骤：

1. 明确产品方向：把「AI 短剧创作」从单轮对话扩展为多智能体工作台。
2. 搭建工作台界面：实现登录、项目侧栏、创意对话、智能体列表、制作流程、资产库、预览视图。
3. 补齐后端能力：使用 Rust + Axum + SQLite 支撑认证、项目、对话、资产、AI 任务、协同会话等 API。
4. 接入生产流程：实现从对话进入制作流程、图片生成资产入库、服务端任务状态监控。
5. 准备交付方式：补充 Docker Compose、本地运行说明、构建验证和提交包。

关键截图：

1. 登录页或登录后工作台首页：待上传
2. 创意对话 + 多智能体列表：待上传
3. 制作流程 / 管线预览：待上传
4. 图片生成 / 资产库：可选

Session ID：

1. 待填写
2. 待填写
3. 待填写

Session ID 获取方式：在 TRAE 里找到关键任务会话，双击会话头像复制 Session ID。

## 5. 技术实现

- 前端：React 18 + TypeScript + Vite 5
- UI：Arco Design + Lucide Icons
- 状态管理：Zustand
- 后端：Rust + Axum + Tokio
- 数据库：SQLite + sqlx
- 鉴权：JWT + bcrypt
- 部署：Docker Compose，Nginx 反向代理前端和后端

## 6. 已验证状态

- `npm run typecheck` 通过
- `cargo check --manifest-path server/Cargo.toml` 通过
- `npm run build` 通过
- 本地前端 `http://127.0.0.1:1420` 返回 200
- 本地后端 `http://127.0.0.1:8080/health` 返回 `status: ok`

## 7. 报名帖链接

通过审核的报名帖链接：待填写
