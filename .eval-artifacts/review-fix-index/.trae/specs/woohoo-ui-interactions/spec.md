# Woohoo Studio UI交互补齐 - Product Requirement Document

## Overview

* **Summary**: 补齐Woohoo Studio前端UI中缺失的关键交互功能，包括资产库面板展示、对话升级为项目、AI自动回复、消息列表滚动及消息操作功能

* **Purpose**: 完善用户体验，提供完整的工作室功能，让用户可以流畅地使用项目管理、对话创作和资产库功能

* **Target Users**: Woohoo Studio的用户，包括创意工作者、内容创作者、项目管理者

## Goals

* 实现完整的资产库面板显示和交互

* 添加对话升级为项目的功能按钮和流程

* 实现发送消息后的AI自动回复模拟

* 添加消息列表自动滚动到最新消息

* 提供消息操作功能（复制、重新生成、删除等）

* 在资产库面板添加返回对话的导航

* 在所有需要返回的界面添加明确的返回按钮/路径

* 保持现有功能的稳定性和一致性

## Non-Goals (Out of Scope)

* 不涉及后端API对接（继续使用mock数据）

* 不涉及用户认证系统

* 不涉及数据持久化

* 不涉及性能优化

* 不添加新的视觉设计元素

## Background & Context

当前Woohoo Studio前端UI已经有了基础框架，但关键交互功能尚未实现：

* 项目树组件已有，但点击资产库时没有对应的面板显示

* 发送消息功能正常，但没有AI回复

* 缺少将临时对话升级为正式项目的入口

* 消息列表不会自动滚动

* 缺少对单个消息的操作功能

## Functional Requirements

* **FR-1**: 实现资产库面板，当activePane为"assets"时显示项目资产

* **FR-2**: 在浮动工作区添加"升级为项目"按钮

* **FR-3**: 发送用户消息后自动生成AI回复

* **FR-4**: 消息列表自动滚动到最新消息

* **FR-5**: 为每个消息添加操作菜单（复制、重新生成、删除）

* **FR-6**: 在对话区域顶部显示当前项目/对话信息

* **FR-7**: 在资产库面板添加返回对话的标签页切换按钮

* **FR-8**: 确保所有界面都有清晰的导航路径和返回方式

## Non-Functional Requirements

* **NFR-1**: 响应时间 < 100ms（用户交互延迟）

* **NFR-2**: 与现有UI风格保持一致

* **NFR-3**: 在浏览器窗口大小变化时正确响应

* **NFR-4**: 动画和过渡效果流畅自然

## Constraints

* **Technical**: React 18 + TypeScript + Vite

* **Business**: 继续使用mock数据，不依赖后端

* **Dependencies**: 现有的UI组件库和状态管理

## Assumptions

* 用户已经了解基本的UI操作

* 资产数据结构已有mock数据支持

* AI回复可以使用预设的模板回复

## Acceptance Criteria

### AC-1: 资产库面板显示

* **Given**: 用户点击项目树中的"项目资产库"

* **When**: activePane变为"assets"

* **Then**: 聊天面板区域显示资产库内容，按类型分组显示（脚本、分镜、视频、提示词）

* **Verification**: `programmatic`

* **Notes**: 资产库需要与现有聊天面板无缝切换

### AC-2: 升级为项目按钮

* **Given**: 用户在浮动工作区有活跃对话

* **When**: 点击"升级为项目"按钮

* **Then**: 触发promoteFloatingConversation动作，对话变为新项目

* **Verification**: `programmatic`

* **Notes**: 按钮应放置在明显位置，并有清晰的视觉反馈

### AC-3: AI自动回复

* **Given**: 用户发送一条消息

* **When**: 消息发送后1-2秒

* **Then**: 自动添加一条AI回复消息到当前对话

* **Verification**: `programmatic`

* **Notes**: AI回复应根据上下文生成合理内容，有随机延迟效果

### AC-4: 消息列表自动滚动

* **Given**: 有新消息添加到对话

* **When**: 消息渲染完成后

* **Then**: 消息列表自动滚动到底部显示最新消息

* **Verification**: `programmatic`

* **Notes**: 用户手动滚动时不应打断，只有新消息时才自动滚动

### AC-5: 消息操作菜单

* **Given**: 鼠标悬停在消息上

* **When**: 显示消息操作按钮

* **Then**: 可以点击复制、重新生成、删除消息

* **Verification**: `human-judgment`

* **Notes**: 操作应该直观，有适当的反馈

### AC-6: 对话信息展示

* **Given**: 有活跃对话打开

* **When**: 查看聊天面板顶部

* **Then**: 显示当前项目/对话名称、对话数量等信息

* **Verification**: `human-judgment`

* **Notes**: 信息应清晰易读，不占用过多空间

### AC-7: 资产库返回对话导航

* **Given**: 用户在资产库面板（activePane为"assets"）

* **When**: 点击"对话"标签或返回按钮

* **Then**: activePane切换回"conversations"，显示对话面板

* **Verification**: `programmatic`

* **Notes**: 标签页切换应该直观，有清晰的视觉指示

### AC-8: 完整导航路径

* **Given**: 用户在任何界面

* **When**: 需要返回或导航到其他界面

* **Then**: 有明确的导航路径或返回按钮可用

* **Verification**: `human-judgment`

* **Notes**: 导航应该符合用户直觉，不应该让用户迷路

## Open Questions

* [ ] AI回复的内容是否需要更智能的生成？

* [ ] 资产库是否需要拖拽上传功能？

* [ ] 消息重新生成时是否需要保留历史记录？

