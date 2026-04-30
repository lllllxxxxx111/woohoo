# Woohoo Studio UI 重构 - Product Requirement Document

## Overview
- **Summary**: 基于现有 Tauri 2 + React + TypeScript + Vite 架构，优化和完善 Woohoo Studio 工业化 AI 短剧产线台的 UI 界面，确保代码结构清晰、模块解耦良好，为后续接入 Rust、SQLite、FFmpeg sidecar 等功能奠定基础。
- **Purpose**: 打造一个功能完整、体验流畅的 AI 短剧创作工作台 UI 原型，包含对话交互、项目管理、资产库、自动化流程和技能管理等核心模块。
- **Target Users**: 短剧创作者、编剧、视频制作人、内容审核人员

## Goals
- 保持现有技术架构不变（Tauri 2 + React + TypeScript + Vite）
- 优化 UI 组件，提升用户体验和视觉效果
- 完善功能模块的解耦架构，避免大文件
- 实现完整的页面功能原型
- 为后续功能（文案审核、FFmpeg、SQLite）预留接口

## Non-Goals (Out of Scope)
- 不修改现有的状态管理架构（useReducer 保持不变）
- 不接入真实后端或数据库（当前阶段仅完成页面）
- 不实现实际的 AI 对话功能
- 不接入 FFmpeg 或其他 sidecar
- 不修改技术栈

## Background & Context
当前项目架构已经非常优秀：
- 使用 React + TypeScript + Vite 构建
- 组件化设计，分离清晰
- 状态管理使用 useReducer + selectors 模式
- 样式文件分离
- 已经有基本的功能模块

我们需要在现有架构基础上，进一步优化 UI 和完善代码结构，确保工业化生产质量。

## Functional Requirements
- **FR-1**: 优化现有 UI 组件的视觉效果和交互体验
- **FR-2**: 确保所有功能模块代码解耦良好，单个文件不超过 500 行
- **FR-3**: 完善侧边栏伸缩功能
- **FR-4**: 优化项目列表折叠/展开交互
- **FR-5**: 优化对话创建和上下文隔离功能
- **FR-6**: 优化设置面板的显示和交互
- **FR-7**: 确保响应式设计在各种屏幕尺寸下正常工作

## Non-Functional Requirements
- **NFR-1**: 代码质量：所有组件添加函数级注释
- **NFR-2**: 性能：页面加载和交互响应流畅
- **NFR-3**: 可维护性：模块解耦清晰，易于扩展
- **NFR-4**: 兼容性：支持主流浏览器

## Constraints
- **Technical**: 必须保持 Tauri 2 + React 18.3 + TypeScript + Vite 5.4 技术栈
- **Business**: 当前阶段仅完成 UI 页面，不接入后端
- **Dependencies**: 不引入新的大型外部依赖库

## Assumptions
- 用户使用 Windows 系统（开发环境）
- 浏览器支持现代 CSS 特性
- 现有架构的状态管理模式可以满足需求

## Acceptance Criteria

### AC-1: 侧边栏功能完整
- **Given**: 用户打开 Woohoo Studio
- **When**: 用户点击侧边栏伸缩按钮
- **Then**: 侧边栏平滑展开/收起，动画流畅
- **Verification**: `human-judgment`

### AC-2: 项目列表折叠交互
- **Given**: 用户在侧边栏查看项目列表
- **When**: 用户点击项目折叠/展开按钮
- **Then**: 项目列表平滑折叠/展开，视觉反馈清晰
- **Verification**: `human-judgment`

### AC-3: 新建独立对话
- **Given**: 用户在项目或未归属草稿中
- **When**: 用户点击新建对话按钮
- **Then**: 创建新的独立对话，不受旧对话上下文影响，工作区自动切换
- **Verification**: `human-judgment`

### AC-4: 设置面板显示
- **Given**: 用户鼠标悬停在设置按钮上
- **When**: 鼠标悬停
- **Then**: 显示包含账号信息、设置、语言、剩余额度、退出登录的面板
- **Verification**: `human-judgment`

### AC-5: 代码结构解耦
- **Given**: 项目代码库
- **When**: 检查所有源文件
- **Then**: 没有单个文件超过 500 行，组件职责单一
- **Verification**: `programmatic`

### AC-6: 响应式设计
- **Given**: 用户在不同屏幕尺寸下访问
- **When**: 调整浏览器窗口大小
- **Then**: 界面布局自适应，无明显错乱
- **Verification**: `human-judgment`

### AC-7: 从对话创建项目
- **Given**: 用户在未归属草稿的对话中
- **When**: 用户点击"从当前对话创建项目"
- **Then**: 创建新项目，工作区切换到新项目
- **Verification**: `human-judgment`

## Open Questions
- [ ] 是否需要添加暗色模式？
- [ ] 是否需要多语言支持（当前只有中文）？
- [ ] 未来的文案审核功能 UI 占位是否需要预留？
