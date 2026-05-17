# 图片生成 Tab 集成 PRD

> 状态：待实现
> 范围：主 Woohoo 工作区内的独立图片生成 Tab
> 非目标：独立 SPA、独立 Vite 入口、独立 `/image-studio` 静态路由

## 1. 结论

图片生成必须作为现有 Woohoo 工作区的一个独立 Tab 实现，而不是独立应用。它复用现有登录态、项目上下文、公共资产库、全局积分账户和后端 API。

图片生成 Tab 可以提供生成参数、生成状态和最近结果预览，但不能维护一套独立资产库或独立历史库。所有生成结果必须进入公共资产库 Tab，资产库是用户侧唯一资产浏览和历史入口。

核心约束：

- 不新增 `src-image-studio/`。
- 不新增 `dist-image-studio/`。
- 不新增 `vite.image-studio.config.ts`。
- 不新增 `/image-studio` 静态入口。
- 不维护图片生成私有历史库。
- 不维护图片生成私有余额或钱包。
- 不在图片生成界面内再嵌套一套资产库历史列表。

## 2. 信息架构

在现有主工作区 Tab 中新增图片生成页。

建议命名：

- `currentTab`: `imageGeneration`
- 导航文案：`图片生成`
- 图标：优先使用 `lucide-react` 中的 `Image`、`Sparkles` 或 `WandSparkles`

涉及位置：

- `src/types/index.ts`
  - 扩展 `ActiveState.currentTab`
- 现有 Workspace / Tab 导航组件
  - 增加图片生成入口
- 现有 Sidebar 顶部菜单
  - 增加图片生成入口
- 现有资产库组件
  - 继续作为公共资产列表，不内嵌图片生成工作台。
- 新组件建议
  - `src/components/ImageGeneration/ImageGenerationPanel.tsx`
  - `src/components/ImageGeneration/ImageGenerationPanel.module.css`
  - 如需要，可拆分 `PromptComposer`、`GenerationControls`

## 3. 资产库约束

图片生成结果必须进入现有资产库，资产库是用户侧唯一主历史入口。

现有资产表：

