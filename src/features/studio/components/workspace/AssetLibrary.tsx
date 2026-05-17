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
  MoreVertical,
  Download,
  Trash2,
  ImageOff,
  Loader2,
  ZoomIn,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { Asset } from '../../../../types';
import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import { getServerAssetBlob } from '../../../../lib/serverApi';
import { isProtectedAssetUrl, useAssetPreviewUrl } from '../../../../hooks/useAssetPreviewUrl';
import styles from './AssetLibrary.module.css';

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
  size: number;
}

type FilterType = 'all' | 'image' | 'video' | 'audio' | 'document';
type ViewMode = 'grid' | 'list';

type PreviewImage = {
  src: string;
  name: string;
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
          onPreview({ src: previewUrl, name: asset.name });
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
  const { activeAssets, activeState } = useAppStore(
    useShallow((state) => ({ activeAssets: state.activeAssets, activeState: state.activeState })),
  );
  const { uploadAssets, deleteAsset, updateAsset } = useAppActions();
  const { showToast } = useToast();

  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const metadataUpdateQueuesRef = useRef(new Map<string, Promise<Asset>>());

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

  const filteredAssets = useMemo(() => {
    return activeAssets.filter((asset) => {
      const matchesType = filterType === 'all' || asset.type === filterType;
      const matchesSearch =
        searchQuery === '' || asset.name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesType && matchesSearch;
    });
  }, [activeAssets, filterType, searchQuery]);

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
    setSelectedAsset(assetId === selectedAsset ? null : assetId);
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
    const labels: Record<FilterType, string> = {
      all: '全部',
      image: '图片',
      video: '视频',
      audio: '音频',
      document: '文档',
    };
    return labels[type];
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

        <div className={styles.actions}>
          <div className={styles.filterDropdown}>
            <button
              className={styles.toolBtn}
              onClick={() => setShowFilterDropdown((prev) => !prev)}
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
                      setFilterType(type);
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
          <button className={styles.primaryBtn} onClick={() => setIsUploadModalOpen(true)}>
            <Upload size={16} /> 上传
          </button>
        </div>
      </div>

      {filteredAssets.length === 0 ? (
        <div className={styles.emptyContainer}>
          <div className={styles.emptyIcon}>
            <FoldersEmpty />
          </div>
          <h3>当前项目暂无资产</h3>
          <p>上传的图片、音频、视频或文档会直接保存到当前项目，并参与后续分镜与剧本流程。</p>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? styles.gridLayout : styles.listLayout}>
          {filteredAssets.map((asset, index) => {
            const favorite = isFavoriteAsset(asset);
            const rating = getAssetRating(asset);

            return (
              <div
                key={asset.id}
                className={`${viewMode === 'grid' ? styles.assetCard : styles.assetListItem} ${selectedAsset === asset.id ? styles.selected : ''}`}
                style={{ animationDelay: `${index * 0.08}s` }}
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
                    <button
                      className={styles.moreBtn}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreVertical size={16} />
                    </button>
                  </div>
                  <div className={styles.assetMetaRow}>
                    <span className={styles.assetType}>{getFilterLabel(asset.type)}</span>
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
          })}
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
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.previewOverlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={styles.previewDialog} onClick={(event) => event.stopPropagation()}>
        <div className={styles.previewHeader}>
          <strong>{preview.name}</strong>
          <button type="button" onClick={onClose} title="关闭预览">
            <X size={18} />
          </button>
        </div>
        <div className={styles.previewCanvas}>
          <img src={preview.src} alt={preview.name} />
        </div>
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
