# Woohoo 架构治理改造文档（PRD + TDD）

版本：v1.2  
日期：2026-04-12  
适用阶段：M1（不破坏现有功能前提下完成架构收敛）

## 0. 更新说明（基于未完成项）

本次版本用于收敛“已落地能力 + 未完成改造”，作为后续开发唯一执行基线。

### 0.1 当前完成度基线（2026-04-12）

1. 已完成：Beta 开关、依赖门控、Review 重试主链路、`request_id/run_id/step_id` 基础追踪、流式默认优先策略。
2. 已完成：流程关键编排单测通过（`pipeline::orchestrator::tests`）。
3. 已完成：`src/store/index.ts` 已移除占位 action + runtime 注入链路；store 仅保留直接状态 action，复杂业务动作改由 `AppProvider` actions context 提供。
4. 已完成（前端）：前端上下文拆分已落地 `AppProvider` actions context、`storageHelpers`、`appContextHelpers`、`useChatWorkspaceActions`、`useAiMessageRuntime`，`src/context/AppContext.tsx` 当前已保持在复杂度目标内（< 1000 行）。
5. 已完成：后端 AI handler 已抽离目录与任务接口模块（`server/src/ai/catalog_handlers.rs`、`server/src/ai/task_handlers.rs`），并继续拆分为 `server/src/ai/handlers/chat_core.rs`、`server/src/ai/handlers/shared.rs` 与 `server/src/ai/handlers/assistant_actions/*`；同时已完成 `server/src/pipeline/orchestrator.rs` 拆分（`server/src/pipeline/orchestrator.rs` + `server/src/pipeline/orchestrator/helpers.rs`）。当前后端关键文件均已满足单文件阈值（< 1500 行）。
6. 已完成：`manual_review_required` 前端闭环已落地，当前可查看待处理步骤、填写责任人/人工结论、单步/批量重试并查看人工复核事件留痕。
7. 已完成（前端工程治理）：统一 logger、全局错误边界、`ESLint/Prettier`、严格模式校验与目录收敛已完成，当前前端 `lint/typecheck/build` 全部通过。
8. 部分完成：数据库初始化已切换为带 `schema_migrations` 记录的版本化 migration runner，历史 schema 兼容补齐改为单次升级步骤；本轮已进一步将 `ai_tasks` 持久化表迁回 SQL migration，并在启动时输出 schema/backfill 报告，但 `server/src/db.rs` 仍保留 legacy backfill/`ensure_*`，尚未完成 migration 主导化收口。
9. 部分完成：流程控制 API、流式兼容与降级主链路已具备；本轮已补齐 pause/resume/cancel 的幂等状态迁移与并发回归测试，SSE 兼容回归矩阵与发布级回退演练仍未完成。

### 0.2 FR 完成度矩阵

| FR | 内容 | 状态 | 备注 |
|---|---|---|---|
| FR-01 | 多智能体 Beta 开关 | 已完成 | 设置页可控 |
| FR-02 | 前置依赖门控 | 已完成 | `depends_on` + orchestrator 判定 |
| FR-03 | 设计后自动进入审核 | 已完成 | 设计/审核步骤联动 |
| FR-04 | 审核失败自动重试 | 已完成 | 支持退避与重试 |
| FR-05 | 超阈值进入人工复核 | 已完成 | 后端状态、前端人工复核工作台、留痕与重试链路已打通 |
| FR-06 | 助理智能体流程摘要 | 部分完成 | 已覆盖设计/审核/重试/完成等主要阶段，尚未确认全部步骤模板 |
| FR-07 | 设计/审核 Prompt 优化模板 | 部分完成 | 已有优化建议生成与展示链路，自动应用与回滚策略待完善 |
| FR-08 | 全链路追踪能力 | 已完成 | `x-request-id` 已前后端贯通 |
| FR-09 | 暂停/恢复/取消幂等 | 已完成 | 控制接口已改为幂等状态迁移，并覆盖重复点击与并发请求回归测试 |
| FR-10 | 旧流程可回退 | 部分完成 | 通过开关回退可用，发布级回退 SOP 仍需演练 |
| FR-11 | 前后端状态口径统一 | 部分完成 | pipeline UI 已联合 `status + error_code` 渲染，其他模块仍需继续统一 |
| FR-12 | 后端不可达/端点缺失/SSE 中断时明确降级 | 部分完成 | bootstrap/task 模式与流尾保留已增强，非项目直连路径与统一提示仍需收口 |
| FR-13 | 流式协议兼容统一解析 | 部分完成 | 前后端主链路已兼容 `[DONE]`/`finish_reason`/`finishreason`，后端仍缺完整回归矩阵与发布级演练 |

