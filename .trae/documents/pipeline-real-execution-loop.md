# Pipeline 步骤从前端操作到后端异步任务的真实执行闭环

## Summary

本计划承接先前会话已落盘的后端 Phase A/B1/B2/B3/B4 工作，继续完成 **Phase B5（后端 cargo 验证）→ Phase C（前端共享层）→ Phase D（4 视图迁移到真实 pipeline）→ Phase E（前端离线测试）→ Phase F（四项构建验证）**，最终交付一个"前端按钮 → 后端真实任务 → SSE/受控刷新回传 → 状态文案统一 → 终态保护/幂等/权限隔离/依赖门控全闭合"的真实执行闭环。

不新增功能、不重构无关代码；所有改动都服务于用户列出的 10 项必须完成要求。

## Current State Analysis（基于本次实际代码核验）

### 后端已落盘（本次会话只读核验通过）

| 项 | 位置 | 状态 |
|---|---|---|
| migration 025 重建 `pipeline_run_events` 移除 event_type CHECK | `server/migrations/025_pipeline_events_constraint_relax.sql` | ✅ 落盘 |
| db.rs 注册 025 + 测试 expected 版本同步 | `server/src/db.rs` L173-176、L2042 | ✅ 落盘 |
| 3 个纯解析函数下沉 `helpers.rs` 为 `pub(super) fn` | `server/src/pipeline/orchestrator/helpers.rs` L75/L147/L216 | ✅ 落盘 |
| orchestrator.rs 3 个调用点改为 `helpers::xxx` | `server/src/pipeline/orchestrator.rs` L1536/L1589/L2093 | ✅ 落盘 |
| helpers.rs 6 个单测 + `build_step_with_policy` helper | `server/src/pipeline/orchestrator/helpers.rs` L740-1137 | ✅ 落盘 |
| handlers.rs 7 个集成测试 | `server/src/pipeline/handlers.rs` L1339-1628 | ✅ 落盘 |
| 幂等 409 / 用户级权限隔离 / retry-step 终态保护 / pause/resume/cancel | `server/src/pipeline/handlers.rs` L47-74/L381/L540-547/L549-591 | ✅ 落盘 |
| 全部 pipeline 路由注册 | `server/src/main.rs` L451-493 | ✅ 落盘 |

### 前端缺口（本次会话只读核验确认）

| 项 | 位置 | 当前状态 |
|---|---|---|
| `CreatePipelineRunInput.stepType` | `src/lib/serverApi.pipeline.ts` L197 | ❌ 仅 `'design'\|'review'\|'system'`，缺 `'image_gen'\|'video_gen'` |
| 共享状态文案层 | 不存在 `pipelineStatusPresets.ts` | ❌ 需新建 |
| 共享 pipeline run 控制器 hook | 不存在 `usePipelineRunController.ts` | ❌ 需新建 |
| `usePipelineTaskLauncher.ts` | 仅封装 `sendAiMessage` 聊天路径 | ⚠️ 保留，不迁移 |
| `OutlineView.tsx` | `createPipelineRun` + `streamPipelineRun` + 兜底 `setInterval(5000)` | ✅ 唯一正确模板，提取为共享 hook |
| `ScriptView.tsx` | L103 `launchTask` → `sendAiMessage` 聊天路径 | ❌ 需迁移到 pipeline design step |
| `ChaptersView.tsx` | L86 `launchTask` → `sendAiMessage` 聊天路径 | ⚠️ 不在 10 项要求内，本次不改 |
| `CharSceneView.tsx` | L42/L61 `createImageGeneration` 单任务 API | ❌ 需迁移到 pipeline image_gen step |
| `KeyframeView.tsx` | L71/L109 `createImageGeneration` 单任务 API | ❌ 需迁移到 pipeline image_gen step |
| `VideoView.tsx` | L90 `createVideoGeneration` + L65 `setInterval` 轮询 `getVideoGeneration` | ❌ 违反 req #2，需迁移到 pipeline video_gen step |
| `EditView.tsx` | L52 `setInterval` 是播放器预览轮播，非任务轮询 | ✅ 无需改 |

> **注**：用户要求"至少 4 类真实步骤"——大纲（OutlineView 已成）、剧本（ScriptView）、角色/场景（CharSceneView）、关键帧（KeyframeView）、视频（VideoView）共 5 类，超过 4 类下限。ChaptersView 不在硬性要求内，保留现状以缩小爆炸半径。

