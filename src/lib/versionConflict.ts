/**
 * 版本并发冲突（HTTP 409 + errorCode=VERSION_CONFLICT）的前端模型与辅助逻辑。
 *
 * 设计要点：
 *   - 冲突时绝不丢弃本地草稿；由 UI 决定“加载服务器最新版 / 复制草稿”等安全动作。
 *   - 该模块为纯逻辑，可在 vitest（node 环境）中直接测试。
 */

export const VERSION_CONFLICT_CODE = 'VERSION_CONFLICT';

export class VersionConflictError extends Error {
  readonly code = VERSION_CONFLICT_CODE;
  readonly baseVersion: number | null;
  readonly currentVersion: number;
  readonly currentVersionId: string | null;
  readonly currentContentHash: string | null;

  constructor(payload: Record<string, unknown>) {
    const message =
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : '内容已被他人更新，发生版本冲突';
    super(message);
    this.name = 'VersionConflictError';
    this.baseVersion = typeof payload.baseVersion === 'number' ? payload.baseVersion : null;
    this.currentVersion = typeof payload.currentVersion === 'number' ? payload.currentVersion : 0;
    this.currentVersionId =
      typeof payload.currentVersionId === 'string' ? payload.currentVersionId : null;
    this.currentContentHash =
      typeof payload.currentContentHash === 'string' ? payload.currentContentHash : null;
  }
}

export function isVersionConflictError(error: unknown): error is VersionConflictError {
  return error instanceof VersionConflictError;
}

/** 若负载是版本冲突则构造错误，否则返回 null */
export function extractVersionConflict(payload: unknown): VersionConflictError | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.errorCode !== VERSION_CONFLICT_CODE) {
    return null;
  }
  return new VersionConflictError(record);
}

/** 冲突 UI 状态：保留草稿，仅记录服务器当前版本以供安全恢复 */
export interface SaveConflictState {
  /** 服务器当前最新版本（草稿所基于的版本已过期） */
  currentVersion: number;
  /** 草稿所基于的版本（可能为 null，例如旧客户端未携带） */
  baseVersion: number | null;
}

export function toConflictState(error: VersionConflictError): SaveConflictState {
  return {
    currentVersion: error.currentVersion,
    baseVersion: error.baseVersion,
  };
}

/**
 * 冲突解决策略：无论选择哪种动作，本地草稿都原样保留，绝不被丢弃。
 * 返回传入的草稿本身，调用方可据此复制 / 重新合并。
 */
export function preserveDraft<T>(draft: T): T {
  return draft;
}

/** 判断是否应在恢复/加载最新版前提示用户先复制草稿 */
export function shouldPromptCopyDraft(draft: string): boolean {
  return draft.trim().length > 0;
}

/** 用户在冲突弹窗中可选择的动作 */
export type ConflictResolutionAction = 'keep_draft' | 'copy_draft' | 'load_server_latest';

/** 冲突期间的编辑器状态：草稿始终保留，仅显式加载最新版才会替换 */
export interface DraftConflictState<Draft> {
  /** 本地未保存草稿（冲突期间绝不丢弃） */
  draft: Draft;
  /** 冲突信息；null 表示无冲突 */
  conflict: SaveConflictState | null;
}

/**
 * 冲突状态机的纯函数实现（与 ScriptEditor / StoryboardArea 的行为一致）：
 *   - keep_draft / copy_draft：草稿原样保留，冲突提示保留；
 *   - load_server_latest：仅当成功拿到服务器最新内容时才替换草稿并清除冲突；
 *     若拉取失败（serverLatest 为 null），草稿必须保留，绝不置空。
 *
 * 该函数保证：任何动作都不会把草稿悄悄丢掉。
 */
export function applyConflictResolution<Draft>(
  state: DraftConflictState<Draft>,
  action: ConflictResolutionAction,
  serverLatest: Draft | null,
): DraftConflictState<Draft> {
  switch (action) {
    case 'keep_draft':
    case 'copy_draft':
      return { draft: state.draft, conflict: state.conflict };
    case 'load_server_latest':
      if (serverLatest === null) {
        // 拉取失败：保留草稿与冲突提示，绝不丢弃草稿
        return { draft: state.draft, conflict: state.conflict };
      }
      return { draft: serverLatest, conflict: null };
    default:
      return { draft: state.draft, conflict: state.conflict };
  }
}

