# 图片生成独立区域分析报告

> 版本: v2.0.0 | 日期: 2026-05-12 | 审计人: 技术型产品经理
> 前置文档: [image-generation-strategy-analysis.md](./image-generation-strategy-analysis.md) (v1.0.0)

---

## 0. 审计前置：用户澄清带来的范式变化

v1.0.0 的分析基于"图片生成是 Woohoo pipeline 的一个步骤"这一假设，推荐了方案 A（在 Woohoo 内开发）。

用户澄清"单独做一个图片生成的区域"后，核心假设被推翻：

| 维度 | v1.0.0 假设 | 用户澄清后的实际需求 |
|------|-------------|---------------------|
| 产品定位 | Woohoo 的功能增强 | 独立的图片生成产品 |
| 用户心智 | "在 Woohoo 里生成图片" | "这是一个图片生成工具" |
| 交互模式 | 对话驱动 + pipeline 步骤 | 独立工作区，专注图片生成 |
| 与视频创作的关系 | 前置步骤 | 独立产品线，可后续打通 |

这一范式变化要求重新评估所有方案。

---

## 1. 三种方案的铁腕审计

### 1.1 方案 A：Woohoo 内的独立 Tab/区域

**实现方式**：在 Workspace 的 `currentTab` 联合类型中新增 `'imageStudio'`，新增 `ImageStudioArea` 组件，后端新增 `server/src/image_gen/` 模块。

**代码审计事实**：

| 维度 | 现状 | 影响 |
|------|------|------|
| Workspace.tsx | `currentTab` 当前为 `'chat' \| 'pipeline' \| 'assets' \| 'automation' \| 'skills' \| 'preview'` | 新增 tab 是配置级改动，成本低 |
| Sidebar.tsx | 项目列表 + 导航，与 tab 切换解耦 | 无需改动 |
| ActiveState 类型 | [types/index.ts](../src/types/index.ts) L230-234 | 新增联合类型成员即可 |
| 后端路由 | [main.rs](../server/src/main.rs) 已有 auth/ai/asset/pipeline 等模块 | 新增 image_gen 模块无破坏性 |
| AiClient | [client.rs](../server/src/ai/client.rs) 仅支持 chat completions | 需新增 images API 调用路径 |
| AiGenerationMethod | [generation.rs](../server/src/ai/generation.rs) L32-36 已定义 `ImageGeneration` | 数据模型已预留 |

**优势**：

1. **基础设施零成本复用**。JWT 认证、AI 任务运行时、SSE 推送、用量追踪、资产管理全部现成可用，节省 30-45 天重写工作量。
2. **用户统一入口**。登录一次，视频创作和图片生成都能用。
3. **数据天然互通**。图片生成结果自动成为项目资产，未来 Woohoo 的 Storyboard 可直接引用，无需跨系统数据同步。
4. **代码改动量最小**。前端新增 1 个 Tab + 1 个 Area 组件；后端新增 1 个模块 + 1 个 migration。

**劣势**：

1. **产品定位模糊化**。Woohoo 的品牌从"短剧创作"变成"短剧创作 + 图片生成"，用户心智分裂。
2. **UI 复杂度增加**。Tab 栏已有 5 个标签，再加 1 个会导致信息密度过高。
3. **图片生成被项目上下文绑定**。用户必须先创建项目才能使用图片生成，这与"独立图片生成工具"的心智不符。

**铁腕审计结论**：

方案 A 的核心问题是**产品定位冲突**。用户明确说"单独做一个图片生成的区域"，意味着图片生成应该有自己的入口、自己的工作流、自己的空间，而不是挤在 Woohoo 的 tab 栏里。如果图片生成必须先创建项目、进入项目、切换 tab 才能用，那就不是"独立区域"，而是"附属功能"。

**审计结果：驳回。** 理由：与用户"独立区域"的意图矛盾，产品定位冲突。

---

### 1.2 方案 B：完全独立的新项目

**实现方式**：新建独立的前后端代码仓库，独立部署，独立域名。

**需要重写的资产清单**（基于代码审计）：

