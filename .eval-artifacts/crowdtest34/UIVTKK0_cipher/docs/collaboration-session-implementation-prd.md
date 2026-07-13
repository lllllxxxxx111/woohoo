# 对话驱动多智能体协同编排 — 实施级 PRD

版本：v1.0
日期：2026-05-12
状态：待实施
前置文档：`docs/conversation-driven-multi-agent-prd.md`（v0.1 草案）

---

## 1. 定位与范围

### 1.1 一句话目标

在项目内对话区实现"默认助理识别成熟度 → 自动发起多智能体协同 → 智能体按队列讨论消除阻塞 → 条件满足后自动步入工作区执行"的完整链路。

### 1.2 本期范围

| 维度 | 约束 |
|---|---|
| 对话类型 | 仅限项目内对话，全局聊天不涉及 |
| 智能体组合 | 默认助理 → 编导 → 大纲 → 剧本 |
| 入工作区阶段 | 仅支持 Outline 自动入工作区 |
| 服务拓扑 | 单服务实例，不做分布式协同调度 |
| 循环检测 | 基于规则，不做 LLM 判断 |
| 成熟度判断 | 基于规则（字段完整性 + 关键词），不做 LLM 自主判断 |

### 1.3 明确不做

1. 全局聊天场景的自动协同
2. 任意智能体自由群聊
3. 分布式多实例协同调度
4. Script/Chapters/Keyframe/Video 全流程自动编排（留到 M2）
5. LLM 自主成熟度判断（首期用规则）
6. 协同消息写入 messages 表（协同消息独立存储）

---

## 2. 实施阶段与交付物

### 阶段 0：基线收口

> 先止血再前进。不收口这些技术债，新功能会在不稳固的地基上越堆越歪。

| 编号 | 任务 | 交付物 | 验收标准 |
|---|---|---|---|
| 0.1 | db.rs migration 主导化 | 新增 `009_collaboration.sql` migration；删除 `ensure_*` 中与 migration 重复的逻辑 | 新库只走 SQL migration 路径初始化；老库启动时 backfill 仅补齐历史兼容，不创建新表 |
| 0.2 | SSE 兼容性回归矩阵 | 测试用例覆盖 `finish_reason`/`finishreason`、`[DONE]`、跨 chunk 分片、空 delta | 所有边界场景有测试，不再出现静默解析失败 |
| 0.3 | 清理 Cargo.toml 无用依赖 | 移除 `redis` 依赖 | `cargo build` 成功，二进制体积减小 |
| 0.4 | 清理 backend/ 旧目录 | 删除或归档 `backend/` | 仓库中不存在已废弃的历史原型目录 |

### 阶段 1：协同会话数据模型 + API 骨架

> 后端先行，建表、建 API、建状态机，不接真实 AI 调用。

| 编号 | 任务 | 交付物 | 验收标准 |
|---|---|---|---|
| 1.1 | 新增 4 张表的 SQL migration | `server/migrations/009_collaboration.sql` | 新库启动后 4 张表存在且字段、索引、外键正确 |
| 1.2 | 新增 `collaboration` 模块 | `server/src/collaboration/{mod,model,repo,handlers}.rs` | 模块结构与现有 `pipeline/`、`conversation/` 一致 |
| 1.3 | 实现协同会话状态机 | `CollaborationSession` 模型 + 状态迁移函数 | 7 个状态（discovery/delegating/resolving_questions/workspace_admission/workspace_execution/completed/halted）的合法迁移有单元测试 |
| 1.4 | 实现任务卡状态机 | `CollaborationAssignment` 模型 + 状态迁移函数 | 8 个状态（idle/assigned/questioning/ready/running/blocked/done/failed）的合法迁移有单元测试 |
| 1.5 | 实现 7 个 API 端点 | 路由注册在 `main.rs`，handler 在 `collaboration/handlers.rs` | 可通过 curl/httpie 完成创建会话、分派任务、发消息、循环检测、入工作区、暂停等操作 |
| 1.6 | 前端类型定义 | `src/types/index.ts` 新增协同相关类型 | TypeScript 编译通过 |

