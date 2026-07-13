# 图片生成战略转向分析报告

> 版本: v1.0.0 | 日期: 2026-05-12 | 审计人: 技术型产品经理

---

## 0. 审计前置：关键发现（颠覆性事实）

在进入正式分析前，必须先纠正一个认知偏差：**用户认为"登录/计费/数据隔离"是全新开发项，但代码审计表明，其中两项已有完整实现。**

| 能力 | 用户认知 | 代码审计实际状态 | 差距 |
|------|----------|------------------|------|
| 登录/认证 | 不存在 | **完整 JWT 认证体系已存在** | 无差距 |
| 计费/用量 | 不存在 | **完整的 AI 用量追踪体系已存在** | 缺计费扣减层 |
| 数据隔离 | 不存在 | **user_id 隔离已存在于所有核心表** | 缺硬隔离加固 |

这一发现将显著影响后续所有判断。

---

## 1. 战略判断

### 1.1 "先做图片生成再回来做视频"是否合理？

**结论：合理且推荐。**

理由：

1. **技术验证链更短**。图片生成是单步调用（prompt -> image），视频生成是多步编排（prompt -> keyframes -> frames -> video）。先验证单步，再组合多步，符合工程递进原则。
2. **用户价值更快交付**。图片生成可独立交付使用，视频生成必须依赖图片生成作为前置步骤（分镜 -> 关键帧图片 -> 视频）。没有图片生成能力，视频生成 pipeline 是空中楼阁。
3. **计费模型更易验证**。图片生成有明确的单次成本（1 张图 = N tokens/credits），视频生成的成本模型复杂（帧数、时长、分辨率组合），先在简单模型上跑通计费闭环。
4. **当前视频流代码几乎为零**。代码审计结果：
   - [VideoView.tsx](file:///c:/Users/lxy/Desktop/work/woohoo/src/features/studio/components/workspace/PipelineSteps/VideoView.tsx) 仅 111 行，只是调用 `launchTask` 发一条 AI 消息
   - 后端无任何视频生成 API、无视频模型集成
   - Storyboard 数据模型存在，但"视频生成"只是 pipeline step_key 的一个字符串概念
   - **暂停视频流开发 = 暂停一个尚未开始的开发项，零沉没成本**

### 1.2 图片生成和视频生成是同一产品的两个阶段，还是两个产品？

**结论：同一产品的两个阶段。**

DNA 分析：
- 图片生成的 DNA = "将文字创意转化为视觉内容"
- 视频生成的 DNA = "将文字创意转化为动态视觉内容"
- 两者共享：prompt 构造、AI 模型调用、资产存储、用量计费、项目管理

图片生成是视频生成的子集。在 Woohoo 的 pipeline 框架下，图片生成是 `keyframe_design` 步骤的产出，视频生成是 `video_design` 步骤的产出。它们天然属于同一个 pipeline 的不同阶段。

### 1.3 "暂停视频流开发"意味着什么？

**意味着：将 pipeline 的执行终点从 `video_design` 截断到 `keyframe_design`。**

具体影响：
- Pipeline 定义中 `step_key` 的合法值集合不变，但 V1 只执行到 `keyframe_design`
- 前端 PipelineArea 的 step 导航中，`video` 和 `edit` 步骤标记为"即将上线"
- StoryboardArea 中的"图生转场"按钮保持占位状态
- 协同会话的 `task_type` 中 `video_design` 暂不启用

**零代码回退成本**，因为视频生成的后端实现不存在。

---

## 2. 项目策略：复用 vs 新建

### 2.1 方案 A：在 Woohoo 中开发

**优势：**

| 复用资产 | 代码位置 | 复用价值 |
|----------|----------|----------|
| JWT 认证体系 | [auth/](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/) | 注册/登录/中间件/Token 刷新，完整闭环 |
| AI 用量追踪 | [usage.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/usage.rs) | 1262 行，已追踪 resource_kind=Image |
| AI 任务系统 | [runtime.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/runtime.rs) | 同步/流式/异步三种模式 |
| Pipeline 编排 | [orchestrator.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/pipeline/orchestrator.rs) | 步骤状态机 + Review Gate + Retry |
| 资产系统 | [generation.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/generation.rs) | `AiGenerationMethod::ImageGeneration` 已定义 |
| 项目管理 | [project/](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/project/) | 项目 CRUD + workspace 切换 |
| 前端 UI 框架 | ChatArea, Workspace, StoryboardArea | 对话驱动 + 可视化工作区 |
| SSE 推送 | [usePendingTaskSse.ts](file:///c:/Users/lxy/Desktop/work/woohoo/src/context/hooks/usePendingTaskSse.ts) | 实时任务状态推送 |

**风险：**

| 风险 | 严重度 | 缓解方案 |
|------|--------|----------|
| 协同模块的 6 个端到端缺口 | 中 | 图片生成 V1 不依赖协同，可并行 |
| SQLite 单文件在高并发写入时的锁竞争 | 低 | 图片生成是低频操作，单用户场景足够 |
| 代码库已较大，新增功能需注意模块边界 | 低 | 图片生成作为独立模块 `server/src/image_gen/` |

### 2.2 方案 B：新建项目

**优势：**
- 干净架构，无历史包袱
- 可选择更适合的技术栈（如 PostgreSQL、Redis）

**劣势：**

| 需重写的资产 | 预估工作量 |
|-------------|-----------|
| JWT 认证（注册/登录/中间件/Token 管理） | 3-5 天 |
| AI 客户端（OpenAI 兼容/流式/重试/fallback） | 5-7 天 |
| AI 任务运行时（队列/并发控制/SSE 推送） | 5-7 天 |
| 用量追踪系统（记录/聚合/查询 API） | 3-5 天 |
| 资产管理（CRUD/文件上传/类型推断） | 2-3 天 |
| 项目管理 | 2-3 天 |
| 前端 UI 框架（对话/工作区/设置） | 10-15 天 |
| **合计重写** | **30-45 天** |

### 2.3 明确建议

**强烈建议方案 A：在 Woohoo 中开发。**

理由：
1. 可复用资产价值约 30-45 天工作量，新建等于白扔。
2. 认证和用量追踪已经完成用户认为不存在的两个核心能力。
3. 图片生成在 Woohoo 的 pipeline 框架下是自然延伸，不是外来功能。
4. 唯一真正需要新建的是：图片生成 API 层 + 计费扣减层 + 前端图片生成交互。

---

## 3. 登录/计费/数据隔离的技术评估

### 3.1 认证系统现状

**已完整实现，无需开发。**

| 组件 | 文件 | 功能 |
|------|------|------|
| JWT 生成/验证 | [jwt.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/jwt.rs) | HS256 签名，可配置过期时间 |
| 认证中间件 | [middleware.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/middleware.rs) | Bearer Token 提取 + 用户存在性校验 |
| 注册 API | [handlers.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/handlers.rs) | 用户名/邮箱/密码 + bcrypt 哈希 + 唯一性校验 |
| 登录 API | [handlers.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/handlers.rs) | 邮箱+密码验证 + Token 签发 |
| 用户信息 API | [handlers.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/auth/handlers.rs) | GET /api/auth/me |
| 前端认证 UI | [AuthModal.tsx](file:///c:/Users/lxy/Desktop/work/woohoo/src/components/Auth/AuthModal.tsx) | 登录/注册表单 |
| 前端会话管理 | [serverApi.ts](file:///c:/Users/lxy/Desktop/work/woohoo/src/lib/serverApi.ts) | Token 持久化 + 自动刷新 + 401 重试 |

路由层面，所有 `/api/*` 路由（除 `/api/auth/login` 和 `/api/auth/register`）均已受 `auth_middleware` 保护。

**结论：登录系统已闭环，零开发量。**

### 3.2 计费系统现状

**用量追踪已完整，计费扣减层需新建。**

已存在的用量追踪能力（[usage.rs](file:///c:/Users/lxy/Desktop/work/woohoo/server/src/ai/usage.rs)，1262 行）：

- `ai_usage_events` 表：每次 AI 调用记录 user_id、model、tokens、latency、resource_kind
- `AiUsageResourceKind` 枚举已包含 `Image` 变体
- 聚合 API：`GET /api/ai/usage/summary` + `GET /api/ai/usage/records`
- 前端用量面板：[UsageDashboard.tsx](file:///c:/Users/lxy/Desktop/work/woohoo/src/components/Settings/UsageDashboard.tsx)

**需要新建的计费层：**

| 需求 | 实现方案 | 工作量 |
|------|----------|--------|
| 用户配额/余额 | 新增 `user_credits` 表：user_id, balance, total_granted, total_consumed | 1 天 |
| 扣减逻辑 | 图片生成前检查余额 -> 扣减 -> 生成 -> 失败回退 | 2 天 |
| 配额查询 API | GET /api/credits/balance | 0.5 天 |
| 配额充值（V1 简化） | 管理员手动充值或注册赠送 | 1 天 |
| 前端余额展示 | 在 Settings 或顶部展示剩余额度 | 0.5 天 |

**SQLite 能否支撑计费场景？**

能。理由：
1. 计费是低频写入操作（每次图片生成 1 次扣减），不是高频交易。
2. SQLite 的 ACID 事务保证扣减的原子性。
3. 单用户场景下无并发冲突。
4. 如果未来需要多实例部署，计费层可独立迁移到 PostgreSQL，但 V1 不需要。

### 3.3 数据隔离现状

**逻辑隔离已存在，硬隔离需加固。**

当前隔离机制：
- 所有核心表均有 `user_id` 字段 + `REFERENCES users(id) ON DELETE CASCADE`
- 所有查询均按 `user_id` 过滤（workspace bootstrap、usage summary、project list 等）
- 前端会话按 userId 隔离本地缓存

需要加固的点：

| 加固项 | 方案 | 工作量 |
|--------|------|--------|
| API 层 user_id 一致性审计 | 确认所有 handler 均从 `Extension<UserId>` 取 user_id，不从请求体取 | 1 天 |
| 资产文件存储隔离 | 上传文件按 `data/{user_id}/` 目录隔离 | 0.5 天 |
| SQLite WAL 模式确认 | 确认已启用 WAL（写时不阻塞读） | 0 天（已启用） |

**SQLite 单文件架构下的数据隔离结论：**
- 逻辑隔离（user_id 过滤）对 V1 足够
- 物理隔离（每用户一个 DB 文件）在 V1 不需要，增加复杂度但无收益
- 如果未来做 SaaS 多租户，再迁移到 PostgreSQL + Row Level Security

### 3.4 改造对现有代码的影响范围

| 改造项 | 影响范围 | 破坏性 |
|--------|----------|--------|
| 新增 user_credits 表 | 新增 migration，不影响现有表 | 无 |
| 图片生成扣减逻辑 | 新增 `server/src/billing/` 模块，在图片生成 handler 中调用 | 无（新增调用点） |
| API 层 user_id 审计 | 可能修正个别 handler 的 user_id 来源 | 低（修正 Bug） |
| 资产文件目录隔离 | 修改 `asset::handlers::upload_asset` 的存储路径 | 低（新文件走新路径，旧文件兼容） |

---

## 4. 图片生成的产品定义

### 4.1 在 Woohoo 框架下的定位

图片生成在 Woohoo 中有**双重身份**：

1. **Pipeline 步骤**：作为 `keyframe_design` 步骤的产出，服务于短剧/短视频的分镜可视化
2. **独立能力**：用户可在对话中直接请求生成图片，不依赖 pipeline

V1 应优先实现第 2 种（独立能力），原因：
- 独立能力的用户旅程更短，可更快验证
- Pipeline 步骤的图片生成可复用独立能力的底层实现
- 独立能力上线后，再将其接入 pipeline 是配置工作，不是开发工作

### 4.2 用户旅程

```
用户进入项目
  |
  v
在对话区输入："帮我生成一张赛博朋克风格的城市场景图"
  |
  v
系统识别为图片生成意图（或用户手动选择图片生成模式）
  |
  v
后端创建 AI 任务，调用图片生成模型 API
  |
  v
SSE 推送任务状态：queued -> running -> completed
  |
  v
对话区展示生成的图片（作为消息附件）
  |
  v
图片自动保存为项目资产，可在 StoryboardArea 中引用
  |
  v
用户可：重新生成 / 基于该图做图生图 / 下载
```

### 4.3 需要的新功能

| 功能 | 后端 | 前端 | 优先级 |
|------|------|------|--------|
| 图片生成 API | 新增 `POST /api/ai/image/generate` | - | P0 |
| 图片生成模型集成 | 在 AiClient 中新增图片生成调用路径 | - | P0 |
| 计费扣减 | 生成前检查余额，扣减后执行 | - | P0 |
| 余额查询 | `GET /api/credits/balance` | 余额展示组件 | P0 |
| 图片结果展示 | - | 对话区图片附件渲染 | P0 |
| 图片生成参数 UI | - | 尺寸/风格/模型选择面板 | P1 |
| 图生图 | `POST /api/ai/image/variations` | StoryboardArea 集成 | P1 |
| 图片历史浏览 | `GET /api/projects/{id}/assets?type=image` | 资产面板图片筛选 | P2 |

---

## 5. 实施建议

### 5.1 开发顺序（在现有 Woohoo 项目中）

```
Phase 0: 基础设施加固（2 天）
  ├── 0.1 API 层 user_id 一致性审计
  ├── 0.2 资产文件按 user_id 目录隔离
  └── 0.3 确认所有 handler 均走 auth_middleware

Phase 1: 计费基础层（3 天）
  ├── 1.1 新增 user_credits 表 migration
  ├── 1.2 新增 server/src/billing/ 模块（余额查询、扣减、回退）
  ├── 1.3 GET /api/credits/balance API
  └── 1.4 注册时赠送初始额度

Phase 2: 图片生成核心（5 天）
  ├── 2.1 新增 server/src/image_gen/ 模块
  ├── 2.2 AiClient 新增图片生成调用路径（OpenAI Images API 兼容格式）
  ├── 2.3 POST /api/ai/image/generate API（含计费扣减）
  ├── 2.4 图片生成结果保存为资产 + 消息附件
  └── 2.5 SSE 推送图片生成任务状态

Phase 3: 前端集成（5 天）
  ├── 3.1 对话区图片附件渲染
  ├── 3.2 图片生成参数面板（尺寸/风格选择）
  ├── 3.3 余额展示组件
  ├── 3.4 图片重新生成 / 下载交互
  └── 3.5 StoryboardArea 中"生成画面"按钮接入

Phase 4: 上线准备（2 天）
  ├── 4.1 端到端测试
  ├── 4.2 计费异常场景测试（余额不足、生成失败回退）
  └── 4.3 Pipeline 中 keyframe_design 步骤接入图片生成

总计：约 17 天（3.5 周）
```

### 5.2 如果新建项目（不推荐，仅供参考）

| 维度 | 选型 | 理由 |
|------|------|------|
| 后端框架 | Rust + Axum | 与 Woohoo 一致，团队熟悉 |
| 数据库 | PostgreSQL | 多租户场景更优，但 V1 过度 |
| 前端框架 | React + Vite | 与 Woohoo 一致 |
| 认证 | JWT | 需从零实现 |
| AI 客户端 | OpenAI 兼容 | 需从零实现 |
| 预估总工作量 | 45-60 天 | 含重写基础设施 |

### 5.3 工作量对比

| 方案 | 工作量 | 可复用资产 | 风险 |
|------|--------|-----------|------|
| 方案 A：在 Woohoo 中开发 | 17 天 | 30-45 天价值 | 低 |
| 方案 B：新建项目 | 45-60 天 | 0 | 高（重写风险 + 延迟上线） |

---

## 6. Not-To-Do List（V1 边界警示）

| 禁止项 | 理由 |
|--------|------|
| 视频生成功能 | V1 只做图片生成，视频是 V2 |
| 协同会话与图片生成的联动 | 协同的 6 个端到端缺口未补齐，联动增加复杂度 |
| 图片生成的批量/队列模式 | V1 单张生成足够验证，批量是优化项 |
| 自建图片生成模型推理 | V1 调用第三方 API（OpenAI/Stability AI），自建推理是基础设施问题 |
| PostgreSQL 迁移 | SQLite 对 V1 单用户场景足够，迁移是 V2+ 的架构演进 |
| 物理数据隔离（每用户独立 DB） | 逻辑隔离对 V1 足够，物理隔离是 SaaS 多租户需求 |
| 订阅/支付集成 | V1 用额度赠送 + 手动充值，在线支付是 V2 |
| 图片编辑/修图功能 | V1 只做生成，编辑是独立产品线 |

---

## 7. 铁腕审计总结

### 内部审计过程

| 功能点 | 审计结果 | 理由 |
|--------|----------|------|
| 图片生成核心 API | **保留** | 产品 DNA：将创意转化为视觉内容 |
| 计费扣减层 | **保留** | 上线必需，防止资源滥用 |
| 余额查询/展示 | **保留** | 计费闭环的用户侧可见性 |
| 图片结果展示 | **保留** | 核心交互闭环 |
| 登录/认证 | **保留但无需开发** | 已存在完整实现 |
| 用量追踪 | **保留但无需开发** | 已存在完整实现 |
| 数据隔离加固 | **保留** | 上线前必须确认 user_id 一致性 |
| 视频生成 | **驳回** | V1 不做，图片生成是前置依赖 |
| 协同联动 | **驳回** | 协同模块未闭环，联动增加风险 |
| 批量生成 | **驳回** | V1 验证单张足够 |
| 自建推理 | **驳回** | V1 调用第三方 API |
| 在线支付 | **驳回** | V1 手动充值足够 |
| 图片编辑 | **驳回** | 独立产品线，稀释核心 |

### Project DNA

将文字创意转化为视觉图片，通过对话驱动 + AI 生成 + 计费管控实现闭环。

### First Action Path

用户输入描述 -> 系统生成图片 -> 展示结果并保存为资产。

### Technical Constraints

- **Data Model**: { UserCredits(user_id, balance, total_granted, total_consumed), ImageGenTask(prompt, model, size, status, asset_id, credit_cost) }
- **State Machine**: ImageGenTask[created -> billing_checked -> generating -> completed/failed]
- **Billing Flow**: check_balance -> deduct -> generate -> on_failure: refund

### Feature Spec

1. **图片生成 API**：接收 prompt + 参数，调用第三方图片模型，返回图片 URL。
2. **计费扣减**：生成前检查余额并扣减，失败时回退。
3. **余额管理**：注册赠送额度，查询余额 API。
4. **图片展示**：对话区渲染图片附件，自动保存为项目资产。
5. **数据隔离加固**：确认所有 API 的 user_id 来源一致性。
