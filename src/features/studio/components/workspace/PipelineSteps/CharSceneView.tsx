import React from 'react';
import { UserPlus, Map, Send } from 'lucide-react';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';

import styles from './PipelineSteps.module.css';

export const CharSceneView: React.FC = () => {
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

  /**
   * 发起人物资产生成任务到后端
   */
  const handleGenerateCharacterAsset = (name: string) => {
    void launchTask(
      `@分镜渲染师 请为项目中的角色「${name}」生成三视图人设资产。\n\n要求：\n1. 输出正面、侧面、背面三个角度的视觉描述。\n2. 包含服装细节、配饰、标志性特征。\n3. 输出格式应可直接用于AI图像生成。`,
      {
        successTitle: '人物资产任务已提交',
        successMessage: '人设三视图生成任务已发送至服务端队列。',
        requireServerTask: true,
      },
    );
  };

  /**
   * 发起场景环境生成任务到后端
   */
  const handleGenerateSceneAsset = (sceneName: string) => {
    void launchTask(
      `@分镜渲染师 请为场景「${sceneName}」生成环境资产生成。\n\n要求：\n1. 描述场景的空间布局、光影氛围、色调。\n2. 列出关键道具和背景元素。\n3. 给出镜头机位建议（全景/中景/特写）。\n`,
      {
        successTitle: '场景资产任务已提交',
        successMessage: '场景环境生成任务已发送至服务端队列。',
        requireServerTask: true,
      },
    );
  };

  return (
    <div className={styles.scrollContainer}>
      <div className={styles.areaHeader}>
        <UserPlus size={18} />
        <h3>人物资产生成</h3>
        <button
          className={styles.btnSmall}
          onClick={() => handleGenerateCharacterAsset('主角')}
          disabled={isSubmitting}
        >
          <Send size={12} /> 生成主角人设
        </button>
      </div>

      <div className={styles.cardsGrid}>
        <div
          style={{
            color: 'var(--text-muted)',
            textAlign: 'center',
            width: '100%',
            padding: '20px',
          }}
        >
          暂无人物资产数据。点击上方按钮通过后端任务生成。
        </div>
      </div>

      <div className={styles.areaHeader} style={{ marginTop: '32px' }}>
        <Map size={18} />
        <h3>场景环境生成</h3>
        <button
          className={styles.btnSmall}
          onClick={() => handleGenerateSceneAsset('主场景')}
          disabled={isSubmitting}
        >
          <Send size={12} /> 生成主场景
        </button>
      </div>

      <div className={styles.cardsGrid}>
        <div
          style={{
            color: 'var(--text-muted)',
            textAlign: 'center',
            width: '100%',
            padding: '20px',
          }}
        >
          暂无场景资产数据。点击上方按钮通过后端任务生成。
        </div>
      </div>
    </div>
  );
};