### 阶段 2：编导分派器 + 回复队列 + 上游追问 + 循环检测

> 协同层的"大脑"，让智能体之间真正能对话。

| 编号 | 任务 | 交付物 | 验收标准 |
|---|---|---|---|
| 2.1 | 编导分派器 | 编导智能体根据用户需求生成任务卡，每个 assignment 对应一个 ai_task | 编导收到 dispatch 请求后，能自动创建大纲/剧本 assignment 并发起对应 ai_task |
| 2.2 | 回复队列 | `reply_queue` 持久化在 `collaboration_sessions` 中，同一时间只允许一个智能体发言 | 不存在同一时刻多个智能体并发抢答；队列状态刷新后可恢复 |
| 2.3 | 上游追问机制 | 领域智能体可向依赖链上游发问 | 剧本可向大纲发问；大纲回答后剧本状态从 blocked → ready |
| 2.4 | 阻塞解除 | 编导监听 answer 事件，更新 assignment 状态 | 上游回答后，下游 blocked → ready 自动推进 |
| 2.5 | 5 轮循环检测 | 基于规则的 question_fingerprint 比对 | 累计 5 轮后触发检测；重复率/无进展/来回转发命中后升级；达到硬限制后 halted |
| 2.6 | SSE 事件推送 | 新增 8 种 collaboration SSE 事件 | 前端可通过 `/api/ai/tasks/stream` 收到协同事件 |

### 阶段 3：自动入工作区 + 前端展示

> 把协同讨论的结果自动落到工作区执行，并在前端完整展示协同过程。

| 编号 | 任务 | 交付物 | 验收标准 |
|---|---|---|---|
| 3.1 | 入工作区判定 | `POST /api/collaboration/sessions/{id}/admit` 端点 | 满足入场条件时自动创建 pipeline_run；不满足时返回拒绝原因 |
| 3.2 | 前端协同状态展示 | ChatArea 中显示协同状态标签、回复队列、阻塞问题清单 | 用户可在对话区看到当前协同进展 |
| 3.3 | 智能体消息标识 | 每条协同消息标识发送者、@目标、意图 | 用户可区分"用户消息"和"智能体间协同消息" |
| 3.4 | 循环风险告警 | 顶部显示循环风险告警条 | 循环检测命中时用户可见告警 |
| 3.5 | 工作区联动 | 协同会话进入 workspace_execution 后自动跳转到对应步骤 | 用户无需手动切换 tab |
| 3.6 | 前端 API 对接 | `src/lib/serverApi.collaboration.ts` | 前端可调用全部 7 个协同 API |

---

## 3. 数据模型

### 3.1 新增表

#### collaboration_sessions

```sql
CREATE TABLE IF NOT EXISTS collaboration_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    entry_message_id TEXT,
    state           TEXT NOT NULL DEFAULT 'discovery',
    orchestrator_agent_id TEXT,
    admission_decision_json TEXT,
    loop_status_json TEXT,
    reply_queue_json TEXT,
    round_count     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_collab_sessions_project ON collaboration_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_conversation ON collaboration_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_collab_sessions_state ON collaboration_sessions(state);
```

#### collaboration_assignments

```sql
CREATE TABLE IF NOT EXISTS collaboration_assignments (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    task_type       TEXT NOT NULL,
    goal            TEXT NOT NULL,
    input_json      TEXT,
    depends_on_json TEXT,
    status          TEXT NOT NULL DEFAULT 'idle',
    blocking_question_count INTEGER NOT NULL DEFAULT 0,
    last_question_fingerprint TEXT,
    ai_task_id      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES collaboration_sessions(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_collab_assignments_session ON collaboration_assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_assignments_status ON collaboration_assignments(status);
```

