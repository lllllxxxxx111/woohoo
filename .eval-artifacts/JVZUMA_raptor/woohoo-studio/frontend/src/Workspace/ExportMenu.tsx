// ExportMenu - export dropdown with preflight integration
import React, { useState, useCallback } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useExportStore } from '../stores/exportStore';
import { runPreflightChecks, runPreflightChecksWithProbe } from '../utils/exportPreflight';
import { DEFAULT_EXPORT_OPTIONS, CORE_EXPORT_OPTIONS } from '../workspaceMvp/exportUtils';
import {
  exportFullProjectBundleEnhanced,
  exportCoreProjectBundleEnhanced,
  triggerDownload,
} from '../workspaceMvp/enhancedExport';
import { getExportAuditLogs } from '../serverApi';
import { formatExportSummary } from '../utils/exportSummary';
import { ExportPreflightDialog } from '../components/ExportPreflightDialog';
import { ExportHistoryPanel } from '../components/ExportHistoryPanel';

type PendingExport = 'full' | 'core' | null;

export const ExportMenu: React.FC = () => {
  const { currentProject, scripts, storyboards, keyframes, videoPlans, assets } = useWorkspaceStore();
  const {
    setExporting, setProgress, setLastExportResult,
    setPreflightIssues, setShowPreflightDialog,
    setExportHistory,
  } = useExportStore();

  const [showHistory, setShowHistory] = useState(false);
  const [pendingExport, setPendingExport] = useState<PendingExport>(null);
  const [isProbing, setIsProbing] = useState(false);

  const handleExportFull = useCallback(async () => {
    if (!currentProject) return;

    // Run fast sync preflight checks first
    const preflight = runPreflightChecks({
      project: currentProject,
      scripts,
      storyboards,
      keyframes,
      videoPlans,
      assets,
      options: DEFAULT_EXPORT_OPTIONS,
    });

    setPreflightIssues(preflight.issues);
    setPendingExport('full');

    // Blocking issues require user confirmation
    if (preflight.blockingCount > 0) {
      setShowPreflightDialog(true);
      return;
    }

    // If there are warnings, show dialog and let user confirm
    if (preflight.warningCount > 0) {
      setShowPreflightDialog(true);
      return;
    }

    // If no warnings but assets are present, run async reachability probe
    if (assets.length > 0) {
      setIsProbing(true);
      try {
        const deepResult = await runPreflightChecksWithProbe({
          project: currentProject, scripts, storyboards, keyframes, videoPlans, assets,
          options: DEFAULT_EXPORT_OPTIONS,
        });
        setPreflightIssues(deepResult.issues);
        if (deepResult.warningCount > 0 || deepResult.blockingCount > 0) {
          setShowPreflightDialog(true);
          setIsProbing(false);
          return;
        }
      } catch {
        // Probe failure should not block export
      }
      setIsProbing(false);
    }

    await doExportFull();
  }, [currentProject, scripts, storyboards, keyframes, videoPlans, assets]);

  const handleExportCore = useCallback(async () => {
    if (!currentProject) return;

    const preflight = runPreflightChecks({
      project: currentProject,
      scripts,
      storyboards,
      keyframes: [],
      videoPlans: [],
      assets: [],
      options: CORE_EXPORT_OPTIONS,
    });

    setPreflightIssues(preflight.issues);
    setPendingExport('core');

    if (preflight.blockingCount > 0 || preflight.warningCount > 0) {
      setShowPreflightDialog(true);
      return;
    }

    await doExportCore();
  }, [currentProject, scripts, storyboards]);

  const doExportFull = async () => {
    if (!currentProject) return;
    setExporting(true);
    setShowPreflightDialog(false);
    setIsProbing(false);

    try {
      const result = await exportFullProjectBundleEnhanced(
        currentProject, scripts, storyboards, keyframes, videoPlans, assets,
        DEFAULT_EXPORT_OPTIONS,
        (p) => setProgress(Math.round((p.completed / Math.max(p.total, 1)) * 100)),
      );

      if (result.blob) {
        triggerDownload(result.blob, result.filename);
      }

      setLastExportResult({
        manifestHash: result.manifestHash,
        assetCount: result.assetCount,
        missingAssetCount: result.missingAssetCount,
        totalSizeBytes: result.stats?.totalSizeBytes ?? 0,
        filename: result.filename,
      });

      showExportToast(result.filename, result.manifestHash, result.assetCount, result.missingAssetCount);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
      setProgress(0);
      setPendingExport(null);
    }
  };

  const doExportCore = async () => {
    if (!currentProject) return;
    setExporting(true);
    setShowPreflightDialog(false);

    try {
      const result = await exportCoreProjectBundleEnhanced(
        currentProject, scripts, storyboards,
        (p) => setProgress(Math.round((p.completed / Math.max(p.total, 1)) * 100)),
      );

      if (result.blob) {
        triggerDownload(result.blob, result.filename);
      }

      setLastExportResult({
        manifestHash: result.manifestHash,
        assetCount: result.assetCount,
        missingAssetCount: result.missingAssetCount,
        totalSizeBytes: result.stats?.totalSizeBytes ?? 0,
        filename: result.filename,
      });

      showExportToast(result.filename, result.manifestHash, result.assetCount, result.missingAssetCount);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
      setProgress(0);
      setPendingExport(null);
    }
  };

  const handleViewHistory = useCallback(async () => {
    if (!currentProject) return;
    try {
      const history = await getExportAuditLogs(currentProject.id);
      setExportHistory(history);
    } catch {
      setExportHistory([]);
    }
    setShowHistory(true);
  }, [currentProject]);

  const handlePreflightProceed = useCallback(() => {
    // User confirmed — proceed with the pending export type
    if (pendingExport === 'full') {
      doExportFull();
    } else if (pendingExport === 'core') {
      doExportCore();
    }
  }, [pendingExport]);

  if (!currentProject) return null;

  return (
    <div className="export-menu" data-testid="export-menu">
      <div className="export-menu-actions">
        <button onClick={handleExportFull} data-testid="btn-export-full" disabled={isProbing}>
          {isProbing ? 'Checking assets...' : 'Export Full Project'}
        </button>
        <button onClick={handleExportCore} data-testid="btn-export-core">
          Export Core Package
        </button>
        <button onClick={handleViewHistory} data-testid="btn-export-history">
          Export History
        </button>
      </div>

      <ExportPreflightDialog onProceed={handlePreflightProceed} onCancel={() => { setShowPreflightDialog(false); setPendingExport(null); }} />
      {showHistory && <ExportHistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  );
};

function showExportToast(filename: string, manifestHash: string, assetCount: number, missingCount: number) {
  const msg = formatExportSummary({ filename, manifestHash, assetCount, missingCount });
  // Console log (fallback for environments without DOM / during tests)
  console.log('[TOAST]', msg);
  if (typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.className = 'export-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-testid', 'export-toast');
    el.setAttribute('data-filename', filename);
    el.setAttribute('data-asset-count', String(assetCount));
    el.setAttribute('data-missing-count', String(missingCount));
    el.setAttribute('data-manifest-hash', manifestHash);
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;top:20px;right:20px;background:#165dff;color:#fff;padding:12px 20px;border-radius:4px;z-index:9999;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2);white-space:pre-line;max-width:420px;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}
