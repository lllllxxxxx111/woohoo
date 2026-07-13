# 方舟第 31 期 Agent 长程众测准备稿

> 适用仓库：`C:\Users\lxy\Desktop\work\woohoo`
> 建议 Harness：Hermes 或 Openclaw 均可
> 众测任务类型：31期 Agent 长任务众测
> 截止时间：2026-07-03 12:00

## 1. 建议提交信息

任务标题：

```text
Woohoo Studio 增加用户级 AI 成本预算、超限拦截与设置页预算看板
```

任务背景：

```text
Woohoo Studio 是一个本地优先的 AI 创作工作台，前端使用 React + TypeScript + Vite，后端使用 Rust Axum + SQLite。当前系统已经有 ai_usage_events 用量流水、UsageDashboard 用量看板、billing 积分余额与 credit_transactions 积分流水，但缺少“按用户设置预算阈值、超限前预警、超限后拦截高成本 AI 任务”的闭环能力。

真实业务需求是：个人或小团队在接入多个 AI endpoint 后，需要防止图像/视频/长文本任务无限消耗 token 或积分。希望在设置页里配置日/月预算，后端在创建 AI task 和同步/流式 chat 前做预算检查，前端能展示当前消耗、预算使用率和最近拦截原因。
```

建议上传依赖：

```text
上传整个仓库文件夹，排除 node_modules、dist、data、runtime-logs、.git。
如果平台上传全量很慢，可以至少上传：
- package.json
- tsconfig.json
- vite.config.ts
- server/Cargo.toml
- server/migrations/
- server/src/
- src/
- docs/current-system-architecture.md
- docs/backend-ai-runtime.md
```

## 2. 固定首轮 Prompt

把下面整段作为所有 4 个模型完全相同的首轮 Prompt：

```text
你现在在 Woohoo Studio 仓库中工作。请先阅读 README、package.json、docs/current-system-architecture.md、docs/backend-ai-runtime.md，以及和 AI 用量、计费、设置页相关的代码，再实现一个真实可用的“用户级 AI 成本预算与超限拦截”功能。

项目背景：
- 前端：React 18 + TypeScript + Vite + Arco Design + Zustand。
- 后端：Rust Axum + SQLite + sqlx。
- 当前已有 ai_usage_events 用量流水、/api/ai/usage/summary 用量汇总、UsageDashboard 用量看板、billing 积分余额和 credit_transactions 流水。
- 当前系统支持同步 chat、流式 chat、异步 AI task、图像生成、视频生成、pipeline、workspace bootstrap。

业务目标：
1. 新增用户级预算配置：
   - 支持 dailyCreditLimit 和 monthlyCreditLimit。
   - 支持 warnRatio，默认 0.8。
   - 支持 isEnabled 开关。
   - 每个用户一份配置。
2. 后端预算检查：
   - 在 POST /api/ai/tasks、POST /api/ai/chat、POST /api/ai/chat/stream 前检查预算。
   - 预算单位统一为“积分”，沿用前端 src/lib/credits.ts 的 1000 token = 1 积分规则。
   - 预算消耗来源使用 ai_usage_events.total_tokens 聚合，不直接依赖 messages.token_usage。
   - 如果已超出日预算或月预算，返回 402 或 429 均可，但错误信息必须结构化，前端能区分 budget_exceeded。
   - 如果接近预算但未超限，不阻断请求，但响应或后续查询中要能体现 warning 状态。
3. API：
   - 新增 GET /api/billing/budget，返回当前用户预算配置、今日消耗、本月消耗、使用率、warning/exceeded 状态。
   - 新增 PUT /api/billing/budget，更新预算配置；需要校验负数、warnRatio 范围、空值含义。
4. 前端：
   - 在 SettingsModal 现有设置体系中加入“预算控制”区域，或整合到 UsageDashboard 中。
   - 可以查看今日/月度消耗、预算上限、使用率、预警状态。
   - 可以编辑 dailyCreditLimit、monthlyCreditLimit、warnRatio、isEnabled。
   - 当后端返回 budget_exceeded 时，聊天/任务入口要显示清晰错误 toast，不要表现成普通网络失败。
5. 数据库与兼容：
   - 新增 migration，不能破坏旧库启动。
   - 注意当前项目有 SQL migration + Rust backfill 的兼容策略，至少保证新库可初始化、旧库可升级。
6. 测试与验证：
   - 补充合理的前端测试或后端可验证逻辑；如果 Rust 侧没有现成测试框架，至少补充 TypeScript 测试和明确的手工验证路径。
   - 必须运行 npm run typecheck、npm run test、npm run build；如果无法运行 Rust 编译或后端测试，请说明原因并保证 Rust 代码通过基本语法/类型检查思路。

约束：
- 不要重构无关模块。
- 不要删除已有功能。
- 不要把 API key、token 或密钥打印到日志或 UI。
- 不要把预算写死在前端，必须以后端当前登录用户为准。
- 保持现有代码风格，优先复用 serverApi、SettingsModal、UsageDashboard、billing repo/handlers 的已有模式。

最终交付：
- 说明改了哪些文件。
- 说明新增 API 形状。
- 说明预算拦截逻辑。
- 说明运行了哪些验证命令及结果。
```

## 3. 后续 9 轮追加话术

为满足同一任务 10 个用户轮次，建议每个模型都使用同一套追加话术。不要把某个模型独有产物复制给另一个模型；下面每轮都只围绕当前产物做验收推进。

第 2 轮：

```text
请继续自查你刚才的改动：确认预算检查是否覆盖了 /api/ai/tasks、/api/ai/chat、/api/ai/chat/stream 三条路径。如果有遗漏，请补齐。请不要改动无关模块。
```

