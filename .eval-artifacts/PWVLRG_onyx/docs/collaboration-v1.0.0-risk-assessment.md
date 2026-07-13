# Woohoo 协同创作系统 v1.0.0 -- 风险评估报告

版本：v1.0.0
日期：2026-05-12
审计对象：`collaboration-ultimate-goal-prd.md` / `collaboration-v1.0.0-dev-prd.md` / `collaboration-session-implementation-prd.md`
审计基线：当前代码库 `server/src/collaboration/` 及 `src/context/hooks/usePendingTaskSse.ts` 实际状态

---

## 一、致命风险（会导致项目无法交付）

### R-01：SSE 广播改造破坏现有 AI 任务事件流

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 开发 PRD 缺口 1 要求在 `AiTaskEvent` 结构体上新增 `collaboration_payload` 字段，并通过 `stream_tasks` SSE 端点透传。当前 `AiTaskEvent` 结构体（见 `server/src/ai/config.rs:351`）仅有 `event_type`、`task`、`content_delta` 三个字段。改造方案是在该结构体中塞入协同事件的 payload，再由前端 `handleSSEEvent` 按 `eventType` 分发。但 `stream_tasks` 的 SSE 连接（见 `server/src/ai/task_handlers.rs:125`）当前仅在 `pendingTaskCount > 0` 时建立（见 `usePendingTaskSse.ts:88`），协同会话激活时如果无 pending AI 任务，SSE 连接根本不存在，协同事件无法送达前端。 |
| **触发条件** | 协同会话已创建，但当前无 AI 任务排队/运行（`pendingTaskCount === 0`），此时 SSE 连接被主动断开，所有协同事件静默丢失。 |
| **影响范围** | 前端完全收不到任何协同 SSE 事件，整个实时协同展示层失效。缺口 1 的全部验收标准无法通过。 |
| **缓解方案** | 1. 修改 SSE 连接生命周期逻辑：当存在活跃协同会话时（`activeCollaborationSession !== null`），即使 `pendingTaskCount === 0` 也保持 SSE 连接。2. 在 `usePendingTaskSse` 的连接条件中增加 `activeCollaborationSession` 判断。3. 后端 `broadcast_collaboration_event` 方法中增加连接状态日志，确保事件发出后可追溯。 |
| **是否阻断当前开发** | **是** -- 这是 Phase A 的第一个任务（A1），所有 Phase B 任务均依赖 SSE 链路打通。如果 SSE 连接生命周期不修正，后续所有前端集成都无法验证。 |

### R-02：admit 不创建 pipeline_run 导致端到端链路断裂

| 维度 | 内容 |
|---|---|
| **风险描述** | 当前 `handlers::admit()`（见 `server/src/collaboration/handlers.rs:249`）在判定通过后，`pipeline_run_id` 始终返回 `None`（第 337 行），仅将 session 状态更新为 `workspace_admission`，未推进到 `workspace_execution`。v1.0.0 PRD 缺口 4 要求 admit 成功后创建 `pipeline_run`，但现有 `create_pipeline_run` handler（见 `server/src/pipeline/handlers.rs:20`）强制要求 `beta_enabled: true`（第 44-48 行），否则返回 Validation 错误。协同入工作区的 pipeline_run 创建路径绕过了前端 UI 的 beta 开关，如果直接调用底层 SQL 插入，需要自行构造 `pipeline_run_steps`，而步骤定义目前依赖前端传入 `CreatePipelineRunReq.steps`。 |
| **触发条件** | admit 判定通过后，调用 pipeline 创建逻辑时，若走 `create_pipeline_run` handler 路径则因 `beta_enabled` 校验失败；若走底层 SQL 则缺少步骤定义，pipeline_run 创建后无步骤可执行，orchestrator 无法推进。 |
| **影响范围** | 端到端链路在"入工作区"环节断裂。用户完成协同讨论后无法进入工作区，M1 核心指标"端到端完成率 >= 80%"不可能达成。 |
| **缓解方案** | 1. 新增 `create_pipeline_run_for_collaboration` 内部函数，不走 HTTP handler 路径，直接操作数据库，硬编码 outline pipeline 的步骤模板。2. 该函数内部设置 `trigger_source = 'collaboration'`，绕过 `beta_enabled` 校验。3. 在 `collaboration_sessions` 表新增 `pipeline_run_id` 字段（migration `013`），admit 成功后回写。4. 单元测试覆盖：admit 成功 -> pipeline_runs 表有新记录 -> pipeline_run_steps 表有 outline 步骤。 |
| **是否阻断当前开发** | **是** -- 这是端到端链路的关键闭合点，缺口 4 是 M1-Alpha 的关键路径 A3。 |

