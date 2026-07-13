# 消息气泡样式优化 - Spec

## Why
用户反馈 AI 消息气泡内文字出现每两个字就被迫换行的问题，同时消息内容区域右侧 margin 过宽，没有贴着头像。这影响了文本阅读的流畅性和视觉紧凑性。

## What Changes
- 修复 AI 消息气泡内文字异常断行问题（每两字换行）
- 减少消息内容区域右侧不必要的 margin，使内容更贴近头像

## Impact
- Affected specs: woohoo-ui-refactor
- Affected code: `src/components/Chat/ChatArea.module.css`

## ADDED Requirements
无新增功能

## MODIFIED Requirements
### Requirement: 消息气泡文字布局
- **原问题**: 中文文字在消息气泡内出现每两字就换行的异常断行
- **修复方案**: 调整 `.markdownContainer` 和相关容器的 CSS 属性，使用 `word-break: break-word` 或 `overflow-wrap: break-word`，确保中文文本正常换行而非强制每字断行

### Requirement: 消息内容区域右侧间距
- **原问题**: AI 消息内容区域（`.messageBodyInner`）右侧 margin 过宽，没有贴着头像
- **修复方案**: 检查 `.ai .messageBody` 的 `margin-right` 或相关宽度限制，适当减少右侧间距，使消息内容更紧凑地贴近头像

## REMOVED Requirements
无
