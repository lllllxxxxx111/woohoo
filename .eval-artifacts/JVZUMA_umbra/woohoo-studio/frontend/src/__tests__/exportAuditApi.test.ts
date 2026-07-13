import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordExportAudit,
  getExportAuditLogs,
  type ExportAuditRecord,
} from '../serverApi';

const HASH = 'a'.repeat(64); // 64 hex chars = valid SHA-256

describe('Export audit API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('recordExportAudit POSTs camelCase JSON to /api/exports/audit', async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: 'rec-1',
          userId: 'anon',
          projectId: 'p1',
          exportType: 'full',
          manifestHash: HASH,
          assetCount: 3,
          missingAssetCount: 1,
          totalSizeBytes: 12345,
          createdAt: '2025-01-01T00:00:00Z',
        } satisfies ExportAuditRecord),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await recordExportAudit({
      projectId: 'p1',
      exportType: 'full',
      manifestHash: HASH,
      assetCount: 3,
      missingAssetCount: 1,
      totalSizeBytes: 12345,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captured[0].url).toBe('/api/exports/audit');
    expect(captured[0].init.method).toBe('POST');
    expect(captured[0].init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(captured[0].init.body as string);
    // CamelCase keys (matches backend's serde rename_all = "camelCase")
    expect(body).toEqual({
      projectId: 'p1',
      exportType: 'full',
      manifestHash: HASH,
      assetCount: 3,
      missingAssetCount: 1,
      totalSizeBytes: 12345,
    });
    // Response is parsed camelCase
    expect(result.id).toBe('rec-1');
    expect(result.manifestHash).toBe(HASH);
    expect(result.assetCount).toBe(3);
  });

  it('recordExportAudit throws on non-ok response', async () => {
    const fetchMock = vi.fn(async () => new Response('bad hash', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      recordExportAudit({
        projectId: 'p1',
        exportType: 'full',
        manifestHash: 'not-a-valid-hash',
        assetCount: 0,
        missingAssetCount: 0,
        totalSizeBytes: 0,
      }),
    ).rejects.toThrow(/API 400/);
  });

  it('getExportAuditLogs GETs /api/projects/:id/exports and parses camelCase', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('/api/projects/p1/exports');
      return new Response(
        JSON.stringify([
          {
            id: 'r1', userId: 'u1', projectId: 'p1', exportType: 'full',
            manifestHash: HASH, assetCount: 2, missingAssetCount: 0,
            totalSizeBytes: 999, schemaVersion: '1.0.0',
            createdAt: '2025-01-01T00:00:00Z',
          },
          {
            id: 'r2', userId: 'u1', projectId: 'p1', exportType: 'core',
            manifestHash: 'b'.repeat(64), assetCount: 0, missingAssetCount: 0,
            totalSizeBytes: 500,
            createdAt: '2024-01-01T00:00:00Z',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const logs = await getExportAuditLogs('p1');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      id: 'r1', exportType: 'full', manifestHash: HASH,
      assetCount: 2, totalSizeBytes: 999,
    });
    // All numeric fields present and numeric
    for (const r of logs) {
      expect(typeof r.assetCount).toBe('number');
      expect(typeof r.missingAssetCount).toBe('number');
      expect(typeof r.totalSizeBytes).toBe('number');
      expect(typeof r.createdAt).toBe('string');
      expect(r.manifestHash).toMatch(/^[0-9a-fA-F]{64}$/);
    }
  });

  it('getExportAuditLogs returns empty array when there are no records', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = await getExportAuditLogs('new-project');
    expect(logs).toEqual([]);
  });
});
