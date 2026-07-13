# Woohoo 协同创作系统 -- v1.0.0 开发 PRD

版本：v1.0.0
日期：2026-05-12
状态：待开发
前置文档：`docs/collaboration-ultimate-goal-prd.md`（最终目标 PRD）
关联文档：`docs/collaboration-session-implementation-prd.md`（实施级 PRD v1.0）

---

## 1. v1.0.0 范围定义

### 1.1 一句话目标

**端到端打通，让用户能完整走通一次"对话 -> 协同 -> 入工作区"流程。**

### 1.2 做什么

| 类别 | 内容 |
|---|---|
| 修复 6 个端到端缺口 | SSE 广播断裂、成熟度判断、ai_task 关联、admit 创建 pipeline_run、CollaborationMessage 集成、刷新恢复 |
| 实现 5 项未完成 PRD 项 | CollaborationQueue 组件、工作区联动跳转、Jaccard 检测（简化版）、硬限制强制阻断、服务重启恢复 |

### 1.3 不做什么

| 不做项 | 理由 |
|---|---|
| LLM 自主成熟度判断 | M1 用规则方案验证链路，LLM 方案留到 M2 |
| 全流程自动编排（Script/Chapters/Keyframe/Video） | M1 仅覆盖 Outline 入工作区 |
| 协同模板 | M2 功能 |
| 多用户实时协作 | M3 功能 |
| 协同历史回放 | M2 功能 |
| 任意智能体自由群聊 | 破坏依赖链，跨版本禁止 |

---

## 2. 六个端到端缺口修复方案

### 缺口 1：SSE 事件广播断裂

**现状**：`repo::create_event()` 只写 DB，不通过 `ai_runtime.events` broadcast channel 推送。前端 SSE 处理逻辑已写但收不到事件。

**根因**：collaboration handlers 没有 `ai_runtime` 的引用，无法调用 `broadcast()`。

**修复方案**：

1. 在 `AppState` 中已有 `ai_runtime: AiTaskRuntime`，handlers 已可通过 `State(state)` 获取。
2. 在 `AiTaskRuntime` 上新增方法：

```rust
/// 广播协同事件到 SSE 通道
pub fn broadcast_collaboration_event(&self, user_id: &str, event_type: &str, payload: serde_json::Value) {
    let event = AiTaskEvent {
        event_type: event_type.to_string(),
        task: /* 构造一个虚拟 AiTask 用于携带 payload */,
        ..Default::default()
    };
    let _ = self.events.send(TaskEventEnvelope {
        user_id: user_id.to_string(),
        event,
    });
}
```

3. 更优方案：在 `AiTaskEvent` 中新增 `collaboration_payload: Option<serde_json::Value>` 字段，SSE handler 在 `stream_tasks` 中透传该字段。前端已有 `handleSSEEvent` 按 `eventType` 分发，无需修改。

4. 在每个 `repo::create_event()` 调用后，追加 `state.ai_runtime.broadcast_collaboration_event()` 调用。

**涉及文件**：
- `server/src/ai/runtime.rs` -- 新增 broadcast_collaboration_event 方法
- `server/src/ai/config.rs` -- AiTaskEvent 新增 collaboration_payload 字段
- `server/src/ai/task_handlers.rs` -- stream_tasks 中透传 collaboration_payload
- `server/src/collaboration/handlers.rs` -- 每个 create_event 后追加广播调用
- `server/src/collaboration/dispatcher.rs` -- dispatch_assignments/handle_question/handle_answer 中追加广播

**验收标准**：
- 前端 SSE 连接建立后，创建协同会话时能收到 `collaboration_session_created` 事件
- 分派/提问/回答/循环检测/入场判定事件均能实时推送到前端
- 前端 Zustand store 中 `activeCollaborationSession` 和 `activeCollaborationAssignments` 实时更新

---

### 缺口 2：成熟度判断未实现

**现状**：无关键词检测逻辑、无 `collaborationReady` 标记、无"启动协同"按钮。

**修复方案**：

**后端**：

1. 新增 `server/src/collaboration/readiness.rs` 模块：

