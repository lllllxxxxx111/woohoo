import React, { useState } from 'react';
import { AlignJustify, Target, Play } from 'lucide-react';

import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';

export const ChaptersView: React.FC = () => {
  const [targetDuration, setTargetDuration] = useState('60');
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

  const handleSyncChat = () => {
    void launchTask(
      `@大纲架构师 请把当前剧本拆成章节，并按约 ${targetDuration || '60'} 秒总时长重新规划节奏。\n\n要求：\n1. 输出章节列表与每节时长。\n2. 标出关键场景和人物出场。\n3. 给出下一步人物/场景资产生成建议。`,
      {
        successTitle: '章节拆解任务已提交',
        successMessage: '章节规划会由后端真实任务处理并回写到对话区。',
      },
    );
  };

  return (
    <div className={styles.splitLayout}>
      <div className={styles.mainArea}>
        <div className={styles.areaHeader}>
          <AlignJustify size={18} />
          <h3>剧本分节规划</h3>
        </div>

        <div className={styles.durationControl}>
          <label>
            <Target size={16} /> 目标短片时长(秒):
          </label>
          <input
            type="number"
            value={targetDuration}
            onChange={(e) => setTargetDuration(e.target.value)}
            className={styles.numberInput}
          />
          <button className={styles.btnSecondary} onClick={handleSyncChat} disabled={isSubmitting}>
            <Play size={14} /> 自动重算分节
          </button>
        </div>

        <div className={styles.longScrollArea}>
          <div
            className={styles.chapterCard}
            style={{
              textAlign: 'center',
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
            }}
          >
            <p>暂无章节拆解数据，请先在对话区执行拆分。</p>
          </div>
        </div>
      </div>

      <div className={styles.sidePanel}>
        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>数据汇总</h4>
          <p className={styles.summaryStat}>总拆解章节：4 节</p>
          <p className={styles.summaryStat}>估算总时长：50 s</p>
          <p className={styles.summaryStat}>预计场景数：3 个</p>
          <p className={styles.summaryStat}>出场人物数：4 人</p>
        </div>

        <div className={styles.panelBlock}>
          <p className={styles.infoText}>
            根据章节拆解，系统已智能提取出下方所需的【人物】与【场景】列表。
          </p>
        </div>

        <div className={styles.panelActions}>
          <button className={styles.btnPrimary} onClick={handleSyncChat} disabled={isSubmitting}>
            提交章节任务
          </button>
        </div>
      </div>
    </div>
  );
};
