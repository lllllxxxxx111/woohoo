import React, { useEffect, useState } from 'react';
import { PlayCircle, Save, Sparkles } from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import styles from './ScriptEditor.module.css';

export const ScriptEditor: React.FC = () => {
  const { activeScript, activeState } = useAppStore(
    useShallow((state) => ({ activeScript: state.activeScript, activeState: state.activeState })),
  );
  const { saveScript } = useAppActions();
  const { showToast } = useToast();
  const [content, setContent] = useState(activeScript?.content || '');
  const [isSaving, setIsSaving] = useState(false);

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

  return (
    <div className={styles.container}>
      <header className={styles.toolbar}>
        <div className={styles.toolsList}>
          <button className={styles.toolBtn} title="智能续写">
            <Sparkles size={16} /> 智能续写
          </button>
          <button className={styles.toolBtn} title="转分镜">
            <PlayCircle size={16} /> 生成分镜
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
