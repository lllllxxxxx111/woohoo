import React from 'react';
import { AlignLeft, FileText } from 'lucide-react';

import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';

export const ScriptView: React.FC = () => {
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

  const handleSyncChat = () => {
    void launchTask(
      '请基于当前项目已有的大纲、角色和上下文，产出一版完整剧本，并在结尾补充章节拆解建议与合规提醒。',
      {
        successTitle: '剧本任务已提交',
        successMessage: '剧本生成会走真实后端任务，结果会回写到当前对话。',
      },
    );
  };
  return (
    <div className={styles.splitLayout}>
      <div className={styles.mainArea}>
        <div className={styles.areaHeader}>
          <FileText size={18} />
          <h3>完整剧本</h3>
        </div>
        <div className={styles.longScrollArea}>
          <div className={styles.scriptParagraph} style={{ color: 'var(--text-muted)' }}>
            暂无剧本内容。请先在对话区生成。
          </div>
        </div>
      </div>

      <div className={styles.sidePanel}>
        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>
            <AlignLeft size={16} /> 剧本目录
          </h4>
          <ul className={styles.tocList}>
            <li className={styles.active} style={{ color: 'var(--text-muted)' }}>
              暂无目录
            </li>
          </ul>
        </div>

        <div className={styles.panelActions}>
          <button className={styles.btnPrimary} onClick={handleSyncChat} disabled={isSubmitting}>
            提交剧本任务
          </button>
        </div>
      </div>
    </div>
  );
};
