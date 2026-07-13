# Woohoo Studio 后端系统 - 实现计划

## [x] Task 1: 项目初始化与基础设施搭建
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 创建Rust项目结构
  - 配置Cargo.toml依赖
  - 设置开发环境（Docker Compose）
  - 配置数据库迁移系统
  - 设置日志系统（tracing）
- **Acceptance Criteria Addressed**: AC-7, AC-8
- **Test Requirements**:
  - `programmatic` TR-1.1: 项目可以正常编译运行
  - `programmatic` TR-1.2: Docker Compose可以启动Redis
  - `programmatic` TR-1.3: 健康检查端点返回200
  - `human-judgement` TR-1.4: 目录结构符合DDD规范
- **Notes**: 首先搭建脚手架，确保基础设施就绪

## [x] Task 2: 数据库设计与迁移
- **Priority**: P0
- **Depends On**: Task 1
- **Description**: 
  - 设计并创建用户表
  - 设计并创建项目表
  - 设计并创建对话表
  - 设计并创建消息表
  - 设计并创建资产表
  - 设计并创建审计日志表
  - 编写SQL迁移脚本
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4
- **Test Requirements**:
  - `programmatic` TR-2.1: 所有表可以正常创建
  - `programmatic` TR-2.2: 外键约束正确设置
  - `programmatic` TR-2.3: 索引正确创建
  - `human-judgement` TR-2.4: 表结构符合业务需求
- **Notes**: 使用sqlx进行数据库操作

## [x] Task 3: 用户认证与授权系统
- **Priority**: P0
- **Depends On**: Task 2
- **Description**: 
  - 实现JWT令牌生成与验证
  - 实现密码加密（bcrypt）
  - 实现用户注册端点
  - 实现用户登录端点
  - 实现令牌刷新端点
  - 实现用户登出端点
  - 实现认证中间件
- **Acceptance Criteria Addressed**: AC-1, AC-6
- **Test Requirements**:
  - `programmatic` TR-3.1: 用户可以正常注册
  - `programmatic` TR-3.2: 用户可以正常登录获取JWT
  - `programmatic` TR-3.3: 无效令牌被拒绝
  - `programmatic` TR-3.4: 密码哈希正确验证
  - `programmatic` TR-3.5: SQL注入尝试被拦截
- **Notes**: 使用jsonwebtoken crate实现JWT

## [x] Task 4: 项目管理API
- **Priority**: P0
- **Depends On**: Task 3
- **Description**: 
  - 实现项目创建端点
  - 实现项目列表查询端点
  - 实现项目详情查询端点
  - 实现项目更新端点
  - 实现项目删除端点
  - 实现项目搜索与筛选
  - 实现项目归档功能
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-4.1: 可以创建新项目
  - `programmatic` TR-4.2: 可以查询项目列表
  - `programmatic` TR-4.3: 可以更新项目信息
  - `programmatic` TR-4.4: 可以删除项目
  - `programmatic` TR-4.5: 用户只能访问自己的项目
- **Notes**: 实现权限检查，确保数据隔离

## [ ] Task 5: 对话系统API
- **Priority**: P0
- **Depends On**: Task 4
- **Description**: 
  - 实现对话创建端点
  - 实现对话列表查询端点
  - 实现对话详情查询端点
  - 实现对话更新端点
  - 实现对话删除端点
  - 实现消息发送端点
  - 实现消息列表查询端点
  - 实现上下文隔离控制
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-5.1: 可以创建新对话
  - `programmatic` TR-5.2: 可以发送消息
  - `programmatic` TR-5.3: 可以查询消息历史
  - `programmatic` TR-5.4: 上下文隔离正常工作
  - `programmatic` TR-5.5: 消息按时间排序正确
- **Notes**: 消息内容需要做sanitization

## [ ] Task 6: 资产管理API
- **Priority**: P1
- **Depends On**: Task 5
- **Description**: 
  - 实现文件上传端点
  - 实现文件列表查询端点
  - 实现文件下载端点
  - 实现文件删除端点
  - 实现文件元数据提取
  - 实现本地文件存储
  - 实现S3兼容存储接口（预留）
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-6.1: 可以上传文件
  - `programmatic` TR-6.2: 可以下载文件
  - `programmatic` TR-6.3: 文件元数据正确提取
  - `programmatic` TR-6.4: 文件大小限制生效
  - `programmatic` TR-6.5: 不允许的文件类型被拒绝
- **Notes**: 实现文件类型白名单验证

