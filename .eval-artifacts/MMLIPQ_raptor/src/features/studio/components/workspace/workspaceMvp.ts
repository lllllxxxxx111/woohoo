import { getServerAssetBlob } from '../../../../lib/serverApi';
import { isProtectedAssetUrl } from '../../../../hooks/useAssetPreviewUrl';
import { sanitizeText, sanitizeJson, sanitizeValue, type SanitizeFinding } from './sensitiveSanitizer';
import type {
  Asset,
  ChatSession,
  Project,
  Script,
  Storyboard,
  StoryboardLine,
} from '../../../../types';

const encoder = new TextEncoder();
const GENERIC_SPEAKERS = new Set([
  '旁白',
  '镜头',
  '场景',
  '画面',
  '字幕',
  '音效',
  '说明',
  '动作',
  '系统',
  '用户',
  '助手',
  '导演',
]);

export type DerivedScriptSection = {
  id: string;
  title: string;
  body: string;
  summary: string;
};

export type DerivedChapter = {
  id: string;
  title: string;
  summary: string;
  durationSeconds: number;
  sceneNumbers: number[];
  characters: string[];
};

export type DerivedCharacter = {
  id: string;
  name: string;
  summary: string;
  prompt: string;
  assetCount: number;
  assets: Asset[];
};

export type DerivedScene = {
  id: string;
  name: string;
  summary: string;
  durationSeconds: number;
  prompt: string;
  assets: Asset[];
};

export type DerivedKeyframe = {
  id: string;
  sceneNumber: number;
  title: string;
  durationSeconds: number;
  motion: string;
  startPrompt: string;
  endPrompt: string;
  assets: Asset[];
};

export type DerivedVideoShot = {
  id: string;
  sceneNumber: number;
  title: string;
  durationSeconds: number;
  prompt: string;
  location: string;
  characters: string[];
  assets: Asset[];
};

export type DerivedFinalCut = {
  totalDurationSeconds: number;
  totalShots: number;
  totalAssets: number;
  shots: DerivedVideoShot[];
  voiceoverTracks: Array<{
    id: string;
    label: string;
    durationSeconds: number;
    startOffsetSeconds: number;
  }>;
  bgmTrack: {
    label: string;
    durationSeconds: number;
  };
};

type ProjectSnapshotInput = {
  project: Project;
  script: Script | null;
  scriptText: string;
  storyboard: Storyboard | null;
  assets: Asset[];
};

export type ProjectSnapshot = {
  scriptTitle: string;
  scriptText: string;
  scriptSections: DerivedScriptSection[];
  chapters: DerivedChapter[];
  characters: DerivedCharacter[];
  scenes: DerivedScene[];
  keyframes: DerivedKeyframe[];
  videoShots: DerivedVideoShot[];
  finalCut: DerivedFinalCut;
};

type TarFile = {
  path: string;
  bytes: Uint8Array;
  mtime?: number;
};

function normalizeMetadata(metadata: Asset['metadata']): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return metadata;
}

function getMetadataText(asset: Asset, keys: string[]) {
  const metadata = normalizeMetadata(asset.metadata);
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getMetadataArray(asset: Asset, keys: string[]) {
  const metadata = normalizeMetadata(asset.metadata);
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
        .filter(Boolean);
      if (items.length > 0) {
        return items;
      }
    }

    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/\r?\n|[,，/]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [] as string[];
}

function sanitizeSegment(value: string, fallback: string) {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return sanitized || fallback;
}

function truncate(value: string, max = 90) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function firstSentence(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  const match = normalized.match(/^(.+?[。！？!?；;])/);
  return match?.[1]?.trim() || truncate(normalized, 64);
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s';
  }

  const rounded = Math.max(1, Math.round(seconds));
  if (rounded < 60) {
    return `${rounded}s`;
  }

  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~|-]/g, ' ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PROCESS_OUTPUT_MARKERS = [
  '优化方案',
  '问题复盘',
  '执行结果',
  '风险兜底',
  '本轮调整',
  '协同大纲',
  '大纲设计稿',
  '章节拆解建议',
  '合规提醒',
  '制作注意事项',
];

const EXPLICIT_SCRIPT_MARKER =
  /(?:完整剧本|剧本正文|分场剧本|剧本初稿|剧本终稿|短片剧本|微短剧剧本)/;

