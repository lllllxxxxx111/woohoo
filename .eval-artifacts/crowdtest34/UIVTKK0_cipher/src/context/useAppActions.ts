import { useContext } from 'react';
import { useAppStore } from '../store';
import { AppActionsContext } from './appActionsContext';

export const useAppActions = () => {
  const actions = useContext(AppActionsContext);
  if (!actions) {
    throw new Error('useAppActions must be used within AppProvider.');
  }

  return actions;
};

export const useAppContext = () => ({
  ...useAppStore(),
  ...useAppActions(),
});
