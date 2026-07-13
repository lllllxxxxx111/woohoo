// ExportHistoryPanel — displays recent export audit records for the current project.
import React, { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { ExportType } from '../types';

interface ExportHistoryPanelProps {
  onClose: () => void;
}

const typeLabel: Record<ExportType, string> = {
  full: 'Full Bundle',
  core: 'Core Bundle',
  snapshot: 'Snapshot',
};

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const ExportHistoryPanel: React.FC<ExportHistoryPanelProps> = ({ onClose }) => {
  const { exportHistory, currentProject, loadExportHistory } = useProjectStore();

  // (Re)load history whenever the panel opens for a project
  useEffect(() => {
    if (currentProject) {
      loadExportHistory(currentProject.id);
    }
  }, [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="history-panel-overlay" onClick={onClose}>
      <div className="history-panel" onClick={(e) => e.stopPropagation()}>
        <h2>Export History{currentProject ? ` — ${currentProject.name}` : ''}</h2>
        {exportHistory.length === 0 ? (
          <p>No export records found for this project yet. Exports will appear here after you run one.</p>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Manifest Hash</th>
                <th>Files</th>
                <th>Size</th>
                <th>Assets Packed</th>
                <th>Missing</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {exportHistory.map((log) => (
                <tr key={log.id}>
                  <td>{new Date(log.createdAt).toLocaleString()}</td>
                  <td>{typeLabel[log.exportType] ?? log.exportType}</td>
                  <td>
                    <code title={log.manifestHash}>{log.manifestHash.substring(0, 12)}…</code>
                  </td>
                  <td>{log.fileCount ?? '—'}</td>
                  <td>{formatBytes(log.totalSizeBytes)}</td>
                  <td>{log.assetCount}</td>
                  <td>
                    {log.missingAssetCount > 0 ? (
                      <span style={{ color: '#d9363e' }}>{log.missingAssetCount}</span>
                    ) : (
                      <span style={{ color: '#00b42a' }}>0</span>
                    )}
                  </td>
                  <td>
                    {log.blockingCount > 0 && (
                      <span style={{ color: '#d9363e', marginRight: 6 }} title={`${log.blockingCount} blocking issues at export time`}>
                        ● {log.blockingCount}
                      </span>
                    )}
                    {log.warningCount > 0 && (
                      <span style={{ color: '#ff7d00' }} title={`${log.warningCount} warnings at export time`}>
                        ▲ {log.warningCount}
                      </span>
                    )}
                    {(!log.blockingCount && !log.warningCount) && <span style={{ color: '#86909c' }}>clean</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="history-hint">
          Records are stored server-side per project. Hash is the SHA-256 of the bundle manifest
          (covering project.json, workspace_snapshot.json, all assets, and the reports).
        </p>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
