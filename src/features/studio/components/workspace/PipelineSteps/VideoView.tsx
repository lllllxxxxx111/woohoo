import React, { useState } from 'react';
import { Film, User, Map, Edit3, Video } from 'lucide-react';

import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';

export const VideoView: React.FC = () => {
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();
  const [promptOne, setPromptOne] = useState(
    '基于首尾帧动画，镜头平滑推进。广场上的千人练剑动作流畅有气势。4k，60fps，电影质感。',
  );
  const [promptTwo, setPromptTwo] = useState(
    '镜头向右摇摄，张三擦汗，然后铁剑掉落在地弹起。微表情捕捉：无奈。电影质感。',
  );

  const handleGen = (id: string, prompt: string) => {
    void launchTask(
      `@分镜渲染师 请为分镜 ${id} 创建视频生成任务。\n\n镜头提示词：${prompt}\n\n要求：\n1. 输出适合视频模型的精炼执行提示词。\n2. 说明镜头运动、时长、主体动作和风格。\n3. 如果提示词还不够，请先补齐缺失条件再执行。`,
      {
        successTitle: `分镜 ${id} 视频任务已提交`,
        successMessage: '这次操作会直接创建后端任务，不再只弹本地提示框。',
      },
    );
  };
  return (
    <div className={styles.scrollContainer}>
      <div className={styles.areaHeader}>
        <Film size={18} />
        <h3>视频镜头生成</h3>
      </div>

      <div className={styles.cardsGrid}>
        {/* Video Card 1 */}
        <div className={styles.entityCard}>
          <div className={styles.videoPreview}>
            <Video size={32} className={styles.placeholderIcon} />
            <span className={styles.timeTag}>10.0s</span>
          </div>
          <div className={styles.videoDetails}>
            <div className={styles.metadataTags}>
              <span className={styles.tagUser}>
                <Map size={12} /> 青云门-广场
              </span>
              <span className={styles.tagUser}>
                <User size={12} /> 张三
              </span>
            </div>

            <label>
              <Edit3 size={14} /> 生成提示语:
            </label>
            <textarea
              className={styles.promptInput}
              value={promptOne}
              onChange={(event) => setPromptOne(event.target.value)}
              rows={3}
            />
          </div>
          <div className={styles.cardActions}>
            <button className={styles.btnSecondary}>重写提示词</button>
            <button
              className={styles.btnPrimary}
              onClick={() => handleGen('1', promptOne)}
              disabled={isSubmitting}
            >
              执行视频生成
            </button>
          </div>
        </div>

        {/* Video Card 2 */}
        <div className={styles.entityCard}>
          <div className={styles.videoPreview}>
            <Video size={32} className={styles.placeholderIcon} />
            <span className={styles.timeTag}>5.0s</span>
          </div>
          <div className={styles.videoDetails}>
            <div className={styles.metadataTags}>
              <span className={styles.tagUser}>
                <Map size={12} /> 青云门-广场角落
              </span>
              <span className={styles.tagUser}>
                <User size={12} /> 张三
              </span>
            </div>

            <label>
              <Edit3 size={14} /> 生成提示语:
            </label>
            <textarea
              className={styles.promptInput}
              value={promptTwo}
              onChange={(event) => setPromptTwo(event.target.value)}
              rows={3}
            />
          </div>
          <div className={styles.cardActions}>
            <button className={styles.btnSecondary}>重写提示词</button>
            <button
              className={styles.btnPrimary}
              onClick={() => handleGen('2', promptTwo)}
              disabled={isSubmitting}
            >
              执行视频生成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
