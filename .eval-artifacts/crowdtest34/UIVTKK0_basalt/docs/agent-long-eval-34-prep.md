# 方舟第 34 期 Agent 长程众测准备稿

仓库：`C:\Users\lxy\Desktop\work\woohoo`

Harness：`hermes`

评测类型：`34期方舟Agent长程评测`

本期任务不复用第 32 期的导出审计题，也不复用第 31 期的预算控制、跨项目素材治理或人工复核题。

## 任务 A：多 AI Endpoint 路由、故障降级与审计闭环

### 标题

```text
Woohoo Studio 多 AI Endpoint 智能路由、故障降级与审计闭环
```

### 任务背景

```text
Woohoo Studio 是一个本地优先的 AI 短剧创作工作台，前端使用 React 18、TypeScript、Vite、Arco Design 和 Zustand，后端使用 Rust Axum、SQLite 与 sqlx。团队会同时配置 OpenAI 兼容网关、OpenRouter、火山引擎和内部代理等多个 AI endpoint。当前仓库已经有 ai_endpoints、ai_endpoint_capabilities、chat、流式 chat、异步 AI task、图片生成、视频生成、pipeline、ai_usage_events 和运维面板，但 capability 主要服务图片/视频模型选择；chat、task 和 pipeline 的 endpoint 选择、失败处理和可观测性仍然分散。

真实问题是：某个 endpoint 超时、429、5xx 或能力不匹配时，创作流程会直接失败，运营人员也无法判断系统最终选用了哪个 endpoint、尝试过哪些候选、是否发生 fallback、失败原因和耗时是什么。需要补齐一套可维护的统一路由和可审计降级机制，让多 endpoint 场景可以安全运行并可追溯。
```

### 固定首轮 Prompt

```text
你正在 Woohoo Studio 仓库中工作。请先阅读 README、package.json、docs/current-system-architecture.md、docs/backend-ai-runtime.md、docs/architecture-governance-prd-tdd.md，并检查 server/src/ai、server/src/ops、server/src/pipeline、server/src/image_gen、server/src/video_gen、server/src/main.rs、server/src/db.rs、server/migrations、src/components/Settings/EndpointManagement.tsx、src/components/Settings/OpsMonitorPanel.tsx、src/lib/serverApi.endpoints.ts、src/lib/serverApi.ts、src/context/hooks/useAiMessageRuntime.ts、src/features/studio/components/chat/hooks/useMessageActions.ts 的现状。然后直接实现一个真实可用的“多 AI Endpoint 智能路由、故障降级与审计闭环”，不要停在方案或只做 UI。

背景：当前已有 ai_endpoints、ai_endpoint_capabilities、/api/ai/endpoints、同步/流式 chat、异步 AI task、图片生成、视频生成、pipeline、ai_usage_events 和 ops monitor。图片/视频已有部分 capability 解析，但 chat/task/pipeline 缺少统一路由、跨 endpoint fallback 和可审计事件。

必须完成以下内容：
1. 设计并实现可复用的后端路由 helper。输入至少包含用户、operation/capability、显式 endpointId、请求模型、上下文长度、是否 streaming、是否要求 tool use；候选排序必须综合显式 endpoint 约束、endpoint active 状态、capability enabled、capability priority、模型匹配、supports_stream、supports_tools、maxContextTokens 或等价配置和健康状态。保持 ai_endpoint_capabilities 旧数据兼容。
2. 至少让同步 chat、流式 chat、异步 AI task/pipeline，以及图片或视频生成中的两个以上真实入口使用该 helper；不要只增加未调用的模块。显式指定 endpoint 不可被静默换成不兼容 endpoint，除非请求属于允许 fallback 的语义并且返回中可追溯。
3. 实现受控 fallback：对网络错误、超时、408、429、5xx 和能力不匹配可尝试下一个候选；对 401/403、请求校验错误、内容安全拒绝等不可重试错误不得盲目 fallback。必须有最大尝试次数、候选去重和环路保护。
4. 新增版本化 SQL migration，持久化路由决策/尝试/失败/fallback 事件。每条记录至少可关联 request_id 或 task/run 标识、operation/capability、候选 endpoint/model、最终 endpoint/model、状态、错误分类、耗时和时间。新库初始化与旧库升级均不得失败。
5. 提供受认证的查询 API，支持按 endpoint、capability、状态和分页查看最近路由事件；保留 ai_usage_events 中实际 endpoint/model 的统计语义。
6. 在现有 Settings EndpointManagement 或 OpsMonitorPanel 中加入紧凑的能力与健康信息展示，并可查看最近 fallback/失败计数或事件；当用户可见请求发生 fallback 时，聊天或任务相关 UI 应有可理解且不泄露密钥的提示。
7. 补充单元/集成测试，至少覆盖候选排序、能力不匹配、429/5xx fallback、不可重试错误、最大尝试次数、审计写入/过滤、旧 capability 数据兼容。不要要求真实 API key、外部付费服务、本地 GPU 或常驻 dev server。
8. 完成后运行与本仓库匹配的验证命令（至少 npm run typecheck、npm run test、npm run build、cargo check --manifest-path server/Cargo.toml），修复你引入的问题。最后简洁说明修改文件、迁移策略、验证结果和仍需人工配置真实 endpoint 才能覆盖的边界。

约束：沿用现有 React/Rust/SQLite 模式，优先复用现有 API、类型、日志与 migration runner；不要输出模型身份猜测；不要修改无关功能；不要把密钥、token、密码或本机绝对路径写入持久化审计数据或导出物。
```

