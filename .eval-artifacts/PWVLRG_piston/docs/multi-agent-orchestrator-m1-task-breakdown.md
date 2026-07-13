# 多智能体编排 M1 执行拆解（可落地任务清单）

## 1. 目标（M1）

在不破坏现有聊天能力的前提下，完成最小闭环：

1. Outline Design 自动执行
2. Outline Review 自动执行
3. 审核失败自动回到 Design 重试（最多 2 次）
4. 全流程异步执行，不阻塞前端
5. 通过 Beta 开关控制是否启用自动编排

## 2. 交付范围

### In Scope

1. Pipeline run 的依赖推进与自动调度
2. Step 状态机（`blocked/ready/running_design/running_review/retrying/passed/failed`）
3. Review JSON 解析与闸门判定
4. 重试策略（次数限制 + 失败原因回灌）
5. Settings 增加 `beta_multi_agent_orchestrator`

### Out of Scope

1. Prompt Optimizer 自动应用（M1 仅预留接口）
2. 全流程（Script/Keyframe/Video）自动串联
3. 多实例分布式抢占（M1 默认单实例进程内）

## 3. 任务分解（按模块）

## 3.1 数据层（DB + Migration）

### T1. 扩展 pipeline_run_steps

1. 新增字段：`step_type`, `depends_on_json`, `review_policy_json`, `retry_of_step_id`, `run_version`
2. 新增索引：`(run_id, status)`, `(run_id, step_order)`, `(run_id, step_type)`

完成标准：

1. migration 可重复执行
2. 老数据兼容（默认值兜底）

### T2. 新增 pipeline_step_outputs

字段建议：

1. `id`, `run_id`, `step_id`, `task_id`
2. `output_type`, `output_json`, `raw_content`
3. `review_decision`, `review_score`, `review_issues_json`, `retry_hints_json`
4. `created_at`, `updated_at`

完成标准：

1. 可按 `run_id/step_id` 查询最新结构化输出
2. 不影响现有 message 存储逻辑

## 3.2 后端编排器（Orchestrator）

### T3. 新增 orchestrator 模块

文件建议：

1. `server/src/pipeline/orchestrator.rs`
2. `server/src/pipeline/engine.rs`
3. `server/src/pipeline/review_gate.rs`
4. `server/src/pipeline/retry.rs`

能力要求：

1. 周期扫描 `running/queued` run
2. 计算 `ready` 步骤并 claim 执行权
3. 为 step 创建 AI task（复用现有 AI 任务能力）

完成标准：

1. 单 run 内同一步骤不会重复触发
2. 编排器异常不会导致主服务不可用

### T4. 状态机与依赖推进

1. `blocked -> ready` 规则实现
2. `running_design -> running_review` 自动推进
3. review 判定 `pass/fail` 分支

完成标准：

1. 覆盖主要迁移路径
2. 所有状态变更写入事件日志

### T5. Review Gate（结构化闸门）

1. 解析审核智能体 JSON 输出
2. 解析失败按 `fail` 处理并记录错误码 `review_parse_error`
3. 支持 `decision/pass/fail/issues/retryHints`

完成标准：

1. 错误输出不导致 run 崩溃
2. 失败原因可在 UI 看到

### T6. Retry Engine

1. 失败回流到对应 Design 步骤
2. `maxRetries=2`（M1 固定）
3. 重试 prompt 拼接 `issues + retryHints`

完成标准：

1. 超过次数后 run 进入 `failed`
2. 每次重试 attempt 可追踪

## 3.3 API 层（最小扩展）

### T7. Pipeline API 扩展

1. `POST /api/pipelines/runs` 支持模板化 steps（含 dependsOn/stepType）
2. `GET /api/pipelines/runs/{id}` 返回扩展状态与最近错误
3. `GET /api/pipelines/runs/{id}/graph`（可选，M1 可延后）

完成标准：

1. 前端可直接绘制步骤状态
2. 与旧调用兼容

## 3.4 前端（设置 + 运行面板）

### T8. Settings Beta 开关

新增字段：

1. `betaMultiAgentOrchestrator: boolean`（默认 false）

落点：

1. `src/types/index.ts`
2. `src/lib/ai.ts`/配置归一化
3. `src/context/AppContext.tsx` 持久化与状态注入
4. `src/components/Settings/SettingsModal.tsx` UI 开关

完成标准：

1. 开关关闭时保持当前行为
2. 开关开启时 pipeline 使用编排器模式

### T9. OutlineView 接入真实 run 模板

1. “重新生成/提交审核”改为调用 `createPipelineRun`（不是直接 `sendAiMessage`）
2. 显示 run 状态和 step 进度
3. 显示失败原因与重试按钮

完成标准：

1. 用户从按钮即可触发完整自动闭环
2. 页面刷新后可恢复 run 状态

## 4. 开发顺序（建议）

1. T1 + T2（Migration）
2. T3 + T4（引擎骨架 + 状态机）
3. T5 + T6（审核闸门 + 重试）
4. T7（API）
5. T8 + T9（前端接入）
6. 全链路联调 + 冒烟

## 5. 验收标准（M1）

### 功能验收

1. 提交 Outline run 后无需人工干预可走到 Review
2. Review pass 时 run completed
3. Review fail 时自动触发 Design 重试
4. 超过 2 次后 run failed，并可见失败原因

### 稳定性验收

1. 无重复执行同一步骤
2. 取消 run 后不再推进新步骤
3. 服务重启后 run 可恢复推进

### 回归验收

1. 现有 `sendAiMessage` 聊天流程不回归
2. 任务取消、SSE、消息落库不回归
3. `npm run build` / `cargo test` 通过

## 6. 测试矩阵

### 单元测试

1. 依赖解析：dependsOn 判定
2. Review 解析：正常 JSON / 缺字段 / 非法 JSON
3. Retry 规则：次数边界、错误码映射

### 集成测试

1. run 从 queued 到 completed 的 happy path
2. review fail -> retry -> pass
3. retry 达上限 -> failed

### 冒烟测试

1. 设置开关关闭：行为与当前版本一致
2. 设置开关开启：触发自动编排闭环
3. 中途取消：run 停止推进

## 7. 风险控制

1. 所有新逻辑以 Beta 开关门控
2. 先对 Outline 流程灰度，不一次扩到全链路
3. 所有自动动作可追踪（事件 + step output）
4. 保留手动 fallback 路径

## 8. M1 交付件列表

1. migration SQL x2
2. orchestrator/review/retry 模块
3. pipeline API 扩展
4. settings Beta 开关 UI + store + persistence
5. outline pipeline 自动闭环接入
6. 测试与回归报告

