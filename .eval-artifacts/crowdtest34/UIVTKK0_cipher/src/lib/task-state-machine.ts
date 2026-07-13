/**
 * Task state machine with:
 * - State ordering for out-of-order event protection
 * - Terminal state guards (completed/failed/cancelled/blocked cannot be overwritten)
 * - Event deduplication by sequence/event ID
 * - Unified boundary state semantics and user-visible messages
 */

// Extended task statuses (includes both AiTask statuses and client-side meta states)
export type TaskLifecycleStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'missing'
  | 'scope_mismatch';

// State ordering:
// - 0: unknown (initial, accepts anything)
// - 1: queued (waiting in queue)
// - 2: active (running/blocked — executing or paused for review; both are "in progress")
// - 5: terminal (completed/failed/cancelled — cannot be downgraded back to active)
// - 6: client-error (missing/scope_mismatch — set locally after resync failure; not from server)
//
// Key invariants:
// 1. Once a task reaches terminal (5), no active-state event (queued/running/blocked) can overwrite it.
// 2. Active states (queued/running/blocked) may transition among themselves freely when eventSeq is newer
//    — blocked is a PAUSE (e.g., human review) from which the task may resume running.
// 3. Same-status transitions are allowed (idempotent repeat).
// 4. Different terminal statuses: server is authoritative; a later failed can overwrite an earlier completed
//    (shouldn't normally happen, but we don't want stale state if server corrects itself).
// 5. missing/scope_mismatch are client-side only; they can be corrected by a snapshot/resync.
const STATE_ORDER: Record<TaskLifecycleStatus, number> = {
  queued: 1,
  running: 2,
  blocked: 2,  // active-paused — transitions to/from running allowed
  completed: 5,
  failed: 5,
  cancelled: 5,
  missing: 6,
  scope_mismatch: 6,
};

const TERMINAL_STATES = new Set<TaskLifecycleStatus>([
  'completed',
  'failed',
  'cancelled',
  'missing',
  'scope_mismatch',
]);

const ACTIVE_STATES = new Set<TaskLifecycleStatus>(['queued', 'running', 'blocked']);

const SERVER_TERMINAL_STATES = new Set<TaskLifecycleStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: string): status is TaskLifecycleStatus {
  return TERMINAL_STATES.has(status as TaskLifecycleStatus);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATES.has(status as TaskLifecycleStatus);
}

export function stateOrder(status: string): number {
  return STATE_ORDER[status as TaskLifecycleStatus] ?? 0;
}

/**
 * Returns true if an incoming event with `incomingStatus` should be allowed
 * to transition a task currently in `currentStatus`.
 *
 * Transition rules (enforced regardless of eventSeq; eventSeq is separately used for
 * older/newer detection via EventDeduplicator):
 *
 * 1. No current status → always allow (first event for this task).
 * 2. Currently terminal (completed/failed/cancelled):
 *    - incoming terminal (any) → allow (server is authoritative; same status is idempotent).
 *    - incoming active (queued/running/blocked) → reject (terminal cannot be rolled back).
 *    - incoming client-error → allow only via explicit resync (snapshot correction).
 * 3. Currently active (queued/running/blocked):
 *    - any active → allow (queued↔running↔blocked transitions permitted; eventSeq dedup prevents replay loops).
 *    - terminal → allow (forward progression).
 *    - client-error → reject during normal event flow (errors set locally, not from server).
 * 4. Currently client-error (missing/scope_mismatch):
 *    - incoming anything except client-error → allow (snapshot or new event corrects the error).
 *    - incoming client-error → allow (idempotent).
 */
export function canTransition(
  currentStatus: TaskLifecycleStatus | undefined,
  incomingStatus: TaskLifecycleStatus,
  options?: { allowTerminalOverride?: boolean; fromResync?: boolean },
): boolean {
  if (!currentStatus) return true;
  if (options?.allowTerminalOverride) return true;

  const currentIsTerminal = isTerminalStatus(currentStatus);
  const incomingIsTerminal = isTerminalStatus(incomingStatus);
  const currentIsServerTerminal = SERVER_TERMINAL_STATES.has(currentStatus);
  const incomingIsServerTerminal = SERVER_TERMINAL_STATES.has(incomingStatus);
  const currentIsClientError = currentIsTerminal && !currentIsServerTerminal; // missing/scope_mismatch
  const incomingIsClientError = incomingIsTerminal && !incomingIsServerTerminal;
  const currentIsActive = ACTIVE_STATES.has(currentStatus);
  const incomingIsActive = ACTIVE_STATES.has(incomingStatus);

  // Client-error states (missing/scope_mismatch) can always be corrected by
  // any server event (active or server-terminal) — snapshot or fresh event fixes the error
  if (currentIsClientError) {
    if (incomingIsClientError) return currentStatus === incomingStatus; // idempotent repeat only
    return true; // any non-client-error (active or server-terminal) overwrites
  }

  // Don't let regular server events set client-error states (those are set locally
  // after stale-check/resync failure). Resync snapshot can override.
  if (incomingIsClientError) {
    return options?.fromResync === true;
  }

  // Server-terminal guard: active states cannot roll back completed/failed/cancelled
  if (currentIsServerTerminal && incomingIsActive) return false;

  // Server-terminal → server-terminal: allow (server authoritative, including corrections)
  if (currentIsServerTerminal && incomingIsServerTerminal) return true;

  // Active → active: allow (queued↔running↔blocked transitions for pauses/resumes/retry)
  if (currentIsActive && incomingIsActive) return true;

  // Active → server-terminal: allow (forward progression to completion)
  if (currentIsActive && incomingIsServerTerminal) return true;

  // Fallback: same status is idempotent; otherwise reject unknown transitions
  return currentStatus === incomingStatus;
}