### R-03：ai_task 与 assignment 状态不同步导致协同卡死

| 维度 | 内容 |
|---|---|
| **风险描述** | 当前 `dispatcher::dispatch_assignments()`（见 `server/src/collaboration/dispatcher.rs:1`）创建 assignment 后，未创建对应的 `ai_task`，`repo::update_assignment_ai_task_id()` 虽已存在（见 `repo.rs:248`）但从未被调用。v1.0.0 PRD 缺口 3 要求为每个 assignment 创建 ai_task，但更深层的问题是：ai_task 完成后如何自动更新 assignment 状态？当前代码中没有任何监听 ai_task 完成事件并回写 assignment 状态的逻辑。如果 ai_task 完成但 assignment 状态仍为 `running`，admit 判定时 `outline_ready` 永远为 `false`（因为 `ready` 状态从未被设置），协同会话永远无法入工作区。 |
| **触发条件** | ai_task 正常完成（status = completed），但 assignment 状态未从 `running` 更新为 `done`/`ready`。此为默认路径，不是异常路径。 |
| **影响范围** | 所有依赖 assignment 状态的判定逻辑失效：admit 永远拒绝入场、循环检测的"无状态变化"信号误触发、前端状态标签显示错误。 |
| **缓解方案** | 1. 在 `ai/runtime.rs` 的 `finalize_task_success` 流程中，检查该 ai_task 是否关联了 collaboration assignment，如果是则自动更新 assignment 状态。2. 或者采用轮询方案：在 `pipeline/orchestrator.rs` 的 `run_orchestrator_once` 中增加协同 assignment 状态同步逻辑。3. 必须在 A2 任务中同步实现 ai_task 完成回调，而非仅创建 ai_task。4. 单元测试覆盖：ai_task completed -> assignment status 自动变为 done。 |
| **是否阻断当前开发** | **是** -- 缺口 3 是 A3 的前置依赖，而状态同步是缺口 3 的核心，不解决则 A3 无法验收。 |

---

## 二、高危风险（会导致核心功能不可用）

### R-04：成熟度判断规则误判导致协同启动体验劣化

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 采用关键词匹配做成熟度判断（见实施 PRD 第 7 节），要求消息中同时包含"题材/方向/受众/体量"四类关键词。但中文表达的多样性远超关键词列表覆盖范围。例如用户说"做个短剧，讲一个女孩逆袭的故事，给年轻人看"，其中"逆袭"不在 `DIRECTION_KEYWORDS` 中，"年轻人"不在 `AUDIENCE_KEYWORDS` 中，系统判定为不成熟。反之，用户闲聊中偶然提到"悬疑爱情动作短剧"，四类关键词全部命中，但用户并无启动协同的意图。 |
| **触发条件** | 1. 漏判：用户表达了充分意图但关键词未覆盖，`collaborationReady` 始终为 `false`，用户无法启动协同。2. 误判：用户无意启动协同但关键词命中，"启动协同创作"按钮突兀出现。 |
| **影响范围** | M1 核心指标"协同启动准确率 >= 70%"可能无法达成。漏判直接阻断用户流程；误判虽不阻断但严重损害信任感。 |
| **缓解方案** | 1. 首期用"用户确认"按钮兜底（PRD 已规划），不自动启动协同，误判影响可控。2. 漏判问题通过增加"手动触发协同"入口缓解：在对话区工具栏增加"发起协同"按钮，允许用户绕过成熟度判断直接创建协同会话。3. 关键词库需持续迭代，建议在 readiness 检测结果中返回 `missing` 列表，前端展示"还需提供：方向/受众"等提示，引导用户补齐。4. M2 阶段切换到 LLM 判断后此风险自然消解。 |
| **是否阻断当前开发** | 否 -- 有用户确认兜底，不阻断交付，但需在 B1/B2 开发时同步增加手动触发入口。 |