| 资产 | 对应 Woohoo 代码 | 重写工作量 | 必要性 |
|------|------------------|-----------|--------|
| JWT 认证体系 | [auth/](../server/src/auth/) (4 文件) | 3-5 天 | 必须 |
| AI 客户端 | [client.rs](../server/src/ai/client.rs) | 5-7 天 | 必须 |
| AI 任务运行时 | [runtime.rs](../server/src/ai/runtime.rs) | 5-7 天 | 必须 |
| SSE 推送 | [task_handlers.rs](../server/src/ai/task_handlers.rs) | 3-4 天 | 必须 |
| 用量追踪 | [usage.rs](../server/src/ai/usage.rs) (1262 行) | 3-5 天 | 必须 |
| 资产管理 | [asset/](../server/src/asset/) (4 文件) | 2-3 天 | 必须 |
| 项目管理 | [project/](../server/src/project/) | 2-3 天 | 可简化 |
| 前端 UI 框架 | Auth/Settings/Toast/ErrorBoundary | 10-15 天 | 必须 |
| 前端状态管理 | Zustand store + Context hooks | 5-7 天 | 必须 |
| **合计** | | **38-60 天** | |

**优势**：

1. **定位绝对清晰**。独立产品、独立品牌、独立域名。
2. **技术栈自由**。可选择更适合图片生成的技术方案（如 PostgreSQL、对象存储）。
3. **迭代不受 Woohoo 牵制**。图片生成的需求变更不会影响视频创作系统。

**劣势**：

1. **重写成本极高**。38-60 天的基础设施重写，其中 80% 是与图片生成无关的通用能力。
2. **用户数据割裂**。Woohoo 的用户和图片生成的用户是两套体系，未来打通需要用户映射和数据同步。
3. **运维成本翻倍**。两套部署、两套监控、两套数据库备份。
4. **代码重复**。认证、AI 客户端、任务运行时等代码会被复制一份，后续维护两份。

**铁腕审计结论**：

方案 B 的核心问题是**投入产出比极低**。38-60 天的工作量中，只有约 5-7 天是图片生成特有的逻辑（调用图片模型 API + 前端图片工作区 UI），其余 85% 都是在重写 Woohoo 已有的基础设施。这不是"做新产品"，而是"重新造轮子"。

**审计结果：驳回。** 理由：重写成本与核心价值不匹配，85% 的工作量在重复造轮子。

---

### 1.3 方案 C：Monorepo 共享基础设施（推荐）

**实现方式**：在现有 Woohoo 仓库内，新建独立前端应用入口，共享后端和基础设施。用户通过不同 URL 路径进入不同产品。

**架构设计**：

```
woohoo/                              (Monorepo 根目录)
├── server/                          (共享后端 - Rust Axum)
│   └── src/
│       ├── auth/                    (共享认证)
│       ├── ai/                      (共享 AI 运行时)
│       │   ├── client.rs            (新增 images API 调用路径)
│       │   ├── generation.rs        (已有 ImageGeneration 方法)
│       │   └── image_gen/           (新增：图片生成专用 handler)
│       │       ├── handlers.rs      (图片生成 API)
│       │       ├── model.rs         (图片生成数据模型)
│       │       └── repo.rs          (图片生成数据访问)
│       ├── billing/                 (新增：计费模块)
│       │       ├── handlers.rs
│       │       ├── model.rs
│       │       └── repo.rs
│       ├── asset/                   (共享资产管理)
│       └── main.rs                  (路由注册：新增 /api/image-gen/* 路由组)
│
├── src/                             (Woohoo 前端 - 视频创作)
│   ├── App.tsx                      (入口：/ 路径)
│   └── features/studio/             (现有 UI)
│
├── src-image-studio/                (新增：图片工作室前端 - 独立 SPA)
│   ├── App.tsx                      (入口：/image-studio 路径)
│   ├── features/
│   │   └── image-studio/            (图片生成专用 UI)
│   │       ├── PromptPanel.tsx      (提示词输入面板)
│   │       ├── ImageGallery.tsx     (生成结果画廊)
│   │       ├── ImageDetail.tsx      (图片详情/操作)
│   │       └── HistoryList.tsx      (生成历史)
│   ├── store/
│   ├── lib/
│   │   └── serverApi.ts             (复用 API 调用模式)
│   └── main.tsx
│
├── vite.config.ts                   (Woohoo 前端构建)
└── vite.image-studio.config.ts      (图片工作室前端构建)
```

**路由分离策略**：

