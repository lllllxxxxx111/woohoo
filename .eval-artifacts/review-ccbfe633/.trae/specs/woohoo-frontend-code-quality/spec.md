# Woohoo Studio 前端代码质量优化 Spec

## Why
前端项目经过多轮功能迭代后，核心组件（如 ChatArea 1929行、ChatMessageGroupItem 大量 any 类型）已出现可维护性下降的趋势。TypeScript 类型安全未完全落地（49处 any），缺少 ESLint 静态检查，大型组件拆分不足。需要在功能稳定的前提下，系统性地提升代码质量。

## What Changes
- 拆分 ChatArea 超大组件（1929行 → 多个 <500行 的子组件）
- 消除 TypeScript `any` 类型（49处 → 目标 <10处）
- 添加 ESLint 配置，建立代码质量门禁
- 简化 AppContext.tsx（提取常量和大型回调为独立模块）
- 补充关键路径的单元测试

## Impact
- Affected specs: woohoo-ui-refactor（组件结构变更）、woohoo-feature-enhancements（组件拆分后导入路径变化）
- Affected code:
  - `src/features/studio/components/chat/ChatArea.tsx`（拆分）
  - `src/features/studio/components/chat/ChatMessageGroupItem.tsx`（类型修复）
  - `src/context/AppContext.tsx`（提取常量/回调）
  - `src/components/Settings/AgentManagement.tsx`（类型修复）
  - `src/components/Settings/EndpointManagement.tsx`（类型修复）
  - `src/components/Settings/SettingsModal.tsx`（类型修复）
  - `src/components/Auth/AuthModal.tsx`（类型修复）
  - `src/features/studio/components/workspace/AutomationArea.tsx`（类型修复）
  - `src/features/studio/components/workspace/PipelinePreview.tsx`（类型修复）
  - 项目根目录（新增 ESLint 配置文件）

## ADDED Requirements

### Requirement: ChatArea 组件拆分
系统 SHALL 将 ChatArea 组件拆分为多个职责单一的子组件，每个文件不超过 500 行。

#### Scenario: 拆分后功能不变
- **WHEN** 用户在聊天区域进行任何操作（发送消息、编辑、撤回、删除、上传文件、提及智能体等）
- **THEN** 所有功能行为与拆分前完全一致

#### Scenario: 单文件行数限制
- **WHEN** 检查 ChatArea 相关的所有文件
- **THEN** 每个文件行数不超过 500 行

### Requirement: TypeScript any 类型消除
系统 SHALL 将所有可替换的 `any` 类型替换为具体的 TypeScript 类型定义。

#### Scenario: 回调函数参数类型化
- **WHEN** 组件回调函数接收 message 参数
- **THEN** 参数类型为 `Message`（来自 `../../types`），而非 `any`

#### Scenario: 表格 render 函数类型化
- **WHEN** Arco Design Table 列定义使用 render 函数
- **THEN** render 函数参数使用具体的记录类型，而非 `any`

#### Scenario: 事件处理函数类型化
- **WHEN** 表单提交处理函数接收 values 参数
- **THEN** values 参数使用具体的表单值类型，而非 `any`

### Requirement: ESLint 配置
系统 SHALL 添加 ESLint 静态检查配置，与现有 Prettier 配置协同工作。

#### Scenario: ESLint 检查通过
- **WHEN** 运行 `npx eslint src/`
- **THEN** 无 error 级别的报告（warn 级别允许存在）

#### Scenario: Prettier 兼容
- **WHEN** ESLint 和 Prettier 同时运行
- **THEN** 两者规则不冲突

### Requirement: AppContext 常量提取
系统 SHALL 将 AppContext 中的硬编码常量数据提取为独立配置文件。

#### Scenario: defaultAgents 提取
- **WHEN** 检查 AppContext.tsx
- **THEN** 不包含 defaultAgents 数组定义，该数据位于独立的配置文件中

### Requirement: 关键工具函数测试
系统 SHALL 为核心工具函数添加单元测试覆盖。

#### Scenario: chatAreaUtils 测试
- **WHEN** 运行 `npm test`（或 vitest）
- **THEN** chatAreaUtils 中的工具函数测试通过

## MODIFIED Requirements

### Requirement: 组件导入路径
ChatArea 拆分后，Workspace.tsx 和其他引用 ChatArea 的组件 SHALL 从新的子组件路径导入。

## REMOVED Requirements
（无移除项）
