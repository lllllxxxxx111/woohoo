import React, { useEffect, useMemo, useState } from 'react';
import { Edit3, Film, Map as MapIcon, PauseCircle, Play, RotateCw, User, Video, XCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { listProjectVideoShotAssets } from '../../../../../lib/serverApi';
import type { Asset } from '../../../../../types';
import {
  usePipelineRunController,
  type PipelineStepInput,
} from './usePipelineRunController';
import { getErrorCodePreset } from './pipelineStatusPresets';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot, type DerivedVideoShot } from '../workspaceMvp';

const VIDEO_STEP_KEY_PREFIX = 'video_shot_';

/**
 * 重写镜头提示词，加入角色与素材参考
 *
 * @param shot 视频镜头数据
 * @returns 增强后的提示词
 */
function rewriteShotPrompt(shot: DerivedVideoShot): string {
  const assetHint =
    shot.assets.length > 0 ? `参考素材：${shot.assets.map((asset) => asset.name).join('、')}。` : '';
  const characterHint =
    shot.characters.length > 0 ? `角色：${shot.characters.join('、')}。` : '';
  return `${shot.prompt} 输出 16:9 连续镜头，主体运动明确，前后动作连贯。${characterHint}${assetHint}`;
}

export const VideoView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );

  // 接入共享 Pipeline Run 控制器（req #1：视频接入真实 video_gen step）
  // pipelineType='custom'（DB 白名单限制），用 triggerSource='video' 区分
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
    triggerSource: 'video',
  });

  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const { showToast } = useToast();

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
      setPrompts({});
      return;
    }

    setPrompts(
      Object.fromEntries(snapshot.videoShots.map((shot) => [shot.id, shot.prompt])),
    );
  }, [snapshot]);

  /**
   * 把已完成 video_gen 步骤的产出 asset 映射回镜头卡片。
   * 走 /video-assets 端点跨 run 聚合（每个镜头一次启动、各自一个 run，
   * 仅看 currentRun 会漏掉历史镜头），重复生成取最新。
   */
  const [shotVideoAssets, setShotVideoAssets] = useState<Map<string, Asset>>(new Map());
  useEffect(() => {
    if (!activeProject) {
      setShotVideoAssets(new Map());
      return undefined;
    }
    let cancelled = false;
    listProjectVideoShotAssets(activeProject.id)
      .then((items) => {
        if (cancelled) {
          return;
        }
        const next = new Map<string, Asset>();
        items.forEach((item) => {
          if (item.stepKey.startsWith(VIDEO_STEP_KEY_PREFIX)) {
            next.set(item.stepKey.slice(VIDEO_STEP_KEY_PREFIX.length), item.asset);
          }
        });
        setShotVideoAssets(next);
      })
      .catch(() => {
        // 素材聚合失败不阻塞页面，卡片回退占位图标
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject, currentRun?.run.status]);

  /**
   * 提交视频生成任务到 pipeline video_gen step（req #1：真实 video_gen step）
   *
   * reviewPolicy 与后端 parse_video_gen_params 契约对齐：
   * { prompt, model:'wan2.1-t2v-480p', durationSeconds, aspectRatio:'16:9' }
   *
   * 彻底消除原 setInterval 轮询 getVideoGeneration（req #2 硬性要求），
   * 状态由 SSE/受控刷新回传。
   *
   * @param shot 视频镜头数据
   * @param prompt 提示词
   */
  const handleGen = (shot: DerivedVideoShot, prompt: string) => {
    if (!prompt.trim()) {
      showToast({
        type: 'warning',
        title: '提示词为空',
        message: '请先填写该镜头的生成提示词，再执行视频生成。',
      });
      return;
    }
    const steps: PipelineStepInput[] = [
      {
        stepKey: `video_shot_${shot.id}`,
        stepName: `视频镜头 ${String(shot.sceneNumber).padStart(2, '0')}：${shot.location}`,
        stepOrder: 1,
        stepType: 'video_gen',
        maxRetries: 2,
        reviewPolicy: {
          prompt,
          model: 'wan2.1-t2v-480p',
          durationSeconds: shot.durationSeconds || 5,
          aspectRatio: '16:9',
        },
        dependsOn: [],
      },
    ];
    void launch(steps, { idempotencyScope: `video:${shot.id}` });
  };

  // 错误码对应的可操作提示（req #3：前端展示可操作提示，不静默失败）
  const errorCodePreset = getErrorCodePreset(currentRun?.run.errorCode ?? null);

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.scrollContainer}>
        <div className={styles.emptyMarkdownState}>
          <Film size={20} />
          <span>请先选择项目，再查看视频镜头步骤。</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scrollContainer}>
      {/* 流程状态面板（req #5：统一状态文案、进度、下一步操作） */}
      <div className={styles.areaHeader}>
        <Film size={18} />
        <div style={{ flex: 1 }}>
          <h3>视频镜头生成</h3>
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

      <div className={styles.cardsGrid}>
        {snapshot.videoShots.length > 0 ? (
          snapshot.videoShots.map((shot) => (
            <div key={shot.id} className={styles.entityCard}>
              <div className={styles.videoPreview}>
                {shotVideoAssets.get(shot.id) ? (
                  <video
                    className={styles.videoPlayer}
                    src={shotVideoAssets.get(shot.id)!.url}
                    controls
                    preload="metadata"
                  />
                ) : (
                  <Video size={32} className={styles.placeholderIcon} />
                )}
                <span className={styles.timeTag}>{shot.durationSeconds.toFixed(1)}s</span>
              </div>
              <div className={styles.videoDetails}>
                <div className={styles.metadataTags}>
                  <span className={styles.tagUser}>
                    <MapIcon size={12} /> {shot.location}
                  </span>
                  {shot.characters.map((character) => (
                    <span key={`${shot.id}-${character}`} className={styles.tagUser}>
                      <User size={12} /> {character}
                    </span>
                  ))}
                </div>

                <label>
                  <Edit3 size={14} /> 生成提示词
                </label>
                <textarea
                  className={styles.promptInput}
                  value={prompts[shot.id] ?? shot.prompt}
                  onChange={(event) =>
                    setPrompts((current) => ({
                      ...current,
                      [shot.id]: event.target.value,
                    }))
                  }
                  rows={4}
                />
                {shot.assets.length > 0 && (
                  <p className={styles.infoText}>素材参考：{shot.assets.map((asset) => asset.name).join('、')}</p>
                )}
              </div>
              <div className={styles.cardActions}>
                <button
                  className={styles.btnSecondary}
                  onClick={() =>
                    setPrompts((current) => ({
                      ...current,
                      [shot.id]: rewriteShotPrompt(shot),
                    }))
                  }
                >
                  重写提示词
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={() => handleGen(shot, prompts[shot.id] ?? shot.prompt)}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? '提交中...' : '执行视频生成'}
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className={styles.entityCard}>
            <div className={styles.cardHeader}>暂无镜头输入</div>
            <p className={styles.infoText}>当前项目还没有可用于视频生成的分镜。先补齐剧本和分镜，再进入视频阶段。</p>
          </div>
        )}
      </div>
    </div>
  );
};
