import type { Asset, Message, MessageAttachment, MessageMeta, ResourceRef } from '../../../../types';

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatAssetTypeLabel(type?: Asset['type'] | ResourceRef['type']) {
  switch (type) {
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'audio':
      return '音频';
    default:
      return '文档';
  }
}

function isResourceMentionBoundary(value: string | undefined) {
  return !value || /[\s,.;:!?()[\]{}<>，。；：！？、]/.test(value);
}

function toResourceRef(asset: Asset): ResourceRef {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
  };
}

export function mergeResourceRefs(...groups: Array<ResourceRef[] | undefined>) {
  const merged: ResourceRef[] = [];
  const seen = new Set<string>();

  groups.forEach((group) => {
    group?.forEach((resourceRef) => {
      if (!resourceRef.id || seen.has(resourceRef.id)) {
        return;
      }
      seen.add(resourceRef.id);
      merged.push(resourceRef);
    });
  });

  return merged;
}

export function buildAssetMentionValue(asset: Asset) {
  return `${asset.name}<asset:${asset.id}>`;
}

function countAssetNameMentions(content: string, assetName: string) {
  let count = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '#') {
      continue;
    }
    if (!content.startsWith(assetName, index + 1)) {
      continue;
    }
    if (!isResourceMentionBoundary(content[index + 1 + assetName.length])) {
      continue;
    }
    count += 1;
  }

  return count;
}

export function parseInputResourceSelections(content: string, assets: Asset[]) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedRefs: ResourceRef[] = [];
  const nextValue = content.replace(
    /#([^#\n<]+?)<asset:([^>\s]+)>/g,
    (_, rawName: string, assetId: string) => {
      const asset = assetsById.get(assetId.trim());
      if (!asset) {
        return `#${rawName.trim()}`;
      }
      selectedRefs.push(toResourceRef(asset));
      return `#${asset.name}`;
    },
  );

  return {
    nextValue,
    selectedRefs: mergeResourceRefs(selectedRefs),
  };
}

