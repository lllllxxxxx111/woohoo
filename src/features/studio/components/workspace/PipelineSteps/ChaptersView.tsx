import React, { useEffect, useMemo, useState } from 'react';
import { AlignJustify, Play, Target } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useShallow } from 'zustand/react/shallow';

import { useAppStore } from '../../../../../store';
import styles from './PipelineSteps.module.css';
import { usePipelineTaskLauncher } from './usePipelineTaskLauncher';
import {
  createProjectSnapshot,
  getLatestDocumentAsset,
  loadAssetText,
} from '../workspaceMvp';

export const ChaptersView: React.FC = () => {
  const { activeProject, activeScript, activeStoryboard, activeAssets } = useAppStore(
    useShallow((state) => ({
      activeProject: state.projects.find((project) => project.id === state.activeState.projectId) ?? null,
      activeScript: state.activeScript,
      activeStoryboard: state.activeStoryboard,
      activeAssets: state.activeAssets,
    })),
  );
  const [targetDuration, setTargetDuration] = useState('60');
  const [chapterDocumentText, setChapterDocumentText] = useState('');
  const [isLoadingDocument, setIsLoadingDocument] = useState(false);
  const { launchTask, isSubmitting } = usePipelineTaskLauncher();

  const latestChapterAsset = useMemo(
    () => getLatestDocumentAsset(activeAssets, 'chapter'),
    [activeAssets],
  );

  useEffect(() => {
    if (!latestChapterAsset) {
      setChapterDocumentText('');
      setIsLoadingDocument(false);
      return;
    }

    let cancelled = false;
    setIsLoadingDocument(true);
    void loadAssetText(latestChapterAsset)
      .then((text) => {
        if (!cancelled) {
          setChapterDocumentText(text.trim());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChapterDocumentText('');
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
  }, [latestChapterAsset]);

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

  const totalDuration = useMemo(
    () => snapshot?.chapters.reduce((sum, chapter) => sum + chapter.durationSeconds, 0) ?? 0,
    [snapshot?.chapters],
  );

  const handleSyncChat = () => {
    void launchTask(
      `@大纲架构师 请把当前剧本拆成章节，并按约 ${targetDuration || '60'} 秒总时长重新规划节奏。\n\n要求：\n1. 输出章节列表与每节时长。\n2. 标出关键场景和人物出场。\n3. 给出下一步人物/场景资产生成建议。`,
      {
        successTitle: '章节拆解任务已提交',
        successMessage: '章节规划会由后端真实任务处理并回写到对话区。',
      },
    );
  };

  if (!activeProject || !snapshot) {
    return (
      <div className={styles.splitLayout}>
        <div className={styles.mainArea}>
          <div className={styles.emptyMarkdownState}>
            <AlignJustify size={20} />
            <span>请先选择项目，再查看章节规划。</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.splitLayout}>
      <div className={styles.mainArea}>
        <div className={styles.areaHeader}>
          <AlignJustify size={18} />
          <h3>剧本分节规划</h3>
        </div>

        <div className={styles.durationControl}>
          <label>
            <Target size={16} /> 目标短片时长(秒)
          </label>
          <input
            type="number"
            value={targetDuration}
            onChange={(event) => setTargetDuration(event.target.value)}
            className={styles.numberInput}
          />
          <button className={styles.btnSecondary} onClick={handleSyncChat} disabled={isSubmitting}>
            <Play size={14} /> 自动重算章节
          </button>
        </div>

        {isLoadingDocument ? (
          <div className={styles.emptyMarkdownState}>
            <span>正在读取章节文档…</span>
          </div>
        ) : chapterDocumentText ? (
          <div className={styles.markdownPreview}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{chapterDocumentText}</ReactMarkdown>
          </div>
        ) : (
          <div className={styles.longScrollArea}>
            {snapshot.chapters.length > 0 ? (
              snapshot.chapters.map((chapter) => (
                <div key={chapter.id} className={styles.chapterCard}>
                  <div className={styles.chapterHeader}>
                    <strong>{chapter.title}</strong>
                    <span className={styles.chapterTime}>{chapter.durationSeconds}s</span>
                  </div>
                  <p className={styles.chapterText}>{chapter.summary}</p>
                  {chapter.sceneNumbers.length > 0 && (
                    <p className={styles.infoText}>覆盖分镜：{chapter.sceneNumbers.join('、')}</p>
                  )}
                  {chapter.characters.length > 0 && (
                    <p className={styles.infoText}>角色出场：{chapter.characters.join('、')}</p>
                  )}
                </div>
              ))
            ) : (
              <div
                className={styles.chapterCard}
                style={{
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  background: 'transparent',
                  border: 'none',
                  boxShadow: 'none',
                }}
              >
                <p>当前还没有章节拆解结果。可以先提交章节任务，或先补齐剧本和分镜。</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.sidePanel}>
        <div className={styles.panelBlock}>
          <h4 className={styles.panelTitle}>数据汇总</h4>
          <p className={styles.summaryStat}>
            <span>章节数量</span>
            <strong>{snapshot.chapters.length}</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>总时长</span>
            <strong>{totalDuration}s</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>分镜数量</span>
            <strong>{activeStoryboard?.lines.length ?? 0}</strong>
          </p>
          <p className={styles.summaryStat}>
            <span>角色候选</span>
            <strong>{snapshot.characters.length}</strong>
          </p>
        </div>

        <div className={styles.panelBlock}>
          <p className={styles.infoText}>
            如果已经跑过章节拆解流水线，这里会优先显示后端生成的章节文档；否则退化为基于当前剧本和分镜推导的最小章节视图，保证流程先可读、可导出。
          </p>
        </div>

        <div className={styles.panelActions}>
          <button className={styles.btnPrimary} onClick={handleSyncChat} disabled={isSubmitting}>
            提交章节任务
          </button>
        </div>
      </div>
    </div>
  );
};
