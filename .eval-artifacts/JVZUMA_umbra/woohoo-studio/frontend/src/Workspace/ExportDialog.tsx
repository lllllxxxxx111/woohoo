import React, { useState, useEffect } from 'react';
import {
  Modal, Radio, Checkbox, Button, Space, Typography, Message, Spin, Divider, Alert, Tag,
} from '@arco-design/web-react';
import { IconCheckCircle, IconExclamationCircle } from '@arco-design/web-react/icon';
import PreflightResultDisplay from '../components/PreflightResultDisplay';
import { useExportStore } from '../stores/exportStore';
import type { ExportType, ExportOptions } from '../types';

const { Text } = Typography;
const RadioGroup = Radio.Group;
const CheckboxGroup = Checkbox.Group;

interface ExportDialogProps {
  projectId: string;
  visible: boolean;
  onClose: () => void;
}

const DEFAULT_OPTIONS: ExportOptions = {
  includeAssets: true,
  includeScripts: true,
  includeStoryboards: true,
  includeKeyframes: true,
  includeVideoPlans: true,
  includeSessions: false,
  assetQuality: 'original',
};

const INCLUDE_OPTIONS = [
  { label: 'Scripts', value: 'includeScripts' },
  { label: 'Storyboards', value: 'includeStoryboards' },
  { label: 'Keyframes', value: 'includeKeyframes' },
  { label: 'Video Plans', value: 'includeVideoPlans' },
  { label: 'Sessions', value: 'includeSessions' },
  { label: 'Assets (binary files)', value: 'includeAssets' },
];

const ExportDialog: React.FC<ExportDialogProps> = ({ projectId, visible, onClose }) => {
  const [exportType, setExportType] = useState<ExportType>('full');
  const [includeOptions, setIncludeOptions] = useState<ExportOptions>({ ...DEFAULT_OPTIONS });

  const {
    preflightResult, isRunningPreflight, isExporting, lastExportResult,
    runPreflight, startExport, clearPreflight,
  } = useExportStore();

  // Reset local state when dialog opens
  useEffect(() => {
    if (visible) {
      setExportType('full');
      setIncludeOptions({ ...DEFAULT_OPTIONS });
      clearPreflight();
    }
  }, [visible, clearPreflight]);

  const handleRunPreflight = async () => {
    try {
      await runPreflight(projectId);
    } catch {
      Message.error('Preflight check failed. Please try again.');
    }
  };

  const handleExport = async () => {
    try {
      const result = await startExport(projectId, exportType, includeOptions);
      const missingSuffix = result.missingAssetCount > 0
        ? ` (${result.missingAssetCount} missing)`
        : '';
      Message.success({
        content: (
          <span>
            Exported <b>{result.filename}</b> — {result.assetCount} assets{missingSuffix}
          </span>
        ),
      });
    } catch {
      Message.error('Export failed. Please try again.');
    }
  };

  const handleClose = () => {
    clearPreflight();
    onClose();
  };

  const blockingCount = preflightResult?.blockingCount ?? 0;
  const warningCount = preflightResult?.warningCount ?? 0;
  const canExport = blockingCount === 0 && !isExporting && !isRunningPreflight;

  const selectedIncludeKeys = Object.entries(includeOptions)
    .filter(([, v]) => v === true)
    .map(([k]) => k);

  const handleIncludeChange = (values: string[]) => {
    const next = { ...includeOptions } as Record<string, unknown>;
    (Object.keys(includeOptions) as (keyof ExportOptions)[]).forEach((key) => {
      if (typeof next[key] === 'boolean') {
        next[key] = values.includes(key);
      }
    });
    setIncludeOptions(next as unknown as ExportOptions);
  };

  const footer = (
    <Space>
      <Button onClick={handleClose}>Cancel</Button>
      <Button
        onClick={handleRunPreflight}
        loading={isRunningPreflight}
        disabled={isExporting}
      >
        Run Preflight
      </Button>
      <Button
        type="primary"
        onClick={handleExport}
        disabled={!canExport}
        loading={isExporting}
        status={warningCount > 0 && blockingCount === 0 ? 'warning' : undefined}
      >
        {blockingCount > 0
          ? `Cannot Export (${blockingCount} blocking)`
          : warningCount > 0
            ? `Export (${warningCount} warnings)`
            : 'Export'}
      </Button>
    </Space>
  );

  return (
    <Modal
      title="Export Project"
      visible={visible}
      onCancel={handleClose}
      footer={footer}
      style={{ width: 680 }}
      maskClosable={false}
    >
      <Spin loading={isExporting} tip="Exporting project…" style={{ width: '100%' }}>
        <Space direction="vertical" size="medium" style={{ width: '100%' }}>
          {/* Export type */}
          <div>
            <Text bold>Export Type</Text>
            <div style={{ marginTop: 8 }}>
              <RadioGroup
                value={exportType}
                onChange={(val) => setExportType(val as ExportType)}
                direction="vertical"
              >
                <Radio value="full">Full bundle — includes all metadata and asset binaries</Radio>
                <Radio value="core">Core bundle — metadata only (no asset binaries)</Radio>
              </RadioGroup>
            </div>
          </div>

          <Divider style={{ margin: '4px 0' }} />

          {/* Include options */}
          <div>
            <Text bold>Include</Text>
            <div style={{ marginTop: 8 }}>
              <CheckboxGroup
                value={selectedIncludeKeys}
                onChange={handleIncludeChange}
                direction="vertical"
                options={INCLUDE_OPTIONS}
              />
            </div>
          </div>

          <Divider style={{ margin: '4px 0' }} />

          {/* Preflight section */}
          <div>
            <Space>
              <Text bold>Preflight Check</Text>
              {preflightResult && blockingCount === 0 && warningCount === 0 && (
                <Tag icon={<IconCheckCircle />} color="green">Passed</Tag>
              )}
              {blockingCount > 0 && (
                <Tag icon={<IconExclamationCircle />} color="red">
                  {blockingCount} blocking
                </Tag>
              )}
              {warningCount > 0 && blockingCount === 0 && (
                <Tag icon={<IconExclamationCircle />} color="orange">
                  {warningCount} warnings
                </Tag>
              )}
            </Space>
            {preflightResult && (
              <PreflightResultDisplay result={preflightResult} onClose={clearPreflight} />
            )}
            {!preflightResult && !isRunningPreflight && (
              <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                Click "Run Preflight" to validate assets and configuration before exporting.
              </Text>
            )}
          </div>

          {/* Success result */}
          {lastExportResult && lastExportResult.success && (
            <Alert
              type="success"
              title="Export complete"
              content={
                <Space direction="vertical" size={4}>
                  <Text>File: <Text code>{lastExportResult.filename}</Text></Text>
                  {lastExportResult.manifestHash && (
                    <Text>Manifest: <Text code>{lastExportResult.manifestHash.slice(0, 16)}…</Text></Text>
                  )}
                  <Text>
                    Assets packed: <b>{lastExportResult.assetCount}</b>
                    {lastExportResult.missingAssetCount > 0 && (
                      <> · <span style={{ color: '#f53f3f' }}>Missing: {lastExportResult.missingAssetCount}</span></>
                    )}
                    {lastExportResult.totalSizeBytes > 0 && (
                      <> · Size: {Math.round(lastExportResult.totalSizeBytes / 1024)} KB</>
                    )}
                  </Text>
                </Space>
              }
            />
          )}
        </Space>
      </Spin>
    </Modal>
  );
};

export default ExportDialog;
