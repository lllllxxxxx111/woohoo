import React, { useEffect, useMemo, useState, useDeferredValue } from 'react';
import { Avatar, Button, Input, Popconfirm, Select, Tag, Tooltip } from '@arco-design/web-react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheckBig,
  Clock,
  Copy,
  PencilLine,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cancelTask } from '../../../../lib/ai';
import type { Message, AgentContact, Asset, MessageMeta, ResourceRef } from '../../../../types';
import FilePreview from './FilePreview';
import { escapeRegExp, formatAssetTypeLabel, resolveMentionedAsset } from './chatAreaUtils';
import styles from './ChatArea.module.css';

const { TextArea } = Input;

export type StoryOutlineSupplementDraft = {
  genre: string;
  protagonist: string;
  conflict: string;
  usage: string;
  ending: string;
  extraNotes: string;
};

type StoryOutlineFieldKey = 'genre' | 'protagonist' | 'conflict' | 'usage' | 'ending';
type WorkflowGuardItem = NonNullable<MessageMeta['workflowGuard']>['items'][number];
type WorkflowGuardItemWithCompletion = {
  item: WorkflowGuardItem;
  effectiveDone: boolean;
  completedViaDraft: boolean;
};

const EMPTY_STORY_OUTLINE_DRAFT: StoryOutlineSupplementDraft = {
  genre: '',
  protagonist: '',
  conflict: '',
  usage: '',
  ending: '',
  extraNotes: '',
};

const STORY_OUTLINE_GENRE_OPTIONS = [
  '都市',
  '校园',
  '悬疑',
  '科幻',
  '古风',
  '爱情',
  '喜剧',
  '奇幻',
  '近未来',
  '现实主义',
];

const STORY_OUTLINE_USAGE_OPTIONS = [
  '短视频剧情',
  '漫画',
  '短篇小说',
  '中篇小说',
  '动画短片',
  '短剧分集',
];

const STORY_OUTLINE_ENDING_OPTIONS = ['HE', 'BE', '反转', '治愈', '开放式', '悬念结尾'];
const EMPTY_RESOURCE_REFS: ResourceRef[] = [];

const STORY_OUTLINE_QUICK_PRESETS: Array<{
  label: string;
  values: Partial<StoryOutlineSupplementDraft>;
}> = [
  {
    label: '近未来悬疑',
    values: {
      genre: '近未来悬疑',
      usage: '动画短片',
      ending: '反转',
    },
  },
  {
    label: '校园爱情喜剧',
    values: {
      genre: '校园爱情喜剧',
      usage: '短视频剧情',
      ending: 'HE',
    },
  },
  {
    label: '都市治愈成长',
    values: {
      genre: '都市成长',
      usage: '短篇小说',
      ending: '治愈',
    },
  },
];

/** 规范化故事大纲草稿，确保所有字段为非空字符串 */
function normalizeStoryOutlineDraft(
  draft?: Partial<StoryOutlineSupplementDraft> | null,
): StoryOutlineSupplementDraft {
  return {
    genre: (draft?.genre || '').trim(),
    protagonist: (draft?.protagonist || '').trim(),
    conflict: (draft?.conflict || '').trim(),
    usage: (draft?.usage || '').trim(),
    ending: (draft?.ending || '').trim(),
    extraNotes: (draft?.extraNotes || '').trim(),
  };
}

/** 根据工作流守卫项的标签和提示推断对应的故事大纲字段键 */
function inferOutlineFieldKeyFromGuardItem(
  item: NonNullable<MessageMeta['workflowGuard']>['items'][number],
): StoryOutlineFieldKey | null {
  const text = `${item.label || ''} ${item.hint || ''}`.toLowerCase();
  if (text.includes('题材') || text.includes('类型') || text.includes('风格')) {
    return 'genre';
  }
  if (
    text.includes('主角') ||
    text.includes('主人公') ||
    text.includes('角色') ||
    text.includes('人物')
  ) {
    return 'protagonist';
  }
  if (
    text.includes('冲突') ||
    text.includes('目标') ||
    text.includes('阻拦') ||
    text.includes('阻碍') ||
    text.includes('矛盾')
  ) {
    return 'conflict';
  }
  if (
    text.includes('篇幅') ||
    text.includes('用途') ||
    text.includes('体裁') ||
    text.includes('形式') ||
    text.includes('短视频') ||
    text.includes('动画')
  ) {
    return 'usage';
  }
  if (
    text.includes('结局') ||
    text.includes('走向') ||
    text.includes('he') ||
    text.includes('be') ||
    text.includes('反转') ||
    text.includes('开放')
  ) {
    return 'ending';
  }
  return null;
}

/** 判断工作流守卫是否为故事大纲类型 */
function isStoryOutlineGuard(workflowGuard?: MessageMeta['workflowGuard']) {
  if (!workflowGuard) {
    return false;
  }

  const combined = `${workflowGuard.title || ''} ${workflowGuard.summary || ''} ${workflowGuard.items
    .map((item) => `${item.label || ''} ${item.hint || ''}`)
    .join(' ')}`;

  const hasOutlineKeyword = /故事大纲|大纲|题材|主角|冲突|篇幅|用途|结局|he|be|反转|治愈/i.test(
    combined,
  );
  const hasMappedRequiredField = workflowGuard.items.some(
    (item) => item.required && inferOutlineFieldKeyFromGuardItem(item),
  );
  return hasOutlineKeyword && hasMappedRequiredField;
}

/** 将故事大纲草稿格式化为可读的文本行列表 */
function formatStoryOutlineDraftLines(draft: StoryOutlineSupplementDraft) {
  const lines: string[] = [];
  if (draft.genre) lines.push(`题材类型：${draft.genre}`);
  if (draft.protagonist) lines.push(`核心主角：${draft.protagonist}`);
  if (draft.conflict) lines.push(`核心冲突：${draft.conflict}`);
  if (draft.usage) lines.push(`篇幅用途：${draft.usage}`);
  if (draft.ending) lines.push(`结局方向：${draft.ending}`);
  if (draft.extraNotes) lines.push(`补充说明：${draft.extraNotes}`);
  return lines;
}