#### collaboration_messages

```sql
CREATE TABLE IF NOT EXISTS collaboration_messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    source_agent_id TEXT,
    target_agent_id TEXT,
    message_kind    TEXT NOT NULL,
    content         TEXT NOT NULL,
    question_fingerprint TEXT,
    reply_to_message_id TEXT,
    queue_order     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES collaboration_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_collab_messages_session ON collaboration_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_messages_kind ON collaboration_messages(message_kind);
```

#### collaboration_events

```sql
CREATE TABLE IF NOT EXISTS collaboration_events (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload_json    TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES collaboration_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_collab_events_session ON collaboration_events(session_id);
CREATE INDEX IF NOT EXISTS idx_collab_events_type ON collaboration_events(event_type);
```

### 3.2 字段约定

| 字段 | 约定 |
|---|---|
| `id` | UUID v4，由服务端生成 |
| `*_json` 字段 | 存储合法 JSON 字符串，空时为 `NULL` 而非 `"{}"` |
| `created_at` / `updated_at` | ISO 8601 毫秒精度字符串，与现有表一致 |
| `state` / `status` | 枚举字符串，不使用整数编码 |
| `source_agent_id` | `NULL` 表示来源是用户或系统 |

### 3.3 复用现有表

| 表 | 用途 |
|---|---|
| `messages` | 面向用户展示的对话消息，协同消息不写入此表 |
| `pipeline_runs` | 入工作区后创建的执行 run |
| `pipeline_run_steps` | 工作区内正式步骤 |
| `agents` / `project_agent_assignments` | 智能体定义和项目绑定 |
| `ai_tasks` | 每个 assignment 对应的异步 AI 任务 |

---

## 4. 状态机

### 4.1 协同会话状态

```
discovery ──→ delegating ──→ resolving_questions ──→ workspace_admission ──→ workspace_execution ──→ completed
    │              │                   │                       │
    │              │                   │                       └──→ halted
    │              │                   └──→ halted
    │              └──→ halted
    └──→ halted
                                               halted ──→ discovery（用户裁决后恢复）
```

合法迁移矩阵：

| 从 → 到 | discovery | delegating | resolving_questions | workspace_admission | workspace_execution | completed | halted |
|---|---|---|---|---|---|---|---|
| discovery | - | ✅ | - | - | - | - | ✅ |
| delegating | - | - | ✅ | - | - | - | ✅ |
| resolving_questions | - | - | ✅ | ✅ | - | - | ✅ |
| workspace_admission | - | - | - | - | ✅ | - | ✅ |
| workspace_execution | - | - | - | - | - | ✅ | ✅ |
| halted | ✅ | - | - | - | - | - | - |

### 4.2 任务卡状态

```
idle ──→ assigned ──→ questioning ──→ blocked ──→ ready ──→ running ──→ done
                │                      ↑          │
                └──→ ready ────────────┘          └──→ failed
```

合法迁移矩阵：

| 从 → 到 | idle | assigned | questioning | ready | blocked | running | done | failed |
|---|---|---|---|---|---|---|---|---|
| idle | - | ✅ | - | - | - | - | - | - |
| assigned | - | - | ✅ | ✅ | - | - | - | - |
| questioning | - | - | - | - | ✅ | - | - | - |
| ready | - | - | - | - | - | ✅ | - | - |
| blocked | - | - | - | ✅ | - | - | - | - |
| running | - | - | - | - | - | - | ✅ | ✅ |

---

## 5. API 契约

### 5.1 创建协同会话

```
POST /api/collaboration/sessions
```

请求体：

```json
{
  "projectId": "project-id",
  "conversationId": "conversation-id",
  "entryMessageId": "optional-message-id",
  "orchestratorAgentId": "optional-agent-id"
}
```

响应体：

