import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Clock,
  Copy,
  Image as ImageIcon,
  LoaderCircle,
  Music,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import {
  createImageGeneration,
  createVideoGeneration,
  getServerStoryboard,
  isVersionConflictError,
} from '../../../../lib/serverApi';
import {
  applyConflictResolution,
  shouldPromptCopyDraft,
  toConflictState,
  type SaveConflictState,
} from '../../../../lib/versionConflict';
import type { StoryboardLine } from '../../../../types';
import { ContentVersionHistory } from './ContentVersionHistory';
import styles from './StoryboardArea.module.css';

function createLineId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `line-${crypto.randomUUID()}`;
  }

  return `line-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftLine(sceneNumber: number): StoryboardLine {
  return {
    id: createLineId(),
    sceneNumber,
    description: '请填写镜头描述',
    duration: 3,
    assets: [],
  };
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略并回退
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

export const StoryboardArea: React.FC = () => {
  const { activeStoryboard, activeState } = useAppStore(
    useShallow((state) => ({
      activeStoryboard: state.activeStoryboard,
      activeState: state.activeState,
    })),
  );
  const { saveStoryboard, refreshWorkspace } = useAppActions();
  const { showToast } = useToast();
  const [lines, setLines] = useState<StoryboardLine[]>(activeStoryboard?.lines || []);
  const [baseVersion, setBaseVersion] = useState<number>(activeStoryboard?.version ?? 0);
  const [conflict, setConflict] = useState<SaveConflictState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [generatingLineId, setGeneratingLineId] = useState<string | null>(null);

  const activeStoryboardId = activeStoryboard?.id;

  // 切换到另一个项目的分镜时重置本地状态（冲突期间不自动覆盖草稿）
  useEffect(() => {
    setLines(activeStoryboard?.lines || []);
    setBaseVersion(activeStoryboard?.version ?? 0);
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoryboardId]);

  const handleCreateStoryboard = async () => {
    if (!activeState.projectId) {
      showToast({
        type: 'warning',
        title: '暂无项目',
        message: '请先创建或选择一个项目，再创建分镜。',
      });
      return;
    }

    const initialLines = [createDraftLine(1)];
    setLines(initialLines);

    setIsSaving(true);
    try {
      const saved = await saveStoryboard(activeState.projectId, initialLines, {
        baseVersion,
        source: 'manual',
      });
      if (typeof saved.version === 'number') {
        setBaseVersion(saved.version);
      } else {
        // 响应缺 version 时主动对齐，避免后续保存持续 409。
        const latest = await getServerStoryboard(activeState.projectId).catch(() => null);
        setBaseVersion(latest?.version ?? 0);
      }
      setConflict(null);
      showToast({
        type: 'success',
        title: '分镜已创建',
        message: '已为当前项目创建首个分镜镜头。',
      });
    } catch (error) {
      if (isVersionConflictError(error)) {
        setConflict(toConflictState(error));
        showToast({
          type: 'warning',
          title: '保存冲突',
          message: `服务器分镜已更新到 v${error.currentVersion}，你的草稿已保留。`,
        });
      } else {
        showToast({
          type: 'error',
          title: '创建失败',
          message: error instanceof Error ? error.message : '创建分镜失败',
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddScene = () => {
    setLines((prev) => [...prev, createDraftLine(prev.length + 1)]);
  };

  const handleRemoveScene = (lineId: string) => {
    setLines((prev) =>
      prev
        .filter((line) => line.id !== lineId)
        .map((line, index) => ({ ...line, sceneNumber: index + 1 })),
    );
  };

  const handleLineChange = (
    lineId: string,
    field: 'description' | 'duration',
    value: string | number,
  ) => {
    setLines((prev) =>
      prev.map((line) =>
        line.id !== lineId
          ? line
          : {
              ...line,
              [field]: field === 'duration' ? Math.max(1, Number(value) || 1) : String(value),
            },
      ),
    );
  };

  const handleSave = async () => {
    if (!activeState.projectId) {
      showToast({
        type: 'warning',
        title: '暂无项目',
        message: '请先创建或选择一个项目，再保存分镜。',
      });
      return;
    }

    if (lines.length === 0) {
      showToast({
        type: 'warning',
        title: '分镜为空',
        message: '至少保留一个镜头再保存。',
      });
      return;
    }

    setIsSaving(true);
    try {
      const saved = await saveStoryboard(activeState.projectId, lines, {
        baseVersion,
        source: 'manual',
      });
      if (typeof saved.version === 'number') {
        setBaseVersion(saved.version);
      } else {
        // 响应缺 version 时主动对齐，避免后续保存持续 409。
        const latest = await getServerStoryboard(activeState.projectId).catch(() => null);
        setBaseVersion(latest?.version ?? 0);
      }
      setConflict(null);
      showToast({
        type: 'success',
        title: '分镜已保存',
        message: `已同步 ${lines.length} 个镜头到后端（v${saved.version ?? '?'}）。`,
      });
    } catch (error) {
      if (isVersionConflictError(error)) {
        setConflict(toConflictState(error));
        showToast({
          type: 'warning',
          title: '保存冲突',
          message: `服务器分镜已更新到 v${error.currentVersion}，你的草稿已保留，请选择处理方式。`,
        });
      } else {
        showToast({
          type: 'error',
          title: '保存失败',
          message: error instanceof Error ? error.message : '分镜保存失败',
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  /** 冲突时：加载服务器最新版（替换当前草稿前先确认并自动复制草稿兜底） */
  const handleLoadServerLatest = useCallback(async () => {
    if (!activeState.projectId) {
      return;
    }
    const draftJson = JSON.stringify(lines, null, 2);
    const draftCopied = shouldPromptCopyDraft(draftJson) ? await copyTextToClipboard(draftJson) : false;
    const message = draftCopied
      ? '将丢弃当前分镜草稿并加载服务器最新版（草稿已复制为 JSON 到剪贴板）。确定继续吗？'
      : '将丢弃当前分镜草稿并加载服务器最新版，该操作无法撤销。确定继续吗？';
    if (!window.confirm(message)) {
      return;
    }
    try {
      const latest = await getServerStoryboard(activeState.projectId);
      // 草稿保护：仅当成功拿到服务器内容才替换草稿，失败时绝不丢弃草稿
      const next = applyConflictResolution({ draft: lines, conflict }, 'load_server_latest', latest ? latest.lines : null);
      setLines(next.draft);
      setConflict(next.conflict);
      if (latest && next.conflict === null) {
        setBaseVersion(latest.version ?? 0);
      }
      void refreshWorkspace('storyboard conflict resolution');
    } catch (error) {
      showToast({
        type: 'error',
        title: '加载失败',
        message: error instanceof Error ? error.message : '无法加载服务器最新版本',
      });
    }
  }, [activeState.projectId, lines, conflict, refreshWorkspace, showToast]);

  /** 冲突时：复制当前草稿（JSON）到剪贴板 */
  const handleCopyDraft = useCallback(async () => {
    const draft = JSON.stringify(lines, null, 2);
    const succeeded = await copyTextToClipboard(draft);
    showToast({
      type: succeeded ? 'success' : 'error',
      title: succeeded ? '草稿已复制' : '复制失败',
      message: succeeded
        ? '当前分镜草稿已复制为 JSON，可加载最新版后再合并。'
        : '当前环境不支持自动复制，请手动复制。',
    });
  }, [lines, showToast]);

  /** 版本恢复成功后重新拉取当前内容 */
  const handleVersionRestored = useCallback(async () => {
    if (!activeState.projectId) {
      return;
    }
    try {
      const latest = await getServerStoryboard(activeState.projectId);
      if (latest) {
        setLines(latest.lines);
        setBaseVersion(latest.version ?? 0);
      }
      setConflict(null);
      void refreshWorkspace('storyboard version restored');
    } catch (error) {
      // 恢复已在服务端生效，但本地拉取失败：必须提示，否则编辑器会带着
      // 旧内容与旧 baseVersion 继续编辑，下一次保存必然出现混乱的 409。
      showToast({
        type: 'error',
        title: '同步恢复结果失败',
        message:
          error instanceof Error && error.message
            ? `服务器已恢复，但拉取最新分镜失败：${error.message}。请手动刷新后再编辑。`
            : '服务器已恢复，但拉取最新分镜失败，请手动刷新后再编辑。',
      });
    }
  }, [activeState.projectId, refreshWorkspace, showToast]);

  /** 图生图：基于当前镜头描述生成画面 */
  const handleImageToImage = useCallback(async (line: StoryboardLine) => {
    if (!line.description.trim()) {
      showToast({ type: 'warning', title: '描述为空', message: '请先填写镜头描述再生成画面。' });
      return;
    }

    setGeneratingLineId(line.id);
    try {
      await createImageGeneration({
        projectId: activeState.projectId ?? '',
        prompt: `图生图风格转换：${line.description}，保持构图不变，转换为电影质感画面`,
        model: 'dall-e-3',
        size: '1792x1024',
        n: 1,
      });
      showToast({ type: 'success', title: '图生图任务已提交', message: `分镜 ${line.sceneNumber} 的画面生成任务已创建。` });
    } catch (error) {
      showToast({ type: 'error', title: '图生图失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setGeneratingLineId(null);
    }
  }, [activeState.projectId, showToast]);

  /** 图生转场：基于当前镜头生成转场视频 */
  const handleImageToVideo = useCallback(async (line: StoryboardLine) => {
    if (!line.description.trim()) {
      showToast({ type: 'warning', title: '描述为空', message: '请先填写镜头描述再生成转场。' });
      return;
    }

    setGeneratingLineId(line.id);
    try {
      await createVideoGeneration({
        projectId: activeState.projectId ?? undefined,
        prompt: `镜头转场动画：${line.description}，时长 ${line.duration}s，平滑过渡`,
        model: 'wan2.1-t2v-480p',
        durationSeconds: line.duration,
        aspectRatio: '16:9',
      });
      showToast({ type: 'success', title: '转场视频任务已提交', message: `分镜 ${line.sceneNumber} 的转场视频已创建。` });
    } catch (error) {
      showToast({ type: 'error', title: '转场视频失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setGeneratingLineId(null);
    }
  }, [activeState.projectId, showToast]);

  /** 自动音效：基于当前镜头描述生成背景音效提示 */
  const handleAutoSound = useCallback(async (line: StoryboardLine) => {
    if (!line.description.trim()) {
      showToast({ type: 'warning', title: '描述为空', message: '请先填写镜头描述再生成音效。' });
      return;
    }

    setGeneratingLineId(line.id);
    try {
      await createImageGeneration({
        projectId: activeState.projectId ?? '',
        prompt: `为以下镜头场景生成音效描述和氛围标签：${line.description}。输出格式：场景音效名称、情绪标签、建议BPM`,
        model: 'dall-e-3',
        size: '1024x1024',
        n: 1,
      });
      showToast({ type: 'success', title: '音效分析任务已提交', message: `分镜 ${line.sceneNumber} 的音效分析已创建。` });
    } catch (error) {
      showToast({ type: 'error', title: '音效分析失败', message: error instanceof Error ? error.message : '提交失败' });
    } finally {
      setGeneratingLineId(null);
    }
  }, [activeState.projectId, showToast]);

  if (!activeStoryboard && lines.length === 0) {
    return (
      <div className={styles.emptyContainer}>
        <h3>分镜数据为空</h3>
        <p>你可以前往剧本创作模块一键生成分镜，或先创建一个可编辑的主分镜。</p>
        <button
          className={styles.createBtn}
          onClick={() => void handleCreateStoryboard()}
          disabled={isSaving}
        >
          {isSaving ? '创建中...' : '创建空分镜'}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarInfo}>
          <h3>项目主分镜</h3>
          <span>{lines.length} 个镜头</span>
          {activeState.projectId && (
            <ContentVersionHistory
              projectId={activeState.projectId}
              contentType="storyboard"
              currentVersion={activeStoryboard?.version}
              onRestored={() => void handleVersionRestored()}
              hasUnsavedChanges={
                JSON.stringify(lines) !== JSON.stringify(activeStoryboard?.lines || [])
              }
              draftText={JSON.stringify(lines, null, 2)}
            />
          )}
        </div>
        <div className={styles.toolbarActions}>
          <button className={styles.secondaryBtn} onClick={handleAddScene}>
            <Plus size={16} /> 添加镜头
          </button>
          <button
            className={styles.createBtn}
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            <Save size={16} /> {isSaving ? '保存中...' : '保存分镜'}
          </button>
        </div>
      </div>

      {conflict && (
        <div className={styles.conflictBanner}>
          <AlertTriangle size={16} />
          <span>
            保存冲突：服务器分镜已更新到 v{conflict.currentVersion}，你的本地草稿尚未保存，已为你保留。
          </span>
          <div className={styles.conflictActions}>
            <button
              className={styles.conflictBtn}
              onClick={() => void handleCopyDraft()}
              title="将当前草稿复制为 JSON"
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

      <div className={styles.timeline}>
        {lines.map((line) => (
          <div key={line.id} className={styles.sceneCard}>
            <div className={styles.sceneHeader}>
              <span className={styles.sceneNumber}>Scene {line.sceneNumber}</span>
              <div className={styles.sceneToolsRight}>
                <label className={styles.sceneMeta}>
                  <Clock size={14} />
                  <input
                    className={styles.durationInput}
                    type="number"
                    min={1}
                    value={line.duration}
                    onChange={(event) =>
                      handleLineChange(line.id, 'duration', Number(event.target.value))
                    }
                  />
                  <span>s</span>
                </label>
                <button className={styles.toolBtn} onClick={() => handleRemoveScene(line.id)}>
                  <Trash2 size={14} /> 删除
                </button>
              </div>
            </div>
            <div className={styles.sceneBody}>
              <div className={styles.imagePlaceholder}>
                <Camera size={24} className={styles.iconOp} />
                <span>{line.assets.length ? `${line.assets.length} 个关联资产` : '生成画面'}</span>
              </div>
              <div className={styles.sceneDesc}>
                <textarea
                  className={styles.descInput}
                  value={line.description}
                  onChange={(event) => handleLineChange(line.id, 'description', event.target.value)}
                  rows={4}
                />
                {line.assets.length > 0 && (
                  <div className={styles.assetTags}>
                    {line.assets.map((asset) => (
                      <span key={asset.id} className={styles.assetChip}>
                        {asset.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className={styles.tools}>
                  <button
                    className={styles.toolBtn}
                    onClick={() => void handleImageToImage(line)}
                    disabled={generatingLineId === line.id}
                  >
                    {generatingLineId === line.id ? <LoaderCircle size={14} className={styles.iconSpin} /> : <ImageIcon size={14} />} 图生图
                  </button>
                  <button
                    className={styles.toolBtn}
                    onClick={() => void handleImageToVideo(line)}
                    disabled={generatingLineId === line.id}
                  >
                    {generatingLineId === line.id ? <LoaderCircle size={14} className={styles.iconSpin} /> : <Video size={14} />} 图生转场
                  </button>
                  <button
                    className={styles.toolBtn}
                    onClick={() => void handleAutoSound(line)}
                    disabled={generatingLineId === line.id}
                  >
                    {generatingLineId === line.id ? <LoaderCircle size={14} className={styles.iconSpin} /> : <Music size={14} />} 自动音效
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
