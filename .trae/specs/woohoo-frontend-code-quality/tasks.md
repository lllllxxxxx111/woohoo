# Tasks

- [x] Task 1: 添加 ESLint 配置
  - [x] SubTask 1.1: 安装 ESLint 及相关插件（@typescript-eslint/parser、@typescript-eslint/eslint-plugin、eslint-config-prettier）
  - [x] SubTask 1.2: 创建 eslint.config.js 配置文件（ESLint 9 扁平配置），包含 TypeScript 推荐规则 + Prettier 兼容 + no-console warn + no-explicit-any warn
  - [x] SubTask 1.3: 在 package.json 中添加 lint 脚本命令
  - [x] SubTask 1.4: 运行 lint 检查，确认配置生效（0 errors, 6 warnings）

- [x] Task 2: 消除 ChatMessageGroupItem.tsx 中的 any 类型（18处）
  - [x] SubTask 2.1: 为 TaskGroupItemProps 接口中的 message/agent/agentContacts/activeAssets 替换 any 为具体类型
  - [x] SubTask 2.2: 为回调函数参数（onEditUserMessage/onRevokeUserMessage/onDeleteMessage/onCopyMessage）替换 any 为 Message 类型
  - [x] SubTask 2.3: 为 MarkdownComponentsProps 和 TaskGroupItemInnerProps 中的 any 替换为具体类型
  - [x] SubTask 2.4: 运行 typecheck 确认无类型错误

- [x] Task 3: 消除 ChatArea.tsx 中的 any 类型（10处）
  - [x] SubTask 3.1: 为消息操作回调函数参数替换 any 为 Message 类型
  - [x] SubTask 3.2: 修复 onKeyDown 的 `as any` 类型断言，使用 React.KeyboardEvent<HTMLTextAreaElement>
  - [x] SubTask 3.3: 运行 typecheck 确认无类型错误

- [x] Task 4: 消除 Settings 组件中的 any 类型
  - [x] SubTask 4.1: AgentManagement.tsx - 为 endpoints 状态和 render 函数参数添加具体类型
  - [x] SubTask 4.2: EndpointManagement.tsx - 为 render 函数参数添加具体类型
  - [x] SubTask 4.3: SettingsModal.tsx - 为 tab 对象的 disabled/badge 属性定义 TabConfig 接口替代 `as any`
  - [x] SubTask 4.4: UsageDashboard.tsx - 为 render 函数参数添加具体类型
  - [x] SubTask 4.5: AuthModal.tsx - 为 handleSubmit 的 values 参数定义 AuthFormValues 接口

- [x] Task 5: 消除 Workspace/AutomationArea/PipelinePreview 中的 any 类型
  - [x] SubTask 5.1: AutomationArea.tsx - 为 task 参数定义 AiTask 类型
  - [x] SubTask 5.2: PipelinePreview.tsx - 为 task 参数定义具体类型
  - [x] SubTask 5.3: Workspace.tsx - 修复 switchTab 的 `as any` 类型断言

- [x] Task 6: 提取 AppContext 中的 defaultAgents 常量
  - [x] SubTask 6.1: 创建 `src/config/defaultAgents.ts`，将 defaultAgents 数组移入
  - [x] SubTask 6.2: 更新 AppContext.tsx 中的导入路径
  - [x] SubTask 6.3: 检查其他引用 defaultAgents 的文件（无需更新）

- [x] Task 7: 拆分 ChatArea 组件
  - [x] SubTask 7.1: 提取消息输入区域为 `ChatInputArea.tsx`（220行）
  - [x] SubTask 7.2: 提取智能体侧边栏为 `AgentSidePanel.tsx`（179行）
  - [x] SubTask 7.3: 提取项目创建弹窗为 `ProjectCreateModal.tsx`（102行）
  - [x] SubTask 7.4: 提取消息分组逻辑为 `useMessageGroups.ts` hook（329行）
  - [x] SubTask 7.5: 提取消息操作逻辑为 `useMessageActions.ts` hook（492行）
  - [x] SubTask 7.6: 提取 Workflow Guard 逻辑为 `useWorkflowGuard.ts` hook（237行）
  - [x] SubTask 7.7: 重构 ChatArea.tsx 主文件为容器组件（477行，原1937行）
  - [x] SubTask 7.8: Workspace.tsx 中 ChatArea 导入路径无需更新（同目录）
  - [x] SubTask 7.9: typecheck 通过

- [x] Task 8: 添加关键工具函数单元测试
  - [x] SubTask 8.1: 安装 vitest@2.1.9 测试框架
  - [x] SubTask 8.2: 为 chatAreaUtils.ts 添加单元测试（53个测试）
  - [x] SubTask 8.3: 为 appContextHelpers.ts 添加单元测试（73个测试）
  - [x] SubTask 8.4: 在 package.json 中添加 test/test:watch 脚本命令
  - [x] SubTask 8.5: 运行测试确认全部通过（126 passed, 0 failed）

- [x] Task 9: 最终验证
  - [x] SubTask 9.1: 运行 `npm run typecheck` 确认无类型错误 ✅
  - [x] SubTask 9.2: 运行 `npm run lint` 确认无 error 级别报告 ✅（0 errors, 6 warnings）
  - [x] SubTask 9.3: 运行 `npm run test` 确认测试通过 ✅（126 passed）
  - [x] SubTask 9.4: 启动 dev 服务器确认功能正常 ✅（http://127.0.0.1:5173/）

# Task Dependencies
- [Task 2] depends on [Task 1]（ESLint 可辅助发现 any 类型）
- [Task 3] depends on [Task 1]
- [Task 4] depends on [Task 1]
- [Task 5] depends on [Task 1]
- [Task 7] depends on [Task 2, Task 3]（先修复类型再拆分，避免拆分时传播 any）
- [Task 8] depends on [Task 7]（拆分后测试结构更清晰）
- [Task 9] depends on [Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8]

# Parallelizable Work
- Task 1, Task 6 可并行执行
- Task 2, Task 3, Task 4, Task 5 可并行执行（均依赖 Task 1 完成后）
