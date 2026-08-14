import type { MessageAttachment } from '../types';
import { logger } from './logger';
import { findResumableUpload, startResumableUpload, type UploadedAsset } from './chunkedUpload';

/**
 * 上传文件到服务器。
 *
 * 统一走分片上传客户端：真实字节进度、断点续传、失败重试。
 * 旧的单次 multipart 接口仍由后端保留兼容，但前端不再使用。
 */
export async function uploadFile(
  file: File,
  projectId: string,
  options?: { onProgress?: (percent: number) => void },
): Promise<MessageAttachment> {
  try {
    const resumeRecord = findResumableUpload(projectId, file);
    const handle = startResumableUpload(file, projectId, {
      resumeSessionId: resumeRecord?.sessionId,
      resumeFallbackToNewOnMismatch: true,
      onProgress: (progress) => options?.onProgress?.(progress.percent),
    });
    const asset = await handle.promise;
    return toAttachment(asset, file);
  } catch (error) {
    logger.error('文件上传错误:', error);
    throw error;
  }
}

function toAttachment(asset: UploadedAsset, file: File): MessageAttachment {
  const metadata = (asset.metadata ?? {}) as Record<string, unknown>;
  const sizeBytes = typeof metadata.sizeBytes === 'number' ? metadata.sizeBytes : file.size;
  return {
    url: asset.url || '',
    name: asset.name || file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes,
    source: 'user_upload' as const,
    sourceMeta: {
      uploadTime: new Date().toISOString(),
    },
  };
}

/**
 * 批量上传多个文件（顺序执行，单文件内部已做分片并发）
 */
export async function uploadFiles(
  files: File[],
  projectId: string,
  options?: { onProgress?: (current: number, total: number) => void },
): Promise<MessageAttachment[]> {
  const results: MessageAttachment[] = [];

  for (let i = 0; i < files.length; i++) {
    options?.onProgress?.(i, files.length);
    const attachment = await uploadFile(files[i], projectId);
    results.push(attachment);
    options?.onProgress?.(i + 1, files.length);
  }

  return results;
}

/**
 * 获取文件的MIME类型图标
 */
export function getFileTypeIcon(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * 检查文件类型是否允许上传
 */
export function isAllowedFileType(file: File): boolean {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
  ];

  const allowedExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.svg',
    '.mp4',
    '.webm',
    '.mp3',
    '.wav',
    '.pdf',
    '.doc',
    '.docx',
    '.ppt',
    '.pptx',
    '.txt',
  ];

  if (allowedTypes.includes(file.type)) return true;

  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return allowedExtensions.includes(ext);
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
