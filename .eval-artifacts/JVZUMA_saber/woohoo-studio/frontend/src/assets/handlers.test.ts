// Tests for asset handlers

import { describe, it, expect } from 'vitest';
import {
  sanitizeAssetFilename,
  detectDuplicateFilenames,
  getAssetExtension,
  isAssetUrlValid,
} from '../assets/handlers';
import type { Asset } from '../types';

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    projectId: 'p1',
    name: 'image.png',
    type: 'image',
    url: 'https://example.com/image.png',
    uploadedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('sanitizeAssetFilename', () => {
  it('replaces invalid characters', () => {
    expect(sanitizeAssetFilename('my file name.png')).toBe('my_file_name.png');
    expect(sanitizeAssetFilename('file<name>.png')).toBe('file_name_.png');
    expect(sanitizeAssetFilename('path/to/file.png')).toBe('path_to_file.png');
  });

  it('collapses multiple underscores', () => {
    expect(sanitizeAssetFilename('a   b   c.png')).toBe('a_b_c.png');
  });

  it('removes leading/trailing underscores', () => {
    expect(sanitizeAssetFilename('_test_.png')).toBe('test_.png');
  });
});

describe('detectDuplicateFilenames', () => {
  it('finds duplicates', () => {
    const assets = [
      makeAsset({ id: 'a1', name: 'image.png' }),
      makeAsset({ id: 'a2', name: 'image.png' }),
    ];
    const dups = detectDuplicateFilenames(assets);
    expect(dups).toContain('image.png');
  });

  it('returns empty for unique names', () => {
    const assets = [
      makeAsset({ id: 'a1', name: 'image1.png' }),
      makeAsset({ id: 'a2', name: 'image2.png' }),
    ];
    expect(detectDuplicateFilenames(assets)).toHaveLength(0);
  });
});

describe('getAssetExtension', () => {
  it('extracts known extensions', () => {
    expect(getAssetExtension('image.png', 'image')).toBe('png');
    expect(getAssetExtension('video.mp4', 'video')).toBe('mp4');
    expect(getAssetExtension('audio.mp3', 'audio')).toBe('mp3');
  });

  it('falls back to type-based extension', () => {
    expect(getAssetExtension('unknownfile', 'image')).toBe('png');
    expect(getAssetExtension('unknownfile', 'video')).toBe('mp4');
    expect(getAssetExtension('unknownfile', 'audio')).toBe('mp3');
    expect(getAssetExtension('unknownfile', 'document')).toBe('txt');
    expect(getAssetExtension('unknownfile', 'other')).toBe('bin');
  });
});

describe('isAssetUrlValid', () => {
  it('accepts http/https URLs', () => {
    expect(isAssetUrlValid('http://example.com/a.png')).toBe(true);
    expect(isAssetUrlValid('https://example.com/a.png')).toBe(true);
  });

  it('accepts relative paths', () => {
    expect(isAssetUrlValid('/api/assets/123/download')).toBe(true);
  });

  it('accepts blob URLs', () => {
    expect(isAssetUrlValid('blob:http://localhost/uuid')).toBe(true);
  });

  it('rejects empty URLs', () => {
    expect(isAssetUrlValid('')).toBe(false);
  });

  it('rejects garbage strings', () => {
    expect(isAssetUrlValid('not a url at all')).toBe(false);
  });
});