/** 构建包含故事大纲补充设定的确认回复文本 */
function buildStoryOutlineConfirmReply(baseReply: string, draft: StoryOutlineSupplementDraft) {
  const normalizedBase = baseReply.trim();
  const lines = formatStoryOutlineDraftLines(draft);
  if (lines.length === 0) {
    return normalizedBase;
  }
  return `${normalizedBase}\n\n补充设定（用于故事大纲）：\n- ${lines.join('\n- ')}\n\n请按以上设定优先生成大纲；仍缺失的项请用最小假设补齐并标注假设。`;
}

/** 单条消息项的属性类型定义 */
type MessageItemProps = {
  message: Message;
  agent: AgentContact | undefined;
  agentContacts: AgentContact[];
  activeAssets: Asset[];
  currentProjectId: string | null;
  canEditUserMessage: boolean;
  onOptimizeStoryOutlineDraft: (
    draft: StoryOutlineSupplementDraft,
  ) => Promise<StoryOutlineSupplementDraft>;
  onWorkflowGuardConfirm: (
    messageId: string,
    suggestedReply: string,
    isAssistantActionGuard: boolean,
  ) => void;
  isSubmittingWorkflowGuard: boolean;
  isWorkflowGuardPending: boolean;
  isWorkflowGuardConfirmed: boolean;
  onMentionClick: (name: string) => void;
  onEditUserMessage: (message: Message) => void;
  onRevokeUserMessage: (message: Message) => void;
  onDeleteMessage: (message: Message) => void;
  onCopyMessage: (message: Message) => void;
  canDeleteMessage: boolean;
  canCopyMessage: boolean;
  isRewindingMessage: boolean;
  isDeletingMessage: boolean;
};