```rust
/// 协同成熟度检测器
pub struct ReadinessDetector;

impl ReadinessDetector {
    /// 检查最近消息是否满足协同启动条件
    pub fn check(messages: &[String]) -> ReadinessResult {
        let text = messages.iter().rev().take(10).cloned().collect::<Vec<_>>().join(" ");
        let has_genre = GENRE_KEYWORDS.iter().any(|kw| text.contains(kw));
        let has_direction = DIRECTION_KEYWORDS.iter().any(|kw| text.contains(kw));
        let has_audience = AUDIENCE_KEYWORDS.iter().any(|kw| text.contains(kw));
        let has_format = FORMAT_KEYWORDS.iter().any(|kw| text.contains(kw));
        ReadinessResult {
            ready: has_genre && has_direction && has_audience && has_format,
            missing: /* 缺失项列表 */,
        }
    }
}
```

2. 在 AI 任务完成回调中（`ai/runtime.rs` 的任务完成处理逻辑），检查该对话是否满足成熟度条件。如果满足，在 assistant 回复的 meta 中附加 `collaborationReady: true`。

3. 新增 API：`GET /api/collaboration/readiness?conversationId={id}`，前端可在需要时主动查询。

**前端**：

1. 在 `ChatMessageGroupItem.tsx` 的 `MessageItem` 组件中，检测 `message.meta?.collaborationReady === true`，渲染"启动协同创作"按钮。

2. 按钮点击后调用 `POST /api/collaboration/sessions` 创建协同会话。

**涉及文件**：
- `server/src/collaboration/readiness.rs` -- 新增
- `server/src/collaboration/mod.rs` -- 注册模块
- `server/src/collaboration/handlers.rs` -- 新增 get_readiness handler
- `server/src/main.rs` -- 注册路由
- `server/src/ai/runtime.rs` -- 任务完成回调中检查成熟度
- `src/types/index.ts` -- MessageMeta 新增 collaborationReady 字段
- `src/features/studio/components/chat/ChatMessageGroupItem.tsx` -- 渲染启动按钮

**验收标准**：
- 用户输入包含题材/方向/受众/体量关键词后，assistant 回复中包含 `collaborationReady: true` 标记
- 前端展示"启动协同创作"按钮
- 点击按钮后成功创建协同会话，状态变为 `discovery`

---

### 缺口 3：ai_task 关联缺失

**现状**：`dispatcher::dispatch_assignments()` 创建 assignment 后未创建 ai_task，`repo::update_assignment_ai_task_id()` 存在但从未被调用。

**修复方案**：

1. 在 `dispatcher::dispatch_assignments()` 中，为每个 assignment 创建对应的 ai_task：

```rust
// 在创建 assignment 后，为每个 assignment 创建 ai_task
for assignment in &created {
    let ai_task_id = state.ai_runtime.create_collaboration_task(
        &user_id,
        &assignment.agent_id,
        &assignment.goal,
        &session.conversation_id,
        &session.project_id,
    ).await?;

    repo::update_assignment_ai_task_id(pool, &assignment.id, &ai_task_id).await?;
}
```

2. 需要将 `ai_runtime` 传入 dispatcher。当前 dispatcher 是纯函数风格（只接收 `SqlitePool`），需要扩展为接收 `AiTaskRuntime` 引用。

3. 在 `handlers::dispatch()` 中传入 `state.ai_runtime`。

4. 当 ai_task 完成时，监听 ai_task 的 completed 事件，自动更新 assignment 状态（running -> done/failed）。

**涉及文件**：
- `server/src/collaboration/dispatcher.rs` -- dispatch_assignments 中创建 ai_task
- `server/src/collaboration/handlers.rs` -- 传入 ai_runtime
- `server/src/collaboration/repo.rs` -- update_assignment_ai_task_id 已存在

**验收标准**：
- dispatch 后每个 assignment 的 `ai_task_id` 字段非空
- assignment 状态从 `assigned` -> `running`（update_assignment_ai_task_id 已设置 status='running'）
- ai_task 完成后 assignment 状态自动更新为 `done` 或 `failed`

---

### 缺口 4：admit 不创建 pipeline_run

**现状**：`handlers::admit()` 判定通过后只更新 session 状态为 `workspace_admission`，但 `pipeline_run_id` 始终为 `None`。

**修复方案**：

1. 在 `handlers::admit()` 中，判定通过后调用 pipeline 的创建逻辑：

```rust
// 判定通过后，创建 pipeline_run
let pipeline_run = create_pipeline_run_for_collaboration(
    &state.db,
    &user_id,
    &session.project_id,
    &session.conversation_id,
    "outline",  // M1 仅支持 outline
).await?;

// 更新 session 状态
repo::update_session_state(&state.db, &session_id, "workspace_execution").await?;

// 广播事件
repo::create_event(&state.db, &session_id, "collaboration_workspace_started", ...).await;
```

