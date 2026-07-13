// Tests for asset handlers and filename utilities
import { describe, it, expect } from 'vitest';
import { sanitizeFilename, detectDuplicateFilenames, getAssetPathInZip } from '../assets/handlers';
import type { Asset } from '../types';

describe('asset handlers', () => {
  describe('sanitizeFilename', () => {
    it('removes invalid characters', () => {
      expect(sanitizeFilename('file<name>.txt')).toBe('file_name_.txt');
      expect(sanitizeFilename('path/to/file')).toBe('path_to_file');
      expect(sanitizeFilename('file:name?')).toBe('file_name_');
      expect(sanitizeFilename('file|name*')).toBe('file_name_');
    });

    it('replaces spaces with underscores', () => {
      expect(sanitizeFilename('my file name.png')).toBe('my_file_name.png');
    });

    it('handles already-safe names', () => {
      expect(sanitizeFilename('normal-file.png')).toBe('normal-file.png');
    });

    it('handles control characters', () => {
      const withControl = 'file\x00name\x01.txt';
      expect(sanitizeFilename(withControl)).toBe('file_name_.txt');
    });
  });

  describe('detectDuplicateFilenames', () => {
    it('returns empty map for no duplicates', () => {
      const assets: Asset[] = [
        { id: 'a1', projectId: 'p1', name: 'a.png', type: 'image', url: 'u1', createdAt: '' },
        { id: 'a2', projectId: 'p1', name: 'b.png', type: 'image', url: 'u2', createdAt: '' },
      ];
      const dupes = detectDuplicateFilenames(assets);
      expect(dupes.size).toBe(0);
    });

    it('detects duplicate filenames', () => {
      const assets: Asset[] = [
        { id: 'a1', projectId: 'p1', name: 'image.png', type: 'image', url: 'u1', createdAt: '' },
        { id: 'a2', projectId: 'p1', name: 'image.png', type: 'image', url: 'u2', createdAt: '' },
        { id: 'a3', projectId: 'p1', name: 'image.png', type: 'image', url: 'u3', createdAt: '' },
      ];
      const dupes = detectDuplicateFilenames(assets);
      expect(dupes.size).toBe(1);
      const dupeList = dupes.get('image.png');
      expect(dupeList).toBeDefined();
      expect(dupeList!).toHaveLength(3);
    });

    it('treats sanitized names as the basis for comparison', () => {
      const assets: Asset[] = [
        { id: 'a1', projectId: 'p1', name: 'my file.png', type: 'image', url: 'u1', createdAt: '' },
        { id: 'a2', projectId: 'p1', name: 'my_file.png', type: 'image', url: 'u2', createdAt: '' },
      ];
      const dupes = detectDuplicateFilenames(assets);
      // After sanitization both become my_file.png
      expect(dupes.size).toBe(1);
    });
  });

  describe('getAssetPathInZip', () => {
    it('places assets in type-prefixed directory', () => {
      const asset: Asset = {
        id: 'a1', projectId: 'p1', name: 'photo.png', type: 'image', url: 'u', createdAt: '',
      };
      const path = getAssetPathInZip(asset);
      expect(path).toBe('assets/image/photo.png');
    });

    it('handles audio type', () => {
      const asset: Asset = {
        id: 'a1', projectId: 'p1', name: 'bgm.mp3', type: 'audio', url: 'u', createdAt: '',
      };
      expect(getAssetPathInZip(asset)).toBe('assets/audio/bgm.mp3');
    });
  });
});