```
前端路由：
  /                    -> Woohoo 视频创作 SPA
  /image-studio        -> 图片工作室 SPA

后端路由（共享）：
  /api/auth/*          -> 共享认证
  /api/ai/*            -> 共享 AI 运行时
  /api/assets/*        -> 共享资产管理
  /api/credits/*       -> 共享计费
  /api/image-gen/*     -> 图片生成专用 API
  /api/workspace/*     -> Woohoo 专用
  /api/pipelines/*     -> Woohoo 专用
  /api/collaboration/* -> Woohoo 专用
```

**代码审计支撑**：

| 复用资产 | 代码位置 | 复用方式 | 改动量 |
|----------|----------|----------|--------|
| JWT 认证 | [auth/](../server/src/auth/) | 直接复用，零改动 | 0 天 |
| AI 客户端 | [client.rs](../server/src/ai/client.rs) | 新增 `generate_image` 方法 | 2 天 |
| AI 任务运行时 | [runtime.rs](../server/src/ai/runtime.rs) | 直接复用 | 0 天 |
| SSE 推送 | [task_handlers.rs](../server/src/ai/task_handlers.rs) | 直接复用 | 0 天 |
| 用量追踪 | [usage.rs](../server/src/ai/usage.rs) | 直接复用，`Image` 变体已存在 | 0 天 |
| 资产管理 | [asset/](../server/src/asset/) | 直接复用 | 0 天 |
| AiGenerationMethod | [generation.rs](../server/src/ai/generation.rs) L32-36 | `ImageGeneration` 已定义 | 0 天 |
| MessageAttachment | [types/index.ts](../src/types/index.ts) L151-159 | 前端类型已支持 `ai_generated` | 0 天 |

**优势**：

1. **产品定位清晰**。图片工作室有独立 URL、独立 UI、独立工作流，用户心智是"这是一个图片生成工具"。
2. **基础设施零成本复用**。认证、AI 运行时、SSE、用量追踪、资产管理全部共享，节省 30-45 天。
3. **数据天然互通**。共享 SQLite 数据库，图片生成结果自动成为资产，未来 Woohoo 的 Storyboard 可直接通过 asset_id 引用。
4. **独立迭代**。图片工作室前端是独立 SPA，可以独立构建、独立部署、独立更新，不影响 Woohoo 前端。
5. **渐进式独立**。如果未来图片工作室需要独立部署，只需将后端 image_gen 模块拆分为微服务，前端已经是独立的。
6. **开发成本最低**。只需新建前端 SPA + 后端新增 image_gen 模块 + 计费模块。

**劣势**：

1. **后端耦合**。图片生成和视频创作共享同一个 Axum 进程，一个崩溃全部崩溃。但 V1 阶段这是可接受的。
2. **构建配置复杂度**。需要维护两套 Vite 配置。但这是配置级工作，不是架构级风险。
3. **部署需协调**。如果未来需要独立扩缩容，需要拆分后端。但 V1 不需要。

**铁腕审计结论**：

方案 C 是唯一同时满足"独立产品体验"和"基础设施复用"的方案。它通过前端路由分离实现了产品独立性，通过 Monorepo 共享后端实现了基础设施复用，通过共享数据库实现了数据互通。三个核心需求全部满足。

**审计结果：通过。** 推荐方案 C。

---

## 2. 方案对比矩阵

| 评估维度 | 方案 A (Woohoo Tab) | 方案 B (独立项目) | 方案 C (Monorepo) |
|----------|---------------------|-------------------|-------------------|
| 产品独立性 | 差 (附属功能) | 优 (完全独立) | 良 (独立入口+独立UI) |
| 基础设施复用 | 优 (全部复用) | 差 (全部重写) | 优 (全部复用) |
| 数据互通 | 优 (同库同表) | 差 (跨库同步) | 优 (同库同表) |
| 开发工作量 | 15-17 天 | 38-60 天 | 18-22 天 |
| 迭代独立性 | 差 (受 Woohoo 牵制) | 优 (完全独立) | 良 (前端独立，后端共享) |
| 运维成本 | 低 | 高 (双倍) | 低 |
| 未来独立部署 | 不适用 | 已独立 | 可渐进拆分 |
| 用户心智 | 混乱 (视频工具里生图) | 清晰 | 清晰 |

---

## 3. 图片生成产品定义

### 3.1 Project DNA

将文字描述转化为高质量图片，提供从创意到成图的一站式生成体验。

### 3.2 First Action Path

用户输入提示词 -> 系统生成图片 -> 展示结果 -> 保存为资产。