2. 新增 `repo::update_session_pipeline_run_id()` 函数，将 pipeline_run_id 存入 session（需在 collaboration_sessions 表中新增 `pipeline_run_id TEXT` 字段）。

3. 新增 migration：`013_collaboration_add_pipeline_run_id.sql`。

**涉及文件**：
- `server/migrations/013_collaboration_add_pipeline_run_id.sql` -- 新增
- `server/src/collaboration/repo.rs` -- 新增 update_session_pipeline_run_id
- `server/src/collaboration/handlers.rs` -- admit 中创建 pipeline_run
- `server/src/collaboration/model.rs` -- CollaborationSession 新增 pipeline_run_id 字段

**验收标准**：
- admit 成功后，返回的 `pipelineRunId` 非空
- `pipeline_runs` 表中新增一条记录，trigger_source 为 `collaboration`
- session 状态变为 `workspace_execution`

---

### 缺口 5：CollaborationMessage 未集成到消息渲染

**现状**：`CollaborationMessage.tsx` 组件已写但未在 `ChatMessageGroupItem.tsx` 中使用。

**修复方案**：

1. 在 `ChatArea.tsx` 中，当存在 `activeCollaborationSession` 时，拉取该 session 的协同消息列表。

2. 新增 API：`GET /api/collaboration/sessions/{id}/messages`（当前只有 `list_messages` repo 函数，无对应 handler）。

3. 在 `ChatMessageGroupItem.tsx` 的消息列表中，将协同消息与普通消息按时间交错排列渲染。

4. 协同消息使用 `CollaborationMessage` 组件渲染，普通消息使用现有 `MessageItem` 组件。

**涉及文件**：
- `server/src/collaboration/handlers.rs` -- 新增 get_messages handler
- `server/src/main.rs` -- 注册路由
- `src/lib/serverApi.collaboration.ts` -- 新增 getMessages API
- `src/features/studio/components/chat/ChatArea.tsx` -- 拉取协同消息
- `src/features/studio/components/chat/ChatMessageGroupItem.tsx` -- 集成 CollaborationMessage

**验收标准**：
- 协同会话激活时，对话区同时展示用户消息和智能体间协同消息
- 协同消息有明确的发送者/目标/意图标签
- 协同消息与用户消息按时间顺序交错排列

---

### 缺口 6：前端刷新不恢复协同状态

**现状**：页面刷新后 Zustand store 重置，不会自动拉取活跃协同会话。

**修复方案**：

1. 新增 API：`GET /api/collaboration/sessions/active?projectId={id}&conversationId={id}`，返回当前对话下的活跃协同会话（状态非 completed/halted）。

2. 在 `ChatArea.tsx` 的 `useEffect` 中，当 `isServerWorkspaceReady && activeState.projectId && activeState.chatSessionId` 时，调用该 API 恢复协同状态。

3. 恢复逻辑：将返回的 session 和 assignments 写入 Zustand store。

**涉及文件**：
- `server/src/collaboration/handlers.rs` -- 新增 get_active_session handler
- `server/src/main.rs` -- 注册路由
- `server/src/collaboration/repo.rs` -- 新增 get_active_session_by_conversation
- `src/lib/serverApi.collaboration.ts` -- 新增 getActiveSession API
- `src/features/studio/components/chat/ChatArea.tsx` -- 初始化时恢复协同状态

**验收标准**：
- 页面刷新后，对话区顶部仍显示协同状态标签
- 回复队列、阻塞问题、循环检测结果均恢复
- SSE 重连后继续接收新事件

---

## 3. 五项未完成 PRD 项的实施计划

### 3.1 CollaborationQueue 独立组件（PRD 9.1）

**目标**：在对话区展示当前发言队列。

**方案**：

1. 新增 `src/features/studio/components/chat/CollaborationQueue.tsx`。

2. 从 `activeCollaborationSession.replyQueueJson` 解析队列，展示为：

```
发言队列：大纲 -> 剧本 -> 编导
```

3. 当前发言者高亮，已完成发言者灰显。

4. 在 `ChatArea.tsx` 中，当存在活跃协同会话时，在 `CollaborationStatus` 下方渲染 `CollaborationQueue`。

**涉及文件**：
- `src/features/studio/components/chat/CollaborationQueue.tsx` -- 新增
- `src/features/studio/components/chat/ChatArea.tsx` -- 集成

**验收标准**：
- 协同会话激活时，对话区展示发言队列
- 队列随 SSE 事件实时更新

