import { describe, it, expect } from 'vitest';
import {
  formatExportSummary,
  formatExportSummaryShort,
  validateExportFilename,
  validateManifestHash,
  buildCountsSummary,
} from '../utils/exportSummary';

const SAMPLE_HASH = 'a'.repeat(64); // valid 64-char hex

describe('formatExportSummary', () => {
  it('formats a full success message with short hash prefix, assets, missing', () => {
    const msg = formatExportSummary({
      filename: 'demo-full.zip',
      manifestHash: SAMPLE_HASH,
      assetCount: 10,
      missingCount: 2,
    });
    expect(msg).toContain('demo-full.zip');
    expect(msg).toContain('Manifest:');
    expect(msg).toContain('aaaaaaaaaaaa...'); // 12 chars
    expect(msg).toContain('Assets: 10');
    expect(msg).toContain('Missing: 2');
  });

  it('defaults to 12-char hash prefix', () => {
    const msg = formatExportSummary({
      filename: 'f.zip',
      manifestHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      assetCount: 0,
      missingCount: 0,
    });
    expect(msg).toContain('0123456789ab...');
    expect(msg).not.toContain('cdef');
  });

  it('respects custom hashPrefixLength', () => {
    const msg = formatExportSummary({
      filename: 'f.zip',
      manifestHash: SAMPLE_HASH,
      assetCount: 0,
      missingCount: 0,
      hashPrefixLength: 7,
    });
    expect(msg).toContain('aaaaaaa...');
  });

  it('shows "(no hash)" when manifestHash is empty', () => {
    const msg = formatExportSummary({
      filename: 'f.zip',
      manifestHash: '',
      assetCount: 0,
      missingCount: 0,
    });
    expect(msg).toContain('(no hash)');
    expect(msg).not.toContain('...');
  });

  it('handles hashes shorter than prefix length without crash', () => {
    const msg = formatExportSummary({
      filename: 'f.zip',
      manifestHash: 'abcd',
      assetCount: 1,
      missingCount: 0,
    });
    expect(msg).toContain('abcd...');
  });

  it('handles zero asset/missing counts', () => {
    const msg = formatExportSummary({
      filename: 'core.zip',
      manifestHash: SAMPLE_HASH,
      assetCount: 0,
      missingCount: 0,
    });
    expect(msg).toContain('Assets: 0');
    expect(msg).toContain('Missing: 0');
  });
});

describe('formatExportSummaryShort', () => {
  it('returns a single-line summary without hash', () => {
    const s = formatExportSummaryShort({
      filename: 'demo.zip',
      manifestHash: SAMPLE_HASH,
      assetCount: 5,
      missingCount: 1,
    });
    expect(s).toBe('demo.zip (5 assets, 1 missing)');
    expect(s).not.toContain('\n');
    expect(s).not.toContain('Manifest');
  });

  it('handles zero counts', () => {
    const s = formatExportSummaryShort({
      filename: 'core.zip', manifestHash: '', assetCount: 0, missingCount: 0,
    });
    expect(s).toBe('core.zip (0 assets, 0 missing)');
  });
});

describe('validateExportFilename', () => {
  it('accepts a normal .zip filename', () => {
    expect(validateExportFilename('demo-full.zip')).toBeNull();
    expect(validateExportFilename('my_project (1).zip')).toBeNull();
    expect(validateExportFilename('a.zip')).toBeNull();
  });

  it('rejects empty filename', () => {
    expect(validateExportFilename('')).not.toBeNull();
    expect(validateExportFilename('   ')).not.toBeNull();
  });

  it('rejects missing .zip extension', () => {
    expect(validateExportFilename('demo')).not.toBeNull();
    expect(validateExportFilename('demo.tar.gz')).not.toBeNull();
  });

  it('rejects invalid path characters', () => {
    for (const bad of ['a/b.zip', 'a\\b.zip', 'a:b.zip', 'a*b.zip', 'a?b.zip', 'a"b.zip', 'a<b.zip', 'a>b.zip', 'a|b.zip']) {
      expect(validateExportFilename(bad)).not.toBeNull();
    }
  });

  it('rejects overly long filenames', () => {
    const long = 'a'.repeat(260) + '.zip';
    expect(validateExportFilename(long)).not.toBeNull();
  });
});

describe('validateManifestHash', () => {
  it('accepts valid 64-char lowercase hex (SHA-256 output)', () => {
    expect(validateManifestHash(SAMPLE_HASH)).toBe(true);
    expect(validateManifestHash('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('accepts empty string (not-yet-computed hash allowed)', () => {
    expect(validateManifestHash('')).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(validateManifestHash('abc')).toBe(false);
    expect(validateManifestHash(SAMPLE_HASH + 'a')).toBe(false);
    expect(validateManifestHash(SAMPLE_HASH.slice(1))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const invalid = SAMPLE_HASH.substring(0, 63) + 'g';
    expect(validateManifestHash(invalid)).toBe(false);
  });

  it('rejects uppercase hex (we normalise to lowercase)', () => {
    const upper = SAMPLE_HASH.toUpperCase();
    expect(validateManifestHash(upper)).toBe(false);
  });
});

describe('buildCountsSummary', () => {
  it('fills missing fields with zero', () => {
    const s = buildCountsSummary({});
    expect(s).toEqual({
      scripts: 0, storyboards: 0, keyframes: 0, videoPlans: 0,
      assets: 0, packagedAssets: 0, missingAssets: 0, files: 0,
    });
  });

  it('passes through supplied counts', () => {
    const s = buildCountsSummary({
      scripts: 3, storyboards: 2, keyframes: 8, videoPlans: 1,
      assets: 12, packagedAssets: 10, missingAssets: 2, files: 7,
    });
    expect(s.scripts).toBe(3);
    expect(s.packagedAssets).toBe(10);
    expect(s.missingAssets).toBe(2);
    expect(s.files).toBe(7);
  });

  it('returns a new plain object (no mutation)', () => {
    const input = { scripts: 1 };
    const s1 = buildCountsSummary(input);
    const s2 = buildCountsSummary(input);
    expect(s1).not.toBe(s2);
    expect(s1).toEqual(s2);
  });
});
