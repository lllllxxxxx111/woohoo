import React, { useEffect, useMemo, useState } from 'react';
import { Edit3, Film, Map, User, Video } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';
import { createProjectSnapshot, type DerivedVideoShot } from '../workspaceMvp';

function rewriteShotPrompt(shot: DerivedVideoShot) {
  const assetHint = shot.assets.length > 0 ? `参考素材：${shot.assets.map((asset) => asset.name).join('、')}。` : '';
  const characterHint = shot.characters.length > 0 ? `角色：${shot.characters.join('、')}。` : '';
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
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();
  const [prompts, setPrompts] = useState<Record<string, string>>({});

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

  const handleGen = (shot: DerivedVideoShot, prompt: string) => {
    void launchTask(
      `@分镜渲染师 请为分镜 ${shot.sceneNumber} 创建视频生成任务。\n\n镜头提示词：${prompt}\n\n要求：\n1. 输出适合视频模型的精炼执行提示词。\n2. 说明镜头运动、时长、主体动作和风格。\n3. 如果提示词还不够，请先补齐缺失条件再执行。`,
      {
        successTitle: `分镜 ${shot.sceneNumber} 视频任务已提交`,
        successMessage: '这次操作会直接创建后端任务，不再只是本地提示。',
      },
    );
  };

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
          <p className={styles.subText}>镜头卡片现在来自当前分镜，不再写死两条演示 prompt。</p>
        </div>
      </div>

      <div className={styles.cardsGrid}>
        {snapshot.videoShots.length > 0 ? (
          snapshot.videoShots.map((shot) => (
            <div key={shot.id} className={styles.entityCard}>
              <div className={styles.videoPreview}>
                <Video size={32} className={styles.placeholderIcon} />
                <span className={styles.timeTag}>{shot.durationSeconds.toFixed(1)}s</span>
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
                  执行视频生成
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