### R-05：服务重启后 ai_task 内存状态丢失导致 assignment 永久卡死

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 3.5 要求实现服务重启恢复逻辑。当前 `AiTaskRuntime` 的任务存储在内存 `HashMap` 中（见 `server/src/ai/runtime.rs:56`），服务重启后所有 ai_task 状态丢失。恢复逻辑（PRD 中的 `restore.rs`）尝试通过 `runtime.get_task(ai_task_id)` 查询 ai_task 状态，但重启后该方法必然返回 `None`，导致所有 assignment 被标记为 `failed`。如果协同会话中大纲 assignment 的 ai_task 正在运行中，重启后大纲 assignment 变为 `failed`，协同会话无法继续推进。 |
| **触发条件** | 服务在协同会话进行中重启，且有 assignment 的 ai_task 处于 `running` 状态。 |
| **影响范围** | 重启后所有进行中的协同会话中，running 状态的 assignment 全部变为 failed，会话无法自动恢复，需要用户手动重新发起。 |
| **缓解方案** | 1. `AiTaskRuntime` 已有 `db: Option<SqlitePool>` 字段（见 `runtime.rs:57`），重启恢复时应从数据库 `ai_tasks` 表重建内存状态，而非直接标记 failed。2. 恢复逻辑分两步：先从 DB 查询 ai_task 状态，再与 assignment 同步。3. 对于确实无法恢复的 ai_task（DB 中也无记录），才标记 assignment 为 failed 并广播错误事件。4. 增加 `ai_tasks` 表的持久化写入逻辑（如果当前 ai_task 仅存内存），确保重启后可从 DB 恢复。 |
| **是否阻断当前开发** | 否 -- 属于稳定性验收项（SAC-3），不影响首次交付，但必须在 M1-RC 前解决。 |

### R-06：CollaborationMessage 与普通消息交错渲染的时间排序问题

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 缺口 5 要求协同消息与普通消息按时间交错排列渲染。但协同消息存储在 `collaboration_messages` 表，普通消息存储在 `messages` 表，两者独立查询后需要在前端合并排序。当前 `ChatArea.tsx` 的消息列表渲染逻辑基于单一消息源，改造为双数据源合并后，需要处理：1. 两个异步数据源的加载时序问题；2. 消息去重（协同消息的 answer 可能同时出现在 messages 表中）；3. 滚动定位（新消息插入后滚动到底部的逻辑需适配双源）。 |
| **触发条件** | 协同会话激活后，对话区同时展示用户消息和智能体间协同消息，消息量大时出现渲染闪烁或排序错乱。 |
| **影响范围** | 用户在对话区看到的消息顺序混乱，无法理解讨论脉络，严重影响协同过程的可观测性。 |
| **缓解方案** | 1. 后端新增聚合 API：`GET /api/collaboration/sessions/{id}/timeline`，返回合并排序后的统一消息列表，前端无需双源合并。2. 如果必须前端合并，使用 `useMemo` 对两个已排序数组做归并排序，避免每次渲染重新排序。3. 协同消息使用 `created_at` 作为排序键，与普通消息的 `createdAt` 统一为 ISO 8601 毫秒精度。4. 限制单次渲染的消息数量（如最近 100 条），避免性能问题。 |
| **是否阻断当前开发** | 否 -- 不阻断核心链路，但影响用户体验，建议在 B3 开发时优先采用后端聚合方案。 |

