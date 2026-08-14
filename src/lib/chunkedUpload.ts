/**
 * 统一的大文件分片上传客户端。
 *
 * 能力：
 * - 上传前流式计算全文件 SHA-256（内存占用 = 一个分片，不缓冲整个文件）
 * - init / status / upload-part / complete / abort 五段协议
 * - XMLHttpRequest 真实字节进度（不是定时器动画）
 * - 暂停 / 继续 / 取消、失败分片指数退避重试、受控并发
 * - 刷新后凭 localStorage 中的会话描述符续传（不保存 File 或文件内容）
 *
 * 协议响应类型与后端 `server/src/asset/upload_session.rs` 严格对应。
 */

import { Sha256 } from './sha256';
import { ensureServerSession, fetchServer, getServerBaseUrl } from './serverApi';
import { logger } from './logger';

/* ───────────────────── 协议常量（与后端一致） ───────────────────── */

export const CHUNK_UPLOAD_CONSTRAINTS = {
  minChunkSize: 64 * 1024,
  maxChunkSize: 8 * 1024 * 1024,
  defaultChunkSize: 4 * 1024 * 1024,
  maxTotalChunks: 10_000,
} as const;

export type UploadPhase =
  | 'hashing'
  | 'uploading'
  | 'finalizing'
  | 'completed'
  | 'aborted'
  | 'error';

export interface ChunkPlan {
  chunkSize: number;
  totalChunks: number;
}

/**
 * 纯函数：按文件大小规划分片。
 * preferred 会被夹在协议允许区间内；分片过多时自动放大分片大小。
 */
export function planChunks(
  fileSize: number,
  preferred: number = CHUNK_UPLOAD_CONSTRAINTS.defaultChunkSize,
): ChunkPlan {
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error('文件大小无效');
  }
  const { minChunkSize, maxChunkSize, maxTotalChunks } = CHUNK_UPLOAD_CONSTRAINTS;
  // 小文件不浪费：分片大小不超过文件本身，但仍受协议下限约束。
  let chunkSize = Math.min(
    maxChunkSize,
    Math.max(minChunkSize, Math.min(Math.floor(preferred), Math.ceil(fileSize))),
  );

  let totalChunks = Math.ceil(fileSize / chunkSize);
  if (totalChunks > maxTotalChunks) {
    chunkSize = Math.min(
      maxChunkSize,
      Math.max(minChunkSize, Math.ceil(fileSize / maxTotalChunks)),
    );
    totalChunks = Math.ceil(fileSize / chunkSize);
    if (totalChunks > maxTotalChunks) {
      throw new Error('文件过大，超过最大分片数量限制');
    }
  }
  return { chunkSize, totalChunks };
}

/* ───────────────────── 协议类型 ───────────────────── */

export interface UploadSessionState {
  sessionId: string;
  projectId: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  status: 'initiated' | 'uploading' | 'completed' | 'aborted' | 'expired' | 'failed';
  bytesReceived: number;
  receivedPartNumbers: number[];
  assetId?: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface PartAck {
  sessionId: string;
  partNumber: number;
  sizeBytes: number;
  bytesReceived: number;
  receivedPartNumbers: number[];
}

export interface UploadedAsset {
  id: string;
  projectId: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'document';
  url: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string;
}

export interface CompleteUploadResponse {
  session: UploadSessionState;
  asset: UploadedAsset;
  deduplicated: boolean;
}

/* ───────────────────── 真实进度 ───────────────────── */

export interface UploadProgress {
  phase: UploadPhase;
  bytesHashed: number;
  hashingPercent: number;
  bytesUploaded: number;
  bytesInFlight: number;
  bytesTotal: number;
  /** 已确认 + 在途字节占比，四舍五入到 0.1%，永远基于真实字节 */
  percent: number;
  failedAttempts: number;
  message?: string;
}

/** 纯函数：真实字节进度。in-flight 字节计入但不允许超过总量。 */
export function computeUploadPercent(
  bytesUploaded: number,
  bytesInFlight: number,
  bytesTotal: number,
): number {
  if (bytesTotal <= 0) return 0;
  const counted = Math.min(bytesTotal, bytesUploaded + bytesInFlight);
  return Math.round((counted / bytesTotal) * 1000) / 10;
}

/* ───────────────────── 续传描述符（绝不存文件内容） ───────────────────── */

export interface ResumeRecord {
  sessionId: string;
  projectId: string;
  filename: string;
  fileSize: number;
  fileSha256: string;
  chunkSize: number;
  totalChunks: number;
  updatedAt: number;
}

const RESUME_STORAGE_KEY = 'woohoo-upload-resume-v1';
const RESUME_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function getStorage(): Storage | null {
  const holder = globalThis as { localStorage?: Storage; window?: { localStorage?: Storage } };
  return holder.localStorage ?? holder.window?.localStorage ?? null;
}

function readResumeRecords(): ResumeRecord[] {
  try {
    const raw = getStorage()?.getItem(RESUME_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ResumeRecord =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ResumeRecord).sessionId === 'string',
    );
  } catch {
    return [];
  }
}

