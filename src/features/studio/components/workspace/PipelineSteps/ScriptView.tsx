import React, { useEffect, useMemo, useState } from 'react';
import { AlignLeft, FileText, Play, PauseCircle, RotateCw, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import {
  usePipelineRunController,
  type PipelineStepInput,
} from './usePipelineRunController';
import { getErrorCodePreset } from './pipelineStatusPresets';
import {
  createProjectSnapshot,
  loadAssetText,
  resolveInlineScriptText,
} from '../workspaceMvp';

/**
 * 构造剧本设计步骤的提示词
 *
 * @returns 剧本设计 prompt
 */
const buildScriptDesignPrompt = (): string =>
  `@主编统筹官 请基于当前项目已有的大纲、角色、资产和上下文，产出一版可直接进入制作流程的完整短片剧本。

输出要求：
1. 第一行必须是 "# 完整剧本"，不要在剧本正文前输出"优化方案""问题复盘""执行结果""职责确认"等过程说明。
2. 正文按场次组织，每场使用 "## 第1场 内/外景 地点 时间" 这种标题。
3. 每场至少包含动作/画面描述和角色对白，对白格式使用 "角色名：台词"。
4. 结尾只允许追加 "## 制作备注"，里面用简短要点列出章节拆解建议和合规提醒；不要把大纲设计稿、复盘、任务摘要混入剧本正文。
5. 如果信息不足，请基于当前项目做最小合理假设并在制作备注中标注，不要反问。`;

/**
 * 构造剧本审核步骤的提示词
 *
 * @returns 剧本审核 prompt
 */
const buildScriptReviewPrompt = (): string =>
  `你是剧本审核官，请审核上游步骤产出的剧本，并给出可执行评语。

审核标准：
1. 结构完整度（场次标题、对白格式、制作备注）
2. 节奏可执行性（每场有动作/画面和对白）
3. 合规与风险（是否有明显风险或不当表述）

如果不通过，请给出可执行修改项和重试建议。
必须只返回 JSON，不要使用 Markdown 代码块或解释文字：
{"decision":"pass|fail","score":0.0,"issues":["问题或通过理由"],"retryHints":["下一步建议"],"riskLevel":"low|medium|high"}`;

export const ScriptView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );

  // 接入共享 Pipeline Run 控制器（req #1：剧本接入真实步骤）
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
  } = usePipelineRunController({ pipelineType: 'script' });

  const [resolvedScriptText, setResolvedScriptText] = useState('');
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);

  const inlineScript = useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return resolveInlineScriptText(activeProject, activeScript, activeAssets);
  }, [activeAssets, activeProject, activeScript]);

  useEffect(() => {
    if (!inlineScript) {
      setResolvedScriptText('');
      setIsLoadingDocument(false);
      return;
    }

    if (inlineScript.content) {
      setResolvedScriptText(inlineScript.content);
      setIsLoadingDocument(false);
      return;
    }

    if (inlineScript.source !== 'asset' || !inlineScript.asset) {
      setResolvedScriptText('');
      setIsLoadingDocument(false);
      return;
    }

    let cancelled = false;
    setIsLoadingDocument(true);
    void loadAssetText(inlineScript.asset)
      .then((text) => {
        if (!cancelled) {
          setResolvedScriptText(text.trim());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedScriptText('');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDocument(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inlineScript]);

  const snapshot = useMemo(() => {
    if (!activeProject) {
      return null;
    }

    return createProjectSnapshot({
      project: activeProject,
      script: activeScript,
      scriptText: resolvedScriptText,
      storyboard: activeStoryboard,
      assets: activeAssets,
    });
  }, [activeAssets, activeProject, activeScript, activeStoryboard, resolvedScriptText]);

  const dialogueCount = useMemo(() => {
    if (!snapshot?.scriptText) {
      return 0;
    }
    return Array.from(snapshot.scriptText.matchAll(/^([^\n#：:]{1,12})[：:]/gm)).length;
  }, [snapshot?.scriptText]);

  const characterCount = useMemo(() => snapshot?.characters.length ?? 0, [snapshot?.characters.length]);

  /**
   * 提交剧本生成任务（req #1：剧本接入真实 pipeline design step）
   *
   * 提交 script_design + script_review 两步：
   * - script_design：design 步骤，reviewPolicy.requires 声明 ['project:outline'] 跨阶段依赖（req #3）
   * - script_review：review 步骤，依赖 script_design
   */
  const handleLaunchScript = () => {
    const steps: PipelineStepInput[] = [
      {
        stepKey: 'script_design',
        stepName: '剧本设计',
        stepOrder: 1,
        stepType: 'design',
        maxRetries: 2,
        reviewPolicy: {
          requires: ['project:outline'],
        },
        promptTemplate: buildScriptDesignPrompt(),
      },
      {
        stepKey: 'script_review',
        stepName: '剧本审核',
        stepOrder: 2,
        stepType: 'review',
        dependsOn: ['script_design'],
        maxRetries: 2,
        reviewPolicy: {
          strictJson: true,
          requiredFields: ['decision', 'score', 'issues', 'retryHints'],
        },
        promptTemplate: buildScriptReviewPrompt(),
      },
    ];
    void launch(steps);
  };

  // 错误码对应的可操作提示（req #3：前端展示可操作提示，不静默失败）
  const errorCodePreset = getErrorCodePreset(currentRun?.run.errorCode ?? null);

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.splitLayout}>
        <div className={styles.mainArea}>
          <div className={styles.emptyMarkdownState}>
            <FileText size={20} />
            <span>请先选择项目，再查看剧本步骤。</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.splitLayout}>
      <div className={styles.mainArea}>
        <div className={styles.areaHeader}>
          <FileText size={18} />
          <div style={{ flex: 1 }}>
            <h3>完整剧本</h3>
            <p className={styles.subText}>
              {inlineScript?.source === 'script'
                ? '当前显示的是已保存到项目的主剧本。'
                : inlineScript?.source === 'asset'
                  ? '当前显示的是项目里最新的剧本文档资产。'
                  : inlineScript?.source === 'chat'
                    ? '当前显示的是最近一次对话里识别到的候选剧本文本。'
                    : '当前项目还没有可用剧本。'}
            </p>
          </div>
        </div>

        {isLoadingDocument ? (
          <div className={styles.emptyMarkdownState}>
            <span>正在读取剧本文档…</span>
          </div>
        ) : snapshot.scriptText ? (
          <div className={styles.markdownPreview}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.scriptText}</ReactMarkdown>
          </div>
        ) : (
          <div className={styles.emptyMarkdownState}>
            <FileText size={20} />
            <span>当前项目还没有剧本内容。</span>
            <button type="button" onClick={handleLaunchScript}>
              生成剧本
            </button>
          </div>
        )}
      </div>

      <div className={styles.sidePanel}>
        {/* 流程状态面板（req #5：统一状态文案、进度、下一步操作） */}
        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>
            <Play size={16} /> 流程状态
          </h4>
          <p className={styles.summaryStat}>
            <span>当前状态</span>
            <strong>{displayPreset.label}</strong>
          </p>
          <p className={styles.infoText}>{displayPreset.hint}</p>
          {currentStep ? (
            <p className={styles.summaryStat}>
              <span>当前步骤</span>
              <strong>{currentStep.stepName}</strong>
            </p>
          ) : null}
          {errorCodePreset ? (
            <p className={styles.infoText} style={{ color: 'var(--danger-text, #d4380d)' }}>
              {errorCodePreset.label}：{errorCodePreset.hint}
            </p>
          ) : null}
          <div className={styles.panelActions}>
            {displayPreset.nextActions.includes('pause') ? (
              <button
                className={styles.btnPrimary}
                onClick={() => void pause()}
                disabled={isSubmitting}
              >
                <PauseCircle size={14} /> 暂停
              </button>
            ) : null}
            {displayPreset.nextActions.includes('resume') ? (
              <button
                className={styles.btnPrimary}
                onClick={() => void resume()}
                disabled={isSubmitting}
              >
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
              <button
                className={styles.btnPrimary}
                onClick={() => void cancel()}
                disabled={isSubmitting}
              >
                <XCircle size={14} /> 取消
              </button>
            ) : null}
            {displayPreset.nextActions.includes('advance') || displayState === 'queued' ? (
              <button
                className={styles.btnPrimary}
                onClick={handleLaunchScript}
                disabled={isSubmitting}
              >
                <Play size={14} /> 提交剧本任务
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>
            <AlignLeft size={16} /> 剧本目录
          </h4>
          <ul className={styles.tocList}>
            {snapshot.scriptSections.length > 0 ? (
              snapshot.scriptSections.map((section, index) => (
                <li key={section.id} className={index === 0 ? styles.active : undefined}>
                  {section.title}
                </li>
              ))
            ) : (
              <li style={{ color: 'var(--text-muted)' }}>暂无目录</li>
            )}
          </ul>
        </div>

        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>项目状态</h4>
          <p className={styles.summaryStat}>
            <span>结构段落</span>
            <strong>{snapshot.scriptSections.length}</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>对白条数</span>
            <strong>{dialogueCount}</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>角色候选</span>
            <strong>{characterCount}</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>分镜数量</span>
            <strong>{activeStoryboard?.lines.length ?? 0}</strong>
          </p>
        </div>

        <div className={styles.panelBlock}>
          <p className={styles.infoText}>
            这一页直接消费项目里的真实剧本或剧本文档，并通过 Pipeline 真实任务提交剧本生成与审核，状态由后端 orchestrator 推进、SSE 回传。
          </p>
        </div>
      </div>
    </div>
  );
};