```json
{
  "id": "session-id",
  "projectId": "project-id",
  "conversationId": "conversation-id",
  "state": "discovery",
  "orchestratorAgentId": "director-agent-id",
  "roundCount": 0,
  "createdAt": "2026-05-12T10:00:00.000Z",
  "updatedAt": "2026-05-12T10:00:00.000Z"
}
```

### 5.2 查询协同会话

```
GET /api/collaboration/sessions/{id}
```

响应体：

```json
{
  "session": {
    "id": "session-id",
    "projectId": "project-id",
    "conversationId": "conversation-id",
    "state": "resolving_questions",
    "orchestratorAgentId": "director-agent-id",
    "roundCount": 3,
    "replyQueue": ["outline-agent-id", "script-agent-id"],
    "blockingQuestions": [
      {
        "assignmentId": "assignment-id",
        "agentId": "script-agent-id",
        "question": "大纲的核心反转是什么？",
        "targetAgentId": "outline-agent-id",
        "createdAt": "2026-05-12T10:01:00.000Z"
      }
    ],
    "admissionDecision": null,
    "loopStatus": null,
    "createdAt": "2026-05-12T10:00:00.000Z",
    "updatedAt": "2026-05-12T10:02:00.000Z"
  },
  "assignments": [
    {
      "id": "assignment-id",
      "sessionId": "session-id",
      "agentId": "outline-agent-id",
      "taskType": "outline_design",
      "goal": "设计大纲结构和核心反转",
      "status": "ready",
      "dependsOn": [],
      "blockingQuestionCount": 0
    }
  ]
}
```

### 5.3 编导分派

```
POST /api/collaboration/sessions/{id}/dispatch
```

请求体：

```json
{
  "assignments": [
    {
      "agentId": "outline-agent-id",
      "taskType": "outline_design",
      "goal": "设计大纲结构和核心反转",
      "dependsOn": []
    },
    {
      "agentId": "script-agent-id",
      "taskType": "script_design",
      "goal": "基于大纲编写剧本",
      "dependsOn": ["outline-agent-id"]
    }
  ]
}
```

响应体：

```json
{
  "dispatchedCount": 2,
  "assignments": [
    {
      "id": "assignment-1",
      "agentId": "outline-agent-id",
      "taskType": "outline_design",
      "status": "assigned"
    },
    {
      "id": "assignment-2",
      "agentId": "script-agent-id",
      "taskType": "script_design",
      "status": "assigned"
    }
  ]
}
```

### 5.4 发送协同消息

```
POST /api/collaboration/sessions/{id}/messages
```

请求体：

```json
{
  "sourceAgentId": "script-agent-id",
  "targetAgentId": "outline-agent-id",
  "messageKind": "question",
  "content": "大纲的核心反转是什么？我需要知道才能设计剧本节奏。",
  "questionFingerprint": "core-twist-clarification"
}
```

`messageKind` 枚举：

| 值 | 含义 |
|---|---|
| `assign` | 编导分派任务 |
| `question` | 智能体提问 |
| `answer` | 智能体回答 |
| `status` | 状态变更通知 |
| `escalation` | 升级给编导/默认助理/用户 |

### 5.5 循环检测

```
POST /api/collaboration/sessions/{id}/loop-check
```

响应体：

```json
{
  "loopDetected": true,
  "signals": ["high_fingerprint_repeat_rate", "no_state_change_in_recent_rounds"],
  "level": 2,
  "action": "escalate_to_director",
  "message": "检测到循环风险：最近 5 轮问题指纹重复率高且无状态变化，已升级给编导"
}
```

`level` 枚举：

| 级别 | 动作 |
|---|---|
| 0 | 无循环风险 |
| 1 | 生成循环风险提示，要求当前智能体改写为明确问题 |
| 2 | 升级给编导，由编导汇总冲突并重新拆解任务 |
| 3 | 升级给默认助理，请求用户裁决 |
| 4 | 标记会话为 halted |

