# Woohoo Studio UI交互补齐 - The Implementation Plan (Decomposed and Prioritized Task List)

## [ ] Task 1: 实现资产库面板显示
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 修改ChatWorkspace组件，添加activePane为"assets"时的面板显示
  - 按类型分组显示资产（脚本、分镜、视频、提示词）
  - 使用现有CSS样式保持UI一致性
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.1: 点击项目树的"项目资产库"后，activePane变为"assets"
  - `programmatic` TR-1.2: activePane为"assets"时，资产库面板正确显示
  - `human-judgement` TR-1.3: 资产库面板与聊天面板切换流畅，无视觉跳动
- **Notes**: 可以使用现有的Workspace组件结构，添加条件渲染

## [ ] Task 2: 添加升级为项目按钮
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 在ChatWorkspace组件的浮动工作区状态下添加"升级为项目"按钮
  - 按钮点击时调用onPromoteConversation回调
  - 按钮样式与现有UI风格一致
- **Acceptance Criteria Addressed**: AC-2
- **Test Requirements**:
  - `programmatic` TR-2.1: 浮动工作区时"升级为项目"按钮可见
  - `programmatic` TR-2.2: 点击按钮触发onPromoteConversation回调
  - `human-judgement` TR-2.3: 按钮位置合理，视觉反馈清晰
- **Notes**: 按钮应该只在浮动工作区（isFloatingWorkspace为true）时显示

## [ ] Task 3: 实现AI自动回复
- **Priority**: P0
- **Depends On**: None
- **Description**: 
  - 在reducer中添加AI回复生成逻辑
  - 发送用户消息后延迟1-2秒添加AI回复
  - 使用预设的AI回复模板
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `programmatic` TR-3.1: 发送用户消息后1-2秒内添加AI回复
  - `programmatic` TR-3.2: AI回复有合理的内容模板
  - `human-judgement` TR-3.3: AI回复显示自然，有随机延迟效果
- **Notes**: 需要修改sendMessage action，添加AI回复的异步处理

## [ ] Task 4: 消息列表自动滚动
- **Priority**: P1
- **Depends On**: None
- **Description**: 
  - 在ChatWorkspace组件中添加消息列表ref
  - 当有新消息时，自动滚动到列表底部
  - 保持用户手动滚动时的状态
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `programmatic` TR-4.1: 添加新消息后自动滚动到底部
  - `human-judgement` TR-4.2: 用户手动滚动时不被打断
  - `human-judgement` TR-4.3: 滚动动画流畅自然
- **Notes**: 使用useRef和useEffect实现滚动逻辑

## [ ] Task 5: 添加消息操作菜单
- **Priority**: P1
- **Depends On**: None
- **Description**: 
  - 为每个消息卡片添加悬停时的操作按钮
  - 实现复制消息功能（使用navigator.clipboard）
  - 实现重新生成功能（删除当前AI回复并重新生成）
  - 实现删除消息功能
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `programmatic` TR-5.1: 悬停时显示操作按钮
  - `programmatic` TR-5.2: 点击复制成功复制消息内容
  - `human-judgement` TR-5.3: 操作按钮样式美观，交互清晰
- **Notes**: 首先添加复制功能，其他功能可后续扩展

## [ ] Task 6: 显示对话信息
- **Priority**: P2
- **Depends On**: None
- **Description**: 
  - 在ChatWorkspace顶部添加当前项目/对话信息栏
  - 显示项目/对话名称、更新时间等信息
  - 提供快捷操作入口
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `human-judgement` TR-6.1: 对话信息显示清晰完整
  - `human-judgement` TR-6.2: 信息栏样式与整体UI协调
  - `human-judgement` TR-6.3: 不占用过多屏幕空间
- **Notes**: 信息栏应该简洁，提供快速识别当前工作区的功能

## [ ] Task 7: 添加标签页切换（对话/资产库）
- **Priority**: P0
- **Depends On**: Task 1
- **Description**: 
  - 在ChatWorkspace顶部添加"对话"和"资产库"标签页
  - 标签页根据activePane状态高亮显示
  - 点击标签页切换activePane状态
  - 在StudioWorkspacePage中添加切换标签页的action
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `programmatic` TR-7.1: 标签页正确显示当前activePane状态
  - `programmatic` TR-7.2: 点击标签页正确切换activePane
  - `human-judgement` TR-7.3: 标签页样式美观，交互清晰
- **Notes**: 标签页应该放在信息栏下方，对话/资产库面板上方

## [ ] Task 8: 确保所有界面有清晰的导航返回
- **Priority**: P1
- **Depends On**: None
- **Description**: 
  - 检查所有界面的导航路径
  - 确保从任何界面都能返回或导航到主要功能
  - 添加必要的返回按钮或面包屑导航
- **Acceptance Criteria Addressed**: AC-8
- **Test Requirements**:
  - `human-judgement` TR-8.1: 所有界面都有清晰的导航选项
  - `human-judgement` TR-8.2: 导航操作符合用户直觉
  - `human-judgement` TR-8.3: 用户不会在界面中迷路
- **Notes**: 重点检查资产库、设置面板等边界界面的导航
