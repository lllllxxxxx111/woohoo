# Woohoo 协同创作系统 -- v1.0.0 MVP 审查报告

审查人：MVP-FREEZE-ARCHITECT
日期：2026-05-12
审查对象：
- `docs/collaboration-ultimate-goal-prd.md`（最终目标 PRD）
- `docs/collaboration-v1.0.0-dev-prd.md`（v1.0.0 开发 PRD）
- `docs/collaboration-session-implementation-prd.md`（实施级 PRD）

---

## 0. 核心生存链路

```
[用户输入创意并启动协同] -> [智能体讨论消除阻塞] -> [大纲入工作区]
```

V1 仅支持：用户通过关键词触发成熟度 -> 点击启动 -> 编导分派 -> 智能体按队列讨论 -> 大纲就绪后自动创建 pipeline_run 并跳转工作区。

V1 不做任何其他事。

---

## 1. 第一动作验证

### 1.1 第一动作定义

最终目标 PRD 明确定义了第一动作：

> 用户在项目对话区输入创作意图 -> 系统识别成熟度 -> 启动多智能体协同 -> 自动步入工作区执行

v1.0.0 PRD 的一句话目标：

> 端到端打通，让用户能完整走通一次"对话 -> 协同 -> 入工作区"流程

两者对齐，方向正确。

### 1.2 偏离检测

逐项检查 v1.0.0 的 12 个任务是否服务于"用户第一次成功完成协同创作"：

| 任务 | 是否服务第一动作 | 判定 |
|---|---|---|
| A1: SSE 广播修复 | 是。前端看不到协同事件则闭环断裂 | 必须 |
| A2: ai_task 关联修复 | 是。智能体不执行则协同无法推进 | 必须 |
| A3: admit 创建 pipeline_run | 是。入工作区是闭环终点 | 必须 |
| A4: 服务重启恢复 | 否。这是生产稳定性需求，不影响用户第一次走通 | **偏离** |
| A5: 硬限制强制阻断 | 部分。20轮上限是安全网，但3次追问/2轮往返限制是防御性设计 | **部分偏离** |
| A6: Jaccard 检测 | 否。最终目标 PRD 的 Not-To-Do 明确写了"M1 阶段实现 Jaccard 同义复述检测"应延后 | **偏离** |
| B1: 成熟度判断(后端) | 是。这是用户进入协同的入口 | 必须 |
| B2: 成熟度判断(前端) | 是。用户必须能触发协同 | 必须 |
| B3: CollaborationMessage 集成 | 是。用户必须看到智能体在做什么 | 必须 |
| B4: 前端刷新恢复 | 部分。刷新后重新拉取即可，不需要独立 API | **可简化** |
| B5: CollaborationQueue 组件 | 否。CollaborationStatus 已展示队列信息，独立组件是 UI 优化 | **偏离** |
| B6: 工作区联动跳转 | 是。闭环终点必须有可见结果 | 必须 |

**结论：12 个任务中有 3 个偏离第一动作（A4、A6、B5），2 个部分偏离（A5、B4）。**

---

## 2. 过度设计检测

### 2.1 投机性设计清单

| 任务 | 过度设计原因 | 严重程度 |
|---|---|---|
| A4: 服务重启恢复 | 为"服务可能在协同过程中重启"这个低概率场景设计了一个完整的恢复模块（restore.rs），包含遍历活跃会话、同步 ai_task 状态、推进会话状态等逻辑。MVP 阶段重启后用户重新开始即可。 | 高 |
| A6: Jaccard 检测 | 最终目标 PRD 的 Not-To-Do List 第6条明确写了"M1 阶段实现 Jaccard 同义复述检测"应延后。v1.0.0 PRD 以"简化版"名义重新引入，属于范围蔓延。且 bigram 对中文效果差，PRD 自己也承认"风险：Jaccard bigram 对中文检测效果不佳"。 | 高 |
| A5: 硬限制（完整版） | 3 层硬限制（同一问题3次/同一对智能体2轮/总计20轮）+ fingerprint 统计函数。MVP 只需要"20轮上限"作为安全网即可，其余是精细化管控。 | 中 |
| B5: CollaborationQueue 组件 | CollaborationStatus.tsx 已经在标签中展示发言队列（`发言队列：{replyQueue.join(' -> ')}`），新建独立组件是重复功能。 | 中 |
| B4: 前端刷新恢复（完整版） | 设计了独立 API `GET /api/collaboration/sessions/active` + 专用 handler + repo 函数。实际上只需在 ChatArea mount 时调用已有的 `getCollaborationSession` 即可恢复。 | 低 |

### 2.2 复杂度溢出检测