### 0.3 NFR 完成度矩阵

| NFR | 内容 | 状态 | 备注 |
|---|---|---|---|
| NFR-01 | 核心流程回归 100% | 部分完成 | 已有关键链路通过，尚缺完整回归矩阵 |
| NFR-02 | 无 silent failure | 部分完成 | 主链路已补齐流尾保留、错误透传与全局兜底，边缘错误语义仍需统一 |
| NFR-03 | 单文件复杂度达标 | 已完成 | 前端 `AppContext.tsx` 已进一步拆成 provider + hooks/context，后端关键模块均已达标（< 1500 行） |
| NFR-04 | 生命周期可观测性 | 部分完成 | 基础事件具备，告警指标与看板待补 |
| NFR-05 | 10 分钟内定位故障 | 部分完成 | `request_id` 已接入，SOP 与检索模板待固化 |

## 1. 背景

当前项目已具备完整业务能力，但架构层面存在以下风险：

1. 前端核心上下文文件过大，状态、持久化、服务端编排强耦合。
2. 后端 AI 模块单文件职责过重，HTTP 处理、业务逻辑、SQL 访问边界不清晰。
3. 状态管理存在运行时注入模式，初始化时序风险高。
4. 路由与数据库演进存在双轨机制，后续维护复杂度持续上升。
5. 多智能体流程已进入 Beta 方向，需要更可控的失败恢复与回退机制。

## 2. 产品目标（PRD）

### 2.1 目标

1. 在不影响现有功能可用性的前提下，完成前后端架构解耦。
2. 建立多智能体流程的“前置门控、自动重试、审核回路、失败回退”闭环。
3. 建立清晰、可追踪、可回滚的工程治理机制。
4. 通过设置页 Beta 开关控制新流程启停。

### 2.2 非目标

1. 本期不重做 UI 风格与交互体系。
2. 本期不替换数据库类型。
3. 本期不一次性重写所有历史模块，采用渐进改造。

### 2.3 用户价值

1. 任务发出后可自动推进，不依赖人工持续盯守。
2. 前置条件未满足时不会误触发后续步骤。
3. 审核失败有自动重试与明确告警，不再“静默失败”。
4. 流程状态更透明，可定位、可解释、可追踪。

## 3. 功能需求（FR）

1. FR-01：支持多智能体 Beta 开关（设置页启用/关闭）。
2. FR-02：流程引擎支持前置依赖门控（未完成前置则阻塞）。
3. FR-03：设计智能体执行后自动进入审核智能体。
4. FR-04：审核失败可自动触发重试流程，并保留失败原因。
5. FR-05：重试超阈值后进入人工复核状态。
6. FR-06：每一步完成后由助理智能体识别当前流程状态并产出对话摘要。
7. FR-07：支持设计 Prompt 与审核 Prompt 的可配置优化模板。
8. FR-08：全流程具备统一错误码、请求 ID、run_id/step_id 跟踪能力。
9. FR-09：流程可暂停/恢复/取消，并具备幂等保护。
10. FR-10：旧流程可保留并可一键回退。
11. FR-11：前后端状态口径统一（逻辑态、存储态、展示态三层映射一致）。
12. FR-12：后端不可达/端点缺失/SSE 中断时有明确降级路径与用户提示。
13. FR-13：流式协议兼容（`finish_reason/finishreason`、`[DONE]`、event/data 双形态）必须统一解析。

## 4. 非功能需求（NFR）

1. NFR-01：核心流程回归通过率 100%。
2. NFR-02：关键接口失败具备明确可读错误，不允许 silent failure。
3. NFR-03：单文件复杂度控制：前端核心文件 < 1000 行，后端 handler 文件 < 1500 行。
4. NFR-04：可观测性覆盖 run 生命周期（创建、阻塞、执行、重试、审核、完成）。
5. NFR-05：故障发生后 10 分钟内可通过日志定位模块与请求链路。

## 5. 技术方案（TDD）

### 5.1 前端架构重构