function writeResumeRecords(records: ResumeRecord[]): void {
  try {
    getStorage()?.setItem(RESUME_STORAGE_KEY, JSON.stringify(records));
  } catch {
    // localStorage 不可用时续传降级为不可用，不影响本次上传。
  }
}

export function listResumableUploads(projectId?: string): ResumeRecord[] {
  const cutoff = Date.now() - RESUME_MAX_AGE_MS;
  return readResumeRecords()
    .filter((record) => record.updatedAt >= cutoff)
    .filter((record) => !projectId || record.projectId === projectId);
}

export function findResumableUpload(
  projectId: string,
  file: Pick<File, 'name' | 'size'>,
  excludedSessionIds: ReadonlySet<string> = new Set(),
): ResumeRecord | undefined {
  return listResumableUploads(projectId)
    .filter((record) => !excludedSessionIds.has(record.sessionId))
    .filter((record) => record.filename === file.name && record.fileSize === file.size)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

export function removeResumableUpload(sessionId: string): void {
  writeResumeRecords(readResumeRecords().filter((r) => r.sessionId !== sessionId));
}

function saveResumeRecord(record: ResumeRecord): void {
  const records = readResumeRecords().filter((r) => r.sessionId !== record.sessionId);
  records.push(record);
  writeResumeRecords(records);
}

/* ───────────────────── 上传控制 ───────────────────── */

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  partConcurrency?: number;
  maxPartAttempts?: number;
  /** 续传：既有会话 ID（localStorage 描述符中的 sessionId） */
  resumeSessionId?: string;
  /** 自动匹配描述符时，若文件指纹不一致则丢弃旧描述符并创建新会话。 */
  resumeFallbackToNewOnMismatch?: boolean;
}

export interface UploadHandle {
  promise: Promise<UploadedAsset>;
  pause: () => void;
  resume: () => void;
  abort: () => Promise<void>;
  sessionId: () => string | null;
}

class UploadAbortedError extends Error {
  constructor() {
    super('上传已取消');
    this.name = 'UploadAbortedError';
  }
}

class UploadRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadRequestError';
  }
}

function createClientToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function hashFileSha256(
  file: File,
  chunkSize: number,
  onProgress: (bytesHashed: number) => void,
): Promise<string> {
  const hasher = new Sha256();
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset = end;
    onProgress(offset);
  }
  return hasher.digestHex();
}