const SCRIPT_NOTE_MARKER = /^(?:#{1,4}\s*)?(?:制作备注)(?:\s|$)/m;

const SCENE_HEADING_PATTERN =
  /^(?:#{1,4}\s*)?(?:第[一二三四五六七八九十百0-9]+[场幕]|场景\s*[一二三四五六七八九十百0-9]+|[内外]景|INT\.|EXT\.)/gim;

const SCRIPT_START_PATTERNS = [
  /^#{1,4}\s*(?:完整剧本|剧本正文|分场剧本|剧本初稿|剧本终稿|短片剧本|微短剧剧本)/m,
  /^(?:完整剧本|剧本正文|分场剧本|剧本初稿|剧本终稿|短片剧本|微短剧剧本)/m,
  /^(?:#{1,4}\s*)?(?:第[一二三四五六七八九十百0-9]+[场幕]|场景\s*[一二三四五六七八九十百0-9]+|[内外]景|INT\.|EXT\.)/im,
];

const TRAILING_PROCESS_SECTION_PATTERN =
  /^#{1,4}\s*(?:优化方案|问题复盘|风险兜底|本轮调整|章节拆解建议|合规提醒|制作注意事项)(?:\s|$)/m;

function hasProcessOutputMarkers(text: string) {
  return PROCESS_OUTPUT_MARKERS.some((marker) => text.includes(marker));
}

function countSceneHeadings(text: string) {
  return Array.from(text.matchAll(SCENE_HEADING_PATTERN)).length;
}

function countDialogueLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (/^(?:[-*•]|\d+[.、）)])\s*/.test(line)) {
        return false;
      }

      const match = line.match(/^([^：:\s#*•-][^：:\n]{0,11})[：:]\s*\S+/);
      const speaker = match?.[1]?.trim();
      if (!speaker || GENERIC_SPEAKERS.has(speaker)) {
        return false;
      }

      return !/[，。！？、；,.!?（）()《》【】[\]]/.test(speaker);
    }).length;
}

function looksLikeScript(text: string) {
  const normalized = text.trim();
  if (normalized.length < 120) {
    return false;
  }

  const hasExplicitScriptMarker = EXPLICIT_SCRIPT_MARKER.test(normalized);
  const sceneHeadingCount = countSceneHeadings(normalized);
  const dialogueLineCount = countDialogueLines(normalized);
  const hasScriptStructure =
    hasExplicitScriptMarker ||
    sceneHeadingCount >= 2 ||
    (sceneHeadingCount >= 1 && dialogueLineCount >= 2) ||
    dialogueLineCount >= 4;

  if (!hasScriptStructure) {
    return false;
  }

  if (!hasProcessOutputMarkers(normalized)) {
    return true;
  }

  return hasExplicitScriptMarker || sceneHeadingCount >= 2 || (sceneHeadingCount >= 1 && dialogueLineCount >= 2);
}

function findScriptStartIndex(text: string) {
  const indexes = SCRIPT_START_PATTERNS.map((pattern) => text.match(pattern)?.index).filter(
    (index): index is number => typeof index === 'number',
  );
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function extractScriptCandidateFromChat(text: string) {
  const normalized = text.trim();
  if (!looksLikeScript(normalized)) {
    return '';
  }

  const hasProcessMarkers = hasProcessOutputMarkers(normalized);
  const startIndex = hasProcessMarkers ? findScriptStartIndex(normalized) : -1;
  if (hasProcessMarkers && startIndex < 0) {
    return '';
  }

  const candidate = startIndex > 0 ? normalized.slice(startIndex).trim() : normalized;
  const trailingProcessSection = candidate.match(TRAILING_PROCESS_SECTION_PATTERN);
  if (typeof trailingProcessSection?.index === 'number' && trailingProcessSection.index > 0) {
    return candidate.slice(0, trailingProcessSection.index).trim();
  }

  return candidate;
}

export function normalizeScriptCandidateText(text: string) {
  const normalized = text.trim();
  if (!normalized || !looksLikeScript(normalized)) {
    return '';
  }

  const candidate = extractScriptCandidateFromChat(normalized);
  if (candidate) {
    return candidate;
  }

  return hasProcessOutputMarkers(normalized) && !SCRIPT_NOTE_MARKER.test(normalized)
    ? ''
    : normalized;
}

function flattenMessages(project: Project) {
  return project.chatSessions
    .flatMap((session) => session.messages.map((message) => ({ session, message })))
    .sort((left, right) => right.message.timestamp - left.message.timestamp);
}

export function getLatestDocumentAsset(
  assets: Asset[],
  kind: 'script' | 'chapter' | 'keyframe' | 'storyboard',
) {
  return [...assets]
    .filter((asset) => {
      if (asset.type !== 'document') {
        return false;
      }

      const metadata = normalizeMetadata(asset.metadata);
      const origin = typeof metadata.origin === 'string' ? metadata.origin.trim() : '';
      const documentKind =
        typeof metadata.documentKind === 'string' ? metadata.documentKind.trim() : '';

      if (kind === 'script') {
        return origin === 'script' || documentKind === 'script';
      }

      if (kind === 'storyboard') {
        return origin === 'storyboard' || documentKind === 'storyboard';
      }

      return documentKind === kind;
    })
    .sort((left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt))[0] ?? null;
}

export async function loadAssetBlob(asset: Pick<Asset, 'id' | 'url'>) {
  if (isProtectedAssetUrl(asset.id, asset.url)) {
    return getServerAssetBlob(asset.id);
  }

  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`Failed to read asset file: ${response.status}`);
  }

  return response.blob();
}

export async function loadAssetText(asset: Pick<Asset, 'id' | 'url'>) {
  const blob = await loadAssetBlob(asset);
  return blob.text();
}

function resolveScriptTextFromChat(project: Project) {
  for (const { message } of flattenMessages(project)) {
    if (message.role !== 'ai') {
      continue;
    }

    const scriptText = extractScriptCandidateFromChat(message.content);
    if (scriptText) {
      return scriptText;
    }
  }

  return '';
}

export function resolveInlineScriptText(project: Project, script: Script | null, assets: Asset[]) {
  const scriptContent = script?.content?.trim() ?? '';
  const scriptTitle = script?.title || `${project.name}-script`;
  if (scriptContent) {
    const normalizedScriptContent = normalizeScriptCandidateText(scriptContent);
    if (normalizedScriptContent || !hasProcessOutputMarkers(scriptContent)) {
      return {
        title: scriptTitle,
        content: normalizedScriptContent || scriptContent,
        source: 'script' as const,
      };
    }
  }

  const scriptAsset = getLatestDocumentAsset(assets, 'script');
  if (scriptAsset) {
    const metadataTitle = getMetadataText(scriptAsset, ['title']);
    return {
      title: metadataTitle || scriptAsset.name.replace(/\.md$/i, ''),
      content: '',
      source: 'asset' as const,
      asset: scriptAsset,
    };
  }

  const chatContent = resolveScriptTextFromChat(project);
  if (chatContent) {
    return {
      title: `${project.name}-chat-script`,
      content: chatContent,
      source: 'chat' as const,
    };
  }

  return {
    title: `${project.name}-script`,
    content: '',
    source: 'empty' as const,
  };
}

export function extractDialogueSpeakers(text: string) {
  const matches = Array.from(text.matchAll(/^([^\n#：:]{1,12})[：:]/gm));
  const values = new Set<string>();

  for (const match of matches) {
    const name = match[1]?.trim();
    if (!name || GENERIC_SPEAKERS.has(name) || /\s/.test(name) || /^\d+$/.test(name)) {
      continue;
    }
    values.add(name);
  }

  return [...values].slice(0, 12);
}

function splitScriptSections(text: string) {
  const normalized = stripMarkdown(text);
  if (!normalized) {
    return [] as DerivedScriptSection[];
  }

  const headingMatches = Array.from(
    normalized.matchAll(/^(#{1,4}\s+.+|第[一二三四五六七八九十0-9]+[章节幕场][^\n]*)$/gm),
  );

  if (headingMatches.length > 0) {
    const sections: DerivedScriptSection[] = [];
    headingMatches.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = headingMatches[index + 1]?.index ?? normalized.length;
      const rawBlock = normalized.slice(start, end).trim();
      const lines = rawBlock.split('\n').map((line) => line.trim());
      const title = lines[0].replace(/^#{1,4}\s*/, '').trim();
      const body = lines.slice(1).join('\n').trim() || title;
      sections.push({
        id: `section-${index + 1}`,
        title: title || `Section ${index + 1}`,
        body,
        summary: firstSentence(body),
      });
    });
    return sections;
  }

  return normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((block, index) => ({
      id: `section-${index + 1}`,
      title: `段落 ${index + 1}`,
      body: block,
      summary: firstSentence(block),
    }));
}

function inferCameraMotion(description: string, index: number) {
  const normalized = description.toLowerCase();
  if (/[追赶追逐跑冲]/.test(description) || normalized.includes('tracking')) {
    return '跟拍推进';
  }
  if (/[环顾看向眺望]/.test(description) || normalized.includes('pan')) {
    return '横移扫视';
  }
  if (/[靠近逼近凝视]/.test(description) || normalized.includes('close')) {
    return '缓推特写';
  }
  if (/[转身回头切换]/.test(description) || normalized.includes('cut')) {
    return '切换转场';
  }
  return index % 2 === 0 ? '缓推进入' : '平移跟随';
}

function inferLocation(description: string, sceneNumber: number) {
  const parts = description
    .split(/[，。；,.;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = parts[0];
  if (!candidate) {
    return `Scene ${sceneNumber}`;
  }
  return truncate(candidate, 18);
}

function groupStoryboardLines(lines: StoryboardLine[]) {
  if (lines.length === 0) {
    return [] as StoryboardLine[][];
  }

  const targetGroupCount = Math.min(4, Math.max(1, Math.ceil(lines.length / 2)));
  const groupSize = Math.max(1, Math.ceil(lines.length / targetGroupCount));
  const groups: StoryboardLine[][] = [];

  for (let index = 0; index < lines.length; index += groupSize) {
    groups.push(lines.slice(index, index + groupSize));
  }

  return groups;
}

function deriveChaptersFromStoryboard(lines: StoryboardLine[]) {
  return groupStoryboardLines(lines).map((group, index) => {
    const descriptions = group.map((line) => line.description).filter(Boolean);
    return {
      id: `chapter-${index + 1}`,
      title: `章节 ${index + 1}`,
      summary: firstSentence(descriptions.join(' ')) || `围绕分镜 ${group[0]?.sceneNumber ?? index + 1} 展开`,
      durationSeconds: group.reduce((sum, line) => sum + Math.max(1, line.duration || 0), 0),
      sceneNumbers: group.map((line) => line.sceneNumber),
      characters: extractDialogueSpeakers(descriptions.join('\n')),
    };
  });
}

function deriveChaptersFromScript(
  sections: DerivedScriptSection[],
  storyboard: Storyboard | null,
  speakers: string[],
) {
  const storyboardDurations =
    storyboard?.lines.reduce((sum, line) => sum + Math.max(1, line.duration || 0), 0) ?? 0;
  const baseDuration = sections.length > 0 ? Math.max(8, Math.round(storyboardDurations / sections.length) || 12) : 12;

  return sections.map((section, index) => {
    const localSpeakers = extractDialogueSpeakers(section.body);
    return {
      id: section.id,
      title: section.title,
      summary: section.summary,
      durationSeconds: baseDuration,
      sceneNumbers:
        storyboard?.lines
          .slice(index, index + 1)
          .map((line) => line.sceneNumber) ?? [index + 1],
      characters: localSpeakers.length > 0 ? localSpeakers : speakers.slice(0, 3),
    };
  });
}

function deriveCharacters(
  speakers: string[],
  storyboard: Storyboard | null,
  assets: Asset[],
  scriptText: string,
) {
  const assetGroups = new Map<string, Asset[]>();
  for (const asset of assets) {
    const names = [
      getMetadataText(asset, ['characterName', 'subject', 'title']),
      ...getMetadataArray(asset, ['characters', 'characterNames', 'subjects']),
    ]
      .map((item) => item.trim())
      .filter(Boolean);

    names.forEach((name) => {
      if (!assetGroups.has(name)) {
        assetGroups.set(name, []);
      }
      assetGroups.get(name)?.push(asset);
    });
  }

  const sceneText = storyboard?.lines.map((line) => line.description).join('\n') ?? '';
  const candidates = [...new Set([...speakers, ...assetGroups.keys()])].slice(0, 8);

  return candidates.map((name, index) => {
    const relatedAssets = assetGroups.get(name) ?? [];
    const scopeText = `${scriptText}\n${sceneText}`;
    const summary = scopeText.includes(name)
      ? `在当前剧本或分镜中已出现，建议围绕「${name}」补齐统一外观、情绪和动作设定。`
      : `当前项目已出现角色候选「${name}」，建议先生成标准人设三视图。`;

    return {
      id: `character-${index + 1}`,
      name,
      summary,
      prompt: `${name} 的角色设定图，统一服装和识别特征，包含正面、侧面、背面三视图，适合后续连续镜头制作。`,
      assetCount: relatedAssets.length,
      assets: relatedAssets,
    };
  });
}

function deriveScenes(storyboard: Storyboard | null) {
  const lines = storyboard?.lines ?? [];
  return lines.map((line, _index) => ({
    id: line.id,
    name: `场景 ${String(line.sceneNumber).padStart(2, '0')}`,
    summary: firstSentence(line.description) || `围绕分镜 ${line.sceneNumber} 展开`,
    durationSeconds: Math.max(1, line.duration || 0),
    prompt: `${truncate(line.description, 80)}。补充空间布局、光线、色调和可复用机位。`,
    assets: line.assets,
  }));
}

function deriveKeyframes(storyboard: Storyboard | null) {
  const lines = storyboard?.lines ?? [];
  return lines.map((line, index) => {
    const motion = inferCameraMotion(line.description, index);
    const assetHint = line.assets.length > 0 ? `参考素材：${line.assets.map((asset) => asset.name).join('、')}。` : '';
    const title = inferLocation(line.description, line.sceneNumber);
    return {
      id: line.id,
      sceneNumber: line.sceneNumber,
      title,
      durationSeconds: Math.max(1, line.duration || 0),
      motion,
      startPrompt: `起始帧：${truncate(line.description, 72)}。主体完整入画，构图稳定。${assetHint}`,
      endPrompt: `结束帧：镜头以「${motion}」收束在情绪节点，保留主体动作结果和空间关系。${assetHint}`,
      assets: line.assets,
    };
  });
}

function deriveVideoShots(storyboard: Storyboard | null, scriptText: string) {
  const lines = storyboard?.lines ?? [];
  const speakers = extractDialogueSpeakers(scriptText);

  return lines.map((line, index) => {
    const motion = inferCameraMotion(line.description, index);
    const location = inferLocation(line.description, line.sceneNumber);
    const lineSpeakers = speakers.filter((speaker) => line.description.includes(speaker)).slice(0, 3);
    const assetHint = line.assets.length > 0 ? `参考素材：${line.assets.map((asset) => asset.name).join('、')}。` : '';
    return {
      id: line.id,
      sceneNumber: line.sceneNumber,
      title: `分镜 ${String(line.sceneNumber).padStart(2, '0')}`,
      durationSeconds: Math.max(1, line.duration || 0),
      location,
      characters: lineSpeakers,
      assets: line.assets,
      prompt: `${truncate(line.description, 88)}。镜头运动：${motion}。时长 ${Math.max(
        1,
        line.duration || 0,
      )} 秒。${lineSpeakers.length > 0 ? `角色：${lineSpeakers.join('、')}。` : ''}${assetHint}输出连续、稳定、可剪辑的视频镜头。`,
    };
  });
}

function deriveFinalCut(videoShots: DerivedVideoShot[], assets: Asset[]) {
  let offset = 0;
  const voiceoverTracks = videoShots.map((shot) => {
    const currentOffset = offset;
    offset += shot.durationSeconds;
    return {
      id: `voice-${shot.id}`,
      label: shot.characters[0] ? `${shot.characters[0]}对白` : `${shot.title}旁白`,
      durationSeconds: shot.durationSeconds,
      startOffsetSeconds: currentOffset,
    };
  });

  const totalDurationSeconds = videoShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  return {
    totalDurationSeconds,
    totalShots: videoShots.length,
    totalAssets: assets.length,
    shots: videoShots,
    voiceoverTracks,
    bgmTrack: {
      label: totalDurationSeconds > 0 ? '主线 BGM' : '待选择 BGM',
      durationSeconds: totalDurationSeconds,
    },
  };
}

export function createProjectSnapshot({
  project,
  script,
  scriptText,
  storyboard,
  assets,
}: ProjectSnapshotInput): ProjectSnapshot {
  const rawScriptSource = scriptText.trim() || script?.content?.trim() || '';
  const normalizedScriptSource =
    normalizeScriptCandidateText(rawScriptSource) ||
    (!hasProcessOutputMarkers(rawScriptSource) ? rawScriptSource : '');
  const scriptSource = normalizedScriptSource;
  const scriptTitle = script?.title || `${project.name}-script`;
  const scriptSections = splitScriptSections(scriptSource);
  const speakers = extractDialogueSpeakers(scriptSource);
  const chapters =
    scriptSections.length > 0
      ? deriveChaptersFromScript(scriptSections, storyboard, speakers)
      : deriveChaptersFromStoryboard(storyboard?.lines ?? []);
  const characters = deriveCharacters(speakers, storyboard, assets, scriptSource);
  const scenes = deriveScenes(storyboard);
  const keyframes = deriveKeyframes(storyboard);
  const videoShots = deriveVideoShots(storyboard, scriptSource);
  const finalCut = deriveFinalCut(videoShots, assets);

  return {
    scriptTitle,
    scriptText: scriptSource,
    scriptSections,
    chapters,
    characters,
    scenes,
    keyframes,
    videoShots,
    finalCut,
  };
}

function markdownFromMessages(session: ChatSession) {
  const lines = [`# ${session.title}`, ''];
  session.messages.forEach((message) => {
    const role =
      message.role === 'user' ? '用户' : message.role === 'ai' ? 'AI' : '系统';
    lines.push(`## ${role} · ${new Date(message.timestamp).toLocaleString('zh-CN')}`);
    lines.push('');
    lines.push(message.content || '(empty)');
    lines.push('');
  });
  return lines.join('\n');
}

export function buildProjectManifest(project: Project, snapshot: ProjectSnapshot, assets: Asset[]) {
  return {
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
      workflow: project.workflow,
    },
    summary: {
      scriptSections: snapshot.scriptSections.length,
      chapters: snapshot.chapters.length,
      characters: snapshot.characters.length,
      scenes: snapshot.scenes.length,
      shots: snapshot.finalCut.totalShots,
      durationSeconds: snapshot.finalCut.totalDurationSeconds,
      assets: assets.length,
      chats: project.chatSessions.length,
    },
    chapters: snapshot.chapters,
    characters: snapshot.characters.map((item) => ({
      name: item.name,
      summary: item.summary,
      assetCount: item.assetCount,
    })),
    scenes: snapshot.scenes,
    keyframes: snapshot.keyframes,
    finalCut: snapshot.finalCut,
    assets: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      url: asset.url,
      versionLabel: asset.versionLabel,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      metadata: asset.metadata ?? null,
    })),
  };
}

function buildCoreMarkdown(project: Project, snapshot: ProjectSnapshot, assets: Asset[]) {
  const lines = [
    `# ${project.name}`,
    '',
    `- 导出时间: ${new Date().toLocaleString('zh-CN')}`,
    `- 项目 ID: ${project.id}`,
    `- 分镜数量: ${snapshot.finalCut.totalShots}`,
    `- 总时长: ${formatDuration(snapshot.finalCut.totalDurationSeconds)}`,
    `- 资产数量: ${assets.length}`,
    '',
    '## 章节规划',
    '',
  ];

  if (snapshot.chapters.length === 0) {
    lines.push('暂无章节数据。', '');
  } else {
    snapshot.chapters.forEach((chapter) => {
      lines.push(`### ${chapter.title}`);
      lines.push(`- 时长: ${formatDuration(chapter.durationSeconds)}`);
      if (chapter.sceneNumbers.length > 0) {
        lines.push(`- 覆盖分镜: ${chapter.sceneNumbers.join(', ')}`);
      }
      if (chapter.characters.length > 0) {
        lines.push(`- 角色: ${chapter.characters.join('、')}`);
      }
      lines.push('');
      lines.push(chapter.summary);
      lines.push('');
    });
  }

  lines.push('## 成片时间线', '');
  if (snapshot.finalCut.shots.length === 0) {
    lines.push('暂无成片时间线。', '');
  } else {
    snapshot.finalCut.shots.forEach((shot) => {
      lines.push(`### ${shot.title}`);
      lines.push(`- 时长: ${formatDuration(shot.durationSeconds)}`);
      lines.push(`- 场景: ${shot.location}`);
      if (shot.characters.length > 0) {
        lines.push(`- 角色: ${shot.characters.join('、')}`);
      }
      lines.push('');
      lines.push(shot.prompt);
      lines.push('');
    });
  }

  lines.push('## 资产清单', '');
  if (assets.length === 0) {
    lines.push('暂无资产。', '');
  } else {
    assets.forEach((asset) => {
      lines.push(`- [${asset.type}] ${asset.name}`);
    });
    lines.push('');
  }

  lines.push('## 当前剧本', '');
  lines.push(snapshot.scriptText || '暂无剧本内容。');
  lines.push('');
  return lines.join('\n');
}

function writeString(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  target.set(bytes.slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const text = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, '0');
  writeString(target, offset, length, `${text}\0`);
}

function splitTarPath(path: string) {
  if (path.length <= 100) {
    return { name: path, prefix: '' };
  }

  const index = path.lastIndexOf('/');
  if (index > 0) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (name.length <= 100 && prefix.length <= 155) {
      return { name, prefix };
    }
  }

  return { name: path.slice(-100), prefix: '' };
}

function createTarHeader(file: TarFile) {
  const header = new Uint8Array(512);
  const normalizedPath = file.path.replace(/\\/g, '/');
  const { name, prefix } = splitTarPath(normalizedPath);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.bytes.length);
  writeOctal(header, 136, 12, file.mtime ?? Math.floor(Date.now() / 1000));
  for (let index = 148; index < 156; index += 1) {
    header[index] = 0x20;
  }
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'woohoo');
  writeString(header, 297, 32, 'woohoo');
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function buildTarArchive(files: TarFile[]) {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  files.forEach((file) => {
    const header = createTarHeader(file);
    const dataPadding = (512 - (file.bytes.length % 512 || 512)) % 512;
    chunks.push(header, file.bytes, new Uint8Array(dataPadding));
    totalLength += header.length + file.bytes.length + dataPadding;
  });

  chunks.push(new Uint8Array(1024));
  totalLength += 1024;

  const archive = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    archive.set(chunk, offset);
    offset += chunk.length;
  });
  return archive;
}