| 任务 | 引入的新状态变更数 | 是否超过3个 | 判定 |
|---|---|---|---|
| A4: 服务重启恢复 | 遍历会话 -> 恢复队列 -> 同步 ai_task -> 更新 assignment -> 推进 session | 是（5个） | DEFERRED |
| A5: 硬限制（完整版） | fingerprint 统计 -> 追问计数 -> 升级编导 -> 往返计数 -> 循环检测 -> halted | 是（6个） | 简化 |
| A6: Jaccard 检测 | 分词 -> bigram -> Jaccard 计算 -> 信号触发 -> 等级提升 | 是（5个） | DEFERRED |

---

## 3. 最小闭环分析

### 3.1 真正的最小功能集

让用户走通一次协同创作，需要且仅需要以下功能：

```
1. 用户输入创意 -> 系统标记成熟 -> 用户点击启动
2. 编导分派任务卡 -> 智能体按队列讨论 -> 阻塞解除
3. 大纲就绪 -> 自动创建 pipeline_run -> 跳转工作区
```

对应的技术动作：

| 步骤 | 技术动作 | 依赖 |
|---|---|---|
| 成熟度标记 | 关键词检测 + meta 标记 | 无 |
| 启动协同 | POST /sessions + 前端按钮 | 成熟度标记 |
| 编导分派 | dispatch + ai_task 创建 | SSE 广播 |
| 智能体讨论 | question/answer + 队列管理 | ai_task 关联 |
| 阻塞解除 | assignment 状态推进 | 无 |
| 入工作区 | admit + pipeline_run 创建 | ai_task 完成 |
| 前端可见 | SSE 事件 + 协同消息渲染 | SSE 广播 |
| 结果跳转 | workspace_started 事件 + tab 切换 | pipeline_run |

### 3.2 当前 v1.0.0 范围对比

| 最小集功能 | v1.0.0 是否覆盖 | 是否有超出 |
|---|---|---|
| SSE 广播 | A1 覆盖 | 无 |
| ai_task 关联 | A2 覆盖 | 无 |
| admit 创建 pipeline_run | A3 覆盖 | 无 |
| 成熟度判断 | B1+B2 覆盖 | 无 |
| 协同消息渲染 | B3 覆盖 | 无 |
| 工作区跳转 | B6 覆盖 | 无 |
| 服务重启恢复 | A4 | **超出** |
| Jaccard 检测 | A6 | **超出** |
| 硬限制（完整版） | A5 | **部分超出** |
| 刷新恢复（完整版） | B4 | **部分超出** |
| CollaborationQueue | B5 | **超出** |

**结论：v1.0.0 范围超出最小集约 30%。3 个任务完全超出（A4、A6、B5），2 个任务部分超出（A5、B4）。**

---

## 4. 精简建议

### 4.1 任务裁决

| 编号 | 任务 | 裁决 | 理由 |
|---|---|---|---|
| A1 | SSE 广播修复 | **必须做** | 前端看不到事件则闭环断裂，无替代方案 |
| A2 | ai_task 关联修复 | **必须做** | 智能体不执行则协同无法推进，无替代方案 |
| A3 | admit 创建 pipeline_run | **必须做** | 入工作区是闭环终点，无替代方案 |
| A4 | 服务重启恢复 | **应延后** | 生产稳定性需求，不影响用户第一次走通。重启后用户重新开始即可。延后至 M2 |
| A5 | 硬限制强制阻断 | **可简化** | 仅保留"20轮上限自动 halted"，删除同一问题3次限制和同一对智能体2轮限制。后者需要新增 repo 函数 `get_question_count_by_fingerprint`，增加复杂度但 MVP 阶段价值有限 |
| A6 | Jaccard 检测 | **应延后** | 最终目标 PRD Not-To-Do 明确标记延后。bigram 对中文效果差，属于增量优化。延后至 M2 |
| B1 | 成熟度判断(后端) | **必须做** | 用户进入协同的入口 |
| B2 | 成熟度判断(前端) | **必须做** | 用户触发协同的交互 |
| B3 | CollaborationMessage 集成 | **必须做** | 用户必须看到智能体在做什么 |
| B4 | 前端刷新恢复 | **可简化** | 不需要新增独立 API。只需在 ChatArea mount 时用已有的 `getCollaborationSession` 拉取当前会话状态写入 store 即可。删除 `GET /api/collaboration/sessions/active` 和对应的 handler/repo 函数 |
| B5 | CollaborationQueue 组件 | **应延后** | CollaborationStatus.tsx 已展示队列信息。独立组件是 UI 优化，延后至 M2 |
| B6 | 工作区联动跳转 | **必须做** | 闭环终点必须有可见结果 |

### 4.2 精简后的 V1 冻结决议

V1 仅做以下 7 项：

