import React from 'react';
import { Layers, Image as ImageIcon, Sparkles } from 'lucide-react';

import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';

export const KeyframeView: React.FC = () => {
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

  const handleBatch = () => {
    void launchTask(
      '@分镜渲染师 请根据当前项目的分镜与资产，批量生成关键帧任务。\n\n要求：\n1. 为每个分镜明确首帧、尾帧与镜头运动。\n2. 缺少素材时先指出缺口。\n3. 输出适合后续视频生成的关键帧描述。',
      {
        successTitle: '关键帧任务已提交',
        successMessage: '批量关键帧请求已经进入后端任务队列。',
      },
    );
  };
  return (
    <div className={styles.scrollContainer}>
      <div className={styles.areaHeader}>
        <Layers size={18} />
        <div style={{ flex: 1 }}>
          <h3>关键帧生成 (首尾帧定位)</h3>
          <p className={styles.subText}>
            基于人物、场景资产与分镜时间轴，生成视频过渡所需的首尾控制帧。
          </p>
        </div>
        <button
          className={styles.btnPrimary}
          style={{ width: 'max-content', padding: '10px 16px' }}
          onClick={handleBatch}
          disabled={isSubmitting}
        >
          <Sparkles size={14} /> 批量生成关键帧
        </button>
      </div>

      <div className={styles.keyframeList}>
        {/* Item 1 */}
        <div className={styles.kfRow}>
          <div className={styles.kfMeta}>
            <h4>分镜 01</h4>
            <p>10s | 广场鸟瞰</p>
          </div>
          <div className={styles.kfVisuals}>
            <div className={styles.kfImageWrapper}>
              <span className={styles.kfTag}>首帧 (0s)</span>
              <div className={styles.kfPlaceholder}>
                <ImageIcon size={24} />
              </div>
            </div>
            <div className={styles.kfConnector}>
              <span>运动轨迹: 缓推 (Dolly In)</span>
            </div>
            <div className={styles.kfImageWrapper}>
              <span className={styles.kfTag}>尾帧 (10s)</span>
              <div className={styles.kfPlaceholder}>
                <ImageIcon size={24} />
              </div>
            </div>
          </div>
          <div className={styles.kfDesc}>
            <textarea
              className={styles.promptInput}
              defaultValue="广角镜头：清晨的青云门外门广场，无数灰衣弟子整齐划一地练剑，场面宏大。"
            />
          </div>
        </div>

        {/* Item 2 */}
        <div className={styles.kfRow}>
          <div className={styles.kfMeta}>
            <h4>分镜 02</h4>
            <p>5s | 张三特写</p>
          </div>
          <div className={styles.kfVisuals}>
            <div className={styles.kfImageWrapper}>
              <span className={styles.kfTag}>首帧 (0s)</span>
              <div className={styles.kfPlaceholder}>
                <ImageIcon size={24} />
              </div>
            </div>
            <div className={styles.kfConnector}>
              <span>运动轨迹: 摇摄 (Pan Right)</span>
            </div>
            <div className={styles.kfImageWrapper}>
              <span className={styles.kfTag}>尾帧 (5s)</span>
              <div className={styles.kfPlaceholder}>
                <ImageIcon size={24} />
              </div>
            </div>
          </div>
          <div className={styles.kfDesc}>
            <textarea
              className={styles.promptInput}
              defaultValue="特写镜头：张三缩在广场角落，满头大汗，手里拿着一把生锈的铁剑，神情无奈。"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