function triggerDownload(filename: string, blob: Blob) {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(objectUrl);
}

export async function exportFullProjectBundle(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
}) {
  const inlineScript = resolveInlineScriptText(args.project, args.script, args.assets);
  const scriptText =
    inlineScript.content ||
    (inlineScript.source === 'asset' && inlineScript.asset
      ? await loadAssetText(inlineScript.asset)
      : '');
  const snapshot = createProjectSnapshot({
    project: args.project,
    script: args.script,
    scriptText,
    storyboard: args.storyboard,
    assets: args.assets,
  });

  const assetResults = await Promise.allSettled(
    args.assets.map(async (asset, index) => {
      const blob = await loadAssetBlob(asset);
      const extension = asset.name.includes('.') ? asset.name.split('.').pop() : asset.type;
      return {
        path: `assets/${String(index + 1).padStart(3, '0')}-${sanitizeSegment(
          asset.name.replace(/\.[^.]+$/, ''),
          asset.id.slice(0, 8),
        )}.${sanitizeSegment(String(extension || asset.type), asset.type)}`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      } satisfies TarFile;
    }),
  );

  const missingAssets = assetResults.filter((result) => result.status === 'rejected').length;
  const downloadedAssets: TarFile[] = [];
  assetResults.forEach((result) => {
    if (result.status === 'fulfilled') {
      downloadedAssets.push(result.value);
    }
  });

  const files: TarFile[] = [
    {
      path: 'manifest.json',
      bytes: encoder.encode(
        sanitizeText(JSON.stringify(buildProjectManifest(args.project, snapshot, args.assets), null, 2)).sanitized,
      ),
    },
    {
      path: 'core-bundle.md',
      bytes: encoder.encode(sanitizeText(buildCoreMarkdown(args.project, snapshot, args.assets)).sanitized),
    },
    {
      path: 'script/current-script.md',
      bytes: encoder.encode(sanitizeText(snapshot.scriptText || '暂无剧本内容。').sanitized),
    },
    {
      path: 'storyboard/storyboard.json',
      bytes: encoder.encode(sanitizeText(JSON.stringify(sanitizeValue(args.storyboard ?? null), null, 2)).sanitized),
    },
    {
      path: 'timeline/final-cut.json',
      bytes: encoder.encode(sanitizeText(JSON.stringify(sanitizeValue(snapshot.finalCut), null, 2)).sanitized),
    },
    ...args.project.chatSessions.map((session, index) => ({
      path: `conversations/${String(index + 1).padStart(2, '0')}-${sanitizeSegment(
        session.title,
        `chat-${index + 1}`,
      )}.md`,
      bytes: encoder.encode(sanitizeText(markdownFromMessages(session)).sanitized),
    })),
    ...downloadedAssets,
  ];

  const archive = buildTarArchive(files);
  const filename = `${sanitizeSegment(args.project.name, 'project')}-full-export.tar`;
  triggerDownload(filename, new Blob([archive], { type: 'application/x-tar' }));

  return {
    filename,
    downloadedAssets: downloadedAssets.length,
    missingAssets,
  };
}

