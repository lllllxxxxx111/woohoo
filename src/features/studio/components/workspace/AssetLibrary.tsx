import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Video,
  Music,
  File,
  Upload,
  Search,
  Filter,
  UploadCloud,
  X,
  Grid,
  List,
  Star,
  FolderOpen,
  Layers,
  MoreVertical,
  Download,
  Trash2,
  ImageOff,
  Loader2,
  ZoomIn,
  Minus,
  Plus,
  Maximize2,
  ArrowLeft,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { Asset } from '../../../../types';
import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import { getServerAssetBlob } from '../../../../lib/serverApi';
import { isProtectedAssetUrl, useAssetPreviewUrl } from '../../../../hooks/useAssetPreviewUrl';
import {
  ASSET_TYPE_LABELS,
  type AssetLibraryFilterType,
  type AssetLibraryGroupMode,
  type AssetLibraryScope,
} from '../../../../lib/assetLibraryView';
import styles from './AssetLibrary.module.css';

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
  size: number;
}

type FilterType = AssetLibraryFilterType;
type RatingFilter = 0 | 1 | 2 | 3 | 4 | 5;
type ViewMode = 'grid' | 'list';

type PreviewImage = {
  src: string;
  name: string;
  asset: Asset;
};

function isFavoriteAsset(asset: Asset): boolean {
  return asset.metadata?.favorite === true;
}

function getAssetRating(asset: Asset): number {
  const rating = Number(asset.metadata?.rating ?? 0);
  if (!Number.isFinite(rating)) {
    return 0;
  }

  return Math.min(5, Math.max(0, Math.round(rating)));
}

function normalizeAssetMetadata(metadata: Asset['metadata']): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return metadata;
}