1. 状态管理
   1. 将 `store` 从“占位 action + runtime 注入”改为“真实 action + 直接调用”。
   2. 消除未绑定 action 的时序不确定性。
2. 上下文拆分
   1. `AppContext` 仅保留 provider 组装。
   2. 业务拆分为 `bootstrap`、`persistence`、`aiRuntime` 模块。
3. API 分层
   1. `serverApi.ts` 仅保留传输层（baseUrl、鉴权、重试、错误标准化）。
   2. 业务域 API 固定在 `serverApi.agents.ts / endpoints.ts / pipeline.ts`。
4. Beta 开关
   1. 设置页新增 `multiAgentBetaEnabled`，持久化并下发服务端。
   2. 关闭 Beta 时强制走稳定旧流程。

### 5.2 后端架构重构

1. 路由聚合
   1. `main.rs` 仅做路由挂载，不承载域逻辑。
   2. 按域拆分 mount：`auth/project/conversation/ai/pipeline/ops`。
2. AI 模块拆分
   1. 从单文件拆为：`endpoints_handlers`、`agents_handlers`、`chat_handlers`、`tasks_handlers`、`usage_handlers`。
   2. SQL 下沉到 repo 层，handler 仅做 request/response 映射。
3. 编排器增强
   1. 支持 step 级重试策略（指数退避、最大重试次数、重试间隔上限）。
   2. 支持状态 `waiting_prerequisite`、`retry_scheduled`、`manual_review_required`。
4. 数据演进
   1. migration 为主，运行时 `ensure_*` 仅保留兼容路径。
   2. 新增流程相关字段统一走 migration，避免“代码即迁移”扩散。

## 6. 多智能体流程状态机

状态定义：

1. `queued`
2. `waiting_prerequisite`
3. `planning`
4. `designing`
5. `reviewing`
6. `retry_scheduled`
7. `manual_review_required`
8. `completed`
9. `failed`
10. `canceled`

转移规则：

1. `queued -> waiting_prerequisite`：存在未完成前置步骤。
2. `waiting_prerequisite -> planning`：前置全部完成。
3. `planning -> designing`：计划审核通过或无需计划审核。
4. `designing -> reviewing`：设计输出提交审核。
5. `reviewing -> completed`：审核通过。
6. `reviewing -> retry_scheduled`：审核不通过且可重试。
7. `retry_scheduled -> designing`：达到重试触发时间。
8. `reviewing -> manual_review_required`：超过重试上限或高风险错误。
9. 任意执行态 -> `failed`：不可恢复错误。
10. 任意执行态 -> `canceled`：用户主动取消。

### 6.1 状态口径统一（必须）

为避免“文档状态”和“代码状态”错位，统一采用三层语义：

1. 逻辑态（用于产品理解）
   1. `waiting_prerequisite`
   2. `retry_scheduled`
   3. `manual_review_required`
2. 存储态（DB `pipeline_runs.status`）
   1. `queued | running | paused | completed | failed | cancelled`
3. 诊断态（DB `pipeline_runs.error_code`）
   1. `WAITING_PREREQUISITE`
   2. `RETRY_SCHEDULED`
   3. `MANUAL_REVIEW_REQUIRED`
   4. `MISSING_ENDPOINT`
   5. `DEPENDENCY_UNSATISFIED`
   6. `EXECUTION_FAILED`

映射规则：

1. “等待前置”显示态 = `status=running` 且 `error_code=WAITING_PREREQUISITE|DEPENDENCY_UNSATISFIED`。
2. “自动重试等待”显示态 = `status=running` 且 `error_code=RETRY_SCHEDULED`。
3. “人工复核”显示态 = `status=failed` 且 `error_code=MANUAL_REVIEW_REQUIRED`。
4. UI 不得仅依据 `status` 渲染流程提示，必须联合 `error_code`。

## 7. 错误处理、重试与回退

### 7.1 错误分级

1. `CONFIG_ERROR`：端点或密钥缺失。
2. `NETWORK_ERROR`：连接失败、超时、中断。
3. `PROVIDER_ERROR`：上游模型服务错误。
4. `VALIDATION_ERROR`：输入不合法。
5. `INTERNAL_ERROR`：系统内部异常。

### 7.2 重试策略

