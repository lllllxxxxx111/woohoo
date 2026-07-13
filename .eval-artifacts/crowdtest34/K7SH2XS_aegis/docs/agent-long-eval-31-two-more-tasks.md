# 方舟第 31 期 Agent 长程众测补充任务 2 份

> 适用仓库：`C:\Users\lxy\Desktop\work\woohoo`
> 使用方式：下面两套任务应分别在平台中新建任务；每套任务内部 4 个模型必须使用完全相同 Prompt。
> 任务类型：31期 Agent 长任务众测
> 重要提醒：反馈和评分必须基于你本人下载产物后的真实运行、截图和验证结果。

---

## 任务 A：跨项目素材治理、引用关系与安全删除

### A.1 建议提交信息

任务标题：

```text
Woohoo Studio 增加跨项目素材搜索、标签过滤、引用关系展示与删除前影响检查
```

任务背景：

```text
Woohoo Studio 当前已经有素材上传、项目内素材库、图片/视频/音频/文档预览、收藏、评分和 metadata 展示能力。真实使用中，一个创作者会在多个项目间复用角色图、场景图、脚本文档、音频素材。现有素材库更偏当前项目视角，缺少跨项目搜索、标签筛选、引用关系检查和删除保护，容易误删被分镜或生产流水线引用的素材。

真实业务目标是把素材库从“项目内文件列表”升级为“可治理的创作资产库”：支持跨项目查找、标签维护、引用关系展示，并在删除前明确告知会影响哪些项目/分镜/流水线结果。
```

建议上传依赖：

```text
上传整个仓库文件夹，排除 node_modules、dist、data、runtime-logs、.git。
如果平台上传全量很慢，可以至少上传：
- package.json
- server/Cargo.toml
- server/migrations/
- server/src/asset/
- server/src/storyboard/
- server/src/pipeline/
- server/src/main.rs
- src/features/studio/components/workspace/AssetLibrary.tsx
- src/features/studio/components/workspace/AssetLibrary.module.css
- src/lib/serverApi.ts
- src/lib/assetLibraryView.ts
- src/store/index.ts
- docs/current-system-architecture.md
```

### A.2 固定首轮 Prompt

```text
你现在在 Woohoo Studio 仓库中工作。请先阅读 package.json、docs/current-system-architecture.md，以及素材库、资产 API、分镜、pipeline、serverApi 和 store 相关代码，再实现一个真实可用的“跨项目素材治理、引用关系与安全删除”功能。

项目背景：
- 前端：React 18 + TypeScript + Vite + Arco Design + Zustand。
- 后端：Rust Axum + SQLite + sqlx。
- 当前已有 AssetLibrary.tsx 素材库 UI，支持项目内展示、上传、预览、收藏、评分、删除。
- 后端已有 server/src/asset handlers/repo/model，assets 表，storyboard_line_assets 关联表，pipeline_step_outputs 和 pipeline document asset 相关逻辑。
- 当前素材 metadata 已被用于 sizeBytes、prompt、rating、favorite、review 信息等，不要破坏已有 metadata。

业务目标：
1. 跨项目素材搜索：
   - 新增后端搜索能力，支持当前用户所有项目范围内检索素材。
   - 支持 query、asset type、projectId、favoriteOnly、ratingMin、tag、sort、limit/offset。
   - 搜索字段至少包括素材名、项目名、metadata 中常见字段（prompt、summary、description、tags）。
   - 只能返回当前登录用户有权限的素材，不能跨用户泄露。
2. 标签治理：
   - 支持给素材维护 tags。
   - 可以选择使用 assets.metadata.tags，也可以新增 asset_tags 表；请说明设计理由。
   - 必须兼容已有素材 metadata，不要覆盖 favorite/rating/prompt 等字段。
3. 引用关系查询：
   - 新增 GET /api/assets/{id}/references 或等价 API。
   - 至少识别 storyboard_line_assets 中的分镜引用。
   - 尽量识别 pipeline_step_outputs、生成结果 metadata 或其它当前仓库中能可靠识别的引用。
   - 返回结构要包含引用类型、项目名/ID、分镜号或 step 信息、可展示标题。
4. 安全删除：
   - 删除素材前如果存在引用，前端必须展示影响范围并要求二次确认。
   - 后端也要有保护，不能只靠前端弹窗。可以默认拒绝删除被引用素材，另提供 force=true 或专门的确认字段。
   - 删除本地上传文件时继续保持现有路径安全检查。
5. 前端 UI：
   - 在 AssetLibrary 中加入跨项目/当前项目 scope 切换、标签筛选、项目筛选和引用信息入口。
   - 素材详情面板展示 tags 和引用关系。
   - 删除按钮需要先加载引用关系；有引用时显示项目/分镜/流水线影响，用户确认后才允许强制删除。
   - 保持现有网格/列表、收藏、评分、上传、预览能力不回退。
6. 测试与验证：
   - 补充 TypeScript 测试，优先覆盖 assetLibraryView 过滤/排序/标签解析、serverApi 类型映射或前端删除保护辅助逻辑。
   - 如能补 Rust 单元测试更好，尤其是搜索参数解析、引用查询、删除保护。
   - 必须运行 npm run typecheck、npm run test、npm run build，并说明结果。

约束：
- 不要重写整个素材库。
- 不要删除现有素材 metadata 字段。
- 不要把跨项目搜索做成纯前端过滤；必须有后端 API 支撑。
- 不要绕过权限校验。
- 不要为了实现搜索引入外部服务或新数据库。
- 保持现有代码风格，优先复用 AssetLibrary、serverApi、asset repo/handlers 的已有模式。

最终交付：
- 说明改了哪些文件。
- 说明新增 API 形状。
- 说明引用关系和删除保护逻辑。
- 说明运行了哪些验证命令及结果。
```

