import React from 'react';
import { X, Image, Film, FileText, Music } from 'lucide-react';
import type { MessageAttachment } from '../../../../types';
import styles from './FileUpload.module.css';

interface AttachmentPreviewProps {
  attachments: MessageAttachment[];
  onRemove: (index: number) => void;
  source?: 'pending' | 'sent';
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <Image size={14} />;
  if (mimeType.startsWith('video/')) return <Film size={14} />;
  if (mimeType.startsWith('audio/')) return <Music size={14} />;
  return <FileText size={14} />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getSourceLabel(source: string): string {
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

function getSourceClass(source: string): string {
  switch (source) {
    case 'user_upload':
      return styles.userSource;
    case 'ai_generated':
      return styles.aiGeneratedSource;
    case 'ai_referenced':
      return styles.aiReferencedSource;
    default:
      return '';
  }
}

function AttachmentPreview({ attachments, onRemove, source = 'pending' }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={styles.previewContainer}>
      {attachments.map((attachment, index) => (
        <div
          key={`${attachment.name}-${index}`}
          className={`${styles.previewItem} ${getSourceClass(attachment.source)}`}
          title={`${attachment.name} (${formatFileSize(attachment.sizeBytes)})`}
        >
          <span className={styles.fileIcon}>{getFileIcon(attachment.mimeType)}</span>
          <span className={styles.fileName}>{attachment.name}</span>
          <span className={styles.fileSize}>{formatFileSize(attachment.sizeBytes)}</span>
          {source !== 'sent' && (
            <button className={styles.removeBtn} onClick={() => onRemove(index)} type="button">
              <X size={12} />
            </button>
          )}
          {source === 'sent' && attachment.source !== 'user_upload' && (
            <span className={styles.sourceTag}>{getSourceLabel(attachment.source)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default AttachmentPreview;
