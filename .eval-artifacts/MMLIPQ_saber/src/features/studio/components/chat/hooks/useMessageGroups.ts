/**
 * useMessageGroups - 消息分组与滚动管理 Hook
 *
 * 将消息按任务/步骤分组，管理滚动加载、折叠状态、会话切换时的增量水合等逻辑。
 */
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { Message } from '../../../../../types';

/** 初始可见分组数量 */
export const INITIAL_GROUP_WINDOW_SIZE = 10;
/** 每次加载更多的分组增量 */
export const GROUP_WINDOW_INCREMENT = 10;
/** 触发加载更早记录的滚动阈值（像素） */
export const LOAD_MORE_TOP_THRESHOLD_PX = 120;
/** 会话切换时初始可见分组数量 */
export const SESSION_SWITCH_INITIAL_GROUP_WINDOW_SIZE = 24;
/** 会话切换时增量水合的块大小 */
export const SESSION_SWITCH_HYDRATE_CHUNK_SIZE = 24;
/** 会话切换时自动水合的最大分组数量 */
export const SESSION_SWITCH_AUTO_HYDRATE_MAX_GROUPS = 80;

/** 空消息数组常量，避免每次渲染创建新引用 */
export const EMPTY_MESSAGES: Message[] = [];

/** 消息分组类型定义 */
export type MessageGroup = {
  id: string;
  type: 'user_task' | 'ai_response' | 'system' | 'standalone';
  title: string;
  status?: string;
  messages: Message[];
  messageCount: number;
  aiMessageCount: number;
  hasError: boolean;
  taskId?: string;
};

/** useMessageGroups 的参数 */
export type UseMessageGroupsParams = {
  /** 当前活跃的消息列表 */
  activeMessages: Message[];
  /** 会话唯一标识，用于触发切换逻辑 */
  conversationKey: string;
  /** AI 是否正在响应 */
  isAiResponding: boolean;
};

/** useMessageGroups 的返回值 */
export type UseMessageGroupsResult = {
  messageGroups: MessageGroup[];
  visibleMessageGroups: MessageGroup[];
  visibleGroupCount: number;
  setVisibleGroupCount: (count: number | ((prev: number) => number)) => void;
  hasHiddenGroups: boolean;
  hiddenGroupCount: number;
  collapsedGroups: Set<string>;
  toggleGroupCollapse: (groupId: string) => void;
  collapseAllGroups: (collapse: boolean) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  bottomRef: React.RefObject<HTMLDivElement>;
  isAtBottomRef: React.MutableRefObject<boolean>;
  scrollFrameRef: React.MutableRefObject<number | null>;
  handleScroll: () => void;
  loadOlderGroups: () => void;
};

/**
 * 将消息按任务/步骤分组的 Hook
 *
 * @param params - 包含 activeMessages、conversationKey、isAiResponding 的参数对象
 * @returns 消息分组状态与滚动控制方法
 */
