import React, { useCallback, useEffect, useState } from 'react';
import { Camera, Clock, Image as ImageIcon, LoaderCircle, Music, Plus, Save, Trash2, Video } from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import { createImageGeneration, createVideoGeneration } from '../../../../lib/serverApi';
import type { StoryboardLine } from '../../../../types';
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

export const StoryboardArea: React.FC = () => {
  const { activeStoryboard, activeState } = useAppStore(
    useShallow((state) => ({
      activeStoryboard: state.activeStoryboard,
      activeState: state.activeState,
    })),
  );
  const { saveStoryboard } = useAppActions();
  const { showToast } = useToast();
  const [lines, setLines] = useState<StoryboardLine[]>(activeStoryboard?.lines || []);
  const [isSaving, setIsSaving] = useState(false);
  const [generatingLineId, setGeneratingLineId] = useState<string | null>(null);

  useEffect(() => {
    setLines(activeStoryboard?.lines || []);
  }, [activeStoryboard?.id, activeStoryboard?.lines, activeStoryboard?.updatedAt]);

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
      await saveStoryboard(activeState.projectId, initialLines);
      showToast({
        type: 'success',
        title: '分镜已创建',
        message: '已为当前项目创建首个分镜镜头。',
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '创建失败',
        message: error instanceof Error ? error.message : '创建分镜失败',
      });
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
      await saveStoryboard(activeState.projectId, lines);
      showToast({
        type: 'success',
        title: '分镜已保存',
        message: `已同步 ${lines.length} 个镜头到后端。`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '分镜保存失败',
      });
    } finally {
      setIsSaving(false);
    }
  };

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
