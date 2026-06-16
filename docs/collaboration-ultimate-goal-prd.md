# Woohoo 协同创作系统 -- 最终目标 PRD

版本：v1.0
日期：2026-05-12
状态：已定稿

---

## 1. Project DNA

**一句话定义**：用户用自然语言说出创作想法，AI 智能体团队自动协同补齐信息、消除分歧、产出结构化内容，从一句话到一个可执行的短剧/短视频方案。

**价值锚点**：将"创意到成品"的链路从人工串联多工具，压缩为一次对话驱动的自动编排。

**第一动作**：用户在项目对话区输入创作意图 -> 系统识别成熟度 -> 启动多智能体协同 -> 自动步入工作区执行。

---

## 2. 核心价值主张与差异化

### 2.1 核心价值

| 价值维度 | 具体表现 |
|---|---|
| 创作门槛降低 | 用户只需自然语言描述想法，无需理解大纲/剧本/分镜的结构化要求 |
| 信息自动收敛 | 智能体之间自动追问补齐，而非用户逐项手动填写表单 |
| 讨论到执行无缝衔接 | 协同讨论收敛后自动步入工作区，无需手动切换和搬运 |
| 循环自愈 | 系统自动检测智能体间的无效循环，逐级升级直到用户裁决 |

### 2.2 差异化

| 对比维度 | 传统 AI 写作工具 | Woohoo |
|---|---|---|
| 智能体协作模式 | 单体对话，用户手动切换角色 | 多智能体按依赖链协同，自动追问上下游 |
| 信息补齐方式 | 用户主动提供或填表 | 智能体主动提问，系统判断成熟度 |
| 讨论到执行 | 复制粘贴到另一个工具 | 协同收敛后自动创建 pipeline run |
| 循环处理 | 无检测，用户自行判断卡住 | 规则 + LLM 混合检测，逐级升级 |

---

## 3. 完整用户旅程

```
用户打开应用
  |
  v
[1] 创建/选择项目
  |
  v
[2] 在对话区输入创作想法（如"我想做一个悬疑反转短剧"）
  |
  v
[3] 默认助理与用户对话，补齐关键约束
    - 题材/类型
    - 核心故事方向
    - 目标受众
    - 体量约束
  |
  v
[4] 系统判断成熟度达标 -> 展示"启动协同创作"按钮
  |
  v
[5] 用户确认 -> 编导智能体分派任务卡
    - @大纲：设计故事结构和核心反转
    - @剧本：基于大纲编写剧本（依赖大纲）
  |
  v
[6] 智能体按回复队列顺序发言
    - 大纲智能体产出初版
    - 剧本智能体发现信息不足 -> 向大纲提问
    - 大纲回答 -> 剧本状态从 blocked -> ready
  |
  v
[7] 循环检测（每5轮）
    - Level 1: 提示智能体改写
    - Level 2: 升级编导重新拆解
    - Level 3: 请求用户裁决
    - Level 4: 暂停会话
  |
  v
[8] 关键依赖链无阻塞 -> 自动入场判定
    - 创建 Outline pipeline run
    - 自动跳转工作区
  |
  v
[9] 工作区执行：大纲 -> 剧本 -> 章节 -> 分镜 -> 视频
  |
  v
[10] 协同完成，用户在对话区继续迭代或发起新一轮协同
```

---

## 4. 功能全景图（M1 -> M2 -> M3 演进路线）

### M1：端到端打通（v1.0.0）

**目标**：用户能完整走通一次"对话 -> 协同 -> 入工作区"流程。

| 功能域 | 功能点 | 状态 |
|---|---|---|
| 成熟度判断 | 规则关键词检测（题材/方向/受众/体量） | 待修复 |
| 协同启动 | 用户确认按钮触发创建会话 | 待实现 |
| 编导分派 | 创建 assignment + 关联 ai_task | 待修复 |
| 智能体对话 | 回复队列管理、上游追问、阻塞解除 | 已完成 |
| 循环检测 | 指纹重复/无状态变化/来回转发 | 已完成（缺 Jaccard） |
| 入工作区 | admit 创建 pipeline_run | 待修复 |
| SSE 实时推送 | 8 种协同事件广播到前端 | 待修复 |
| 前端展示 | 状态标签/告警/消息气泡/刷新恢复 | 待修复 |
| 硬限制 | 同一问题3次/同一对智能体2轮/总计20轮 | 待实现 |

### M2：全流程编排

**目标**：从大纲扩展到剧本/章节/分镜/视频全链路自动编排。