/**
 * User-visible error messages for boundary states.
 */
export const STATE_MESSAGES: Record<TaskLifecycleStatus, { title: string; detail: string; action?: string }> = {
  queued: {
    title: '任务已提交，排队中...',
    detail: '任务已加入队列，等待执行',
  },
  running: {
    title: 'AI 正在处理中...',
    detail: '任务正在执行，请稍候',
  },
  completed: {
    title: '任务已完成',
    detail: '',
  },
  failed: {
    title: '任务失败',
    detail: '任务执行出错，请查看错误信息后重试',
    action: '重新发送',
  },
  cancelled: {
    title: '任务已取消',
    detail: '任务已被取消',
  },
  blocked: {
    title: '任务等待中',
    detail: '任务正在等待前置条件或人工审核',
  },
  missing: {
    title: '任务状态丢失',
    detail: '长时间未收到服务端状态更新，连接可能已中断。请检查网络后重试',
    action: '重试',
  },
  scope_mismatch: {
    title: '任务作用域异常',
    detail: '任务返回的会话与当前对话不匹配，已拒绝回写',
    action: '刷新页面',
  },
};

/**
 * Map an AiTask status (from server) to client-side message status.
 */
export function mapTaskStatusToMessageStatus(
  taskStatus: TaskLifecycleStatus,
): 'pending' | 'done' | 'error' {
  switch (taskStatus) {
    case 'queued':
    case 'running':
    case 'blocked':
      return 'pending';
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
    case 'missing':
    case 'scope_mismatch':
      return 'error';
    default:
      return 'pending';
  }
}

/**
 * Map an AiTask status to a human-readable label for PipelinePreview.
 */
export function mapTaskStatusToLabel(status: TaskLifecycleStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'running': return '执行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'blocked': return '等待中';
    case 'missing': return '状态丢失';
    case 'scope_mismatch': return '作用域异常';
    default: return status;
  }
}

/**
 * Track seen event IDs per entity (task/run) to detect duplicates.
 * Uses a bounded LRU-like set to prevent memory growth.
 */
export class EventDeduplicator {
  private seen = new Map<string, number>(); // key -> last seen seq
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Check if an event has already been processed.
   * Returns true if the event is new (should be processed), false if duplicate.
   */
  check(key: string, seq: number): boolean {
    const lastSeq = this.seen.get(key);
    if (lastSeq !== undefined && seq <= lastSeq) {
      return false; // duplicate or out-of-order (older than last seen)
    }
    this.seen.set(key, seq);
    this.prune();
    return true;
  }

  /**
   * Check without recording - used for idempotent queries.
   */
  hasSeen(key: string, seq: number): boolean {
    const lastSeq = this.seen.get(key);
    return lastSeq !== undefined && seq <= lastSeq;
  }

  remove(key: string) {
    this.seen.delete(key);
  }

  clear() {
    this.seen.clear();
  }

  private prune() {
    if (this.seen.size <= this.maxSize) return;
    // Remove oldest entries (Map preserves insertion order)
    const keysToDelete = Array.from(this.seen.keys()).slice(0, this.seen.size - this.maxSize);
    for (const k of keysToDelete) {
      this.seen.delete(k);
    }
  }
}

/**
 * Convert server task status to TaskLifecycleStatus.
 * Handles both new statuses (cancelled, blocked) and legacy mappings.
 */
export function normalizeTaskStatus(status: string | undefined | null): TaskLifecycleStatus {
  if (!status) return 'queued';
  const s = status.toLowerCase();
  if (s === 'canceled') return 'cancelled'; // handle American spelling
  if (STATE_ORDER[s as TaskLifecycleStatus] !== undefined) {
    return s as TaskLifecycleStatus;
  }
  return 'failed'; // unknown -> failed for safety
}