### 5.6 入工作区

```
POST /api/collaboration/sessions/{id}/admit
```

响应体（成功）：

```json
{
  "admitted": true,
  "pipelineRunId": "run-id",
  "reason": "大纲智能体状态为 ready，关键依赖链无阻塞，编导确认入场"
}
```

响应体（拒绝）：

```json
{
  "admitted": false,
  "pipelineRunId": null,
  "reason": "大纲智能体仍有 1 个未解决的阻塞问题，无法入场",
  "blockingIssues": [
    {
      "assignmentId": "assignment-1",
      "agentId": "outline-agent-id",
      "question": "核心反转方向尚未确认",
      "status": "blocked"
    }
  ]
}
```

入场前提（全部满足才允许）：

1. 已创建 collaboration session
2. 编导已完成任务拆解
3. 关键依赖链上没有 blocked 状态
4. 大纲智能体状态为 ready
5. 编导明确给出 `admit_to_workspace = true`

### 5.7 暂停协同

```
POST /api/collaboration/sessions/{id}/halt
```

请求体：

```json
{
  "reason": "loop_detected",
  "detail": "连续 3 次循环检测命中，达到硬限制"
}
```

---

## 6. SSE 事件

新增 8 种协同事件，通过现有 `/api/ai/tasks/stream` 推送：

| 事件名 | 触发时机 | payload 关键字段 |
|---|---|---|
| `collaboration_session_created` | 创建协同会话 | sessionId, projectId, state |
| `collaboration_assignment_updated` | 任务卡状态变更 | sessionId, assignmentId, agentId, oldStatus, newStatus |
| `collaboration_queue_updated` | 回复队列变更 | sessionId, replyQueue |
| `collaboration_question_asked` | 智能体提问 | sessionId, sourceAgentId, targetAgentId, questionFingerprint |
| `collaboration_question_answered` | 智能体回答 | sessionId, sourceAgentId, targetAgentId, replyToMessageId |
| `collaboration_loop_warning` | 循环检测命中 | sessionId, level, signals |
| `collaboration_admission_changed` | 入工作区判定结果 | sessionId, admitted, pipelineRunId |
| `collaboration_workspace_started` | 工作区开始执行 | sessionId, pipelineRunId |

事件格式与现有 SSE 事件保持一致：

```
event: collaboration_assignment_updated
data: {
  "eventType": "collaboration_assignment_updated",
  "sessionId": "session-id",
  "assignmentId": "assignment-id",
  "agentId": "outline-agent-id",
  "oldStatus": "assigned",
  "newStatus": "ready"
}
```

---

## 7. 成熟度判断规则（首期）

默认助理在项目内对话中判断是否达到"协同启动阈值"。

### 7.1 必须满足的条件

| 条件 | 检测方式 |
|---|---|
| 题材/类型明确 | 消息中包含题材关键词（悬疑/喜剧/爱情/动作/科幻/现实/古装等） |
| 核心故事方向明确 | 消息中包含方向性描述（反转/成长/救赎/复仇/冒险等） |
| 目标受众明确 | 消息中包含受众描述（18-30岁/女性/青少年/全年龄等） |
| 体量约束明确 | 消息中包含体量描述（短剧/短视频/单集/多集/分钟数等） |

### 7.2 判断逻辑

```
function isReadyForCollaboration(messages: Message[]): boolean {
  const recentMessages = messages.slice(-10);
  const text = recentMessages.map(m => m.content).join(' ');

  const hasGenre = GENRE_KEYWORDS.some(kw => text.includes(kw));
  const hasDirection = DIRECTION_KEYWORDS.some(kw => text.includes(kw));
  const hasAudience = AUDIENCE_KEYWORDS.some(kw => text.includes(kw));
  const hasFormat = FORMAT_KEYWORDS.some(kw => text.includes(kw));

  return hasGenre && hasDirection && hasAudience && hasFormat;
}
```

