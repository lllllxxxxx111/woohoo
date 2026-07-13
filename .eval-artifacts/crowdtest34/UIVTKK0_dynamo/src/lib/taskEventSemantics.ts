/**
 * Task event idempotency, ordering, and state semantics for AI task SSE events.
 *
 * Provides:
 * - Status rank ordering: prevents old events from overwriting newer terminal states.
 * - Seen event ID tracking (bounded): prevents duplicate event processing.
 * - Terminal state guards: once terminal, non-terminal events are ignored.
 * - Unified boundary state messages (completed/failed/cancelled/blocked/scope_mismatch/missing).
 * - Workspace refresh deduplication.
 */

import type { AiTask, AiTaskStatus } from './serverApi';

// ─── Status Ordering ──────────────────────────────────────────────────────────

/**
 * Numeric rank for task statuses. Higher rank = later in lifecycle.
 * Used to prevent out-of-order events from regressing state.
 *
 * queued=0 < running=1 < terminal states=2 (completed/failed/cancelled)
 */
const STATUS_RANK: Record<AiTaskStatus, number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/** Terminal statuses: once reached, no going back. */
export const TERMINAL_STATUSES: ReadonlySet<AiTaskStatus> = new Set<AiTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** Non-terminal ("active") statuses that indicate the task is still in progress. */
export const ACTIVE_STATUSES: ReadonlySet<AiTaskStatus> = new Set<AiTaskStatus>(['queued', 'running']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as AiTaskStatus);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status as AiTaskStatus);
}

/**
 * Check if an incoming task update should be applied given the current known state.
 *
 * Rules:
 * - If no current state → ACCEPT (first event for this task)
 * - If current is terminal and incoming is non-terminal → REJECT (regression)
 * - If both are terminal and same status → ACCEPT (idempotent replay safe)
 * - If both are terminal but different status → REJECT (first terminal wins;
 *   out-of-order events must not flip a resolved state)
 * - If incoming seq <= current seq (when seqs available) → REJECT (stale)
 * - If current rank > incoming rank → REJECT (out of order)
 * - Otherwise → ACCEPT
 *
 * @param incomingStatus The status from the incoming event
 * @param currentStatus The currently known status (undefined if first event)
 * @param incomingSeq Optional sequence number from the incoming event
 * @param currentSeq Optional sequence number of the last applied event
 */
export function shouldApplyTaskUpdate(
  incomingStatus: AiTaskStatus,
  currentStatus: AiTaskStatus | undefined,
  incomingSeq?: number | null,
  currentSeq?: number | null,
): boolean {
  if (!currentStatus) return true;

  // If we have sequence numbers, use them for precise ordering.
  // Higher seq = definitively newer event from the server; trust it.
  if (incomingSeq != null && currentSeq != null) {
    if (incomingSeq <= currentSeq) return false; // Stale or duplicate
    return true; // Newer event wins regardless of status rank
  }

  const incomingRank = STATUS_RANK[incomingStatus] ?? 0;
  const currentRank = STATUS_RANK[currentStatus] ?? 0;

  // Both terminal (no seq available): only allow same-status replay (idempotent)
  if (isTerminalStatus(currentStatus) && isTerminalStatus(incomingStatus)) {
    return currentStatus === incomingStatus;
  }

  // Never regress from terminal to non-terminal
  if (isTerminalStatus(currentStatus) && !isTerminalStatus(incomingStatus)) {
    return false;
  }

  // Don't go backwards in rank (e.g., running after completed)
  if (currentRank > incomingRank) {
    return false;
  }

  return true;
}

// ─── Seen Event Tracker ──────────────────────────────────────────────────────

/**
 * Bounded set for tracking recently seen event IDs/keys to prevent duplicate processing.
 * Uses a simple FIFO eviction when size exceeds max.
 */
export class SeenEventTracker {
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(private maxSize: number = 1000) {}

