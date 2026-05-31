import React, { useMemo } from 'react';
import { Map, Send, UserPlus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';
import { createProjectSnapshot } from '../workspaceMvp';

export const CharSceneView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

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

  const handleGenerateCharacterAsset = (name: string, prompt: string) => {
    void launchTask(
      `@分镜渲染师 请为项目中的角色「${name}」生成三视图人设资产。\n\n要求：\n1. 输出正面、侧面、背面三个角度的视觉描述。\n2. 包含服装细节、配饰、标志性特征。\n3. 输出格式应可直接用于 AI 图像生成。\n\n补充信息：${prompt}`,
      {
        successTitle: '人物资产任务已提交',
        successMessage: '人设三视图生成任务已发送至服务端队列。',
        requireServerTask: true,
      },
    );
  };

  const handleGenerateSceneAsset = (sceneName: string, prompt: string) => {
    void launchTask(
      `@分镜渲染师 请为场景「${sceneName}」生成环境资产。\n\n要求：\n1. 描述场景的空间布局、光影氛围、色调。\n2. 列出关键道具和背景元素。\n3. 给出镜头机位建议（全景/中景/特写）。\n\n补充信息：${prompt}`,
      {
        successTitle: '场景资产任务已提交',
        successMessage: '场景环境生成任务已发送至服务端队列。',
        requireServerTask: true,
      },
    );
  };

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.scrollContainer}>
        <div className={styles.emptyMarkdownState}>
          <UserPlus size={20} />
          <span>请先选择项目，再生成角色和场景资产。</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scrollContainer}>
      <div className={styles.areaHeader}>
        <UserPlus size={18} />
        <div style={{ flex: 1 }}>
          <h3>人物资产生成</h3>
          <p className={styles.subText}>优先显示从现有剧本、分镜和资产中提取出的真实角色候选。</p>
        </div>
      </div>

      <div className={styles.cardsGrid}>
        {snapshot.characters.length > 0 ? (
          snapshot.characters.map((character) => (
            <div key={character.id} className={styles.entityCard}>
              <div className={styles.cardHeader}>
                {character.name}
                <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  已有关联资产 {character.assetCount}
                </span>
              </div>
              <p className={styles.scriptDesc}>{character.summary}</p>
              <div className={styles.promptArea}>
                <label>建议生成提示</label>
                <textarea className={styles.promptInput} value={character.prompt} readOnly rows={4} />
              </div>
              {character.assets.length > 0 && (
                <p className={styles.infoText}>参考素材：{character.assets.map((asset) => asset.name).join('、')}</p>
              )}
              <div className={styles.cardActions}>
                <button
                  className={styles.btnPrimary}
                  onClick={() => handleGenerateCharacterAsset(character.name, character.prompt)}
                  disabled={isSubmitting}
                >
                  <Send size={12} /> 生成人设
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className={styles.entityCard}>
            <div className={styles.cardHeader}>暂无角色候选</div>
            <p className={styles.infoText}>先补充剧本对白、角色命名或人物素材，系统才能自动提取更明确的人物资产任务。</p>
          </div>
        )}
      </div>

      <div className={styles.areaHeader} style={{ marginTop: '32px' }}>
        <Map size={18} />
        <div style={{ flex: 1 }}>
          <h3>场景环境生成</h3>
          <p className={styles.subText}>按当前分镜逐条展开，至少保证每个场景都能形成独立环境资产任务。</p>
        </div>
      </div>

      <div className={styles.cardsGrid}>
        {snapshot.scenes.length > 0 ? (
          snapshot.scenes.map((scene) => (
            <div key={scene.id} className={styles.entityCard}>
              <div className={styles.cardHeader}>
                {scene.name}
                <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  {scene.durationSeconds}s
                </span>
              </div>
              <p className={styles.scriptDesc}>{scene.summary}</p>
              <div className={styles.promptArea}>
                <label>场景生成提示</label>
                <textarea className={styles.promptInput} value={scene.prompt} readOnly rows={4} />
              </div>
              {scene.assets.length > 0 && (
                <p className={styles.infoText}>场景内已有素材：{scene.assets.map((asset) => asset.name).join('、')}</p>
              )}
              <div className={styles.cardActions}>
                <button
                  className={styles.btnPrimary}
                  onClick={() => handleGenerateSceneAsset(scene.name, scene.prompt)}
                  disabled={isSubmitting}
                >
                  <Send size={12} /> 生成场景
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className={styles.entityCard}>
            <div className={styles.cardHeader}>暂无场景候选</div>
            <p className={styles.infoText}>当前没有可用分镜，先在上一阶段补齐分镜或故事板。</p>
          </div>
        )}
      </div>
    </div>
  );
};