1. SSE 广播修复（A1）
2. ai_task 关联修复（A2）
3. admit 创建 pipeline_run（A3）
4. 成熟度判断 - 后端 + 前端（B1 + B2）
5. CollaborationMessage 集成（B3）
6. 工作区联动跳转（B6）
7. 硬限制简化版 - 仅20轮上限（A5-simplified）
8. 刷新恢复简化版 - mount 时重拉（B4-simplified）

V1 不做任何其他事。

### 4.3 DEFERRED 清单

- 服务重启恢复（A4）-- 延后至 M2
- Jaccard 同义复述检测（A6）-- 延后至 M2
- CollaborationQueue 独立组件（B5）-- 延后至 M2
- 硬限制中的同一问题3次追问限制 -- 延后至 M2
- 硬限制中的同一对智能体2轮往返限制 -- 延后至 M2
- 前端刷新恢复的独立 API（GET /sessions/active）-- 延后至 M2
- repo::get_question_count_by_fingerprint 函数 -- 延后至 M2
- restore.rs 模块 -- 延后至 M2

---

## 5. 开发顺序优化

### 5.1 当前顺序的问题

当前顺序：`A1 -> A2 -> A5 -> A6 -> A3 -> A4 -> B1 -> B2 -> B3 -> B4 -> B5 -> B6`

问题：

1. **A3（admit 创建 pipeline_run）排在第5位**，但它是闭环终点，应尽早验证
2. **A4（服务重启恢复）排在 A3 之前**，但 A4 是生产需求不是闭环需求
3. **A6（Jaccard）排在 A3 之前**，但 A6 是增量优化不是闭环需求
4. **B6（工作区跳转）排在最后**，但它是用户看到结果的最后一步，应紧跟 B3

### 5.2 优化后的开发顺序

```
Phase 1: 后端管道修复（闭环骨架）
  P1-1. SSE 广播修复 (A1) ─────────── 独立，最先做
  P1-2. ai_task 关联修复 (A2) ─────── 独立，与 P1-1 可并行
  P1-3. admit 创建 pipeline_run (A3) ── 依赖 P1-2

Phase 2: 入口 + 可见性（闭环打通）
  P2-1. 成熟度判断后端 (B1) ────────── 独立
  P2-2. 成熟度判断前端 (B2) ────────── 依赖 P2-1 + P1-1
  P2-3. CollaborationMessage 集成 (B3) ── 依赖 P1-1
  P2-4. 工作区联动跳转 (B6) ────────── 依赖 P1-3

Phase 3: 安全网（闭环加固）
  P3-1. 硬限制简化版 (A5-simplified) ── 仅20轮上限，独立
  P3-2. 刷新恢复简化版 (B4-simplified) ── 依赖 P2-3
```

**推荐执行顺序**：

```
P1-1 -> P1-2 -> P1-3 -> P2-1 -> P2-2 -> P2-3 -> P2-4 -> P3-1 -> P3-2
```

### 5.3 优化理由

| 优化点 | 原顺序 | 优化后 | 理由 |
|---|---|---|---|
| admit 提前 | 第5位 | 第3位 | 闭环终点尽早验证，后端管道修复完成后立即验证入工作区 |
| 删除 A4/A6 | 第4/6位 | 删除 | 不属于闭环，延后至 M2 |
| B6 提前 | 第12位 | 第7位 | 闭环终点必须有可见结果，紧跟 B3 |
| 安全网后置 | A5 第3位 | P3-1 第8位 | 安全网不是闭环必需，放在闭环打通后加固 |

### 5.4 里程碑调整

**M1-Alpha：后端闭环（Phase 1 完成）**

- SSE 事件广播链路打通
- ai_task 正确关联 assignment
- admit 正确创建 pipeline_run

验收方式：curl 端到端测试，从创建会话到 pipeline_run 生成

**M1-Beta：前端闭环（Phase 2 完成）**

- 成熟度判断 + 启动按钮
- 协同消息在对话区渲染
- 工作区联动跳转

验收方式：手动端到端测试 -- 从输入创意到大纲入工作区完整走通

**M1-RC：加固（Phase 3 完成）**

- 20轮硬限制
- 刷新恢复

验收方式：边界场景测试

---

## 6. 代码库现状确认

通过代码审查确认以下已实现/未实现状态：