1. 可重试范围：`NETWORK_ERROR`、部分 `PROVIDER_ERROR`。
2. 不可重试范围：`VALIDATION_ERROR`、明确配置缺失。
3. 策略：指数退避（2^n）+ 抖动 + 最大次数上限。
4. 审核失败重试必须附带“失败原因摘要 + 改进指令”。

### 7.3 回退策略

1. Beta 开关关闭：立即切回旧流程。
2. 发布回退：保留旧路由/旧处理器一个发布周期。
3. 数据回退：新增字段只增不删，兼容旧读路径。

### 7.4 降级策略（网络与流式）

1. 后端不可达（`ERR_CONNECTION_REFUSED/ERR_ABORTED`）：
   1. 前端进入“受限模式”，阻止新流程创建，保留本地输入与重试入口。
   2. 所有错误提示必须带 `request_id`（若无服务端响应则带客户端 request_id）。
2. 端点缺失（`MISSING_ENDPOINT`）：
   1. run 进入可恢复阻塞，不直接标记不可恢复失败。
   2. 设置页完成端点配置后，支持继续推进而非重建 run。
3. SSE 中断：
   1. 首选流式，失败时回退任务模式（task mode）；
   2. 已输出内容保留，不允许被空响应覆盖。
4. Bootstrap 失败：
   1. 不清空本地已加载可读数据；
   2. 展示“重试连接”与“查看诊断 request_id”。

### 7.5 幂等与去重契约

1. `createPipelineRun` 必须要求 `idempotency_key`，相同 key 在 `queued/running/paused` 内返回同一 run。
2. pause/resume/cancel/retry-step 必须具备重复提交幂等保障（重复点击不产生多次状态跃迁）。
3. 任务回调按 `task_id + step_id` 去重，防止重复完成写入。
4. 前端对同一步骤操作按钮需有“请求中”互斥态，避免并发触发。

### 7.6 流式协议解析契约

1. 兼容以下结束信号：
   1. `event: done` + `data: [DONE]`
   2. `data: [DONE]`
   3. chunk 中 `finish_reason=stop` 或 `finishreason=stop`
2. 兼容以下内容载荷：
   1. `choices[].delta.content`
   2. `choices[].message.content`
3. 若仅收到结束信号且无正文，按错误处理并带 request_id。
4. SSE 解析器需容忍 `event/data` 跨 chunk 分片与空行分隔。

## 8. Prompt 协同设计（设计/审核）

### 8.1 设计 Prompt 基线

1. 输入：任务目标、约束、前置结果、可用资产。
2. 输出：结构化方案（目标、步骤、产物、风险、自检）。
3. 强制项：禁止跳过前置、禁止输出未验证结论。

### 8.2 审核 Prompt 基线

1. 输入：设计稿、验收标准、失败历史。
2. 输出：通过/拒绝、问题列表、修复建议、重试指令。
3. 强制项：拒绝必须给出可执行修改点，不允许模糊否决。

### 8.3 助理智能体职责

1. 识别当前状态与下一状态。
2. 汇总本步结果并广播给相关智能体。
3. 在失败时生成重试上下文包（最小必要信息）。

## 9. 里程碑与交付

### 9.1 已完成（截至 v1.1）

1. M1-A：多智能体 Beta 开关、流程主链路（设计->审核->重试）打通。
2. M1-B：请求链路追踪（`x-request-id`）前后端贯通。
3. M1-C：Prompt 优化建议链路与结果展示基础能力落地。

### 9.2 未完成里程碑（本次更新）

1. M1.5-架构收口（进行中）
   1. 已完成：前端去 runtime 注入，store 真 action 化已落地。
   2. 进行中：数据层 `migration` 主导化继续推进，pipeline 编排器重复 runtime 建表逻辑已下沉，剩余 `ensure_*` 仍需逐步替代。
2. M1.6-稳定性收口（进行中）
   1. 部分完成：暂停/恢复/取消已具备幂等状态迁移和并发回归测试，乱序/故障注入压测待补。
   2. 已完成：人工复核流程（`manual_review_required`）前端运营闭环。
   3. 未完成：流程错误分级与提示语义统一，消除边缘 silent failure。
3. M2-Beta 完整化（未完成）
   1. Prompt 优化自动应用策略（可配置）与一键回滚。
   2. 助理摘要覆盖全部流程阶段。
   3. 可观测性看板与报警阈值固化。

### 9.3 里程碑出口条件（补充）