---

### 3.2 工作区联动自动跳转（PRD 3.5）

**目标**：协同会话进入 `workspace_execution` 后自动跳转到工作区 tab。

**方案**：

1. 在 `usePendingTaskSse.ts` 的 `collaboration_workspace_started` 事件处理中，调用 `useAppStore.getState().switchTab('workspace')`。

2. 同时设置 `activeState.currentTab = 'workspace'`。

**涉及文件**：
- `src/context/hooks/usePendingTaskSse.ts` -- collaboration_workspace_started 事件中触发跳转

**验收标准**：
- admit 成功且收到 `collaboration_workspace_started` 事件后，自动切换到工作区 tab
- 工作区中显示刚创建的 Outline pipeline run

---

### 3.3 同义复述 Jaccard 检测（PRD 8.2，简化版）

**目标**：检测智能体间是否存在语义重复的提问。

**方案（M1 简化版）**：

1. 在 `loop_detector.rs` 中新增 `check_jaccard_similarity` 方法。

2. 对最近 5 轮的 question 消息，提取分词后计算 Jaccard 相似度。

3. 中文分词使用简单的字符级 bigram（避免引入分词库依赖）。

4. Jaccard > 0.6 时触发 `SemanticParaphrase` 信号。

```rust
/// 计算两个文本的 bigram Jaccard 相似度
fn jaccard_similarity(a: &str, b: &str) -> f64 {
    let set_a: HashSet<String> = bigrams(a);
    let set_b: HashSet<String> = bigrams(b);
    let intersection = set_a.intersection(&set_b).count() as f64;
    let union = set_a.union(&set_b).count() as f64;
    if union == 0.0 { return 0.0; }
    intersection / union
}

fn bigrams(text: &str) -> HashSet<String> {
    let chars: Vec<char> = text.chars().collect();
    chars.windows(2).map(|w| w.iter().collect::<String>()).collect()
}
```

5. 新增 `LoopSignal::SemanticParaphrase` 变体。

**涉及文件**：
- `server/src/collaboration/loop_detector.rs` -- 新增 check_jaccard_similarity 和 SemanticParaphrase 信号

**验收标准**：
- 两个语义相近的提问（如"核心反转是什么"和"主要反转方向是什么"）Jaccard > 0.6
- 检测到后触发 `SemanticParaphrase` 信号，循环等级提升

---

### 3.4 硬限制强制阻断（PRD 8.4）

**目标**：同一问题最多3次、同一对智能体同一主题最多2轮、单次协同最多20轮。

**方案**：

1. 在 `dispatcher::handle_question()` 中，检查 `assignment.blocking_question_count`：
   - 若 >= 3，直接升级给编导，不再允许同一智能体继续追问。

2. 在 `loop_detector::check_ping_pong()` 中，检查同一对智能体的往返次数：
   - 若 >= 2 轮，触发 `PingPongBetweenAgents` 信号。

3. 在 `loop_detector::detect()` 中，检查 `session.round_count`：
   - 若 >= 20，直接返回 Level 4 信号，会话 halted。

4. 新增 `repo::get_question_count_by_fingerprint()` 函数，按 fingerprint 统计同一问题的追问次数。

**涉及文件**：
- `server/src/collaboration/dispatcher.rs` -- handle_question 中检查硬限制
- `server/src/collaboration/loop_detector.rs` -- detect 中检查总轮次硬限制
- `server/src/collaboration/repo.rs` -- 新增 get_question_count_by_fingerprint

**验收标准**：
- 同一 fingerprint 追问 3 次后，系统自动升级给编导
- 同一对智能体同一主题往返 2 轮后，触发循环检测
- 总轮次达到 20 后，会话自动 halted

---

### 3.5 服务重启恢复逻辑（SAC-3）

**目标**：服务重启后，未完成的协同会话可从数据库恢复状态。

**方案**：

1. 在 `main.rs` 启动流程中，新增 `collaboration::restore::restore_active_sessions()` 调用。

2. 新增 `server/src/collaboration/restore.rs` 模块：

