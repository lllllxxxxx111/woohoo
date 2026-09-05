import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from '@arco-design/web-react';
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  LoaderCircle,
  PlayCircle,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import {
  createAiTask,
  createPipelineRun,
  getServerScript,
  isVersionConflictError,
} from '../../../../lib/serverApi';
import {
  applyConflictResolution,
  shouldPromptCopyDraft,
  toConflictState,
  type SaveConflictState,
} from '../../../../lib/versionConflict';
import { ContentVersionHistory } from './ContentVersionHistory';
import styles from './ScriptEditor.module.css';

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略并回退到 execCommand
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch {
    return false;
  }
}

export interface ScriptEditorProps {
  /** 兼容旧流水线仅产出文档资产时，把当前可见剧本文本带入首次保存。 */
  initialContent?: string;
  onClose?: () => void;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ initialContent = '', onClose }) => {
  const { activeScript, activeState, aiSettings } = useAppStore(
    useShallow((state) => ({
      activeScript: state.activeScript,
      activeState: state.activeState,
      aiSettings: state.aiSettings,
    })),
  );
  const { saveScript, refreshWorkspace } = useAppActions();
  const { showToast } = useToast();
  const [content, setContent] = useState(activeScript?.content || initialContent);
  const [baseVersion, setBaseVersion] = useState<number>(activeScript?.version ?? 0);
  const [conflict, setConflict] = useState<SaveConflictState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAiWorking, setIsAiWorking] = useState(false);

  const activeScriptId = activeScript?.id;
  const activeProjectId = activeState.projectId;
  const savedContent = activeScript?.content || initialContent;
  const hasUnsavedChanges = content !== savedContent;

  // 切换到另一个项目的剧本时重置本地状态（冲突期间不自动覆盖草稿）
  useEffect(() => {
    setContent(activeScript?.content || initialContent);
    setBaseVersion(activeScript?.version ?? 0);
    setConflict(null);
    // 只在切换项目/剧本实体时重置；普通 workspace 刷新不能覆盖未保存草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeScriptId]);

  // 旧流水线文档可能异步加载；仅在当前编辑区仍为空时补入，避免覆盖用户输入。
  useEffect(() => {
    if (!activeScript && initialContent) {
      setContent((current) => current || initialContent);
    }
  }, [activeScript, initialContent]);

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
      const savedScript = await saveScript(activeState.projectId, content, activeScript?.title, {
        baseVersion,
        source: 'manual',
      });
      if (typeof savedScript.version === 'number') {
        setBaseVersion(savedScript.version);
      } else {
        // 旧服务端/网关可能不回传 version：保留旧 baseVersion 会让后续每次
        // 保存都 409。主动拉一次当前文档重新对齐。
        const latest = await getServerScript(activeState.projectId).catch(() => null);
        setBaseVersion(latest?.version ?? 0);
      }
      setConflict(null);
      showToast({
        type: 'success',
        title: '剧本已保存',
        message: `已同步到后端：${savedScript.title}（v${savedScript.version ?? '?'}）`,
      });
    } catch (error) {
      if (isVersionConflictError(error)) {
        // 保留本地草稿，仅提示冲突并给出安全选项
        setConflict(toConflictState(error));
        showToast({
          type: 'warning',
          title: '保存冲突',
          message: `服务器内容已更新到 v${error.currentVersion}，你的草稿已保留，请选择处理方式。`,
        });
      } else {
        showToast({
          type: 'error',
          title: '保存失败',
          message: error instanceof Error ? error.message : '剧本保存失败',
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = useCallback(() => {
    if (!hasUnsavedChanges) {
      onClose?.();
      return;
    }
    Modal.confirm({
      title: '放弃未保存的修改？',
      content: '当前剧本还有未保存的修改，返回预览会丢弃这些修改。',
      okText: '丢弃并返回',
      cancelText: '继续编辑',
      onOk: () => onClose?.(),
    });
  }, [hasUnsavedChanges, onClose]);

  /** 冲突时：加载服务器最新版（替换当前草稿前先确认并自动复制草稿兜底） */
  const handleLoadServerLatest = useCallback(async () => {
    const projectId = activeState.projectId;
    if (!projectId) {
      return;
    }
    const draftCopied = shouldPromptCopyDraft(content) ? await copyTextToClipboard(content) : false;
    const message = draftCopied
      ? '将丢弃当前草稿并加载服务器最新版（草稿已复制到剪贴板）。确定继续吗？'
      : '将丢弃当前草稿并加载服务器最新版，该操作无法撤销。确定继续吗？';
    Modal.confirm({
      title: '加载服务器最新版',
      content: message,
      okText: '丢弃草稿并加载',
      cancelText: '取消',
      onOk: async () => {
        try {
          const latest = await getServerScript(projectId);
          // 草稿保护：仅当成功拿到服务器内容才替换草稿，失败时绝不丢弃草稿
          const next = applyConflictResolution(
            { draft: content, conflict },
            'load_server_latest',
            latest ? latest.content : null,
          );
          setContent(next.draft);
          setConflict(next.conflict);
          if (latest && next.conflict === null) {
            setBaseVersion(latest.version ?? 0);
          }
          void refreshWorkspace('script conflict resolution');
        } catch (error) {
          showToast({
            type: 'error',
            title: '加载失败',
            message: error instanceof Error ? error.message : '无法加载服务器最新版本',
          });
        }
      },
    });
  }, [activeState.projectId, content, conflict, refreshWorkspace, showToast]);

  /** 冲突时：复制当前草稿到剪贴板 */
  const handleCopyDraft = useCallback(async () => {
    const succeeded = await copyTextToClipboard(content);
    showToast({
      type: succeeded ? 'success' : 'error',
      title: succeeded ? '草稿已复制' : '复制失败',
      message: succeeded
        ? '当前草稿已复制到剪贴板，可加载最新版后再粘贴合并。'
        : '当前环境不支持自动复制，请手动选择文本复制。',
    });
  }, [content, showToast]);

  /** 版本恢复成功后重新拉取当前内容 */
  const handleVersionRestored = useCallback(async () => {
    if (!activeState.projectId) {
      return;
    }
    try {
      const latest = await getServerScript(activeState.projectId);
      if (latest) {
        setContent(latest.content);
        setBaseVersion(latest.version ?? 0);
      }
      setConflict(null);
      void refreshWorkspace('script version restored');
    } catch (error) {
      // 恢复已在服务端生效，但本地拉取失败：必须让用户知道编辑器内容
      // 已过期，否则会带着旧内容与旧 baseVersion 继续编辑并触发混乱的 409。
      showToast({
        type: 'error',
        title: '同步恢复结果失败',
        message:
          error instanceof Error && error.message
            ? `服务器已恢复，但拉取最新内容失败：${error.message}。请手动刷新后再编辑。`
            : '服务器已恢复，但拉取最新内容失败，请手动刷新后再编辑。',
      });
    }
  }, [activeState.projectId, refreshWorkspace, showToast]);

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
      showToast({
        type: 'success',
        title: '续写任务已提交',
        message: 'AI 正在为你的剧本生成续写内容。',
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '续写失败',
        message: error instanceof Error ? error.message : '提交失败',
      });
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

    if (aiSettings.multiAgentBetaEnabled !== true) {
      showToast({
        type: 'warning',
        title: '制作流程未开启',
        message: '请先在设置中开启“多智能体制作流程”，再生成分镜。',
      });
      return;
    }

    setIsAiWorking(true);
    try {
      await createPipelineRun({
        projectId: activeState.projectId,
        conversationId: activeState.chatSessionId ?? '',
        pipelineType: 'script',
        betaEnabled: true,
        steps: [
          {
            stepKey: 'storyboard_generate',
            stepName: '分镜拆分',
            stepOrder: 1,
            stepType: 'design',
            promptTemplate: `请根据以下剧本生成分镜。
只输出 JSON，不要 Markdown 或解释文字，格式必须是：
{"lines":[{"sceneNumber":1,"description":"镜头画面描述","duration":5,"assetIds":[]}]}

剧本：
${content.trim()}`,
          },
        ],
      });
      showToast({
        type: 'success',
        title: '分镜生成任务已提交',
        message: '制作流程正在运行，请在剧本步骤页面查看进度。',
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '分镜生成失败',
        message: error instanceof Error ? error.message : '提交失败',
      });
    } finally {
      setIsAiWorking(false);
    }
  }, [
    activeState.chatSessionId,
    activeState.projectId,
    aiSettings.multiAgentBetaEnabled,
    content,
    showToast,
  ]);

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
            {isAiWorking ? (
              <LoaderCircle size={16} className={styles.iconSpin} />
            ) : (
              <Sparkles size={16} />
            )}{' '}
            智能续写
          </button>
          <button
            className={styles.toolBtn}
            title="转分镜"
            onClick={() => void handleGenerateStoryboard()}
            disabled={isAiWorking}
          >
            {isAiWorking ? (
              <LoaderCircle size={16} className={styles.iconSpin} />
            ) : (
              <PlayCircle size={16} />
            )}{' '}
            生成分镜
          </button>
          {onClose ? (
            <button className={styles.toolBtn} title="返回剧本预览" onClick={handleClose}>
              <ArrowLeft size={16} /> 返回预览
            </button>
          ) : null}
          {activeState.projectId && (
            <ContentVersionHistory
              projectId={activeState.projectId}
              contentType="script"
              currentVersion={activeScript?.version}
              onRestored={() => void handleVersionRestored()}
              hasUnsavedChanges={hasUnsavedChanges}
              draftText={content}
            />
          )}
        </div>
        <button className={styles.saveBtn} onClick={() => void handleSave()} disabled={isSaving}>
          <Save size={16} /> {isSaving ? '保存中...' : '保存'}
        </button>
      </header>

      {conflict && (
        <div className={styles.conflictBanner}>
          <AlertTriangle size={16} />
          <span>
            保存冲突：服务器剧本已更新到 v{conflict.currentVersion}
            ，你的本地草稿尚未保存，已为你保留。
          </span>
          <div className={styles.conflictActions}>
            <button
              className={styles.conflictBtn}
              onClick={() => void handleCopyDraft()}
              title="将当前草稿复制到剪贴板"
            >
              <Copy size={14} /> 复制当前草稿
            </button>
            <button
              className={styles.conflictBtn}
              onClick={() => void handleLoadServerLatest()}
              title="丢弃草稿并使用服务器最新内容"
            >
              <RefreshCw size={14} /> 加载服务器最新版
            </button>
          </div>
        </div>
      )}

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
                  ? `当前项目已存在主剧本（v${activeScript.version ?? '?'}），编辑后可保存为新版本。`
                  : '当前项目还没有主剧本，首次保存会自动创建版本 v1。'}
              </p>
            </div>
            <div className={styles.reviewItem}>
              <h4>结构建议</h4>
              <p className={styles.warningText}>建议用标题行或场景标记拆段，便于后续一键转分镜。</p>
            </div>
            <div className={styles.reviewItem}>
              <h4>版本与并发</h4>
              <p className={styles.successText}>
                每次保存生成不可变版本；若他人先行保存，系统会提示冲突并保留你的草稿。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
