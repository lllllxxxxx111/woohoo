import { createContext } from 'react';
import type { SendAiMessageOptions, SendMessageResult } from '../store';
import type { SaveScriptOptions, SaveStoryboardOptions } from '../lib/serverApi';
import type { Asset, ChatSession, Message, Project, Script, Storyboard } from '../types';

export type AppActions = {
  createProject: (name: string) => Promise<Project>;
  updateProject: (projectId: string, name: string) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  createChatInProject: (projectId: string, title?: string) => Promise<ChatSession>;
  deleteChatInProject: (projectId: string, chatId: string) => Promise<void>;
  deleteMessageInChat: (
    projectId: string | null,
    chatId: string | null,
    messageId: string,
  ) => Promise<void>;
  rewindChatToMessage: (
    projectId: string,
    chatId: string,
    messageId: string,
    assetsOnly?: boolean,
  ) => Promise<void>;
  updateMessageInChat: (
    projectId: string | null,
    chatId: string | null,
    messageId: string,
    newContent: string,
  ) => Promise<void>;
  addMessage: (projectId: string | null, chatId: string | null, message: Message) => void;
  uploadAssets: (projectId: string, files: File[]) => Promise<Asset[]>;
  updateAsset: (assetId: string, input: Partial<Pick<Asset, 'name' | 'type' | 'url' | 'metadata'>>) => Promise<Asset>;
  deleteAsset: (assetId: string) => Promise<void>;
  saveScript: (
    projectId: string,
    content: string,
    title?: string,
    options?: SaveScriptOptions,
  ) => Promise<Script>;
  saveStoryboard: (
    projectId: string,
    lines: Storyboard['lines'],
    options?: SaveStoryboardOptions,
  ) => Promise<Storyboard>;
  refreshWorkspace: (reason?: string, maxAttempts?: number) => Promise<unknown>;
  suggestProjectName: (seedContent?: string) => string;
  sendAiMessage: (content: string, options?: SendAiMessageOptions) => Promise<SendMessageResult>;
};

export const AppActionsContext = createContext<AppActions | null>(null);