```rust
/// 从数据库恢复活跃协同会话
pub async fn restore_active_sessions(pool: &SqlitePool, runtime: &AiTaskRuntime) -> Result<()> {
    // 1. 查询所有非终态的协同会话
    let sessions = repo::list_active_sessions(pool).await?;

    for session in sessions {
        // 2. 恢复回复队列
        let queue = ReplyQueueManager::load_queue(pool, &session.id).await?;

        // 3. 检查关联的 ai_task 状态，同步 assignment 状态
        let assignments = repo::list_assignments(pool, &session.id).await?;
        for assignment in assignments {
            if let Some(ai_task_id) = &assignment.ai_task_id {
                let task = runtime.get_task(ai_task_id).await;
                if let Some(task) = task {
                    match task.status.as_str() {
                        "completed" => {
                            repo::update_assignment_status(pool, &assignment.id, "done").await?;
                        }
                        "failed" => {
                            repo::update_assignment_status(pool, &assignment.id, "failed").await?;
                        }
                        _ => {}
                    }
                } else {
                    // ai_task 在重启后已丢失，标记 assignment 为 failed
                    repo::update_assignment_status(pool, &assignment.id, "failed").await?;
                }
            }
        }

        // 4. 如果所有 assignment 都是终态，推进会话状态
        // ...
    }

    Ok(())
}
```

3. 新增 `repo::list_active_sessions()` 函数，查询状态非 completed/halted 的会话。

**涉及文件**：
- `server/src/collaboration/restore.rs` -- 新增
- `server/src/collaboration/mod.rs` -- 注册模块
- `server/src/collaboration/repo.rs` -- 新增 list_active_sessions
- `server/src/main.rs` -- 启动时调用 restore_active_sessions

**验收标准**：
- 服务重启后，之前处于 `resolving_questions` 状态的会话仍可继续
- 关联的 ai_task 已完成的 assignment 自动更新为 `done`
- 关联的 ai_task 已丢失的 assignment 标记为 `failed`

---

## 4. 开发顺序和依赖关系

```
Phase A: 基础管道修复（无前端依赖，后端先行）
  A1. SSE 广播修复 ─────────────────────────── 缺口1
  A2. ai_task 关联修复 ─────────────────────── 缺口3
  A3. admit 创建 pipeline_run ──────────────── 缺口4
  A4. 服务重启恢复 ──────────────────────────── 3.5
  A5. 硬限制强制阻断 ────────────────────────── 3.4
  A6. Jaccard 检测（简化版）────────────────── 3.3

  依赖关系：
  A1 独立
  A2 独立
  A3 依赖 A2（需要 ai_task_id 正确关联）
  A4 依赖 A2（恢复时需要检查 ai_task 状态）
  A5 独立
  A6 独立

Phase B: 成熟度 + 前端集成（依赖 Phase A）
  B1. 成熟度判断（后端） ────────────────────── 缺口2-后端
  B2. 成熟度判断（前端启动按钮）────────────── 缺口2-前端
  B3. CollaborationMessage 集成 ────────────── 缺口5
  B4. 前端刷新恢复 ──────────────────────────── 缺口6
  B5. CollaborationQueue 组件 ──────────────── 3.1
  B6. 工作区联动跳转 ────────────────────────── 3.2

  依赖关系：
  B1 独立
  B2 依赖 B1 + A1（需要 SSE 推送启动事件）
  B3 依赖 A1（需要 SSE 推送消息事件）+ 缺口5 的 messages API
  B4 依赖 A1（需要 SSE 重连后继续接收）
  B5 依赖 A1（需要 SSE 推送队列更新事件）
  B6 依赖 A3（需要 pipeline_run 创建成功后触发跳转）
```

**推荐开发顺序**：

```
A1 -> A2 -> A5 -> A6 -> A3 -> A4 -> B1 -> B2 -> B3 -> B4 -> B5 -> B6
```

---

## 5. 每个任务的验收标准

### Phase A

| 编号 | 任务 | 验收标准 |
|---|---|---|
| A1 | SSE 广播修复 | 创建协同会话后，前端 SSE 连接收到 `collaboration_session_created` 事件；分派/提问/回答/循环检测/入场事件均实时推送 |
| A2 | ai_task 关联修复 | dispatch 后每个 assignment 的 `ai_task_id` 非空；assignment 状态自动从 assigned -> running -> done/failed |
| A3 | admit 创建 pipeline_run | admit 成功后返回 `pipelineRunId` 非空；`pipeline_runs` 表新增记录；session 状态变为 `workspace_execution` |
| A4 | 服务重启恢复 | 重启后活跃会话状态可恢复；ai_task 已完成的 assignment 自动更新；丢失的 assignment 标记 failed |
| A5 | 硬限制强制阻断 | 同一 fingerprint 追问 3 次后自动升级；同一对智能体往返 2 轮后触发检测；20 轮后自动 halted |
| A6 | Jaccard 检测 | 语义相近提问 Jaccard > 0.6 触发 `SemanticParaphrase` 信号；循环等级正确提升 |

