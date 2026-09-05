import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@arco-design/web-react';
import { History, RefreshCw, X } from 'lucide-react';
import {
  getContentVersion,
  listContentVersions,
  restoreContentVersion,
  type ServerContentVersion,
} from '../../../../lib/serverApi';
import { isVersionConflictError } from '../../../../lib/serverApi';
import {
  diffScriptText,
  diffStoryboardLines,
  storyboardLinesToViews,
  type ContentDiffResult,
  type StoryboardLineView,
} from '../../../../lib/contentDiff';
import { shouldPromptCopyDraft } from '../../../../lib/versionConflict';
import { useToast } from '../../../../context/useToast';
import styles from './ContentVersionHistory.module.css';

const PAGE_SIZE = 50;

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略，回退到 execCommand
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

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  ai: 'AI',
  pipeline: '流水线',
  restore: '恢复',
  rewind: '撤回',
  baseline: '基线',
  import: '导入',
  collaboration: '协同',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const date = new Date(timestamp);
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

interface StoryboardSnapshotLineLike {
  id?: string;
  sceneNumber?: number;
  description?: string;
  duration?: number;
  assetIds?: string[];
}

function parseStoryboardViews(content: string): StoryboardLineView[] {
  try {
    const parsed = JSON.parse(content) as { lines?: StoryboardSnapshotLineLike[] };
    const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    return storyboardLinesToViews(
      lines.map((line, index) => ({
        id: line.id || `line-${index}`,
        sceneNumber: typeof line.sceneNumber === 'number' ? line.sceneNumber : index + 1,
        description: line.description || '',
        duration: typeof line.duration === 'number' ? line.duration : 0,
        assets: (line.assetIds || []).map((assetId) => ({ id: assetId })),
      })),
    );
  } catch {
    return [];
  }
}

function storyboardPreviewText(content: string): string {
  const views = parseStoryboardViews(content);
  if (views.length === 0) {
    return '（空分镜）';
  }
  return views
    .map((line) => `Scene ${line.sceneNumber}（${line.duration}s）：${line.description}`)
    .join('\n');
}

export interface ContentVersionHistoryProps {
  projectId: string;
  contentType: 'script' | 'storyboard';
  currentVersion?: number;
  /** 恢复成功后的回调（父组件据此重新加载当前内容） */
  onRestored?: () => void;
  /** 编辑器当前是否有未保存的修改；恢复版本会丢弃这些修改，需要用户确认 */
  hasUnsavedChanges?: boolean;
  /** 未保存草稿的文本形式，用于恢复前自动复制兜底 */
  draftText?: string;
}