/** 单条消息渲染组件，支持用户/系统/AI消息展示、工作流守卫、Markdown渲染等功能 */
const MessageItem = React.memo<MessageItemProps>(
  ({
    message,
    agent,
    agentContacts,
    activeAssets,
    currentProjectId,
    canEditUserMessage,
    onOptimizeStoryOutlineDraft,
    onWorkflowGuardConfirm,
    isSubmittingWorkflowGuard,
    isWorkflowGuardPending,
    isWorkflowGuardConfirmed,
    onMentionClick,
    onEditUserMessage,
    onRevokeUserMessage,
    onDeleteMessage,
    onCopyMessage,
    canDeleteMessage,
    canCopyMessage,
    isRewindingMessage,
    isDeletingMessage,
  }) => {
    const isError = message.role === 'system' && message.status === 'error';
    const meta = message.meta;
    const canDeleteCurrentMessage = canDeleteMessage && message.role === 'user';
    const canCopyCurrentMessage =
      canCopyMessage && (message.role === 'user' || message.role === 'ai');
    const canCopyInActionBar = canCopyCurrentMessage && message.role === 'user';
    const canCopyInMetaRow = canCopyCurrentMessage && message.role === 'ai';
    const showMessageActions =
      canCopyInActionBar ||
      canDeleteCurrentMessage ||
      (message.role === 'user' && canEditUserMessage);

    /** 获取任务状态的中文标签 */
    const getTaskStatusLabel = (status?: MessageMeta['taskStatus']) => {
      switch (status) {
        case 'queued':
          return '排队中';
        case 'running':
          return '执行中';
        case 'completed':
          return '已完成';
        case 'failed':
          return '失败';
        case 'missing':
          return '任务缺失';
        case 'scope_mismatch':
          return '作用域异常';
        default:
          return null;
      }
    };

    /** 获取任务状态对应的颜色标识 */
    const getTaskStatusColor = (status?: MessageMeta['taskStatus']) => {
      switch (status) {
        case 'completed':
          return 'green';
        case 'failed':
        case 'missing':
        case 'scope_mismatch':
          return 'red';
        case 'running':
          return 'arcoblue';
        case 'queued':
          return 'orange';
        default:
          return undefined;
      }
    };

    /** 获取运行时状态的中文标签 */
    const getRuntimeStatusLabel = (status?: MessageMeta['agentStatus']) => {
      switch (status) {
        case 'busy':
          return '忙碌';
        case 'queued':
          return '排队';
        case 'idle':
          return '空闲';
        default:
          return null;
      }
    };

    /** 格式化输出类型为中文标签 */
    const formatOutputKind = (value?: MessageMeta['outputKind']) => {
      switch (value) {
        case 'image':
          return '图片';
        case 'video':
          return '视频';
        case 'audio':
          return '音频';
        case 'document':
          return '文档';
        case 'text':
          return '文本';
        default:
          return value || null;
      }
    };

    const taskStatusLabel = getTaskStatusLabel(meta?.taskStatus);
    const runtimeStatusLabel = getRuntimeStatusLabel(meta?.agentStatus);
    const outputKindLabel = formatOutputKind(meta?.outputKind);
    const visibleLastError =
      meta?.lastError && !(message.status === 'error' && message.content.includes(meta.lastError))
        ? meta.lastError
        : null;
    const assistantActions = (
      Array.isArray(meta?.assistantActions) ? meta.assistantActions : []
    ) as NonNullable<MessageMeta['assistantActions']>;
    const workflowGuard = meta?.workflowGuard as MessageMeta['workflowGuard'] | undefined;
    const resourceRefs = (
      Array.isArray(meta?.resourceRefs) ? meta.resourceRefs : EMPTY_RESOURCE_REFS
    ) as ResourceRef[];
    const isAssistantActionGuard = assistantActions.some(
      (item) => item.status === 'needs_confirmation',
    );
    const isStoryOutlineWorkflowGuard = useMemo(
      () => isStoryOutlineGuard(workflowGuard),
      [workflowGuard],
    );

    const hasExecutionMeta = Boolean(
      taskStatusLabel ||
      meta?.attemptIndex ||
      meta?.isRedo ||
      runtimeStatusLabel ||
      visibleLastError ||
      outputKindLabel ||
      assistantActions.length,
    );

    const [isExpanded, setIsExpanded] = useState(false);
    const [storyOutlineDraft, setStoryOutlineDraft] =
      useState<StoryOutlineSupplementDraft>(EMPTY_STORY_OUTLINE_DRAFT);
    const [optimizedStoryOutlineDraft, setOptimizedStoryOutlineDraft] =
      useState<StoryOutlineSupplementDraft | null>(null);
    const [appliedOptimizationSnapshot, setAppliedOptimizationSnapshot] = useState<{
      before: StoryOutlineSupplementDraft;
      optimized: StoryOutlineSupplementDraft;
    } | null>(null);
    const [isOptimizingStoryOutlineDraft, setIsOptimizingStoryOutlineDraft] = useState(false);

    const workflowGuardSignature = useMemo(() => {
      if (!workflowGuard) {
        return '';
      }
      return `${workflowGuard.title || ''}::${workflowGuard.summary || ''}::${workflowGuard.items
        .map((item) => `${item.label}:${item.done}:${item.required}:${item.hint || ''}`)
        .join('|')}`;
    }, [workflowGuard]);

    useEffect(() => {
      if (!isStoryOutlineWorkflowGuard) {
        setStoryOutlineDraft(EMPTY_STORY_OUTLINE_DRAFT);
        setOptimizedStoryOutlineDraft(null);
        setAppliedOptimizationSnapshot(null);
        setIsOptimizingStoryOutlineDraft(false);
        return;
      }

      setStoryOutlineDraft(EMPTY_STORY_OUTLINE_DRAFT);
      setOptimizedStoryOutlineDraft(null);
      setAppliedOptimizationSnapshot(null);
      setIsOptimizingStoryOutlineDraft(false);
    }, [isStoryOutlineWorkflowGuard, message.id, workflowGuardSignature]);

    const storyOutlineFieldCompletion = useMemo(
      () => ({
        genre: Boolean(storyOutlineDraft.genre.trim()),
        protagonist: Boolean(storyOutlineDraft.protagonist.trim()),
        conflict: Boolean(storyOutlineDraft.conflict.trim()),
        usage: Boolean(storyOutlineDraft.usage.trim()),
        ending: Boolean(storyOutlineDraft.ending.trim()),
      }),
      [storyOutlineDraft],
    );

    const workflowGuardItemsWithCompletion = useMemo(() => {
      if (!workflowGuard) {
        return [];
      }
      return workflowGuard.items.map((item: WorkflowGuardItem): WorkflowGuardItemWithCompletion => {
        const mappedField = isStoryOutlineWorkflowGuard
          ? inferOutlineFieldKeyFromGuardItem(item)
          : null;
        const completedViaDraft = Boolean(mappedField && storyOutlineFieldCompletion[mappedField]);
        const effectiveDone = item.done || completedViaDraft;
        return {
          item,
          effectiveDone,
          completedViaDraft: !item.done && completedViaDraft,
        };
      });
    }, [workflowGuard, isStoryOutlineWorkflowGuard, storyOutlineFieldCompletion]);

    const workflowGuardProgress = useMemo(() => {
      const total = workflowGuardItemsWithCompletion.length;
      const completed = workflowGuardItemsWithCompletion.filter(
        (entry: WorkflowGuardItemWithCompletion) => entry.effectiveDone,
      ).length;
      const requiredTotal = workflowGuardItemsWithCompletion.filter(
        (entry: WorkflowGuardItemWithCompletion) => entry.item.required,
      ).length;
      const requiredDone = workflowGuardItemsWithCompletion.filter(
        (entry: WorkflowGuardItemWithCompletion) => entry.item.required && entry.effectiveDone,
      ).length;
      const missingRequiredLabels = workflowGuardItemsWithCompletion
        .filter(
          (entry: WorkflowGuardItemWithCompletion) => entry.item.required && !entry.effectiveDone,
        )
        .map((entry: WorkflowGuardItemWithCompletion) => entry.item.label);
      const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
      return {
        total,
        completed,
        requiredTotal,
        requiredDone,
        percent,
        missingRequiredLabels,
      };
    }, [workflowGuardItemsWithCompletion]);

    const hasStoryOutlineInput = useMemo(
      () => Object.values(storyOutlineDraft).some((value) => Boolean(value.trim())),
      [storyOutlineDraft],
    );
    const shouldEnforceStoryOutlineRequiredFields =
      isStoryOutlineWorkflowGuard && workflowGuardProgress.requiredTotal > 0;
    const hasMissingRequiredStoryOutlineField =
      shouldEnforceStoryOutlineRequiredFields &&
      workflowGuardProgress.requiredDone < workflowGuardProgress.requiredTotal;
    const storyOutlineConfirmHint = hasMissingRequiredStoryOutlineField
      ? `还缺 ${workflowGuardProgress.requiredTotal - workflowGuardProgress.requiredDone} 项必填：${workflowGuardProgress.missingRequiredLabels.join('、')}`
      : '';

    const finalWorkflowGuardReply = useMemo(() => {
      const baseReply = workflowGuard?.suggestedReply || '';
      if (!baseReply.trim()) {
        return '';
      }
      if (!isStoryOutlineWorkflowGuard) {
        return baseReply;
      }
      return buildStoryOutlineConfirmReply(
        baseReply,
        normalizeStoryOutlineDraft(storyOutlineDraft),
      );
    }, [workflowGuard?.suggestedReply, isStoryOutlineWorkflowGuard, storyOutlineDraft]);

    const handleApplyOutlinePreset = (values: Partial<StoryOutlineSupplementDraft>) => {
      setStoryOutlineDraft((previous) => ({
        ...previous,
        ...normalizeStoryOutlineDraft({
          ...previous,
          ...values,
        }),
      }));
    };

    const handleOptimizeStoryOutline = async () => {
      if (!hasStoryOutlineInput || isOptimizingStoryOutlineDraft) {
        return;
      }
      setIsOptimizingStoryOutlineDraft(true);
      try {
        const optimized = await onOptimizeStoryOutlineDraft(
          normalizeStoryOutlineDraft(storyOutlineDraft),
        );
        setOptimizedStoryOutlineDraft(normalizeStoryOutlineDraft(optimized));
      } catch {
        // onOptimizeStoryOutlineDraft 内部已 showToast，此处仅阻止未捕获拒绝
      } finally {
        setIsOptimizingStoryOutlineDraft(false);
      }
    };

    const handleApplyOptimizedStoryOutline = () => {
      if (!optimizedStoryOutlineDraft) {
        return;
      }
      setAppliedOptimizationSnapshot({
        before: storyOutlineDraft,
        optimized: optimizedStoryOutlineDraft,
      });
      setStoryOutlineDraft(optimizedStoryOutlineDraft);
      setOptimizedStoryOutlineDraft(null);
    };

    const handleDiscardOptimizedStoryOutline = () => {
      setOptimizedStoryOutlineDraft(null);
    };

    const handleUndoAppliedOptimization = () => {
      if (!appliedOptimizationSnapshot) {
        return;
      }
      setStoryOutlineDraft(appliedOptimizationSnapshot.before);
      setAppliedOptimizationSnapshot(null);
    };
    const deferredContent = useDeferredValue(message.content);
    const isStreaming = message.status === 'pending';
    const processedMarkdown = useMemo(() => {
      let rawContent = deferredContent || '';
      if (!rawContent) {
        return '';
      }

      /**
       * 修复常见的 Markdown 格式问题
       * 0. 修复流式分片导致的结构黏连（标题/列表/分隔线被拼在一行）
       * 1. 标题缺少空格：##标题 → ## 标题
       * 2. 列表项缺少空格：-项目 → - 项目
       * 3. 有序列表缺少空格：1.项目 → 1. 项目
       */
      rawContent = rawContent
        .replace(/(#{1,6}[^\n#]+)(#{1,6})(?=[^#\s\n])/g, '$1\n$2')
        .replace(/([。！？；：.!?])\s*(#{1,6})(?=[^#\s\n])/g, '$1\n$2')
        .replace(/---(?=#{1,6})/g, '---\n')
        .replace(/([。！？；：.!?])\s*-(?=[^\s\n-])/g, '$1\n- ')
        .replace(/([。！？；：.!?])\s*(\d+\.)(?=[^\s\n])/g, '$1\n$2 ')
        .replace(/([\u4e00-\u9fa5])-(?=(\*\*|[\u4e00-\u9fa5]))/g, '$1\n- ')
        .replace(/([：:])\s*(\d+\.)(?=[^\s])/g, '$1\n$2 ')
        .replace(/^(#{1,6})([^#\s\n])/gm, '$1 $2')
        .replace(/^(\s*[-*+])([^\s])/gm, '$1 $2')
        .replace(/^(\s*\d+\.)([^\s])/gm, '$1 $2');

      /**
       * 流式输出时修复不完整的 Markdown 结构
       * 避免未闭合的语法导致 ReactMarkdown 渲染异常
       */
      if (isStreaming) {
        const codeBlockCount = (rawContent.match(/```/g) || []).length;
        if (codeBlockCount % 2 !== 0) {
          rawContent += '\n```';
        }
        const inlineCodeCount = (rawContent.match(/(?<!`)`(?!`)/g) || []).length;
        if (inlineCodeCount % 2 !== 0) {
          rawContent += '`';
        }
        const boldCount = (rawContent.match(/\*\*/g) || []).length;
        if (boldCount % 2 !== 0) {
          rawContent += '**';
        }
        const italicCount = (rawContent.match(/(?<!\*)\*(?!\*)/g) || []).length;
        if (italicCount % 2 !== 0) {
          rawContent += '*';
        }
        const strikethroughCount = (rawContent.match(/~~/g) || []).length;
        if (strikethroughCount % 2 !== 0) {
          rawContent += '~~';
        }
        if (
          rawContent.endsWith('\n-') ||
          rawContent.endsWith('\n*') ||
          rawContent.endsWith('\n+')
        ) {
          rawContent = rawContent.slice(0, -2);
        }
      }

      const hasAgentMention = rawContent.includes('@');
      const hasAssetMention = rawContent.includes('#');
      if (!hasAgentMention && !hasAssetMention && resourceRefs.length === 0) {
        return rawContent;
      }

      let processedContent = rawContent.replace(
        /#([^#\n<]+?)<asset:([^>\s]+)>/g,
        (_match: string, rawName: string, assetId: string) =>
          `[#${rawName.trim()}](#asset-id:${assetId.trim()})`,
      );

      if (hasAgentMention && agentContacts.length > 0) {
        const agentNames = [
          ...new Set(agentContacts.map((agent) => agent.name).filter(Boolean)),
        ].sort((a, b) => b.length - a.length);
        agentNames.forEach((name) => {
          const escapedName = escapeRegExp(name);
          const regex = new RegExp(`(?<!\\w)@${escapedName}(?!\\w)`, 'g');
          processedContent = processedContent.replace(regex, `[@${name}](#mention-${name})`);
        });
      }

      if ((hasAssetMention || resourceRefs.length > 0) && activeAssets.length > 0) {
        const assetNameById = new Map(activeAssets.map((asset) => [asset.id, asset.name]));
        resourceRefs.forEach((resourceRef) => {
          const assetName = assetNameById.get(resourceRef.id) || resourceRef.name;
          const escapedName = escapeRegExp(assetName);
          const regex = new RegExp(`(?<![\\w\\[])#${escapedName}(?!\\w)`, 'g');
          processedContent = processedContent.replace(
            regex,
            `[#${assetName}](#asset-id:${resourceRef.id})`,
          );
        });

        if (hasAssetMention) {
          const assetNames = [
            ...new Set(activeAssets.map((asset) => asset.name).filter(Boolean)),
          ].sort((a, b) => b.length - a.length);
          assetNames.forEach((name) => {
            const escapedName = escapeRegExp(name);
            const regex = new RegExp(`(?<![\\w\\[])#${escapedName}(?!\\w)`, 'g');
            processedContent = processedContent.replace(
              regex,
              `[#${name}](#asset-name:${encodeURIComponent(name)})`,
            );
          });
        }
      }

      return processedContent;
    }, [deferredContent, isStreaming, agentContacts, activeAssets, resourceRefs]);

    /** Markdown 自定义链接渲染组件，处理 @提及 和 #资源引用 */
    const markdownComponents = {
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }) => {
        if (href?.startsWith('#mention-')) {
          const agentName = (children as string).replace(/^@/, '');
          const mentionedAgent = agentContacts.find((a) => a.name === agentName);
          if (!mentionedAgent) {
            return <span className={`${styles.mentionPill} ${styles.missing}`}>{children}</span>;
          }

          return (
            <Tooltip content={`${mentionedAgent.role} · ${mentionedAgent.status || '在线'}`}>
              <span
                className={`${styles.mentionPill} ${styles[mentionedAgent.status || 'idle']}`}
                onClick={() => onMentionClick(agentName)}
              >
                <span className={styles.statusDot} />
                {children}
              </span>
            </Tooltip>
          );
        }

        if (href?.startsWith('#asset-')) {
          const encodedValue = href.slice('#asset-'.length);
          const [mode, rawValue] = encodedValue.split(':', 2);
          const assetValue = rawValue ? decodeURIComponent(rawValue) : '';
          const mentionedAsset = resolveMentionedAsset(
            activeAssets,
            resourceRefs,
            currentProjectId,
            mode,
            assetValue,
          );
          return (
            <Tooltip
              content={
                mentionedAsset
                  ? `${formatAssetTypeLabel(mentionedAsset.type)} · ID ${mentionedAsset.id}`
                  : '项目资源引用'
              }
            >
              <span className={styles.assetPill}>{children}</span>
            </Tooltip>
          );
        }

        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--bg-accent)', fontWeight: 500 }}
            {...props}
          >
            {children}
          </a>
        );
      },
    };

    return (
      <div
        className={[
          styles.messageWrapper,
          message.role === 'user' ? styles.user : '',
          message.role === 'ai' ? styles.ai : '',
          message.role === 'system' ? styles.system : '',
          isError ? styles.error : '',
        ].join(' ')}
      >
        <Avatar
          size={34}
          style={{
            backgroundColor:
              message.role === 'user'
                ? 'var(--color-primary-light-1)'
                : message.role === 'system'
                  ? 'var(--color-danger-light-1)'
                  : 'var(--color-fill-3)',
          }}
        >
          {message.role === 'user' ? 'U' : message.role === 'system' ? '!' : <Bot size={18} />}
        </Avatar>
        <div className={styles.messageBody}>
          {showMessageActions && (
            <div className={styles.userMessageActions}>
              {message.role === 'user' && canEditUserMessage && (
                <>
                  <button
                    type="button"
                    className={styles.userMessageActionBtn}
                    onClick={() => onEditUserMessage(message)}
                    disabled={isRewindingMessage || isDeletingMessage}
                    title="编辑重发"
                  >
                    <PencilLine size={13} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.userMessageActionBtn} ${styles.revoke}`}
                    onClick={() => onRevokeUserMessage(message)}
                    disabled={isRewindingMessage || isDeletingMessage}
                    title="撤回消息"
                  >
                    <Undo2 size={13} />
                  </button>
                </>
              )}
              {canDeleteCurrentMessage && (
                <Popconfirm
                  focusLock
                  title="确认删除该条聊天记录吗？"
                  onOk={() => onDeleteMessage(message)}
                  disabled={isRewindingMessage || isDeletingMessage}
                >
                  <button
                    type="button"
                    className={`${styles.userMessageActionBtn} ${styles.messageDelete}`}
                    disabled={isRewindingMessage || isDeletingMessage}
                    title="删除消息"
                  >
                    <Trash2 size={13} />
                  </button>
                </Popconfirm>
              )}
              {canCopyInActionBar && (
                <button
                  type="button"
                  className={styles.userMessageActionBtn}
                  onClick={() => onCopyMessage(message)}
                  disabled={isRewindingMessage || isDeletingMessage}
                  title="复制消息"
                >
                  <Copy size={13} />
                </button>
              )}
            </div>
          )}
          <div className={styles.messageBodyInner}>
            <div className={styles.messageContent}>
              <div className={styles.markdownContainer}>
                {isError && message.content && message.content.length > 300 ? (
                  <>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {isExpanded ? processedMarkdown : `${processedMarkdown.substring(0, 300)}...`}
                    </ReactMarkdown>
                    <button
                      type="button"
                      className={styles.expandButton}
                      onClick={() => setIsExpanded(!isExpanded)}
                    >
                      {isExpanded ? '收起' : '展开'}
                    </button>
                  </>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {processedMarkdown}
                  </ReactMarkdown>
                )}
              </div>

              {message.attachments && message.attachments.length > 0 && (
                <FilePreview attachments={message.attachments} />
              )}
            </div>

            {message.role === 'ai' && workflowGuard && workflowGuard.items.length > 0 && (
              <div className={styles.workflowGuardCard}>
                <div className={styles.workflowGuardHeader}>
                  <div>
                    <div className={styles.workflowGuardTitle}>{workflowGuard.title}</div>
                    {workflowGuard.summary && (
                      <div className={styles.workflowGuardSummary}>{workflowGuard.summary}</div>
                    )}
                  </div>
                  <Tag
                    color={
                      isWorkflowGuardConfirmed
                        ? 'green'
                        : isWorkflowGuardPending
                          ? 'arcoblue'
                          : 'orange'
                    }
                    size="small"
                  >
                    {isWorkflowGuardConfirmed
                      ? '已确认'
                      : isWorkflowGuardPending
                        ? '提交中'
                        : '待确认'}
                  </Tag>
                </div>
                <div className={styles.workflowGuardProgress}>
                  <div className={styles.workflowGuardProgressHeader}>
                    <span>
                      进度 {workflowGuardProgress.completed}/{workflowGuardProgress.total}
                    </span>
                    <span>
                      必填 {workflowGuardProgress.requiredDone}/
                      {workflowGuardProgress.requiredTotal}
                    </span>
                  </div>
                  <div className={styles.workflowGuardProgressTrack}>
                    <div
                      className={styles.workflowGuardProgressFill}
                      style={{ width: `${workflowGuardProgress.percent}%` }}
                    />
                  </div>
                </div>
                <div className={styles.workflowGuardList}>
                  {workflowGuardItemsWithCompletion.map(
                    (
                      { item, effectiveDone, completedViaDraft }: WorkflowGuardItemWithCompletion,
                      index: number,
                    ) => (
                      <div key={`${item.label}-${index}`} className={styles.workflowGuardItem}>
                        <div className={styles.workflowGuardIcon}>
                          {effectiveDone ? (
                            <CircleCheckBig size={15} />
                          ) : item.required ? (
                            <AlertCircle size={15} />
                          ) : (
                            <Circle size={15} />
                          )}
                        </div>
                        <div className={styles.workflowGuardText}>
                          <div className={styles.workflowGuardItemLabel}>
                            {item.label}
                            {item.required && (
                              <span className={styles.workflowGuardRequired}>必需</span>
                            )}
                            {completedViaDraft && (
                              <span className={styles.workflowGuardProvidedTag}>已补充</span>
                            )}
                          </div>
                          {item.hint && <div className={styles.workflowGuardHint}>{item.hint}</div>}
                        </div>
                      </div>
                    ),
                  )}
                </div>
                {isStoryOutlineWorkflowGuard && (
                  <div className={styles.storyOutlineGuardPanel}>
                    <div className={styles.storyOutlineGuardTitle}>
                      补充设定（必填未完成时不可生成）
                    </div>
                    <div className={styles.storyOutlineGuardQuickRow}>
                      {STORY_OUTLINE_QUICK_PRESETS.map((preset) => (
                        <Button
                          key={preset.label}
                          size="mini"
                          type="secondary"
                          onClick={() => handleApplyOutlinePreset(preset.values)}
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                    <div className={styles.storyOutlineGuardGrid}>
                      <div className={styles.storyOutlineGuardField}>
                        <div className={styles.storyOutlineGuardLabel}>题材类型</div>
                        <Select
                          size="small"
                          allowClear
                          placeholder="选择题材类型"
                          value={storyOutlineDraft.genre || undefined}
                          onChange={(value) =>
                            setStoryOutlineDraft((previous) => ({
                              ...previous,
                              genre: typeof value === 'string' ? value : '',
                            }))
                          }
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        >
                          {STORY_OUTLINE_GENRE_OPTIONS.map((option) => (
                            <Select.Option key={option} value={option}>
                              {option}
                            </Select.Option>
                          ))}
                        </Select>
                      </div>
                      <div className={styles.storyOutlineGuardField}>
                        <div className={styles.storyOutlineGuardLabel}>核心主角</div>
                        <Input
                          size="small"
                          placeholder="例如：女高中生，能听见别人没说出口的话"
                          value={storyOutlineDraft.protagonist}
                          onChange={(value) =>
                            setStoryOutlineDraft((previous) => ({
                              ...previous,
                              protagonist: value,
                            }))
                          }
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        />
                      </div>
                      <div className={styles.storyOutlineGuardField}>
                        <div className={styles.storyOutlineGuardLabel}>核心冲突</div>
                        <TextArea
                          autoSize={{ minRows: 2, maxRows: 4 }}
                          placeholder="主角想得到什么，被什么阻拦"
                          value={storyOutlineDraft.conflict}
                          onChange={(value) =>
                            setStoryOutlineDraft((previous) => ({
                              ...previous,
                              conflict: value,
                            }))
                          }
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        />
                      </div>
                      <div className={styles.storyOutlineGuardField}>
                        <div className={styles.storyOutlineGuardLabel}>篇幅用途</div>
                        <Select
                          size="small"
                          allowClear
                          placeholder="选择用途"
                          value={storyOutlineDraft.usage || undefined}
                          onChange={(value) =>
                            setStoryOutlineDraft((previous) => ({
                              ...previous,
                              usage: typeof value === 'string' ? value : '',
                            }))
                          }
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        >
                          {STORY_OUTLINE_USAGE_OPTIONS.map((option) => (
                            <Select.Option key={option} value={option}>
                              {option}
                            </Select.Option>
                          ))}
                        </Select>
                      </div>
                      <div className={styles.storyOutlineGuardField}>
                        <div className={styles.storyOutlineGuardLabel}>结局方向</div>
                        <Select
                          size="small"
                          allowClear
                          placeholder="可选"
                          value={storyOutlineDraft.ending || undefined}
                          onChange={(value) =>
                            setStoryOutlineDraft((previous) => ({
                              ...previous,
                              ending: typeof value === 'string' ? value : '',
                            }))
                          }
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                        >
                          {STORY_OUTLINE_ENDING_OPTIONS.map((option) => (
                            <Select.Option key={option} value={option}>
                              {option}
                            </Select.Option>
                          ))}
                        </Select>
                      </div>
                    </div>
                    <div className={styles.storyOutlineGuardField}>
                      <div className={styles.storyOutlineGuardLabel}>补充说明</div>
                      <TextArea
                        autoSize={{ minRows: 3, maxRows: 5 }}
                        placeholder="可补充背景设定、目标受众、禁忌点等"
                        value={storyOutlineDraft.extraNotes}
                        onChange={(value) =>
                          setStoryOutlineDraft((previous) => ({
                            ...previous,
                            extraNotes: value,
                          }))
                        }
                        disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                      />
                    </div>

                    <div className={styles.storyOutlineGuardAiActions}>
                      <Button
                        size="mini"
                        type="secondary"
                        loading={isOptimizingStoryOutlineDraft}
                        disabled={
                          isWorkflowGuardPending ||
                          isWorkflowGuardConfirmed ||
                          !hasStoryOutlineInput
                        }
                        onClick={() => {
                          void handleOptimizeStoryOutline();
                        }}
                      >
                        AI优化补充
                      </Button>
                      {appliedOptimizationSnapshot && (
                        <Button
                          size="mini"
                          type="secondary"
                          disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                          onClick={handleUndoAppliedOptimization}
                        >
                          撤销已应用优化
                        </Button>
                      )}
                    </div>

                    {optimizedStoryOutlineDraft && (
                      <div className={styles.storyOutlineOptimizationCard}>
                        <div className={styles.storyOutlineOptimizationTitle}>
                          AI 优化建议（未应用）
                        </div>
                        <div className={styles.storyOutlineOptimizationBody}>
                          {formatStoryOutlineDraftLines(optimizedStoryOutlineDraft).length > 0 ? (
                            formatStoryOutlineDraftLines(optimizedStoryOutlineDraft).map(
                              (line, index) => (
                                <div
                                  key={`${line}-${index}`}
                                  className={styles.storyOutlineOptimizationLine}
                                >
                                  {line}
                                </div>
                              ),
                            )
                          ) : (
                            <div className={styles.storyOutlineOptimizationLine}>
                              未返回可应用内容，建议手动调整。
                            </div>
                          )}
                        </div>
                        <div className={styles.storyOutlineOptimizationActions}>
                          <Button
                            size="mini"
                            type="primary"
                            disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                            onClick={handleApplyOptimizedStoryOutline}
                          >
                            应用优化
                          </Button>
                          <Button
                            size="mini"
                            type="secondary"
                            disabled={isWorkflowGuardPending || isWorkflowGuardConfirmed}
                            onClick={handleDiscardOptimizedStoryOutline}
                          >
                            取消应用
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className={styles.workflowGuardActions}>
                  {storyOutlineConfirmHint && (
                    <div className={styles.workflowGuardActionHint}>{storyOutlineConfirmHint}</div>
                  )}
                  <Button
                    type="primary"
                    size="small"
                    loading={isSubmittingWorkflowGuard}
                    disabled={
                      isWorkflowGuardConfirmed ||
                      isWorkflowGuardPending ||
                      !finalWorkflowGuardReply ||
                      hasMissingRequiredStoryOutlineField
                    }
                    onClick={() =>
                      !isWorkflowGuardConfirmed &&
                      !isWorkflowGuardPending &&
                      finalWorkflowGuardReply &&
                      onWorkflowGuardConfirm(
                        message.id,
                        finalWorkflowGuardReply,
                        isAssistantActionGuard,
                      )
                    }
                  >
                    {isWorkflowGuardConfirmed
                      ? '已确认'
                      : isWorkflowGuardPending
                        ? '提交中'
                        : workflowGuard.confirmLabel || '确认继续'}
                  </Button>
                </div>
              </div>
            )}

            {hasExecutionMeta && (
              <div className={styles.executionMetaPanel}>
                <div className={styles.executionTagRow}>
                  {taskStatusLabel && (
                    <Tag size="small" color={getTaskStatusColor(meta?.taskStatus)}>
                      {taskStatusLabel}
                    </Tag>
                  )}
                  {(meta?.taskStatus === 'running' || meta?.taskStatus === 'queued') &&
                    meta?.taskId && (
                      <button
                        className={styles.cancelTaskBtn}
                        onClick={() => cancelTask(meta.taskId!).catch(() => {})}
                        title="取消此任务"
                        type="button"
                      >
                        <Square size={12} />
                        取消
                      </button>
                    )}
                  {typeof meta?.attemptIndex === 'number' && meta.attemptIndex > 0 && (
                    <Tag size="small" color={meta.isRedo ? 'magenta' : 'purple'}>
                      {meta.isRedo
                        ? `重做第 ${meta.attemptIndex} 次`
                        : `第 ${meta.attemptIndex} 次`}
                    </Tag>
                  )}
                  {outputKindLabel && (
                    <Tag size="small">
                      {outputKindLabel}
                      {typeof meta?.outputItems === 'number' && meta.outputItems > 1
                        ? ` ×${meta.outputItems}`
                        : ''}
                    </Tag>
                  )}
                </div>
                {(runtimeStatusLabel || typeof meta?.activeTasks === 'number') && (
                  <div className={styles.executionHint}>
                    运行态{runtimeStatusLabel ? `：${runtimeStatusLabel}` : ''}
                    {typeof meta?.activeTasks === 'number' ? ` · 执行中 ${meta.activeTasks}` : ''}
                  </div>
                )}
                {visibleLastError && (
                  <div
                    className={styles.executionHint}
                    style={{ color: 'var(--color-danger-light-4)' }}
                  >
                    上次失败：{visibleLastError}
                  </div>
                )}
                {assistantActions.length > 0 && (
                  <div className={styles.executionHint}>
                    {assistantActions.map((item) => item.summary).join('；')}
                  </div>
                )}
              </div>
            )}

            {(agent || message.model || canCopyInMetaRow) && (
              <div className={styles.messageMetaRow}>
                {agent && (
                  <Tag
                    size="small"
                    color="blue"
                    bordered
                    style={{ fontSize: '10px', height: '18px', lineHeight: '16px' }}
                  >
                    {agent.name}
                  </Tag>
                )}
                {message.model && (
                  <Tag
                    size="small"
                    style={{ fontSize: '10px', height: '18px', lineHeight: '16px' }}
                  >
                    {message.model}
                  </Tag>
                )}
                {canCopyInMetaRow && (
                  <button
                    type="button"
                    className={styles.metaCopyBtn}
                    onClick={() => onCopyMessage(message)}
                    disabled={isRewindingMessage || isDeletingMessage}
                    title="复制回复"
                  >
                    <Copy size={11} />
                    复制
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prev, next) => {
    if (prev.message.id !== next.message.id) return false;
    if (prev.message.content !== next.message.content) return false;
    if (prev.message.meta !== next.message.meta) return false;
    if (prev.message.status !== next.message.status) return false;
    if (prev.message.role !== next.message.role) return false;
    if (prev.canEditUserMessage !== next.canEditUserMessage) return false;
    if (prev.isSubmittingWorkflowGuard !== next.isSubmittingWorkflowGuard) return false;
    if (prev.isWorkflowGuardPending !== next.isWorkflowGuardPending) return false;
    if (prev.isWorkflowGuardConfirmed !== next.isWorkflowGuardConfirmed) return false;
    if (prev.canDeleteMessage !== next.canDeleteMessage) return false;
    if (prev.canCopyMessage !== next.canCopyMessage) return false;
    if (prev.isRewindingMessage !== next.isRewindingMessage) return false;
    if (prev.isDeletingMessage !== next.isDeletingMessage) return false;
    return true;
  },
);

MessageItem.displayName = 'MessageItem';

/** 任务分组项的属性类型定义 */
type TaskGroupItemProps = {
  group: {
    id: string;
    type: string;
    title: string;
    status?: string;
    messages: Message[];
    messageCount: number;
    aiMessageCount: number;
    hasError: boolean;
    taskId?: string;
  };
  isCollapsed: boolean;
  isTaskGroup: boolean;
  onToggle: () => void;
  activeAgentsMap: Map<string, AgentContact>;
  agentContacts: AgentContact[];
  activeAssets: Asset[];
  currentProjectId: string | null;
  canEditUserMessage: boolean;
  onOptimizeStoryOutlineDraft: (
    draft: StoryOutlineSupplementDraft,
  ) => Promise<StoryOutlineSupplementDraft>;
  onWorkflowGuardConfirm: (
    messageId: string,
    suggestedReply: string,
    isAssistantActionGuard: boolean,
  ) => void;
  submittingWorkflowGuardId: string | null;
  pendingWorkflowGuardIds: Set<string>;
  confirmedWorkflowGuardIds: Set<string>;
  onMentionClick: (name: string) => void;
  onEditUserMessage: (msg: Message) => void;
  onRevokeUserMessage: (msg: Message) => void;
  onDeleteMessage: (msg: Message) => void;
  onCopyMessage: (msg: Message) => void;
  rewindingMessageId: string | null;
  deletingMessageId: string | null;
};

/** 任务分组渲染组件，支持折叠/展开、分组标题、消息列表展示 */
export const TaskGroupItem = React.memo<TaskGroupItemProps>(
  ({ group, isCollapsed, isTaskGroup, onToggle, ...itemProps }) => {
    return (
      <div className={`${styles.taskGroup} ${isCollapsed ? styles.taskGroupCollapsed : ''}`}>
        {isTaskGroup && (
          <div className={styles.taskGroupHeader} onClick={onToggle}>
            <span className={styles.taskGroupToggle}>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
            <span className={styles.taskGroupTitle}>{group.title}</span>
            <span className={styles.taskGroupMeta}>
              <Tag
                size="small"
                color={group.hasError ? 'red' : group.status === 'completed' ? 'green' : 'blue'}
              >
                {group.hasError ? (
                  <>
                    <AlertTriangle size={10} style={{ marginRight: 3 }} /> 异常
                  </>
                ) : group.status === 'completed' ? (
                  <>
                    <CheckCircle2 size={10} style={{ marginRight: 3 }} /> 已完成
                  </>
                ) : (
                  <>
                    <Clock size={10} style={{ marginRight: 3 }} /> 处理中
                  </>
                )}
              </Tag>
              <span className={styles.taskGroupCount}>{group.aiMessageCount} 条回复</span>
            </span>
          </div>
        )}
        {!isCollapsed &&
          group.messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              agent={message.agentId ? itemProps.activeAgentsMap.get(message.agentId) : undefined}
              agentContacts={itemProps.agentContacts}
              activeAssets={itemProps.activeAssets}
              currentProjectId={itemProps.currentProjectId}
              canEditUserMessage={itemProps.canEditUserMessage}
              onOptimizeStoryOutlineDraft={itemProps.onOptimizeStoryOutlineDraft}
              onWorkflowGuardConfirm={itemProps.onWorkflowGuardConfirm}
              isSubmittingWorkflowGuard={itemProps.submittingWorkflowGuardId === message.id}
              isWorkflowGuardPending={itemProps.pendingWorkflowGuardIds.has(message.id)}
              isWorkflowGuardConfirmed={itemProps.confirmedWorkflowGuardIds.has(message.id)}
              onMentionClick={itemProps.onMentionClick}
              onEditUserMessage={itemProps.onEditUserMessage}
              onRevokeUserMessage={itemProps.onRevokeUserMessage}
              onDeleteMessage={itemProps.onDeleteMessage}
              onCopyMessage={itemProps.onCopyMessage}
              canDeleteMessage={true}
              canCopyMessage={true}
              isRewindingMessage={itemProps.rewindingMessageId === message.id}
              isDeletingMessage={itemProps.deletingMessageId === message.id}
            />
          ))}
        {isCollapsed && isTaskGroup && (
          <div className={styles.taskGroupPreview}>
            {group.messages
              .slice(1)
              .slice(-1)
              .map((msg) => (
                <div key={msg.id} className={styles.previewText}>
                  {msg.content.slice(0, 120).replace(/[#*\n]/g, ' ') +
                    (msg.content.length > 120 ? '...' : '')}
                </div>
              ))}
          </div>
        )}
      </div>
    );
  },
  (prev, next) => {
    if (prev.isCollapsed !== next.isCollapsed) return false;
    if (prev.group.id !== next.group.id) return false;
    if (prev.group.messageCount !== next.group.messageCount) return false;
    if (prev.group.status !== next.group.status) return false;
    if (prev.group.hasError !== next.group.hasError) return false;
    if (prev.canEditUserMessage !== next.canEditUserMessage) return false;
    if (prev.submittingWorkflowGuardId !== next.submittingWorkflowGuardId) return false;
    if (prev.pendingWorkflowGuardIds !== next.pendingWorkflowGuardIds) return false;
    if (prev.confirmedWorkflowGuardIds !== next.confirmedWorkflowGuardIds) return false;
    if (prev.rewindingMessageId !== next.rewindingMessageId) return false;
    if (prev.deletingMessageId !== next.deletingMessageId) return false;
    const prevLastContent = prev.group.messages[prev.group.messages.length - 1]?.content;
    const nextLastContent = next.group.messages[next.group.messages.length - 1]?.content;
    if (prevLastContent !== nextLastContent) return false;
    return true;
  },
);

TaskGroupItem.displayName = 'TaskGroupItem';
