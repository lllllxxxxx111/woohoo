import React from 'react';
import { logger } from '../../lib/logger';

type AppErrorBoundaryProps = {
  children: React.ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string | null;
  isRecoverableModuleLoadError: boolean;
};

const MODULE_LOAD_RELOAD_KEY = 'woohoo:last-module-load-reload';
const MODULE_LOAD_RELOAD_COOLDOWN_MS = 30_000;

function isRecoverableModuleLoadError(error: Error) {
  const message = error.message || '';
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    error.name === 'ChunkLoadError'
  );
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: null,
    isRecoverableModuleLoadError: false,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || '发生未知异常',
      isRecoverableModuleLoadError: isRecoverableModuleLoadError(error),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('[AppErrorBoundary] Unhandled React error', error, errorInfo.componentStack);

    if (isRecoverableModuleLoadError(error)) {
      this.reloadOnceForModuleLoadError();
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({
      hasError: false,
      errorMessage: null,
      isRecoverableModuleLoadError: false,
    });
  };

  reloadOnceForModuleLoadError() {
    try {
      const lastReload = Number(window.sessionStorage.getItem(MODULE_LOAD_RELOAD_KEY) || '0');
      const now = Date.now();

      if (now - lastReload < MODULE_LOAD_RELOAD_COOLDOWN_MS) {
        return;
      }

      window.sessionStorage.setItem(MODULE_LOAD_RELOAD_KEY, String(now));
      window.setTimeout(() => window.location.reload(), 50);
    } catch {
      window.location.reload();
    }
  }

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
          {this.state.isRecoverableModuleLoadError ? (
            <p
              style={{
                margin: '10px 0 0',
                lineHeight: 1.6,
                color: 'var(--text-secondary, #b8c0d4)',
              }}
            >
              检测到前端模块加载失败，通常来自开发服务器热更新或浏览器缓存。应用会尝试自动刷新一次。
            </p>
          ) : null}
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
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              marginTop: '18px',
              marginLeft: '10px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
              borderRadius: '10px',
              background: 'transparent',
              color: 'inherit',
              padding: '10px 14px',
              cursor: 'pointer',
            }}
          >
            重置界面
          </button>
        </div>
      </div>
    );
  }
}