export const ContentVersionHistory: React.FC<ContentVersionHistoryProps> = ({
  projectId,
  contentType,
  currentVersion,
  onRestored,
  hasUnsavedChanges = false,
  draftText = '',
}) => {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ServerContentVersion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ServerContentVersion | null>(null);
  const [diff, setDiff] = useState<ContentDiffResult | null>(null);
  const [diffMeta, setDiffMeta] = useState<{ base: number; target: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // 请求序号：并发/乱序返回时只有最新一次请求的结果可以落进状态，
  // 防止旧响应覆盖新响应（例如连点刷新、或切换项目后旧请求才返回）。
  const loadSeqRef = useRef(0);

  const loadVersions = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    setPreview(null);
    setDiff(null);
    setDiffMeta(null);
    try {
      const result = await listContentVersions(projectId, contentType, PAGE_SIZE, 0);
      if (seq !== loadSeqRef.current) {
        return;
      }
      setVersions(result.versions);
      setTotal(result.total);
    } catch (error) {
      if (seq !== loadSeqRef.current) {
        return;
      }
      // 项目切换后旧项目的列表不能残留：失败也要清空，否则“恢复”会把
      // 旧项目的版本号作用到新项目上（版本号在不同项目间会重叠）。
      setVersions([]);
      setTotal(0);
      setLoadError(error instanceof Error ? error.message : '版本历史加载失败');
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [projectId, contentType]);

  const loadMore = useCallback(async () => {
    if (loading || versions.length >= total) {
      return;
    }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const result = await listContentVersions(projectId, contentType, PAGE_SIZE, versions.length);
      if (seq !== loadSeqRef.current) {
        return;
      }
      setVersions((previous) => {
        const seen = new Set(previous.map((item) => item.version));
        return [...previous, ...result.versions.filter((item) => !seen.has(item.version))];
      });
      setTotal(result.total);
    } catch (error) {
      if (seq !== loadSeqRef.current) {
        return;
      }
      showToast({
        type: 'error',
        title: '加载失败',
        message: error instanceof Error ? error.message : '无法加载更多版本',
      });
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [loading, versions.length, total, projectId, contentType, showToast]);

  useEffect(() => {
    if (open) {
      void loadVersions();
    }
  }, [open, loadVersions]);

  // 项目/内容类型变化时立即清空旧数据，避免旧项目版本残留可操作。
  useEffect(() => {
    loadSeqRef.current += 1;
    setVersions([]);
    setTotal(0);
    setLoadError(null);
    setPreview(null);
    setDiff(null);
    setDiffMeta(null);
    setLoading(false);
  }, [projectId, contentType]);

  const handlePreview = useCallback(
    async (version: number) => {
      setBusy(true);
      setDiff(null);
      setDiffMeta(null);
      try {
        const detail = await getContentVersion(projectId, contentType, version);
        setPreview(detail);
      } catch (error) {
        showToast({
          type: 'error',
          title: '预览失败',
          message: error instanceof Error ? error.message : '无法加载版本内容',
        });
      } finally {
        setBusy(false);
      }
    },
    [projectId, contentType, showToast],
  );

  const handleDiff = useCallback(
    async (version: number) => {
      setBusy(true);
      setPreview(null);
      try {
        const latestVersion = currentVersion ?? versions[0]?.version ?? version;
        const [baseDetail, targetDetail] = await Promise.all([
          getContentVersion(projectId, contentType, latestVersion),
          getContentVersion(projectId, contentType, version),
        ]);

        let result: ContentDiffResult;
        if (contentType === 'script') {
          result = diffScriptText(baseDetail.content || '', targetDetail.content || '');
        } else {
          result = diffStoryboardLines(
            parseStoryboardViews(baseDetail.content || ''),
            parseStoryboardViews(targetDetail.content || ''),
          );
        }
        setDiff(result);
        setDiffMeta({ base: baseDetail.version, target: targetDetail.version });
      } catch (error) {
        showToast({
          type: 'error',
          title: '差异加载失败',
          message: error instanceof Error ? error.message : '无法计算版本差异',
        });
      } finally {
        setBusy(false);
      }
    },
    [projectId, contentType, currentVersion, versions, showToast],
  );

  const performRestore = useCallback(
    async (version: number) => {
      setBusy(true);
      try {
        // 携带已知当前版本做乐观并发校验：他人（或另一窗口）已保存更新时
        // 服务端返回 409，而不是静默覆盖掉更新的内容。
        const knownCurrent = currentVersion ?? versions[0]?.version;
        await restoreContentVersion(projectId, contentType, version, {
          baseVersion: knownCurrent,
        });
        showToast({
          type: 'success',
          title: '已恢复',
          message: `已基于版本 v${version} 创建新的当前版本，历史记录保持不变。`,
        });
        setPreview(null);
        setDiff(null);
        setDiffMeta(null);
        await loadVersions();
        onRestored?.();
      } catch (error) {
        if (isVersionConflictError(error)) {
          showToast({
            type: 'warning',
            title: '恢复冲突',
            message: `当前内容已更新到 v${error.currentVersion}，已刷新列表，请基于新状态重试。`,
          });
          // 服务器内容已前进：刷新列表与父组件，让用户基于新状态决定。
          await loadVersions();
          onRestored?.();
        } else {
          showToast({
            type: 'error',
            title: '恢复失败',
            message: error instanceof Error ? error.message : '恢复版本失败',
          });
        }
      } finally {
        setBusy(false);
      }
    },
    [
      projectId,
      contentType,
      currentVersion,
      versions,
      showToast,
      loadVersions,
      onRestored,
    ],
  );

  const handleRestore = useCallback(
    async (version: number) => {
      // 恢复会用历史内容替换编辑器内容，未保存的草稿若不处理会直接丢失。
      if (!hasUnsavedChanges) {
        await performRestore(version);
        return;
      }
      let draftCopied = false;
      if (shouldPromptCopyDraft(draftText)) {
        draftCopied = await copyTextToClipboard(draftText);
      }
      const message = draftCopied
        ? `当前有未保存的修改，恢复 v${version} 会用历史内容替换它们（草稿已复制到剪贴板）。确定继续吗？`
        : `当前有未保存的修改，恢复 v${version} 会用历史内容替换它们且无法撤销。建议先手动复制草稿。确定继续吗？`;
      Modal.confirm({
        title: '恢复历史版本',
        content: message,
        okText: '丢弃修改并恢复',
        cancelText: '取消',
        onOk: () => performRestore(version),
      });
    },
    [hasUnsavedChanges, draftText, performRestore],
  );

  const renderDiff = () => {
    if (!diff) {
      return null;
    }
    return (
      <div className={styles.detail}>
        <div className={styles.detailTitle}>
          <span>
            差异（v{diffMeta?.base} → v{diffMeta?.target}）
          </span>
          <button className={styles.miniBtn} onClick={() => setDiff(null)}>
            <X size={12} /> 关闭
          </button>
        </div>
        <div className={styles.summary}>{diff.summary}</div>
        {diff.kind === 'script' ? (
          <div className={styles.diffList}>
            {diff.entries.map((entry, index) => {
              const className =
                entry.op === 'add' || entry.op === 'modify_to'
                  ? styles.diffAdd
                  : entry.op === 'remove' || entry.op === 'modify_from'
                    ? styles.diffRemove
                    : styles.diffContext;
              const prefix =
                entry.op === 'add' || entry.op === 'modify_to'
                  ? '+ '
                  : entry.op === 'remove' || entry.op === 'modify_from'
                    ? '- '
                    : '  ';
              return (
                <div key={index} className={className}>
                  {prefix}
                  {entry.text}
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.diffList}>
            {diff.added.map((change) => (
              <div key={`add-${change.lineId}`} className={styles.diffAdd}>
                + Scene {change.sceneNumber}：{change.description}
              </div>
            ))}
            {diff.removed.map((change) => (
              <div key={`remove-${change.lineId}`} className={styles.diffRemove}>
                - Scene {change.sceneNumber}：{change.description}
              </div>
            ))}
            {diff.modified.map((change) => (
              <div key={`modify-${change.lineId}`} className={styles.diffContext}>
                ~ Scene {change.sceneNumber} 修改字段：{change.changedFields.join(', ')}
              </div>
            ))}
            {diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0 && (
              <div className={styles.diffContext}>无结构化差异</div>
            )}
          </div>
        )}
        {diff.truncated && <div className={styles.summary}>内容过大，差异已截断。</div>}
      </div>
    );
  };

  return (
    <div className={styles.wrapper}>
      <button className={styles.toggleBtn} onClick={() => setOpen((value) => !value)}>
        <History size={14} /> 版本历史
        <span className={styles.badge}>{currentVersion ? `v${currentVersion}` : '无'}</span>
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span>
              共 {total} 个版本{currentVersion ? ` · 当前 v${currentVersion}` : ''}
            </span>
            <button
              className={styles.miniBtn}
              onClick={() => void loadVersions()}
              disabled={loading}
              title={loading ? '正在加载…' : '重新加载版本列表'}
            >
              <RefreshCw size={12} /> 刷新
            </button>
          </div>

          {loading && <div className={styles.loading}>加载中…</div>}
          {loadError && <div className={styles.empty}>{loadError}</div>}
          {!loading && !loadError && versions.length === 0 && (
            <div className={styles.empty}>暂无版本记录，保存后将自动生成。</div>
          )}

          <div className={styles.list}>
            {versions.map((version) => (
              <div key={version.id} className={styles.item}>
                <div className={styles.itemMeta}>
                  <div className={styles.itemTitle}>
                    <strong>v{version.version}</strong>
                    <span className={styles.sourceTag}>{sourceLabel(version.source)}</span>
                    {version.version === currentVersion && (
                      <span className={styles.sourceTag}>当前</span>
                    )}
                  </div>
                  <div className={styles.itemSub}>
                    {formatTime(version.createdAt)}
                    {version.note ? ` · ${version.note}` : ''}
                    {version.title ? ` · ${version.title}` : ''}
                  </div>
                </div>
                <div className={styles.itemActions}>
                  <button
                    className={styles.miniBtn}
                    onClick={() => void handlePreview(version.version)}
                    disabled={busy}
                  >
                    预览
                  </button>
                  <button
                    className={styles.miniBtn}
                    onClick={() => void handleDiff(version.version)}
                    disabled={busy}
                  >
                    对比
                  </button>
                  {version.version !== currentVersion && (
                    <button
                      className={styles.miniBtnPrimary}
                      onClick={() => void handleRestore(version.version)}
                      disabled={busy}
                    >
                      恢复
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {versions.length < total && (
            <button
              className={styles.miniBtn}
              onClick={() => void loadMore()}
              disabled={loading || busy}
            >
              加载更多（已显示 {versions.length}/{total}）
            </button>
          )}

          {preview && (
            <div className={styles.detail}>
              <div className={styles.detailTitle}>
                <span>
                  预览 v{preview.version}（{sourceLabel(preview.source)}）
                </span>
                <button className={styles.miniBtn} onClick={() => setPreview(null)}>
                  <X size={12} /> 关闭
                </button>
              </div>
              <div className={styles.previewBox}>
                {contentType === 'script'
                  ? preview.content || '（空内容）'
                  : storyboardPreviewText(preview.content || '')}
              </div>
            </div>
          )}

          {renderDiff()}
        </div>
      )}
    </div>
  );
};

export default ContentVersionHistory;
