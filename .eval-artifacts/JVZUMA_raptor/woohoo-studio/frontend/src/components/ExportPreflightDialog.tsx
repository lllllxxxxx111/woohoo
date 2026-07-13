// ExportPreflightDialog - shows preflight issues before export
import React from 'react';
import { useExportStore } from '../stores/exportStore';
import type { PreflightIssue } from '../stores/exportStore';

interface Props {
  onProceed: () => void;
  onCancel: () => void;
}

export const ExportPreflightDialog: React.FC<Props> = ({ onProceed, onCancel }) => {
  const { showPreflightDialog, preflightIssues } = useExportStore();

  if (!showPreflightDialog) return null;

  const blocking = preflightIssues.filter((i) => i.severity === 'blocking');
  const warnings = preflightIssues.filter((i) => i.severity === 'warning');
  const infos = preflightIssues.filter((i) => i.severity === 'info');

  return (
    <div className="preflight-overlay" data-testid="preflight-dialog" style={styles.overlay}>
      <div className="preflight-dialog" style={styles.dialog}>
        <h3 style={styles.title}>Export Pre-flight Check</h3>

        {blocking.length > 0 && (
          <div style={styles.section}>
            <h4 style={{ ...styles.sectionTitle, color: '#f53f3f' }}>
              Blocking Issues ({blocking.length})
            </h4>
            <p style={styles.sectionDesc}>These issues must be resolved before exporting, or you may proceed at your own risk.</p>
            <ul style={styles.list}>
              {blocking.map((issue, idx) => (
                <IssueItem key={`b-${idx}`} issue={issue} color="#f53f3f" />
              ))}
            </ul>
          </div>
        )}

        {warnings.length > 0 && (
          <div style={styles.section}>
            <h4 style={{ ...styles.sectionTitle, color: '#ff7d00' }}>
              Warnings ({warnings.length})
            </h4>
            <ul style={styles.list}>
              {warnings.map((issue, idx) => (
                <IssueItem key={`w-${idx}`} issue={issue} color="#ff7d00" />
              ))}
            </ul>
          </div>
        )}

        {infos.length > 0 && (
          <div style={styles.section}>
            <h4 style={{ ...styles.sectionTitle, color: '#165dff' }}>
              Information ({infos.length})
            </h4>
            <ul style={styles.list}>
              {infos.map((issue, idx) => (
                <IssueItem key={`i-${idx}`} issue={issue} color="#165dff" />
              ))}
            </ul>
          </div>
        )}

        {preflightIssues.length === 0 && (
          <p style={styles.allClear}>All checks passed! No issues found.</p>
        )}

        <div style={styles.actions}>
          <button onClick={onCancel} style={styles.cancelBtn} data-testid="preflight-cancel">
            Cancel
          </button>
          <button
            onClick={onProceed}
            style={{
              ...styles.proceedBtn,
              opacity: blocking.length > 0 ? 0.7 : 1,
            }}
            data-testid="preflight-proceed"
          >
            {blocking.length > 0 ? 'Proceed Anyway (Not Recommended)' : 'Continue Export'}
          </button>
        </div>
      </div>
    </div>
  );
};

const IssueItem: React.FC<{ issue: PreflightIssue; color: string }> = ({ issue, color }) => (
  <li style={styles.listItem}>
    <span style={{ ...styles.badge, backgroundColor: color }}>{issue.category}</span>
    <span style={styles.issueMsg}>{issue.message}</span>
    {issue.detail && <p style={styles.issueDetail}>{issue.detail}</p>}
  </li>
);

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 10000,
  },
  dialog: {
    background: '#fff', borderRadius: 8, padding: 24, maxWidth: 600, width: '90%',
    maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
  },
  title: { margin: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 },
  section: { marginBottom: 16 },
  sectionTitle: { margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 },
  sectionDesc: { margin: '0 0 8px', fontSize: 12, color: '#86909c' },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  listItem: { padding: '8px 0', borderBottom: '1px solid #f2f3f5', fontSize: 13 },
  badge: {
    display: 'inline-block', padding: '2px 6px', borderRadius: 3,
    color: '#fff', fontSize: 11, fontWeight: 600, marginRight: 8, textTransform: 'uppercase',
  },
  issueMsg: { color: '#1d2129' },
  issueDetail: { margin: '4px 0 0 28px', fontSize: 12, color: '#86909c' },
  allClear: { padding: '24px 0', textAlign: 'center', color: '#00b42a', fontSize: 14 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 },
  cancelBtn: {
    padding: '8px 16px', border: '1px solid #c9cdd4', borderRadius: 4,
    background: '#fff', cursor: 'pointer', fontSize: 13,
  },
  proceedBtn: {
    padding: '8px 16px', border: 'none', borderRadius: 4,
    background: '#165dff', color: '#fff', cursor: 'pointer', fontSize: 13,
  },
};
