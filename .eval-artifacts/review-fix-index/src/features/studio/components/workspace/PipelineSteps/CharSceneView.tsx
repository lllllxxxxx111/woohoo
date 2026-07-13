import React, { useCallback, useMemo, useState } from 'react';
import { LoaderCircle, Map, Send, UserPlus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import { useToast } from '../../../../../context/useToast';
import { createImageGeneration } from '../../../../../lib/serverApi';
import styles from './PipelineSteps.module.css';
import { createProjectSnapshot } from '../workspaceMvp';

export const CharSceneView: React.FC = () => {
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
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  /** 生成角色人设资产：调用图片生成 API */
  const handleGenerateCharacterAsset = useCallback(async (name: string, prompt: string) => {
    setIsSubmitting(true);
    try {
      await createImageGeneration({
        projectId: activeState.projectId ?? '',
        prompt: `角色三视图人设：${name}。${prompt}。输出正面、侧面、背面三个角度，电影质感，高细节`,
        model: 'dall-e-3',
        size: '1024x1792',
        n: 1,
      });
      showToast({ type: 'success', title: '人物资产任务已提交', message: `角色「${name}」人设生成任务已创建。` });
    } catch (error) {
      showToast({ type: 'error', title: '人物资产生成失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setIsSubmitting(false);
    }
  }, [activeState.projectId, showToast]);

  /** 生成场景环境资产：调用图片生成 API */
  const handleGenerateSceneAsset = useCallback(async (sceneName: string, prompt: string) => {
    setIsSubmitting(true);
    try {
      await createImageGeneration({
        projectId: activeState.projectId ?? '',
        prompt: `场景环境概念图：${sceneName}。${prompt}。广角全景，电影级光影，16:9`,
        model: 'dall-e-3',
        size: '1792x1024',
        n: 1,
      });
      showToast({ type: 'success', title: '场景资产任务已提交', message: `场景「${sceneName}」环境生成任务已创建。` });
    } catch (error) {
      showToast({ type: 'error', title: '场景资产生成失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setIsSubmitting(false);
    }
  }, [activeState.projectId, showToast]);

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
                  onClick={() => void handleGenerateCharacterAsset(character.name, character.prompt)}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? <LoaderCircle size={12} className={styles.iconSpin} /> : <Send size={12} />} 生成人设
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
                  onClick={() => void handleGenerateSceneAsset(scene.name, scene.prompt)}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? <LoaderCircle size={12} className={styles.iconSpin} /> : <Send size={12} />} 生成场景
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
