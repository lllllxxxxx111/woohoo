import React from 'react';
import { logger } from '../../lib/logger';

type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string | null;
};

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || '发生未知异常',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('[AppErrorBoundary] Unhandled React error', error, errorInfo.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: 'var(--bg-primary, #0b1020)',
          color: 'var(--text-primary, #f5f7fb)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '560px',
            border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
            borderRadius: '16px',
            padding: '24px',
            background: 'var(--bg-card, rgba(14,20,36,0.92))',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.28)',
          }}
        >
          <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>界面出现异常</h1>
          <p
            style={{ margin: '12px 0 0', lineHeight: 1.6, color: 'var(--text-secondary, #b8c0d4)' }}
          >
            当前页面渲染失败，已经阻止整页白屏。你可以先重新加载应用；如果问题持续，检查最近一次操作和错误日志。
          </p>
          {import.meta.env.DEV && this.state.errorMessage ? (
            <pre
              style={{
                margin: '16px 0 0',
                padding: '12px',
                borderRadius: '10px',
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                background: 'rgba(0, 0, 0, 0.24)',
                color: '#ffd7d7',
              }}
            >
              {this.state.errorMessage}
            </pre>
          ) : null}
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              marginTop: '18px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
              borderRadius: '10px',
              background: 'var(--bg-secondary, rgba(255,255,255,0.06))',
              color: 'inherit',
              padding: '10px 14px',
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
