import React from 'react';
import ReactDOM from 'react-dom/client';
import { Workspace } from './Workspace/Workspace';

// Simple demo App — renders workspace with a sample project ID
function App() {
  const projectId = 'demo-project-001';
  return <Workspace projectId={projectId} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
