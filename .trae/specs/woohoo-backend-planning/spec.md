# Woohoo Studio 后端系统 - 产品需求文档

## Overview

* **Summary**: 构建一个安全、专业、规范的后端系统，支持工业化AI短剧产线，包含用户认证、项目管理、对话系统、媒体处理、AI内容审核等核心功能

* **Purpose**: 为Woohoo Studio前端提供可靠、高性能、安全的后端API服务，支持剧本、分镜、视频的智能审核和自动化处理

* **Target Users**:

  * 内容创作者

  * 视频制作团队

  * 短剧工作室

  * 系统管理员

## Goals

* **G1**: 实现完整的用户认证与授权系统，支持JWT+OAuth2.0

* **G2**: 实现项目管理、对话管理、资产管理的完整CRUD功能

* **G3**: 集成FFmpeg媒体处理服务，支持视频转码、剪辑、水印、字幕

* **G4**: 实现AI服务集成，支持LLM对话、内容审核

* **G5**: 建立完整的审计日志和监控系统

* **G6**: 提供RESTful API和GraphQL双接口支持

## Non-Goals (Out of Scope)

* 不实现前端UI（已有独立前端项目）

* 不实现机器学习模型训练

* 不实现第三方支付系统

* 不实现多租户架构（第一阶段单租户）

* 不实现实时视频流处理

## Background & Context

* 前端已使用 React + TypeScript + Vite + Tauri 2 实现

* 当前状态管理使用 useReducer（本地状态）

* 需要逐步迁移到真实后端API

* 技术栈确定为 Rust + Axum + SQLite + Redis + FFmpeg

## Functional Requirements

### FR-1: 用户认证与授权

* 用户注册、登录、登出

* JWT Token管理（访问令牌+刷新令牌）

* 角色权限控制（普通用户/管理员）

* 密码重置与邮箱验证

* 第三方OAuth集成（预留接口）

### FR-2: 项目管理

* 创建、编辑、删除项目

* 项目状态管理（草稿/待立项/进行中/已完成）

* 项目成员管理

* 项目搜索与筛选

* 项目归档与恢复

### FR-3: 对话系统

* 创建、编辑、删除对话

* 上下文隔离控制（独立上下文/关联上下文）

* 消息发送与接收

* 消息历史查询

* 对话导出功能

### FR-4: 资产管理

* 文件上传（剧本、分镜、视频、图片）

* 文件存储（本地/S3兼容）

* 媒体元数据提取

* 文件分类与标签

* 文件预览与下载

### FR-5: 媒体处理服务

* 视频转码（支持多种格式）

* 视频剪辑（时间轴裁剪）

* 水印添加（文字/图片水印）

* 字幕烧录（SRT/VTT格式）

* 视频拼接与合并

* 异步任务队列与进度查询

### FR-6: AI服务集成

* LLM对话代理

* 剧本智能审核

* 分镜智能审核

* 视频文案审核

* 内容分级与风险提示

### FR-7: 审计与监控

* 用户操作日志

* API访问日志

* 系统健康检查

* 性能指标收集

* 错误追踪与告警

## Non-Functional Requirements

### NFR-1: 安全性

* 密码使用bcrypt加密（cost=12）

* API密钥使用AES-256-GCM加密存储

* 支持TLS 1.3传输加密

* SQL注入防护（使用参数化查询）

* XSS防护（输入输出 sanitization）

* CSRF防护

* 速率限制（基于Redis）

* 敏感数据审计日志

### NFR-2: 性能

* API响应时间 < 200ms（P95）

* 支持100+并发用户

* 媒体处理任务队列吞吐量 > 10任务/分钟

* 数据库查询优化（索引+缓存）

* Redis缓存热点数据

### NFR-3: 可靠性

* 系统可用性 > 99.5%

* 数据库定期备份

* 任务失败重试机制

* 优雅降级策略

### NFR-4: 可维护性

* 代码覆盖率 ≥ 80%

* 完整的API文档（OpenAPI 3.0）

* 结构化日志（tracing）

* 架构决策记录（ADR）

## Constraints

### Technical

* **编程语言**: Rust 1.75+

* **Web框架**: Axum 0.7+

* **数据库**: SQLite 3.44+（开发）/ PostgreSQL（生产）

* **缓存**: Redis 7.2+

* **ORM**: sqlx 0.7+

* **认证**: JWT + OAuth2.0

* **媒体处理**: FFmpeg 6.0+

### Business

* **开发周期**: 8-12周

* **部署环境**: Docker + Docker Compose

* **合规要求**: 内容审核符合相关法规

### Dependencies

* FFmpeg（媒体处理）

* Redis（缓存+队列）

* LLM API服务（如OpenAI/Anthropic）

## Assumptions

* 用户会使用现代浏览器（Chrome 100+, Firefox 100+, Safari 16+）

* 服务器有足够的磁盘空间存储媒体文件

* 有可用的LLM API服务

* FFmpeg可在目标环境正常运行

## Acceptance Criteria

### AC-1: 用户可以正常注册登录

* **Given**: 用户访问注册页面

* **When**: 用户填写有效信息并提交

* **Then**: 用户账户创建成功，收到JWT令牌，可以正常登录

* **Verification**: `programmatic`

### AC-2: 用户可以创建和管理项目

* **Given**: 用户已登录

* **When**: 用户创建新项目并编辑

* **Then**: 项目成功创建，用户可以查看、编辑、删除项目

* **Verification**: `programmatic`

### AC-3: 用户可以发送和接收消息

* **Given**: 用户在项目对话中

* **When**: 用户输入消息并发送

* **Then**: 消息显示在对话中，AI可以响应

* **Verification**: `programmatic`

### AC-4: 用户可以上传和处理媒体文件

* **Given**: 用户在项目中

* **When**: 用户上传视频文件并请求转码

* **Then**: 文件上传成功，媒体处理任务进入队列，用户可以查询进度

* **Verification**: `programmatic`

### AC-5: AI内容审核功能正常工作

* **Given**: 用户提交剧本/分镜/视频文案

* **When**: 系统进行内容审核

* **Then**: 审核结果返回，包含风险提示和分级

* **Verification**: `programmatic`

### AC-6: 系统安全防护有效

* **Given**: 攻击者尝试SQL注入/XSS攻击

* **When**: 恶意请求到达后端

* **Then**: 请求被拦截，系统记录安全事件

* **Verification**: `programmatic`

### AC-7: API文档完整准确

* **Given**: 开发者查看API文档

* **When**: 开发者使用OpenAPI文档

* **Then**: 所有接口都有文档，参数和响应定义清晰

* **Verification**: `human-judgment`

### AC-8: 系统监控和日志完整

* **Given**: 系统运行中

* **When**: 查看监控和日志

* **Then**: 可以看到健康状态、性能指标、操作日志

* **Verification**: `human-judgment`

## Open Questions

* [ ] 具体使用哪个LLM服务？（OpenAI/Anthropic/自研）

* [ ] 生产环境是否需要PostgreSQL？还是SQLite足够？

* [ ] 文件存储使用本地还是S3兼容服务？

* [ ] 是否需要支持WebSocket实时通信？

* [ ] 内容审核的具体标准和级别是什么？