### A.3 后续 9 轮追加话术

第 2 轮：

```text
请继续自查你刚才的改动：确认跨项目素材搜索不是只在前端过滤当前已加载 assets，而是有后端 API 支撑，并且只返回当前登录用户可访问的素材。如果有遗漏请补齐。
```

第 3 轮：

```text
请检查 tags 设计是否兼容已有 metadata。favorite、rating、prompt、reviewSummary、sizeBytes 等字段不能被覆盖或丢失。必要时补充 metadata merge/helper 和测试。
```

第 4 轮：

```text
请完善引用关系查询：至少要能识别 storyboard_line_assets 的分镜引用，并在前端详情面板展示项目名、分镜号或可读标题。不能只返回裸 ID。
```

第 5 轮：

```text
请补齐安全删除闭环：有引用的素材，后端默认不能直接删除；前端删除前要展示影响范围并二次确认。请修复任何只靠前端阻止或只靠后端报错但 UI 不清楚的问题。
```

第 6 轮：

```text
请检查 AssetLibrary 的现有能力是否回退：上传、预览、收藏、评分、搜索、网格/列表切换都应继续可用。若你改动了相关状态或组件，请自查并修复。
```

第 7 轮：

```text
请补充测试，优先覆盖标签解析、搜索参数规范化、引用结果展示/删除保护辅助逻辑。不要为了测试大幅重构无关代码。
```

第 8 轮：

```text
请运行 npm run typecheck 和 npm run test，并根据失败信息修复问题。请在回复中贴出关键结果。如果命令无法运行，请说明具体失败原因。
```

第 9 轮：

```text
请运行 npm run build，并修复构建失败。然后说明 Rust 后端代码的主要编译风险点，以及你如何检查这些风险。
```

第 10 轮：

```text
请最后收尾：列出最终改动文件、新增 API、手工验收步骤、已知限制和验证命令结果。不要继续扩大功能范围，只修明显 bug 或遗漏。
```

### A.4 验收清单

基础命令：

```powershell
npm run typecheck
npm run test
npm run build
```

手工检查：

```text
- 切换“当前项目/全部项目”后，素材范围确实变化。
- 通过素材名、项目名、prompt/summary、tag 能查到素材。
- 给素材新增/删除标签后，favorite/rating/prompt 等 metadata 不丢。
- 打开素材详情能看到引用关系。
- 删除被分镜引用的素材时，前端显示影响范围，后端默认拒绝或要求显式 force。
- 强制删除后引用处理逻辑清楚，不出现前端假成功。
```

建议截图：

```text
1. 跨项目素材搜索结果。
2. 标签筛选和标签编辑。
3. 素材详情中的引用关系。
4. 删除被引用素材时的影响范围确认弹窗。
5. typecheck/test/build 结果。
```

---

## 任务 B：Pipeline 失败诊断、人工复核队列与重试闭环

### B.1 建议提交信息

任务标题：

```text
Woohoo Studio 增加 Pipeline 失败诊断、人工复核队列与步骤级重试闭环
```

任务背景：