  /**
   * Check if an event key has been seen before. If not, marks it as seen.
   * Returns true if this is a new event (should process), false if duplicate.
   */
  checkAndMark(key: string): boolean {
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  clear(): void {
    this.seen.clear();
    this.order = [];
  }

  get size(): number {
    return this.seen.size;
  }
}

// ─── Unified User-Facing Messages ────────────────────────────────────────────

export interface BoundaryStateMessage {
  /** Message content to show to the user. */
  content: string;
  /** Message role for UI rendering. */
  role: 'system' | 'ai';
  /** Message status. */
  status: 'done' | 'error';
  /** Whether workspace refresh is needed. */
  requiresRefresh: boolean;
}

/**
 * Get the user-facing message for a terminal/boundary task state.
 */
export function getBoundaryStateMessage(
  status: AiTaskStatus | 'missing' | 'scope_mismatch' | 'blocked',
  task: { error?: string | null; result?: string | null },
): BoundaryStateMessage {
  switch (status) {
    case 'completed':
      return {
        content: task.result?.trim() || '任务已完成，但没有返回内容。',
        role: 'ai',
        status: 'done',
        requiresRefresh: true,
      };
    case 'failed':
      return {
        content: `任务失败：${task.error || '未知错误，请检查网络或端点配置后重试。'}`,
        role: 'system',
        status: 'error',
        requiresRefresh: true,
      };
    case 'cancelled':
      return {
        content: `任务已取消：${task.error || '任务已被用户取消。'}`,
        role: 'system',
        status: 'error',
        requiresRefresh: false,
      };
    case 'missing':
      return {
        content:
          '任务状态异常：长时间未收到服务端更新，可能是网络中断或服务重启导致。请检查连接后重试或重新发送任务。',
        role: 'system',
        status: 'error',
        requiresRefresh: true,
      };
    case 'scope_mismatch':
      return {
        content: '任务返回的会话作用域异常，已拒绝回写到当前对话。请刷新页面后重试。',
        role: 'system',
        status: 'error',
        requiresRefresh: false,
      };
    case 'blocked':
      return {
        content: `任务阻塞：${task.error || '前置条件未满足，请检查工作流状态。'}`,
        role: 'system',
        status: 'error',
        requiresRefresh: false,
      };
    default:
      return {
        content: `任务状态异常：${String(status)}`,
        role: 'system',
        status: 'error',
        requiresRefresh: false,
      };
  }
}

// ─── Workspace Refresh Deduplication ─────────────────────────────────────────

/**
 * Deduplicates workspace refresh calls within a debounce window.
 * Prevents concurrent refresh storms from multiple terminal events
 * arriving in quick succession.
 */
export class RefreshDeduplicator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private inFlight = false;
  private pendingWhileInFlight = false;

  constructor(
    private refreshFn: () => Promise<void>,
    private debounceMs: number = 300,
  ) {}

  schedule(): void {
    if (this.inFlight) {
      // A refresh is in progress — mark that another is needed when it finishes.
      // Don't start a parallel timer; the in-flight completion will re-schedule.
      this.pendingWhileInFlight = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.timer = setTimeout(async () => {
      this.scheduled = false;
      this.timer = null;
      this.inFlight = true;
      try {
        await this.refreshFn();
      } catch (err) {
        console.warn('[RefreshDeduplicator] Refresh failed:', err);
      } finally {
        this.inFlight = false;
        // If events arrived during refresh, schedule one more to catch up
        if (this.pendingWhileInFlight) {
          this.pendingWhileInFlight = false;
          this.schedule();
        }
      }
    }, this.debounceMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduled = false;
    this.pendingWhileInFlight = false;
  }
}

// ─── Task Event Key Generation ───────────────────────────────────────────────

/**
 * Generate a unique key for a task event for deduplication.
 * Uses the event sequence number if available, otherwise falls back to
 * taskId + eventType + status + contentDelta hash.
 */
export function makeEventKey(
  eventType: string,
  task: AiTask,
  seq?: number | null,
  contentDelta?: string | null,
): string {
  if (seq != null) {
    return `evt_${seq}`;
  }
  // Fallback: construct from event + task fields
  const deltaHash = contentDelta ? `_${simpleHash(contentDelta)}` : '';
  return `evt_${task.id}_${eventType}_${task.status}${deltaHash}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