### R-07：前端刷新后 SSE 重连但协同事件快照缺失

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 缺口 6 要求前端刷新后恢复协同状态。当前 SSE 连接建立时发送 `snapshot` 事件（见 `task_handlers.rs:137`），但 snapshot 仅包含 `ai_tasks` 列表，不包含协同会话数据。刷新后前端通过 `GET /api/collaboration/sessions/active` 恢复协同状态，但恢复时刻到 SSE 重连时刻之间的协同事件会丢失（SSE 是广播模式，无历史回放）。 |
| **触发条件** | 用户在协同进行中刷新页面，恢复请求和 SSE 重连之间存在时间窗口。 |
| **影响范围** | 刷新后短暂时间内前端状态与后端不一致，可能出现：assignment 状态显示旧值、回复队列显示旧顺序、循环检测告警丢失。 |
| **缓解方案** | 1. 在 `GET /api/collaboration/sessions/active` 的响应中包含"最后事件 ID"（`collaboration_events` 表的 `rowid`），SSE 重连后前端可请求 `GET /api/collaboration/sessions/{id}/events?since={lastEventId}` 补齐丢失事件。2. 或者简化方案：恢复时直接拉取最新完整状态（session + assignments + messages），不依赖事件回放。3. SSE 重连后发送一次完整的协同状态快照（类似 `ai_tasks` 的 snapshot 机制）。 |
| **是否阻断当前开发** | 否 -- 刷新恢复是 SAC 验收项，不影响首次正常流程，但 M1-RC 验收场景 4 要求 100% 恢复成功率。 |

---

## 三、中危风险（会影响用户体验但不阻断）

### R-08：Jaccard bigram 对中文同义复述检测效果不佳

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 3.3 采用字符级 bigram 计算 Jaccard 相似度。中文的语义相似性往往不体现在字符重叠上。例如"核心反转是什么"和"主要反转方向是什么"，bigram 集合为 {核心,心反,反转,转是,是什,什么} 与 {主要,要反,反转,转方,方向,向是,是什,什么}，交集仅 {反转,是什,什么}，Jaccard = 3/11 = 0.27，远低于 0.6 阈值，无法触发检测。 |
| **触发条件** | 智能体间使用不同表述重复同一问题，但字符级 bigram 重叠度低。 |
| **影响范围** | 同义复述循环无法被检测到，循环检测的 `SemanticParaphrase` 信号形同虚设。但指纹重复率检测（`HighFingerprintRepeatRate`）仍可覆盖同一问题的重复追问场景。 |
| **缓解方案** | 1. M1 阶段接受此限制，Jaccard 检测仅作为辅助信号，不作为主要循环判定依据（PRD 已明确）。2. 降低 Jaccard 阈值到 0.4 可能增加误报，不建议调整。3. 在 `question_fingerprint` 生成逻辑中增加语义归一化（如去除停用词、提取核心名词），使同义问题的 fingerprint 更容易重复。4. M2 阶段引入分词库或 LLM 判断。 |
| **是否阻断当前开发** | 否 |

### R-09：硬限制阈值过于刚性导致正常讨论被强制阻断

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 3.4 定义了三个硬限制：同一问题最多 3 次、同一对智能体同一主题最多 2 轮、单次协同最多 20 轮。在实际协同中，大纲和剧本之间的讨论可能需要多轮深入追问才能消除分歧，2 轮的限制过于严格。特别是"同一对智能体同一主题"的判定依赖 `question_fingerprint`，如果 fingerprint 生成粒度过粗，不同问题可能被归为同一主题。 |
| **触发条件** | 正常的深度讨论触发硬限制，系统强制升级或 halted。 |
| **影响范围** | 用户感觉系统"过早干预"，正常讨论被打断，需要手动恢复（halted -> discovery），体验割裂。 |
| **缓解方案** | 1. 硬限制触发时先升级给编导（Level 2），而非直接 halted，给编导一次重新拆解的机会。2. "同一对智能体同一主题 2 轮"改为"3 轮"，给更充分的讨论空间。3. `question_fingerprint` 的生成逻辑需仔细设计，确保粒度适中：过细则无法检测循环，过粗则误判为同一主题。4. 前端在硬限制触发前展示预警（如"还剩 1 次追问机会"），让用户有预期。 |
| **是否阻断当前开发** | 否 |

