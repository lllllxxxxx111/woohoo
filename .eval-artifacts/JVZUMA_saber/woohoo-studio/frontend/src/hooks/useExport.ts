// useExport hook - manages export flow: preflight, confirmation, export, toast

import { useCallback, useState } from 'react';
import { useWorkspaceStore } from '../store/workspaceStore';
import { exportFullProjectBundle, exportCoreProjectBundle, runPreflightChecks } from '../export';
import type { ExportType, ExportResult, PreflightResult, ExportOptions } from '../types';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  content: string;
}

export interface ExportState {
  isExporting: boolean;
  stage: string;
  progress: number;
  progressTotal: number;
  progressLabel?: string;
  preflightResult: PreflightResult | null;
  lastExportResult: ExportResult | null;
  showPreflightModal: boolean;
  pendingExportType: ExportType | null;
  pendingOptions: Partial<ExportOptions> | null;
  toasts: ToastMessage[];
}

export function useExport() {
  const [state, setState] = useState<ExportState>({
    isExporting: false,
    stage: '',
    progress: 0,
    progressTotal: 0,
    preflightResult: null,
    lastExportResult: null,
    showPreflightModal: false,
    pendingExportType: null,
    pendingOptions: null,
    toasts: [],
  });

  const currentProject = useWorkspaceStore(s => s.currentProject);
  const scripts = useWorkspaceStore(s => s.scripts);
  const storyboards = useWorkspaceStore(s => s.storyboards);
  const keyframes = useWorkspaceStore(s => s.keyframes);
  const videoPlans = useWorkspaceStore(s => s.videoPlans);
  const assets = useWorkspaceStore(s => s.assets);
  const addExportAudit = useWorkspaceStore(s => s.addExportAudit);

  const showToast = useCallback((type: ToastMessage['type'], title: string, content: string) => {
    const id = Math.random().toString(36).slice(2);
    const toast: ToastMessage = { id, type, title, content };
    setState(s => ({ ...s, toasts: [...s.toasts, toast] }));
    // Auto-remove after 6 seconds
    setTimeout(() => {
      setState(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }));
    }, 6000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setState(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }));
  }, []);

  const initiateExport = useCallback((type: ExportType, options?: Partial<ExportOptions>) => {
    if (!currentProject) {
      showToast('error', 'No project', 'No project is currently open');
      return;
    }

    // Always run preflight first
    const preflight = runPreflightChecks(
      currentProject,
      scripts,
      storyboards,
      keyframes,
      videoPlans,
      assets
    );

    setState(s => ({
      ...s,
      preflightResult: preflight,
      pendingExportType: type,
      pendingOptions: options || null,
      showPreflightModal: true,
    }));
  }, [currentProject, scripts, storyboards, keyframes, videoPlans, assets, showToast]);

  const cancelPreflight = useCallback(() => {
    setState(s => ({
      ...s,
      showPreflightModal: false,
      pendingExportType: null,
      pendingOptions: null,
      preflightResult: null,
    }));
  }, []);

  const confirmExport = useCallback(async (forceBypassBlocking = false) => {
    if (!currentProject || !state.pendingExportType) return;

    setState(s => ({
      ...s,
      showPreflightModal: false,
      isExporting: true,
      stage: 'starting',
      progress: 0,
      progressTotal: 1,
    }));

    try {
      let result: ExportResult;
      const progressCb = (stage: string, done: number, total: number, label?: string) => {
        setState(s => ({ ...s, stage, progress: done, progressTotal: total, progressLabel: label }));
      };

      if (state.pendingExportType === 'full') {
        result = await exportFullProjectBundle(
          currentProject,
          scripts,
          storyboards,
          keyframes,
          videoPlans,
          assets,
          state.pendingOptions || undefined,
          progressCb,
          forceBypassBlocking
        );
      } else {
        result = await exportCoreProjectBundle(
          currentProject,
          scripts,
          storyboards,
          keyframes,
          assets,
          state.pendingOptions || undefined,
          progressCb,
          forceBypassBlocking
        );
      }

      if (!result.success) {
        // Blocking issues stopped the export (should not happen after modal confirmation but handle gracefully)
        showToast('error', 'Export blocked', 'Blocking issues prevented export.');
        setState(s => ({ ...s, isExporting: false }));
        return;
      }

      // Trigger browser download
      if (result.bundleBlob) {
        const url = URL.createObjectURL(result.bundleBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.bundleFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Update store with audit entry
      addExportAudit({
        id: Math.random().toString(36).slice(2),
        userId: currentProject.userId,
        projectId: currentProject.id,
        exportType: result.manifest.exportType,
        manifestHash: result.manifestHash,
        assetCount: result.packedAssetCount,
        missingAssetCount: result.missingAssetCount,
        fileCount: result.manifest.counts.files,
        totalSizeBytes: result.bundleBlob?.size ?? 0,
        blockingIssuesOverride: forceBypassBlocking,
        createdAt: result.manifest.exportedAt,
      });

      // Success toast: filename, manifest hash, asset count, missing count
      const missingTxt = result.missingAssetCount > 0
        ? `, ${result.missingAssetCount} missing`
        : '';
      showToast(
        'success',
        'Export complete',
        `${result.bundleFilename}\nHash: ${result.manifestHash.slice(0, 12)}... | ${result.packedAssetCount} assets packed${missingTxt} | ${result.manifest.counts.files} files`
      );

      setState(s => ({
        ...s,
        isExporting: false,
        lastExportResult: result,
        pendingExportType: null,
        pendingOptions: null,
      }));
    } catch (err) {
      showToast(
        'error',
        'Export failed',
        err instanceof Error ? err.message : String(err)
      );
      setState(s => ({ ...s, isExporting: false }));
    }
  }, [currentProject, state.pendingExportType, state.pendingOptions, scripts, storyboards, keyframes, videoPlans, assets, addExportAudit, showToast]);

  return {
    ...state,
    initiateExport,
    confirmExport,
    cancelPreflight,
    dismissToast,
    showToast,
  };
}
