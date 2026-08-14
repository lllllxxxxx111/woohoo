import { describe, expect, it } from 'vitest';
import {
  VersionConflictError,
  VERSION_CONFLICT_CODE,
  applyConflictResolution,
  extractVersionConflict,
  isVersionConflictError,
  preserveDraft,
  shouldPromptCopyDraft,
  toConflictState,
  type DraftConflictState,
} from './versionConflict';

describe('VersionConflictError', () => {
  it('从结构化 409 负载解析冲突信息', () => {
    const payload = {
      success: false,
      error: '内容已被更新到 v3',
      statusCode: 409,
      errorCode: VERSION_CONFLICT_CODE,
      baseVersion: 1,
      currentVersion: 3,
      currentVersionId: 'version-id-3',
      currentContentHash: 'hash-3',
    };
    const error = new VersionConflictError(payload);
    expect(error.name).toBe('VersionConflictError');
    expect(error.code).toBe(VERSION_CONFLICT_CODE);
    expect(error.baseVersion).toBe(1);
    expect(error.currentVersion).toBe(3);
    expect(error.currentVersionId).toBe('version-id-3');
    expect(error.currentContentHash).toBe('hash-3');
    expect(error.message).toContain('v3');
  });

  it('缺少字段时使用安全默认值', () => {
    const error = new VersionConflictError({});
    expect(error.baseVersion).toBeNull();
    expect(error.currentVersion).toBe(0);
    expect(error.currentVersionId).toBeNull();
    expect(error.message).toBeTruthy();
  });
});

describe('isVersionConflictError', () => {
  it('只识别 VersionConflictError 实例', () => {
    expect(isVersionConflictError(new VersionConflictError({ currentVersion: 2 }))).toBe(true);
    expect(isVersionConflictError(new Error('boom'))).toBe(false);
    expect(isVersionConflictError(null)).toBe(false);
    expect(isVersionConflictError(undefined)).toBe(false);
    expect(isVersionConflictError({ code: VERSION_CONFLICT_CODE })).toBe(false);
  });
});

describe('extractVersionConflict', () => {
  it('从带 VERSION_CONFLICT errorCode 的负载构造错误', () => {
    const error = extractVersionConflict({
      errorCode: VERSION_CONFLICT_CODE,
      currentVersion: 5,
      baseVersion: 2,
    });
    expect(error).not.toBeNull();
    expect(error?.currentVersion).toBe(5);
    expect(error?.baseVersion).toBe(2);
  });

  it('非冲突负载返回 null', () => {
    expect(extractVersionConflict({ errorCode: 'NOT_FOUND' })).toBeNull();
    expect(extractVersionConflict(null)).toBeNull();
    expect(extractVersionConflict('oops')).toBeNull();
    expect(extractVersionConflict({})).toBeNull();
  });
});

describe('冲突状态与草稿保护', () => {
  it('toConflictState 提取服务器当前版本与基线版本', () => {
    const error = new VersionConflictError({ currentVersion: 4, baseVersion: 2 });
    const state = toConflictState(error);
    expect(state.currentVersion).toBe(4);
    expect(state.baseVersion).toBe(2);
  });

  it('preserveDraft 绝不丢弃本地草稿（原样返回）', () => {
    const draft = '用户未保存的剧本草稿';
    expect(preserveDraft(draft)).toBe(draft);
    const lines = [{ id: 'l1', description: '镜头' }];
    expect(preserveDraft(lines)).toBe(lines);
  });

  it('shouldPromptCopyDraft 仅在草稿非空时提示复制', () => {
    expect(shouldPromptCopyDraft('有内容的草稿')).toBe(true);
    expect(shouldPromptCopyDraft('   ')).toBe(false);
    expect(shouldPromptCopyDraft('')).toBe(false);
  });
});

describe('applyConflictResolution（冲突状态机，草稿绝不丢弃）', () => {
  const conflict = { currentVersion: 5, baseVersion: 2 };
  const initial: DraftConflictState<string> = { draft: '我的未保存草稿', conflict };

  it('keep_draft：保留草稿与冲突提示', () => {
    const next = applyConflictResolution(initial, 'keep_draft', null);
    expect(next.draft).toBe('我的未保存草稿');
    expect(next.conflict).toEqual(conflict);
  });

  it('copy_draft：复制动作不改变草稿，也不清除冲突', () => {
    const next = applyConflictResolution(initial, 'copy_draft', null);
    expect(next.draft).toBe('我的未保存草稿');
    expect(next.conflict).toEqual(conflict);
  });

  it('load_server_latest：成功拿到服务器内容时替换草稿并清除冲突', () => {
    const next = applyConflictResolution(initial, 'load_server_latest', '服务器最新内容');
    expect(next.draft).toBe('服务器最新内容');
    expect(next.conflict).toBeNull();
  });

  it('load_server_latest：拉取失败（null）时绝不丢弃草稿', () => {
    const next = applyConflictResolution(initial, 'load_server_latest', null);
    expect(next.draft).toBe('我的未保存草稿');
    expect(next.conflict).toEqual(conflict);
  });

  it('对结构化草稿（分镜行数组）同样保证不丢弃', () => {
    const draftLines = [{ id: 'l1', description: '镜头一' }];
    const state: DraftConflictState<typeof draftLines> = { draft: draftLines, conflict };
    const kept = applyConflictResolution(state, 'keep_draft', null);
    expect(kept.draft).toBe(draftLines);
    const failed = applyConflictResolution(state, 'load_server_latest', null);
    expect(failed.draft).toBe(draftLines);
  });
});
