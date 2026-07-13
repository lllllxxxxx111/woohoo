/**
 * Task event ordering, idempotency, and state transition rules.
 *
 * This module defines:
 * - The precedence order of task states (so old events don't override new terminal states)
 * - Event deduplication by sequence number / event ID
 * - Terminal state stickiness (completed/failed/cancelled/blocked can't be overwritten by non-terminal states)
 * - Safe handling of repeated terminal events
 */

import type { AiTask, AiTaskStatus } from './serverApi';

/**
 * Extended task statuses that include edge-case states from the frontend perspective.
 * The backend uses 'queued' | 'running' | 'completed' | 'failed'.
 * The frontend adds 'missing' and 'scope_mismatch' for UI-level error states.
 */
export type UiTaskStatus = AiTaskStatus | 'missing' | 'scope_mismatch' | 'blocked' | 'cancelled';

/**
 * State precedence: higher number = higher priority.
 * When processing events out of order, a higher-precedence state
 * cannot be overwritten by a lower-precedence one.
 */
const STATE_PRECEDENCE: Record<UiTaskStatus, number> = {
  queued: 1,
  running: 2,
  blocked: 3,
  missing: 4,
  scope_mismatch: 4,
  completed: 5,
  failed: 5,
  cancelled: 5,
};

/** Terminal states that cannot be overwritten by non-terminal states. */
export const TERMINAL_STATES: ReadonlySet<UiTaskStatus> = new Set<UiTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'missing',
  'scope_mismatch',
]);

/**
 * Check if a status is a terminal state.
 */
export function isTerminalState(status: string): status is UiTaskStatus {
  return TERMINAL_STATES.has(status as UiTaskStatus);
}

/**
 * Determine if an incoming event state should be applied given the current state.
 *
 * Rules:
 * 1. Terminal states are sticky — they cannot be overwritten by non-terminal states.
 * 2. Higher-precedence states always win over lower-precedence states.
 * 3. Same precedence (e.g., completed vs failed): the incoming event wins
 *    (allows correcting failed->completed if there was a race).
 * 4. If the incoming event has a lower or equal sequence and the current state
 *    is terminal, the incoming event is discarded.
 *
 * @returns true if the incoming state should be applied
 */
export function shouldApplyState(
  currentStatus: UiTaskStatus | undefined,
  incomingStatus: UiTaskStatus,
  currentSeq?: number,
  incomingSeq?: number
): boolean {
  // No current state — always apply
  if (!currentStatus) return true;

  // If we have sequence numbers and the incoming event is older or same-seq, skip
  if (currentSeq !== undefined && incomingSeq !== undefined && incomingSeq <= currentSeq) {
    // Exception: same-seq terminal-to-terminal replay is safe (idempotent re-application)
    if (
      incomingSeq === currentSeq &&
      isTerminalState(incomingStatus) &&
      isTerminalState(currentStatus)
    ) {
      return true;
    }
    // Otherwise, older or equal seq events are rejected
    return false;
  }

  // Current is terminal and incoming is not terminal — never apply
  if (isTerminalState(currentStatus) && !isTerminalState(incomingStatus)) {
    return false;
  }

  // Current is not terminal — any incoming state can apply (including terminal)
  if (!isTerminalState(currentStatus)) {
    return true;
  }

  // Both are terminal — allow (incoming wins, e.g. cancelled vs failed)
  return true;
}

/**
 * Get the precedence rank for a state.
 */
export function statePrecedence(status: UiTaskStatus): number {
  return STATE_PRECEDENCE[status] ?? 0;
}

/**
 * Event deduplication tracker. Tracks seen event IDs/sequence numbers per task
 * to avoid processing the same event twice.
 */
export class EventDedupTracker {
  private seenEvents = new Map<string, Set<string>>();
  private maxSeqs = new Map<string, number>();

  /**
   * Check if an event has already been processed.
   * Returns true if the event is new (should be processed).
   * Returns false if the event is a duplicate.
   */
  markAndCheck(taskId: string, eventId: string | null, eventSeq?: number): boolean {
    const key = taskId;

    // Check sequence number first
    if (eventSeq !== undefined) {
      const currentMax = this.maxSeqs.get(key) ?? -1;
      if (eventSeq <= currentMax) {
        // Already seen or older
        return false;
      }
      this.maxSeqs.set(key, eventSeq);
    }

    // Check event ID
    if (eventId) {
      let seenSet = this.seenEvents.get(key);
      if (!seenSet) {
        seenSet = new Set();
        this.seenEvents.set(key, seenSet);
      }
      if (seenSet.has(eventId)) {
        return false;
      }
      seenSet.add(eventId);

      // Prevent unbounded growth — trim seen set
      if (seenSet.size > 1000) {
        const ids = Array.from(seenSet);
        seenSet.clear();
        for (const id of ids.slice(-500)) {
          seenSet.add(id);
        }
      }
    }

    return true;
  }

  /** Get the highest seen sequence number for a task. */
  getMaxSeq(taskId: string): number | undefined {
    return this.maxSeqs.get(taskId);
  }

  /** Clear tracking for a task (e.g., after it reaches terminal state). */
  clearTask(taskId: string): void {
    this.seenEvents.delete(taskId);
    this.maxSeqs.delete(taskId);
  }

  /** Clear all tracking. */
  clear(): void {
    this.seenEvents.clear();
    this.maxSeqs.clear();
  }
}

/**
 * User-facing error messages for edge-case states.
 * These provide actionable feedback instead of silent failures.
 */
export const STATE_USER_MESSAGES: Record<string, { title: string; message: string; action?: string }> = {
  missing: {
    title: '任务状态丢失',
    message: '任务在网络断开期间状态未知，已尝试重新同步但未能恢复。你可以重新发送消息或检查网络连接。',
    action: '重新发送',
  },
  scope_mismatch: {
    title: '任务范围不匹配',
    message: '该任务不属于当前对话或项目范围，可能已在其他会话中处理。',
    action: undefined,
  },
  completed: {
    title: '已完成',
    message: '',
  },
  cancelled: {
    title: '已取消',
    message: '任务已被取消。',
    action: '重新发送',
  },
  blocked: {
    title: '任务阻塞',
    message: '任务因依赖未满足或配置问题被阻塞，请检查端点配置后重试。',
    action: '查看设置',
  },
  failed: {
    title: '任务失败',
    message: '任务执行遇到错误，请检查网络和端点配置后重试。',
    action: '重试',
  },
};

/**
 * Normalize a backend AiTaskStatus to a UiTaskStatus.
 * The backend uses 'failed' for cancellations; we map based on error content.
 */
export function normalizeUiStatus(task: AiTask): UiTaskStatus {
  const status = task.status as UiTaskStatus;
  if (status === 'failed' && task.error) {
    if (task.error.includes('取消') || task.error.includes('cancelled')) {
      return 'cancelled';
    }
  }
  return status;
}