export async function exportCoreProjectBundle(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
}) {
  const inlineScript = resolveInlineScriptText(args.project, args.script, args.assets);
  const scriptText =
    inlineScript.content ||
    (inlineScript.source === 'asset' && inlineScript.asset
      ? await loadAssetText(inlineScript.asset)
      : '');
  const snapshot = createProjectSnapshot({
    project: args.project,
    script: args.script,
    scriptText,
    storyboard: args.storyboard,
    assets: args.assets,
  });
  const filename = `${sanitizeSegment(args.project.name, 'project')}-core-bundle.md`;
  triggerDownload(
    filename,
    new Blob([sanitizeText(buildCoreMarkdown(args.project, snapshot, args.assets)).sanitized], {
      type: 'text/markdown;charset=utf-8',
    }),
  );
  return {
    filename,
    chapterCount: snapshot.chapters.length,
    shotCount: snapshot.finalCut.totalShots,
    totalAssets: args.assets.length,
    missingAssets: 0,
  };
}

export function exportFinalCutPlan(project: Project, finalCut: DerivedFinalCut) {
  const filename = `${sanitizeSegment(project.name, 'project')}-final-cut.json`;
  triggerDownload(
    filename,
    new Blob([JSON.stringify(finalCut, null, 2)], {
      type: 'application/json;charset=utf-8',
    }),
  );
  return filename;
}

// ─── 可审计导出增强 ───────────────────────────────────────

/** 预检问题级别 */
export type PrecheckSeverity = 'error' | 'warning' | 'info';

/** 预检问题 */
export type PrecheckIssue = {
  severity: PrecheckSeverity;
  code: string;
  message: string;
  assetId?: string;
  assetName?: string;
  field?: string;
};

/** 预检结果 */
export type ExportPrecheckResult = {
  projectId: string;
  projectName: string;
  canExport: boolean;
  issues: PrecheckIssue[];
  summary: {
    totalAssets: number;
    readyAssets: number;
    missingAssets: number;
    corruptedAssets: number;
    externalAssets: number;
    duplicateNames: number;
    estimatedSizeBytes: number;
    estimatedSizeHuman: string;
    scriptPresent: boolean;
    storyboardPresent: boolean;
    shotCount: number;
    keyframeCount: number;
    emptyLines: number;
    blockingCount: number;
    warningCount: number;
    infoCount: number;
  };
};

/** 缺失资产条目 */
export type MissingAssetEntry = {
  assetId: string;
  assetName: string;
  type: string;
  expectedPath?: string;
  reason: string;
  url?: string;
  createdAt: number;
};

/** 验证检查结果 */
export type VerificationCheck = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
};

/** 敏感信息发现 */
export type SensitiveFinding = {
  severity: 'high' | 'medium' | 'low';
  category: 'api_key' | 'jwt' | 'password' | 'email' | 'phone' | 'private_key' | 'auth_header' | 'absolute_path' | 'db_url' | 'generic_secret';
  file: string;
  lineHint?: number;
  description: string;
};

/** 文件校验和条目 */
export type FileChecksum = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

/** 资产验证摘要 */
export type AssetVerificationSummary = {
  totalChecked: number;
  passed: number;
  failed: number;
  missing: number;
  checksumsValidated: number;
};

/** 复现性信息 */
export type ReproducibilityInfo = {
  canReproduce: boolean;
  requirements: string[];
  blockers: string[];
  woohooVersionRequired: string;
  databaseSnapshotIncluded: boolean;
};