### 3.3 目标用户

| 维度 | 定义 |
|------|------|
| 主要用户 | 有图片生成需求的创作者（设计师、内容运营、自媒体） |
| 与 Woohoo 用户的关系 | 高度重叠。短剧创作者需要生成分镜画面、角色设定图、场景概念图 |
| 差异化用户 | 不做视频但需要 AI 生图的纯图片用户 |

### 3.4 核心功能（铁腕审计后）

| 功能 | 优先级 | 理由 |
|------|--------|------|
| 文生图 (Text-to-Image) | P0 | 产品 DNA，没有它产品不成立 |
| 生成结果展示与下载 | P0 | 核心交互闭环 |
| 计费扣减 | P0 | 防止资源滥用，上线必需 |
| 余额查询 | P0 | 计费闭环的用户侧可见性 |
| 图片生成参数 (尺寸/风格/模型) | P1 | 提升生成质量，但 V1 可用默认值 |
| 图生图 (Image-to-Image) | P1 | 基于已有图片做变体，是核心差异化能力 |
| 生成历史 | P1 | 用户需要回溯和复用历史生成结果 |
| 批量生成 | P2 | V1 验证单张足够，批量是优化项 |
| 风格预设库 | P2 | 降低提示词门槛，但非 MVP |

### 3.5 差异化定位

与市面产品的对比：

| 产品 | 定位 | Woohoo 图片工作室的差异化 |
|------|------|--------------------------|
| Midjourney | 艺术创作导向，Discord 交互 | 本地优先 + Web 原生 + 与视频创作数据互通 |
| DALL-E | OpenAI 生态内嵌，ChatGPT 附属 | 独立工作区 + 专业参数控制 + 资产管理 |
| Stable Diffusion WebUI | 开源，技术用户导向 | 零部署门槛 + 计费管控 + 统一认证 |
| ComfyUI | 工作流编排，专业用户 | 简化交互 + 对话驱动 + 一键生成 |

**核心差异化**：本地优先 + 零部署 + 与视频创作数据天然互通。用户在图片工作室生成的分镜画面，可以直接在 Woohoo 的 Storyboard 中引用，这是任何独立图片生成工具做不到的。

### 3.6 用户旅程

```
用户访问 /image-studio
  |
  v
展示图片工作室首页（提示词输入区 + 参数面板 + 生成历史）
  |
  v
用户输入提示词："赛博朋克风格的城市场景，霓虹灯，雨夜"
  |
  v
[可选] 用户调整参数：尺寸 1024x1024 / 模型 dall-e-3 / 风格 vivid
  |
  v
点击"生成"按钮
  |
  v
前端调用 POST /api/image-gen/generate
  |
  v
后端：检查余额 -> 扣减 -> 调用图片模型 API -> 保存结果 -> 推送 SSE
  |
  v
前端：展示生成中的 loading 状态 -> 接收 SSE -> 展示生成结果
  |
  v
用户可：下载 / 重新生成 / 基于该图做图生图 / 查看历史
```

---

## 4. 技术可行性评估

### 4.1 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端框架 | React + Vite + Zustand | 与 Woohoo 一致，团队零学习成本 |
| UI 组件库 | Arco Design | 与 Woohoo 一致 |
| 后端框架 | Rust + Axum | 共享后端，无需额外选型 |
| 数据库 | SQLite | 共享数据库，V1 足够 |
| 图片存储 | 本地文件系统 `data/assets/` | 与 Woohoo 一致，V1 足够 |

### 4.2 图片生成 API 选型

| API | 优势 | 劣势 | V1 推荐 |
|-----|------|------|---------|
| OpenAI Images API (DALL-E 3) | 质量稳定，API 简单，与现有 AiClient 的 OpenAI 兼容架构天然匹配 | 成本较高，风格偏写实 | 是 |
| Stability AI | 风格多样，支持图生图 | API 复杂度高于 DALL-E | V2 |
| ComfyUI (自建) | 完全可控，成本最低 | 需要 GPU 服务器，运维复杂 | V3+ |
| Replicate | 模型丰富 | 延迟高，依赖第三方 | 不推荐 |

**V1 推荐**：OpenAI Images API (DALL-E 3)。

