# 方舟第 32 期 Agent 长程众测准备稿

> 适用仓库：`C:\Users\lxy\Desktop\work\woohoo`
> 建议 Harness：Hermes；若平台只允许 Openclaw，则切换为 Openclaw
> 众测任务类型：32期Agent长程任务众测
> 截止时间：2026-07-06 12:00

## 0. 众测硬性要求

- 每个任务必须是真实 Agent 开发场景，有明确业务价值。
- 同一条 Prompt 必须跑完 4 个模型：raptor、saber、tempest、umbra。
- 一个任务里每个模型的工具调用轮次都要超过 300，并完成所有模型反馈，才算完成。
- 每人最多提交 2 条高质量任务。
- 任务选择必须选择【32期Agent长程任务众测】。
- 不能复用历史众测完全相同的任务 Prompt；本期不要复用第 31 期的预算控制、跨项目素材治理、Pipeline 人工复核题。

当前平台公开接口暂未显示【32期Agent长程任务众测】；拿到正确评测任务 ID 后，用 `eval-results/crowdtest32-create-tasks.mjs` 创建任务，用 `eval-results/crowdtest32-append-rounds.mjs` 追加第 2-10 轮。

---

## 任务 A：AI Endpoint 能力画像、智能路由与失败降级闭环

### A.1 建议提交信息

任务标题：

```text
Woohoo Studio 增加 AI Endpoint 能力画像、智能路由与失败降级闭环
```

任务背景：

```text
Woohoo Studio 是一个本地优先的 AI 短剧创作工作台，前端使用 React + TypeScript + Vite，后端使用 Rust Axum + SQLite。当前系统已经有 AI endpoint 管理、endpoint capability、同步/流式 chat、异步 AI task、图片生成、视频生成、pipeline、用量流水和运维监控，但各入口选择模型与 endpoint 的逻辑仍然分散：用户需要手动知道哪个 endpoint 支持 chat、image、video 或长上下文；当 endpoint 失败时，系统缺少可审计的自动降级、失败原因聚合和前端健康提示。

真实业务需求是：小团队通常同时配置 OpenAI、OpenRouter、火山、内部网关等多个 endpoint。创作流程中 chat、pipeline、图片、视频任务都要自动选择合适 endpoint；某个 endpoint 超时、限流、能力不匹配或返回 5xx 时，系统应能按策略 fallback 到候选 endpoint，并把这次路由、失败和降级记录下来，方便运营排查模型稳定性。
```

建议上传依赖：

```text
上传整个仓库文件夹，排除 node_modules、dist、data、runtime-logs、.git。
如果平台上传全量很慢，至少上传：
- package.json
- tsconfig.json
- vite.config.ts
- server/Cargo.toml
- server/migrations/
- server/src/ai/
- server/src/ops/
- server/src/pipeline/
- server/src/image_gen/
- server/src/video_gen/
- server/src/main.rs
- src/components/Settings/EndpointManagement.tsx
- src/components/Settings/OpsMonitorPanel.tsx
- src/lib/serverApi.endpoints.ts
- src/lib/serverApi.ts
- src/context/hooks/useAiMessageRuntime.ts
- src/features/studio/components/chat/hooks/useMessageActions.ts
- docs/current-system-architecture.md
- docs/backend-ai-runtime.md
```

### A.2 固定首轮 Prompt