### R-10：协同消息渲染对对话区滚动性能的影响

| 维度 | 内容 |
|---|---|
| **风险描述** | 协同会话激活后，对话区需要同时渲染用户消息和智能体间协同消息。一次协同可能产生 20+ 条协同消息（5 轮 x 4 条/轮），加上用户消息，对话区消息总量可能翻倍。当前 `ChatArea` 的渲染逻辑未针对大量消息做虚拟化处理。 |
| **触发条件** | 协同讨论轮次较多（>10 轮），对话区消息数量超过 100 条。 |
| **影响范围** | 低配设备上对话区滚动卡顿，消息渲染延迟。 |
| **缓解方案** | 1. 协同消息按 session 分批加载，初始仅加载最近 20 条，历史消息按需加载。2. 评估引入虚拟列表（如 `react-virtuoso`）的必要性。3. 协同消息组件使用 `React.memo` 避免不必要的重渲染。4. 限制单次协同的最大消息数量（硬限制 20 轮已间接限制）。 |
| **是否阻断当前开发** | 否 |

### R-11：pipeline_run 创建与协同会话状态的一致性问题

| 维度 | 内容 |
|---|---|
| **风险描述** | v1.0.0 PRD 缺口 4 要求 admit 成功后创建 pipeline_run 并更新 session 状态为 `workspace_execution`。但这两个操作不是原子的：如果 pipeline_run 创建成功但 session 状态更新失败，会出现 pipeline_run 已存在但 session 仍为 `workspace_admission` 的不一致状态。反之，如果 session 先更新为 `workspace_execution` 但 pipeline_run 创建失败，session 指向一个不存在的 pipeline_run。 |
| **触发条件** | admit 流程中任意一步 DB 操作失败（如 SQLite 锁竞争、磁盘满）。 |
| **影响范围** | 数据不一致导致前端状态混乱，工作区可能显示空内容或报错。 |
| **缓解方案** | 1. 使用 SQLite 事务包裹 admit 的全部 DB 操作（创建 pipeline_run + 更新 session 状态 + 创建 event），确保原子性。2. 如果事务失败，session 状态回退到 `resolving_questions`（PRD 已提及此策略但未强制事务）。3. 增加 session 与 pipeline_run 一致性校验的定时任务，检测并修复不一致状态。 |
| **是否阻断当前开发** | 否 -- 概率较低但后果严重，建议在 A3 开发时强制使用事务。 |

---

## 四、低危风险（可接受但需记录）

### R-12：dispatcher 纯函数风格改造为接收 AiTaskRuntime 的架构影响

| 维度 | 内容 |
|---|---|
| **风险描述** | 当前 `dispatcher.rs` 是纯函数风格，仅接收 `SqlitePool`。v1.0.0 PRD 缺口 3 要求 dispatcher 接收 `AiTaskRuntime` 引用以创建 ai_task。这改变了 dispatcher 的函数签名，所有调用方（`handlers.rs`）需同步修改。 |
| **触发条件** | dispatcher 函数签名变更后，调用方未同步更新，编译失败。 |
| **影响范围** | 编译错误，不影响运行时。 |
| **缓解方案** | 1. 修改 dispatcher 函数签名时同步修改所有调用方。2. 考虑将 `AiTaskRuntime` 通过 `AppState` 传入，保持函数签名简洁。 |
| **是否阻断当前开发** | 否 |

### R-13：协同会话状态机 `can_transition_to` 未在运行时强制校验

