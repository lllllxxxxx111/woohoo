import type { MessageAttachment } from '../types';
import { logger } from './logger';
import { ensureServerSession, fetchServer } from './serverApi';

/**
 * 上传文件到服务器（使用统一API客户端，带鉴权和端口自动切换）
 */
export async function uploadFile(
  file: File,
  projectId: string,
  _options?: { onProgress?: (percent: number) => void },
): Promise<MessageAttachment> {
  try {
    const session = await ensureServerSession(false);

    const formData = new FormData();
    formData.append('file', file);

    const doUpload = async (token: string) => {
      return fetchServer(`/api/projects/${projectId}/assets/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
    };

    let response = await doUpload(session.token);

    /**
     * 401 时自动刷新 token 并重试一次（与 requestApi 行为一致）
     */
    if (response.status === 401) {
      const refreshed = await ensureServerSession(true);
      response = await doUpload(refreshed.token);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let errorMessage = `上传失败 (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) {
          errorMessage = errorJson.error;
        }
      } catch {}
      throw new Error(errorMessage);
    }

    /**
     * 后端返回格式：(StatusCode::CREATED, Json(asset))
     * 直接是 Asset 对象，无 success/data 包装
     */
    const asset = await response.json();

    return {
      url: asset.url || asset.path || '',
      name: asset.name || file.name,
      mimeType: asset.mimeType || file.type,
      sizeBytes: asset.sizeBytes || file.size,
      thumbnailUrl: asset.thumbnailUrl,
      source: 'user_upload' as const,
      sourceMeta: {
        uploadTime: new Date().toISOString(),
      },
    };
  } catch (error) {
    logger.error('文件上传错误:', error);
    throw error;
  }
}

/**
 * 批量上传多个文件
 */
export async function uploadFiles(
  files: File[],
  projectId: string,
  options?: { onProgress?: (current: number, total: number) => void },
): Promise<MessageAttachment[]> {
  const results: MessageAttachment[] = [];

  for (let i = 0; i < files.length; i++) {
    options?.onProgress?.(i + 1, files.length);
    const attachment = await uploadFile(files[i], projectId, {
      onProgress: options?.onProgress
        ? (percent) =>
            options.onProgress!(Math.round(percent * files.length) / 100 + i, files.length)
        : undefined,
    });
    results.push(attachment);
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
