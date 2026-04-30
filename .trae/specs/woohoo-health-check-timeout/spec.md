# 健康检查超时优化 - Spec

## Why
当前健康检查的超时只有 800 毫秒，导致经常出现 `net::ERR_FAILED` 和 `net::ERR_ABORTED` 错误。开发环境中有时响应稍慢就会超时，导致前端无法连接到后端。

## What Changes
- 增加健康检查超时时间从 800ms 到更合理的 3000ms
- 确保前端能在开发环境中可靠地连接到后端

## Impact
- Affected specs: woohoo-message-bubble-fix
- Affected code: `src/lib/serverApi.ts`

## ADDED Requirements
无

## MODIFIED Requirements
### Requirement: 健康检查超时
- **原问题**: 健康检查超时只有 800ms，容易超时导致连接失败
- **修复方案**: 将超时时间增加到 3000ms（3秒），给更多时间让请求完成

## REMOVED Requirements
无
