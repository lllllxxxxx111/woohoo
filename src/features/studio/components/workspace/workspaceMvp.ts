import { getServerAssetBlob } from '../../../../lib/serverApi';
import { isProtectedAssetUrl } from '../../../../hooks/useAssetPreviewUrl';
import type {
  Asset,
  ChatSession,
  Message,
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

function looksLikeScript(text: string) {
  const normalized = text.trim();
  if (normalized.length < 120) {
    return false;
  }

  return (
    /^#{1,4}\s+/m.test(normalized) ||
    /第[一二三四五六七八九十0-9]+[章节幕场]/.test(normalized) ||
    /^.{1,12}[：:]/m.test(normalized) ||
    /场景|镜头|对白|旁白/.test(normalized)
  );
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
  const latestAiMessage = flattenMessages(project).find(
    ({ message }) => message.role === 'ai' && looksLikeScript(message.content),
  );

  return latestAiMessage?.message.content?.trim() ?? '';
}

export function resolveInlineScriptText(project: Project, script: Script | null, assets: Asset[]) {
  if (script?.content?.trim()) {
    return {
      title: script.title || `${project.name}-script`,
      content: script.content.trim(),
      source: 'script' as const,
    };
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
  return lines.map((line, index) => ({
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
  const scriptSource = scriptText.trim() || script?.content?.trim() || '';
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

function buildProjectManifest(project: Project, snapshot: ProjectSnapshot, assets: Asset[]) {
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
        JSON.stringify(buildProjectManifest(args.project, snapshot, args.assets), null, 2),
      ),
    },
    {
      path: 'core-bundle.md',
      bytes: encoder.encode(buildCoreMarkdown(args.project, snapshot, args.assets)),
    },
    {
      path: 'script/current-script.md',
      bytes: encoder.encode(snapshot.scriptText || '暂无剧本内容。'),
    },
    {
      path: 'storyboard/storyboard.json',
      bytes: encoder.encode(JSON.stringify(args.storyboard ?? null, null, 2)),
    },
    {
      path: 'timeline/final-cut.json',
      bytes: encoder.encode(JSON.stringify(snapshot.finalCut, null, 2)),
    },
    ...args.project.chatSessions.map((session, index) => ({
      path: `conversations/${String(index + 1).padStart(2, '0')}-${sanitizeSegment(
        session.title,
        `chat-${index + 1}`,
      )}.md`,
      bytes: encoder.encode(markdownFromMessages(session)),
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
    new Blob([buildCoreMarkdown(args.project, snapshot, args.assets)], {
      type: 'text/markdown;charset=utf-8',
    }),
  );
  return {
    filename,
    chapterCount: snapshot.chapters.length,
    shotCount: snapshot.finalCut.totalShots,
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
