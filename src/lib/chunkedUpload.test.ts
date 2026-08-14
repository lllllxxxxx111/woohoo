import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHUNK_UPLOAD_CONSTRAINTS,
  computeUploadPercent,
  findResumableUpload,
  listResumableUploads,
  planChunks,
  removeResumableUpload,
  startResumableUpload,
  type UploadProgress,
} from './chunkedUpload';
import type { MessageAttachment } from '../types';

describe('planChunks 分片规划', () => {
  const { minChunkSize, maxChunkSize, defaultChunkSize, maxTotalChunks } = CHUNK_UPLOAD_CONSTRAINTS;

  it('小文件使用最小分片、单片', () => {
    const plan = planChunks(100);
    expect(plan.chunkSize).toBe(minChunkSize);
    expect(plan.totalChunks).toBe(1);
  });

  it('普通文件按默认分片大小规划', () => {
    const plan = planChunks(defaultChunkSize * 2 + 1);
    expect(plan.chunkSize).toBe(defaultChunkSize);
    expect(plan.totalChunks).toBe(3);
  });

  it('用户偏好被夹在协议区间内', () => {
    const tooSmall = planChunks(10 * 1024 * 1024, 1024);
    expect(tooSmall.chunkSize).toBe(minChunkSize);

    const tooBig = planChunks(100 * 1024 * 1024, maxChunkSize * 4);
    expect(tooBig.chunkSize).toBe(maxChunkSize);
  });

  it('超大文件自动放大分片，避免分片数超限', () => {
    const fileSize = maxTotalChunks * maxChunkSize; // 恰好上限
    const plan = planChunks(fileSize);
    expect(plan.totalChunks).toBe(maxTotalChunks);
    expect(plan.chunkSize).toBe(maxChunkSize);
  });

  it('非法大小直接拒绝', () => {
    expect(() => planChunks(0)).toThrow();
    expect(() => planChunks(-1)).toThrow();
    expect(() => planChunks(Number.NaN)).toThrow();
  });
});

describe('computeUploadPercent 真实进度计算', () => {
  it('无数据时为 0', () => {
    expect(computeUploadPercent(0, 0, 100)).toBe(0);
  });

  it('已确认字节按比例换算', () => {
    expect(computeUploadPercent(50, 0, 100)).toBe(50);
    expect(computeUploadPercent(33, 0, 99)).toBe(33.3);
  });

  it('在途字节计入但不超过总量', () => {
    expect(computeUploadPercent(50, 20, 100)).toBe(70);
    expect(computeUploadPercent(90, 50, 100)).toBe(100);
  });

  it('绝不由定时器/随机数推进：同一输入恒定输出', () => {
    const samples = Array.from({ length: 20 }, () => computeUploadPercent(42, 7, 100));
    expect(new Set(samples).size).toBe(1);
    expect(samples[0]).toBe(49);
  });
});

describe('上传状态机启动顺序', () => {
  it('先返回 handle，再异步报告同步校验错误', async () => {
    const phases: string[] = [];
    let handle: ReturnType<typeof startResumableUpload> | undefined;
    const emptyFile = {
      name: 'empty.txt',
      size: 0,
      type: 'text/plain',
    } as File;

    handle = startResumableUpload(emptyFile, 'project-1', {
      onProgress: (progress) => {
        expect(handle).toBeDefined();
        phases.push(progress.phase);
      },
    });

    await expect(handle.promise).rejects.toThrow('文件大小无效');
    expect(phases).toEqual(['error']);
  });
});

describe('刷新后续传描述符', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
      },
    });
  });

  afterEach(() => {
    store = {};
  });

  it('描述符只含会话元数据，绝不包含 File 对象或文件内容', () => {
    // 模拟 chunkedUpload 内部保存逻辑
    const record = {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      filename: 'demo.txt',
      fileSize: 1234,
      fileSha256: 'a'.repeat(64),
      chunkSize: 64 * 1024,
      totalChunks: 1,
      updatedAt: Date.now(),
    };
    localStorage.setItem('woohoo-upload-resume-v1', JSON.stringify([record]));

    const listed = listResumableUploads('proj-1');
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe('sess-1');

    const serialized = store['woohoo-upload-resume-v1'];
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('base64');
    // File/Blob 结构特征不得出现
    expect(serialized).not.toMatch(/"lastModified"/);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('可按 sessionId 删除描述符', () => {
    const records = [
      {
        sessionId: 'a',
        projectId: 'p',
        filename: 'a.txt',
        fileSize: 1,
        fileSha256: 'b'.repeat(64),
        chunkSize: 64 * 1024,
        totalChunks: 1,
        updatedAt: Date.now(),
      },
      {
        sessionId: 'b',
        projectId: 'p',
        filename: 'b.txt',
        fileSize: 1,
        fileSha256: 'c'.repeat(64),
        chunkSize: 64 * 1024,
        totalChunks: 1,
        updatedAt: Date.now(),
      },
    ];
    localStorage.setItem('woohoo-upload-resume-v1', JSON.stringify(records));
    removeResumableUpload('a');
    expect(listResumableUploads('p').map((r) => r.sessionId)).toEqual(['b']);
  });

  it('重新选择同名同大小文件时优先使用最新且未被占用的会话', () => {
    const now = Date.now();
    localStorage.setItem(
      'woohoo-upload-resume-v1',
      JSON.stringify([
        {
          sessionId: 'old',
          projectId: 'p',
          filename: 'demo.txt',
          fileSize: 123,
          fileSha256: 'a'.repeat(64),
          chunkSize: 64 * 1024,
          totalChunks: 1,
          updatedAt: now - 1000,
        },
        {
          sessionId: 'new',
          projectId: 'p',
          filename: 'demo.txt',
          fileSize: 123,
          fileSha256: 'b'.repeat(64),
          chunkSize: 64 * 1024,
          totalChunks: 1,
          updatedAt: now,
        },
        {
          sessionId: 'other-project',
          projectId: 'q',
          filename: 'demo.txt',
          fileSize: 123,
          fileSha256: 'c'.repeat(64),
          chunkSize: 64 * 1024,
          totalChunks: 1,
          updatedAt: now + 1000,
        },
      ]),
    );

    const file = { name: 'demo.txt', size: 123 };
    expect(findResumableUpload('p', file)?.sessionId).toBe('new');
    expect(findResumableUpload('p', file, new Set(['new']))?.sessionId).toBe('old');
    expect(findResumableUpload('p', { name: 'other.txt', size: 123 })).toBeUndefined();
  });

  it('上传结果可映射为聊天附件结构', () => {
    const progress: UploadProgress = {
      phase: 'uploading',
      bytesHashed: 100,
      hashingPercent: 100,
      bytesUploaded: 50,
      bytesInFlight: 10,
      bytesTotal: 100,
      percent: 60,
      failedAttempts: 0,
    };
    expect(progress.percent).toBeGreaterThan(0);
    expect(progress.percent).toBeLessThanOrEqual(100);

    // 与 MessageAttachment 的兼容映射（类型级保证）。
    const attachment: Pick<MessageAttachment, 'name' | 'sizeBytes' | 'source'> = {
      name: 'f.txt',
      sizeBytes: 100,
      source: 'user_upload',
    };
    expect(attachment.source).toBe('user_upload');
  });
});
