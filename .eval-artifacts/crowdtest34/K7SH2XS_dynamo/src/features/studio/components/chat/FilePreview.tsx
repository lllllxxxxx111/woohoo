import React, { useState } from 'react';
import { X, ZoomIn, Download, Image as ImageIcon, Film, FileText, Music } from 'lucide-react';
import type { MessageAttachment } from '../../../../types';
import styles from './FilePreview.module.css';

interface FilePreviewProps {
  attachments: MessageAttachment[];
}

/**
 * 根据MIME类型获取文件图标
 */
function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <ImageIcon size={16} />;
  if (mimeType.startsWith('video/')) return <Film size={16} />;
  if (mimeType.startsWith('audio/')) return <Music size={16} />;
  return <FileText size={16} />;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 获取来源标签文本
 */
function getSourceLabel(source: MessageAttachment['source']): string {
  switch (source) {
    case 'user_upload':
      return '用户上传';
    case 'ai_generated':
      return 'AI生成';
    case 'ai_referenced':
      return 'AI引用';
    default:
      return source;
  }
}

/**
 * 获取来源样式类名
 */
function getSourceStyleClass(source: MessageAttachment['source']): string {
  switch (source) {
    case 'user_upload':
      return styles.userUpload;
    case 'ai_generated':
      return styles.aiGenerated;
    case 'ai_referenced':
      return styles.aiReferenced;
    default:
      return '';
  }
}

/**
 * 图片Lightbox预览组件
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className={styles.lightboxOverlay} onClick={onClose}>
      <div className={styles.lightboxContent} onClick={(e) => e.stopPropagation()}>
        <button className={styles.lightboxClose} onClick={onClose}>
          <X size={24} />
        </button>
        <img src={src} alt={alt} className={styles.lightboxImage} />
      </div>
    </div>
  );
}

/**
 * 单个附件预览项
 */
function AttachmentItem({ attachment }: { attachment: MessageAttachment }) {
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const isImage = attachment.mimeType.startsWith('image/');
  const isVideo = attachment.mimeType.startsWith('video/');
  const isAudio = attachment.mimeType.startsWith('audio/');

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = attachment.url;
    link.download = attachment.name;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className={`${styles.attachmentItem} ${getSourceStyleClass(attachment.source)}`}>
        <div className={styles.attachmentHeader}>
          <span className={styles.fileIcon}>{getFileIcon(attachment.mimeType)}</span>
          <span className={styles.fileName} title={attachment.name}>
            {attachment.name}
          </span>
          <span className={styles.sourceBadge}>{getSourceLabel(attachment.source)}</span>
        </div>

        <div className={styles.attachmentBody}>
          {isImage && (
            <div className={styles.imageThumbnail} onClick={() => setIsLightboxOpen(true)}>
              <img
                src={attachment.thumbnailUrl || attachment.url}
                alt={attachment.name}
                loading="lazy"
              />
              <div className={styles.zoomHint}>
                <ZoomIn size={14} />
                <span>点击预览</span>
              </div>
            </div>
          )}

          {isVideo && (
            <video
              className={styles.videoPlayer}
              controls
              preload="metadata"
              poster={attachment.thumbnailUrl}
            >
              <source src={attachment.url} type={attachment.mimeType} />
              您的浏览器不支持视频播放
            </video>
          )}

          {isAudio && (
            <audio className={styles.audioPlayer} controls preload="metadata">
              <source src={attachment.url} type={attachment.mimeType} />
              您的浏览器不支持音频播放
            </audio>
          )}

          {!isImage && !isVideo && !isAudio && (
            <div className={styles.documentPreview}>
              <FileText size={32} style={{ color: 'var(--text-quaternary)' }} />
              <span className={styles.docInfo}>{formatFileSize(attachment.sizeBytes)}</span>
            </div>
          )}
        </div>

        <div className={styles.attachmentFooter}>
          <button className={styles.downloadBtn} onClick={handleDownload} title="下载文件">
            <Download size={12} />
            <span>下载</span>
          </button>
        </div>

        {isLightboxOpen && (
          <ImageLightbox
            src={attachment.url}
            alt={attachment.name}
            onClose={() => setIsLightboxOpen(false)}
          />
        )}
      </div>
    </>
  );
}

/**
 * 文件预览容器组件 - 支持三种来源样式的区分显示
 */
function FilePreview({ attachments }: FilePreviewProps) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className={styles.previewContainer}>
      {attachments.map((attachment, index) => (
        <AttachmentItem key={`${attachment.name}-${index}`} attachment={attachment} />
      ))}
    </div>
  );
}

export default FilePreview;
