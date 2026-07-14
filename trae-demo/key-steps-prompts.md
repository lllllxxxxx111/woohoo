# TRAE 实际迭代任务提示词

目标：这 4 段提示词不是“写材料”，而是让 TRAE 基于当前 Woohoo Studio 项目做真实更新、验证和交付。每段都可以单独开一个 TRAE 会话，完成后截图并复制 Session ID。

项目路径：

```text
C:\Users\lxy\Desktop\work\woohoo
```

推荐顺序：

1. 先做 Demo 一键体验优化。
2. 再做 Docker / GitHub 评审运行路径验证。
3. 再做核心工作台演示流程打磨。
4. 最后做质量门禁和提交材料同步。

## Task 1：增加 Demo 一键体验模式

目的：降低评审进入门槛。评审不应该先研究账号、配置和空白数据，打开后应该能快速看到 Woohoo Studio 的核心价值。

建议截图：

- TRAE 正在修改 demo onboarding / 示例项目逻辑。
- 登录页或工作台出现清晰的 Demo 入口 / 示例项目。
- 示例项目中能看到创意对话、智能体、制作流程或资产内容。

Session ID 填到：`trae-demo/session-ids.md` 第 1 行。

提示词：

```text
你是这个仓库的产品工程师。请基于当前 Woohoo Studio 项目做一个“评审 Demo 一键体验模式”，目标是让评审打开项目后能快速看到核心能力，而不是停在空白工作区。

项目路径：C:\Users\lxy\Desktop\work\woohoo

请先阅读这些文件，理解现有结构：
- src/App.tsx
- src/store/index.ts
- src/context/AppContext.tsx
- src/features/studio/components/workspace/Workspace.tsx
- src/features/studio/components/chat/ChatArea.tsx
- src/features/studio/components/sidebar/Sidebar.tsx
- src/config/defaultAgents.ts
- src/features/studio/components/workspace/workspaceMvp.ts
- server/src/db.rs
- server/src/auth/handlers.rs

任务目标：
1. 增加一个适合评审的 Demo 体验入口。可以是登录页上的“体验 Demo”提示、注册后的示例项目自动初始化，或工作台内的“载入演示项目”按钮。请选择最符合现有架构且改动最小的方案。
2. 示例内容要围绕这个短剧创意：
   “外卖骑手误入未来城市，用一单外卖改变 AI 市长的决策。”
3. 示例项目至少要体现：
   - 6 个默认智能体
   - 1 段创意对话或示例消息
   - 1 个制作流程 / 大纲 / 剧本 / 分镜相关内容
   - 资产库或导出入口可见
4. 不要引入新的大型依赖。
5. 不要破坏真实登录和注册流程。
6. 如果涉及后端默认数据，保证新用户注册后也能看到示例内容；如果只做前端演示态，也要解释为什么这样更稳。

完成后请执行：
- npm run typecheck
- npm run build

输出：
1. 改了哪些文件。
2. 评审怎么进入 Demo。
3. 适合截图的 3 个界面。
4. 仍然存在的风险。
```

## Task 2：补齐 GitHub + Docker 评审运行闭环

目的：让评审按 GitHub README 或帖子命令能跑起来。这个任务会产生真实部署相关改动和验证截图。

建议截图：

- TRAE 检查 Dockerfile / compose / Nginx。
- `docker compose config` 通过。
- Docker Desktop 可用时，`docker compose up --build` 成功或至少 build 过程截图。

Session ID 填到：`trae-demo/session-ids.md` 第 2 行。

提示词：

```text
你是这个仓库的部署工程师。请把 Woohoo Studio 的 GitHub + Docker 评审运行路径做成真正可交付状态。

项目路径：C:\Users\lxy\Desktop\work\woohoo

目标评审命令：
git clone https://github.com/lllllxxxxx111/woohoo.git
cd woohoo
git checkout codex/agent-eval-good-features
docker compose up --build

请检查并必要时修复：
- docker-compose.yml
- Dockerfile.server
- Dockerfile.web
- docker/nginx.conf
- .dockerignore
- docs/docker-deploy.md
- trae-demo/README.md
- trae-demo/submission-post.md

必须确认：
1. GitHub 分支根目录包含运行需要的 Docker 文件。
2. 前端通过 Nginx 提供，访问 http://127.0.0.1:18080。
3. 后端暴露健康检查，访问 http://127.0.0.1:18081/health。
4. 前端请求后端时走 /backend 反向代理，不依赖用户手动改环境变量。
5. Docker build 不把 node_modules、dist、server/target、data、runtime-logs、.env 打进上下文。
6. README 写明首次运行后可直接注册账号。

请执行：
- docker compose config
- 如果 Docker daemon 可用，执行 docker compose build
- 如果 Docker daemon 不可用，明确记录原因，不要假装已通过

输出：
1. 最终评审可复制运行命令。
2. 验证结果。
3. 适合截图的终端画面。
4. 如果发现 Docker 不能完整 build，请给出具体修复并实施。
```