## Proposed Changes

### Phase B5：cargo 验证（后端关口，必须全绿才进 C）

**命令**：
1. `cargo test --manifest-path server/Cargo.toml pipeline`（运行所有 pipeline 模块测试：B3 的 6 个单测 + B4 的 7 个集成测试 + 现有 9 个测试）
2. `cargo check --manifest-path server/Cargo.toml`（编译检查）

**验收**：全绿，0 error。新增代码无 warning。
**失败处理**：根据编译错误/测试失败修复 B3/B4 代码，不扩散到无关模块。

### Phase C：前端共享层

#### C1：扩展 `stepType` 类型

**文件**：`src/lib/serverApi.pipeline.ts` L197

**改动**：
```typescript
stepType?: 'design' | 'review' | 'system' | 'image_gen' | 'video_gen';
```

**理由**：与后端 `normalize_step_type`（helpers.rs L35-50）支持的 5 类对齐。req #1。

#### C2：新建 `pipelineStatusPresets.ts`（共享状态文案层）

**文件（新建）**：`src/features/studio/components/workspace/PipelineSteps/pipelineStatusPresets.ts`

**职责**：
1. **派生显示态** `PipelineDisplayState`：8 态 = `queued | running | paused | blocked | manual_review_required | completed | failed | cancelled`
   - 从 `(run.status, step.status, errorCode)` 三元组派生
   - `run.status='running' + step.status='blocked'` → `blocked`
   - `run.status='failed' + errorCode='MANUAL_REVIEW_REQUIRED'` → `manual_review_required`
   - `run.status='paused'` → `paused`
   - 其余直接映射
2. **统一文案表** `PIPELINE_DISPLAY_PRESETS: Record<PipelineDisplayState, { label, hint, progress, nextActions }>`：
   - `queued`：排队中 / 流程已创建，等待 orchestrator 调度 / progress 0 / 下一步：取消
   - `running`：执行中 / 正在执行步骤 N/total / progress = completedSteps/total / 下一步：暂停、取消
   - `paused`：已暂停 / 用户主动暂停 / progress 冻结 / 下一步：恢复、取消
   - `blocked`：已阻塞 / 依赖未满足或端点缺失 / progress 冻结 / 下一步：查看错误、取消
   - `manual_review_required`：需人工复核 / 自动审核多次失败 / progress 冻结 / 下一步：人工重试、取消
   - `completed`：已完成 / 全部步骤成功 / progress 100% / 下一步：进入下一阶段
   - `failed`：失败 / {errorMessage} / progress 冻结 / 下一步：重试失败步骤、取消
   - `cancelled`：已取消 / 用户取消 / progress 冻结 / 下一步：重新启动
3. **错误码文案表** `PIPELINE_ERROR_CODE_PRESETS: Record<string, { label, hint, action }>`：
   - `MISSING_ENDPOINT` / `DEPENDENCY_UNSATISFIED` / `RETRY_SCHEDULED` / `WAITING_PREREQUISITE` / `MANUAL_REVIEW_REQUIRED` / `EXECUTION_FAILED`
   - 与 OutlineView.tsx L73-98 `RUN_ERROR_LABELS` 对齐（提取共享）
4. **导出纯函数** `deriveDisplayState(run, step?)` 和 `getDisplayPreset(state)`

**理由**：req #5（统一状态文案、进度、下一步操作），req #3（前端展示可操作提示）。治理文档 6.1 三层状态口径（逻辑态/存储态/诊断态联合渲染）。

#### C3：新建 `usePipelineRunController.ts`（共享控制器 hook）

**文件（新建）**：`src/features/studio/components/workspace/PipelineSteps/usePipelineRunController.ts`

**职责**：从 OutlineView.tsx 提炼通用逻辑，供 5 个 View 复用：
1. **状态**：`currentRun: PipelineRunSummary | null`、`isLoading`、`loadError`、`isSubmitting`
2. **幂等键生成** `buildIdempotencyKey(scope)`：`projectId + conversationId + pipelineType + triggerSource + hash(payload)`（治理文档 20.4 默认决策值）
   - **修正 OutlineView 隐患**：现有 `Date.now()+random` 不是真正幂等（L625），新 hook 改用确定性 hash
3. **启动 run** `launch(pipelineType, steps, options)`：
   - 调 `createPipelineRun` → `getPipelineRun` 拿详情 → `setFocusedRunId`
   - 返回 run.id 供调用方做后续动作
