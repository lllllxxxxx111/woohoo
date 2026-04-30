import { createContext } from 'react';
import type { SendAiMessageOptions, SendMessageResult } from '../store';
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
  deleteAsset: (assetId: string) => Promise<void>;
  saveScript: (projectId: string, content: string, title?: string) => Promise<Script>;
  saveStoryboard: (projectId: string, lines: Storyboard['lines']) => Promise<Storyboard>;
  suggestProjectName: (seedContent?: string) => string;
  sendAiMessage: (content: string, options?: SendAiMessageOptions) => Promise<SendMessageResult>;
};

export const AppActionsContext = createContext<AppActions | null>(null);
