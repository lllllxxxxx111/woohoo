import { describe, it, expect } from 'vitest';
import { isAssetDeleteBlockedError, getAssetTags } from '../types';
import type { Asset, AssetDeleteBlockedError } from '../types';

// ─── getAssetTags ──────────────────────────────────────────────

describe('getAssetTags', () => {
  it('should return empty array for null/undefined metadata', () => {
    expect(getAssetTags(null)).toEqual([]);
    expect(getAssetTags(undefined)).toEqual([]);
  });

  it('should return empty array for non-object metadata', () => {
    expect(getAssetTags('string' as unknown as Asset['metadata'])).toEqual([]);
    expect(getAssetTags(123 as unknown as Asset['metadata'])).toEqual([]);
  });

  it('should return empty array when tags is missing', () => {
    expect(getAssetTags({ favorite: true })).toEqual([]);
  });

  it('should return empty array when tags is not an array', () => {
    expect(getAssetTags({ tags: 'not-an-array' })).toEqual([]);
    expect(getAssetTags({ tags: null })).toEqual([]);
  });

  it('should extract tags from metadata', () => {
    expect(getAssetTags({ tags: ['人物', '风景', '城市'] })).toEqual(['人物', '风景', '城市']);
  });

  it('should trim and filter empty tags', () => {
    expect(getAssetTags({ tags: ['  人物  ', '', '  ', '风景'] })).toEqual(['人物', '风景']);
  });

  it('should convert non-string tag values to strings', () => {
    expect(getAssetTags({ tags: ['人物', 123, null, undefined] })).toEqual(['人物', '123']);
  });

  it('should preserve other metadata fields', () => {
    const meta = { tags: ['a'], favorite: true, rating: 5, prompt: 'test' };
    const tags = getAssetTags(meta);
    expect(tags).toEqual(['a']);
    // Original object should not be modified
    expect(meta.favorite).toBe(true);
  });
});

// ─── isAssetDeleteBlockedError ────────────────────────────────

describe('isAssetDeleteBlockedError', () => {
  it('should return true for valid blocked error objects', () => {
    const err: AssetDeleteBlockedError = {
      error: '素材被引用',
      errorCode: 'ASSET_HAS_REFERENCES',
      references: [],
      referenceCount: 0,
    };
    expect(isAssetDeleteBlockedError(err)).toBe(true);
  });

  it('should return false for null/undefined', () => {
    expect(isAssetDeleteBlockedError(null)).toBe(false);
    expect(isAssetDeleteBlockedError(undefined)).toBe(false);
  });

  it('should return false for non-objects', () => {
    expect(isAssetDeleteBlockedError('string')).toBe(false);
    expect(isAssetDeleteBlockedError(123)).toBe(false);
    expect(isAssetDeleteBlockedError(true)).toBe(false);
  });

  it('should return false for objects without errorCode', () => {
    expect(isAssetDeleteBlockedError({ error: 'test' })).toBe(false);
  });

  it('should return false for objects with wrong errorCode', () => {
    expect(isAssetDeleteBlockedError({ errorCode: 'OTHER_ERROR' })).toBe(false);
  });

  it('should return false for Error instances', () => {
    expect(isAssetDeleteBlockedError(new Error('test'))).toBe(false);
  });

  it('should return true for objects with additional fields', () => {
    const err = {
      error: '被引用',
      errorCode: 'ASSET_HAS_REFERENCES' as const,
      references: [{ refType: 'storyboard', projectId: 'p1', projectName: 'P1', title: 't' }],
      referenceCount: 1,
      extraField: 'ignored',
    };
    expect(isAssetDeleteBlockedError(err)).toBe(true);
  });
});