| 维度 | 内容 |
|---|---|
| **风险描述** | `SessionState::can_transition_to()` 方法已实现（见 `model.rs:31`），但 `repo::update_session_state()` 直接执行 SQL UPDATE，不校验状态迁移合法性。当前 `handlers.rs` 中的状态迁移逻辑是手动判断的（如 admit 中判断 `current_state != ResolvingQuestions`），而非调用 `can_transition_to`。如果后续新增状态迁移路径时遗漏校验，可能出现非法状态迁移。 |
| **触发条件** | 开发者在新 handler 中直接调用 `update_session_state` 而未先校验迁移合法性。 |
| **影响范围** | 数据库中出现非法状态，前端状态标签显示异常，后续基于状态的判定逻辑出错。 |
| **缓解方案** | 1. 在 `repo::update_session_state` 中增加可选的 `from_state` 参数，执行 `UPDATE ... WHERE id = ? AND state = ?`，利用 SQL 的 WHERE 条件实现乐观锁。2. 或在 `update_session_state` 前强制调用 `can_transition_to` 校验，校验失败返回错误。 |
| **是否阻断当前开发** | 否 |

### R-14：前端 Zustand store 协同状态未持久化

| 维度 | 内容 |
|---|---|
| **风险描述** | 当前 Zustand store 中 `activeCollaborationSession`、`activeCollaborationAssignments`、`collaborationLoopCheckResult` 三个状态未持久化到 localStorage（见 `store/index.ts`），页面刷新后丢失。v1.0.0 PRD 缺口 6 通过 API 恢复解决此问题，但如果 API 调用失败（网络异常），协同状态无法恢复。 |
| **触发条件** | 页面刷新且恢复 API 调用失败。 |
| **影响范围** | 用户需要手动重新进入对话区触发恢复，体验降级但不阻断。 |
| **缓解方案** | 1. 在 Zustand store 的协同状态变更时同步写入 localStorage（与 `projects` 等状态一致）。2. 刷新恢复时优先使用 localStorage 中的缓存状态，同时异步请求 API 更新。3. API 失败时展示"协同状态恢复中..."提示，而非空白。 |
| **是否阻断当前开发** | 否 |

### R-15：循环检测的 `check_no_state_change` 信号误报

| 维度 | 内容 |
|---|---|
| **风险描述** | 循环检测信号 `NoStateChangeInRecentRounds` 判定"最近 5 轮没有任何 assignment 状态迁移"。但在正常协同中，智能体可能在 5 轮内都在讨论同一个问题的细节，状态不变不代表循环。例如大纲智能体正在详细回答剧本的追问，5 轮内 assignment 状态一直是 `questioning`，但讨论在实质推进。 |
| **触发条件** | 正常的深度讨论在 5 轮内未产生状态迁移。 |
| **影响范围** | Level 1 循环风险提示出现，干扰智能体正常讨论。但 Level 1 仅提示不阻断，影响有限。 |
| **缓解方案** | 1. `NoStateChangeInRecentRounds` 信号权重降低，单独出现不触发 Level 1，需与其他信号组合才触发。2. 增加"内容增量"检测：即使状态不变，如果新消息内容与之前消息的 Jaccard 相似度低于阈值，说明讨论在推进，不触发此信号。3. M2 阶段用 LLM 判断替代规则。 |
| **是否阻断当前开发** | 否 |

---

## 五、特别关注项汇总

### 5.1 SSE 广播改造对现有 AI 任务流的影响

**风险等级**：致命（R-01）

核心问题不是 `AiTaskEvent` 结构体改造本身（新增字段是向后兼容的），而是 SSE 连接的生命周期管理。当前 SSE 连接仅在 `pendingTaskCount > 0` 时存活，协同事件需要 SSE 连接始终可用。这是架构层面的矛盾，不是简单的字段新增能解决的。

