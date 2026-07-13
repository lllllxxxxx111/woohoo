// ExportDialog — shows preflight results, allows selecting export type, and confirms the export.
import React from 'react';
import { useExportStore } from '../store/exportStore';
import type { ExportType, PreflightSeverity } from '../types';

interface ExportDialogProps {
  onClose: () => void;
  onConfirm: (exportType: ExportType, force: boolean) => void;
}

const severityLabel: Record<PreflightSeverity, string> = {
  blocking: '🚫 Blocking',
  warning: '⚠️ Warning',
  info: 'ℹ️ Info',
};

const severityColor: Record<PreflightSeverity, string> = {
  blocking: '#d32f2f',
  warning: '#ed6c02',
  info: '#0288d1',
};

export const ExportDialog: React.FC<ExportDialogProps> = ({ onClose, onConfirm }) => {
  const { preflightResult, isExporting } = useExportStore();
  const [exportType, setExportType] = React.useState<ExportType>('full');
  const [forceBlockers, setForceBlockers] = React.useState(false);

  if (!preflightResult) return null;

  const hasBlocking = preflightResult.summary.blockingCount > 0;
  const canProceed = !hasBlocking || forceBlockers;

  return (
    <div className="export-dialog-overlay" onClick={onClose}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Export Project</h2>

        <div className="preflight-summary">
          <span style={{ color: severityColor.blocking }}>
            {preflightResult.summary.blockingCount} blocking
          </span>
          {' • '}
          <span style={{ color: severityColor.warning }}>
            {preflightResult.summary.warningCount} warnings
          </span>
          {' • '}
          <span style={{ color: severityColor.info }}>
            {preflightResult.summary.infoCount} info
          </span>
        </div>

        {preflightResult.allIssues.length > 0 && (
          <div className="preflight-issues">
            {(['blocking', 'warning', 'info'] as PreflightSeverity[]).map((sev) => {
              const issues = preflightResult.allIssues.filter((i) => i.severity === sev);
              if (issues.length === 0) return null;
              return (
                <div key={sev} className="issue-group">
                  <h4 style={{ color: severityColor[sev] }}>{severityLabel[sev]}</h4>
                  <ul>
                    {issues.map((issue, idx) => (
                      <li key={idx}>
                        <strong>{issue.message}</strong>
                        {issue.detail && <div className="issue-detail">{issue.detail}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {preflightResult.allIssues.length === 0 && (
          <p className="no-issues">✓ All preflight checks passed.</p>
        )}

        <div className="export-type-selector">
          <label>
            <input
              type="radio"
              value="full"
              checked={exportType === 'full'}
              onChange={() => setExportType('full')}
            />
            Full Project Bundle (includes assets)
          </label>
          <label>
            <input
              type="radio"
              value="core"
              checked={exportType === 'core'}
              onChange={() => setExportType('core')}
            />
            Core Planning Bundle (scripts + storyboards, no heavy assets)
          </label>
          <label>
            <input
              type="radio"
              value="snapshot"
              checked={exportType === 'snapshot'}
              onChange={() => setExportType('snapshot')}
            />
            Snapshot Only (data JSON, no assets)
          </label>
        </div>

        {hasBlocking && (
          <div className="force-option">
            <label>
              <input
                type="checkbox"
                checked={forceBlockers}
                onChange={(e) => setForceBlockers(e.target.checked)}
              />
              I understand the risks and want to export anyway ({preflightResult.summary.blockingCount} blocking issue(s))
            </label>
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose} disabled={isExporting}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(exportType, forceBlockers)}
            disabled={!canProceed || isExporting}
            className="primary"
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
};
