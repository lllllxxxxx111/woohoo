import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Layers, Sparkles } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';
import { createProjectSnapshot } from '../workspaceMvp';

export const KeyframeView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();
  const [drafts, setDrafts] = useState<Record<string, { startPrompt: string; endPrompt: string }>>({});

  const snapshot = useMemo(() => {
    if (!activeProject) {
      return null;
    }

    return createProjectSnapshot({
      project: activeProject,
      script: activeScript,
      scriptText: activeScript?.content ?? '',
      storyboard: activeStoryboard,
      assets: activeAssets,
    });
  }, [activeAssets, activeProject, activeScript, activeStoryboard]);

  useEffect(() => {
    if (!snapshot) {
      setDrafts({});
      return;
    }

    setDrafts(
      Object.fromEntries(
        snapshot.keyframes.map((frame) => [
          frame.id,
          { startPrompt: frame.startPrompt, endPrompt: frame.endPrompt },
        ]),
      ),
    );
  }, [snapshot]);

  const handleBatch = () => {
    void launchTask(
      '@分镜渲染师 请根据当前项目的分镜与资产，批量生成关键帧任务。\n\n要求：\n1. 为每个分镜明确首帧、尾帧与镜头运动。\n2. 缺少素材时先指出缺口。\n3. 输出适合后续视频生成的关键帧描述。',
      {
        successTitle: '关键帧任务已提交',
        successMessage: '批量关键帧请求已经进入后端任务队列。',
      },
    );
  };

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.scrollContainer}>
        <div className={styles.emptyMarkdownState}>
          <Layers size={20} />
          <span>请先选择项目，再查看关键帧步骤。</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scrollContainer}>
      <div className={styles.areaHeader}>
        <Layers size={18} />
        <div style={{ flex: 1 }}>
          <h3>关键帧生成（首尾帧定位）</h3>
          <p className={styles.subText}>
            当前内容直接从项目分镜推导，不再固定展示两张示例卡片。
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
        {snapshot.keyframes.length > 0 ? (
          snapshot.keyframes.map((frame) => (
            <div key={frame.id} className={styles.kfRow}>
              <div className={styles.kfMeta}>
                <h4>分镜 {String(frame.sceneNumber).padStart(2, '0')}</h4>
                <p>
                  {frame.durationSeconds}s | {frame.title}
                </p>
              </div>
              <div className={styles.kfVisuals}>
                <div className={styles.kfImageWrapper}>
                  <span className={styles.kfTag}>首帧</span>
                  <div className={styles.kfPlaceholder}>
                    <ImageIcon size={24} />
                  </div>
                </div>
                <div className={styles.kfConnector}>
                  <span>镜头运动：{frame.motion}</span>
                </div>
                <div className={styles.kfImageWrapper}>
                  <span className={styles.kfTag}>尾帧</span>
                  <div className={styles.kfPlaceholder}>
                    <ImageIcon size={24} />
                  </div>
                </div>
              </div>
              <div className={styles.promptArea}>
                <label>首帧提示</label>
                <textarea
                  className={styles.promptInput}
                  value={drafts[frame.id]?.startPrompt ?? frame.startPrompt}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [frame.id]: {
                        startPrompt: event.target.value,
                        endPrompt: current[frame.id]?.endPrompt ?? frame.endPrompt,
                      },
                    }))
                  }
                  rows={3}
                />
                <label>尾帧提示</label>
                <textarea
                  className={styles.promptInput}
                  value={drafts[frame.id]?.endPrompt ?? frame.endPrompt}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [frame.id]: {
                        startPrompt: current[frame.id]?.startPrompt ?? frame.startPrompt,
                        endPrompt: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                />
              </div>
              {frame.assets.length > 0 && (
                <p className={styles.infoText}>参考素材：{frame.assets.map((asset) => asset.name).join('、')}</p>
              )}
            </div>
          ))
        ) : (
          <div className={styles.entityCard}>
            <div className={styles.cardHeader}>暂无关键帧输入</div>
            <p className={styles.infoText}>当前没有分镜数据，无法推导首尾关键帧。先补齐分镜，再回到本步骤。</p>
          </div>
        )}
      </div>
    </div>
  );
};
