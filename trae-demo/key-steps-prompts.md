# TRAE 关键步骤截图与提示词

目标：补齐初赛 Demo 帖里最容易缺失的两项材料。

- 至少 3 张开发关键步骤截图
- 至少 3 个关键任务 Session ID

建议你在 TRAE 里开 4 个独立会话。每个会话都是真实任务，完成后截图并复制 Session ID。

## Step 1：提交材料审查与缺口补齐

用途：证明你用 TRAE 理解官方规则、拆解提交要求、修正作品帖。

截图建议：

- TRAE 会话中展示官方要求拆解、缺口清单、修改建议。
- 本仓库 `trae-demo/submission-post.md` 或 `trae-demo/session-ids.md` 被更新后的差异。

Session ID 填写到：`session-ids.md` 第 1 行。

提示词：

```text
你是 TRAE AI 创造力大赛初赛提交审核助手。请基于官方初赛 Demo 发布要求，检查我的 Woohoo Studio 提交材料是否完整。

项目路径：C:\Users\lxy\Desktop\work\woohoo
重点文件：
- trae-demo/submission-post.md
- trae-demo/session-ids.md
- trae-demo/how-to-publish.md
- docs/docker-deploy.md

请完成：
1. 列出官方硬性要求。
2. 对照当前文件指出缺口。
3. 修改提交材料，让它明确包含 Demo 简介、创作思路、体验地址、TRAE 实践过程、截图位、Session ID 位、报名帖链接位。
4. 不要改无关源码。
5. 输出我应该截图的 3 个画面。
```

## Step 2：GitHub + Docker 可运行路径验证

用途：证明 Demo 不只是概念，评审可以按 GitHub + Docker 跑起来。

截图建议：

- TRAE 会话中正在检查 Docker 部署文件。
- 终端里 `docker compose config` 通过。
- 如果 Docker Desktop 已启动，再截 `docker compose up --build` 或服务健康检查。

Session ID 填写到：`session-ids.md` 第 2 行。

提示词：

```text
请帮我验证 Woohoo Studio 的评审运行路径是否足够清晰。

目标运行方式：
git clone https://github.com/lllllxxxxx111/woohoo.git
cd woohoo
git checkout codex/agent-eval-good-features
docker compose up --build

请检查：
1. GitHub 分支根目录是否包含 docker-compose.yml、Dockerfile.server、Dockerfile.web、docker/nginx.conf。
2. docker-compose.yml 是否能正确暴露前端 18080、后端 18081。
3. README 或 docs/docker-deploy.md 是否写清楚运行步骤。
4. 如果发现问题，直接修复部署说明或 Docker 配置。
5. 给我最终评审可复制的运行命令。
```

## Step 3：核心产品体验闭环

用途：证明 Demo 有可交互产品，而不是静态页面。

截图建议：

- 登录后 Woohoo Studio 工作台首页。
- 创意对话区 + 智能体侧栏。
- 输入短剧创意后，展示多智能体创作方向或消息流。

Session ID 填写到：`session-ids.md` 第 3 行。

提示词：

```text
请帮我设计并验证 Woohoo Studio 的 3 分钟 Demo 演示路径。

产品定位：AI 多智能体短剧创作工作台。
核心体验：创意对话、多智能体分工、制作流程、资产库、导出。

请输出：
1. 一个 3 分钟演示脚本。
2. 用户要在输入框里输入的一句短剧创意。
3. 每一步应该点击哪里、展示什么价值。
4. 哪 3 个界面最适合截图给评审。
5. 如果当前 UI 中有明显影响演示的问题，请指出并给出最小修复建议。

示例短剧创意：
做一个 60 秒短剧：外卖骑手误入未来城市，用一单外卖改变 AI 市长的决策。
```

## Step 4：发帖前最终检查

用途：证明你用 TRAE 做了交付前自检，降低漏项风险。

截图建议：

- TRAE 会话中展示最终检查结果。
- 发帖正文预览。
- GitHub 分支或附件链接。

Session ID 可选，作为第 4 个备用 ID。

提示词：

```text
请做一次 TRAE 初赛 Demo 发帖前最终检查。

请检查以下内容是否齐全：
1. 帖子标题是否包含赛道和作品名。
2. 标签是否选择“学习工作”。
3. 正文是否包含 Demo 简介、创作思路、体验地址、TRAE 实践过程。
4. 是否有不少于 3 张关键步骤截图。
5. 是否有不少于 3 个关键任务 Session ID。
6. 是否附上报名通过的报名帖链接。
7. GitHub 或 Docker 体验方式是否清晰。

请输出：
- 可以直接复制到论坛的最终正文。
- 仍需人工补充的占位项。
- 发布前 5 项检查清单。
```

## 推荐截图组合

至少上传 3 张，建议 5 张：

1. TRAE 会话：官方要求拆解和提交材料更新。
2. TRAE 会话：Docker 运行路径检查。
3. Woohoo 登录后工作台首页。
4. 创意对话 + 多智能体侧栏。
5. 制作流程 / 预览视图 / 资产库三选一。

## Session ID 获取提醒

在 TRAE 中打开对应会话，双击会话头像复制 Session ID。把复制到的 ID 填入：

```text
trae-demo/session-ids.md
```

然后再同步到：

```text
trae-demo/submission-post.md
```
