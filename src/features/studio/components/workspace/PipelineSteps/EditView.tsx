import React from 'react';
import { Scissors, PlayCircle, Download } from 'lucide-react';
import styles from './PipelineSteps.module.css';

export const EditView: React.FC = () => {
  return (
    <div className={styles.containerCol}>
      <div className={styles.areaHeader}>
        <Scissors size={18} />
        <h3>剪辑与合成</h3>
        <span style={{ flex: 1 }}></span>
        <button className={styles.btnSecondary}>
          <PlayCircle size={14} /> 预览生成剧集
        </button>
        <button className={styles.btnPrimary}>
          <Download size={14} /> 导出成片
        </button>
      </div>

      {/* Fake timeline editor layout */}
      <div className={styles.editorTimelineView}>
        <div className={styles.videoPreviewArea}>
          <div className={styles.previewScreen}>
            <PlayCircle size={48} className={styles.placeholderIcon} />
            <span>产线最终合成预览</span>
          </div>
        </div>

        <div className={styles.timelineTracks}>
          <div className={styles.track}>
            <div className={styles.trackLabel}>画面</div>
            <div className={styles.trackItems}>
              <div className={styles.trackClip} style={{ width: '20%' }}>
                场景1
              </div>
              <div className={styles.trackClip} style={{ width: '10%' }}>
                场景2
              </div>
              <div className={styles.trackClip} style={{ width: '30%' }}>
                场景3
              </div>
              <div className={styles.trackClip} style={{ width: '15%' }}>
                场景4
              </div>
            </div>
          </div>

          <div className={styles.track}>
            <div className={styles.trackLabel}>配音</div>
            <div className={styles.trackItems}>
              <div className={styles.trackAudio} style={{ width: '18%', marginLeft: '2%' }}>
                配音轨 1
              </div>
              <div className={styles.trackAudio} style={{ width: '25%', marginLeft: '25%' }}>
                配音轨 2
              </div>
            </div>
          </div>

          <div className={styles.track}>
            <div className={styles.trackLabel}>音效/BGM</div>
            <div className={styles.trackItems}>
              <div className={styles.trackBGM} style={{ width: '100%' }}>
                背景音乐 1
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