function getMetadataNumber(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function getMetadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function isMarkdownDocumentAsset(asset: Asset, metadata: Record<string, unknown>): boolean {
  const format = getMetadataText(metadata, 'format').toLowerCase();
  const mimeType = getMetadataText(metadata, 'mimeType').toLowerCase();
  const name = asset.name.toLowerCase();

  return (
    format === 'markdown' ||
    format === 'md' ||
    mimeType.includes('markdown') ||
    name.endsWith('.md') ||
    name.endsWith('.markdown')
  );
}

function getMetadataDocumentText(metadata: Record<string, unknown>): string | null {
  const directKeys = ['content', 'text', 'markdown', 'body', 'document'];

  for (const key of directKeys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  const output = metadata.output;
  if (typeof output === 'string' && output.trim().length > 0) {
    return output;
  }

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return getMetadataDocumentText(output as Record<string, unknown>);
  }

  return null;
}

function formatBytesToMb(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '未填写';
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '未填写';
  }

  const totalSeconds = Math.max(0, Math.round(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function countDocumentCharacters(text: string): number {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/[#>*_~|[\]{}()-]/g, ' ')
    .replace(/\s+/g, '');

  return cleaned.length;
}

function getAssetMetricLabel(type: Asset['type']): string {
  switch (type) {
    case 'image':
      return '大小';
    case 'video':
    case 'audio':
      return '时长';
    case 'document':
      return '字数';
    default:
      return '尺寸';
  }
}

async function loadAssetBlob(asset: Pick<Asset, 'id' | 'url'>): Promise<Blob> {
  if (isProtectedAssetUrl(asset.id, asset.url)) {
    return getServerAssetBlob(asset.id);
  }

  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`无法读取资产文件: ${response.status}`);
  }

  return response.blob();
}

async function resolveAssetMediaDuration(asset: Pick<Asset, 'id' | 'url' | 'type'>): Promise<number | null> {
  try {
    const blob = await loadAssetBlob(asset);
    const objectUrl = window.URL.createObjectURL(blob);

    return await new Promise<number | null>((resolve) => {
      const media = window.document.createElement(asset.type === 'audio' ? 'audio' : 'video');
      let settled = false;

      const finish = (value: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        media.removeAttribute('src');
        media.load();
        window.URL.revokeObjectURL(objectUrl);
        resolve(value);
      };

      media.preload = 'metadata';
      media.onloadedmetadata = () => {
        const duration = Number.isFinite(media.duration) ? media.duration : null;
        finish(duration);
      };
      media.onerror = () => finish(null);
      media.src = objectUrl;
      media.load();
    });
  } catch {
    return null;
  }
}

function isTextLikeDocument(asset: Pick<Asset, 'name' | 'url' | 'metadata'>, blob: Blob): boolean {
  const metadata = normalizeAssetMetadata(asset.metadata);
  const format = getMetadataText(metadata, 'format').toLowerCase();
  const mimeType = (getMetadataText(metadata, 'mimeType') || blob.type).toLowerCase();
  const sourceName = `${asset.name} ${asset.url}`.toLowerCase();

  return (
    format === 'markdown' ||
    format === 'md' ||
    format === 'text' ||
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('markdown') ||
    /\.(md|markdown|txt|json|csv|log|yaml|yml)$/i.test(sourceName)
  );
}

async function resolveDocumentText(asset: Pick<Asset, 'id' | 'name' | 'url' | 'metadata'>): Promise<string | null> {
  const inlineText = getMetadataDocumentText(normalizeAssetMetadata(asset.metadata));
  if (inlineText !== null) {
    return inlineText;
  }

  try {
    const blob = await loadAssetBlob(asset);
    if (!isTextLikeDocument(asset, blob)) {
      return null;
    }
    return await blob.text();
  } catch {
    return null;
  }
}

function formatAssetDate(value: string | number | undefined): string {
  if (value === undefined || value === null) {
    return '未填写';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('zh-CN');
}

const AssetPreviewImage: React.FC<{
  asset: Asset;
  onPreview: (preview: PreviewImage) => void;
}> = ({ asset, onPreview }) => {
  const { previewUrl, status, error } = useAssetPreviewUrl(asset);

  if (status === 'ready' && previewUrl) {
    return (
      <button
        type="button"
        className={styles.previewButton}
        onClick={(event) => {
          event.stopPropagation();
          onPreview({ src: previewUrl, name: asset.name, asset });
        }}
        title="放大预览"
      >
        <img src={previewUrl} alt={asset.name} loading="lazy" />
        <span className={styles.zoomHint}>
          <ZoomIn size={16} />
        </span>
      </button>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.previewState} title={error ?? '资产文件无法预览'}>
        <ImageOff size={24} />
        <span>无法预览</span>
      </div>
    );
  }

  return (
    <div className={styles.previewState} aria-label={`${asset.name} 正在加载预览`}>
      <Loader2 size={22} className={styles.previewSpinner} />
    </div>
  );
};

export const AssetLibrary: React.FC = () => {
  const { activeAssets, activeState, assets, projects, assetLibraryView, setAssetLibraryView } =
    useAppStore(
    useShallow((state) => ({
      activeAssets: state.activeAssets,
      activeState: state.activeState,
      assets: state.assets,
      projects: state.projects,
      assetLibraryView: state.assetLibraryView,
      setAssetLibraryView: state.setAssetLibraryView,
    })),
  );
  const { uploadAssets, deleteAsset, updateAsset } = useAppActions();
  const { showToast } = useToast();

  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const filterType = assetLibraryView.filterType;
  const libraryScope = assetLibraryView.scope;
  const groupMode = assetLibraryView.groupMode;
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>(0);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showRatingDropdown, setShowRatingDropdown] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [resolvedMediaDurationSeconds, setResolvedMediaDurationSeconds] = useState<number | null>(
    null,
  );
  const [resolvedDocumentText, setResolvedDocumentText] = useState<string | null>(null);
  const [resolvedDocumentCharacterCount, setResolvedDocumentCharacterCount] = useState<
    number | null
  >(null);
  const [detailResolveStatus, setDetailResolveStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const metadataUpdateQueuesRef = useRef(new Map<string, Promise<Asset>>());

  useEffect(() => {
    if (selectedAsset && !assets.some((asset) => asset.id === selectedAsset)) {
      setSelectedAsset(null);
    }
  }, [assets, selectedAsset]);

  const projectNameById = useMemo(() => {
    const nextMap = new Map<string, string>();
    for (const project of projects) {
      nextMap.set(project.id, project.name);
    }
    return nextMap;
  }, [projects]);
  const selectedAssetData = useMemo(
    () => assets.find((asset) => asset.id === selectedAsset) ?? null,
    [assets, selectedAsset],
  );
  const selectedAssetMetadata = useMemo(
    () => normalizeAssetMetadata(selectedAssetData?.metadata),
    [selectedAssetData],
  );
  const selectedAssetProjectName = selectedAssetData
    ? projectNameById.get(selectedAssetData.projectId) || '未命名项目'
    : null;
  const selectedAssetFavorite = selectedAssetData ? isFavoriteAsset(selectedAssetData) : false;
  const selectedAssetPrompt = selectedAssetData?.type === 'image'
    ? getMetadataText(selectedAssetMetadata, 'prompt')
    : '';
  const selectedAssetRevisedPrompt = selectedAssetData?.type === 'image'
    ? getMetadataText(selectedAssetMetadata, 'revisedPrompt')
    : '';
  const selectedAssetIsMarkdownDocument =
    selectedAssetData?.type === 'document'
      ? isMarkdownDocumentAsset(selectedAssetData, selectedAssetMetadata)
      : false;
  const selectedAssetSizeBytes = getMetadataNumber(selectedAssetMetadata, ['sizeBytes']);
  const selectedAssetInlineDurationSeconds = getMetadataNumber(selectedAssetMetadata, [
    'durationSeconds',
    'durationSec',
    'duration',
    'length',
  ]);
  const selectedAssetInlineDurationMs = getMetadataNumber(selectedAssetMetadata, [
    'durationMs',
    'durationMillis',
    'durationMilliseconds',
  ]);
  const selectedAssetInlineWordCount = getMetadataNumber(selectedAssetMetadata, [
    'wordCount',
    'word_count',
    'characters',
    'charCount',
  ]);
  const selectedAssetMetric = useMemo(() => {
    if (!selectedAssetData) {
      return null;
    }

    if (selectedAssetData.type === 'image') {
      return {
        label: getAssetMetricLabel(selectedAssetData.type),
        value: formatBytesToMb(selectedAssetSizeBytes),
      };
    }

    if (selectedAssetData.type === 'video' || selectedAssetData.type === 'audio') {
      const durationSeconds = resolvedMediaDurationSeconds ?? selectedAssetInlineDurationSeconds;
      const normalizedDuration =
        durationSeconds ?? (selectedAssetInlineDurationMs !== null ? selectedAssetInlineDurationMs / 1000 : null);
      return {
        label: getAssetMetricLabel(selectedAssetData.type),
        value: formatDurationSeconds(normalizedDuration),
      };
    }

    if (selectedAssetData.type === 'document') {
      const wordCount = resolvedDocumentCharacterCount ?? selectedAssetInlineWordCount;
      return {
        label: getAssetMetricLabel(selectedAssetData.type),
        value:
          typeof wordCount === 'number' && Number.isFinite(wordCount)
            ? `${Math.max(0, Math.round(wordCount)).toLocaleString('zh-CN')} 字`
            : detailResolveStatus === 'loading'
              ? '加载中'
              : '未填写',
      };
    }

    return {
      label: getAssetMetricLabel(selectedAssetData.type),
      value: formatBytesToMb(selectedAssetSizeBytes),
    };
  }, [
    detailResolveStatus,
    resolvedDocumentCharacterCount,
    resolvedMediaDurationSeconds,
    selectedAssetData,
    selectedAssetInlineDurationMs,
    selectedAssetInlineDurationSeconds,
    selectedAssetInlineWordCount,
    selectedAssetSizeBytes,
  ]);

  useEffect(() => {
    if (!activeState.projectId && libraryScope === 'current') {
      setAssetLibraryView({ scope: 'all' });
    }
  }, [activeState.projectId, libraryScope, setAssetLibraryView]);

  useEffect(() => {
    let cancelled = false;

    setResolvedMediaDurationSeconds(null);
    setResolvedDocumentText(null);
    setResolvedDocumentCharacterCount(null);
    setDetailResolveStatus(selectedAssetData ? 'loading' : 'idle');

    if (!selectedAssetData) {
      return undefined;
    }

    if (selectedAssetData.type === 'video' || selectedAssetData.type === 'audio') {
      const inlineSeconds =
        selectedAssetInlineDurationSeconds ??
        (selectedAssetInlineDurationMs !== null ? selectedAssetInlineDurationMs / 1000 : null);
      if (inlineSeconds !== null) {
        setResolvedMediaDurationSeconds(inlineSeconds);
        setDetailResolveStatus('ready');
        return undefined;
      }

      void resolveAssetMediaDuration(selectedAssetData)
        .then((seconds) => {
          if (cancelled) {
            return;
          }
          setResolvedMediaDurationSeconds(seconds);
          setDetailResolveStatus(seconds === null ? 'error' : 'ready');
        })
        .catch(() => {
          if (!cancelled) {
            setDetailResolveStatus('error');
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (selectedAssetData.type === 'document') {
      if (selectedAssetInlineWordCount !== null) {
        setResolvedDocumentCharacterCount(selectedAssetInlineWordCount);
      }

      void resolveDocumentText(selectedAssetData)
        .then((text) => {
          if (cancelled) {
            return;
          }
          setResolvedDocumentText(text);
          setResolvedDocumentCharacterCount(
            text === null ? selectedAssetInlineWordCount : countDocumentCharacters(text),
          );
          setDetailResolveStatus(text === null ? 'error' : 'ready');
        })
        .catch(() => {
          if (!cancelled) {
            setDetailResolveStatus('error');
          }
        });
      return () => {
        cancelled = true;
      };
    }

    setDetailResolveStatus('ready');
    return undefined;
  }, [
    selectedAssetData,
    selectedAssetInlineDurationMs,
    selectedAssetInlineDurationSeconds,
    selectedAssetInlineWordCount,
  ]);

  useEffect(() => {
    if (!selectedAsset || previewImage) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedAsset(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewImage, selectedAsset]);

  const updateLibraryView = useCallback(
    (request: {
      filterType?: FilterType;
      groupMode?: AssetLibraryGroupMode;
      scope?: AssetLibraryScope;
    }) => {
      setAssetLibraryView(request);
    },
    [setAssetLibraryView],
  );

  const getAssetIcon = (type: Asset['type']) => {
    switch (type) {
      case 'image':
        return <ImageIcon size={24} />;
      case 'video':
        return <Video size={24} />;
      case 'audio':
        return <Music size={24} />;
      default:
        return <File size={24} />;
    }
  };

  const scopedAssets = useMemo(() => {
    if (libraryScope === 'current' && activeState.projectId) {
      return activeAssets;
    }
    return assets;
  }, [activeAssets, activeState.projectId, assets, libraryScope]);

  const activeProjectName = activeState.projectId
    ? projectNameById.get(activeState.projectId) || '当前项目'
    : '未选择项目';

  const filteredAssets = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    return scopedAssets.filter((asset) => {
      const matchesType = filterType === 'all' || asset.type === filterType;
      const matchesFavorite = !favoriteOnly || isFavoriteAsset(asset);
      const matchesRating = ratingFilter === 0 || getAssetRating(asset) >= ratingFilter;
      const projectName = projectNameById.get(asset.projectId) || '';
      const matchesSearch =
        normalizedSearch === '' ||
        asset.name.toLowerCase().includes(normalizedSearch) ||
        projectName.toLowerCase().includes(normalizedSearch);
      return matchesType && matchesFavorite && matchesRating && matchesSearch;
    });
  }, [favoriteOnly, filterType, projectNameById, ratingFilter, scopedAssets, searchQuery]);

  const groupedAssetSections = useMemo(() => {
    if (groupMode === 'none') {
      return [
        {
          key: 'flat',
          title: libraryScope === 'current' ? activeProjectName : '全部资产',
          subtitle: `${filteredAssets.length} 个资产`,
          assets: filteredAssets,
        },
      ];
    }

    if (groupMode === 'project') {
      const projectOrder = new Map(projects.map((project, index) => [project.id, index]));
      const grouped = new Map<string, Asset[]>();
      for (const asset of filteredAssets) {
        const groupAssets = grouped.get(asset.projectId) ?? [];
        groupAssets.push(asset);
        grouped.set(asset.projectId, groupAssets);
      }

      return Array.from(grouped.entries())
        .sort(
          ([leftProjectId], [rightProjectId]) =>
            (projectOrder.get(leftProjectId) ?? Number.MAX_SAFE_INTEGER) -
            (projectOrder.get(rightProjectId) ?? Number.MAX_SAFE_INTEGER),
        )
        .map(([projectId, groupAssets]) => ({
          key: projectId,
          title: projectNameById.get(projectId) || '未命名项目',
          subtitle: `${groupAssets.length} 个资产`,
          assets: groupAssets,
        }));
    }

    return (['image', 'video', 'audio', 'document'] as Asset['type'][])
      .map((type) => {
        const groupAssets = filteredAssets.filter((asset) => asset.type === type);
        return {
          key: type,
          title: ASSET_TYPE_LABELS[type],
          subtitle: `${groupAssets.length} 个资产`,
          assets: groupAssets,
        };
      })
      .filter((section) => section.assets.length > 0);
  }, [activeProjectName, filteredAssets, groupMode, libraryScope, projectNameById, projects]);

  const hasActiveAssetFilters =
    searchQuery.trim() !== '' ||
    filterType !== 'all' ||
    favoriteOnly ||
    ratingFilter > 0 ||
    libraryScope !== 'current' ||
    groupMode !== 'none';

  const handleCloseUploadModal = () => {
    if (isUploading) {
      return;
    }

    setIsUploadModalOpen(false);
    setIsDragging(false);
    setUploadingFiles([]);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const removeUploadingFiles = (ids: string[]) => {
    setTimeout(() => {
      setUploadingFiles((prev) => prev.filter((file) => !ids.includes(file.id)));
    }, 800);
  };

  const uploadSelectedFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) {
        return;
      }

      if (!activeState.projectId) {
        showToast({
          type: 'warning',
          title: '请先创建项目',
          message: '资产需要挂在具体项目下，先去聊天区或侧栏创建一个项目。',
        });
        return;
      }

      const queue = files.map((file) => ({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        progress: 12,
        size: file.size,
      }));

      setUploadingFiles((prev) => [...prev, ...queue]);
      setIsUploading(true);

      const intervals = queue.map((item) =>
        window.setInterval(() => {
          setUploadingFiles((prev) =>
            prev.map((file) =>
              file.id === item.id
                ? { ...file, progress: Math.min(file.progress + Math.random() * 16, 92) }
                : file,
            ),
          );
        }, 180),
      );

      try {
        await uploadAssets(activeState.projectId, files);
        intervals.forEach((timer) => window.clearInterval(timer));
        setUploadingFiles((prev) =>
          prev.map((file) =>
            queue.some((item) => item.id === file.id) ? { ...file, progress: 100 } : file,
          ),
        );
        showToast({
          type: 'success',
          title: '上传完成',
          message: `已保存 ${files.length} 个资产到当前项目。`,
        });
        removeUploadingFiles(queue.map((item) => item.id));
      } catch (error) {
        intervals.forEach((timer) => window.clearInterval(timer));
        showToast({
          type: 'error',
          title: '上传失败',
          message: error instanceof Error ? error.message : '文件上传失败',
        });
      } finally {
        setIsUploading(false);
      }
    },
    [activeState.projectId, showToast, uploadAssets],
  );

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    await uploadSelectedFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      const files = Array.from(event.dataTransfer.files || []);
      await uploadSelectedFiles(files);
    },
    [uploadSelectedFiles],
  );

  const handleUploadButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleAssetClick = (assetId: string) => {
    setSelectedAsset(assetId);
  };

  const updateAssetMetadata = (
    asset: Asset,
    nextMetadata: Record<string, unknown>,
    event?: React.MouseEvent,
  ) => {
    event?.stopPropagation();

    const existingOperation = metadataUpdateQueuesRef.current.get(asset.id) ?? Promise.resolve(asset);
    let nextOperation: Promise<Asset>;

    nextOperation = existingOperation
      .catch(() => asset)
      .then((latestAsset) =>
        updateAsset(asset.id, {
          metadata: {
            ...normalizeAssetMetadata(latestAsset.metadata),
            ...nextMetadata,
          },
        }),
      )
      .catch((error) => {
        showToast({
          type: 'error',
          title: '更新资产标记失败',
          message: error instanceof Error ? error.message : '请稍后重试',
        });
        return asset;
      })
      .finally(() => {
        if (metadataUpdateQueuesRef.current.get(asset.id) === nextOperation) {
          metadataUpdateQueuesRef.current.delete(asset.id);
        }
      });

    metadataUpdateQueuesRef.current.set(asset.id, nextOperation);
  };

  const handleFavoriteToggle = (asset: Asset, event: React.MouseEvent) => {
    updateAssetMetadata(asset, { favorite: !isFavoriteAsset(asset) }, event);
  };

  const handleRatingChange = (asset: Asset, rating: number, event: React.MouseEvent) => {
    const currentRating = getAssetRating(asset);
    updateAssetMetadata(asset, { rating: currentRating === rating ? 0 : rating }, event);
  };

  const handleAssetDownload = async (asset: Asset, event: React.MouseEvent) => {
    event.stopPropagation();

    try {
      const link = window.document.createElement('a');
      link.download = asset.name;
      link.target = '_blank';
      link.rel = 'noreferrer';

      if (isProtectedAssetUrl(asset.id, asset.url)) {
        const blob = await getServerAssetBlob(asset.id);
        const objectUrl = window.URL.createObjectURL(blob);
        link.href = objectUrl;
        link.click();
        window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1_000);
      } else {
        link.href = asset.url;
        link.click();
      }
    } catch (error) {
      showToast({
        type: 'error',
        title: '下载失败',
        message: error instanceof Error ? error.message : '资产下载失败',
      });
    }
  };

  const handleAssetDelete = async (asset: Asset, event: React.MouseEvent) => {
    event.stopPropagation();

    try {
      await deleteAsset(asset.id);
      showToast({
        type: 'success',
        title: '资产已删除',
        message: `${asset.name} 已从项目资产库移除。`,
      });
      setSelectedAsset((prev) => (prev === asset.id ? null : prev));
    } catch (error) {
      showToast({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '删除资产时发生错误',
      });
    }
  };

  const getFilterLabel = (type: FilterType) => {
    return ASSET_TYPE_LABELS[type];
  };

  const getRatingFilterLabel = (rating: RatingFilter) => {
    return rating === 0 ? '星级' : `${rating} 星+`;
  };

  const renderAssetItem = (asset: Asset, index: number) => {
    const favorite = isFavoriteAsset(asset);
    const rating = getAssetRating(asset);
    const projectName = projectNameById.get(asset.projectId);

    return (
      <div
        key={asset.id}
        className={`${viewMode === 'grid' ? styles.assetCard : styles.assetListItem} ${selectedAsset === asset.id ? styles.selected : ''}`}
        style={{ animationDelay: `${Math.min(index, 12) * 0.04}s` }}
        onClick={() => handleAssetClick(asset.id)}
      >
        <div className={styles.assetPreview}>
          {asset.type === 'image' ? (
            <AssetPreviewImage asset={asset} onPreview={setPreviewImage} />
          ) : (
            <div className={styles.iconPreview}>{getAssetIcon(asset.type)}</div>
          )}
          {selectedAsset === asset.id && (
            <div className={styles.assetOverlay}>
              <button
                className={styles.actionBtn}
                title="下载"
                onClick={(event) => void handleAssetDownload(asset, event)}
              >
                <Download size={16} />
              </button>
              <button
                className={`${styles.actionBtn} ${favorite ? styles.favoriteActive : ''}`}
                title={favorite ? '取消收藏' : '收藏'}
                onClick={(event) => handleFavoriteToggle(asset, event)}
              >
                <Star size={16} fill={favorite ? 'currentColor' : 'none'} />
              </button>
              <button
                className={`${styles.actionBtn} ${styles.danger}`}
                title="删除"
                onClick={(event) => void handleAssetDelete(asset, event)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}
        </div>
        <div className={styles.assetInfo}>
          <div className={styles.assetNameRow}>
            <span className={styles.assetName} title={asset.name}>
              {asset.name}
            </span>
            <button
              className={`${styles.favoriteButton} ${favorite ? styles.favoriteButtonActive : ''}`}
              title={favorite ? '取消收藏' : '收藏'}
              aria-label={favorite ? '取消收藏' : '收藏'}
              aria-pressed={favorite}
              onClick={(event) => handleFavoriteToggle(asset, event)}
            >
              <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
            </button>
            <button className={styles.moreBtn} onClick={(event) => event.stopPropagation()}>
              <MoreVertical size={16} />
            </button>
          </div>
          <div className={styles.assetMetaRow}>
            <span className={styles.assetType}>{getFilterLabel(asset.type)}</span>
            {libraryScope === 'all' && projectName && (
              <span className={styles.projectBadge}>{projectName}</span>
            )}
            {favorite && (
              <span className={styles.favoriteBadge}>
                <Star size={12} fill="currentColor" />
                收藏
              </span>
            )}
            <span className={styles.assetDate}>
              {new Date(asset.createdAt).toLocaleDateString('zh-CN')}
            </span>
          </div>
          <div
            className={styles.ratingRow}
            onClick={(event) => event.stopPropagation()}
            aria-label={`${asset.name} 星级评分`}
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className={`${styles.ratingButton} ${rating >= value ? styles.ratingActive : ''}`}
                title={`${value} 星`}
                aria-label={`${value} 星`}
                aria-pressed={rating >= value}
                onClick={(event) => handleRatingChange(asset, value, event)}
              >
                <Star size={13} fill={rating >= value ? 'currentColor' : 'none'} />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.topToolbar}>
        <div className={styles.searchBox}>
          <Search size={16} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="搜索资产..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && (
            <button className={styles.clearSearch} onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className={styles.viewToggle}>
          <button
            className={`${styles.viewBtn} ${libraryScope === 'current' ? styles.active : ''}`}
            onClick={() => updateLibraryView({ scope: 'current' })}
            title="只看当前项目"
            disabled={!activeState.projectId}
          >
            <FolderOpen size={18} />
            <span>当前</span>
          </button>
          <button
            className={`${styles.viewBtn} ${libraryScope === 'all' ? styles.active : ''}`}
            onClick={() => updateLibraryView({ scope: 'all' })}
            title="查看全部项目资产"
          >
            <Layers size={18} />
            <span>全部</span>
          </button>
        </div>

        <div className={styles.viewToggle}>
          <button
            className={`${styles.viewBtn} ${viewMode === 'grid' ? styles.active : ''}`}
            onClick={() => setViewMode('grid')}
            title="网格视图"
          >
            <Grid size={18} />
          </button>
          <button
            className={`${styles.viewBtn} ${viewMode === 'list' ? styles.active : ''}`}
            onClick={() => setViewMode('list')}
            title="列表视图"
          >
            <List size={18} />
          </button>
        </div>

        <div className={styles.groupToggle}>
          {([
            ['none', '平铺'],
            ['project', '按项目'],
            ['type', '按分类'],
          ] as Array<[AssetLibraryGroupMode, string]>).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={groupMode === mode ? styles.activeGroupBtn : undefined}
              onClick={() => {
                updateLibraryView({
                  groupMode: mode,
                  scope: mode === 'project' ? 'all' : libraryScope,
                });
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <div className={styles.filterDropdown}>
            <button
              className={styles.toolBtn}
              onClick={() => {
                setShowFilterDropdown((prev) => !prev);
                setShowRatingDropdown(false);
              }}
            >
              <Filter size={16} />
              {getFilterLabel(filterType)}
            </button>
            {showFilterDropdown && (
              <div className={styles.filterMenu}>
                {(['all', 'image', 'video', 'audio', 'document'] as FilterType[]).map((type) => (
                  <button
                    key={type}
                    className={`${styles.filterItem} ${filterType === type ? styles.active : ''}`}
                    onClick={() => {
                      updateLibraryView({ filterType: type });
                      setShowFilterDropdown(false);
                    }}
                  >
                    {getAssetIcon(type as Asset['type'])}
                    {getFilterLabel(type)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className={`${styles.toolBtn} ${favoriteOnly ? styles.activeToolBtn : ''}`}
            onClick={() => {
              setFavoriteOnly((prev) => !prev);
              setShowFilterDropdown(false);
              setShowRatingDropdown(false);
            }}
            title={favoriteOnly ? '显示全部资产' : '只看收藏'}
            aria-label={favoriteOnly ? '取消只看收藏' : '只看收藏'}
            aria-pressed={favoriteOnly}
          >
            <Star size={16} fill={favoriteOnly ? 'currentColor' : 'none'} />
            收藏
          </button>
          <div className={styles.filterDropdown}>
            <button
              className={`${styles.toolBtn} ${ratingFilter > 0 ? styles.activeToolBtn : ''}`}
              onClick={() => {
                setShowRatingDropdown((prev) => !prev);
                setShowFilterDropdown(false);
              }}
              aria-label="星级筛选"
            >
              <Star size={16} fill={ratingFilter > 0 ? 'currentColor' : 'none'} />
              {getRatingFilterLabel(ratingFilter)}
            </button>
            {showRatingDropdown && (
              <div className={styles.filterMenu}>
                {([0, 1, 2, 3, 4, 5] as RatingFilter[]).map((rating) => (
                  <button
                    key={rating}
                    className={`${styles.filterItem} ${ratingFilter === rating ? styles.active : ''}`}
                    onClick={() => {
                      setRatingFilter(rating);
                      setShowRatingDropdown(false);
                    }}
                  >
                    <Star size={16} fill={rating > 0 ? 'currentColor' : 'none'} />
                    {rating === 0 ? '全部星级' : `${rating} 星及以上`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={styles.primaryBtn} onClick={() => setIsUploadModalOpen(true)}>
            <Upload size={16} /> 上传
          </button>
        </div>
      </div>

      {selectedAssetData && (
        <div className={styles.detailOverlay} role="presentation" onClick={() => setSelectedAsset(null)}>
          <section className={styles.detailPanel} aria-label="资产详情" onClick={(event) => event.stopPropagation()}>
            <div className={styles.detailSidebar}>
              <div className={styles.detailPreview}>
                {selectedAssetData.type === 'image' ? (
                  <AssetPreviewImage asset={selectedAssetData} onPreview={setPreviewImage} />
                ) : selectedAssetData.type === 'document' ? (
                  <div className={styles.detailDocumentPreview}>
                    <div className={styles.detailDocumentPreviewHeader}>
                      <div>
                        <strong>{selectedAssetIsMarkdownDocument ? 'Markdown 预览' : '文档预览'}</strong>
                        <span>{selectedAssetMetric?.value ?? '加载中'}</span>
                      </div>
                    </div>
                    <div className={styles.detailDocumentPreviewBody}>
                      {detailResolveStatus === 'loading' && !resolvedDocumentText ? (
                        <div className={styles.detailLoadingState}>
                          <Loader2 size={20} className={styles.previewSpinner} />
                          <span>正在加载文档</span>
                        </div>
                      ) : resolvedDocumentText !== null ? (
                        selectedAssetIsMarkdownDocument ? (
                          <div className={styles.detailMarkdownPreview}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {resolvedDocumentText}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <pre className={styles.detailPlaintextPreview}>
                            {resolvedDocumentText || '文档为空'}
                          </pre>
                        )
                      ) : (
                        <div className={styles.detailLoadingState}>
                          <ImageOff size={20} />
                          <span>文档无法预览</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={styles.detailFallback}>
                    <div className={styles.detailFallbackIcon}>
                      {getAssetIcon(selectedAssetData.type)}
                    </div>
                    <span>{getFilterLabel(selectedAssetData.type)}</span>
                  </div>
                )}
              </div>

              {selectedAssetData.type === 'image' &&
                (selectedAssetPrompt || selectedAssetRevisedPrompt) && (
                  <div className={styles.detailPromptBlock}>
                    <div className={styles.detailPromptHeader}>
                      <span>提示词</span>
                      {selectedAssetRevisedPrompt && selectedAssetRevisedPrompt !== selectedAssetPrompt && (
                        <span>AI 优化</span>
                      )}
                    </div>
                    {selectedAssetPrompt && (
                      <div className={styles.detailPromptSection}>
                        <span className={styles.detailPromptLabel}>原始提示词</span>
                        <pre className={styles.detailPromptText}>{selectedAssetPrompt}</pre>
                      </div>
                    )}
                    {selectedAssetRevisedPrompt && selectedAssetRevisedPrompt !== selectedAssetPrompt && (
                      <div className={styles.detailPromptSection}>
                        <span className={styles.detailPromptLabel}>优化提示词</span>
                        <pre className={styles.detailPromptText}>{selectedAssetRevisedPrompt}</pre>
                      </div>
                    )}
                  </div>
                )}
            </div>

            <div className={styles.detailBody}>
              <div className={styles.detailHeader}>
                <div className={styles.detailHeading}>
                  <div className={styles.detailNameRow}>
                    <h3 className={styles.detailName} title={selectedAssetData.name}>
                      {selectedAssetData.name}
                    </h3>
                  </div>
                  <div className={styles.detailMetaRow}>
                    <span className={styles.assetType}>{getFilterLabel(selectedAssetData.type)}</span>
                    <span className={styles.projectBadge}>{selectedAssetProjectName}</span>
                    <span className={styles.detailMuted}>
                      {formatAssetDate(selectedAssetData.createdAt)}
                    </span>
                  </div>
                </div>
                <div className={styles.detailActions}>
                  <button
                    type="button"
                    className={`${styles.detailActionBtn} ${styles.detailBackBtn}`}
                    onClick={() => setSelectedAsset(null)}
                    title="返回资产库"
                  >
                    <ArrowLeft size={16} />
                    <span>返回资产库</span>
                  </button>
                  <button
                    type="button"
                    className={styles.detailActionBtn}
                    onClick={(event) => void handleAssetDownload(selectedAssetData, event)}
                    title="下载"
                  >
                    <Download size={16} />
                    <span>下载</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.detailActionBtn} ${selectedAssetFavorite ? styles.detailActionActive : ''}`}
                    onClick={(event) => handleFavoriteToggle(selectedAssetData, event)}
                    title={selectedAssetFavorite ? '取消收藏' : '收藏'}
                  >
                    <Star size={16} fill={selectedAssetFavorite ? 'currentColor' : 'none'} />
                    <span>{selectedAssetFavorite ? '取消收藏' : '收藏'}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.detailActionBtn} ${styles.detailDanger}`}
                    onClick={(event) => void handleAssetDelete(selectedAssetData, event)}
                    title="删除"
                  >
                    <Trash2 size={16} />
                    <span>删除</span>
                  </button>
                </div>
              </div>

              <dl className={styles.detailGrid}>
                <div className={styles.detailField}>
                  <dt className={styles.detailFieldLabel}>项目</dt>
                  <dd className={styles.detailFieldValue}>{selectedAssetProjectName}</dd>
                </div>
                <div className={styles.detailField}>
                  <dt className={styles.detailFieldLabel}>类型</dt>
                  <dd className={styles.detailFieldValue}>{getFilterLabel(selectedAssetData.type)}</dd>
                </div>
                <div className={styles.detailField}>
                  <dt className={styles.detailFieldLabel}>{selectedAssetMetric?.label ?? '尺寸'}</dt>
                  <dd className={styles.detailFieldValue}>{selectedAssetMetric?.value ?? '未填写'}</dd>
                </div>
                <div className={styles.detailField}>
                  <dt className={styles.detailFieldLabel}>更新时间</dt>
                  <dd className={styles.detailFieldValue}>
                    {formatAssetDate(selectedAssetData.updatedAt ?? selectedAssetData.createdAt)}
                  </dd>
                </div>
              </dl>
            </div>
          </section>
        </div>
      )}

      {filteredAssets.length === 0 ? (
        <div className={styles.emptyContainer}>
          <div className={styles.emptyIcon}>
            <FoldersEmpty />
          </div>
          <h3>{hasActiveAssetFilters ? '没有符合条件的资产' : '当前项目暂无资产'}</h3>
          <p>
            {hasActiveAssetFilters
              ? '调整搜索、类型、收藏或星级筛选后再试。'
              : '上传的图片、音频、视频或文档会直接保存到当前项目，并参与后续分镜与剧本流程。'}
          </p>
        </div>
      ) : (
        <div className={styles.assetSections}>
          {groupedAssetSections.map((section) => (
            <section key={section.key} className={styles.assetSection}>
              {groupMode !== 'none' && (
                <div className={styles.assetSectionHeader}>
                  <h3>{section.title}</h3>
                  <span>{section.subtitle}</span>
                </div>
              )}
              <div className={viewMode === 'grid' ? styles.gridLayout : styles.listLayout}>
                {section.assets.map((asset, index) => renderAssetItem(asset, index))}
              </div>
            </section>
          ))}
        </div>
      )}

      {isUploadModalOpen && (
        <div className={styles.uploadModalOverlay} onClick={handleCloseUploadModal}>
          <div className={styles.uploadModal} onClick={(event) => event.stopPropagation()}>
            <div className={styles.uploadModalHeader}>
              <h2>上传资产</h2>
              <button
                className={styles.closeButton}
                onClick={handleCloseUploadModal}
                disabled={isUploading}
              >
                <X size={24} />
              </button>
            </div>
            <div
              className={`${styles.dropZone} ${isDragging ? styles.dragging : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={(event) => void handleDrop(event)}
            >
              <UploadCloud size={48} className={styles.dropZoneIcon} />
              <p className={styles.dropZoneText}>拖拽文件到这里上传</p>
              <p className={styles.dropZoneSubtext}>
                当前实现会把文件内容直接写入项目资产库，刷新后仍能保留。
              </p>
              <input
                type="file"
                ref={fileInputRef}
                className={styles.fileInput}
                multiple
                onChange={(event) => void handleFileSelect(event)}
              />
              <button
                className={styles.uploadSelectButton}
                onClick={handleUploadButtonClick}
                disabled={isUploading}
              >
                选择文件
              </button>
            </div>
            {uploadingFiles.length > 0 && (
              <div className={styles.uploadProgressContainer}>
                <h3>{isUploading ? '上传中' : '上传完成'}</h3>
                {uploadingFiles.map((file) => (
                  <div key={file.id} className={styles.uploadProgressItem}>
                    <div className={styles.uploadProgressInfo}>
                      <span className={styles.uploadFileName}>{file.name}</span>
                      <span className={styles.uploadFileSize}>{formatFileSize(file.size)}</span>
                    </div>
                    <div className={styles.progressBar}>
                      <div className={styles.progressFill} style={{ width: `${file.progress}%` }} />
                    </div>
                    <span className={styles.progressText}>{Math.round(file.progress)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {previewImage && (
        <AssetPreviewDialog preview={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </div>
  );
};

const AssetPreviewDialog: React.FC<{
  preview: PreviewImage;
  onClose: () => void;
}> = ({ preview, onClose }) => {
  const [zoomLevel, setZoomLevel] = useState(1);
  const assetMetadata = useMemo(() => normalizeAssetMetadata(preview.asset.metadata), [preview.asset.metadata]);
  const imageSizeBytes = getMetadataNumber(assetMetadata, ['sizeBytes']);
  const prompt = getMetadataText(assetMetadata, 'prompt');
  const revisedPrompt = getMetadataText(assetMetadata, 'revisedPrompt');
  const hasOptimizedPrompt = prompt !== '' && revisedPrompt !== '' && revisedPrompt !== prompt;
  const previewPrompt = revisedPrompt || prompt;
  const hasPrompt = prompt !== '' || revisedPrompt !== '';

  useEffect(() => {
    setZoomLevel(1);
  }, [preview.src]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const clampZoom = (value: number) => Math.max(0.5, Math.min(4, Math.round(value * 100) / 100));
  const zoomOut = () => setZoomLevel((current) => clampZoom(current - 0.25));
  const zoomIn = () => setZoomLevel((current) => clampZoom(current + 0.25));
  const resetZoom = () => setZoomLevel(1);

  return (
    <div className={styles.previewOverlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.previewDialog} onClick={(event) => event.stopPropagation()}>
        <div className={styles.previewHeader}>
          <div className={styles.previewHeaderInfo}>
            <strong>{preview.name}</strong>
            <div className={styles.previewHeaderMeta}>
              <span className={styles.previewTypeBadge}>{ASSET_TYPE_LABELS[preview.asset.type]}</span>
              <span>{formatBytesToMb(imageSizeBytes)}</span>
            </div>
          </div>
          <div className={styles.previewHeaderActions}>
            <button type="button" onClick={zoomOut} title="缩小" aria-label="缩小">
              <Minus size={16} />
            </button>
            <button type="button" onClick={resetZoom} title="还原" aria-label="还原">
              <Maximize2 size={16} />
            </button>
            <button type="button" onClick={zoomIn} title="放大" aria-label="放大">
              <Plus size={16} />
            </button>
            <span className={styles.previewZoomLabel}>{Math.round(zoomLevel * 100)}%</span>
            <button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className={styles.previewCanvas}>
          <div
            className={styles.previewCanvasStage}
            style={{ width: `${zoomLevel * 100}%`, height: `${zoomLevel * 100}%` }}
          >
            <img src={preview.src} alt={preview.name} className={styles.previewCanvasImage} />
          </div>
        </div>
        {hasPrompt && (
          <div className={styles.previewFooter}>
            <div className={styles.previewPromptHeader}>
              <span>提示词</span>
              {hasOptimizedPrompt && <span>AI 优化</span>}
            </div>
            {prompt ? (
              <div className={styles.previewPromptSection}>
                <span className={styles.previewPromptLabel}>原始提示词</span>
                <pre className={styles.previewPromptText}>{prompt}</pre>
              </div>
            ) : previewPrompt ? (
              <div className={styles.previewPromptSection}>
                <span className={styles.previewPromptLabel}>提示词</span>
                <pre className={styles.previewPromptText}>{previewPrompt}</pre>
              </div>
            ) : null}
            {hasOptimizedPrompt && (
              <div className={styles.previewPromptSection}>
                <span className={styles.previewPromptLabel}>优化提示词</span>
                <pre className={styles.previewPromptText}>{revisedPrompt}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const FoldersEmpty = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
);
