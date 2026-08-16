import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { fetchServer } from './serverApi';
import type { MessageAttachment } from '../types';

vi.mock('./serverApi', () => ({
  ensureServerSession: async () => ({ token: 'test-token' }),
  getServerBaseUrl: async () => 'http://server.test',
  fetchServer: vi.fn(),
}));

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
    expect(() => planChunks(-1)).toThrow();
    expect(() => planChunks(Number.NaN)).toThrow();
  });

  it('0 字节文件规划为单个空分片', () => {
    const plan = planChunks(0);
    expect(plan.totalChunks).toBe(1);
    expect(plan.chunkSize).toBe(CHUNK_UPLOAD_CONSTRAINTS.minChunkSize);
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
    const badFile = {
      name: 'bad.txt',
      size: -1,
      type: 'text/plain',
    } as File;

    handle = startResumableUpload(badFile, 'project-1', {
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

/* ───────────────────── 状态机集成测试（mock 网络） ───────────────────── */

// planChunks 对小于默认分片大小的文件会整体单片化，只有超过 4MB 的文件
// 才会真正进入多分片并发路径——这是本组用例要覆盖的状态机核心。
const CHUNK = CHUNK_UPLOAD_CONSTRAINTS.defaultChunkSize;
const TOTAL_CHUNKS = 4;
const FILE_SIZE = CHUNK * TOTAL_CHUNKS;

function makeFakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'application/octet-stream',
    slice(start?: number, end?: number) {
      const from = Math.max(0, start ?? 0);
      const to = Math.min(size, end ?? size);
      return {
        arrayBuffer: async () => new ArrayBuffer(Math.max(0, to - from)),
      } as unknown as Blob;
    },
  } as unknown as File;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeXhr {
  static sentPartNumbers: number[] = [];
  static active = 0;
  static maxConcurrent = 0;
  static failStatus: number | null = null;

  method = '';
  url = '';
  status = 0;
  responseText = '';
  timeout = 0;
  responseType = '';
  upload = {
    onprogress: null as
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private aborted = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader() {}

  getResponseHeader() {
    return null;
  }

  send() {
    const partNumber = Number(this.url.split('/parts/')[1] ?? '0');
    FakeXhr.sentPartNumbers.push(partNumber);
    FakeXhr.active += 1;
    FakeXhr.maxConcurrent = Math.max(FakeXhr.maxConcurrent, FakeXhr.active);
    const failStatus = FakeXhr.failStatus;
    void Promise.resolve().then(() => {
      FakeXhr.active -= 1;
      if (this.aborted) return;
      if (failStatus !== null) {
        this.status = failStatus;
        this.responseText = JSON.stringify({ error: `part failed (${failStatus})` });
      } else {
        this.status = 200;
        this.responseText = '';
      }
      this.onload?.();
    });
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    FakeXhr.active = Math.max(0, FakeXhr.active - 1);
    this.onabort?.();
  }
}

describe('分片上传状态机（mock 网络）', () => {
  let store: Record<string, string>;
  let calls: Array<{ path: string; method: string }>;
  const originalXhr = globalThis.XMLHttpRequest;

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
    FakeXhr.sentPartNumbers = [];
    FakeXhr.active = 0;
    FakeXhr.maxConcurrent = 0;
    FakeXhr.failStatus = null;
    calls = [];
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof globalThis.XMLHttpRequest;

    vi.mocked(fetchServer).mockImplementation(async (path: string, init: RequestInit) => {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ path, method });
      if (method === 'POST' && path === '/api/projects/p1/uploads') {
        return jsonResponse({
          sessionId: 'sess-1',
          status: 'initiated',
          receivedPartNumbers: [],
        });
      }
      if (method === 'POST' && path.endsWith('/complete')) {
        return jsonResponse({
          session: { sessionId: 'sess-1', status: 'completed', receivedPartNumbers: [] },
          asset: {
            id: 'asset-1',
            projectId: 'p1',
            name: 'demo.bin',
            type: 'document',
            url: '/uploads/demo.bin',
            createdAt: '2026-08-16T00:00:00Z',
          },
          deduplicated: false,
        });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: `unexpected ${method} ${path}` }, 404);
    });
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXhr;
    vi.mocked(fetchServer).mockReset();
  });

  it('全新上传走完 init → 分片 → complete，并发受控且不误判失败', async () => {
    const phases: UploadProgress['phase'][] = [];
    const file = makeFakeFile('demo.bin', FILE_SIZE);

    const handle = startResumableUpload(file, 'p1', {
      onProgress: (progress) => phases.push(progress.phase),
    });
    const asset = await handle.promise;

    expect(asset.id).toBe('asset-1');
    // 4 个分片各传一次，且并发从未超过默认的 3。
    expect([...FakeXhr.sentPartNumbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(FakeXhr.maxConcurrent).toBeLessThanOrEqual(3);
    // init 与 complete 各恰好一次。
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/projects/p1/uploads')).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
    // 全程不得出现误判失败的 error 相位，最终 completed。
    expect(phases).not.toContain('error');
    expect(phases[phases.length - 1]).toBe('completed');
  });

  it('分片命中不可重试错误时立即失败，且不再发送后续分片', async () => {
    FakeXhr.failStatus = 400;
    const phases: UploadProgress['phase'][] = [];
    const file = makeFakeFile('demo.bin', FILE_SIZE);

    const handle = startResumableUpload(file, 'p1', {
      onProgress: (progress) => phases.push(progress.phase),
    });
    await expect(handle.promise).rejects.toThrow();
    // 等待所有已启动协程落地（部分可能在建连前被终态闸门拦下）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sent = [...FakeXhr.sentPartNumbers].sort((a, b) => a - b);
    // 第一波至多 3 个分片；失败后 pump 不再补位，第 4 片永远不发送；
    // 400 不可重试，任何分片都不得重复发送。
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent).not.toContain(TOTAL_CHUNKS);
    expect(new Set(sent).size).toBe(sent.length);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(0);
    // 失败后不得再出现非终态相位（终态门控）。
    const errorIndex = phases.indexOf('error');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(
      phases.slice(errorIndex + 1).filter((phase) => phase === 'uploading' || phase === 'hashing'),
    ).toHaveLength(0);
  });
});