## Task 3：打磨核心工作台演示流程

目的：让 Woohoo Studio 的“多智能体短剧创作工作台”价值在 3 分钟内可见，而不是功能分散、评审看不懂。

建议截图：

- 工作台首页：项目名、当前视图、智能体、对话。
- 创意对话：短剧创意输入和回复。
- 制作流程 / 预览视图 / 资产库：证明有产线和资产沉淀。

Session ID 填到：`trae-demo/session-ids.md` 第 3 行。

提示词：

```text
你是 Woohoo Studio 的前端产品工程师。请基于现有 React 工作台，把初赛 Demo 的核心演示流程打磨到评审一眼能看懂。

项目路径：C:\Users\lxy\Desktop\work\woohoo

请先阅读：
- src/features/studio/components/workspace/Workspace.tsx
- src/features/studio/components/workspace/PipelineArea.tsx
- src/features/studio/components/workspace/PipelinePreview.tsx
- src/features/studio/components/workspace/AssetLibrary.tsx
- src/features/studio/components/chat/ChatArea.tsx
- src/features/studio/components/chat/ChatInputArea.tsx
- src/features/studio/components/sidebar/Sidebar.tsx
- src/config/defaultAgents.ts

任务目标：
1. 梳理评审 3 分钟演示路径，并把路径反映到 UI 文案或帮助提示中。不要做营销落地页，要在真实工作台里体现。
2. 优化工作台首屏的信息密度，让评审能看到：
   - 当前产品是 Woohoo Studio
   - 当前核心是 AI 多智能体短剧创作
   - 可以从创意对话进入制作流程、图片生成、资产库和导出
3. 如果当前空状态不够清楚，请改进空状态文案和行动按钮。
4. 保持现有设计系统，不要大范围重构。
5. 所有按钮文字要短、明确、可操作。
6. 中文文案要专业，不要像宣传页。

建议演示输入：
做一个 60 秒短剧：外卖骑手误入未来城市，用一单外卖改变 AI 市长的决策。

完成后请执行：
- npm run typecheck
- npm run build

输出：
1. 修改了哪些 UI 文件。
2. 3 分钟演示脚本。
3. 3 张最适合上传到 TRAE 帖子的截图位置。
4. 如果还有未完成体验，请列出下一步最小任务。
```

## Task 4：完成参赛提交前质量门禁

目的：把代码、Docker、提交材料和 GitHub 分支做最终闭环。这个任务适合最后执行，作为发帖前最后一个 Session ID。

建议截图：

- TRAE 输出最终检查清单。
- 终端中 typecheck / build / docker compose config 结果。
- `trae-demo/submission-post.md` 最终正文。

Session ID 可选，作为第 4 个备用 ID。

提示词：

```text
你是 Woohoo Studio 的发版负责人。请对 TRAE 初赛 Demo 做最终质量门禁，不只是检查文字，要验证代码、运行路径和提交材料是否一致。

项目路径：C:\Users\lxy\Desktop\work\woohoo

请检查：
1. Git 工作区中哪些文件是本次参赛提交相关，哪些是无关脏改动，不要误提交无关内容。
2. GitHub 分支 codex/agent-eval-good-features 是否包含 Docker 运行所需文件。
3. trae-demo/submission-post.md 是否包含：
   - Demo 简介
   - Demo 创作思路
   - Demo 体验地址
   - TRAE 实践过程
   - 至少 3 张截图占位
   - 至少 3 个 Session ID 占位
   - 报名帖链接占位
4. docs/docker-deploy.md 和 trae-demo/README.md 的命令是否一致。
5. woohoo-studio-trae-demo-20260703.zip 是否包含最新文档和部署文件。

请执行：
- npm run typecheck
- npm run build
- docker compose config
- 如果 Docker daemon 可用，执行 docker compose build

请输出：
1. 最终能否提交。
2. 仍需人工补充项。
3. 发帖前 10 项清单。
4. 建议提交到 GitHub 的文件清单。
5. 不应该提交的文件清单。
```

## 截图组合建议

至少 3 张，建议 5 张：

1. Task 1：TRAE 正在实现 Demo 一键体验 / 示例项目。
2. Task 2：Docker 运行路径验证或 `docker compose config` 结果。
3. Task 3：Woohoo 工作台首页。
4. Task 3：创意对话 + 多智能体侧栏。
5. Task 3：制作流程 / 资产库 / 预览视图。

## Session ID 填写位置

把 TRAE 复制出来的 Session ID 填入：

```text
trae-demo/session-ids.md
```

再同步到：

```text
trae-demo/submission-post.md
```