| 功能域 | 功能点 |
|---|---|
| 全流程 pipeline | Script -> Chapters -> Keyframe -> Video 自动编排 |
| 多阶段协同 | 大纲完成后自动触发剧本协同，而非手动 |
| LLM 成熟度判断 | 替代规则关键词，由 LLM 自主判断信息是否充分 |
| LLM 循环检测 | 补充 Jaccard 同义复述检测 |
| 协同消息摘要 | 长讨论自动摘要，避免上下文溢出 |
| 智能体自由组合 | 用户可自定义参与协同的智能体组合 |
| 协同历史回放 | 查看历史协同会话的完整讨论过程 |

### M3：智能增强

**目标**：从"编排工具"进化为"创作伙伴"。

| 功能域 | 功能点 |
|---|---|
| 主动建议 | 编导主动发现创意矛盾并建议修改方向 |
| 多方案对比 | 同一创意生成多个大纲方案，用户选择 |
| 知识库增强 | 智能体参考项目内已有素材和历史创作 |
| 协同模板 | 预设"悬疑短剧""校园爱情"等创作模板 |
| 实时协作 | 多用户同时参与协同讨论 |
| 跨项目迁移 | 将一个项目的协同经验迁移到新项目 |

---

## 5. 数据模型（最终形态）

```
CollaborationSession
  ├── id, user_id, project_id, conversation_id
  ├── state: discovery | delegating | resolving_questions | workspace_admission | workspace_execution | completed | halted
  ├── orchestrator_agent_id
  ├── reply_queue_json        -- 回复队列
  ├── admission_decision_json -- 入场决策
  ├── loop_status_json        -- 循环检测状态
  ├── round_count             -- 当前轮次
  └── timestamps

CollaborationAssignment
  ├── id, session_id, agent_id
  ├── task_type: outline_design | script_design | chapter_design | keyframe_design | video_design
  ├── goal, input_json
  ├── depends_on_json          -- 依赖的其他 assignment
  ├── status: idle | assigned | questioning | ready | running | blocked | done | failed
  ├── blocking_question_count
  ├── last_question_fingerprint
  ├── ai_task_id               -- 关联的 AI 异步任务
  └── timestamps

CollaborationMessage
  ├── id, session_id
  ├── source_agent_id, target_agent_id
  ├── message_kind: assign | question | answer | status | escalation
  ├── content
  ├── question_fingerprint
  ├── reply_to_message_id
  ├── queue_order
  └── created_at

CollaborationEvent
  ├── id, session_id
  ├── event_type               -- 8 种 SSE 事件
  ├── payload_json
  └── created_at
```

---

## 6. 状态机（最终形态）

### 6.1 协同会话状态

```
discovery -> delegating -> resolving_questions -> workspace_admission -> workspace_execution -> completed
    |            |                 |                      |
    |            |                 |                      +-> halted
    |            |                 +-> halted
    |            +-> halted
    +-> halted
                                              halted -> discovery（用户裁决后恢复）
```

### 6.2 任务卡状态

```
idle -> assigned -> questioning -> blocked -> ready -> running -> done
                 |                  ^         |
                 +-> ready ---------+         +-> failed
```

---

## 7. 成功指标

### 7.1 M1 核心指标

| 指标 | 目标值 | 度量方式 |
|---|---|---|
| 端到端完成率 | >= 80% | 用户从输入创意到大纲入工作区的完成比例 |
| 协同启动准确率 | >= 70% | 成熟度判断正确触发协同的比例（非误触/漏触） |
| 循环检测命中率 | >= 60% | 检测到真实循环的比例（非误报） |
| 刷新恢复成功率 | 100% | 页面刷新后协同状态完整恢复 |

### 7.2 M2 核心指标

| 指标 | 目标值 |
|---|---|
| 全流程自动完成率 | >= 50%（大纲到视频无需人工干预） |
| 智能体追问解决率 | >= 80%（追问后状态从 blocked -> ready） |
| 平均协同轮次 | <= 10 轮（从启动到入工作区） |

### 7.3 M3 核心指标

| 指标 | 目标值 |
|---|---|
| 用户满意度 | NPS >= 40 |
| 创作效率提升 | 从创意到大纲的时间缩短 60% |
| 协同模板使用率 | >= 40% 的新协同使用模板启动 |

---

## 8. Not-To-Do List（跨版本边界警示）

| 禁止项 | 理由 |
|---|---|
| 任意智能体自由群聊 | 破坏依赖链和回复队列，导致上下文混乱 |
| 全局聊天场景的自动协同 | 全局聊天无项目上下文，协同无法关联 pipeline |
| 分布式多实例协同调度 | 架构复杂度远超当前需求，单实例足够 |
| 协同消息写入 messages 表 | 协同消息是智能体间通信，非面向用户，独立存储避免混淆 |
| M1 阶段使用 LLM 做成熟度判断 | 规则方案可验证，LLM 方案需额外工程，留到 M2 |
| M1 阶段实现 Jaccard 同义复述检测 | 指纹重复率检测已覆盖核心场景，Jaccard 是增量优化 |