export function useMessageGroups(params: UseMessageGroupsParams): UseMessageGroupsResult {
  const { activeMessages, conversationKey, isAiResponding } = params;

  /** 任务折叠状态：key = groupId, value = 是否折叠 */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /** 消息组窗口：默认渲染最近一段，向上滚动再增量加载更早内容 */
  const [visibleGroupCount, setVisibleGroupCount] = useState(INITIAL_GROUP_WINDOW_SIZE);

  const scrollRef = useRef<HTMLDivElement>(null!);
  const bottomRef = useRef<HTMLDivElement>(null!);
  const isAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const lastAutoLoadAtRef = useRef(0);
  const messageGroupCountRef = useRef(0);
  const isSwitchHydratingRef = useRef(false);
  const switchHydrationFrameRef = useRef<number | null>(null);
  const previousGroupCountRef = useRef(0);
  const pendingPrependAdjustmentRef = useRef<{
    previousScrollHeight: number;
    previousScrollTop: number;
  } | null>(null);
  /** 记录上一次消息数量，用于判断是新增还是删除 */
  const prevMessageCountRef = useRef(activeMessages.length);

  /** 切换任务组折叠状态 */
  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  /** 将消息按任务/步骤分组 */
  const messageGroups = useMemo(() => {
    // 确保消息按时间戳升序排序（先发送的消息在前）
    const sortedMessages = [...activeMessages].sort((a, b) => a.timestamp - b.timestamp);
    const groups: MessageGroup[] = [];
    let currentGroup: MessageGroup | null = null;

    for (let i = 0; i < sortedMessages.length; i++) {
      const msg = sortedMessages[i];

      if (msg.role === 'user') {
        if (currentGroup) {
          groups.push(currentGroup);
        }

        const previewText = msg.content.slice(0, 60).replace(/\n/g, ' ');
        const taskId = msg.meta?.taskId;

        currentGroup = {
          id: `task-${msg.id}`,
          type: 'user_task',
          title: previewText + (msg.content.length > 60 ? '...' : ''),
          status: undefined,
          messages: [msg],
          messageCount: 1,
          aiMessageCount: 0,
          hasError: false,
          taskId,
        };
        continue;
      }

      if (currentGroup && (msg.role === 'ai' || msg.role === 'system')) {
        currentGroup.messages.push(msg);
        currentGroup.messageCount++;
        if (msg.role === 'ai') {
          currentGroup.aiMessageCount++;
        }
        if (
          msg.status === 'error' ||
          msg.meta?.taskStatus === 'failed' ||
          msg.meta?.taskStatus === 'missing'
        ) {
          currentGroup.hasError = true;
          currentGroup.status = msg.meta?.taskStatus || 'error';
        } else if (msg.status === 'done' || msg.meta?.taskStatus === 'completed') {
          currentGroup.status = 'completed';
        }
        continue;
      }

      if (!currentGroup) {
        groups.push({
          id: `standalone-${msg.id}`,
          type: 'standalone',
          title: msg.role === 'system' ? '系统消息' : msg.content.slice(0, 40),
          status: msg.status || msg.meta?.taskStatus,
          messages: [msg],
          messageCount: 1,
          aiMessageCount: msg.role === 'ai' ? 1 : 0,
          hasError: msg.status === 'error',
          taskId: msg.meta?.taskId,
        });
      }
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }, [activeMessages]);

  messageGroupCountRef.current = messageGroups.length;

  const hiddenGroupCount = Math.max(0, messageGroups.length - visibleGroupCount);
  const hasHiddenGroups = hiddenGroupCount > 0;
  const visibleMessageGroups = useMemo(
    () => (hasHiddenGroups ? messageGroups.slice(-visibleGroupCount) : messageGroups),
    [hasHiddenGroups, messageGroups, visibleGroupCount],
  );

  /** 全部展开/折叠 */
  const collapseAllGroups = useCallback(
    (collapse: boolean) => {
      setCollapsedGroups(collapse ? new Set(messageGroups.map((g) => g.id)) : new Set());
    },
    [messageGroups],
  );

  /** 加载更早的分组 */
  const loadOlderGroups = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !hasHiddenGroups || pendingPrependAdjustmentRef.current) {
      return;
    }

    pendingPrependAdjustmentRef.current = {
      previousScrollHeight: container.scrollHeight,
      previousScrollTop: container.scrollTop,
    };
    setVisibleGroupCount((current) =>
      Math.min(messageGroups.length, current + GROUP_WINDOW_INCREMENT),
    );
  }, [hasHiddenGroups, messageGroups.length]);

  /** 同步滚动状态，判断是否在底部及是否需要加载更多 */
  const syncScrollState = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (
      scrollTop <= LOAD_MORE_TOP_THRESHOLD_PX &&
      hasHiddenGroups &&
      now - lastAutoLoadAtRef.current > 160
    ) {
      lastAutoLoadAtRef.current = now;
      loadOlderGroups();
    }
  }, [hasHiddenGroups, loadOlderGroups]);

  /** 处理滚动事件，使用 rAF 节流 */
  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      syncScrollState();
    });
  }, [syncScrollState]);

  /** 在 visibleGroupCount 变化后修正滚动位置，防止内容前插入导致跳动 */
  useLayoutEffect(() => {
    const adjustment = pendingPrependAdjustmentRef.current;
    const container = scrollRef.current;
    if (!adjustment || !container) {
      return;
    }

    const delta = container.scrollHeight - adjustment.previousScrollHeight;
    container.scrollTop = adjustment.previousScrollTop + delta;
    pendingPrependAdjustmentRef.current = null;
  }, [visibleGroupCount]);

  /** 当新消息到来且用户在底部时，自动滚动到底部（仅在消息增加时触发） */
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = activeMessages.length;
    prevMessageCountRef.current = currentCount;

    // 只在消息数量增加时（新增消息）才自动滚动
    // 删除/回滚等操作导致消息减少时不触发滚动，保持用户当前位置
    if (isAtBottomRef.current && currentCount > prevCount) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [activeMessages.length, isAiResponding]);

  /** 组件卸载时清理 rAF */
  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  /** 会话切换时的增量水合逻辑：先显示少量分组，再逐步加载更多 */
  useEffect(() => {
    if (switchHydrationFrameRef.current !== null) {
      cancelAnimationFrame(switchHydrationFrameRef.current);
      switchHydrationFrameRef.current = null;
    }
    const groupCount = messageGroupCountRef.current;
    isSwitchHydratingRef.current = true;
    previousGroupCountRef.current = groupCount;
    const targetAutoVisibleCount =
      groupCount === 0
        ? INITIAL_GROUP_WINDOW_SIZE
        : Math.min(groupCount, SESSION_SWITCH_AUTO_HYDRATE_MAX_GROUPS);
    const initialVisibleCount =
      groupCount === 0
        ? INITIAL_GROUP_WINDOW_SIZE
        : Math.min(targetAutoVisibleCount, SESSION_SWITCH_INITIAL_GROUP_WINDOW_SIZE);
    setVisibleGroupCount(initialVisibleCount);
    pendingPrependAdjustmentRef.current = null;
    isAtBottomRef.current = true;
    lastAutoLoadAtRef.current = 0;

    if (targetAutoVisibleCount <= initialVisibleCount) {
      isSwitchHydratingRef.current = false;
      return;
    }

    let cancelled = false;
    const hydrateStep = () => {
      if (cancelled) {
        return;
      }

      setVisibleGroupCount((current) => {
        const next = Math.min(targetAutoVisibleCount, current + SESSION_SWITCH_HYDRATE_CHUNK_SIZE);
        if (next < targetAutoVisibleCount) {
          switchHydrationFrameRef.current = requestAnimationFrame(hydrateStep);
        } else {
          switchHydrationFrameRef.current = null;
          isSwitchHydratingRef.current = false;
        }
        return next;
      });
    };

    switchHydrationFrameRef.current = requestAnimationFrame(hydrateStep);

    return () => {
      cancelled = true;
      if (switchHydrationFrameRef.current !== null) {
        cancelAnimationFrame(switchHydrationFrameRef.current);
        switchHydrationFrameRef.current = null;
      }
      isSwitchHydratingRef.current = false;
    };
  }, [conversationKey]);

  /** 当分组数量增长时，自动扩展可见窗口 */
  useEffect(() => {
    if (isSwitchHydratingRef.current) {
      previousGroupCountRef.current = messageGroups.length;
      return;
    }

    const previousGroupCount = previousGroupCountRef.current;
    const wasShowingAllGroups = visibleGroupCount >= previousGroupCount;
    if (wasShowingAllGroups && messageGroups.length > visibleGroupCount) {
      const shouldKeepFullyExpanded = previousGroupCount > SESSION_SWITCH_AUTO_HYDRATE_MAX_GROUPS;
      const nextVisibleCount = shouldKeepFullyExpanded
        ? messageGroups.length
        : Math.min(messageGroups.length, SESSION_SWITCH_AUTO_HYDRATE_MAX_GROUPS);
      if (nextVisibleCount !== visibleGroupCount) {
        setVisibleGroupCount(nextVisibleCount);
      }
    }
    previousGroupCountRef.current = messageGroups.length;
  }, [conversationKey, messageGroups.length, visibleGroupCount]);

  return {
    messageGroups,
    visibleMessageGroups,
    visibleGroupCount,
    setVisibleGroupCount,
    hasHiddenGroups,
    hiddenGroupCount,
    collapsedGroups,
    toggleGroupCollapse,
    collapseAllGroups,
    scrollRef,
    bottomRef,
    isAtBottomRef,
    scrollFrameRef,
    handleScroll,
    loadOlderGroups,
  };
}