```text
你现在在 Woohoo Studio 仓库中工作。请先阅读 README、package.json、docs/current-system-architecture.md、docs/backend-ai-runtime.md，以及 AI endpoint、capabilities、chat/task、image_gen、video_gen、pipeline、ops monitoring、EndpointManagement 和 serverApi.endpoints 相关代码，再实现一个真实可用的“AI Endpoint 能力画像、智能路由与失败降级闭环”功能。

项目背景：
- 前端：React 18 + TypeScript + Vite + Arco Design + Zustand。
- 后端：Rust Axum + SQLite + sqlx。
- 当前已有 ai_endpoints、ai_endpoint_capabilities、/api/ai/endpoints、/api/ai/endpoint-capabilities、同步 chat、流式 chat、异步 AI task、图片生成、视频生成、pipeline、ai_usage_events 和 ops monitor。
- 当前代码里 capability 主要用于 image/video 的模型选择，chat/task/pipeline 入口仍然缺少统一的路由、fallback 与审计闭环。

业务目标：
1. 能力画像：
   - 为每个 AI endpoint 维护可展示的 capability profile，至少包含 chat、stream_chat、image_generation、video_generation、long_context、tool_use。
   - 每项 capability 支持 enabled、preferredModel、maxContextTokens、priority、notes 或等价字段。
   - 兼容现有 ai_endpoint_capabilities，不破坏旧库启动；可以新增 migration 或扩展 metadata，但要说明理由。
2. 智能路由：
   - 新增后端统一路由 helper，用于根据 operation/capability、用户、请求模型、上下文长度、是否需要 streaming/tool use 选择 endpoint。
   - 优先级应综合显式 endpointId、capability priority、active 状态、模型匹配和健康状态。
   - chat、stream chat、AI task、pipeline、image generation、video generation 至少要接入这个 helper 中合理的一部分；不能只做 UI。
3. 失败降级：
   - 当选中 endpoint 出现超时、429、5xx、能力不匹配或网络错误时，按同 capability 候选 endpoint 进行 fallback。
   - fallback 必须有最大尝试次数，避免无限重试。
   - 对不可重试错误（认证失败、请求参数非法、内容安全拒绝等）不要盲目 fallback。
4. 审计与可观测：
   - 持久化或至少结构化记录每次路由决策、失败原因、fallback 链路、最终 endpoint/model、耗时和结果。
   - 新增 GET API，例如 /api/ai/routing/events 或 /api/ops/ai-routing，支持分页和按 endpoint/capability/status 过滤。
   - 用量流水 ai_usage_events 仍要保留 endpoint/model 信息，不能因为 fallback 丢失统计。
5. 前端体验：
   - 在 Settings 的 EndpointManagement 或 OpsMonitorPanel 中展示 endpoint 能力画像、健康状态、最近 fallback/失败次数。
   - 支持编辑 capability profile 的核心字段，并清楚展示默认路由优先级。
   - 当一次 AI 请求发生 fallback 时，聊天/任务/生成入口至少能显示可理解提示或在详情中可查到路由事件。
6. 测试与验证：
   - 补充 TypeScript 测试或 Rust 单元测试，优先覆盖 capability profile 规范化、路由排序、fallback 可重试分类、serverApi 类型映射或前端展示 helper。
   - 必须运行 npm run typecheck、npm run test、npm run build。
   - 如果 Rust 侧无法完整 cargo check，请说明具体原因；但必须尽量保证 Rust 代码通过类型/所有权检查思路，不能留下明显不存在的模块或字段。

约束：
- 不要重写整个 AI runtime。
- 不要删除已有 endpoint、capability、usage、budget、pipeline、image/video 功能。
- 不要把 API key、token 或密钥打印到日志或 UI。
- 不要把智能路由做成纯前端假选择；后端必须参与真实请求路径。
- 不要引入外部队列、外部数据库或新服务。
- 保持现有代码风格，优先复用 ai client、capabilities、serverApi.endpoints、EndpointManagement、OpsMonitorPanel 的已有模式。

最终交付：
- 说明改了哪些文件。
- 说明新增/调整 API 形状。
- 说明路由排序、fallback 策略和不可重试错误判断。
- 说明运行了哪些验证命令及结果。
```

### A.3 后续 9 轮追加话术

第 2 轮：

```text
请继续自查你刚才的改动：确认智能路由不是只在前端选择 endpoint，而是后端 chat、stream chat、AI task 或生成入口真实调用了统一路由 helper。如果有遗漏请补齐。
```

第 3 轮：

```text
请检查 capability profile 的数据库兼容性：新库应能初始化，旧库升级不能因为缺少字段或表而启动失败。现有 ai_endpoint_capabilities 的记录不能丢失。
```

第 4 轮：

```text
请完善 fallback 分类：429、超时、5xx、网络错误可以重试；认证失败、参数非法、内容安全拒绝不应盲目 fallback。请补齐 helper 和测试。
```

第 5 轮：

```text
请确认用量与审计记录：fallback 后最终使用的 endpoint/model 必须写入 ai_usage_events 或路由事件中，前端能够查到一次请求的路由链路和失败原因。
```

第 6 轮：

```text
请完善 EndpointManagement/OpsMonitorPanel 的 UI：展示能力画像、健康状态、优先级、最近失败/fallback 次数，并能编辑核心 capability 字段。注意窄屏下不要布局溢出。
```

第 7 轮：

```text
请补充测试，优先覆盖 capability 规范化、路由候选排序、fallback 错误分类、API 类型映射和前端展示 helper。不要为了测试大幅重构无关代码。
```

第 8 轮：

