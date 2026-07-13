import React, { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, PlayCircle, Save, Sparkles } from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import { createAiTask, createPipelineRun } from '../../../../lib/serverApi';
import styles from './ScriptEditor.module.css';

export const ScriptEditor: React.FC = () => {
  const { activeScript, activeState } = useAppStore(
    useShallow((state) => ({ activeScript: state.activeScript, activeState: state.activeState })),
  );
  const { saveScript } = useAppActions();
  const { showToast } = useToast();
  const [content, setContent] = useState(activeScript?.content || '');
  const [isSaving, setIsSaving] = useState(false);
  const [isAiWorking, setIsAiWorking] = useState(false);

  useEffect(() => {
    setContent(activeScript?.content || '');
  }, [activeScript?.content, activeScript?.id, activeScript?.updatedAt]);

  const handleSave = async () => {
    if (!activeState.projectId) {
      showToast({
        type: 'warning',
        title: '暂无项目',
        message: '请先创建或选择一个项目，再保存剧本。',
      });
      return;
    }

    setIsSaving(true);
    try {
      const savedScript = await saveScript(activeState.projectId, content, activeScript?.title);
      showToast({
        type: 'success',
        title: '剧本已保存',
        message: `已同步到后端：${savedScript.title}`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '剧本保存失败',
      });
    } finally {
      setIsSaving(false);
    }
  };

  /** 智能续写：调用 AI 任务为当前剧本生成续写内容 */
  const handleSmartContinue = useCallback(async () => {
    if (!activeState.projectId || !activeState.chatSessionId) {
      showToast({ type: 'warning', title: '缺少上下文', message: '请先选择项目和对话。' });
      return;
    }

    if (!content.trim()) {
      showToast({ type: 'warning', title: '剧本为空', message: '请先输入一些内容，AI 才能续写。' });
      return;
    }

    setIsAiWorking(true);
    try {
      const lastParagraph = content.slice(-500);
      await createAiTask({
        conversationId: activeState.chatSessionId,
        content: `请续写以下剧本内容，保持风格和人物一致：\n\n${lastParagraph}\n\n续写：`,
        outputKind: 'text',
      });
      showToast({ type: 'success', title: '续写任务已提交', message: 'AI 正在为你的剧本生成续写内容。' });
    } catch (error) {
      showToast({ type: 'error', title: '续写失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setIsAiWorking(false);
    }
  }, [activeState.chatSessionId, activeState.projectId, content, showToast]);

  /** 生成分镜：基于当前剧本内容创建 Pipeline Run 生成故事板 */
  const handleGenerateStoryboard = useCallback(async () => {
    if (!activeState.projectId) {
      showToast({ type: 'warning', title: '缺少项目', message: '请先选择项目再生成分镜。' });
      return;
    }

    if (!content.trim()) {
      showToast({ type: 'warning', title: '剧本为空', message: '请先编写剧本内容再生成分镜。' });
      return;
    }

    setIsAiWorking(true);
    try {
      await createPipelineRun({
        projectId: activeState.projectId,
        conversationId: activeState.chatSessionId ?? '',
        steps: [
          { stepKey: 'script_parse', stepName: '剧本解析', stepOrder: 1, stepType: 'system' },
          { stepKey: 'storyboard_generate', stepName: '分镜拆分', stepOrder: 2, stepType: 'design' },
          { stepKey: 'keyframe_extract', stepName: '关键帧提取', stepOrder: 3, stepType: 'design' },
        ],
      });
      showToast({ type: 'success', title: '分镜生成任务已提交', message: 'Pipeline 正在运行，请在大纲视图中查看进度。' });
    } catch (error) {
      showToast({ type: 'error', title: '分镜生成失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setIsAiWorking(false);
    }
  }, [activeState.chatSessionId, activeState.projectId, content, showToast]);

  return (
    <div className={styles.container}>
      <header className={styles.toolbar}>
        <div className={styles.toolsList}>
          <button
            className={styles.toolBtn}
            title="智能续写"
            onClick={() => void handleSmartContinue()}
            disabled={isAiWorking}
          >
            {isAiWorking ? <LoaderCircle size={16} className={styles.iconSpin} /> : <Sparkles size={16} />} 智能续写
          </button>
          <button
            className={styles.toolBtn}
            title="转分镜"
            onClick={() => void handleGenerateStoryboard()}
            disabled={isAiWorking}
          >
            {isAiWorking ? <LoaderCircle size={16} className={styles.iconSpin} /> : <PlayCircle size={16} />} 生成分镜
          </button>
        </div>
        <button className={styles.saveBtn} onClick={() => void handleSave()} disabled={isSaving}>
          <Save size={16} /> {isSaving ? '保存中...' : '保存'}
        </button>
      </header>

      <div className={styles.editorWrapper}>
        <textarea
          className={styles.scriptTextarea}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="在此输入或生成你的剧本..."
        />

        <aside className={styles.aiPanel}>
          <div className={styles.panelHeader}>
            <span>
              <Sparkles size={14} className={styles.iconSp} /> 剧本智能审核
            </span>
          </div>
          <div className={styles.panelContent}>
            <div className={styles.reviewItem}>
              <h4>保存状态</h4>
              <p className={styles.successText}>
                {activeScript
                  ? '当前项目已存在主剧本，可继续编辑并覆盖保存。'
                  : '当前项目还没有主剧本，首次保存会自动创建。'}
              </p>
            </div>
            <div className={styles.reviewItem}>
              <h4>结构建议</h4>
              <p className={styles.warningText}>建议用标题行或场景标记拆段，便于后续一键转分镜。</p>
            </div>
            <div className={styles.reviewItem}>
              <h4>同步目标</h4>
              <p className={styles.successText}>保存后会直接写入后端数据库，并在刷新后保留。</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