1. M1.5 退出条件：
   1. store 不再 runtime 注入；
   2. `migration` 主导化完成当期范围，`ensure_*` 下线计划进入执行；
   3. 全链路回归通过且无 P0/P1。
2. M1.6 退出条件：
   1. manual review 前端闭环上线；
   2. 幂等压测与故障注入达标；
   3. 网络降级与恢复路径验收通过。
3. M2 退出条件：
   1. Prompt 优化自动应用可控并可回滚；
   2. 观测看板与告警阈值生效；
   3. 灰度指标达到上线门槛。

## 10. 验收标准（DoD）

### 10.1 本轮收口 DoD（当前达成情况）

1. 已完成：`src/store/index.ts` 不再依赖占位 action + runtime 注入，初始化期间调用 action 不会静默失效。
2. 已完成：`manual_review_required` 在前端可见、可操作、可重试、可留痕。
3. 已完成：pause/resume/cancel 在重复点击与并发请求下满足幂等，不出现重复推进或错态。
4. 部分完成：错误提示与链路追踪已接入 `request_id`，但日志检索 SOP 与边缘提示语义仍需统一。
5. 部分完成：`server/src/db.rs` 的 pipeline 重复 runtime 建表逻辑已继续迁回 migration/backfill，`ai_tasks` 已迁回 SQL migration，且启动时可输出 schema/backfill 报告；本地跨版本回滚演练已完成，真实 staging 实机演练与剩余 `ensure_*` 下线仍待完成。
6. 部分完成：前端 `npm run lint`、`npm run typecheck`、`npm run build` 已通过；后端关键编排测试主链路已通过，但 migration 收口相关验收尚未结束。

## 11. 风险清单

1. 结构拆分导致行为漂移。
2. 老数据兼容引发边界故障。
3. SSE/流式链路在弱网下不稳定。

缓解措施：

1. 分阶段发布与灰度开关。
2. 每阶段保留回退入口。
3. 增加链路级超时、取消、重试、幂等校验。

## 12. 开发执行清单（文件级）

前端：

1. `src/context/AppContext.tsx`（已完成：拆分到 hooks，主文件已 < 1000 行）
2. `src/store/index.ts`（已完成：runtime 注入链路已移除，store action 改为直接状态 action）
3. `src/lib/serverApi.ts`（已完成：request_id/错误链路增强）
4. `src/lib/serverApi.agents.ts`（已完成：域 API 分层）
5. `src/lib/serverApi.endpoints.ts`（已完成：域 API 分层）
6. `src/components/Settings/SettingsModal.tsx`（已完成：Beta 开关与高级参数治理）
7. `src/features/studio/components/workspace/PipelineSteps/OutlineView.tsx`（已完成：manual review 工作台、人工留痕与重试闭环）
8. `src/types/index.ts`（已完成：配置与状态字段扩展）

后端：

1. `server/src/main.rs`（已完成：按域挂载 + request_id middleware）
2. `server/src/ai/handlers.rs`（已完成主入口瘦身：当前约 1303 行）
3. `server/src/ai/catalog_handlers.rs`（已完成：目录/智能体接口抽离）
4. `server/src/ai/task_handlers.rs`（已完成：任务与用量接口抽离）
5. `server/src/ai/handlers/chat_core.rs`（已完成：聊天上下文与提示编排抽离）
6. `server/src/ai/handlers/shared.rs`（已完成：跨模块共享辅助函数抽离）
7. `server/src/ai/handlers/assistant_actions.rs`（已完成：动作模块入口收敛）
8. `server/src/ai/handlers/assistant_actions/execution.rs`（已完成：执行链路抽离，当前约 1470 行）
9. `server/src/ai/handlers/assistant_actions/validation.rs`（已完成：动作校验与策略抽离）
10. `server/src/ai/handlers/assistant_actions/workflow.rs`（已完成：确认卡片与状态回写抽离）
11. `server/src/pipeline/orchestrator.rs`（已完成：状态机与重试主链路）
12. `server/src/pipeline/orchestrator/helpers.rs`（已完成：编排辅助函数与测试拆分）
13. `server/src/db.rs`（未完成：migration 主导化仍需收口）
14. `server/migrations/*`（部分完成：新增迁移已落地，需继续替代 ensure_* 运行时补齐）

---

该文档用于立项评审、开发执行与发布验收，后续变更请维护版本号与变更记录。

## 13. 角色与职责（RACI）

