import React, { useMemo } from 'react';
import { LoaderCircle, Map, Play, PauseCircle, RotateCw, Send, UserPlus, XCircle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import {
  usePipelineRunController,
  type PipelineStepInput,
} from './usePipelineRunController';
import { getErrorCodePreset } from './pipelineStatusPresets';
import styles from './PipelineSteps.module.css';
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

  // 接入共享 Pipeline Run 控制器（req #1：角色/场景接入真实 image_gen step）
  // pipelineType='custom'（DB 白名单限制），用 triggerSource='char_scene' 区分
  const {
    currentRun,
    isSubmitting,
    displayState,
    displayPreset,
    currentStep,
    launch,
    pause,
    resume,
    cancel,
    retryStep,
  } = usePipelineRunController({
    pipelineType: 'custom',
    triggerSource: 'char_scene',
  });

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

  /**
   * 生成角色人设资产（req #1：image_gen step，reviewPolicy 与后端 parse_image_gen_params 契约对齐）
   *
   * @param name 角色名
   * @param prompt 角色描述
   */
  const handleGenerateCharacterAsset = (name: string, prompt: string) => {
    const steps: PipelineStepInput[] = [
      {
        stepKey: 'char_scene_character',
        stepName: `角色人设：${name}`,
        stepOrder: 1,
        stepType: 'image_gen',
        maxRetries: 2,
        reviewPolicy: {
          prompt: `角色三视图人设：${name}。${prompt}。输出正面、侧面、背面三个角度，电影质感，高细节`,
          size: '1024x1792',
          n: 1,
          model: 'dall-e-3',
        },
        dependsOn: [],
      },
    ];
    void launch(steps, { idempotencyScope: `character:${name}` });
  };

  /**
   * 生成场景环境资产（req #1：image_gen step，reviewPolicy 与后端 parse_image_gen_params 契约对齐）
   *
   * @param sceneName 场景名
   * @param prompt 场景描述
   */
  const handleGenerateSceneAsset = (sceneName: string, prompt: string) => {
    const steps: PipelineStepInput[] = [
      {
        stepKey: 'char_scene_environment',
        stepName: `场景环境：${sceneName}`,
        stepOrder: 1,
        stepType: 'image_gen',
        maxRetries: 2,
        reviewPolicy: {
          prompt: `场景环境概念图：${sceneName}。${prompt}。广角全景，电影级光影，16:9`,
          size: '1792x1024',
          n: 1,
          model: 'dall-e-3',
        },
        dependsOn: [],
      },
    ];
    void launch(steps, { idempotencyScope: `scene:${sceneName}` });
  };

  // 错误码对应的可操作提示（req #3：前端展示可操作提示，不静默失败）
  const errorCodePreset = getErrorCodePreset(currentRun?.run.errorCode ?? null);

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
      {/* 流程状态面板（req #5：统一状态文案、进度、下一步操作） */}
      <div className={styles.areaHeader}>
        <UserPlus size={18} />
        <div style={{ flex: 1 }}>
          <h3>人物资产生成</h3>
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
                  onClick={() => handleGenerateSceneAsset(scene.name, scene.prompt)}
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