async function hashPartSha256(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // 复制到独占 ArrayBuffer，规避 SharedArrayBuffer 类型不兼容。
    const owned = new Uint8Array(bytes.length);
    owned.set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', owned);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return new Sha256().update(bytes).digestHex();
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const session = await ensureServerSession(false);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.token}`);
  let response = await fetchServer(path, { ...init, headers });
  if (response.status === 401) {
    const refreshed = await ensureServerSession(true);
    const retryHeaders = new Headers(headers);
    retryHeaders.set('Authorization', `Bearer ${refreshed.token}`);
    response = await fetchServer(path, { ...init, headers: retryHeaders }, true);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `上传请求失败 (${response.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text;
    }
    throw new UploadRequestError(message, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * 启动一个可暂停/继续/取消的分片上传。
 */
export function startResumableUpload(
  file: File,
  projectId: string,
  options: UploadOptions = {},
): UploadHandle {
  const onProgress = options.onProgress ?? (() => {});
  const concurrency = Math.max(1, options.partConcurrency ?? 3);
  const maxPartAttempts = Math.max(1, options.maxPartAttempts ?? 3);

  let sessionId: string | null = options.resumeSessionId ?? null;
  let paused = false;
  let aborted = false;
  let settled = false;
  let resolvePromise!: (asset: UploadedAsset) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<UploadedAsset>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  // 真实字节账本。
  let bytesUploaded = 0;
  let bytesHashedValue = 0;
  let failedAttempts = 0;
  const inFlightLoaded = new Map<number, number>();
  const activeXhrs = new Set<XMLHttpRequest>();
  const pendingParts: number[] = [];
  const completedParts = new Set<number>();
  let plan: ChunkPlan;
  let fileSha256 = '';
  let waitResolvers: Array<() => void> = [];

  function emit(phase: UploadPhase, message?: string): void {
    const bytesInFlight = Array.from(inFlightLoaded.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    try {
      onProgress({
        phase,
        bytesHashed: phase === 'hashing' ? bytesHashedValue : file.size,
        hashingPercent: file.size ? Math.round((bytesHashedValue / file.size) * 1000) / 10 : 0,
        bytesUploaded,
        bytesInFlight,
        bytesTotal: file.size,
        percent:
          phase === 'hashing' ? 0 : computeUploadPercent(bytesUploaded, bytesInFlight, file.size),
        failedAttempts,
        message,
      });
    } catch (error) {
      // UI 回调属于观察者，不能反向打断上传状态机或让 promise 悬空。
      logger.warn('上传进度回调执行失败（上传仍继续）', error);
    }
  }

  function fail(error: Error): void {
    if (settled || aborted) return;
    settled = true;
    emit('error', error.message);
    rejectPromise(error);
  }

  function succeed(asset: UploadedAsset): void {
    if (settled || aborted) return;
    settled = true;
    bytesUploaded = file.size;
    inFlightLoaded.clear();
    if (sessionId) removeResumableUpload(sessionId);
    emit('completed');
    resolvePromise(asset);
  }

  function wakeWaiters(): void {
    const waiters = waitResolvers;
    waitResolvers = [];
    waiters.forEach((resolve) => resolve());
  }

  async function waitIfPaused(): Promise<void> {
    if (!paused || aborted) return;
    await new Promise<void>((resolve) => waitResolvers.push(resolve));
  }

  function pump(): void {
    if (aborted || settled) return;
    while (!paused && inFlightLoaded.size < concurrency) {
      const partNumber = pendingParts.shift();
      if (partNumber === undefined) break;
      void uploadPartWithRetries(partNumber);
    }
    maybeFinish();
  }

  function maybeFinish(): void {
    if (aborted || settled || paused) return;
    if (pendingParts.length === 0 && inFlightLoaded.size === 0) {
      if (completedParts.size === plan.totalChunks) {
        void complete();
      } else if (completedParts.size < plan.totalChunks) {
        // 所有分片都尝试过但没凑齐（例如全部命中不可重试错误）→ 失败。
        fail(new Error('部分分片上传失败，请检查网络后重试'));
      }
    }
  }

  async function uploadPartWithRetries(partNumber: number): Promise<void> {
    let attempt = 0;
    while (true) {
      if (aborted) return;
      await waitIfPaused();
      if (aborted) return;

      attempt += 1;
      try {
        await uploadSinglePart(partNumber);
        completedParts.add(partNumber);
        bytesUploaded = Math.min(file.size, bytesUploaded + expectedPartSize(partNumber));
        inFlightLoaded.delete(partNumber);
        emit('uploading');
        pump();
        return;
      } catch (error) {
        inFlightLoaded.delete(partNumber);
        if (aborted) return;
        if (error instanceof UploadAbortedError) {
          // 暂停导致的中断：分片回到队列，等待 resume。
          pendingParts.push(partNumber);
          pump();
          return;
        }
        const retryable = error instanceof Error && !!(error as { retryable?: boolean }).retryable;
        if (!retryable || attempt >= maxPartAttempts) {
          pendingParts.push(partNumber);
          fail(error instanceof Error ? error : new Error('分片上传失败'));
          return;
        }
        if (error instanceof UploadRequestError && error.status === 401) {
          // 分片请求使用 XHR，不经过 apiJson 的自动刷新路径；401 时主动刷新，
          // 下一轮重试会从会话缓存读取新 token。
          try {
            await ensureServerSession(true);
          } catch (refreshError) {
            pendingParts.push(partNumber);
            fail(refreshError instanceof Error ? refreshError : new Error('上传认证刷新失败'));
            return;
          }
        }
        failedAttempts += 1;
        emit('uploading', `分片 ${partNumber} 第 ${attempt} 次重试`);
        const backoff = Math.min(15_000, 500 * 2 ** (attempt - 1)) + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  async function uploadSinglePart(partNumber: number): Promise<void> {
    if (aborted || paused) throw new UploadAbortedError();

    const start = (partNumber - 1) * plan.chunkSize;
    const end = Math.min(start + plan.chunkSize, file.size);
    const blob = await file.slice(start, end).arrayBuffer();
    const bytes = new Uint8Array(blob);
    const expected = expectedPartSize(partNumber);
    if (bytes.length !== expected) {
      throw Object.assign(new Error(`分片 ${partNumber} 本地大小异常`), {
        retryable: false,
      });
    }
    const partSha256 = await hashPartSha256(bytes);

    const token = await ensureServerSession(false);
    const baseUrl = await getServerBaseUrl();
    const url = `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(sessionId ?? '')}/parts/${partNumber}`;

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);
      inFlightLoaded.set(partNumber, 0);

      const cleanup = () => {
        activeXhrs.delete(xhr);
      };

      xhr.open('PUT', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token.token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Part-SHA256', partSha256);
      xhr.responseType = 'text';

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          inFlightLoaded.set(partNumber, event.loaded);
          emit('uploading');
        }
      };

      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = `分片 ${partNumber} 上传失败 (${xhr.status})`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          if (xhr.responseText) message = xhr.responseText;
        }
        const retryableStatus = [408, 425, 429, 500, 502, 503, 504].includes(xhr.status);
        reject(
          Object.assign(new UploadRequestError(message, xhr.status), {
            retryable: xhr.status === 401 || retryableStatus,
          }),
        );
      };

      xhr.onerror = () => {
        cleanup();
        // 网络层中断：可重试。
        reject(Object.assign(new Error(`分片 ${partNumber} 网络错误`), { retryable: true }));
      };

      xhr.onabort = () => {
        cleanup();
        reject(new UploadAbortedError());
      };

      xhr.send(bytes);
    });
  }

  function expectedPartSize(partNumber: number): number {
    if (partNumber >= plan.totalChunks) {
      return file.size - (plan.totalChunks - 1) * plan.chunkSize;
    }
    return plan.chunkSize;
  }

  async function complete(): Promise<void> {
    if (aborted) return;
    emit('finalizing');
    try {
      const result = await apiJson<CompleteUploadResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(sessionId ?? '')}/complete`,
        { method: 'POST' },
      );
      succeed(result.asset);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('完成上传失败'));
    }
  }

  async function run(): Promise<void> {
    try {
      plan = planChunks(file.size);
      bytesHashedValue = 0;
      emit('hashing');
      fileSha256 = await hashFileSha256(file, plan.chunkSize, (hashed) => {
        bytesHashedValue = hashed;
        emit('hashing');
      });

      if (aborted) return;

      let state: UploadSessionState | null = null;
      if (sessionId) {
        // 刷新后续传：重新拉取服务端状态。服务端已清理的过期描述符自动
        // 失效并创建新会话；文件不匹配则明确报错，避免续传到错误内容。
        try {
          state = await apiJson<UploadSessionState>(
            `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(sessionId)}`,
            { method: 'GET' },
          );
        } catch (error) {
          if (error instanceof UploadRequestError && error.status === 404) {
            removeResumableUpload(sessionId);
            sessionId = null;
          } else {
            throw error;
          }
        }
      }

      if (state) {
        const resumeMismatch =
          state.fileSha256 !== fileSha256 ||
          state.fileSize !== file.size ||
          state.chunkSize !== plan.chunkSize ||
          state.totalChunks !== plan.totalChunks;
        if (resumeMismatch) {
          if (options.resumeFallbackToNewOnMismatch) {
            removeResumableUpload(state.sessionId);
            sessionId = null;
            state = null;
          } else {
            throw new Error('所选文件与未完成上传的指纹或分片规划不一致');
          }
        }
      }

      if (state) {
        if (state.status === 'completed') {
          // 服务端可能已完成但浏览器在收到响应前刷新；complete 是幂等的。
          await complete();
          return;
        }
        if (state.status !== 'initiated' && state.status !== 'uploading') {
          removeResumableUpload(state.sessionId);
          sessionId = null;
          state = null;
        }
      }

      if (state) {
        state.receivedPartNumbers.forEach((part) => {
          completedParts.add(part);
          bytesUploaded += expectedPartSizeFromPlan(part, plan, file.size);
        });
      }

      if (!state) {
        const state = await apiJson<UploadSessionState>(
          `/api/projects/${encodeURIComponent(projectId)}/uploads`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              fileSize: file.size,
              mimeType: file.type || 'application/octet-stream',
              chunkSize: plan.chunkSize,
              totalChunks: plan.totalChunks,
              fileSha256,
              clientToken: createClientToken(),
            }),
          },
        );
        sessionId = state.sessionId;
      }

      // 仅保存会话描述符（无 File、无内容）。
      if (sessionId) {
        saveResumeRecord({
          sessionId,
          projectId,
          filename: file.name,
          fileSize: file.size,
          fileSha256,
          chunkSize: plan.chunkSize,
          totalChunks: plan.totalChunks,
          updatedAt: Date.now(),
        });
      }

      for (let part = 1; part <= plan.totalChunks; part += 1) {
        if (!completedParts.has(part)) pendingParts.push(part);
      }

      emit('uploading');
      pump();
    } catch (error) {
      fail(error instanceof Error ? error : new Error('上传初始化失败'));
    }
  }

  // 让调用方先拿到 UploadHandle，再开始触发进度回调。这样 UI 可以在回调中
  // 安全地保存 handle，也避免同步校验失败在 promise 监听器挂载前发生。
  queueMicrotask(() => {
    void run();
  });

  return {
    promise,
    pause: () => {
      if (aborted || settled) return;
      paused = true;
      // 中止所有在途请求：暂停不丢进度，分片回到队列在 resume 时重传。
      activeXhrs.forEach((xhr) => xhr.abort());
      emit('uploading', '已暂停');
    },
    resume: () => {
      if (aborted || settled || !paused) return;
      paused = false;
      wakeWaiters();
      pump();
    },
    abort: async () => {
      if (aborted || settled) return;
      aborted = true;
      paused = false;
      wakeWaiters();
      activeXhrs.forEach((xhr) => xhr.abort());
      const id = sessionId;
      if (id) {
        removeResumableUpload(id);
        try {
          await apiJson(
            `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
          );
        } catch (error) {
          logger.warn('取消上传会话失败（不影响本地状态）', error);
        }
      }
      settled = true;
      emit('aborted');
      rejectPromise(new UploadAbortedError());
    },
    sessionId: () => sessionId,
  };
}

function expectedPartSizeFromPlan(part: number, plan: ChunkPlan, fileSize: number): number {
  if (part >= plan.totalChunks) {
    return fileSize - (plan.totalChunks - 1) * plan.chunkSize;
  }
  return plan.chunkSize;
}

/**
 * Promise 风格的简化封装：一次性上传单个文件。
 * 供聊天附件等不需要暂停 UI 的场景复用同一客户端。
 */
export function uploadFileResumable(
  file: File,
  projectId: string,
  options: { onProgress?: (progress: UploadProgress) => void } = {},
): Promise<UploadedAsset> {
  return startResumableUpload(file, projectId, {
    onProgress: options.onProgress,
  }).promise;
}