理由：
1. 现有 [AiClient](../server/src/ai/client.rs) 已实现 OpenAI 兼容的 HTTP 客户端，新增 `generate_image` 方法只需约 100 行代码。
2. DALL-E 3 的 API 格式与 chat completions 共享 base_url 和 api_key 配置，用户无需额外配置。
3. 质量稳定，文档完善，调试成本低。

**API 调用格式**：

```rust
// POST {base_url}/v1/images/generations
// Request:
{
  "model": "dall-e-3",
  "prompt": "赛博朋克风格的城市场景",
  "n": 1,
  "size": "1024x1024",
  "quality": "standard",
  "style": "vivid"
}
// Response:
{
  "data": [
    {
      "url": "https://...",
      "revised_prompt": "..."
    }
  ]
}
```

### 4.3 计费模型

| 维度 | V1 方案 | V2 演进 |
|------|---------|---------|
| 计费单位 | Credits (1 Credit = 1 次生成) | 按 token/分辨率差异化计费 |
| 定价 | DALL-E 3 标准质量: 1 Credit/张 | 根据模型和分辨率差异化 |
| 初始额度 | 注册赠送 20 Credits | 订阅制 |
| 充值方式 | 管理员手动充值 | 在线支付 |
| 余额不足 | 拦截生成请求，提示余额不足 | 引导充值 |

### 4.4 存储方案

| 维度 | V1 方案 |
|------|---------|
| 图片存储位置 | `data/assets/{user_id}/` 目录 |
| 图片格式 | PNG (DALL-E 3 默认输出) |
| 元数据 | `assets` 表，type='image'，metadata 记录 prompt/model/size |
| 缩略图 | 前端按需缩放，V1 不生成缩略图 |
| 容量限制 | 用户级总容量限制（复用现有 asset 限制机制） |

---

## 5. 与 Woohoo 的关系

### 5.1 当前关系：互补

图片工作室和 Woohoo 视频创作是**互补关系**，不是替代关系：

```
图片工作室 (独立产品)          Woohoo 视频创作 (独立产品)
  |                              |
  | 生成图片资产                  | 引用图片资产
  |                              |
  v                              v
  +--------- 共享资产库 ---------+
              |
              v
         SQLite assets 表
```

### 5.2 未来打通路径

| 打通场景 | 实现方式 | 优先级 |
|----------|----------|--------|
| Storyboard 引用图片工作室生成的图片 | 图片工作室生成的图片保存为项目资产，Storyboard 通过 asset_id 引用 | P1 |
| 图片工作室直接打开 Woohoo 中的图片做图生图 | 前端通过 URL 参数传递 asset_id | P2 |
| 统一项目管理 | 图片工作室支持"关联到项目"，生成的图片自动归入项目资产 | P2 |

### 5.3 数据模型设计

**共享资产表**（已有，无需新建）：

```sql
-- assets 表已存在，图片工作室直接写入
INSERT INTO assets (id, project_id, name, type, url, metadata, created_at, updated_at)
VALUES (?, ?, ?, 'image', ?, ?, ?, ?);

-- metadata JSON 扩展：
{
  "source": "ai_generated",
  "generatedAt": "2026-05-12T10:00:00Z",
  "method": {
    "type": "image_generation",
    "model": "dall-e-3",
    "prompt": "赛博朋克城市场景",
    "size": "1024x1024"
  },
  "originApp": "image-studio"  -- 标记来源，区分 Woohoo pipeline 生成和图片工作室生成
}
```

**新增表**：

```sql
-- 图片生成任务表（独立于 ai_tasks，记录图片生成特有字段）
CREATE TABLE image_gen_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT,  -- 可选，关联到项目时填写
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  model TEXT NOT NULL DEFAULT 'dall-e-3',
  size TEXT NOT NULL DEFAULT '1024x1024',
  quality TEXT NOT NULL DEFAULT 'standard',
  style TEXT NOT NULL DEFAULT 'vivid',
  n INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'created',  -- created/billing_checked/generating/completed/failed
  asset_id TEXT,  -- 生成成功后关联 assets 表
  credit_cost INTEGER NOT NULL DEFAULT 1,
  revised_prompt TEXT,  -- DALL-E 3 返回的优化后 prompt
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户积分表
CREATE TABLE user_credits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  total_granted INTEGER NOT NULL DEFAULT 0,
  total_consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 积分变动记录表
CREATE TABLE credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,  -- 正数=充值，负数=消费
  balance_after INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,  -- grant/consume/refund
  reference_type TEXT,  -- image_gen_task/registration/manual_grant
  reference_id TEXT,  -- 关联的 task_id 或操作 ID
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**状态机**：

```
ImageGenTask 状态流转：

