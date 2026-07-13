/**
 * Shared state semantics for AI tasks.
 *
 * Defines:
 * - Terminal states that must not be overwritten by earlier states
 * - State ordering for out-of-order event protection
 * - Unified user-facing messages for all boundary states
 * - Idempotency key helpers
 */

import type { AiTask, AiTaskStatus } from './serverApi';
import type { MessageMeta } from '../types';

/** Terminal task states - once reached, no earlier state can overwrite */
export const TERMINAL_TASK_STATUSES = new Set<AiTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'blocked',
]);

/** Non-terminal task states that can transition */
export const NON_TERMINAL_TASK_STATUSES = new Set<AiTaskStatus>([
  'queued',
  'running',
]);

/** Status precedence (higher number = more final) */
export const STATUS_PRECEDENCE: Record<AiTaskStatus, number> = {
  queued: 0,
  running: 1,
  completed: 10,
  failed: 10,
  cancelled: 10,
  blocked: 10,
};

/**
 * Check if a task status is terminal.
 */
export function isTerminalStatus(status: AiTaskStatus | string): boolean {
  return TERMINAL_TASK_STATUSES.has(status as AiTaskStatus);
}

/**
 * Determine if a new event should be applied given the current task state.
 * Prevents:
 * - Old queued/running events from overwriting a terminal state
 * - Content deltas being applied after terminal state
 * - Duplicate events from creating duplicate effects
 */
export function shouldApplyTaskEvent(
  currentStatus: AiTaskStatus | string | undefined,
  newStatus: AiTaskStatus | string,
  currentFinishedAt: number | null | undefined,
  newFinishedAt: number | null | undefined,
): boolean {
  // If no current status, always apply
  if (!currentStatus) return true;

  const currentPrec = STATUS_PRECEDENCE[currentStatus as AiTaskStatus] ?? -1;
  const newPrec = STATUS_PRECEDENCE[newStatus as AiTaskStatus] ?? -1;

  // Terminal states always win over non-terminal
  if (newPrec > currentPrec) return true;

  // If same precedence (both terminal), the later finishedAt wins
  if (newPrec === currentPrec && newPrec >= 10) {
    if (newFinishedAt && currentFinishedAt) {
      return newFinishedAt >= currentFinishedAt;
    }
    return true; // If no timestamps, allow (idempotent terminal)
  }

  // Non-terminal after non-terminal: allow (e.g., queued -> running)
  if (newPrec >= currentPrec) return true;

  // Lower precedence (e.g., queued after completed): reject
  return false;
}

/**
 * User-facing messages for terminal and error states.
 */
export const TASK_STATE_MESSAGES = {
  completed: { prefix: '', role: 'ai' as const },
  failed: { prefix: '任务失败：', role: 'system' as const },
  cancelled: { prefix: '任务已取消：', role: 'system' as const },
  blocked: { prefix: '任务被阻塞：', role: 'system' as const },
  missing: { prefix: '任务状态丢失：长时间未收到服务端更新，请检查连接后重试。', role: 'system' as const },
  scope_mismatch: { prefix: '任务返回的会话作用域异常，已拒绝回写到当前对话。', role: 'system' as const },
  resync_failed: { prefix: '连接恢复后同步失败，请刷新页面重试。', role: 'system' as const },
} as const;

/**
 * Get the user-facing content for a terminal task state.
 */
export function formatTerminalTaskContent(
  task: Pick<AiTask, 'status' | 'result' | 'error'>,
): { content: string; role: 'ai' | 'system' } {
  const msg = TASK_STATE_MESSAGES[task.status as keyof typeof TASK_STATE_MESSAGES];
  if (!msg) {
    return { content: task.result ?? '', role: 'ai' };
  }

  if (task.status === 'completed') {
    return {
      content: task.result?.trim() || '任务已完成，但没有返回内容。',
      role: 'ai',
    };
  }

  const errorText = task.error || '未知错误';
  return {
    content: `${msg.prefix}${errorText}`,
    role: msg.role,
  };
}

/**
 * Check if a message's meta indicates a terminal task state.
 */
export function isTerminalMetaTaskStatus(meta: MessageMeta | undefined): boolean {
  const status = meta?.taskStatus;
  if (!status) return false;
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'missing' ||
    status === 'scope_mismatch'
  );
}

/**
 * Generate an idempotency key for a task event to prevent duplicate processing.
 */
export function makeTaskEventKey(taskId: string, eventType: string, seq?: number | string): string {
  if (seq !== undefined && seq !== null) {
    return `${taskId}:${eventType}:${seq}`;
  }
  return `${taskId}:${eventType}`;
}

/**
 * Maximum age of a seen event key before it can be evicted (prevents unbounded memory growth).
 */
export const SEEN_EVENT_KEY_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Simple LRU-like set for tracking seen event IDs with TTL eviction.
 */
export class SeenEventTracker {
  private seen = new Map<string, number>();

  /** Returns true if this is the first time seeing this key */
  checkAndAdd(key: string): boolean {
    const now = Date.now();
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, now);
    return true;
  }

  /** Check without adding */
  has(key: string): boolean {
    return this.seen.has(key);
  }

  /** Evict entries older than TTL */
  evictStale(ttlMs: number = SEEN_EVENT_KEY_TTL_MS): void {
    const cutoff = Date.now() - ttlMs;
    const staleKeys: string[] = [];
    this.seen.forEach((timestamp, key) => {
      if (timestamp < cutoff) staleKeys.push(key);
    });
    for (const key of staleKeys) {
      this.seen.delete(key);
    }
  }

  /** Clear all entries for a specific task */
  clearTask(taskId: string): void {
    const prefix = `${taskId}:`;
    const toDelete: string[] = [];
    this.seen.forEach((_timestamp, key) => {
      if (key.startsWith(prefix)) toDelete.push(key);
    });
    for (const key of toDelete) {
      this.seen.delete(key);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Threshold for marking a task as missing after disconnect + resync failure.
 * Only mark missing if:
 * 1. We've been disconnected for longer than MISSING_TASK_GRACE_PERIOD_MS, AND
 * 2. An explicit resync attempt has failed, OR
 * 3. No event has been received for MISSING_TASK_TIMEOUT_MS total
 */
export const MISSING_TASK_TIMEOUT_MS = 120_000; // 2 minutes without any event
export const MISSING_TASK_GRACE_PERIOD_MS = 30_000; // 30 seconds grace after disconnect before considering missing