1. 架构负责人（A）：确认边界、评审拆分方案、审批发布。
2. 前端负责人（R）：完成状态层改造、Beta 开关、错误语义统一。
3. 后端负责人（R）：完成 handler/service/repo 拆分、状态机与重试落地。
4. QA 负责人（R）：维护回归矩阵、验证失败注入场景、发布验收签字。
5. 运维/平台（C）：日志、告警、灰度、回滚通道保障。
6. 产品/项目（C）：范围控制、验收标准确认、风险仲裁。
7. 安全合规（I）：密钥与审计链路抽检。

## 14. 测试计划（必须通过）

### 14.1 单元测试

1. 前置门控判定函数（依赖未完成时阻塞）。
2. 重试策略计算（退避、抖动、最大次数）。
3. 错误码归类与前端映射逻辑。
4. Beta 开关路由分流逻辑。

### 14.2 集成测试

1. `queued -> waiting_prerequisite -> planning` 正常推进。
2. `reviewing -> retry_scheduled -> designing` 重试闭环。
3. 重试超阈值转 `manual_review_required`。
4. 取消/暂停/恢复在并发下的幂等行为。

### 14.3 E2E 回归

1. 聊天主链路：发送、流式、停止、错误提示。
2. 端点管理：测试连通、保存、刷新后可用。
3. 流程运行：创建 run、查看 step、重试、完成。
4. 设置页：Beta 开关开启/关闭后行为一致且可回切。

### 14.4 故障注入

1. 模拟上游超时与 5xx，验证自动重试。
2. 模拟网络断连，验证回退与恢复。
3. 模拟配置缺失，验证阻塞与引导提示。

### 14.5 协议兼容与渲染一致性测试（新增）

1. SSE 兼容样例：
   1. 同时覆盖 `finish_reason` 与 `finishreason`。
   2. 同时覆盖 `event: done` 与 `data: [DONE]`。
   3. 覆盖 chunk 分片与跨行拼接。
2. 流式回退样例：
   1. 流式首包失败回退 task；
   2. 中途失败保留已输出内容。
3. Markdown 渲染样例：
   1. 标题/列表黏连文本（`##...###1...-...`）应被正确拆分渲染。
   2. 代码块未闭合流式场景不应导致整段渲染崩坏。

## 15. 发布与回滚 SOP

1. 预发布检查
   1. 所有回归测试通过。
   2. 数据迁移脚本在 staging 验证通过。
   3. Beta 开关默认关闭。
2. 灰度发布
   1. 内部环境开启 Beta，观察 24 小时。
   2. 小流量用户开启 Beta，观察告警与失败率。
3. 回滚触发条件
   1. 出现 P0/P1 缺陷。
   2. 流程完成率明显下降或重试风暴。
4. 回滚动作
   1. 关闭 Beta 开关并切回旧流程。
   2. 服务端路由回切至旧处理器入口。
   3. 保留故障 run 数据用于复盘，不做破坏性清理。
   4. staging 数据库回滚演练按 [staging-db-rollback-drill.md](./staging-db-rollback-drill.md) 执行。

## 16. 依赖与前置条件

1. 服务端可用并通过 `/api/workspace/bootstrap` 健康检查。
2. 至少存在一个可用 AI 端点配置。
3. 数据库 migration 与当前代码版本一致。
4. SSE 链路在目标环境稳定（代理、网关不截断）。
5. 日志系统可按 `request_id/run_id/step_id` 检索。

### 16.1 数据迁移与补数策略（新增）

1. 新增字段统一由 migration 管理，`ensure_*` 仅保留历史兼容并设下线时间。
2. 老 run 数据需要补齐最小可用字段（`step_type/depends_on_json/review_policy_json/run_version`）。
3. 每次结构迁移需附带 backfill 脚本与回滚说明。
4. 迁移执行后必须产出“补数结果报告”（成功数/失败数/人工介入数）。

## 17. 可观测性指标（上线门槛）

1. 流程成功率（run success rate）。
2. 步骤重试率与平均重试次数。
3. 审核拒绝率与人工介入率。
4. 平均完成时长（P50/P95）。
5. Beta 用户错误率与回退触发次数。

上线门槛建议：

1. 关键流程成功率不低于旧流程基线。
2. P95 完成时长劣化不超过 15%。
3. 人工介入率在可接受阈值内并可解释。

