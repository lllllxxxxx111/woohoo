import React from 'react';
import { exportFullProjectBundle, exportCoreProjectBundle, runPreflightChecks } from './export';

export function App() {
  return (
    <div>
      <h1>Woohoo Studio</h1>
      <p>Export integrity module loaded. Available exports: exportFullProjectBundle, exportCoreProjectBundle, runPreflightChecks</p>
    </div>
  );
}