### 7.3 触发方式

成熟度判断在**后端**执行，作为 AI 任务的后处理步骤。当默认助理的回复中包含特定标记（如 `[COLLABORATION_READY]`）时，后端自动创建协同会话。

首期简化方案：前端在用户发送消息后，后端在 AI 任务完成时检查最近对话是否满足成熟度条件。如果满足，在 assistant 回复末尾附加一个 `collaborationReady: true` 的 meta 标记，前端据此展示"启动协同"按钮，用户确认后调用 `POST /api/collaboration/sessions`。

---

## 8. 循环检测规则

### 8.1 检测频率

每累计 5 轮智能体对话（1 轮 = 一个智能体完成一次有效回复），执行一次循环检测。

### 8.2 检测信号

| 信号 | 判定条件 |
|---|---|
| 问题指纹重复率高 | 最近 5 轮中 ≥3 个 question_fingerprint 相同 |
| 无新增结构化约束 | 最近 5 轮没有新的 assignment 状态变为 ready |
| 无状态变化 | 最近 5 轮没有任何 assignment 状态迁移 |
| 来回转发 | 同一问题在两个智能体之间往返 ≥2 次 |
| 同义复述 | 最近 5 轮内容的 Jaccard 相似度 > 0.8 |

### 8.3 处置策略

| 级别 | 触发条件 | 动作 |
|---|---|---|
| Level 1 | 首次命中任一信号 | 生成循环风险提示，要求当前智能体改写为明确问题 |
| Level 2 | 连续第二次命中 | 升级给编导，由编导汇总冲突并重新拆解任务 |
| Level 3 | 连续第三次命中 | 升级给默认助理，请求用户裁决 |
| Level 4 | 超过阈值仍无解 | 标记会话为 halted |

### 8.4 硬限制

| 限制 | 值 |
|---|---|
| 同一问题最多追问次数 | 3 次 |
| 同一对智能体同一主题最多往返轮数 | 2 轮 |
| 单次协同会话最多自动讨论轮数 | 20 轮 |
| 达到上限后 | 必须请求用户决策或人工接管 |

---

## 9. 前端变更

### 9.1 新增文件

| 文件 | 用途 |
|---|---|
| `src/lib/serverApi.collaboration.ts` | 协同 API 调用 |
| `src/features/studio/components/chat/CollaborationStatus.tsx` | 协同状态标签 |
| `src/features/studio/components/chat/CollaborationAlert.tsx` | 循环风险告警条 |
| `src/features/studio/components/chat/CollaborationQueue.tsx` | 回复队列展示 |
| `src/features/studio/components/chat/CollaborationMessage.tsx` | 协同消息气泡 |

### 9.2 修改文件

| 文件 | 变更内容 |
|---|---|
| `src/types/index.ts` | 新增 `CollaborationSession`、`CollaborationAssignment`、`CollaborationMessage` 等类型 |
| `src/context/AppContext.tsx` | 新增协同会话状态管理 |
| `src/context/hooks/usePendingTaskSse.ts` | 处理新增的 8 种协同 SSE 事件 |
| `src/features/studio/components/chat/ChatArea.tsx` | 集成协同状态展示 |
| `src/features/studio/components/chat/ChatMessageGroupItem.tsx` | 区分协同消息和普通消息 |
| `src/features/studio/components/workspace/Workspace.tsx` | 协同入工作区时自动切换 tab |

### 9.3 UI 交互规格

**协同状态标签**：在对话区顶部显示当前协同状态，格式为：

```
🔵 协同准备中 | 🟡 正在解除阻塞 (2/5) | 🟢 已入工作区 | 🔴 已暂停
```

**协同消息气泡**：与普通消息气泡区分，左侧显示智能体头像和名称，右上角显示意图标签（分派/提问/回答/确认）。

**回复队列**：在对话区右侧或底部显示当前发言队列，格式为：

