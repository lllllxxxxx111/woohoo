// Workspace container — main workspace view with export menu integration.
// This is a simplified version that demonstrates the export flow integration.
import React, { useEffect, useCallback } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useExportStore } from '../store/exportStore';
import { ExportDialog } from '../components/ExportDialog';
import { ExportHistoryPanel } from '../components/ExportHistoryPanel';

interface WorkspaceProps {
  projectId: string;
}

export const Workspace: React.FC<WorkspaceProps> = ({ projectId }) => {
  const { currentProject, scripts, storyboards, keyframes, videoPlans, assets, loadProject, loadExportHistory } =
    useProjectStore();
  const { runPreflight: runPf, performExport, toastMessage, clearToast, isExporting, exportProgress, exportMessage } =
    useExportStore();

  useEffect(() => {
    loadProject(projectId);
    loadExportHistory(projectId);
  }, [projectId, loadProject, loadExportHistory]);

  const [showExportDialog, setShowExportDialog] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);

  const handleOpenExport = useCallback(() => {
    if (!currentProject) return;
    runPf({ project: currentProject, scripts, storyboards, keyframes, videoPlans, assets });
    setShowExportDialog(true);
  }, [currentProject, scripts, storyboards, keyframes, videoPlans, assets, runPf]);

  const handleConfirmExport = useCallback(
    async (exportType: 'full' | 'core' | 'snapshot', force: boolean) => {
      if (!currentProject) return;
      const preflight = runPf({ project: currentProject, scripts, storyboards, keyframes, videoPlans, assets });
      const result = await performExport({
        project: currentProject,
        scripts,
        storyboards,
        keyframes,
        videoPlans,
        assets,
        exportType,
        preflight,
        force,
      });
      if (result.success) {
        setShowExportDialog(false);
        loadExportHistory(projectId);
      }
    },
    [currentProject, scripts, storyboards, keyframes, videoPlans, assets, runPf, performExport, projectId, loadExportHistory],
  );

  if (!currentProject) {
    return <div>Loading project...</div>;
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <h1>{currentProject.name}</h1>
        <div className="workspace-actions">
          <button onClick={handleOpenExport} disabled={isExporting}>
            {isExporting ? 'Exporting...' : 'Export Project'}
          </button>
          <button onClick={() => setShowHistory(!showHistory)}>Export History</button>
        </div>
      </header>

      {toastMessage && (
        <div className="toast" onClick={clearToast}>
          {toastMessage}
        </div>
      )}

      {isExporting && (
        <div className="export-progress">
          <div className="progress-bar" style={{ width: `${exportProgress * 100}%` }} />
          <span>{exportMessage}</span>
        </div>
      )}

      <main className="workspace-content">
        <p>
          {scripts.length} scripts, {storyboards.length} storyboards, {keyframes.length} keyframes,{' '}
          {videoPlans.length} video plans, {assets.length} assets
        </p>
      </main>

      {showExportDialog && (
        <ExportDialog
          onClose={() => setShowExportDialog(false)}
          onConfirm={handleConfirmExport}
        />
      )}

      {showHistory && <ExportHistoryPanel onClose={() => setShowHistory(false)} />}
    </div>
  );
};