| 模块 | 状态 | 说明 |
|---|---|---|
| collaboration/mod.rs | 已实现 | 模块注册 |
| collaboration/model.rs | 已实现 | 数据模型 + 状态机 + 请求/响应类型 |
| collaboration/repo.rs | 已实现 | CRUD 操作，但缺少 `list_active_sessions`、`get_question_count_by_fingerprint` |
| collaboration/handlers.rs | 已实现 | 7 个 API handler，但 admit 不创建 pipeline_run，无 get_messages/get_active_session handler |
| collaboration/dispatcher.rs | 已实现 | 分派/提问/回答逻辑，但不创建 ai_task |
| collaboration/queue.rs | 已实现 | 回复队列管理 |
| collaboration/loop_detector.rs | 已实现 | 指纹重复/无状态变化/来回转发检测，无 Jaccard |
| collaboration/restore.rs | 未实现 | v1.0.0 PRD 要求新增，但本审查建议延后 |
| collaboration/readiness.rs | 未实现 | 成熟度判断模块 |
| 前端 SSE 事件处理 | 已实现 | usePendingTaskSse.ts 已处理 8 种协同事件 |
| 前端 API 客户端 | 已实现 | serverApi.collaboration.ts 已有 7 个 API |
| 前端 Store | 已实现 | Zustand store 已有协同状态管理 |
| CollaborationStatus.tsx | 已实现 | 状态标签 + 队列展示 |
| CollaborationMessage.tsx | 已实现 | 协同消息气泡 |
| CollaborationAlert.tsx | 已实现 | 循环风险告警 |
| CollaborationQueue.tsx | 未实现 | v1.0.0 PRD 要求新增，但本审查建议延后 |

**关键缺口确认**：
1. `repo::create_event()` 只写 DB 不广播 SSE -- 确认存在
2. `dispatcher::dispatch_assignments()` 不创建 ai_task -- 确认存在
3. `handlers::admit()` 不创建 pipeline_run，`pipeline_run_id` 始终为 None -- 确认存在
4. 无成熟度判断模块 -- 确认存在
5. CollaborationMessage.tsx 未集成到 ChatMessageGroupItem.tsx -- 确认存在

---

## 7. 风险评估

### 7.1 精简后的风险

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 无服务重启恢复，重启后协同中断 | 低 | 中 | MVP 可接受，用户重新开始。M2 补齐 |
| 无 Jaccard 检测，同义复述循环可能漏检 | 中 | 低 | 已有指纹重复检测兜底，Jaccard 是增量优化 |
| 无 CollaborationQueue 独立组件，队列展示较简陋 | 低 | 低 | CollaborationStatus 已展示队列文本，M2 优化 |
| 硬限制仅20轮上限，无精细管控 | 中 | 低 | 20轮上限足以防止无限循环，精细管控 M2 补齐 |
| 刷新恢复仅重拉会话，不恢复 SSE 事件流 | 低 | 中 | SSE 重连后自动接收新事件，历史事件通过重拉补偿 |

### 7.2 不精简的风险

| 风险 | 概率 | 影响 |
|---|---|---|
| 12 个任务全部完成需要 12 个工作日，超出 MVP 时间窗口 | 高 | 延迟交付 |
| A4/A6 引入新模块和复杂逻辑，增加测试负担 | 中 | 质量风险 |
| Jaccard bigram 对中文效果差，实现后可能需要重写 | 高 | 返工 |

---

## 8. 最终裁决

### V1 冻结决议

V1 仅支持：用户通过关键词触发成熟度 -> 点击启动协同 -> 编导分派任务 -> 智能体按队列讨论 -> 大纲就绪后自动创建 pipeline_run 并跳转工作区。

V1 不做任何其他事。

### 任务清单（9 项，原 12 项精简 25%）

| 编号 | 任务 | 裁决 | 预估工时 |
|---|---|---|---|
| P1-1 | SSE 广播修复 | 必须做 | 1d |
| P1-2 | ai_task 关联修复 | 必须做 | 1d |
| P1-3 | admit 创建 pipeline_run | 必须做 | 1d |
| P2-1 | 成熟度判断(后端) | 必须做 | 1d |
| P2-2 | 成熟度判断(前端) | 必须做 | 0.5d |
| P2-3 | CollaborationMessage 集成 | 必须做 | 1d |
| P2-4 | 工作区联动跳转 | 必须做 | 0.5d |
| P3-1 | 硬限制简化版(仅20轮上限) | 可简化 | 0.5d |
| P3-2 | 刷新恢复简化版(mount重拉) | 可简化 | 0.5d |

**总预估：7 个工作日**（原计划 12 个工作日，精简 42%）

### DEFERRED 清单

- 服务重启恢复（restore.rs 模块）-- M2
- Jaccard 同义复述检测（loop_detector.rs 扩展）-- M2
- CollaborationQueue 独立组件 -- M2
- 硬限制中的同一问题3次追问限制 -- M2
- 硬限制中的同一对智能体2轮往返限制 -- M2
- 前端刷新恢复的独立 API -- M2
- repo::get_question_count_by_fingerprint -- M2
- repo::list_active_sessions -- M2