```sql
CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    asset_type  TEXT NOT NULL CHECK (asset_type IN ('image', 'video', 'audio', 'document')),
    url         TEXT NOT NULL,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

生成成功后必须：

- 将图片文件写入现有 `data/assets` 存储体系。
- 调用或复用 `asset::repo::create_asset` 写入 `assets` 表。
- `asset_type` 使用 `image`。
- `url` 使用现有资产文件访问机制可读取的地址。
- 资产必须属于当前项目 `project_id`。

资产 `metadata` 至少记录：

```json
{
  "origin": "image_generation",
  "generationId": "string",
  "prompt": "string",
  "model": "string",
  "size": "1024x1024",
  "revisedPrompt": "string | null",
  "costCredits": 5
}
```

`image_generations` 表只用于任务审计、生成状态和调试，不作为用户侧历史来源。资产库列表是唯一的用户侧历史列表；图片生成 Tab 只展示当前生成预览、生成中状态和必要操作，不再维护或渲染一套独立资产历史。

资产库必须能看到图片生成结果。不能出现“图片生成 Tab 能看到，公共资产库看不到”的分裂状态。

## 4. 全局积分约束

余额必须使用全局统一体系。

保留并复用：

- `user_credits`
- `credit_transactions`
- `server/src/billing/*`
- `GET /api/billing/credits`
- `GET /api/billing/transactions`

图片生成只是全局积分消费的一种：

- `reason`: `image_generation`
- `ref_type`: `image_generation`
- `ref_id`: 对应 `image_generations.id`

前端不允许为图片生成 Tab 维护私有余额源。应抽取或复用全局余额查询能力，让 Header、图片生成 Tab、未来其他收费功能读同一份余额。

建议前端新增全局 hook：

```ts
useBillingCredits()
```

职责：

- 读取 `getImageCredits()` 或后续更名后的通用 `getBillingCredits()`。
- 暴露 `credits`、`loading`、`reload`。
- 图片生成成功、失败退款、充值后统一刷新。

## 5. 后端 API 调整

现有图片生成 API 可以保留，但需要补齐资产沉淀。

当前已存在：

- `POST /api/image-gen/generations`
- `GET /api/image-gen/generations`
- `GET /api/image-gen/generations/{id}`
- `GET /api/billing/credits`
- `GET /api/billing/transactions`

### 5.1 API 通道与能力矩阵

图片生成不应依赖单独的环境变量式图片 API 配置作为主路径。系统应复用现有 API 通道管理，并为每个通道维护能力矩阵。

后端新增能力表：

```sql
CREATE TABLE IF NOT EXISTS ai_endpoint_capabilities (
    id               TEXT PRIMARY KEY NOT NULL,
    endpoint_id      TEXT NOT NULL REFERENCES ai_endpoints(id) ON DELETE CASCADE,
    capability       TEXT NOT NULL,
    model            TEXT,
    path_override    TEXT,
    request_adapter  TEXT NOT NULL DEFAULT 'openai_compatible',
    response_adapter TEXT NOT NULL DEFAULT 'openai_compatible',
    supports_stream  INTEGER NOT NULL DEFAULT 0,
    supports_tools   INTEGER NOT NULL DEFAULT 0,
    supports_files   INTEGER NOT NULL DEFAULT 0,
    enabled          INTEGER NOT NULL DEFAULT 1,
    priority         INTEGER NOT NULL DEFAULT 100,
    config_json      TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(endpoint_id, capability)
);
```

能力类型先支持：

- `chat`
- `agent_plan`
- `image_generation`
- `video_generation`
- `tts`
- `stt`
- `embedding`
- `moderation`

当前阶段只把图片生成做成可用闭环。视频、语音、Agent Plan 等能力暂不展开 UI 和业务流程，但后端保留同一张能力表，避免未来为每种模态各建一套 API 配置。

设置页暂不暴露“多模态能力”勾选、图片生成模型、路径覆盖等高级配置，避免模型配置页面过重。图片生成 Tab 先直接复用已启用的 API 通道，并在图片生成页面选择模型。后端仍可识别 `ai_endpoint_capabilities`，用于未来升级为更细粒度的能力矩阵。

图片生成后端默认通过所选 API 通道调用 Responses API，内部按 Base URL 拼接 `/v1/responses`，前端不暴露接口类型、路径覆盖或底层协议选择。旧的 `path_override` 能力配置不能影响当前图片生成闭环，避免历史配置把请求导向 `/v1/images/generations`。

图片生成后端必须兼容多种聚合 API 返回：

- Image API: `data[].b64_json`
- Responses API: `output[]` 中 `type = image_generation_call` 的 `result`
- Chat 聚合接口: message/content 中的 base64、data URL 或嵌套 JSON 字符串

生成请求应带上 `endpointId`，后端优先使用该 API 通道的密钥和 Base URL；如果该通道没有 capability 记录，则按默认图片生成模型和当前通道继续执行。请求体不包含 `apiMode`，接口模式属于后端内部实现细节。

建议调整 `POST /api/image-gen/generations` 请求体：

```json
{
  "projectId": "string",
  "endpointId": "string",
  "prompt": "string",
  "model": "gpt-image-1",
  "size": "1024x1024",
  "n": 1
}
```

后端流程：

1. 从 `Extension<UserId>` 取得当前用户。
2. 校验 `projectId` 属于当前用户。
3. 计算 cost。
4. 创建 `image_generations` 任务记录。
5. 使用全局 billing 扣减积分。
6. 调用图片模型。
7. 成功后将每张图片落盘到 `data/assets`，并写入 `assets` 表。
8. 更新 `image_generations` 为 completed，并记录生成关联的资产 ID。
9. 失败时更新 failed，并走 billing refund。

如果一次生成多张图片，应创建多条 `assets` 记录。

## 6. 前端体验

图片生成 Tab 应是工作台页面，不是全屏独立应用，也不是公共资产库的替代品。

推荐布局：

- 主区：生成预览
  - 空状态
  - 生成中状态
  - 失败状态
  - 完成图片预览
  - 下载
- 右栏：生成参数
  - 提示词
  - 模型
  - 尺寸
  - 数量
- 预计积分消耗
- 全局余额
- 生成按钮
- 不展示独立资产历史列表
- 不展示公共资产库列表的复制版本

文案必须是正常 UTF-8 中文，禁止乱码。

## 7. 参考项目

实现体验参考：

- `https://github.com/CookSleep/gpt_image_playground`
  - 参考参数面板、生成体验、结果画廊、图片编辑能力入口。
- `https://github.com/3inchtime/astro_studio`
  - 参考桌面工作台式布局，适合 Tauri + React + Rust。
- `https://github.com/jiasongji/ChatUI`
  - 参考对话式输入和创作反馈体验。

不要照搬视觉。最终 UI 必须贴合 Woohoo 现有工作区、Arco Design 和本项目样式系统。

## 8. 验收标准

- 主应用里能通过现有主工作区 Tab 进入图片生成页。
- 侧边栏顶部菜单可进入图片生成页。
- 仓库内无 `src-image-studio`、`dist-image-studio`、`vite.image-studio.config.ts`。
- 后端无 `/image-studio` 静态挂载。
- 生成成功的图片能在图片生成 Tab 中预览。
- 生成成功的图片能在现有资产库列表中看到。
- 积分余额使用全局 `user_credits`。
- 积分流水使用全局 `credit_transactions`。
- 图片生成 Tab 不维护私有余额。
- 图片生成 Tab 不维护独立资产历史列表或独立资产库。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- `cargo check --manifest-path server/Cargo.toml` 通过。
