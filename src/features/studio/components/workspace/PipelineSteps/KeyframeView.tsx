import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Layers, Sparkles } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { createImageGeneration } from '../../../../../lib/serverApi';
import type { ImageGeneration } from '../../../../../lib/serverApi';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot } from '../workspaceMvp';

export const KeyframeView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets, activeState } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
      activeState: state.activeState,
    })),
  );
  const { showToast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, { startPrompt: string; endPrompt: string }>>({});
  const [generatingFrame, setGeneratingFrame] = useState<string | null>(null);
  const [frameGenerations, setFrameGenerations] = useState<Record<string, ImageGeneration>>({});

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

  /** 为单个关键帧（首帧或尾帧）调用图片生成 API */
  const handleGenFrame = useCallback(async (
    frameId: string,
    prompt: string,
    position: 'start' | 'end',
  ) => {
    if (!prompt.trim()) {
      showToast({ type: 'warning', title: '提示词为空', message: '请先填写关键帧提示词。' });
      return;
    }

    const key = `${frameId}-${position}`;
    setGeneratingFrame(key);
    try {
      const generation = await createImageGeneration({
        projectId: activeState.projectId ?? '',
        prompt,
        model: 'dall-e-3',
        size: '1792x1024',
        n: 1,
      });

      setFrameGenerations((prev) => ({ ...prev, [key]: generation }));

      showToast({
        type: 'success',
        title: `${position === 'start' ? '首帧' : '尾帧'}图片已提交`,
        message: `任务ID: ${generation.id.slice(0, 8)}...，状态: ${generation.status}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '关键帧图片生成失败',
        message: error instanceof Error ? error.message : '后端任务创建失败',
      });
    } finally {
      setGeneratingFrame(null);
    }
  }, [activeState.projectId, showToast]);

  /** 批量生成所有关键帧的首帧图片 */
  const handleBatch = useCallback(async () => {
    if (!snapshot) return;

    const frames = snapshot.keyframes;
    let successCount = 0;

    for (const frame of frames) {
      const startPrompt = drafts[frame.id]?.startPrompt ?? frame.startPrompt;
      if (!startPrompt.trim()) continue;

      try {
        const generation = await createImageGeneration({
          projectId: activeState.projectId ?? '',
          prompt: startPrompt,
          model: 'dall-e-3',
          size: '1792x1024',
          n: 1,
        });

        setFrameGenerations((prev) => ({ ...prev, [`${frame.id}-start`]: generation }));
        successCount++;
      } catch {
        // 继续处理后续帧
      }
    }

    showToast({
      type: successCount > 0 ? 'success' : 'warning',
      title: '批量关键帧任务已提交',
      message: successCount > 0
        ? `已提交 ${successCount}/${frames.length} 个首帧生成任务`
        : '所有帧提交失败，请检查配置',
    });
  }, [activeState.projectId, drafts, showToast, snapshot]);

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
            从项目分镜推导关键帧，点击生成将调用图片生成 API。
          </p>
        </div>
        <button
          className={styles.btnPrimary}
          style={{ width: 'max-content', padding: '10px 16px' }}
          onClick={() => void handleBatch()}
          disabled={generatingFrame !== null}
        >
          <Sparkles size={14} /> 批量生成关键帧
        </button>
      </div>

      <div className={styles.keyframeList}>
        {snapshot.keyframes.length > 0 ? (
          snapshot.keyframes.map((frame) => {
            const startGen = frameGenerations[`${frame.id}-start`];
            const endGen = frameGenerations[`${frame.id}-end`];

            return (
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
                    {startGen && startGen.status === 'completed' && startGen.urls.length > 0 ? (
                      <img src={startGen.urls[0]} alt="首帧" className={styles.kfGeneratedImage} />
                    ) : (
                      <div className={styles.kfPlaceholder}>
                        <ImageIcon size={24} />
                      </div>
                    )}
                  </div>
                  <div className={styles.kfConnector}>
                    <span>镜头运动：{frame.motion}</span>
                  </div>
                  <div className={styles.kfImageWrapper}>
                    <span className={styles.kfTag}>尾帧</span>
                    {endGen && endGen.status === 'completed' && endGen.urls.length > 0 ? (
                      <img src={endGen.urls[0]} alt="尾帧" className={styles.kfGeneratedImage} />
                    ) : (
                      <div className={styles.kfPlaceholder}>
                        <ImageIcon size={24} />
                      </div>
                    )}
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
                  <button
                    className={styles.btnSecondary}
                    style={{ marginTop: 4, fontSize: 12, padding: '4px 10px' }}
                    onClick={() => void handleGenFrame(frame.id, drafts[frame.id]?.startPrompt ?? frame.startPrompt, 'start')}
                    disabled={generatingFrame === `${frame.id}-start`}
                  >
                    {generatingFrame === `${frame.id}-start` ? '生成中...' : '生成首帧'}
                  </button>
                  <label style={{ marginTop: 8 }}>尾帧提示</label>
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
                  <button
                    className={styles.btnSecondary}
                    style={{ marginTop: 4, fontSize: 12, padding: '4px 10px' }}
                    onClick={() => void handleGenFrame(frame.id, drafts[frame.id]?.endPrompt ?? frame.endPrompt, 'end')}
                    disabled={generatingFrame === `${frame.id}-end`}
                  >
                    {generatingFrame === `${frame.id}-end` ? '生成中...' : '生成尾帧'}
                  </button>
                </div>
                {frame.assets.length > 0 && (
                  <p className={styles.infoText}>参考素材：{frame.assets.map((asset) => asset.name).join('、')}</p>
                )}
              </div>
            );
          })
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
