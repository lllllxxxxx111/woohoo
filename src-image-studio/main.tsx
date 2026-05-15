import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppErrorBoundary } from '../src/components/ErrorBoundary/AppErrorBoundary';
import '../src/styles/arco';
import '../src/styles/arco-async';
import '../src/styles/global.css';
import App from './App';

document.body.classList.remove('theme-light');
document.body.classList.add('theme-dark');
document.body.setAttribute('arco-theme', 'dark');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