```text
Woohoo Studio 当前已有 pipeline_runs、pipeline_run_steps、pipeline_run_events、pipeline_prompt_optimizations，以及 pause/resume/cancel/retry-step 等接口。真实创作流水线里，AI 生成大纲、脚本、角色场景、关键帧、视频等步骤经常会因为模型输出格式、审核失败、上下文不足或资源缺失而中断。现在缺少一个集中查看失败步骤、读取失败原因、采纳优化建议、记录人工复核意见并重新推进的工作台。

真实业务目标是：让创作者或运营人员不用翻日志，就能在前端看到所有需要人工处理的 Pipeline 步骤，判断失败原因，写入复核意见，选择重试/跳过/取消，并保留审计记录。
```

建议上传依赖：

```text
上传整个仓库文件夹，排除 node_modules、dist、data、runtime-logs、.git。
如果平台上传全量很慢，可以至少上传：
- package.json
- server/Cargo.toml
- server/migrations/
- server/src/pipeline/
- server/src/ai/
- server/src/main.rs
- src/features/studio/components/workspace/PipelineArea.tsx
- src/features/studio/components/workspace/PipelinePreview.tsx
- src/features/studio/components/workspace/PipelineSteps/
- src/lib/serverApi.pipeline.ts
- src/lib/serverApi.ts
- src/store/index.ts
- docs/backend-ai-runtime.md
- docs/current-system-architecture.md
```

### B.2 固定首轮 Prompt

```text
你现在在 Woohoo Studio 仓库中工作。请先阅读 package.json、docs/current-system-architecture.md、docs/backend-ai-runtime.md，以及 pipeline handlers/orchestrator/model、serverApi.pipeline、PipelinePreview、PipelineSteps 相关代码，再实现一个真实可用的“Pipeline 失败诊断、人工复核队列与步骤级重试闭环”功能。

项目背景：
- 前端：React 18 + TypeScript + Vite + Arco Design + Zustand。
- 后端：Rust Axum + SQLite + sqlx。
- 当前已有 pipeline_runs、pipeline_run_steps、pipeline_run_events、pipeline_step_outputs、pipeline_prompt_optimizations。
- 当前已有 POST /api/pipelines/runs/{id}/pause、resume、cancel、retry-step，以及 GET run detail 和 SSE stream。
- 当前 PipelinePreview 更偏任务时间线展示，不是完整的人工复核工作台。

业务目标：
1. 失败/阻塞步骤聚合：
   - 新增一个人工复核队列 API，例如 GET /api/pipelines/review-queue。
   - 支持按 projectId、status、pipelineType、limit/offset 过滤。
   - 聚合当前用户下 failed、blocked、需要人工复核或有 prompt optimization 的步骤。
   - 返回 run、step、最近事件、错误信息、优化建议数量、项目/会话标识等 UI 可直接展示的信息。
2. 复核记录：
   - 增加可持久化的人工复核记录，可以新增 pipeline_manual_reviews 表，也可以基于现有 event 表扩展；请说明理由。
   - 至少记录 reviewer user_id、run_id、step_id、decision、note、created_at。
   - decision 至少支持 retry、skip、cancel、acknowledge 中合理的一组；如果你认为 skip 不适合当前状态机，请说明并不要硬做假功能。
3. 步骤级复核动作：
   - 新增 API，例如 POST /api/pipelines/runs/{runId}/steps/{stepId}/review-decision。
   - retry 应复用或兼容现有 retry-step 语义，写入复核意见和 pipeline event。
   - cancel 应能取消 run 或将当前 run 进入终态，不能留下 UI 显示 running 但后端已不可推进的状态。
   - acknowledge 可仅记录已知晓，不改变运行状态。
   - 所有动作都要校验用户权限和步骤归属。
4. 前端工作台：
   - 在 Pipeline 区域或 PipelinePreview 增加“人工复核/失败队列”视图。
   - 列表展示失败步骤、错误摘要、所属项目/流程、最近更新时间、优化建议。
   - 详情区域展示最近事件、prompt optimization、历史复核记录。
   - 支持输入复核意见并执行 retry/cancel/acknowledge。
   - 动作成功后刷新队列和当前 run 详情。
5. 状态与边界：
   - 不要破坏已有 pause/resume/cancel/retry-step。
   - 不要把失败队列做成纯前端假数据。
   - 对已经 completed/cancelled 的 run，复核动作要给出合理错误。
   - SSE 连接失败时，工作台仍可通过普通 HTTP 刷新获取状态。
6. 测试与验证：
   - 补充 TypeScript 测试或 Rust 测试，优先覆盖 review queue 过滤、decision payload 校验、状态转换辅助逻辑、前端数据映射。
   - 必须运行 npm run typecheck、npm run test、npm run build，并说明结果。

约束：
- 不要重写整个 Pipeline Orchestrator。
- 不要把人工复核记录只存前端状态。
- 不要删除现有 pipeline_run_events 和 optimization 能力。
- 不要引入外部队列或服务。
- 保持现有代码风格，优先复用 pipeline handlers、serverApi.pipeline、PipelinePreview/PipelineSteps 的已有模式。

最终交付：
- 说明改了哪些文件。
- 说明新增 API 形状。
- 说明复核队列和复核动作的状态流转。
- 说明运行了哪些验证命令及结果。
```