## 18. 变更记录模板

1. 版本号：
2. 变更日期：
3. 变更人：
4. 变更摘要：
5. 影响范围（前端/后端/数据/运维）：
6. 是否需要迁移：
7. 是否需要回归测试：
8. 回滚方案链接：

## 19. 待决策项状态

1. 本文档上一版中的待决策项，已由第 20 节“默认决策值”提供默认值并临时闭合。
2. 若业务方需要调整默认值，需走变更评审并更新本 PRD 版本号与变更记录。
3. 当前仍需落地执行的事项已全部迁移至第 21 节任务清单，不在本节重复。

## 20. 默认决策值（即刻生效，除非另行审批）

1. Prompt 优化自动应用策略（Beta）：
   1. 连续 3 次审核通过，且平均评分提升 >= 0.08，才允许自动附加 patch。
   2. 若后续 5 次内失败率 > 30% 或出现 `manual_review_required`，自动回滚到基线 prompt。
   3. 自动应用范围仅限“当前项目”，不跨项目扩散。
2. 人工复核 SLA：
   1. `manual_review_required` 首次响应时限：30 分钟内。
   2. 处理完成目标：4 小时内（工作时段）。
   3. 超时自动升级到值班负责人并发送告警。
3. 幂等键作用域：
   1. 以“用户级”生效（与当前实现保持一致）。
   2. 前端生成建议：`projectId + conversationId + pipelineType + triggerSource + hash(payload)`。
4. 重试预算默认值：
   1. `design`：`maxRetries = 2`
   2. `review`：`maxRetries = 1`
   3. `system`：`maxRetries = 1`
5. ensure 下线时间窗：
   1. `v1.2`：禁止新增 `ensure_*`（仅允许 migration）。
   2. `v1.3`：下线 pipeline 相关 `ensure_*`。
   3. `v1.4`：完成其余 `ensure_*` 收口，保留极少数启动期只读校验。

## 21. 执行任务清单（按优先级）

### 21.1 P0（必须先完成）

1. 前端状态层去 runtime 注入（已完成）
   1. 目标文件：`src/store/index.ts`、`src/context/AppContext.tsx`
   2. 验收：删除占位 action；初始化期间调用 action 不再静默失效。
2. manual review 前端闭环（已完成）
   1. 目标：可查看、可指派、可重试、可留痕
   2. 验收：`MANUAL_REVIEW_REQUIRED` 路径全链路可操作。
3. migration 主导化收口（进行中）
   1. 目标文件：`server/src/db.rs`、`server/migrations/*`
   2. 验收：关键 `ensure_*` 迁移为 migration/backfill，保留最小兼容并有下线计划；本轮已移除 pipeline 编排器重复 runtime 建表逻辑。

### 21.2 P1（稳定性收口）

1. pause/resume/cancel 幂等压测（进行中）
   1. 已覆盖重复点击与并发重复请求；乱序请求、网络抖动场景待补。
   2. 验收：无重复推进、无错态回退。
2. SSE 兼容性回归（进行中）
   1. 覆盖 `finish_reason/finishreason`、`event: done`、`data: [DONE]`。
   2. 验收：流式解析稳定、异常可降级 task mode。
3. migration/backfill 治理（进行中）
   1. 已将 pipeline schema 兼容补齐拆到版本化 backfill，并继续缩减 runtime `ensure_*`；本轮已新增 `008_ai_tasks_persistence` SQL migration，并将 `notification_events / runtime_heartbeats / scripts / storyboards` 的 conflict-target 兼容修复下沉到 `009_ops_schema_conflict_backfills`，同时将 `agents / project_agent_assignments` 的 user-scope 兼容迁移拆到 `010_agent_scope_backfills`；启动时输出 schema/backfill 报告；本地跨版本回滚演练已通过。
   2. 现状：已通过本地跨版本 drill（`386e8bd -> 2fea1cc -> 386e8bd`），报告见 `data/rollback-drills/cross-version-2026-04-13T15-51-50-764Z/cross-version-report.json`；真实 staging 实机演练待执行。
   3. 验收：输出补数报告，staging 回滚验证通过。

### 21.3 P2（Beta 完整化）

1. Prompt 优化自动应用与回滚策略上线（未完成）。
2. 助理摘要覆盖全部流程阶段（进行中）。
3. 可观测性看板与报警阈值固化（未完成）。