第 3 轮：

```text
请检查数据库兼容性：新建库应能通过 migration 初始化，已有库也不能因为缺少 budget 表或字段而启动失败。必要时补充 migration 或启动期兼容逻辑，并说明你的选择。
```

第 4 轮：

```text
请检查前端错误处理：当后端因为预算超限返回 budget_exceeded 时，聊天或任务入口应展示明确的预算超限提示，而不是普通“请求失败”。请补齐缺失处理。
```

第 5 轮：

```text
请完善设置页的预算控制体验：需要能查看今日/月度消耗、预算上限、使用率、预警/超限状态，并能保存 dailyCreditLimit、monthlyCreditLimit、warnRatio、isEnabled。注意移动端或窄宽度下不要出现明显布局溢出。
```

第 6 轮：

```text
请补充测试或验证代码，优先覆盖预算数据规范化、预算状态计算、API 类型映射、前端展示辅助逻辑。不要为了测试大幅重构业务代码。
```

第 7 轮：

```text
请运行 npm run typecheck 和 npm run test，并根据失败信息修复问题。请在回复中贴出关键结果。如果命令无法运行，请说明具体失败原因。
```

第 8 轮：

```text
请运行 npm run build，并修复构建失败。构建通过后，请说明是否还有 Rust 后端编译风险，以及你如何检查这些风险。
```

第 9 轮：

```text
请做一次端到端验收说明：从登录用户打开设置页、配置预算、发起 AI 请求、接近预算预警、超过预算拦截，这条链路每一步应该如何验证？如果你认为当前仓库缺少 mock 数据或环境变量，也请给出本地可执行的替代验证办法。
```

第 10 轮：

```text
请最后自查并收尾：列出最终改动文件、核心设计权衡、已知限制、已运行验证命令。不要继续扩大功能范围，只修复明显 bug 或遗漏。
```

## 4. 验收清单

你下载每个模型产物后，建议按这个顺序亲自检查并截图。

基础检查：

```powershell
npm run typecheck
npm run test
npm run build
```

代码检查点：

```text
- 是否新增了预算配置的持久化表或等价结构。
- 是否有 GET /api/billing/budget 和 PUT /api/billing/budget。
- 是否预算消耗来自 ai_usage_events.total_tokens 聚合。
- 是否覆盖 task、sync chat、stream chat 三条入口。
- 是否超限错误有稳定机器可读字段，例如 code=budget_exceeded。
- 是否前端 serverApi 类型和请求函数完整。
- 是否设置页能编辑和展示预算。
- 是否没有泄露 API key。
- 是否没有把预算只做成前端假状态。
```

建议截图：

```text
1. 设置页预算控制区域。
2. 保存预算配置后的状态。
3. 用量看板或预算看板显示今日/月度使用率。
4. 超限请求被拦截时的 toast 或错误提示。
5. typecheck/test/build 通过或失败终端截图。
```

## 5. 评分参考

请基于你自己实际运行和截图评分，不要直接复制下面文字作为最终反馈。

高分特征：

```text
- 能准确识别现有 ai_usage_events、billing、UsageDashboard、serverApi 的职责边界。
- 后端预算检查真的接入请求入口，而不是只做 UI。
- API 结构稳定，错误码可被前端识别。
- migration 兼容，不破坏旧库。
- 前端体验完整，表单校验和错误 toast 清楚。
- 至少 typecheck/test/build 有实际运行记录。
```

低分特征：

```text
- 只写方案，没有改代码。
- 只改前端，没有后端拦截。
- 预算消耗从 localStorage 或 messages 文本估算，绕开 ai_usage_events。
- 只覆盖 /api/ai/tasks，漏掉 sync/stream chat。
- 破坏现有 API 类型或构建失败。
- 没有 migration，或旧库启动会失败。
- 超限错误只是普通 500，前端无法识别。
```

## 6. 反馈模板

产物质量评论模板：

```text
我本地下载并运行了该模型产物，重点检查了预算配置持久化、后端预算拦截、设置页展示、超限错误提示和构建测试结果。

优点：
- （根据实际产物填写）

问题：
- （根据实际产物填写，建议引用具体文件或截图）

验证结果：
- npm run typecheck：（通过/失败，失败原因）
- npm run test：（通过/失败，失败原因）
- npm run build：（通过/失败，失败原因）
- 手工验证：（预算保存、预警、超限拦截是否符合预期）

综合判断：
- （说明为什么给这个分数）
```

轨迹分析可选评论方向：

```text
- 是否先读了 docs/current-system-architecture.md 和 docs/backend-ai-runtime.md。
- 是否先 grep 了 ai_usage_events、billing、UsageDashboard、serverApi，而不是盲改。
- 是否在修改 Rust 路由前确认了 main.rs 的路由注册方式。
- 是否在设计 migration 时考虑旧库兼容。
- 是否运行验证命令并根据错误继续修。
- 是否出现明显偏题，例如改成纯报表、纯文档或重做 UI。
```

## 7. 备用任务方向

如果你不想做预算控制，也可以保留同一仓库，换成下面两个方向之一。但同一众测任务中 4 个模型必须使用同一条固定 Prompt。

方向 A：

```text
给 Pipeline Orchestrator 增加失败重试可视化与人工复核队列，包括后端状态查询、前端队列入口、retry/cancel 操作和测试。
```

方向 B：

```text
给素材库 AssetLibrary 增加跨项目素材搜索、标签过滤、引用关系展示和删除前影响检查，覆盖前后端 API、SQLite schema、前端 UI 和测试。
```
