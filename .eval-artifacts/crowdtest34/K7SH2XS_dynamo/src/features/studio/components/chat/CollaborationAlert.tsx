/**
 * CollaborationAlert - 协同循环风险告警组件
 *
 * 在对话区顶部显示循环检测命中的红色告警条，
 * 提示用户当前协同讨论存在循环风险。
 */
import React from 'react';
import { Alert } from '@arco-design/web-react';
import type { LoopCheckResponse } from '../../../../types';

interface CollaborationAlertProps {
  loopCheckResult: LoopCheckResponse | null;
}

/** 协同循环风险告警组件 */
export const CollaborationAlert: React.FC<CollaborationAlertProps> = ({
  loopCheckResult,
}) => {
  if (!loopCheckResult || !loopCheckResult.loopDetected) {
    return null;
  }

  const type = loopCheckResult.level >= 3 ? 'error' : loopCheckResult.level >= 2 ? 'warning' : 'info';
  const title = loopCheckResult.level >= 4
    ? '协同已暂停'
    : `循环风险检测 (Level ${loopCheckResult.level})`;

  return (
    <Alert
      type={type}
      title={title}
      content={loopCheckResult.message}
      style={{ margin: '8px 12px' }}
      closable={loopCheckResult.level < 4}
    />
  );
};
