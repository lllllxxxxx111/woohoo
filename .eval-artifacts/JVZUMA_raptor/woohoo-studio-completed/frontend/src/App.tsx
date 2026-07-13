import React, { useState } from 'react';
import { Button, Layout, Typography, Space, ConfigProvider } from '@arco-design/web-react';
import '@arco-design/web-react/dist/css/arco.css';
import ExportDialog from './Workspace/ExportDialog';
import ExportHistoryPanel from './Workspace/ExportHistoryPanel';

const { Header, Content } = Layout;
const { Title } = Typography;

// Demo / test project ID. In production this would come from route params or app state.
const DEMO_PROJECT_ID = 'demo-project-001';

const App: React.FC = () => {
  const [dialogVisible, setDialogVisible] = useState(false);

  return (
    <ConfigProvider>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ background: '#1d2129', padding: '0 24px', display: 'flex', alignItems: 'center' }}>
          <Title heading={4} style={{ color: '#fff', margin: 0 }}>
            Woohoo Studio
          </Title>
        </Header>
        <Content style={{ padding: 24, background: '#f2f3f5' }}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <div style={{ background: '#fff', padding: 24, borderRadius: 4 }}>
              <Space direction="vertical">
                <Title heading={4} style={{ margin: 0 }}>
                  Project: Demo Project
                </Title>
                <Button type="primary" size="large" onClick={() => setDialogVisible(true)}>
                  Open Export Dialog
                </Button>
              </Space>
            </div>

            <div style={{ background: '#fff', borderRadius: 4 }}>
              <ExportHistoryPanel projectId={DEMO_PROJECT_ID} />
            </div>
          </Space>
        </Content>

        <ExportDialog
          projectId={DEMO_PROJECT_ID}
          visible={dialogVisible}
          onClose={() => setDialogVisible(false)}
        />
      </Layout>
    </ConfigProvider>
  );
};

export default App;