4. **加载最新 run** `loadLatestRun()`：
   - `listPipelineRuns({projectId, conversationId, limit:30})` → 找 focusedRunId 或 runs[0]
   - 终态 run 清空 focusedRunId
   - 并发 `getPipelineRun` + `getPipelineOptimizations`
5. **SSE 订阅 + 兜底轮询**：
   - 终态不订阅
   - 有 focusedRunId → `streamPipelineRun` SSE 订阅
   - 无 focusedRunId → `setInterval(5000)` 兜底轮询（仅用于恢复无主 run）
   - 组件卸载/依赖变化时 abort + clearInterval
6. **控制操作** `pause/resume/cancel/retryStep`：透传 serverApi，刷新 run + toast
7. **派生显示态**：通过 C2 的 `deriveDisplayState` 暴露 `displayState` 和 `displayPreset`
8. **资产刷新去重**：`refreshedAssetIdsRef` 防止重复 `refreshWorkspace`

**接口契约**：
```typescript
interface UsePipelineRunControllerOptions {
  pipelineType: string;          // 'outline' | 'script' | 'char_scene' | 'keyframe' | 'video'
  triggerSource?: string;       // 默认 'manual'
  enabled?: boolean;             // isServerWorkspaceReady && projectId
  requireBeta?: boolean;         // 默认 true
}

interface UsePipelineRunControllerResult {
  currentRun: PipelineRunSummary | null;
  isLoading: boolean;
  loadError: string;
  isSubmitting: boolean;
  displayState: PipelineDisplayState;
  displayPreset: PipelineDisplayPreset;
  currentStep: PipelineRunStep | null;
  launch: (steps: PipelineStepInput[], options?: { idempotencyScope?: string }) => Promise<string | null>;
  loadLatestRun: () => Promise<void>;
  pause: (reason?: string) => Promise<void>;
  resume: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  retryStep: (stepId: string, reason?: string) => Promise<void>;
}
```

**理由**：req #2（真实状态为准，SSE/受控刷新）、req #4（幂等键确定性）、req #7（避免重复刷新）。

#### C4：OutlineView 重构接入共享 hook（可选但建议）

**文件**：`src/features/studio/components/workspace/PipelineSteps/OutlineView.tsx`

**改动**：
- 删除本地 `currentRun / isLoading / loadError / isSubmitting` 状态
- 删除本地 `loadLatestRun / SSE 订阅 / 兜底轮询` 逻辑
- 改用 `usePipelineRunController({ pipelineType: 'outline' })`
- 保留业务专属逻辑：`buildOutlineDesignPrompt / buildOutlineReviewPrompt / 大纲文档源提取 / 审核面板`
- 修正幂等键：`buildIdempotencyKey('outline-{mode}')` 替换 L625 的 `Date.now()+random`

**理由**：消除重复、验证 hook 可用性、修正幂等键隐患。**若 C4 风险过大可跳过**，但 D1-D4 必须用 hook。

### Phase D：4 视图迁移到真实 pipeline

> **统一原则**：每个 View 调用 `usePipelineRunController`，提交真实 step，SSE 跟踪真实状态。不允许 `setTimeout` 推进步骤、不允许伪造完成。

#### D1：ScriptView → pipeline `design` step

**文件**：`src/features/studio/components/workspace/PipelineSteps/ScriptView.tsx`

**改动**：
- 删除 `usePipelineTaskLauncher` import + `launchTask` 调用（L25/L103）
- 接入 `usePipelineRunController({ pipelineType: 'script' })`
- `launch` 提交 1-2 个 step：
  - `step_key='script_design'` `step_type='design'` `prompt_template=buildScriptPrompt()`
  - 可选 `step_key='script_review'` `step_type='review'` `depends_on=['script_design']` `review_policy={strictJson,requiredFields:[...]}`
- reviewPolicy.requires 可声明 `['project:outline']`（req #3 跨阶段依赖门控）
- 状态展示用 C2 的 `displayPreset`
- 失败/阻塞时展示 `errorCode` 对应的可操作提示

**理由**：req #1（剧本接入真实步骤）、req #3（前置资产门控）。

#### D2：CharSceneView → pipeline `image_gen` step

**文件**：`src/features/studio/components/workspace/PipelineSteps/CharSceneView.tsx`