**必须修改的文件**：
- [usePendingTaskSse.ts](file:///c:/Users/lxy/Desktop/work/woohoo/src/context/hooks/usePendingTaskSse.ts) -- SSE 连接条件增加协同会话判断
- [runtime.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/runtime.rs) -- 新增 `broadcast_collaboration_event` 方法
- [config.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/config.rs) -- `AiTaskEvent` 新增 `collaboration_payload` 字段
- [task_handlers.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/task_handlers.rs) -- `stream_tasks` 透传协同事件

### 5.2 成熟度判断误判对用户体验的影响

**风险等级**：高危（R-04）

关键词方案的漏判率预计在 30-50%（基于中文表达的多样性），误判率预计在 10-15%。用户确认按钮可兜底误判，但漏判无解。**建议在 B1/B2 开发时同步增加手动触发入口**，作为漏判的逃生通道。

### 5.3 ai_task 与 assignment 状态不同步的风险

**风险等级**：致命（R-03）

这是当前代码库中最大的结构性缺陷。`dispatcher::dispatch_assignments` 创建 assignment 后不创建 ai_task，且无 ai_task 完成回调机制。v1.0.0 PRD 缺口 3 仅描述了"创建 ai_task"的部分，未详细设计"ai_task 完成后如何同步 assignment 状态"的机制。**建议在 A2 任务中同步实现 ai_task 完成回调**，而非仅创建 ai_task。

### 5.4 pipeline_run 创建与协同会话状态的一致性

**风险等级**：中危（R-11）

admit 流程涉及多步 DB 操作，必须使用事务保证原子性。当前代码中 `repo::update_session_state` 和 `repo::create_event` 是独立调用，无事务包裹。**建议在 A3 开发时强制使用 SQLite 事务**。

### 5.5 前端状态管理的复杂度增长

**风险等级**：中危（R-06, R-10）

协同功能为前端 Zustand store 新增了 3 个状态字段（`activeCollaborationSession`、`activeCollaborationAssignments`、`collaborationLoopCheckResult`），8 种 SSE 事件处理分支，以及双数据源消息合并渲染。这些变更使 `usePendingTaskSse` 的复杂度显著增加（当前已 662 行）。**建议**：
1. 将协同 SSE 事件处理逻辑抽离为独立的 `useCollaborationSse` hook
2. 协同消息渲染使用后端聚合 API 而非前端双源合并
3. 对 `usePendingTaskSse` 进行拆分重构，单一职责

---

## 六、风险矩阵总览

| 编号 | 风险等级 | 风险摘要 | 阻断开发 |
|---|---|---|---|
| R-01 | 致命 | SSE 连接生命周期与协同事件推送矛盾 | 是 |
| R-02 | 致命 | admit 不创建 pipeline_run，端到端链路断裂 | 是 |
| R-03 | 致命 | ai_task 与 assignment 状态不同步，协同卡死 | 是 |
| R-04 | 高危 | 成熟度关键词误判/漏判 | 否 |
| R-05 | 高危 | 服务重启后 ai_task 内存状态丢失 | 否 |
| R-06 | 高危 | 协同消息与普通消息交错渲染排序问题 | 否 |
| R-07 | 高危 | 刷新后 SSE 重连事件快照缺失 | 否 |
| R-08 | 中危 | Jaccard bigram 中文检测效果不佳 | 否 |
| R-09 | 中危 | 硬限制阈值过于刚性 | 否 |
| R-10 | 中危 | 协同消息渲染性能影响 | 否 |
| R-11 | 中危 | pipeline_run 与 session 状态一致性 | 否 |
| R-12 | 低危 | dispatcher 函数签名改造 | 否 |
| R-13 | 低危 | 状态机迁移未运行时强制校验 | 否 |
| R-14 | 低危 | Zustand 协同状态未持久化 | 否 |
| R-15 | 低危 | 循环检测 NoStateChange 信号误报 | 否 |

---

## 七、开发前必须解决的阻断项

在启动 Phase A 开发前，以下三个致命风险必须先有明确的解决方案（不要求代码完成，但要求方案确定）：

1. **R-01**：确定 SSE 连接生命周期策略 -- 是修改 `usePendingTaskSse` 的连接条件，还是为协同事件新建独立的 SSE 端点？
2. **R-02**：确定 pipeline_run 创建路径 -- 是复用 `create_pipeline_run` handler 并绕过 beta 校验，还是新建内部函数直接操作 DB？
3. **R-03**：确定 ai_task 完成回调机制 -- 是在 `finalize_task_success` 中增加协同 assignment 回写，还是用轮询方案？

以上三个问题的决策将直接影响 Phase A 的代码架构，建议在开发启动前完成方案评审。
