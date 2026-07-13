import React, { useEffect, useMemo, useState } from 'react';
import { AlignLeft, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';
import {
  createProjectSnapshot,
  loadAssetText,
  resolveInlineScriptText,
} from '../workspaceMvp';

export const ScriptView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();
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

  const handleSyncChat = () => {
    void launchTask(
      '请基于当前项目已有的大纲、角色和上下文，产出一版完整剧本，并在结尾补充章节拆解建议与合规提醒。',
      {
        successTitle: '剧本任务已提交',
        successMessage: '剧本生成会走真实后端任务，结果会回写到当前对话。',
      },
    );
  };

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
                    ? '当前显示的是最近一次对话里识别到的长文本剧本。'
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
            <button type="button" onClick={handleSyncChat}>
              生成剧本
            </button>
          </div>
        )}
      </div>

      <div className={styles.sidePanel}>
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
            这一页现在直接消费项目里的真实剧本或剧本文档，不再固定显示占位文案。后续如果大纲或对话产出新剧本，只要同步到项目，就会在这里更新。
          </p>
        </div>

        <div className={styles.panelActions}>
          <button className={styles.btnPrimary} onClick={handleSyncChat} disabled={isSubmitting}>
            提交剧本任务
          </button>
        </div>
      </div>
    </div>
  );
};
