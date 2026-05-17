import React from 'react';
import { Settings } from 'lucide-react';
import styles from './SettingsMenu.module.css';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { SettingsModal } from '../../../../components/Settings/SettingsModal';

export const SettingsMenu: React.FC = () => {
  const { isSidebarCollapsed, isSettingsOpen, setSettingsOpen } = useAppStore(
    useShallow((state) => ({
      isSidebarCollapsed: state.isSidebarCollapsed,
      isSettingsOpen: state.isSettingsOpen,
      setSettingsOpen: state.setSettingsOpen,
    })),
  );

  if (isSidebarCollapsed) {
    return (
      <div className={styles.container}>
        <button className={styles.triggerBtn} onClick={() => setSettingsOpen(true)}>
          <Settings size={20} />
        </button>
        {isSettingsOpen ? <SettingsModal /> : null}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <button className={styles.triggerBtn} onClick={() => setSettingsOpen(true)}>
        <div className={styles.userInfo}>
          <div className={styles.avatar}>U</div>
          <span className={styles.userName}>系统设置</span>
        </div>
        <Settings size={18} />
      </button>
      {isSettingsOpen ? <SettingsModal /> : null}
    </div>
  );
};