### B.3 后续 9 轮追加话术

第 2 轮：

```text
请继续自查你刚才的改动：确认人工复核队列来自后端真实 pipeline_runs/pipeline_run_steps/pipeline_run_events/pipeline_prompt_optimizations 数据，而不是前端静态 mock 或只读当前页面内存。
```

第 3 轮：

```text
请检查权限与归属：review queue 和 review decision 必须只操作当前登录用户自己的 run 和 step，stepId 必须属于 runId。若缺失请补齐。
```

第 4 轮：

```text
请完善复核记录持久化：每次 retry/cancel/acknowledge 都要留下可查询记录或 pipeline event，包含用户、时间、决策和备注。前端详情里要能看到历史复核记录。
```

第 5 轮：

```text
请检查 retry 动作是否和现有 retry-step 语义一致。不要创建一个看似重试但 orchestrator 不会继续推进的状态。必要时复用现有 retry-step 逻辑。
```

第 6 轮：

```text
请完善前端失败队列体验：列表、详情、错误摘要、优化建议、复核意见输入、retry/cancel/acknowledge 按钮都要可用，并且动作后能刷新状态。
```

第 7 轮：

```text
请处理边界状态：completed/cancelled 的 run 不允许 retry；已经 acknowledged 的记录不应导致重复误操作；SSE 断开时仍能通过手动刷新看到队列。
```

第 8 轮：

```text
请补充测试，优先覆盖 review queue 数据映射、decision 校验、状态转换或前端复核动作辅助逻辑。不要为了测试大幅重构无关代码。
```

第 9 轮：

```text
请运行 npm run typecheck 和 npm run test，并根据失败信息修复问题。请在回复中贴出关键结果。如果命令无法运行，请说明具体失败原因。
```

第 10 轮：

```text
请运行 npm run build 并收尾：列出最终改动文件、新增 API、端到端验收步骤、已知限制和验证命令结果。不要继续扩大功能范围，只修明显 bug 或遗漏。
```

### B.4 验收清单

基础命令：

```powershell
npm run typecheck
npm run test
npm run build
```

手工检查：

```text
- 能看到 failed/blocked/有优化建议的 pipeline 步骤队列。
- 队列项包含项目/流程/步骤/错误摘要/最近时间。
- 打开详情能看到最近事件、prompt optimization、复核历史。
- 输入复核意见后 retry 能让步骤进入 retrying 或可被 orchestrator 继续推进的状态。
- cancel 能把 run 置为合理终态，不留下假 running。
- acknowledge 会记录复核但不伪造成功。
- 当前用户不能访问或操作别人的 run/step。
```

建议截图：

```text
1. 人工复核队列列表。
2. 失败步骤详情和错误摘要。
3. prompt optimization / 最近事件 / 复核历史。
4. 输入复核意见并执行 retry 或 cancel。
5. typecheck/test/build 结果。
```

---

## 通用评分参考

高分特征：

```text
- 模型先读架构文档和相关模块，再动手。
- 能沿用现有 Rust Axum、sqlx、serverApi、Zustand/React 结构。
- 后端 API、权限、持久化、前端 UI 和测试验证形成闭环。
- 多轮中能根据测试失败继续修复。
- 对状态机、旧库兼容、metadata 兼容等边界有明确处理。
```

低分特征：

```text
- 只写方案或只改 UI。
- 用静态 mock 数据冒充真实后端能力。
- 没有权限校验。
- 破坏现有上传/预览、pipeline 控制或 workspace bootstrap。
- 构建失败且没有有效修复。
- 反馈中无法解释新增 API 和状态流转。
```

反馈模板：

```text
我本地下载并运行了该模型产物，重点检查了后端 API、前端入口、权限/状态边界、测试和构建结果。

优点：
- （根据实际产物填写）

问题：
- （根据实际产物填写，建议引用具体文件或截图）

验证结果：
- npm run typecheck：（通过/失败，失败原因）
- npm run test：（通过/失败，失败原因）
- npm run build：（通过/失败，失败原因）
- 手工验证：（功能链路是否符合预期）

综合判断：
- （说明为什么给这个分数）
```