```text
请运行 npm run typecheck 和 npm run test，并根据失败信息修复问题。请在回复中贴出关键结果。如果命令无法运行，请说明具体失败原因。
```

第 9 轮：

```text
请运行 npm run build，并修复构建失败。然后说明 Rust 后端的主要编译风险点，以及你如何检查这些风险。
```

第 10 轮：

```text
请最后收尾：列出最终改动文件、新增 API、端到端验收步骤、已知限制和验证命令结果。不要继续扩大功能范围，只修明显 bug 或遗漏。
```

### A.4 验收清单

```text
- 能为 endpoint 查看/维护 chat、stream_chat、image_generation、video_generation、long_context、tool_use 能力。
- 后端真实请求路径使用统一路由 helper。
- 明确的 fallback 最大次数和可重试/不可重试分类。
- 路由事件能查到首选 endpoint、fallback endpoint、失败原因、最终结果。
- ai_usage_events 仍记录最终 endpoint/model。
- 设置页或运维面板能展示健康/fallback 信息。
- npm run typecheck/test/build 有实际结果。
```

---

## 任务 B：导出包完整性校验、可复现实验包与交付审计

### B.1 建议提交信息

任务标题：

```text
Woohoo Studio 增加项目导出包完整性校验、可复现实验包与交付审计
```

任务背景：

```text
Woohoo Studio 已经能从短剧项目导出完整工程包和核心策划包，导出逻辑主要在 workspaceMvp 与 Workspace 中完成。真实创作团队交付给导演、制片或外部供应商时，光下载一个 tar/markdown 不够：需要知道导出包包含哪些资产、哪些资产缺失或下载失败、剧本/分镜/关键帧/视频计划对应的版本是什么、导出后是否可复现当时工作区状态，以及后续谁导出了什么、是否有敏感信息或损坏资产。

真实业务需求是：把导出从“浏览器里临时打包”升级为“可审计、可校验、可复现实验包”。导出包应带 manifest、资产校验和、缺失清单、项目快照、生成参数摘要和验证报告；前端导出前能预检，导出后能显示结果；后端记录导出审计，方便团队追踪交付历史。
```

建议上传依赖：

```text
上传整个仓库文件夹，排除 node_modules、dist、data、runtime-logs、.git。
如果平台上传全量很慢，至少上传：
- package.json
- tsconfig.json
- vite.config.ts
- server/Cargo.toml
- server/migrations/
- server/src/asset/
- server/src/project/
- server/src/workspace/
- server/src/main.rs
- src/features/studio/components/workspace/Workspace.tsx
- src/features/studio/components/workspace/workspaceMvp.ts
- src/features/studio/components/workspace/workspaceMvp.test.ts
- src/lib/serverApi.ts
- src/types/index.ts
- docs/current-system-architecture.md
```

### B.2 固定首轮 Prompt