export function reconcileDraftResourceRefs(content: string, refs: ResourceRef[], assets: Asset[]) {
  if (refs.length === 0 || assets.length === 0) {
    return [];
  }

  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const kept: ResourceRef[] = [];
  const usedByName = new Map<string, number>();
  const seen = new Set<string>();

  refs.forEach((resourceRef) => {
    const asset = assetsById.get(resourceRef.id);
    if (!asset || seen.has(asset.id)) {
      return;
    }

    const mentionCount = countAssetNameMentions(content, asset.name);
    const usedCount = usedByName.get(asset.name) ?? 0;
    if (usedCount >= mentionCount) {
      return;
    }

    usedByName.set(asset.name, usedCount + 1);
    seen.add(asset.id);
    kept.push(toResourceRef(asset));
  });

  return kept;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

export function scoreAssetSearch(
  asset: Asset,
  projectName: string,
  query: string,
  currentProjectId: string | null,
) {
  const normalizedQuery = normalizeSearchText(query);
  const currentProjectBonus = asset.projectId === currentProjectId ? 30 : 0;

  if (!normalizedQuery) {
    return currentProjectBonus + (asset.createdAt || 0) / 1_000_000_000_000;
  }

  const tokens = normalizedQuery.split(/[\s:：]+/).filter(Boolean);
  const name = asset.name.toLowerCase();
  const project = projectName.toLowerCase();
  const typeLabel = formatAssetTypeLabel(asset.type).toLowerCase();
  const versionLabel = (asset.versionLabel || '当前版').toLowerCase();
  const id = asset.id.toLowerCase();

  let matchScore = 0;

  tokens.forEach((token) => {
    if (name === token) {
      matchScore += 180;
      return;
    }
    if (name.startsWith(token)) {
      matchScore += 120;
    } else if (name.includes(token)) {
      matchScore += 80;
    }

    if (project.startsWith(token)) {
      matchScore += 60;
    } else if (project.includes(token)) {
      matchScore += 36;
    }

    if (typeLabel.includes(token)) {
      matchScore += 32;
    }

    if (versionLabel.includes(token)) {
      matchScore += 24;
    }

    if (id.includes(token)) {
      matchScore += 18;
    }
  });

  if (matchScore === 0) {
    return 0;
  }

  return matchScore + currentProjectBonus;
}

export function resolveMentionedAsset(
  activeAssets: Asset[],
  resourceRefs: ResourceRef[],
  currentProjectId: string | null,
  mode: string,
  assetValue: string,
) {
  if (mode === 'id') {
    return activeAssets.find((asset) => asset.id === assetValue);
  }

  const sortCandidates = (left: Asset, right: Asset) => {
    const leftCurrent = left.projectId === currentProjectId ? 1 : 0;
    const rightCurrent = right.projectId === currentProjectId ? 1 : 0;
    if (leftCurrent !== rightCurrent) {
      return rightCurrent - leftCurrent;
    }
    return right.createdAt - left.createdAt;
  };

  const referencedCandidates = activeAssets
    .filter(
      (asset) =>
        asset.name === assetValue &&
        resourceRefs.some((resourceRef) => resourceRef.id === asset.id),
    )
    .sort(sortCandidates);

  if (referencedCandidates.length > 0) {
    return referencedCandidates[0];
  }

  return activeAssets.filter((asset) => asset.name === assetValue).sort(sortCandidates)[0];
}

export type CollaborationReadinessHint = {
  ready: boolean;
  entryMessageId?: string;
  reason: string;
  signals: string[];
};

const COLLAB_CREATIVE_KEYWORDS = [
  '短剧',
  '视频',
  '故事',
  '剧情',
  '剧本',
  '分镜',
  '角色',
  '大纲',
  '广告',
  '宣传片',
  '产品',
  '海报',
];

const COLLAB_DETAIL_KEYWORDS = [
  '受众',
  '人群',
  '平台',
  '风格',
  '集',
  '分钟',
  '预算',
  '目标',
  '主题',
  '卖点',
  '节奏',
  '场景',
];

export function detectCollaborationReadiness(
  messages: Message[],
  hasActiveProject: boolean,
): CollaborationReadinessHint {
  if (!hasActiveProject) {
    return { ready: false, reason: '需要先进入项目对话', signals: [] };
  }

  const userMessages = messages.filter(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  );
  const completedAiMessages = messages.filter(
    (message) =>
      message.role === 'ai' &&
      message.status !== 'pending' &&
      message.content.trim().length > 0,
  );

  if (userMessages.length === 0 || completedAiMessages.length === 0) {
    return { ready: false, reason: '需要至少一轮用户需求和 AI 回复', signals: [] };
  }

  const combined = messages
    .map((message) => message.content)
    .join('\n')
    .toLowerCase();
  const creativeSignals = COLLAB_CREATIVE_KEYWORDS.filter((keyword) =>
    combined.includes(keyword.toLowerCase()),
  );
  const detailSignals = COLLAB_DETAIL_KEYWORDS.filter((keyword) =>
    combined.includes(keyword.toLowerCase()),
  );
  const explicitReady = /可以开始|开始制作|进入制作|生成大纲|确认方案|按这个做|就这样/.test(
    combined,
  );
  const enoughConversation = userMessages.length >= 2 || combined.length >= 180;
  const ready =
    creativeSignals.length > 0 &&
    (explicitReady || enoughConversation || detailSignals.length >= 2);

  return {
    ready,
    entryMessageId: completedAiMessages[completedAiMessages.length - 1]?.id,
    reason: ready
      ? '基础创意信息已具备进入制作协同的条件'
      : '还需要继续补充创意目标、受众、结构或风格',
    signals: [...creativeSignals.slice(0, 3), ...detailSignals.slice(0, 3)],
  };
}

export function extractMessageResourceRefs(
  message: { meta?: MessageMeta } | null | undefined,
): ResourceRef[] {
  if (!message || !Array.isArray(message.meta?.resourceRefs)) {
    return [];
  }

  return message.meta.resourceRefs.filter(
    (item) =>
      item &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.type === 'string',
  );
}

export function extractMessageAttachments(
  message: { attachments?: MessageAttachment[]; meta?: MessageMeta } | null | undefined,
) {
  if (!message) {
    return [] as MessageAttachment[];
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return message.attachments;
  }

  if (Array.isArray(message.meta?.attachments)) {
    return message.meta.attachments.filter(
      (item) =>
        item &&
        typeof item.url === 'string' &&
        typeof item.name === 'string' &&
        typeof item.mimeType === 'string' &&
        typeof item.sizeBytes === 'number',
    );
  }

  return [] as MessageAttachment[];
}