**改动**：
- 删除 `createImageGeneration` import + 2 处调用（L7/L42/L61）
- 接入 `usePipelineRunController({ pipelineType: 'char_scene' })`
- `launch` 提交 step：
  - `step_key='char_scene'` `step_type='image_gen'`
  - `review_policy={ prompt, size:'1024x1024', n:1, model?, endpointId? }`（与后端 `parse_image_gen_params` 契约对齐）
  - `depends_on` 可声明 `['project:script']`（跨阶段依赖）
- 不再本地轮询 `getImageGeneration`；状态由 SSE 回传
- 完成后 `displayPreset.completed` + `refreshWorkspace('pipeline char_scene asset', 2)`

**理由**：req #1（角色/场景接入真实 image_gen 步骤）、req #2（消除本地轮询）。

#### D3：KeyframeView → pipeline `image_gen` step

**文件**：`src/features/studio/components/workspace/PipelineSteps/KeyframeView.tsx`

**改动**：
- 删除 `createImageGeneration` import + 2 处调用（L7/L71/L109）
- 接入 `usePipelineRunController({ pipelineType: 'keyframe' })`
- `launch` 提交 step：
  - `step_key='keyframe'` `step_type='image_gen'`
  - `review_policy={ prompt: 分镜描述, size, n, model?, endpointId? }`
  - `depends_on=['project:storyboard']` 或 `['project:script']`
- 状态由 SSE 回传，消除本地轮询
- 完成后刷新资产库 + Pipeline 预览

**理由**：req #1（关键帧接入真实 image_gen 步骤）、req #2（消除本地轮询）。

#### D4：VideoView → pipeline `video_gen` step

**文件**：`src/features/studio/components/workspace/PipelineSteps/VideoView.tsx`

**改动**：
- 删除 `createVideoGeneration` + `getVideoGeneration` import + `setInterval` 轮询（L7/L65/L90）
- 接入 `usePipelineRunController({ pipelineType: 'video' })`
- `launch` 提交 step：
  - `step_key='video'` `step_type='video_gen'`
  - `review_policy={ prompt, model:'wan2.1-t2v-480p', durationSeconds:5, aspectRatio:'16:9' }`（与后端 `parse_video_gen_params` 契约对齐）
  - `depends_on=['project:keyframe']` 或 `['project:char_scene']`
- 状态由 SSE 回传，**彻底消除 `setInterval` 轮询**（req #2 硬性要求）
- 完成后刷新资产库

**理由**：req #1（视频接入真实 video_gen 步骤）、req #2（消除 `setInterval` 轮询，这是当前最严重的违规）。

### Phase E：前端离线测试

**文件（新建）**：`src/features/studio/components/workspace/PipelineSteps/__tests__/pipelineController.test.ts`

**测试范围**（用 vitest + mock serverApi）：
1. **创建任务**：`launch` 调 `createPipelineRun` 传入正确的 step + idempotencyKey
2. **依赖阻塞**：run.status='running' + step.status='blocked' + errorCode='DEPENDENCY_UNSATISFIED' → `displayState='blocked'` + preset.hint 包含"依赖"
3. **重复提交**：相同 payload 两次 `launch` → 第二次返回相同 run.id（mock `createPipelineRun` 返回 409 + 既有 run）
4. **终态保护**：run.status='completed' → `displayState='completed'` + 不订阅 SSE
5. **暂停恢复取消**：`pause/resume/cancel` 调用对应 API + 刷新 run
6. **失败重试**：`retryStep(stepId)` 调 `retryPipelineStep` + 刷新 run
7. **权限隔离**：mock `getPipelineRun` 返回 404 → `loadError` 非空
8. **SSE/API 乱序竞态**：先返回旧 run、再返回新 run → `currentRun` 取最新（按 updatedAt 比较）

**理由**：req #9（离线可执行测试覆盖 8 类场景）。

### Phase F：四项构建验证

**命令**（按顺序）：
1. `npm run typecheck`（前端类型检查）
2. `npm run test`（前端测试，含 Phase E 新增）
3. `npm run build`（前端构建）
4. `cargo check --manifest-path server/Cargo.toml`（后端编译检查，B5 已跑过则可复用结果）

**失败处理**：逐项修复，不跳过。每修一处重跑对应命令。

## Assumptions & Decisions