### Phase B

| 编号 | 任务 | 验收标准 |
|---|---|---|
| B1 | 成熟度判断（后端） | 包含题材/方向/受众/体量关键词的消息被标记为 `collaborationReady: true`；缺失项被列出 |
| B2 | 成熟度判断（前端） | assistant 回复中展示"启动协同创作"按钮；点击后成功创建协同会话 |
| B3 | CollaborationMessage 集成 | 协同消息与用户消息交错展示；协同消息有发送者/目标/意图标签 |
| B4 | 前端刷新恢复 | 页面刷新后协同状态标签、回复队列、阻塞问题均恢复 |
| B5 | CollaborationQueue 组件 | 发言队列实时展示；当前发言者高亮 |
| B6 | 工作区联动跳转 | admit 成功后自动切换到工作区 tab；工作区显示 Outline pipeline run |

---

## 6. 里程碑定义

### M1-Alpha：管道修复（Phase A 完成）

**时间估算**：5 个工作日

**交付物**：
- SSE 事件广播链路打通
- ai_task 正确关联 assignment
- admit 正确创建 pipeline_run
- 硬限制和 Jaccard 检测生效
- 服务重启可恢复

**验收方式**：后端单元测试 + curl 端到端测试

**关键路径**：A1 -> A2 -> A3

---

### M1-Beta：前端集成（Phase B 完成）

**时间估算**：5 个工作日

**交付物**：
- 成熟度判断 + 启动按钮
- 协同消息在对话区渲染
- 刷新恢复
- CollaborationQueue 组件
- 工作区联动跳转

**验收方式**：手动端到端测试 -- 从输入创意到大纲入工作区完整走通

**关键路径**：B1 -> B2 -> B3

---

### M1-RC：端到端验收

**时间估算**：2 个工作日

**验收场景**：

1. **Happy Path**：用户输入"我想做一个悬疑反转短剧，节奏快，面向18-30岁女性用户，3集短剧" -> 系统标记成熟 -> 用户点击启动 -> 编导分派大纲和剧本 -> 大纲产出 -> 剧本追问 -> 大纲回答 -> 剧本就绪 -> 自动入工作区 -> 工作区展示 Outline pipeline run

2. **循环检测**：模拟智能体间来回追问 -> 5轮后触发检测 -> Level 1 提示 -> Level 2 升级编导 -> Level 3 请求用户裁决

3. **硬限制**：同一问题追问3次 -> 自动升级；20轮后 -> 自动 halted

4. **刷新恢复**：协同进行中刷新页面 -> 状态完整恢复 -> SSE 重连后继续接收事件

5. **服务重启**：协同进行中重启服务 -> 恢复活跃会话 -> 继续协同

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| SSE 广播改造影响现有 AI 任务事件流 | 低 | 高 | AiTaskEvent 新增字段而非修改结构；前端按 eventType 分发，互不影响 |
| 成熟度规则误判（漏判/误触） | 中 | 中 | 首期用"用户确认"按钮兜底，不自动启动；后续迭代优化关键词库 |
| ai_task 创建失败导致 assignment 卡在 assigned | 中 | 高 | 创建 ai_task 失败时，assignment 标记为 failed 并广播错误事件 |
| pipeline_run 创建失败导致 admit 卡住 | 低 | 高 | admit 中 pipeline_run 创建失败时，session 状态回退到 resolving_questions |
| Jaccard bigram 对中文检测效果不佳 | 中 | 低 | M1 仅作为辅助信号，不作为主要循环判定依据；M2 考虑引入分词库 |
| 前端协同消息与普通消息交错渲染性能 | 低 | 中 | 协同消息按 session 分批加载，限制单次渲染数量 |

---

## 8. 技术约束

| 约束 | 说明 |
|---|---|
| 单服务实例 | 不做分布式协同调度 |
| SQLite | 不引入新的存储依赖 |
| 规则优先 | 成熟度判断和循环检测均基于规则，M1 不引入 LLM 判断 |
| 现有 SSE 通道 | 协同事件复用 `/api/ai/tasks/stream`，不新建 SSE 端点 |
| 现有 pipeline 机制 | admit 创建 pipeline_run 复用现有 pipeline 创建逻辑 |
| 前端状态管理 | 协同状态通过 Zustand store 管理，不引入新的状态管理库 |
