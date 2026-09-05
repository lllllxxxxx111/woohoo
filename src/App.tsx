import React, { Suspense, lazy } from 'react';
import { useAppStore } from './store';
import { useShallow } from 'zustand/react/shallow';
import { AppProvider } from './context/AppContext';

import { ToastProvider } from './context/ToastContext';
import { Sidebar } from './features/studio/components/sidebar/Sidebar';
import { Workspace } from './features/studio/components/workspace/Workspace';
import { ConfigProvider } from '@arco-design/web-react';
import enUS from '@arco-design/web-react/es/locale/en-US';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import { Loader2 } from 'lucide-react';
import './styles/global.css';

const AuthModal = lazy(() =>
  import('./components/Auth/AuthModal').then((module) => ({ default: module.AuthModal })),
);
const HelpModal = lazy(() =>
  import('./components/Help/HelpModal').then((module) => ({ default: module.HelpModal })),
);

const BootstrapErrorScreen: React.FC<{ message: string }> = ({ message }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      padding: '24px',
      textAlign: 'center',
      gap: '12px',
    }}
  >
    <h2 style={{ margin: 0, fontWeight: 600, fontSize: '1.1rem' }}>初始化失败</h2>
    <p style={{ margin: 0, color: 'var(--text-secondary)', maxWidth: '640px' }}>{message}</p>
    <button
      type="button"
      onClick={() => window.location.reload()}
      style={{
        marginTop: '4px',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        padding: '8px 14px',
        cursor: 'pointer',
      }}
    >
      重试初始化
    </button>
  </div>
);

const AppContent: React.FC = () => {
  const { isServerWorkspaceReady, workspaceBootstrapError, isAuthenticated, language } =
    useAppStore(
      useShallow((state) => ({
        isServerWorkspaceReady: state.isServerWorkspaceReady,
        workspaceBootstrapError: state.workspaceBootstrapError,
        isAuthenticated: state.isAuthenticated,
        language: state.language,
      })),
    );
  const locale = language === 'en-US' ? enUS : zhCN;

  return (
    <ConfigProvider locale={locale}>
      <div style={{ display: 'flex', width: '100%', height: '100%', position: 'relative' }}>
        {!isServerWorkspaceReady ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              backdropFilter: 'var(--backdrop-blur)',
            }}
          >
            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  width: '120px',
                  height: '120px',
                  background: 'var(--bg-glow)',
                  borderRadius: '50%',
                  filter: 'blur(30px)',
                  animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                }}
              ></div>
              <Loader2
                size={48}
                className="lucide-spin"
                style={{
                  color: 'var(--bg-accent)',
                  position: 'relative',
                  animation: 'spin 2s linear infinite',
                }}
              />
            </div>
            <h2
              style={{
                marginTop: '24px',
                fontWeight: 600,
                fontSize: '1.25rem',
                letterSpacing: '0.05em',
              }}
            >
              初始化工作流
            </h2>
            <p style={{ marginTop: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              正在同步服务端数据...
            </p>
          </div>
        ) : !isAuthenticated ? (
          workspaceBootstrapError ? (
            <BootstrapErrorScreen message={workspaceBootstrapError} />
          ) : (
            <Suspense fallback={null}>
              <AuthModal />
            </Suspense>
          )
        ) : workspaceBootstrapError ? (
          <BootstrapErrorScreen message={workspaceBootstrapError} />
        ) : (
          <>
            <Sidebar />
            <Workspace />
            <Suspense fallback={null}>
              <HelpModal />
            </Suspense>
          </>
        )}
      </div>
    </ConfigProvider>
  );
};

const App: React.FC = () => {
  return (
    <AppProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </AppProvider>
  );
};

export default App;