```text
你现在在 Woohoo Studio 仓库中工作。请先阅读 README、package.json、docs/current-system-architecture.md，以及 workspaceMvp、Workspace、asset repo/handlers、project/workspace API、serverApi 和现有导出相关测试，再实现一个真实可用的“项目导出包完整性校验、可复现实验包与交付审计”功能。

项目背景：
- 前端：React 18 + TypeScript + Vite + Arco Design + Zustand。
- 后端：Rust Axum + SQLite + sqlx。
- 当前已有 exportFullProjectBundle、exportCoreProjectBundle、createProjectSnapshot、资产下载、项目/会话/脚本/分镜等数据结构。
- 现有导出主要在前端临时打包，缺少 manifest、校验、导出前预检、导出审计和导出历史。

业务目标：
1. 导出 manifest：
   - 完整工程包必须包含 manifest.json，记录 projectId、projectName、exportedAt、schemaVersion、counts、文件清单、资产清单、缺失资产、生成参数摘要。
   - 文件清单至少包含 path、kind、sizeBytes、sha256 或等价校验字段。
   - 资产清单要包含 assetId、name、type、url/source、是否成功打包、失败原因。
2. 导出前预检：
   - 新增前端 helper 或后端 API，对当前项目导出前做完整性检查。
   - 检查脚本、分镜、关键帧、视频计划、资产 URL、重复文件名、空内容、不可下载资产。
   - 预检结果分为 blocking/warning/info，前端在导出菜单或弹窗中展示。
3. 可复现实验包：
   - 导出包中增加 workspace_snapshot.json，保存项目、脚本、分镜、资产 metadata、pipeline 关键输出摘要。
   - 增加 README_EXPORT.md 或 validation_report.md，说明如何复核导出包内容、缺失项和校验和。
   - 不要把 API key、JWT、用户密码、完整密钥或本地绝对隐私路径写入包内。
4. 后端交付审计：
   - 新增导出审计记录，可以新增 export_audit_logs 表或复用 ops/action audit；请说明理由。
   - 记录 user_id、project_id、export_type、manifest_hash、asset_count、missing_asset_count、created_at。
   - 新增查询 API，例如 GET /api/projects/{projectId}/exports 或 /api/exports/audit，前端能查看最近导出历史。
5. 前端体验：
   - 导出完整工程包前显示预检结果；blocking 项应阻止导出或要求用户明确继续。
   - 导出成功 toast 要展示 manifest hash、打包资产数量、缺失资产数量。
   - 工作区或导出菜单能查看最近导出历史。
   - 保持现有“导出完整项目工程”和“导出核心策划包”能力不回退。
6. 测试与验证：
   - 补充 TypeScript 测试，优先覆盖 manifest 生成、sha256/文件清单、预检规则、敏感字段剔除、导出结果摘要。
   - 如能补 Rust 测试更好，尤其是审计 API 参数校验和权限。
   - 必须运行 npm run typecheck、npm run test、npm run build，并说明结果。

约束：
- 不要重写整个 workspace/export 模块。
- 不要引入外部压缩或校验服务；优先使用浏览器 Web Crypto 或项目现有能力。
- 不要把导出做成纯文档说明，必须改变真实导出包或导出流程。
- 不要泄露密钥、token、密码、本机绝对路径。
- 不要破坏现有资产预览、下载和导出按钮。
- 保持现有代码风格，优先复用 workspaceMvp、Workspace、serverApi、asset helpers 的已有模式。

最终交付：
- 说明改了哪些文件。
- 说明 manifest 和预检规则。
- 说明导出审计 API/数据结构。
- 说明运行了哪些验证命令及结果。
```

### B.3 后续 9 轮追加话术

第 2 轮：

```text
请继续自查你刚才的改动：确认完整工程包里真的包含 manifest.json 和 workspace_snapshot.json，而不是只在 UI 中展示说明。如果缺失请补齐。
```

第 3 轮：

```text
请检查导出前预检：脚本/分镜/资产 URL/重复文件名/空内容/不可下载资产至少要覆盖其中大部分，并区分 blocking、warning、info。
```

第 4 轮：

```text
请补齐敏感信息剔除：导出包和 manifest 不能包含 API key、JWT、密码、完整密钥、本机绝对隐私路径。请补充 helper 和测试。
```

第 5 轮：

```text
请完善导出审计：后端必须记录导出类型、项目、用户、manifest hash、资产数量、缺失数量和时间；前端可以查询最近导出历史。
```

第 6 轮：

```text
请确认现有导出能力没有回退：完整工程包和核心策划包仍可生成，成功 toast 能展示文件名、资产数量和缺失数量。
```

第 7 轮：

```text
请补充测试，优先覆盖 manifest 文件清单、hash 生成、预检规则、敏感字段剔除和导出摘要。不要为了测试大幅重构无关代码。
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
请最后收尾：列出最终改动文件、新增 API、导出包结构、手工验收步骤、已知限制和验证命令结果。不要继续扩大功能范围，只修明显 bug 或遗漏。
```

### B.4 验收清单

```text
- 完整工程包包含 manifest.json、workspace_snapshot.json、validation_report 或 README_EXPORT。
- manifest 文件清单包含 size/hash/kind/path。
- 资产清单能区分成功打包与缺失/失败。
- 导出前预检能发现空内容、缺失资产、重复文件名或不可下载资产。
- 导出包不会泄露 key/token/password/绝对隐私路径。
- 后端有导出审计记录和查询入口。
- 前端可查看预检结果和最近导出历史。
- npm run typecheck/test/build 有实际结果。
```

---

## 通用反馈模板

```text
我本地下载并运行了该模型产物，重点检查了后端 API、前端入口、真实功能链路、测试和构建结果。

优点：
- （根据实际产物填写）

问题：
- （根据实际产物填写，建议引用具体文件或截图）

验证结果：
- npm run typecheck：（通过/失败，失败原因）
- npm run test：（通过/失败，失败原因）
- npm run build：（通过/失败，失败原因）
- cargo check --manifest-path server/Cargo.toml：（通过/失败，失败原因；如未运行需说明）
- 手工验证：（功能链路是否符合预期）

综合判断：
- （说明为什么给这个分数）
```
