// ExportHistoryPanel - shows recent export audit records
import React from 'react';
import { useExportStore } from '../stores/exportStore';
import type { ExportAuditRecord } from '../serverApi';

interface Props {
  onClose: () => void;
}

export const ExportHistoryPanel: React.FC<Props> = ({ onClose }) => {
  const { exportHistory } = useExportStore();

  return (
    <div className="export-history-overlay" data-testid="export-history-panel" style={styles.overlay}>
      <div className="export-history-dialog" style={styles.dialog}>
        <div style={styles.header}>
          <h3 style={styles.title}>Export History</h3>
          <button onClick={onClose} style={styles.closeBtn} data-testid="history-close">×</button>
        </div>

        {exportHistory.length === 0 ? (
          <p style={styles.empty}>No export records found.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Time</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Manifest Hash</th>
                <th style={styles.th}>Assets</th>
                <th style={styles.th}>Missing</th>
                <th style={styles.th}>Size</th>
              </tr>
            </thead>
            <tbody>
              {exportHistory.map((record) => (
                <HistoryRow key={record.id} record={record} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const HistoryRow: React.FC<{ record: ExportAuditRecord }> = ({ record }) => (
  <tr>
    <td style={styles.td}>{new Date(record.createdAt).toLocaleString()}</td>
    <td style={styles.td}>
      <span style={typeBadgeStyle(record.exportType)}>{record.exportType}</span>
    </td>
    <td style={styles.td}>
      <code style={styles.code}>{record.manifestHash.substring(0, 12)}...</code>
    </td>
    <td style={styles.td}>{record.assetCount}</td>
    <td style={{ ...styles.td, color: record.missingAssetCount > 0 ? '#f53f3f' : undefined }}>
      {record.missingAssetCount}
    </td>
    <td style={styles.td}>{formatSize(record.totalSizeBytes)}</td>
  </tr>
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function typeBadgeStyle(type: string): React.CSSProperties {
  const colors: Record<string, string> = {
    full: '#165dff',
    core: '#00b42a',
    snapshot: '#722ed1',
  };
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 3,
    background: colors[type] ?? '#86909c', color: '#fff', fontSize: 11,
    fontWeight: 600, textTransform: 'uppercase',
  };
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 10000,
  },
  dialog: {
    background: '#fff', borderRadius: 8, padding: 24, maxWidth: 700, width: '90%',
    maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { margin: 0, fontSize: 18, fontWeight: 600 },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 24, cursor: 'pointer',
    color: '#86909c', padding: 0, lineHeight: 1,
  },
  empty: { textAlign: 'center', padding: 40, color: '#86909c' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid #e5e6eb',
    fontWeight: 600, color: '#4e5969', fontSize: 12,
  },
  td: { padding: '8px 12px', borderBottom: '1px solid #f2f3f5' },
  code: { fontSize: 12, background: '#f7f8fa', padding: '2px 4px', borderRadius: 2 },
};
