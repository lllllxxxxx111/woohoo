# 多智能体全自动协同编排规划书（Beta）

> 历史设计参考（更新时间：2026-08-24）。当前 `server/src/pipeline/orchestrator.rs` 已提供流水线编排、依赖推进、审核闸门、重试和恢复失败收敛；本文中的“关键差距”描述的是当时的规划基线，不应作为当前能力清单或发布阻断依据。封闭 Beta 当前执行基线请参阅 [`closed-beta-stabilization-prd-v1.2.md`](prd/closed-beta-stabilization/v1.2/closed-beta-stabilization-prd-v1.2.md)。

## 1. 目标与范围

### 1.1 目标

在现有 Woohoo 聊天与任务系统上，落地一套“全自动、多智能体协同”的流程编排能力，实现：

1. 任务发出后异步待命，不阻塞用户等待。
2. 严格前置依赖：必须完成前序步骤，后续步骤才可执行。
3. 设计智能体与审核智能体形成闭环（设计 -> 审核 -> 通过/退回）。
4. 审核失败自动重试，达到阈值后人工介入或流程失败收敛。
5. 每个流程阶段结束后，自动分析“设计-审核”对话并优化两侧 Prompt。
6. 该优化功能初始以 Beta 开关在设置中控制，默认关闭。

### 1.2 不在本期范围

1. 全局自动改写所有历史 Prompt。
2. 多租户跨项目资源共享策略重构。
3. UI 大改版（本期仅新增必要控制位和状态可视化）。

## 2. 当前现状与核心差距

### 2.1 已有能力

1. 聊天任务异步执行、任务队列、任务取消、SSE 状态推送已具备。
2. workflow guard 的确认机制已存在，可用于“确认继续”。
3. 智能体有项目内分配与角色字段，可传入单次任务上下文。
4. pipeline 相关 API 已有基础 CRUD 和控制接口。

### 2.2 历史差距与当前状态

以下四项是本文形成时的规划差距；前 3 项已在当前主线实现，最后 1 项仍按 Beta 的建议模式推进：

1. 自动推进编排器：已由 `Pipeline Orchestrator` 定时扫描并推进可执行步骤。
2. pipeline 执行引擎：已具备 AI task 创建、结果回写、失败收敛和事件记录。
3. 步骤依赖与审核闸门：已具备统一状态转换、审核结果解析和重试/人工处理路径。
4. Prompt 优化闭环：仍默认只生成建议，由人工确认后应用，不自动改变系统策略。

## 3. 目标流程（端到端）

## 3.1 标准流程阶段

1. 大纲设计（Design）
2. 大纲审核（Review）
3. 剧本设计（Design）
4. 剧本审核（Review）
5. 章节拆分（Design）
6. 分镜/关键帧设计（Design）
7. 分镜审核（Review）
8. 视频提示词与生成任务（Design）
9. 终审与发布前检查（Review）

### 3.2 每阶段执行规则

1. Design 步骤只产出草案与结构化结果。
2. Review 步骤必须输出结构化结论：
   - `decision: pass | fail`
   - `issues: []`
   - `retryHints: []`
3. `pass` 才能推进下一阶段。
4. `fail` 则回退到最近对应 Design 步骤，带审查意见重试。

## 4. 编排状态机设计

### 4.1 Run 级状态

1. `queued`
2. `running`
3. `paused`
4. `failed`
5. `completed`
6. `cancelled`

### 4.2 Step 级状态

1. `queued`：已创建，待依赖满足
2. `blocked`：依赖未满足
3. `ready`：依赖满足，待调度
4. `running_design`
5. `running_review`
6. `passed`
7. `retrying`
8. `failed`
9. `skipped`

### 4.3 状态迁移规则（核心）

1. `blocked -> ready`：所有 `dependsOn` 步骤状态为 `passed`
2. `ready -> running_design/review`：编排器拿到执行权并创建 AI 任务
3. `running_review -> passed`：解析审核结论 `decision=pass`
4. `running_review -> retrying`：`decision=fail` 且 `retryCount < maxRetries`
5. `retrying -> running_design`：带上 `retryHints` 重跑 Design
6. 达到重试上限后 `retrying -> failed`

## 5. 系统架构方案

### 5.1 组件拆分

1. `Pipeline Orchestrator`（新增）
   - 监听 pipeline 事件与 AI task 状态
   - 计算可执行步骤并调度
2. `Dependency Resolver`（新增）
   - 校验 `dependsOn`、生成 `ready` 队列
3. `Step Executor`（新增）
   - 按步骤类型构建 prompt、选择智能体并发起任务
4. `Review Gate`（新增）
   - 解析审核输出，决定 `pass/fail/retry`
5. `Retry Engine`（新增）
   - 负责重试策略（指数退避、最大次数、原因聚合）
6. `Prompt Optimizer`（新增，Beta）
   - 分析设计-审核对话，产出下一轮 prompt patch

### 5.2 运行方式

1. 事件驱动优先，轮询兜底。
2. 任务触发后立即返回 runId，不阻塞前端。
3. 编排器可多实例，但同一 run 通过乐观锁/版本号保证单执行者。

## 6. 数据模型与存储规划

### 6.1 新增/扩展表

1. `pipeline_run_steps`
   - 新增 `depends_on_json`
   - 新增 `step_type`（design/review/system）
   - 新增 `review_policy_json`
   - 新增 `retry_of_step_id`
2. `pipeline_step_outputs`（新增）
   - 持久化步骤结构化产出、审核结果、错误原因
