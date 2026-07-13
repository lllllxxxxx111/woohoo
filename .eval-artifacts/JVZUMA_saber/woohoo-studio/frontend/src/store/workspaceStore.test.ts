// Tests for workspace store: export history loading

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListByProject, mockListRecent, mockRecord, mockGetProject } = vi.hoisted(() => ({
  mockListByProject: vi.fn(),
  mockListRecent: vi.fn(),
  mockRecord: vi.fn(),
  mockGetProject: vi.fn(),
}));

vi.mock('../api/serverApi', () => ({
  serverApi: {
    exportAudit: {
      record: mockRecord,
      listByProject: mockListByProject,
      listRecent: mockListRecent,
    },
    projects: {
      get: mockGetProject,
    },
  },
}));

vi.mock('zustand', () => {
  return {
    create: (initializer: any) => {
      let state: any = {};
      const setState = (patch: any) => {
        if (typeof patch === 'function') state = { ...state, ...patch(state) };
        else state = { ...state, ...patch };
      };
      const getState = () => state;
      state = initializer(setState, getState, { setState, getState });
      const hook: any = () => state;
      hook.getState = getState;
      hook.setState = setState;
      return hook;
    },
  };
});

import { useWorkspaceStore } from '../store/workspaceStore';
import type { ExportAuditLog } from '../types';

function makeAudit(overrides: Partial<ExportAuditLog> = {}): ExportAuditLog {
  return {
    id: 'audit-1',
    userId: 'u1',
    projectId: 'p1',
    exportType: 'full',
    manifestHash: 'a'.repeat(64),
    assetCount: 5,
    missingAssetCount: 1,
    fileCount: 12,
    totalSizeBytes: 1024,
    blockingIssuesOverride: false,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('workspaceStore export history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = useWorkspaceStore as any;
    store.setState({
      currentProject: null,
      scripts: [],
      storyboards: [],
      keyframes: [],
      videoPlans: [],
      assets: [],
      exportHistory: [],
      exportHistoryLoading: false,
    });
  });

  it('addExportAudit prepends to history and caps at 50', () => {
    const store = useWorkspaceStore as any;
    store.getState().addExportAudit(makeAudit({ id: 'a1' }));
    store.getState().addExportAudit(makeAudit({ id: 'a2' }));
    expect(store.getState().exportHistory).toHaveLength(2);
    expect(store.getState().exportHistory[0].id).toBe('a2');

    for (let i = 0; i < 50; i++) {
      store.getState().addExportAudit(makeAudit({ id: `b${i}` }));
    }
    expect(store.getState().exportHistory.length).toBeLessThanOrEqual(50);
  });

  it('refreshExportHistory pulls from serverApi and updates state', async () => {
    const audits = [makeAudit({ id: 's1' }), makeAudit({ id: 's2', exportType: 'core' })];
    mockListByProject.mockResolvedValue(audits);

    const store = useWorkspaceStore as any;
    store.setState({ currentProject: { id: 'p1', name: 'P', userId: 'u1', createdAt: '', updatedAt: '' } });

    await store.getState().refreshExportHistory();

    expect(mockListByProject).toHaveBeenCalledWith('p1');
    expect(store.getState().exportHistory).toHaveLength(2);
    expect(store.getState().exportHistory[0].exportType).toBe('full');
    expect(store.getState().exportHistory[1].exportType).toBe('core');
    expect(store.getState().exportHistoryLoading).toBe(false);
  });

  it('refreshExportHistory is no-op when no project loaded', async () => {
    const store = useWorkspaceStore as any;
    store.setState({ currentProject: null });
    await store.getState().refreshExportHistory();
    expect(mockListByProject).not.toHaveBeenCalled();
  });

  it('refreshExportHistory handles API failure gracefully (preserves existing history)', async () => {
    mockListByProject.mockRejectedValue(new Error('network down'));
    const store = useWorkspaceStore as any;
    store.setState({ currentProject: { id: 'p1', name: 'P', userId: 'u1', createdAt: '', updatedAt: '' } });
    store.setState({ exportHistory: [makeAudit({ id: 'existing' })] });

    await store.getState().refreshExportHistory();

    expect(store.getState().exportHistoryLoading).toBe(false);
    expect(store.getState().exportHistory).toHaveLength(1);
    expect(store.getState().exportHistory[0].id).toBe('existing');
  });

  it('setProject triggers refreshExportHistory', async () => {
    const audits = [makeAudit({ id: 'auto' })];
    mockListByProject.mockResolvedValue(audits);
    const store = useWorkspaceStore as any;

    store.getState().setProject({ id: 'p2', name: 'My Project', userId: 'u1', createdAt: '', updatedAt: '' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockListByProject).toHaveBeenCalledWith('p2');
    expect(store.getState().exportHistory[0].id).toBe('auto');
  });

  it('setExportHistory replaces the entire history', () => {
    const store = useWorkspaceStore as any;
    const list = [makeAudit({ id: 'r1' }), makeAudit({ id: 'r2' })];
    store.getState().setExportHistory(list);
    expect(store.getState().exportHistory).toHaveLength(2);
    expect(store.getState().exportHistory[1].id).toBe('r2');
  });
});
