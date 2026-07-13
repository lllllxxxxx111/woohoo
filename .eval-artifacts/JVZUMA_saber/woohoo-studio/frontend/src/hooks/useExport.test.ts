// Tests for the success toast content format (filename + hash + asset count + missing count)
// We verify the formatting logic extracted from useExport hook without mounting React.

import { describe, it, expect } from 'vitest';

// Replicate the exact toast-message formatting from hooks/useExport.ts so we can
// unit-test it without rendering. If you change the hook, update this too.
function formatSuccessToast(params: {
  bundleFilename: string;
  manifestHashPrefix: string;
  packedAssetCount: number;
  missingAssetCount: number;
  fileCount: number;
}): string {
  const { bundleFilename, manifestHashPrefix, packedAssetCount, missingAssetCount, fileCount } = params;
  const missingTxt = missingAssetCount > 0 ? `, ${missingAssetCount} missing` : '';
  return `${bundleFilename}\nHash: ${manifestHashPrefix}... | ${packedAssetCount} assets packed${missingTxt} | ${fileCount} files`;
}

describe('success toast format', () => {
  it('includes filename on first line', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'My_Project_full_2024-01-01T12-00-00.zip',
      manifestHashPrefix: 'abcdef123456',
      packedAssetCount: 5,
      missingAssetCount: 0,
      fileCount: 12,
    });
    expect(msg.startsWith('My_Project_full_2024-01-01T12-00-00.zip')).toBe(true);
  });

  it('shows manifest hash prefix', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'x.zip',
      manifestHashPrefix: 'deadbeefcafe',
      packedAssetCount: 0,
      missingAssetCount: 0,
      fileCount: 3,
    });
    expect(msg).toContain('Hash: deadbeefcafe...');
  });

  it('shows packed asset count', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'x.zip',
      manifestHashPrefix: 'aa',
      packedAssetCount: 42,
      missingAssetCount: 0,
      fileCount: 10,
    });
    expect(msg).toContain('42 assets packed');
  });

  it('shows missing count when there are missing assets', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'x.zip',
      manifestHashPrefix: 'bb',
      packedAssetCount: 3,
      missingAssetCount: 2,
      fileCount: 8,
    });
    expect(msg).toContain('2 missing');
  });

  it('omits missing clause when zero missing', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'x.zip',
      manifestHashPrefix: 'cc',
      packedAssetCount: 3,
      missingAssetCount: 0,
      fileCount: 8,
    });
    expect(msg).not.toContain('missing');
  });

  it('shows total file count', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'x.zip',
      manifestHashPrefix: 'dd',
      packedAssetCount: 1,
      missingAssetCount: 1,
      fileCount: 27,
    });
    expect(msg).toContain('| 27 files');
  });

  it('full bundle: all fields rendered together', () => {
    const msg = formatSuccessToast({
      bundleFilename: 'Demo_full_2024-06-01T10-00-00.zip',
      manifestHashPrefix: '09f59e62591c',
      packedAssetCount: 7,
      missingAssetCount: 1,
      fileCount: 19,
    });
    expect(msg).toBe(
      'Demo_full_2024-06-01T10-00-00.zip\n' +
      'Hash: 09f59e62591c... | 7 assets packed, 1 missing | 19 files'
    );
  });
});