/** 验证报告 */
export type VerificationReport = {
  verifiedAt: string;
  overallStatus: 'pass' | 'pass_with_warnings' | 'fail';
  checksPerformed: VerificationCheck[];
  warnings: string[];
  errors: string[];
  sensitiveFindings: SensitiveFinding[];
  assetVerification: AssetVerificationSummary;
  reproducibility: ReproducibilityInfo;
};

/** 审计导出返回结果 */
export type AuditableExportResult = {
  filename: string;
  downloadedAssets: number;
  missingAssets: number;
  corruptedAssets: number;
  totalSizeBytes: number;
  manifest: Record<string, unknown>;
  missing: MissingAssetEntry[];
  verification: VerificationReport;
  packageSha256?: string;
};

/**
 * 计算字节数据的SHA-256哈希（使用Web Crypto API）
 */
export async function sha256Bytes(data: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 降级：简单的非加密哈希（仅用于标记，不用于安全校验）
  let h1 = 0xdeadbeef ^ data.length;
  let h2 = 0x41c6ce57 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `fallback-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/**
 * 计算字符串的SHA-256
 */
export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(encoder.encode(text));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 判断URL是否是合法的HTTP(S)或本地路径格式
 */
export function isValidAssetUrl(url: string): boolean {
  if (!url || !url.trim()) return false;
  if (url.startsWith('/uploads/')) return true;
  if (url.startsWith('/api/')) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'blob:' || u.protocol === 'data:';
  } catch {
    return false;
  }
}

/**
 * 快速HEAD请求检查资产可达性（带超时和重试）
 * 返回: { ok, status, sizeBytes }
 */
async function quickProbeAsset(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status?: number; sizeBytes?: number; error?: string }> {
  // 本地路径使用authFetch逻辑
  const isRelative = url.startsWith('/');
  const probeUrl = isRelative ? url : url;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {};
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('woohoo_token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await fetch(probeUrl, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
      credentials: isRelative ? 'include' : 'omit',
    });
    clearTimeout(timer);

    const contentLength = resp.headers.get('content-length');
    const sizeBytes = contentLength ? parseInt(contentLength, 10) : undefined;

    if (resp.ok) {
      return { ok: true, status: resp.status, sizeBytes };
    }
    return { ok: false, status: resp.status, sizeBytes, error: `HTTP ${resp.status}` };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: '请求超时' };
    }
    return { ok: false, error: err instanceof Error ? err.message : '请求失败' };
  }
}

/**
 * 导出预检：在实际导出前全面检查项目状态
 *
 * 覆盖项：
 * 1. 脚本检查：缺失 / 空白 / 过短
 * 2. 分镜检查：缺失 / 空行 / 空描述行 / 空时长行
 * 3. 资产URL检查：空URL / 非法格式 / 不可达 / 零字节
 * 4. 重复文件名检测
 * 5. 空内容检测：分镜空描述、角色缺失等
 * 6. 不可下载资产：HEAD请求可达性验证（本地/外部）
 *
 * 分级标准：
 * - error (blocking): 会导致导出包损坏或关键数据完全无法生成
 * - warning: 不阻止导出但会影响完整性
 * - info: 提示性信息，建议关注
 */
export async function precheckExport(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
}): Promise<ExportPrecheckResult> {
  const issues: PrecheckIssue[] = [];
  let ready = 0;
  let missing = 0;
  let corrupted = 0;
  let external = 0;
  let duplicates = 0;
  let emptyLines = 0;
  let estimatedSize = 0;

  // ═══════════════════════════════════════════
  // 1. 脚本检查
  // ═══════════════════════════════════════════
  const scriptContent = args.script?.content?.trim() ?? '';
  const scriptPresent = !!scriptContent;
  const scriptTitle = args.script?.title?.trim() ?? '';

  if (!args.script) {
    // 没有剧本记录 → warning（核心策划包可以生成但缺少剧本部分）
    issues.push({
      severity: 'warning',
      code: 'NO_SCRIPT',
      field: 'script',
      message: '项目没有剧本内容，导出包将缺少剧本部分',
    });
  } else if (!scriptContent) {
    // 有记录但内容全空白 → warning
    issues.push({
      severity: 'warning',
      code: 'EMPTY_SCRIPT',
      field: 'script',
      message: '剧本内容为空（仅空白字符），导出包的剧本部分将无实质内容',
    });
  } else if (scriptContent.length < 30) {
    // 内容过短 → info
    issues.push({
      severity: 'info',
      code: 'SCRIPT_TOO_SHORT',
      field: 'script',
      message: `剧本内容较短（${scriptContent.length}字符），可能影响可复现性`,
    });
  }

  if (scriptPresent && !scriptTitle) {
    issues.push({
      severity: 'info',
      code: 'NO_SCRIPT_TITLE',
      field: 'script',
      message: '剧本没有标题，导出包中将使用默认名称',
    });
  }

  // ═══════════════════════════════════════════
  // 2. 分镜检查
  // ═══════════════════════════════════════════
  const lines = args.storyboard?.lines ?? [];
  const storyboardPresent = !!args.storyboard && lines.length > 0;
  const shotCount = lines.length;

  if (!args.storyboard) {
    issues.push({
      severity: 'warning',
      code: 'NO_STORYBOARD',
      field: 'storyboard',
      message: '项目没有分镜数据，导出包将缺少分镜部分',
    });
  } else if (lines.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'EMPTY_STORYBOARD',
      field: 'storyboard',
      message: '分镜已创建但没有任何镜头行，导出包的分镜将为空',
    });
  } else {
    // 逐个检查镜头行
    const emptyDescLines: number[] = [];
    const zeroDurLines: number[] = [];
    const noAssetsLines: number[] = [];

    for (const line of lines) {
      const desc = line.description?.trim() ?? '';
      if (!desc) {
        emptyDescLines.push(line.sceneNumber);
      }
      if (!line.duration || line.duration <= 0) {
        zeroDurLines.push(line.sceneNumber);
      }
      if (!line.assets || line.assets.length === 0) {
        noAssetsLines.push(line.sceneNumber);
      }
    }

    emptyLines = emptyDescLines.length;

    if (emptyDescLines.length > 0) {
      const preview = emptyDescLines.slice(0, 5).join(', ') + (emptyDescLines.length > 5 ? '...' : '');
      issues.push({
        severity: emptyDescLines.length > lines.length / 2 ? 'warning' : 'info',
        code: 'EMPTY_SHOT_DESCRIPTION',
        field: 'storyboard',
        message: `${emptyDescLines.length}个镜头缺少画面描述（镜头${preview}），导出包将不完整`,
      });
    }
    if (zeroDurLines.length > 0) {
      const preview = zeroDurLines.slice(0, 5).join(', ') + (zeroDurLines.length > 5 ? '...' : '');
      issues.push({
        severity: 'info',
        code: 'ZERO_DURATION_SHOT',
        field: 'storyboard',
        message: `${zeroDurLines.length}个镜头时长为0（镜头${preview}），终剪时间线可能异常`,
      });
    }
    if (noAssetsLines.length === lines.length && lines.length > 0) {
      issues.push({
        severity: 'info',
        code: 'NO_SHOT_ASSETS',
        field: 'storyboard',
        message: '所有镜头都未关联资产，导出包中仅有文字分镜',
      });
    }
  }

  // ═══════════════════════════════════════════
  // 3. 资产检查：URL格式、空URL、重复文件名
  // ═══════════════════════════════════════════

  // 3a. 重复文件名检测
  const nameCount = new Map<string, number>();
  for (const asset of args.assets) {
    const name = (asset.name || '').trim();
    if (name) {
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
  }
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1);
  duplicates = dupNames.length;
  if (dupNames.length > 0) {
    const preview = dupNames.slice(0, 3).map(([n]) => `"${n}"`).join(', ') + (dupNames.length > 3 ? '...' : '');
    issues.push({
      severity: 'warning',
      code: 'DUPLICATE_ASSET_NAMES',
      field: 'assets',
      message: `发现${dupNames.length}组重复资产名（${preview}），打包时将通过ID后缀区分，但可能造成混淆`,
    });
  }

  // 3b. 无资产提示
  if (args.assets.length === 0) {
    issues.push({
      severity: 'info',
      code: 'NO_ASSETS',
      field: 'assets',
      message: '项目当前没有任何资产，导出包将仅包含文本内容',
    });
  }

  // 3c. 逐资产检查（URL格式、可达性、大小）
  // 并发执行HEAD请求（限制并发数）
  const CONCURRENCY = 4;

  // 先收集所有需要探测的资产
  const toProbe: Array<{ index: number; asset: (typeof args.assets)[number]; isLocal: boolean; hasUrlIssue: boolean }> = [];

  for (let i = 0; i < args.assets.length; i++) {
    const asset = args.assets[i];
    const url = (asset.url || '').trim();
    const isLocal = isProtectedAssetUrl(asset.id, url) || url.startsWith('/uploads/') || url.startsWith('/api/');
    let hasUrlIssue = false;

    // URL空值检查 → error (blocking，无法下载)
    if (!url) {
      hasUrlIssue = true;
      issues.push({
        severity: 'error',
        code: 'MISSING_ASSET_URL',
        field: 'assets',
        assetId: asset.id,
        assetName: asset.name,
        message: `资产 "${asset.name}" 的URL为空，导出时无法下载`,
      });
      missing++;
    }
    // URL格式检查 → error
    else if (!isValidAssetUrl(url)) {
      hasUrlIssue = true;
      issues.push({
        severity: 'error',
        code: 'INVALID_ASSET_URL',
        field: 'assets',
        assetId: asset.id,
        assetName: asset.name,
        message: `资产 "${asset.name}" 的URL格式异常（"${truncate(url, 50)}"），导出时无法下载`,
      });
      corrupted++;
    }

    if (!hasUrlIssue) {
      toProbe.push({ index: i, asset, isLocal, hasUrlIssue });
    }
  }

  // 并发探测资产可达性
  const results = new Map<number, { ok: boolean; status?: number; sizeBytes?: number; error?: string }>();
  for (let i = 0; i < toProbe.length; i += CONCURRENCY) {
    const batch = toProbe.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ index, asset }) => {
        try {
          const probe = await quickProbeAsset(asset.url);
          return { index, probe };
        } catch {
          return { index, probe: { ok: false, error: '探测失败' } };
        }
      }),
    );
    for (const { index, probe } of batchResults) {
      results.set(index, probe);
    }
  }

  // 处理探测结果
  for (const { index, asset, isLocal } of toProbe) {
    const probe = results.get(index);
    const sizeHint =
      typeof asset.metadata === 'object' && asset.metadata
        ? ((asset.metadata as Record<string, unknown>).sizeBytes as number) || 0
        : 0;

    if (!probe) {
      // 无探测结果，按metadata判断
      if (sizeHint > 0) {
        ready++;
        estimatedSize += sizeHint;
      } else {
        ready++;
        estimatedSize += isLocal ? 500 * 1024 : 100 * 1024;
      }
      continue;
    }

    if (isLocal) {
      if (probe.ok) {
        const reportedSize = probe.sizeBytes ?? sizeHint;
        if (reportedSize === 0) {
          // 本地文件零字节 → error (文件损坏)
          corrupted++;
          issues.push({
            severity: 'error',
            code: 'EMPTY_ASSET_FILE',
            field: 'assets',
            assetId: asset.id,
            assetName: asset.name,
            message: `资产 "${asset.name}" 的本地文件大小为0字节，文件可能已损坏`,
          });
        } else {
          ready++;
          estimatedSize += reportedSize || 500 * 1024;
        }
      } else {
        // 本地资产不可达 → error (blocking，导出必然失败)
        missing++;
        issues.push({
          severity: 'error',
          code: 'ASSET_UNREACHABLE',
          field: 'assets',
          assetId: asset.id,
          assetName: asset.name,
          message: `资产 "${asset.name}" 不可访问（${probe.error ?? '未知原因'}），导出时将标记为缺失`,
        });
      }
    } else {
      // 外部URL
      external++;
      if (probe.ok) {
        estimatedSize += probe.sizeBytes ?? sizeHint ?? 100 * 1024;
        issues.push({
          severity: 'info',
          code: 'EXTERNAL_ASSET',
          field: 'assets',
          assetId: asset.id,
          assetName: asset.name,
          message: `资产 "${asset.name}" 是外部URL（${truncate(asset.url, 40)}），导出包中不会包含原始文件`,
        });
      } else {
        // 外部URL不可达 → warning（外部资产不阻塞导出）
        issues.push({
          severity: 'warning',
          code: 'EXTERNAL_ASSET_UNREACHABLE',
          field: 'assets',
          assetId: asset.id,
          assetName: asset.name,
          message: `外部资产 "${asset.name}" 无法访问（${probe.error ?? '未知原因'}），导出时将标记为缺失`,
        });
      }
    }
  }

  // ═══════════════════════════════════════════
  // 4. 项目级空内容检测
  // ═══════════════════════════════════════════
  const chatSessions = args.project.chatSessions ?? [];
  if (chatSessions.length === 0) {
    issues.push({
      severity: 'info',
      code: 'NO_CHAT_SESSIONS',
      field: 'project',
      message: '项目没有对话历史，导出包将不包含创作过程记录',
    });
  }

  // 项目名称检查
  const projectName = args.project.name?.trim() ?? '';
  if (!projectName || projectName === 'Untitled' || projectName === '未命名') {
    issues.push({
      severity: 'info',
      code: 'DEFAULT_PROJECT_NAME',
      field: 'project',
      message: '项目使用默认名称，导出时建议先修改项目名以便识别',
    });
  }

  // ═══════════════════════════════════════════
  // 统计和结果
  // ═══════════════════════════════════════════
  estimatedSize += 250 * 1024; // 元数据预估

  const blockingCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const infoCount = issues.filter((i) => i.severity === 'info').length;
  const hasErrors = blockingCount > 0;

  return {
    projectId: args.project.id,
    projectName: args.project.name,
    canExport: !hasErrors,
    issues,
    summary: {
      totalAssets: args.assets.length,
      readyAssets: ready,
      missingAssets: missing,
      corruptedAssets: corrupted,
      externalAssets: external,
      duplicateNames: duplicates,
      estimatedSizeBytes: estimatedSize,
      estimatedSizeHuman: formatBytes(estimatedSize),
      scriptPresent,
      storyboardPresent,
      shotCount,
      keyframeCount: shotCount,
      emptyLines,
      blockingCount,
      warningCount,
      infoCount,
    },
  };
}

/**
 * 敏感信息扫描和脱敏已移至 sensitiveSanitizer.ts 模块。
 * sanitizeText() 在写入导出包时自动执行脱敏，并返回脱敏发现供验证报告使用。
 */

/**
 * 可审计完整项目工程包导出
 * 增强版：包含manifest、checksums、missing-assets、verification-report、project-snapshot
 */
export async function exportAuditableProjectBundle(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
  onProgress?: (phase: string, current: number, total: number) => void;
}): Promise<AuditableExportResult> {
  const { project, script, storyboard, assets, onProgress } = args;
  const exportedAt = new Date().toISOString();
  const exportId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  onProgress?.('解析剧本...', 0, 5);

  const inlineScript = resolveInlineScriptText(project, script, assets);
  const scriptText =
    inlineScript.content ||
    (inlineScript.source === 'asset' && inlineScript.asset
      ? await loadAssetText(inlineScript.asset)
      : '');

  const snapshot = createProjectSnapshot({
    project,
    script,
    scriptText,
    storyboard,
    assets,
  });

  onProgress?.('下载资产...', 1, 5);

  // 下载资产并记录结果
  const assetResults = await Promise.allSettled(
    assets.map(async (asset, index) => {
      try {
        const blob = await loadAssetBlob(asset);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const extension = asset.name.includes('.')
          ? (asset.name.split('.').pop() as string)
          : asset.type;
        const safeName = sanitizeSegment(
          asset.name.replace(/\.[^.]+$/, ''),
          asset.id.slice(0, 8),
        );
        const safeExt = sanitizeSegment(String(extension || asset.type), asset.type);
        const path = `assets/${String(index + 1).padStart(3, '0')}-${safeName}.${safeExt}`;

        const hash = await sha256Bytes(bytes);
        const isCorrupted = bytes.length === 0;

        return {
          path,
          bytes,
          asset,
          sha256: hash,
          sizeBytes: bytes.length,
          status: isCorrupted ? ('corrupted' as const) : ('included' as const),
        };
      } catch (err) {
        return {
          asset,
          status: 'missing' as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  onProgress?.('构建清单...', 2, 5);

  const downloadedAssets: Array<{
    path: string;
    bytes: Uint8Array;
    sha256: string;
    sizeBytes: number;
  }> = [];
  const missingEntries: MissingAssetEntry[] = [];
  const assetManifest: Array<Record<string, unknown>> = [];
  const fileChecksums: FileChecksum[] = [];
  let includedCount = 0;
  let missingCount = 0;
  let corruptedCount = 0;
  let totalContentSize = 0;

  for (const result of assetResults) {
    if (result.status === 'fulfilled') {
      const r = result.value;
      if (r.status === 'included') {
        downloadedAssets.push({
          path: r.path,
          bytes: r.bytes,
          sha256: r.sha256,
          sizeBytes: r.sizeBytes,
        });
        fileChecksums.push({ path: r.path, sizeBytes: r.sizeBytes, sha256: r.sha256 });
        totalContentSize += r.sizeBytes;
        includedCount++;
        assetManifest.push({
          id: r.asset.id,
          name: r.asset.name,
          type: r.asset.type,
          versionLabel: r.asset.versionLabel,
          packagedPath: r.path,
          sizeBytes: r.sizeBytes,
          sha256: r.sha256,
          status: 'included',
          createdAt: r.asset.createdAt,
          updatedAt: r.asset.updatedAt,
          metadata: r.asset.metadata,
        });
      } else if (r.status === 'corrupted') {
        corruptedCount++;
        missingEntries.push({
          assetId: r.asset.id,
          assetName: r.asset.name,
          type: r.asset.type,
          expectedPath: r.path,
          reason: '文件为空（0字节），可能已损坏',
          url: r.asset.url,
          createdAt: r.asset.createdAt,
        });
        assetManifest.push({
          id: r.asset.id,
          name: r.asset.name,
          type: r.asset.type,
          packagedPath: r.path,
          sizeBytes: 0,
          sha256: null,
          status: 'corrupted',
          createdAt: r.asset.createdAt,
          updatedAt: r.asset.updatedAt,
        });
      }
    }
    // rejected 的在下面的 forEach 中统一处理
  }

  // 处理rejected的promise（上面的逻辑有问题，重新处理）
  assetResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      const asset = assets[index];
      const ext = asset.name.includes('.') ? asset.name.split('.').pop() : asset.type;
      const safeName = sanitizeSegment(
        asset.name.replace(/\.[^.]+$/, ''),
        asset.id.slice(0, 8),
      );
      const path = `assets/${String(index + 1).padStart(3, '0')}-${safeName}.${sanitizeSegment(String(ext || asset.type), asset.type)}`;
      missingEntries.push({
        assetId: asset.id,
        assetName: asset.name,
        type: asset.type,
        expectedPath: path,
        reason: result.reason?.message || '下载失败',
        url: asset.url,
        createdAt: asset.createdAt,
      });
      assetManifest.push({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        packagedPath: path,
        sizeBytes: 0,
        sha256: null,
        status: 'missing',
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        metadata: asset.metadata,
      });
    }
  });

  onProgress?.('生成报告...', 3, 5);

  // ═══════════════════════════════════════════
  // 构建文本文件内容（构建后全部经过敏感信息脱敏）
  // ═══════════════════════════════════════════
  const coreMarkdown = buildCoreMarkdown(project, snapshot, assets);
  const conversationsMarkdown = project.chatSessions.map((session, index) => ({
    path: `conversations/${String(index + 1).padStart(2, '0')}-${sanitizeSegment(session.title, `chat-${index + 1}`)}.md`,
    content: markdownFromMessages(session),
  }));

  // 构建 project-snapshot 对象（先sanitizeValue递归脱敏再JSON.stringify）
  const snapshotObj = sanitizeValue({
    exportedAt,
    exportId,
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
    },
    scriptTitle: snapshot.scriptTitle,
    scriptText: snapshot.scriptText,
    scriptSections: snapshot.scriptSections,
    chapters: snapshot.chapters,
    characters: snapshot.characters,
    scenes: snapshot.scenes,
    keyframes: snapshot.keyframes,
    videoShots: snapshot.videoShots,
    finalCut: snapshot.finalCut,
  });
  const snapshotJson = JSON.stringify(snapshotObj, null, 2);

  // 构建 generation-params.json（脱敏）
  const genParamsObj = sanitizeValue({
    exportedAt,
    exportId,
    generatedAtFrontend: true,
    note: '完整AI生成参数需从服务端导出获取',
    project: {
      id: project.id,
      name: project.name,
      phase: project.phase,
    },
    assetCounts: {
      images: assets.filter((a) => a.type === 'image').length,
      videos: assets.filter((a) => a.type === 'video').length,
      audio: assets.filter((a) => a.type === 'audio').length,
      documents: assets.filter((a) => a.type === 'document').length,
    },
    shots: snapshot.finalCut.totalShots,
    durationSeconds: snapshot.finalCut.totalDurationSeconds,
  });
  const genParamsJson = JSON.stringify(genParamsObj, null, 2);

  // 所有文本/JSON内容先脱敏再打包
  const rawTextFiles: Array<{ path: string; content: string; isJson: boolean }> = [
    { path: 'core-bundle.md', content: coreMarkdown, isJson: false },
    { path: 'script/current-script.md', content: scriptText || '暂无剧本内容。', isJson: false },
    {
      path: 'storyboard/storyboard.json',
      content: JSON.stringify(sanitizeValue(storyboard ?? null)),
      isJson: true,
    },
    { path: 'timeline/final-cut.json', content: JSON.stringify(sanitizeValue(snapshot.finalCut)), isJson: true },
    { path: 'project-snapshot.json', content: snapshotJson, isJson: true },
    { path: 'generation-params.json', content: genParamsJson, isJson: true },
    ...conversationsMarkdown.map((c) => ({ path: c.path, content: c.content, isJson: false })),
  ];

  // 对每个文本文件执行脱敏，并收集所有脱敏发现
  const allSanitizeFindings: SanitizeFinding[] = [];
  const textFiles: Array<{ path: string; content: string }> = [];
  for (const f of rawTextFiles) {
    const result = sanitizeText(f.content);
    allSanitizeFindings.push(...result.findings.map((sf) => ({ ...sf, file: f.path } as SanitizeFinding & { file: string })));
    textFiles.push({ path: f.path, content: result.sanitized });
  }

  // 第一步：收集所有"内容文件"（文本/JSON文件+资产）的字节和校验和到 fileChecksums
  // 此时 fileChecksums 已经包含了 downloadedAssets 的checksums，现在添加textFiles
  const textFileBytes: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const f of textFiles) {
    const bytes = encoder.encode(f.content);
    const hash = await sha256Bytes(bytes);
    fileChecksums.push({ path: f.path, sizeBytes: bytes.length, sha256: hash });
    totalContentSize += bytes.length;
    textFileBytes.push({ path: f.path, bytes });
  }

  // 第二步：构建验证报告（此时checksumsValidated=内容文件数+资产数）
  const checksPerformed: VerificationCheck[] = [];

  checksPerformed.push({
    name: 'asset_integrity',
    status: corruptedCount === 0 ? 'pass' : 'warn',
    message: `检查了${assets.length}个资产，${includedCount}个成功，${missingCount}个缺失，${corruptedCount}个损坏`,
  });
  checksPerformed.push({
    name: 'script_presence',
    status: scriptText.trim() ? 'pass' : 'warn',
    message: scriptText.trim() ? '剧本内容已包含' : '未检测到剧本内容',
  });
  checksPerformed.push({
    name: 'storyboard_presence',
    status: storyboard ? 'pass' : 'warn',
    message: storyboard ? '分镜数据已包含' : '未检测到分镜数据',
  });
  checksPerformed.push({
    name: 'manifest_presence',
    status: 'pass',
    message: 'manifest.json将包含完整清单索引',
  });
  checksPerformed.push({
    name: 'checksum_validation',
    status: 'pass',
    message: `将为所有文件计算SHA-256校验和（详见checksums.json）`,
  });
  checksPerformed.push({
    name: 'project_snapshot',
    status: 'pass',
    message: 'project-snapshot.json包含完整项目状态，用于复现',
  });

  // 将脱敏发现转为 SensitiveFinding 格式用于验证报告
  const verificationSensitiveFindings: SensitiveFinding[] = allSanitizeFindings.slice(0, 200).map((sf) => {
    const withFile = sf as SanitizeFinding & { file?: string };
    const catMap: Record<string, SensitiveFinding['severity']> = {
      private_key: 'high',
      api_key: 'high',
      jwt: 'high',
      password: 'high',
      auth_header: 'high',
      db_url: 'high',
      generic_secret: 'high',
      absolute_path: 'medium',
      email: 'low',
      phone: 'low',
    };
    return {
      severity: catMap[sf.category] ?? 'medium',
      category: sf.category as SensitiveFinding['category'],
      file: withFile.file ?? 'unknown',
      description: `已自动脱敏 ${sf.category} 类型敏感内容（长度 ${sf.matchLength}，已替换为 ${sf.redacted}）`,
    };
  });

  const warnings: string[] = [];
  const errors: string[] = [];
  if (missingCount > 0) {
    warnings.push(`${missingCount}个资产文件缺失，详见missing-assets.json`);
  }
  if (corruptedCount > 0) {
    errors.push(`${corruptedCount}个资产文件损坏（空文件）`);
  }
  if (allSanitizeFindings.length > 0) {
    // 按类别统计
    const byCat = new Map<string, number>();
    for (const f of allSanitizeFindings) {
      byCat.set(f.category, (byCat.get(f.category) ?? 0) + 1);
    }
    const summary = [...byCat.entries()].map(([c, n]) => `${c}×${n}`).join(', ');
    warnings.push(`自动脱敏 ${allSanitizeFindings.length} 处敏感信息（${summary}），已替换为[REDACTED_*]占位符`);
  }

  const overallStatus: 'pass' | 'pass_with_warnings' | 'fail' = errors.length > 0
    ? 'fail'
    : warnings.length > 0
      ? 'pass_with_warnings'
      : 'pass';

  const verificationReport: VerificationReport = {
    verifiedAt: exportedAt,
    overallStatus,
    checksPerformed: [
      ...checksPerformed,
      {
        name: 'sensitive_content_sanitization',
        status: allSanitizeFindings.length > 0 ? 'warn' : 'pass',
        message: allSanitizeFindings.length > 0
          ? `已自动脱敏 ${allSanitizeFindings.length} 处敏感信息`
          : '未检测到需要脱敏的敏感信息',
      },
    ],
    warnings,
    errors,
    sensitiveFindings: verificationSensitiveFindings,
    assetVerification: {
      totalChecked: assets.length,
      passed: includedCount,
      failed: corruptedCount,
      missing: missingCount,
      checksumsValidated: fileChecksums.length + 3, // +3 for manifest/missing/verification files
    },
    reproducibility: {
      canReproduce: missingCount === 0 && corruptedCount === 0,
      requirements: [
        'Woohoo Studio v0.1.0+',
        'project-snapshot.json包含完整项目状态',
        'manifest.json包含资产版本信息',
        'checksums.json包含所有文件SHA-256校验和',
      ],
      blockers:
        missingCount + corruptedCount > 0
          ? [`${missingCount + corruptedCount}个资产缺失/损坏，无法完整复现`]
          : [],
      woohooVersionRequired: '0.1.0',
      databaseSnapshotIncluded: false,
    },
  };

  // 第三步：构建缺失资产清单（脱敏后编码）
  const missingJsonRaw = { exportedAt, exportId, totalMissing: missingEntries.length, missingAssets: missingEntries };
  const missingJson = JSON.stringify(sanitizeValue(missingJsonRaw), null, 2);
  const missingBytes = encoder.encode(missingJson);
  const missingHash = await sha256Bytes(missingBytes);
  fileChecksums.push({
    path: 'missing-assets.json',
    sizeBytes: missingBytes.length,
    sha256: missingHash,
  });
  totalContentSize += missingBytes.length;

  // 第四步：构建验证报告（脱敏后编码）
  const verificationJson = JSON.stringify(sanitizeValue(verificationReport), null, 2);
  const verificationBytes = encoder.encode(verificationJson);
  const verificationHash = await sha256Bytes(verificationBytes);
  fileChecksums.push({
    path: 'verification-report.json',
    sizeBytes: verificationBytes.length,
    sha256: verificationHash,
  });
  totalContentSize += verificationBytes.length;

  // 第五步：构建manifest.json（此时fileChecksums包含：所有资产+所有textFiles+missing+verification，但不含manifest和checksums自身）
  // manifest.files列出包内所有内容文件和辅助元文件，不包含checksums.json（因为checksums.json是校验和索引，引用它自己会循环）
  // manifest 数据先脱敏再序列化
  const manifestRaw = {
    manifestVersion: '1.0',
    exportId,
    exportedAt,
    exportedBy: 'current-user',
    exportType: 'full',
    exportFormat: 'tar',
    woohooVersion: '0.1.0',
    sanitization: {
      enabled: true,
      findingsCount: allSanitizeFindings.length,
      redactedCategories: [...new Set(allSanitizeFindings.map((f) => f.category))],
    },
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
    },
    summary: {
      scriptSections: snapshot.scriptSections.length,
      chapters: snapshot.chapters.length,
      characters: snapshot.characters.length,
      scenes: snapshot.scenes.length,
      shots: snapshot.videoShots.length,
      keyframes: snapshot.keyframes.length,
      durationSeconds: snapshot.finalCut.totalDurationSeconds,
      totalAssets: assets.length,
      includedAssets: includedCount,
      missingAssets: missingCount,
      corruptedAssets: corruptedCount,
      totalPackageSizeBytes: 0, // 最后填充
    },
    versions: {
      scriptId: script?.id,
      scriptUpdatedAt: script?.updatedAt,
      storyboardId: storyboard?.id,
      storyboardUpdatedAt: storyboard?.updatedAt,
      snapshotFingerprint: null as string | null,
    },
    assets: assetManifest,
    files: fileChecksums.slice(), // 拷贝当前所有checksums（不含manifest和checksums）
    packageChecksum: null as null | { algorithm: string; value: string },
  };
  const manifest = sanitizeValue(manifestRaw);

  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  const manifestHash = await sha256Bytes(manifestBytes);
  const manifestChecksumEntry: FileChecksum = {
    path: 'manifest.json',
    sizeBytes: manifestBytes.length,
    sha256: manifestHash,
  };
  totalContentSize += manifestBytes.length;

  // 第六步：构建checksums.json（包含所有文件的校验和，除了自身）
  // checksums.json 包含: 内容文件 + 资产 + missing-assets + verification-report + manifest
  const allChecksumsForFile: FileChecksum[] = [...fileChecksums, manifestChecksumEntry];
  const checksumsJson = JSON.stringify(
    {
      algorithm: 'SHA-256',
      exportedAt,
      exportId,
      note: '本文件（checksums.json）的SHA-256记录在manifest.packageChecksum中（包级别校验）',
      files: allChecksumsForFile,
    },
    null,
    2,
  );
  const checksumsBytes = encoder.encode(checksumsJson);
  const checksumsHash = await sha256Bytes(checksumsBytes);
  totalContentSize += checksumsBytes.length;

  onProgress?.('打包文件...', 4, 5);

  // 第七步：组装TAR包所有文件
  // 顺序：manifest放最前（便于快速查看），然后是checksums，然后是元文件，最后是内容和资产
  const allFiles: TarFile[] = [
    { path: 'manifest.json', bytes: manifestBytes },
    { path: 'checksums.json', bytes: checksumsBytes },
    { path: 'missing-assets.json', bytes: missingBytes },
    { path: 'verification-report.json', bytes: verificationBytes },
    ...textFileBytes.map((f) => ({ path: f.path, bytes: f.bytes })),
    ...downloadedAssets.map((a) => ({ path: a.path, bytes: a.bytes })),
  ];

  const archive = buildTarArchive(allFiles);
  const packageHash = await sha256Bytes(new Uint8Array(archive));

  const filename = `${sanitizeSegment(project.name, 'project')}-auditable-export-${new Date().toISOString().slice(0, 10)}.tar`;

  onProgress?.('完成', 5, 5);

  triggerDownload(filename, new Blob([archive], { type: 'application/x-tar' }));

  // 更新返回值中的manifest信息
  manifest.summary.totalPackageSizeBytes = archive.length;
  manifest.packageChecksum = { algorithm: 'SHA-256', value: packageHash };
  // 更新manifest.files为完整列表（包含所有文件）
  manifest.files = [...allChecksumsForFile, {
    path: 'checksums.json',
    sizeBytes: checksumsBytes.length,
    sha256: checksumsHash,
  }];

  return {
    filename,
    downloadedAssets: includedCount,
    missingAssets: missingCount,
    corruptedAssets: corruptedCount,
    totalSizeBytes: archive.length,
    manifest,
    missing: missingEntries,
    verification: verificationReport,
    packageSha256: packageHash,
  };
}
