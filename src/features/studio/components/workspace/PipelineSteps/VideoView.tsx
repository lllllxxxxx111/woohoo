import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit3, Film, Map, User, Video } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { createVideoGeneration, getVideoGeneration } from '../../../../../lib/serverApi';
import type { VideoGeneration } from '../../../../../lib/serverApi';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot, type DerivedVideoShot } from '../workspaceMvp';

function rewriteShotPrompt(shot: DerivedVideoShot) {
  const assetHint = shot.assets.length > 0 ? `参考素材：${shot.assets.map((asset) => asset.name).join('、')}。` : '';
  const characterHint = shot.characters.length > 0 ? `角色：${shot.characters.join('、')}。` : '';
  return `${shot.prompt} 输出 16:9 连续镜头，主体运动明确，前后动作连贯。${characterHint}${assetHint}`;
}

export const VideoView: React.FC = () => {
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
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [submittingShotId, setSubmittingShotId] = useState<string | null>(null);
  const [generations, setGenerations] = useState<Record<string, VideoGeneration>>({});

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

  /** 轮询未完成的视频生成任务状态 */
  useEffect(() => {
    const pendingGens = Object.entries(generations).filter(
      ([, gen]) => gen.status === 'pending' || gen.status === 'processing',
    );
    if (pendingGens.length === 0) return;

    const interval = setInterval(() => {
      void Promise.all(
        pendingGens.map(async ([shotId, gen]) => {
          try {
            const updated = await getVideoGeneration(gen.id);
            setGenerations((prev) => ({ ...prev, [shotId]: updated }));
          } catch {
            // 轮询失败静默处理
          }
        }),
      );
    }, 5000);

    return () => clearInterval(interval);
  }, [generations]);

  /** 提交视频生成任务到 video-gen API */
  const handleGen = useCallback(async (shot: DerivedVideoShot, prompt: string) => {
    if (!prompt.trim()) {
      showToast({ type: 'warning', title: '提示词为空', message: '请先填写视频生成提示词。' });
      return;
    }

    setSubmittingShotId(shot.id);
    try {
      const generation = await createVideoGeneration({
        projectId: activeState.projectId ?? undefined,
        prompt,
        model: 'wan2.1-t2v-480p',
        durationSeconds: shot.durationSeconds || undefined,
        aspectRatio: '16:9',
      });

      setGenerations((prev) => ({ ...prev, [shot.id]: generation }));

      showToast({
        type: 'success',
        title: `分镜 ${shot.sceneNumber} 视频任务已提交`,
        message: `任务ID: ${generation.id.slice(0, 8)}...，状态: ${generation.status}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '视频生成提交失败',
        message: error instanceof Error ? error.message : '后端任务创建失败',
      });
    } finally {
      setSubmittingShotId(null);
    }
  }, [activeState.projectId, showToast]);

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
      <div className={styles.areaHeader}>
        <Film size={18} />
        <div style={{ flex: 1 }}>
          <h3>视频镜头生成</h3>
          <p className={styles.subText}>镜头卡片来自当前分镜，点击执行将直接调用视频生成 API。</p>
        </div>
      </div>

      <div className={styles.cardsGrid}>
        {snapshot.videoShots.length > 0 ? (
          snapshot.videoShots.map((shot) => {
            const gen = generations[shot.id];
            const isSubmitting = submittingShotId === shot.id;
            const isProcessing = gen && (gen.status === 'pending' || gen.status === 'processing');
            const isCompleted = gen && gen.status === 'completed';
            const isFailed = gen && gen.status === 'failed';

            return (
              <div key={shot.id} className={styles.entityCard}>
                <div className={styles.videoPreview}>
                  {isCompleted && gen.url ? (
                    <video
                      src={gen.url}
                      className={styles.videoResult}
                      muted
                      loop
                      onMouseEnter={(e) => (e.target as HTMLVideoElement).play()}
                      onMouseLeave={(e) => {
                        const v = e.target as HTMLVideoElement;
                        v.pause();
                        v.currentTime = 0;
                      }}
                    />
                  ) : (
                    <>
                      <Video size={32} className={styles.placeholderIcon} />
                      <span className={styles.timeTag}>{shot.durationSeconds.toFixed(1)}s</span>
                    </>
                  )}
                </div>
                <div className={styles.videoDetails}>
                  <div className={styles.metadataTags}>
                    <span className={styles.tagUser}>
                      <Map size={12} /> {shot.location}
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
                  {isProcessing && (
                    <p className={styles.infoText} style={{ color: 'var(--color-primary-6)' }}>
                      生成中... (任务 {gen.id.slice(0, 8)})
                    </p>
                  )}
                  {isFailed && gen.errorMessage && (
                    <p className={styles.infoText} style={{ color: 'var(--color-danger-6)' }}>
                      失败: {gen.errorMessage}
                    </p>
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
                    onClick={() => void handleGen(shot, prompts[shot.id] ?? shot.prompt)}
                    disabled={isSubmitting || isProcessing}
                  >
                    {isSubmitting ? '提交中...' : isProcessing ? '生成中...' : '执行视频生成'}
                  </button>
                </div>
              </div>
            );
          })
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
