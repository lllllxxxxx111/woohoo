import type { SetStateAction } from 'react';
import { getStoredServerUserId } from '../../lib/serverApi';
import type { AiSettings } from '../../types';

export type ThemeMode = 'dark' | 'light';

export const STORAGE_KEYS = {
  projects: 'woohoo-projects-v2',
  globalChatMessages: 'woohoo-global-chat-v1',
  assets: 'woohoo-assets-v1',
  scripts: 'woohoo-scripts-v1',
  storyboards: 'woohoo-storyboards-v1',
  agents: 'woohoo-agents-v1',
  activeState: 'woohoo-active-state-v2',
  theme: 'woohoo-theme-v2',
  autoSave: 'woohoo-auto-save-v1',
  aiSettings: 'woohoo-ai-settings-v1',
  aiEndpointId: 'woohoo-ai-endpoint-v1',
} as const;

const USER_SCOPED_STORAGE_KEYS = new Set<string>([
  STORAGE_KEYS.projects,
  STORAGE_KEYS.globalChatMessages,
  STORAGE_KEYS.assets,
  STORAGE_KEYS.scripts,
  STORAGE_KEYS.storyboards,
  STORAGE_KEYS.agents,
  STORAGE_KEYS.activeState,
  STORAGE_KEYS.autoSave,
  STORAGE_KEYS.aiSettings,
  STORAGE_KEYS.aiEndpointId,
]);

type ScopedStorageValue<T> = {
  userId: string | null;
  value: T;
};

function isScopedStorageValue<T>(value: unknown): value is ScopedStorageValue<T> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'value' in value &&
    'userId' in value &&
    (((value as ScopedStorageValue<T>).userId ?? null) === null ||
      typeof (value as ScopedStorageValue<T>).userId === 'string'),
  );
}

export function loadStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!USER_SCOPED_STORAGE_KEYS.has(key)) {
      return parsed as T;
    }

    const currentUserId = getStoredServerUserId();
    if (isScopedStorageValue<T>(parsed)) {
      if (currentUserId && parsed.userId !== currentUserId) {
        return fallback;
      }

      return parsed.value;
    }

    return currentUserId ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

export function persistStorage<T>(key: string, value: T) {
  if (typeof window === 'undefined') {
    return;
  }

  if (!USER_SCOPED_STORAGE_KEYS.has(key)) {
    window.localStorage.setItem(key, JSON.stringify(value));
    return;
  }

  const currentUserId = getStoredServerUserId();
  const scopedValue: ScopedStorageValue<T> = {
    userId: currentUserId,
    value,
  };
  window.localStorage.setItem(key, JSON.stringify(scopedValue));
}

export function stripSensitiveAiSettings(
  value: Partial<AiSettings> | null | undefined,
): Partial<AiSettings> | null {
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }

  return {
    ...value,
    apiKey: '',
  };
}

export function resolveStateUpdate<T>(updater: SetStateAction<T>, prev: T): T {
  return typeof updater === 'function' ? (updater as (prevState: T) => T)(prev) : updater;
}

export function hydrateTheme(value: unknown): ThemeMode {
  return value === 'light' ? 'light' : 'dark';
}