## [ ] Task 7: FFmpeg媒体处理服务
- **Priority**: P1
- **Depends On**: Task 6
- **Description**: 
  - 封装FFmpeg命令行调用
  - 实现视频转码功能
  - 实现视频剪辑功能
  - 实现水印添加功能
  - 实现字幕烧录功能
  - 实现视频拼接功能
  - 实现异步任务队列（Redis）
  - 实现任务进度查询端点
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-7.1: FFmpeg命令正常执行
  - `programmatic` TR-7.2: 视频转码输出正确格式
  - `programmatic` TR-7.3: 任务进度可以查询
  - `programmatic` TR-7.4: 失败任务可以重试
  - `human-judgement` TR-7.5: 输出视频质量符合预期
- **Notes**: 使用ffmpeg-next或直接调用命令行

## [ ] Task 8: AI服务集成
- **Priority**: P1
- **Depends On**: Task 7
- **Description**: 
  - 实现LLM客户端封装
  - 实现对话代理接口
  - 实现剧本审核接口
  - 实现分镜审核接口
  - 实现视频文案审核接口
  - 实现内容分级逻辑
  - 实现API密钥加密存储
- **Acceptance Criteria Addressed**: AC-3, AC-5
- **Test Requirements**:
  - `programmatic` TR-8.1: LLM API调用成功
  - `programmatic` TR-8.2: 内容审核结果正确返回
  - `programmatic` TR-8.3: API密钥加密存储
  - `programmatic` TR-8.4: 超时和错误处理正常
  - `human-judgement` TR-8.5: 审核结果合理准确
- **Notes**: 使用reqwest调用LLM API

## [ ] Task 9: GraphQL接口
- **Priority**: P2
- **Depends On**: Task 8
- **Description**: 
  - 定义GraphQL Schema
  - 实现Query Resolvers
  - 实现Mutation Resolvers
  - 实现Subscription Resolvers（预留）
  - 配置GraphQL Playground
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `programmatic` TR-9.1: GraphQL查询正常工作
  - `programmatic` TR-9.2: GraphQL mutation正常工作
  - `programmatic` TR-9.3: 类型验证生效
  - `human-judgement` TR-9.4: Schema设计合理
- **Notes**: 使用async-graphql

## [ ] Task 10: API文档与监控
- **Priority**: P2
- **Depends On**: Task 9
- **Description**: 
  - 配置utoipa生成OpenAPI文档
  - 配置Redoc文档UI
  - 实现系统健康检查端点
  - 实现指标收集（Prometheus格式）
  - 实现审计日志记录
  - 实现速率限制中间件
- **Acceptance Criteria Addressed**: AC-7, AC-8
- **Test Requirements**:
  - `programmatic` TR-10.1: OpenAPI文档正确生成
  - `programmatic` TR-10.2: 健康检查端点正常工作
  - `programmatic` TR-10.3: 速率限制生效
  - `programmatic` TR-10.4: 审计日志正确记录
  - `human-judgement` TR-10.5: 文档清晰易读
- **Notes**: 使用utoipa和tower-http

## [ ] Task 11: 安全加固与测试
- **Priority**: P2
- **Depends On**: Task 10
- **Description**: 
  - 实现XSS防护
  - 实现CSRF防护
  - 实现安全头设置
  - 编写单元测试（覆盖率≥80%）
  - 编写集成测试
  - 进行安全渗透测试
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `programmatic` TR-11.1: 单元测试覆盖率≥80%
  - `programmatic` TR-11.2: 集成测试通过
  - `programmatic` TR-11.3: XSS攻击被拦截
  - `programmatic` TR-11.4: CSRF攻击被拦截
  - `human-judgement` TR-11.5: 安全评估通过
- **Notes**: 使用cargo tarpaulin计算覆盖率

## [ ] Task 12: 部署与运维
- **Priority**: P2
- **Depends On**: Task 11
- **Description**: 
  - 编写Dockerfile
  - 配置Docker Compose生产环境
  - 配置数据库备份策略
  - 配置日志轮转
  - 编写部署文档
  - 编写运维手册
- **Acceptance Criteria Addressed**: AC-8
- **Test Requirements**:
  - `programmatic` TR-12.1: Docker镜像可以正常构建
  - `programmatic` TR-12.2: Docker Compose可以正常启动
  - `programmatic` TR-12.3: 数据库备份正常工作
  - `human-judgement` TR-12.4: 部署文档完整
  - `human-judgement` TR-12.5: 运维手册清晰
- **Notes**: 支持多环境配置（dev/staging/prod）
