import React, { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Layers, Play, PauseCircle, RotateCw, Sparkles, XCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import {
  usePipelineRunController,
  type PipelineStepInput,
} from './usePipelineRunController';
import { getErrorCodePreset } from './pipelineStatusPresets';
import styles from './PipelineSteps.module.css';
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

  // 接入共享 Pipeline Run 控制器（req #1：关键帧接入真实 image_gen step）
  // pipelineType='custom'（DB 白名单限制），用 triggerSource='keyframe' 区分
  const {
    currentRun,
    isSubmitting,
    displayPreset,
    currentStep,
    launch,
    pause,
    resume,
    cancel,
    retryStep,
  } = usePipelineRunController({
    pipelineType: 'custom',
    triggerSource: 'keyframe',
  });

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

  /**
   * 为单个关键帧（首帧或尾帧）提交 image_gen 步骤（req #1：真实 image_gen step）
   *
   * @param frameId 关键帧 ID
   * @param prompt 提示词
   * @param position 首帧/尾帧
   */
  const handleGenFrame = (frameId: string, prompt: string, position: 'start' | 'end') => {
    if (!prompt.trim()) {
      return;
    }
    const steps: PipelineStepInput[] = [
      {
        stepKey: `keyframe_${frameId}_${position}`,
        stepName: `关键帧 ${frameId.slice(0, 8)} ${position === 'start' ? '首帧' : '尾帧'}`,
        stepOrder: 1,
        stepType: 'image_gen',
        maxRetries: 2,
        reviewPolicy: {
          prompt,
          size: '1792x1024',
          n: 1,
          model: 'dall-e-3',
        },
        dependsOn: [],
      },
    ];
    void launch(steps, { idempotencyScope: `${frameId}:${position}` });
  };

  /**
   * 批量生成所有关键帧的首帧图片（req #1：合并为多 step 的 image_gen run）
   *
   * 每个关键帧作为一个独立的 image_gen step，并行执行（dependsOn 为空）。
   */
  const handleBatch = () => {
    if (!snapshot) return;

    const steps: PipelineStepInput[] = snapshot.keyframes
      .map((frame, index): PipelineStepInput | null => {
        const startPrompt = drafts[frame.id]?.startPrompt ?? frame.startPrompt;
        if (!startPrompt.trim()) return null;
        return {
          stepKey: `keyframe_${frame.id}_start`,
          stepName: `关键帧 ${String(frame.sceneNumber).padStart(2, '0')} 首帧`,
          stepOrder: index + 1,
          stepType: 'image_gen',
          maxRetries: 2,
          reviewPolicy: {
            prompt: startPrompt,
            size: '1792x1024',
            n: 1,
            model: 'dall-e-3',
          },
          dependsOn: [],
        };
      })
      .filter((step): step is PipelineStepInput => step !== null);

    if (steps.length === 0) return;
    void launch(steps, { idempotencyScope: 'batch:start' });
  };

  // 错误码对应的可操作提示（req #3：前端展示可操作提示，不静默失败）
  const errorCodePreset = getErrorCodePreset(currentRun?.run.errorCode ?? null);

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
      {/* 流程状态面板（req #5：统一状态文案、进度、下一步操作） */}
      <div className={styles.areaHeader}>
        <Layers size={18} />
        <div style={{ flex: 1 }}>
          <h3>关键帧生成（首尾帧定位）</h3>
          <p className={styles.subText}>
            状态：{displayPreset.label} · {displayPreset.hint}
          </p>
        </div>
        <div className={styles.panelActions}>
          {displayPreset.nextActions.includes('pause') ? (
            <button className={styles.btnPrimary} onClick={() => void pause()} disabled={isSubmitting}>
              <PauseCircle size={14} /> 暂停
            </button>
          ) : null}
          {displayPreset.nextActions.includes('resume') ? (
            <button className={styles.btnPrimary} onClick={() => void resume()} disabled={isSubmitting}>
              <Play size={14} /> 恢复
            </button>
          ) : null}
          {displayPreset.nextActions.includes('retry_step') && currentStep ? (
            <button
              className={styles.btnPrimary}
              onClick={() => void retryStep(currentStep.id)}
              disabled={isSubmitting}
            >
              <RotateCw size={14} /> 重试
            </button>
          ) : null}
          {displayPreset.nextActions.includes('cancel') ? (
            <button className={styles.btnPrimary} onClick={() => void cancel()} disabled={isSubmitting}>
              <XCircle size={14} /> 取消
            </button>
          ) : null}
          <button
            className={styles.btnPrimary}
            style={{ width: 'max-content', padding: '10px 16px' }}
            onClick={handleBatch}
            disabled={isSubmitting}
          >
            <Sparkles size={14} /> 批量生成关键帧
          </button>
        </div>
      </div>

      {errorCodePreset ? (
        <p className={styles.infoText} style={{ color: 'var(--danger-text, #d4380d)' }}>
          {errorCodePreset.label}：{errorCodePreset.hint}
        </p>
      ) : null}

      {currentStep ? (
        <p className={styles.infoText}>
          当前步骤：{currentStep.stepName}（{currentStep.status}）
        </p>
      ) : null}

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
                <button
                  className={styles.btnSecondary}
                  style={{ marginTop: 4, fontSize: 12, padding: '4px 10px' }}
                  onClick={() =>
                    handleGenFrame(frame.id, drafts[frame.id]?.startPrompt ?? frame.startPrompt, 'start')
                  }
                  disabled={isSubmitting}
                >
                  {isSubmitting ? '生成中...' : '生成首帧'}
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
                  onClick={() =>
                    handleGenFrame(frame.id, drafts[frame.id]?.endPrompt ?? frame.endPrompt, 'end')
                  }
                  disabled={isSubmitting}
                >
                  {isSubmitting ? '生成中...' : '生成尾帧'}
                </button>
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