3. `pipeline_prompt_optimizations`（新增）
   - 存设计/审核 prompt patch
   - 记录来源对话、应用范围、得分
4. `user_feature_flags`（新增或并入 settings）
   - `beta_multi_agent_orchestrator`
   - `beta_prompt_optimizer`

### 6.2 幂等与并发控制

1. 每步执行使用 `execution_token`（一次性 claim）。
2. 更新状态时使用 `version` 字段防并发覆盖。
3. 任务回调按 `task_id + step_id` 去重。

## 7. API 与契约

### 7.1 编排相关 API（新增）

1. `POST /api/pipelines/runs`（扩展）
   - 支持模板化流程定义（步骤、依赖、角色）
2. `GET /api/pipelines/runs/{id}/graph`
   - 返回步骤图与实时状态
3. `POST /api/pipelines/runs/{id}/retry-failed`
   - 对失败阶段执行策略化重跑
4. `GET /api/pipelines/runs/{id}/optimizations`
   - 返回 Prompt 优化建议和应用状态

### 7.2 审核输出契约（强约束）

Review 智能体必须输出 JSON（可包在代码块中）：

```json
{
  "decision": "pass",
  "score": 0.0,
  "issues": [],
  "retryHints": [],
  "riskLevel": "low"
}
```

若解析失败，按 `fail` 处理并触发“格式错误重试”。

## 8. 智能体分工策略

### 8.1 角色映射

1. Design 任务默认路由到设计类智能体（例如：大纲架构师、分镜渲染师）。
2. Review 任务默认路由到审核类智能体（例如：合规审核官）。
3. 若项目内缺目标角色：
   - 优先从可复用智能体中拉取并分配
   - 缺失时给出待确认动作（保持当前确认机制）

### 8.2 任务待命机制

1. 未满足依赖的步骤保持 `blocked`。
2. 已满足依赖但受并发上限限制的步骤进入 `ready` 队列。
3. 编排器空闲时按优先级（review > design）拉取执行。

## 9. Prompt 优化（Beta）方案

### 9.1 触发时机

每个阶段完成后触发一次：

1. 收集本阶段设计与审核消息窗口
2. 抽取失败原因、重复问题、审查要点
3. 生成两份 patch：
   - `design_prompt_patch`
   - `review_prompt_patch`

### 9.2 应用策略

1. 默认“建议模式”：只展示，不自动应用。
2. Beta 开关开启后：
   - 对同项目后续 run 自动附加 patch（临时生效）
   - 达到质量阈值（例如连续 3 次提升）后可转“项目长期生效”
3. 提供一键回滚到基线 prompt。

### 9.3 安全约束

1. patch 长度限制与敏感词过滤。
2. 禁止改写系统级安全策略段。
3. 记录每次 patch 来源和 diff，便于审计。

## 10. 设置页 Beta 开关设计

### 10.1 新增开关

在设置中增加 Beta 区域：

1. `启用全自动多智能体编排（Beta）`
2. `启用流程后 Prompt 自优化（Beta）`

### 10.2 开关行为

1. 开关关闭：回退到当前“手动触发任务”行为。
2. 仅开编排：自动流程跑，但不做 prompt 自优化。
3. 两者都开：完整 Beta 行为。

## 11. 里程碑与实施计划

### 里程碑 M1：最小闭环（2 周）

1. 实现 Outline Design -> Outline Review 自动推进
2. 审核失败自动重试（最多 2 次）
3. run/step 状态完整可视化

验收：

1. 无人工点击可从 Design 自动到 Review
2. `fail` 自动触发重试并记录原因
3. 所有状态可在 API 查询

### 里程碑 M2：全流程编排（2~3 周）

1. 扩展到 Script/Chapters/Keyframe/Video
2. 加入并发队列与优先级调度
3. 增加取消、暂停、恢复一致性

验收：

1. 端到端 run 完成率达标
2. 无“跨项目串任务”与“重复执行”问题

### 里程碑 M3：Prompt Optimizer Beta（2 周）

1. 对话抽取与 patch 生成
2. 设置页 Beta 开关与策略应用
3. 回滚机制与审计日志

验收：

1. 可看到每阶段 patch 建议
2. 开关关闭时不影响主流程
3. 可回滚并可追踪 patch 来源

## 12. 质量指标与验收标准

### 12.1 关键指标

1. 流程成功率（run completed / run total）
2. 审核一次通过率
3. 重试后修复率
4. 平均阶段耗时
5. Prompt 优化后通过率提升

### 12.2 稳定性指标

1. 幂等冲突率 < 0.5%
2. 串任务事故 = 0
3. 关键接口 95 分位响应稳定

## 13. 风险与应对

1. 风险：审核输出不稳定，JSON 难解析
   - 应对：强 schema + 容错解析 + 格式重试模板
2. 风险：并发调度导致重复执行
   - 应对：step claim token + version 乐观锁
3. 风险：Prompt 优化偏航
   - 应对：Beta 开关 + 建议模式默认 + 一键回滚
4. 风险：用户感知“黑盒”
   - 应对：步骤图、审核结论、重试原因全可见

## 14. 建议的首个落地切片

优先实现以下最小切片并上线灰度：

1. Outline Design + Outline Review 自动闭环
2. 审核失败自动重试（2 次）
3. Beta 开关仅控制“自动编排”
4. Prompt Optimizer 先只“生成建议不自动应用”

该切片可以最低风险验证架构正确性，再逐步扩展到全流程与自动应用。
