import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeDollarSign, Settings } from 'lucide-react';
import styles from './SettingsMenu.module.css';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';
import { SettingsModal } from '../../../../components/Settings/SettingsModal';
import { getStoredServerProfile } from '../../../../lib/serverApi';
import { useBillingCredits } from '../../../../hooks/useBillingCredits';
import { formatCreditAmount } from '../../../../lib/credits';

const LONG_PRESS_DELAY_MS = 550;

export const SettingsMenu: React.FC = () => {
  const { isSidebarCollapsed, isSettingsOpen, setSettingsOpen, isAuthenticated } = useAppStore(
    useShallow((state) => ({
      isSidebarCollapsed: state.isSidebarCollapsed,
      isSettingsOpen: state.isSettingsOpen,
      setSettingsOpen: state.setSettingsOpen,
      isAuthenticated: state.isAuthenticated,
    })),
  );
  const { credits, loading: creditsLoading, error: creditsError } = useBillingCredits();
  const [profile, setProfile] = useState(() => getStoredServerProfile());
  const [isUuidVisible, setUuidVisible] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (isAuthenticated) {
      setProfile(getStoredServerProfile());
      return;
    }

    setProfile(null);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isUuidVisible) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setUuidVisible(false), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [isUuidVisible]);

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    },
    [],
  );

  const displayName = profile?.username || profile?.email || '未登录账户';
  const userId = profile?.id || '暂无 UUID';
  const avatarText = useMemo(() => {
    const source = (profile?.username || profile?.email || 'U').trim();
    return source.charAt(0).toUpperCase() || 'U';
  }, [profile?.email, profile?.username]);

  const handleAvatarPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = window.setTimeout(() => {
      setUuidVisible(true);
      longPressTimerRef.current = null;
    }, LONG_PRESS_DELAY_MS);
  };

  const clearLongPressTimer = (event?: React.PointerEvent<HTMLButtonElement>) => {
    event?.stopPropagation();
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleAvatarClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleAvatarContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setUuidVisible(true);
  };

  const creditsText = creditsLoading
    ? '读取中'
    : creditsError
      ? '读取失败'
      : `${formatCreditAmount(credits?.balance ?? 0)} 积分`;
  const accountMeta = profile?.email || (isAuthenticated ? '已登录' : '未登录');

  if (isSidebarCollapsed) {
    return (
      <div className={styles.container}>
        <div className={styles.collapsedStack}>
          <button
            type="button"
            className={styles.collapsedAvatar}
            aria-label="账户头像，长按显示 UUID"
            onPointerDown={handleAvatarPointerDown}
            onPointerUp={clearLongPressTimer}
            onPointerLeave={clearLongPressTimer}
            onPointerCancel={clearLongPressTimer}
            onClick={handleAvatarClick}
            onContextMenu={handleAvatarContextMenu}
          >
            {avatarText}
          </button>
          {isUuidVisible && <div className={styles.uuidTooltip}>{userId}</div>}
        </div>
        <div className={styles.collapsedCredits} title={creditsText}>
          <BadgeDollarSign size={16} />
        </div>
        <button
          className={`${styles.triggerBtn} ${styles.iconOnlyTrigger}`}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={20} />
        </button>
        {isSettingsOpen ? <SettingsModal /> : null}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.accountCard}>
        <div className={styles.userInfo}>
          <div className={styles.avatarWrap}>
            <button
              type="button"
              className={styles.avatar}
              aria-label="账户头像，长按显示 UUID"
              onPointerDown={handleAvatarPointerDown}
              onPointerUp={clearLongPressTimer}
              onPointerLeave={clearLongPressTimer}
              onPointerCancel={clearLongPressTimer}
              onClick={handleAvatarClick}
              onContextMenu={handleAvatarContextMenu}
            >
              {avatarText}
            </button>
            {isUuidVisible && <div className={styles.uuidTooltip}>{userId}</div>}
          </div>
          <div className={styles.userText}>
            <span className={styles.userName}>{displayName}</span>
            <span className={styles.userMeta}>{accountMeta}</span>
          </div>
        </div>
      </div>

      <div className={styles.creditBar} aria-label="余额积分" title={creditsText}>
        <div className={styles.creditLabel}>
          <BadgeDollarSign size={16} />
          <span>余额积分</span>
        </div>
        <strong>{creditsText}</strong>
      </div>

      <button className={styles.triggerBtn} onClick={() => setSettingsOpen(true)}>
        <span className={styles.settingsLabel}>系统设置</span>
        <Settings size={18} />
      </button>
      {isSettingsOpen ? <SettingsModal /> : null}
    </div>
  );
};
