// WorkspaceMVP - the main MVP workspace view (simplified)
import React from 'react';
import { ExportMenu } from '../Workspace/ExportMenu';

export const WorkspaceMVP: React.FC = () => {
  return (
    <div className="workspace-mvp" data-testid="workspace-mvp">
      <header className="workspace-header">
        <h1>Woohoo Studio</h1>
        <ExportMenu />
      </header>
      <main className="workspace-content">
        <p>Workspace content area - scripts, storyboards, keyframes, video plans are managed here.</p>
      </main>
    </div>
  );
};