1. **后端 B1-B4 已落盘且逻辑正确**——本次会话只读核验通过，B5 只需运行验证，不重写。
2. **不修改 ChaptersView**——不在用户 10 项要求硬性范围内，缩小爆炸半径。
3. **`PipelineStepStatus` 保持 7 态**（queued/running/completed/failed/skipped/blocked/retrying）——与 002 的 DB CHECK 一致；`manual_review_required/paused/cancelled` 通过 `PipelineDisplayState` 派生显示，不污染存储态。
4. **幂等键策略**：`projectId + conversationId + pipelineType + triggerSource + hash(payload)`——治理文档 20.4 默认决策值；修正 OutlineView 现有 `Date.now()+random` 隐患。
5. **SSE 优先 + 5s 兜底轮询**：与 OutlineView 现有实现一致；兜底轮询仅用于"恢复无主 run"场景，不用于推进已订阅 run。
6. **后端契约（image_gen）**：`reviewPolicy={prompt, size, n, model?, endpointId?}`——与 `parse_image_gen_params` (helpers.rs L75-134) 对齐。
7. **后端契约（video_gen）**：`reviewPolicy={prompt, model, durationSeconds?, aspectRatio}`——与 `parse_video_gen_params` (helpers.rs L147-202) 对齐。
8. **跨阶段依赖**：`reviewPolicy.requires=['project:outline'|'project:script'|'project:storyboard'|...]`——由后端 `parse_business_requires` + `validate_business_prerequisites` 处理（helpers.rs L216-238 + orchestrator.rs L2093/L2212）。
9. **C4（OutlineView 重构）可选**——若 hook 接入风险过大可跳过，但 D1-D4 必须用 hook；跳过 C4 时 OutlineView 保持现状（已是正确实现）。
10. **测试不依赖真实模型端点**——前端 mock serverApi；后端测试用 `init_db` 内存 schema，不调真实 AI/image/video 端点。

## Verification Steps

### B5（后端）
- [ ] `cargo test --manifest-path server/Cargo.toml pipeline` 全绿（22 个测试：9 现有 + 6 helpers + 7 handlers）
- [ ] `cargo check --manifest-path server/Cargo.toml` 0 error

### C（前端共享层）
- [ ] `serverApi.pipeline.ts` L197 stepType 包含 `image_gen|video_gen`
- [ ] `pipelineStatusPresets.ts` 导出 `PipelineDisplayState` / `deriveDisplayState` / `PIPELINE_DISPLAY_PRESETS` / `PIPELINE_ERROR_CODE_PRESETS`
- [ ] `usePipelineRunController.ts` 导出 hook，接口与契约一致
- [ ] `npm run typecheck` 0 error

### D（4 视图迁移）
- [ ] ScriptView 不再 import `usePipelineTaskLauncher`，改用 `usePipelineRunController`
- [ ] CharSceneView 不再 import `createImageGeneration`，改用 `usePipelineRunController`
- [ ] KeyframeView 不再 import `createImageGeneration`，改用 `usePipelineRunController`
- [ ] VideoView 不再 import `createVideoGeneration/getVideoGeneration`，不再有 `setInterval` 轮询
- [ ] `npm run typecheck` 0 error

### E（前端测试）
- [ ] `pipelineController.test.ts` 覆盖 8 类场景
- [ ] `npm run test` 全绿

### F（构建验证）
- [ ] `npm run typecheck` 0 error
- [ ] `npm run test` 全绿
- [ ] `npm run build` 成功
- [ ] `cargo check --manifest-path server/Cargo.toml` 0 error

## 实施顺序

B5 → C1 → C2 → C3 → C4（可选）→ D1 → D2 → D3 → D4 → E → F

每完成一个 Phase 立即用对应验证步骤确认，不批量堆积。

## 边界声明（最终交付时需说明）

- **不接入真实模型端点**：后端 orchestrator 调用 AI/image_gen/video_gen 模块时仍依赖用户已配置的端点；若端点缺失，run 会进入 `blocked` + `MISSING_ENDPOINT` 状态（这是设计预期，非 bug）。
- **不实现 SSE 服务端改造**：现有 `/api/pipelines/runs/{id}/stream` 每 2 秒轮询 DB 事件，最多 300 次迭代；不在本次改造范围。
- **不实现 ChaptersView/EditView 迁移**：不在 10 项要求硬性范围内。
- **不修改后端业务逻辑**：B1-B4 已落盘且核验通过，B5 仅运行验证。