## 任务 B：AI Task 与 Pipeline SSE 断连恢复、乱序事件幂等和可见错误闭环

### 标题

```text
Woohoo Studio AI Task 与 Pipeline SSE 断连恢复、乱序事件幂等与可见错误闭环
```

### 任务背景

```text
Woohoo Studio 的创作流程包含异步 AI task、pipeline run 和协作会话。前端 usePendingTaskSse 通过 fetch 读取 /api/ai/tasks/stream，pipeline 和协作也有各自的 SSE 链路。当前已经有基础重连、超时标记和局部刷新，但弱网、代理截断、重连后旧事件重放、跨任务事件乱序、重复 terminal 事件、断连期间任务完成等场景还没有统一的恢复协议和回归矩阵，部分错误会变成模糊提示或 silent failure。

真实影响是：短剧创作项目执行长耗时图片、视频和 pipeline 步骤时，用户可能看到错误的 pending 状态、被旧事件覆盖的新结果、重复 toast、或不知道任务是在服务端完成、丢失还是需要重试。需要为异步任务与 pipeline 建立可恢复、幂等、可解释的事件消费闭环，降低弱网下的误操作与重复提交。
```

### 固定首轮 Prompt

```text
你正在 Woohoo Studio 仓库中工作。请先阅读 README、package.json、docs/current-system-architecture.md、docs/backend-ai-runtime.md、docs/architecture-governance-prd-tdd.md，并检查 src/context/hooks/usePendingTaskSse.ts、src/context/hooks/usePendingTaskRegistry.ts、src/context/hooks/useAiMessageRuntime.ts、src/lib/serverApi.ts、src/lib/serverApi.pipeline.ts、src/lib/serverApi.collaboration.ts、src/store、src/types、src/features/studio/components/chat、src/features/studio/components/workspace/PipelinePreview.tsx、server/src/ai、server/src/pipeline、server/src/collaboration、server/src/main.rs、server/src/db.rs、server/migrations 的现状。然后直接实现一个真实可用的“AI Task 与 Pipeline SSE 断连恢复、乱序事件幂等与可见错误闭环”，不要只写文档或只增加轮询。

背景：当前前端 usePendingTaskSse 使用 fetch 读取 /api/ai/tasks/stream，pipeline 和协作分别有 SSE 入口。已有基础重连、超时标记、workspace refresh 和一些流式兼容处理，但尚未形成稳定的事件游标、重放、去重、乱序保护、断连恢复和统一错误语义。

必须完成以下内容：
1. 为至少 AI task 和 pipeline run 事件定义稳定的事件标识/顺序语义；后端 SSE 输出应带可恢复 cursor 或事件 id，并支持在合理上限内按 Last-Event-ID 或 query cursor 重放。若游标过期或事件过多，必须返回明确的 resync 信号而不是静默丢失。
2. 前端统一或提炼可复用的 SSE 消费逻辑，正确处理任意 chunk 切分、event/data/id/retry 多行帧、[DONE]/done 终止、连接中断、401 刷新后重连、指数退避且有上限。不能对无 pending 任务无限重连。
3. 实现任务级幂等与乱序保护：同一事件重放不得重复写消息、重复显示 toast、重复刷新 workspace；旧 queued/running 事件不得覆盖新的 completed/failed/cancelled/blocked 终态；终态重复事件必须安全。保留必要的状态版本、updatedAt、事件序号或状态序关系，不依赖仅靠本机时间猜测。
4. 断连期间若任务在服务端完成，恢复连接后应通过重放或一次受控 resync 修正 UI。不得把正常断连立即标为 missing；只有超过明确阈值且 resync 失败时才显示 missing，并给出可操作错误提示。统一 completed/cancelled/blocked/failed/scope_mismatch/missing 等边界状态的用户可见文案和 metadata。
5. pipeline 预览/任务状态与聊天 placeholder 都要消费相同或等价的状态语义；处理 API 返回与 SSE 推送竞态，避免重复推进、错误回退或遗漏 refresh。
6. 新增必要的 migration/持久化字段或事件查询接口，确保新库初始化和旧库升级兼容。若使用内存 buffer，必须说明进程重启后的降级为数据库 resync 的路径。
7. 编写可在本地执行的回归测试矩阵，至少覆盖：分片多行 SSE、重复事件、乱序事件、终态保护、断连重连、游标重放、游标过期 resync、401 重连、任务范围不匹配、任务完成后的刷新去重。使用 mock/fake stream，不依赖外部 endpoint、GPU 或常驻服务。
8. 完成后运行与本仓库匹配的验证命令（至少 npm run typecheck、npm run test、npm run build、cargo check --manifest-path server/Cargo.toml），修复你引入的问题。最后简洁说明事件协议、兼容与回退策略、测试结果和风险边界。

约束：沿用现有 React/Rust/SQLite 与 request_id/run_id/taskId 追踪模式；不要修改无关业务；不要通过高频轮询替代事件恢复；不要泄露密钥、token、密码或本机绝对路径；不要输出模型身份猜测。
```