created ──> billing_checked ──> generating ──> completed
   |              |                 |
   |              |                 v
   |              |             failed (refund)
   |              v
   |         billing_failed (余额不足)
   v
 cancelled
```

---

## 6. 实施方案

### 6.1 MVP 范围

| 包含 | 不包含 |
|------|--------|
| 文生图 (DALL-E 3) | 图生图 |
| 生成结果展示与下载 | 风格预设库 |
| 计费扣减 (Credits) | 在线支付 |
| 余额查询 | 订阅制 |
| 生成历史列表 | 批量生成 |
| 独立前端入口 (/image-studio) | Woohoo 内 Tab |
| 图片保存为资产 | Storyboard 集成 |

### 6.2 开发路径

```
Phase 0: 基础设施准备（2 天）
  ├── 0.1 新增 src-image-studio/ 目录结构 + Vite 配置
  ├── 0.2 新增 vite.image-studio.config.ts
  ├── 0.3 后端路由注册 /api/image-gen/* 路由组
  └── 0.4 package.json 新增 image-studio 构建脚本

Phase 1: 计费基础层（3 天）
  ├── 1.1 新增 user_credits / credit_transactions 表 migration
  ├── 1.2 新增 server/src/billing/ 模块
  │   ├── model.rs (UserCredits, CreditTransaction)
  │   ├── repo.rs (余额查询、扣减、回退、充值)
  │   └── handlers.rs (GET /api/credits/balance)
  └── 1.3 注册时赠送初始额度 (20 Credits)

Phase 2: 图片生成核心后端（5 天）
  ├── 2.1 新增 image_gen_tasks 表 migration
  ├── 2.2 AiClient 新增 generate_image() 方法
  │   └── 调用 POST {base_url}/v1/images/generations
  ├── 2.3 新增 server/src/image_gen/ 模块
  │   ├── model.rs (ImageGenTask, 状态机)
  │   ├── repo.rs (CRUD + 状态流转)
  │   └── handlers.rs
  │       ├── POST /api/image-gen/generate (创建任务+计费扣减+调用模型)
  │       ├── GET /api/image-gen/tasks (生成历史)
  │       └── GET /api/image-gen/tasks/{id} (任务详情)
  ├── 2.4 生成结果保存为资产 (复用 save_ai_generated_asset)
  └── 2.5 SSE 推送图片生成任务状态 (复用现有 SSE 机制)

Phase 3: 图片工作室前端（7 天）
  ├── 3.1 src-image-studio/ 基础框架
  │   ├── main.tsx (入口)
  │   ├── App.tsx (路由 + 认证检查)
  │   └── store/ (Zustand 状态管理)
  ├── 3.2 提示词输入面板 (PromptPanel)
  │   ├── 提示词文本框
  │   ├── 参数选择 (尺寸/质量/风格)
  │   └── 生成按钮 + 余额显示
  ├── 3.3 生成结果画廊 (ImageGallery)
  │   ├── 网格展示生成结果
  │   ├── 生成中 loading 状态
  │   └── 图片预览 + 下载
  ├── 3.4 生成历史 (HistoryList)
  │   ├── 按时间倒序展示历史任务
  │   └── 状态筛选 (全部/成功/失败)
  └── 3.5 余额展示组件
      ├── 当前余额显示
      └── 余额不足提示

Phase 4: 集成与上线（3 天）
  ├── 4.1 前端路由整合 (/image-studio 入口)
  ├── 4.2 端到端测试
  ├── 4.3 计费异常场景测试 (余额不足、生成失败回退)
  └── 4.4 构建脚本整合 (dev + build)

总计：约 20 天（4 周）
```

### 6.3 工作量对比

| 方案 | 工作量 | 核心开发 | 基础设施重写 | 数据互通成本 |
|------|--------|----------|-------------|-------------|
| 方案 A (Woohoo Tab) | 15-17 天 | 15-17 天 | 0 | 0 |
| 方案 B (独立项目) | 38-60 天 | 5-7 天 | 33-53 天 | 高 (跨库同步) |
| **方案 C (Monorepo)** | **18-22 天** | **18-22 天** | **0** | **0** |

方案 C 比方案 A 多 3-5 天（前端独立 SPA 框架搭建），但换来了产品独立性。比方案 B 省 20-38 天（基础设施复用），且数据天然互通。

---

## 7. Not-To-Do List（V1 边界警示）

| 禁止项 | 理由 |
|--------|------|
| 在 Woohoo 的 Workspace Tab 栏中加"图片生成" | 与"独立区域"意图矛盾，产品定位冲突 |
| 图生图 (Image-to-Image) | V1 只做文生图，图生图需要额外的图片上传 + 模型调用路径 |
| 批量生成 | V1 验证单张生成足够，批量是优化项 |
| 风格预设库 | 降低提示词门槛是 P2 需求，V1 用户需自行编写 prompt |
| 自建图片生成模型推理 | V1 调用 OpenAI Images API，自建推理是基础设施问题 |
| 在线支付集成 | V1 用 Credits 赠送 + 手动充值，在线支付是 V2 |
| 订阅制 | V1 按次计费，订阅制需要支付系统支撑 |
| Storyboard 集成 | V1 图片工作室独立运行，与 Woohoo Storyboard 的打通是 V2 |
| 协同会话与图片生成的联动 | 协同模块未闭环，联动增加复杂度 |
| PostgreSQL 迁移 | SQLite 对 V1 足够，迁移是架构演进 |
| 图片编辑/修图功能 | V1 只做生成，编辑是独立产品线 |
| ComfyUI 工作流编排 | 专业用户功能，V1 面向普通创作者 |
| 多模型切换 UI | V1 只支持 DALL-E 3，多模型是 V2 |

---

## 8. 铁腕审计总结

### 内部审计过程

| 需求点 | 审计结果 | 理由 |
|--------|----------|------|
| 独立产品入口 | **保留** | 用户明确要求"独立区域" |
| 文生图核心 API | **保留** | 产品 DNA |
| 计费扣减层 | **保留** | 上线必需 |
| 余额查询/展示 | **保留** | 计费闭环 |
| 生成结果展示与下载 | **保留** | 核心交互闭环 |
| 生成历史 | **保留** | 用户回溯需求 |
| 图片生成参数 | **保留** | 提升生成质量 |
| Woohoo Tab 集成 | **驳回** | 与"独立区域"意图矛盾 |
| 图生图 | **驳回** | V1 只做文生图 |
| 批量生成 | **驳回** | V1 验证单张足够 |
| 风格预设库 | **驳回** | P2 需求 |
| 在线支付 | **驳回** | V2 |
| Storyboard 集成 | **驳回** | V2 打通 |
| 自建推理 | **驳回** | V1 调用第三方 API |
| 图片编辑 | **驳回** | 独立产品线 |

### Project DNA

将文字描述转化为高质量图片，提供从创意到成图的一站式生成体验。

### First Action Path

用户输入提示词 -> 系统生成图片 -> 展示结果 -> 保存为资产。

### Technical Constraints

- **Data Model**: { ImageGenTask(prompt, model, size, quality, style, status, asset_id, credit_cost), UserCredits(user_id, balance, total_granted, total_consumed), CreditTransaction(user_id, amount, balance_after, transaction_type, reference_type, reference_id) }
- **State Machine**: ImageGenTask[created -> billing_checked -> generating -> completed/failed]
- **Billing Flow**: check_balance -> deduct -> generate -> on_failure: refund
- **Frontend Architecture**: 独立 SPA (src-image-studio/)，共享后端 API

### Feature Spec

1. **文生图 API**：接收 prompt + 参数，调用 OpenAI Images API，返回图片 URL。
2. **计费扣减**：生成前检查余额并扣减 Credits，失败时回退。
3. **余额管理**：注册赠送 20 Credits，查询余额 API，管理员手动充值。
4. **生成结果展示**：网格画廊展示，支持预览和下载。
5. **生成历史**：按时间倒序展示历史任务，支持状态筛选。
6. **独立前端入口**：/image-studio 路径，独立 SPA，独立 UI 工作流。
7. **数据隔离加固**：确认所有 API 的 user_id 来源一致性。

### 推荐方案

**方案 C：Monorepo 共享基础设施**。在现有 Woohoo 仓库内新建独立前端应用，共享后端和基础设施。通过前端路由分离实现产品独立性，通过共享后端实现基础设施复用，通过共享数据库实现数据互通。