```
发言队列：大纲 → 剧本 → 编导
```

**循环风险告警**：对话区顶部显示红色告警条，格式为：

```
⚠️ 循环风险检测：大纲和剧本之间已往返 2 次同一问题，建议用户裁决
```

---

## 10. 后端模块结构

```
server/src/collaboration/
├── mod.rs           模块声明与导出
├── model.rs         数据模型 + 状态机
├── repo.rs          数据库操作
├── handlers.rs      API handler
├── dispatcher.rs    编导分派器
├── queue.rs         回复队列管理
└── loop_detector.rs 循环检测
```

### 10.1 与现有模块的集成点

| 集成点 | 现有模块 | 协同模块 | 集成方式 |
|---|---|---|---|
| AI 任务创建 | `ai/runtime.rs` | `collaboration/dispatcher.rs` | 每个 assignment 创建一个 ai_task |
| SSE 事件推送 | `ai/runtime.rs` | `collaboration/handlers.rs` | 复用现有 broadcast channel |
| Pipeline 创建 | `pipeline/handlers.rs` | `collaboration/handlers.rs` | admit 时调用 pipeline create |
| 路由注册 | `main.rs` | `collaboration/mod.rs` | 新增 `/api/collaboration/*` 路由组 |

---

## 11. 验收标准

### 11.1 功能验收

| 编号 | 验收项 | 通过条件 |
|---|---|---|
| AC-1 | 默认助理可判断成熟度 | 用户给出包含题材/方向/受众/体量的创意后，系统提示可启动协同 |
| AC-2 | 编导可分派任务 | 编导自动创建大纲和剧本 assignment |
| AC-3 | 智能体可上游追问 | 剧本可向大纲发问并得到顺序回复 |
| AC-4 | 阻塞可解除 | 大纲回答后，剧本状态从 blocked → ready |
| AC-5 | 自动入工作区 | 大纲无阻塞时，系统自动创建 Outline pipeline run |
| AC-6 | 不误入工作区 | 仍有阻塞时，系统继续停留在对话区 |
| AC-7 | 循环检测生效 | 每 5 轮触发检测，达到阈值后暂停 |
| AC-8 | 刷新可恢复 | 页面刷新后协同会话与队列可恢复 |

### 11.2 稳定性验收

| 编号 | 验收项 | 通过条件 |
|---|---|---|
| SAC-1 | 无并发抢答 | 不存在同一时刻多个智能体同时发言 |
| SAC-2 | 入场决策可解释 | 所有 admit/halt 决策都有事件留痕 |
| SAC-3 | 服务重启可恢复 | 未完成协同会话可从数据库恢复状态 |

---

## 12. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 成熟度规则误判 | 中 | 用户在不该启动协同时被触发 | 首期用"用户确认"按钮兜底，不自动启动 |
| 智能体回复格式不稳定 | 高 | question_fingerprint 提取失败 | fingerprint 用简单哈希，容错解析 |
| 循环检测误报 | 中 | 正常讨论被误判为循环 | Level 1 只提示不阻断，给智能体改写机会 |
| 协同消息与用户消息混淆 | 低 | 用户看到不该看的内部讨论 | 协同消息独立存储，前端按 messageKind 过滤展示 |
| ai_task 与 assignment 状态不同步 | 中 | 任务完成但 assignment 未更新 | 编导分派器监听 ai_task SSE 事件，自动同步 |

---

## 13. 开发顺序

```
阶段 0 ──→ 阶段 1 ──→ 阶段 2 ──→ 阶段 3
  │           │           │           │
  │           │           │           └─ 前端联调
  │           │           └─ 核心逻辑（最复杂）
  │           └─ 数据模型 + API（后端独立）
  └─ 基线收口（前置条件）
```

阶段间严格串行，阶段内任务可并行。阶段 2 是关键路径，预计占整体工作量的 40%。
