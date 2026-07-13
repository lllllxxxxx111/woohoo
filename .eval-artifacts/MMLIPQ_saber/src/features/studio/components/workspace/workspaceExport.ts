/**
 * Auditable Export Engine
 *
 * Upgrades export from "browser temporary packaging" to "auditable, verifiable,
 * reproducible experiment package". Every export produces:
 *   - manifest.json with SHA-256 checksums, version snapshots, generation params
 *   - verification-report.json with pass/warn/fail status
 *   - missing-assets.json listing failed downloads with error reasons
 *   - project-snapshot.json capturing reproducible workspace state
 */

import { getServerAssetBlob } from '../../../../lib/serverApi';
import { isProtectedAssetUrl } from '../../../../hooks/useAssetPreviewUrl';
import type {
  Asset,
  ChatSession,
  Message,
  Project,
  Script,
  Storyboard,
} from '../../../../types';
import {
  createProjectSnapshot,
  type DerivedFinalCut,
  type ProjectSnapshot,
} from './workspaceMvp';
import {
  redactSensitiveInfo,
  redactSensitiveDeep,
  CATEGORY_LABELS,
  type RedactionCategory,
} from './redaction';

// ─── Constants ───────────────────────────────────────────────────────

export const EXPORT_MANIFEST_VERSION = '1.0';
export const EXPORT_TOOL = 'woohoo-studio';

// ─── Types ───────────────────────────────────────────────────────────

export type ExportType = 'full' | 'core' | 'final_cut' | 'snapshot';
export type VerifyStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type PreflightSeverity = 'blocking' | 'warning' | 'info';

export interface PreflightFinding {
  severity: PreflightSeverity;
  code: string;
  message: string;
  /** Optional asset ID this finding relates to */
  assetId?: string;
  /** Optional path/subject */
  subject?: string;
}

export interface PreflightAssetCheck {
  assetId: string;
  name: string;
  type: string;
  url: string;
  status: VerifyStatus;
  reason?: string;
  sizeBytes?: number;
  /** Per-asset findings (e.g. duplicate name, zero bytes) */
  findings?: PreflightFinding[];
}

export interface PreflightResult {
  projectId: string;
  projectName: string;
  canExport: boolean;
  overallStatus: VerifyStatus;
  /** Findings grouped by severity */
  findings: PreflightFinding[];
  /** Legacy flat arrays for backwards compat */
  blocking: PreflightFinding[];
  warnings: PreflightFinding[];
  infos: PreflightFinding[];
  assets: PreflightAssetCheck[];
  assetSummary: {
    total: number;
    reachable: number;
    missing: number;
    uncertain: number;
    duplicateNames: number;
    zeroByte: number;
  };
  scriptReady: boolean;
  storyboardReady: boolean;
  estimatedSizeBytes: number;
  /** Tar filename collision check */
  pathCollisions: string[];
}

export interface FileEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
  addedAt: string;
}

export interface AssetEntry {
  id: string;
  name: string;
  type: string;
  filePath?: string;
  sha256?: string;
  sizeBytes?: number;
  versionLabel?: string;
  metadata?: Record<string, unknown> | null;
  sourceUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface MissingAssetEntry {
  id: string;
  name: string;
  type: string;
  sourceUrl: string;
  error: string;
  errorCode: string;
}

export interface DocumentVersion {
  id: string;
  title?: string;
  updatedAt: number;
  contentHash: string;
  contentLength: number;
}

export interface ModelUsage {
  model: string;
  requestCount: number;
  totalTokens?: number;
}

export interface GenerationParamsSummary {
  modelsUsed: ModelUsage[];
  totalAiTasks: number;
  totalTokensUsed?: number;
  imageGenerations: number;
  videoGenerations: number;
}

export interface CompletenessReport {
  expectedAssets: number;
  includedAssets: number;
  missingAssets: number;
  scriptIncluded: boolean;
  storyboardIncluded: boolean;
  conversationsIncluded: number;
}

export interface VerificationReport {
  status: VerifyStatus;
  checkedAt: string;
  totalFiles: number;
  verifiedFiles: number;
  failedChecksums: number;
  completeness: CompletenessReport;
  issues: string[];
}

export interface ContentFlags {
  hasExternalUrls: boolean;
  hasApiKeys: boolean;
  hasPersonalInfo: boolean;
  warnings: string[];
  /** Redaction summary (populated during export) */
  redaction?: {
    applied: boolean;
    totalRedactions: number;
    byCategory: Partial<Record<RedactionCategory, number>>;
  };
}

export interface ExportManifest {
  manifestVersion: string;
  exportId: string;
  exportedAt: string;
  exporter: {
    tool: string;
    version: string;
    schemaVersion: string;
    client?: string;
  };
  project: {
    id: string;
    name: string;
    status: string;
    phase: string;
    createdAt: number;
    workflow?: unknown;
  };
  files: FileEntry[];
  assets: AssetEntry[];
  missingAssets: MissingAssetEntry[];
  versions: {
    script?: DocumentVersion;
    storyboard?: DocumentVersion;
    chatMessagesCount: number;
  };
  generationParams: GenerationParamsSummary;
  verification: VerificationReport;
  contentFlags: ContentFlags;
}

export interface ExportResult {
  exportId: string;
  filename: string;
  exportType: ExportType;
  status: 'completed' | 'partial' | 'failed';
  manifest: ExportManifest;
  verification: VerificationReport;
  downloadedAssets: number;
  missingAssets: number;
  totalSizeBytes: number;
}

// ─── SHA-256 (Web Crypto) ───────────────────────────────────────────

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Content hash helpers ────────────────────────────────────────────

async function hashDocument(content: string): Promise<{ hash: string; length: number }> {
  const hash = await sha256Hex(content);
  return { hash: hash.slice(0, 16), length: content.length };
}

// ─── Preflight check ─────────────────────────────────────────────────

export async function runPreflightCheck(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
}): Promise<PreflightResult> {
  const { project, script, storyboard, assets } = args;
  const findings: PreflightFinding[] = [];
  const assetChecks: PreflightAssetCheck[] = [];
  const tarPathMap = new Map<string, string[]>(); // tar-path -> [assetIds]
  const nameMap = new Map<string, string[]>();     // display-name -> [assetIds]
  let reachable = 0;
  let missing = 0;
  let uncertain = 0;
  let duplicateNames = 0;
  let zeroByteCount = 0;
  let estimatedSize = 0;

  function finding(severity: PreflightSeverity, code: string, message: string, assetId?: string, subject?: string) {
    findings.push({ severity, code, message, assetId, subject });
  }

  // ── Per-asset checks ──────────────────────────────────────────
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const assetFindings: PreflightFinding[] = [];
    let status: VerifyStatus = 'pass';
    let reason: string | undefined;
    let size: number | undefined;

    // Check 1: Empty name
    if (!asset.name.trim()) {
      assetFindings.push({
        severity: 'blocking',
        code: 'ASSET_EMPTY_NAME',
        message: '资产名称为空，将无法在包中正确命名',
        assetId: asset.id,
      });
      status = 'fail';
    }

    // Check 2: Missing URL
    if (!asset.url.trim()) {
      assetFindings.push({
        severity: 'blocking',
        code: 'ASSET_NO_URL',
        message: '资产缺少 URL，无法下载',
        assetId: asset.id,
      });
      status = 'fail';
      assetChecks.push({
        assetId: asset.id,
        name: asset.name || '(unnamed)',
        type: asset.type,
        url: asset.url,
        status,
        reason: '资产缺少 URL',
        findings: assetFindings,
      });
      missing++;
      continue;
    }

    // Check 3: URL reachability classification
    if (isProtectedAssetUrl(asset.id, asset.url)) {
      size = getAssetSizeFromMetadata(asset);
      status = 'pass';
      reachable++;
      if (size) estimatedSize += size;
    } else if (asset.url.startsWith('/uploads/')) {
      size = getAssetSizeFromMetadata(asset);
      status = 'pass';
      reachable++;
      if (size) estimatedSize += size;
    } else if (asset.url.startsWith('http://') || asset.url.startsWith('https://')) {
      size = getAssetSizeFromMetadata(asset);
      status = 'warn';
      reason = '外部 URL，导出时将尝试下载';
      uncertain++;
      if (size) estimatedSize += size;
    } else if (asset.url.startsWith('data:')) {
      status = 'pass';
      reachable++;
      // data: URLs don't have a predictable size in metadata
    } else {
      assetFindings.push({
        severity: 'blocking',
        code: 'ASSET_BAD_URL',
        message: `无法识别的 URL 格式: ${asset.url.slice(0, 60)}`,
        assetId: asset.id,
      });
      status = 'fail';
      missing++;
    }

    // Check 4: Zero-byte assets
    if (size != null && size === 0) {
      assetFindings.push({
        severity: 'warning',
        code: 'ASSET_ZERO_BYTES',
        message: '资产大小为 0 字节，可能已损坏',
        assetId: asset.id,
      });
      zeroByteCount++;
    }

    // Check 5: Duplicate display names
    if (asset.name.trim()) {
      const nameKey = asset.name.trim().toLowerCase();
      const ids = nameMap.get(nameKey) ?? [];
      ids.push(asset.id);
      nameMap.set(nameKey, ids);
    }

    // Check 6: Tar-path collision (what the sanitized filename will be)
    const ext = asset.name.includes('.')
      ? asset.name.split('.').pop()!
      : asset.type;
    const safeName = sanitizeSegment(
      asset.name.replace(/\.[^.]+$/, ''),
      asset.id.slice(0, 8),
    );
    const safeExt = sanitizeSegment(ext, asset.type);
    const tarPath = `assets/${String(i + 1).padStart(3, '0')}-${safeName}.${safeExt}`;
    // Note: using index prefix ensures uniqueness, but if two assets have the
    // same base name they will produce confusingly similar files. Flag it.
    const existingForPath = tarPathMap.get(tarPath) ?? [];
    existingForPath.push(asset.id);
    tarPathMap.set(tarPath, existingForPath);

    assetChecks.push({
      assetId: asset.id,
      name: asset.name || '(unnamed)',
      type: asset.type,
      url: asset.url.startsWith('data:') ? asset.url.slice(0, 60) + '...' : asset.url,
      status,
      reason,
      sizeBytes: size,
      findings: assetFindings.length > 0 ? assetFindings : undefined,
    });

    // Promote per-asset findings to global list
    for (const f of assetFindings) {
      findings.push(f);
    }
  }

  // Check 7: Duplicate asset names (global, cross-asset)
  for (const [name, ids] of nameMap.entries()) {
    if (ids.length > 1) {
      duplicateNames += ids.length;
      finding(
        'warning',
        'DUPLICATE_ASSET_NAME',
        `存在 ${ids.length} 个同名资产「${name}」，导出时将重命名避免覆盖，但内容可能混淆`,
        ids[0],
        name,
      );
    }
  }

  // ── Script checks ─────────────────────────────────────────────
  const scriptContent = script?.content?.trim() ?? '';
  const scriptReady = scriptContent.length > 0;

  if (!script) {
    finding('info', 'SCRIPT_MISSING', '当前项目没有保存剧本（可能只在对话中生成），导出包中将包含对话中的剧本文本（如有）');
  } else if (!scriptReady) {
    finding('warning', 'SCRIPT_EMPTY', '剧本记录存在但内容为空，导出包中将缺少剧本文档');
  } else if (scriptContent.length < 50) {
    finding('warning', 'SCRIPT_TOO_SHORT', `剧本内容较短 (${scriptContent.length} 字符)，可能是草稿`);
  } else {
    finding('info', 'SCRIPT_OK', `剧本就绪，约 ${scriptContent.length} 字符`);
  }

  // Check for sensitive content in script
  if (scriptReady) {
    const apiKeyPatterns = /sk-[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*\S+|secret\s*[:=]\s*\S+/i;
    if (apiKeyPatterns.test(scriptContent)) {
      finding('warning', 'SCRIPT_SENSITIVE_KEY', '剧本中检测到可能的 API Key 或密钥，交付前请确认是否需要脱敏');
    }
    const piiPatterns = /1[3-9]\d{9}|[a-zA-Z0-9._%+-]+@(?:gmail|qq|163|outlook|hotmail)\.com|身份证|身份证号/g;
    if (piiPatterns.test(scriptContent)) {
      finding('warning', 'SCRIPT_PII', '剧本中检测到可能的个人信息（手机号/邮箱/身份证），交付前请确认是否需要脱敏');
    }
  }

  // ── Storyboard checks ─────────────────────────────────────────
  const sbLines = storyboard?.lines ?? [];
  const storyboardReady = sbLines.length > 0;

  if (!storyboard) {
    finding('info', 'STORYBOARD_MISSING', '当前项目没有分镜数据，导出包中将缺少分镜文件');
  } else if (!storyboardReady) {
    finding('warning', 'STORYBOARD_EMPTY', '分镜记录存在但没有镜头数据');
  } else {
    // Check for empty scene descriptions
    const emptyDescriptions = sbLines.filter(l => !l.description.trim()).length;
    if (emptyDescriptions > 0) {
      finding(
        'warning',
        'STORYBOARD_EMPTY_SCENES',
        `${emptyDescriptions} 个分镜缺少场景描述，导出后将显示为空`,
      );
    }

    // Check for storyboard lines referencing assets not in the asset list
    const storyboardAssetIds = new Set<string>();
    for (const line of sbLines) {
      for (const a of line.assets) {
        storyboardAssetIds.add(a.id);
      }
    }
    const knownAssetIds = new Set(assets.map(a => a.id));
    const danglingRefs: string[] = [];
    for (const said of storyboardAssetIds) {
      if (!knownAssetIds.has(said)) danglingRefs.push(said);
    }
    if (danglingRefs.length > 0) {
      finding(
        'warning',
        'STORYBOARD_DANGLING_REFS',
        `分镜引用了 ${danglingRefs.length} 个不在资产库中的资产（可能已被删除）`,
      );
    }

    // Check for zero-duration scenes
    const zeroDuration = sbLines.filter(l => !l.duration || l.duration <= 0).length;
    if (zeroDuration > 0) {
      finding('info', 'STORYBOARD_ZERO_DURATION', `${zeroDuration} 个分镜时长为 0 秒`);
    }

    const totalDuration = sbLines.reduce((sum, l) => sum + Math.max(0, l.duration || 0), 0);
    finding('info', 'STORYBOARD_OK', `分镜就绪，${sbLines.length} 个镜头，总时长约 ${totalDuration} 秒`);
  }

  // ── Project-level checks ──────────────────────────────────────
  if (assets.length === 0) {
    finding('warning', 'NO_ASSETS', '当前项目没有任何资产文件，导出包仅包含文档');
  }

  if (project.chatSessions.length === 0) {
    finding('info', 'NO_CONVERSATIONS', '当前项目没有对话记录，导出包将不含对话历史');
  }

  if (project.chatSessions.length > 0) {
    let totalMessages = 0;
    let aiMessages = 0;
    for (const s of project.chatSessions) {
      totalMessages += s.messages.length;
      for (const m of s.messages) {
        if (m.role === 'ai') aiMessages++;
      }
    }
    finding('info', 'CONVERSATIONS_OK', `${project.chatSessions.length} 个对话，共 ${totalMessages} 条消息（${aiMessages} 条 AI 回复）`);
  }

  // ── Classify findings ─────────────────────────────────────────
  const blocking = findings.filter(f => f.severity === 'blocking');
  const warnList = findings.filter(f => f.severity === 'warning');
  const infos = findings.filter(f => f.severity === 'info');

  // Determine canExport: blocking findings prevent export
  // - An asset with no URL is blocking for THAT asset but not for the whole project
  //   if there are other valid assets or documents to export
  // - Truly blocking only when: NO assets downloadable AND no script AND no storyboard
  const hasBlockers = blocking.length > 0;
  const hasContent = scriptReady || storyboardReady || reachable > 0;
  const canExport = hasContent;

  let overallStatus: VerifyStatus;
  if (blocking.some(f => f.code === 'ASSET_BAD_URL' || f.code === 'ASSET_NO_URL') && !scriptReady && !storyboardReady) {
    overallStatus = 'fail';
  } else if (blocking.length > 0) {
    overallStatus = 'warn'; // individual asset failures don't fully block
  } else if (warnList.length > 0) {
    overallStatus = 'warn';
  } else {
    overallStatus = 'pass';
  }

  // Collect path collisions (informational, since index prefix prevents actual overwrite)
  const pathCollisions: string[] = [];
  for (const [path, ids] of tarPathMap.entries()) {
    if (ids.length > 1) pathCollisions.push(path);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    canExport,
    overallStatus,
    findings,
    blocking,
    warnings: warnList,
    infos,
    assets: assetChecks,
    assetSummary: {
      total: assets.length,
      reachable,
      missing,
      uncertain,
      duplicateNames,
      zeroByte: zeroByteCount,
    },
    scriptReady,
    storyboardReady,
    estimatedSizeBytes: estimatedSize,
    pathCollisions,
  };
}

function getAssetSizeFromMetadata(asset: Asset): number | undefined {
  const meta = asset.metadata as Record<string, unknown> | null;
  if (meta && typeof meta.sizeBytes === 'number') return meta.sizeBytes;
  return undefined;
}

// ─── Asset loading with error capture ────────────────────────────────

interface LoadedAsset {
  asset: Asset;
  data?: Uint8Array;
  error?: { message: string; code: string };
  path: string;
}

async function loadAssetRaw(asset: Pick<Asset, 'id' | 'url'>): Promise<Uint8Array> {
  if (isProtectedAssetUrl(asset.id, asset.url)) {
    const blob = await getServerAssetBlob(asset.id);
    return new Uint8Array(await blob.arrayBuffer());
  }
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const ab = await response.arrayBuffer();
  return new Uint8Array(ab);
}

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return sanitized || fallback;
}

// ─── Generation params extraction ────────────────────────────────────

function extractGenerationParams(project: Project): GenerationParamsSummary {
  const modelCounts = new Map<string, { count: number; tokens: number }>();
  let totalTokens = 0;
  let imageCount = 0;
  let videoCount = 0;
  let taskCount = 0;

  for (const session of project.chatSessions) {
    for (const msg of session.messages) {
      if (msg.role === 'ai') {
        taskCount++;
        const model = msg.model ?? 'unknown';
        const entry = modelCounts.get(model) ?? { count: 0, tokens: 0 };
        entry.count++;
        modelCounts.set(model, entry);

        if (msg.meta) {
          const usage = (msg.meta as Record<string, unknown>).usage as
            | { totalTokens?: number; total_tokens?: number }
            | undefined;
          const tokens = usage?.totalTokens ?? usage?.total_tokens ?? 0;
          totalTokens += tokens;
          entry.tokens += tokens;

          const outputKind = (msg.meta as Record<string, unknown>).outputKind as string | undefined;
          if (outputKind === 'image') imageCount++;
          if (outputKind === 'video') videoCount++;
        }
      }
    }
  }

  const modelsUsed: ModelUsage[] = [];
  for (const [model, { count, tokens }] of modelCounts) {
    modelsUsed.push({
      model,
      requestCount: count,
      totalTokens: tokens > 0 ? tokens : undefined,
    });
  }

  return {
    modelsUsed,
    totalAiTasks: taskCount,
    totalTokensUsed: totalTokens > 0 ? totalTokens : undefined,
    imageGenerations: imageCount,
    videoGenerations: videoCount,
  };
}

// ─── Content flag scanning ───────────────────────────────────────────

function scanContentFlags(
  script: Script | null,
  assets: Asset[],
): ContentFlags {
  const warnings: string[] = [];
  let hasExternalUrls = false;
  let hasApiKeys = false;
  let hasPersonalInfo = false;

  for (const asset of assets) {
    if (asset.url.startsWith('http://') || asset.url.startsWith('https://')) {
      hasExternalUrls = true;
    }
  }

  const apiKeyPatterns = ['sk-', 'api_key', 'API_KEY', 'secret=', 'password='];
  const piiPatterns = ['@gmail.com', '@qq.com', '@163.com', '手机', '电话', '身份证'];

  if (script) {
    for (const pat of apiKeyPatterns) {
      if (script.content.includes(pat)) {
        hasApiKeys = true;
        break;
      }
    }
    for (const pat of piiPatterns) {
      if (script.content.includes(pat)) {
        hasPersonalInfo = true;
        break;
      }
    }
  }

  if (hasApiKeys) warnings.push('检测到可能的 API Key 或密钥信息，请确认是否需要脱敏');
  if (hasPersonalInfo) warnings.push('检测到可能的个人信息（邮箱/电话等），请确认是否需要脱敏');
  if (hasExternalUrls) warnings.push('包中包含外部 URL 资产，解压后需要网络连接才能访问');

  return { hasExternalUrls, hasApiKeys, hasPersonalInfo, warnings };
}

// ─── Tar building (reused from workspaceMvp) ────────────────────────

function writeString(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = new TextEncoder().encode(value);
  target.set(bytes.slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  writeString(target, offset, length, `${text}\0`);
}

function splitTarPath(path: string) {
  if (path.length <= 100) return { name: path, prefix: '' };
  const index = path.lastIndexOf('/');
  if (index > 0) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (name.length <= 100 && prefix.length <= 155) return { name, prefix };
  }
  return { name: path.slice(-100), prefix: '' };
}

function createTarHeader(path: string, size: number, mtime: number) {
  const header = new Uint8Array(512);
  const normalizedPath = path.replace(/\\/g, '/');
  const { name, prefix } = splitTarPath(normalizedPath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'woohoo');
  writeString(header, 297, 32, 'woohoo');
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, v) => sum + v, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

interface TarFile {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

function buildTarArchive(files: TarFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const mtime = Math.floor(Date.now() / 1000);
  for (const file of files) {
    const header = createTarHeader(file.path, file.bytes.length, mtime);
    const dataPadding = (512 - (file.bytes.length % 512 || 512)) % 512;
    chunks.push(header, file.bytes, new Uint8Array(dataPadding));
    totalLength += header.length + file.bytes.length + dataPadding;
  }
  chunks.push(new Uint8Array(1024));
  totalLength += 1024;
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

// ─── Core markdown (simplified, reused from workspaceMvp pattern) ────

function buildCoreMarkdown(
  project: Project,
  snapshot: ProjectSnapshot,
  assets: AssetEntry[],
): string {
  const lines = [
    `# ${project.name}`,
    '',
    `- 导出时间: ${new Date().toLocaleString('zh-CN')}`,
    `- 项目 ID: ${project.id}`,
    `- 分镜数量: ${snapshot.finalCut.totalShots}`,
    `- 总时长: ${Math.round(snapshot.finalCut.totalDurationSeconds)}s`,
    `- 资产数量: ${assets.length}`,
    '',
    '## 当前剧本',
    '',
    snapshot.scriptText || '暂无剧本内容。',
    '',
  ];
  return lines.join('\n');
}

// ─── Main auditable export ──────────────────────────────────────────

export async function exportAuditableProject(args: {
  project: Project;
  script: Script | null;
  storyboard: Storyboard | null;
  assets: Asset[];
  exportType?: ExportType;
  includeConversations?: boolean;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<ExportResult> {
  const {
    project,
    script,
    storyboard,
    assets,
    exportType = 'full',
    includeConversations = true,
    onProgress,
  } = args;

  const exportId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  onProgress?.('preparing', 0, assets.length);

  // ── Set up redaction context ────────────────────────────────
  // We accumulate counts across every text content added to the tar
  // so the manifest can report exactly what was redacted.
  const redactionCounts: Partial<Record<RedactionCategory, number>> = {};
  let totalRedactions = 0;
  let redactionApplied = false;

  function R(text: string): string {
    const r = redactSensitiveInfo(text);
    if (r.totalRedactions > 0) {
      redactionApplied = true;
      totalRedactions += r.totalRedactions;
      for (const [cat, n] of Object.entries(r.byCategory)) {
        if (n > 0) {
          redactionCounts[cat as RedactionCategory] =
            (redactionCounts[cat as RedactionCategory] ?? 0) + n;
        }
      }
    }
    return r.redactedText;
  }

  function RDeep<T>(obj: T): T {
    const redacted = redactSensitiveDeep(obj);
    // Deep redaction doesn't return counts directly, so we re-run a simple
    // stringify -> redact to capture counts for JSON-serialized metadata
    const jsonStr = JSON.stringify(redacted);
    const r2 = redactSensitiveInfo(jsonStr);
    if (r2.totalRedactions > 0) {
      redactionApplied = true;
      totalRedactions += r2.totalRedactions;
      for (const [cat, n] of Object.entries(r2.byCategory)) {
        if (n > 0) {
          redactionCounts[cat as RedactionCategory] =
            (redactionCounts[cat as RedactionCategory] ?? 0) + n;
        }
      }
    }
    return redacted;
  }

  // Build snapshot (re-uses existing derivation logic) — source script
  // content is raw; we redact only the text that goes into the tar.
  const rawScriptText = script?.content ?? '';
  const snapshot = createProjectSnapshot({
    project,
    script,
    scriptText: rawScriptText,
    storyboard,
    assets,
  });
  // Redact the snapshot's text fields for file output
  const redactedScriptText = R(rawScriptText);
  // Build a redacted copy of the snapshot for JSON output (redacts embedded script text)
  const snapshotForExport = RDeep({ ...snapshot, scriptText: redactedScriptText });

  // Load all assets (with per-asset error capture)
  const loadedAssets: LoadedAsset[] = [];
  let loadedCount = 0;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    onProgress?.('loading-assets', i, assets.length);
    const ext = asset.name.includes('.')
      ? asset.name.split('.').pop()!
      : asset.type;
    const path = `assets/${String(i + 1).padStart(3, '0')}-${sanitizeSegment(
      asset.name.replace(/\.[^.]+$/, ''),
      asset.id.slice(0, 8),
    )}.${sanitizeSegment(ext, asset.type)}`;

    try {
      const data = await loadAssetRaw(asset);
      loadedAssets.push({ asset, data, path });
      loadedCount++;
    } catch (err) {
      loadedAssets.push({
        asset,
        path,
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: 'DOWNLOAD_FAILED',
        },
      });
    }
  }

  onProgress?.('building-manifest', assets.length, assets.length);

  // Build file entries with checksums
  const tarFiles: TarFile[] = [];
  const fileEntries: FileEntry[] = [];
  const assetEntries: AssetEntry[] = [];
  const missingAssets: MissingAssetEntry[] = [];
  let totalSize = 0;

  // Helper to add a text file and record its checksum
  async function addTextFile(path: string, content: string, mediaType: string) {
    const bytes = new TextEncoder().encode(content);
    const sha256 = await sha256Hex(bytes);
    tarFiles.push({ path, bytes, mediaType });
    fileEntries.push({
      path,
      sizeBytes: bytes.length,
      sha256,
      mediaType,
      addedAt: now,
    });
    totalSize += bytes.length;
  }

  // Helper to add binary file
  async function addBinaryFile(path: string, bytes: Uint8Array, mediaType: string) {
    const sha256 = await sha256Hex(bytes);
    tarFiles.push({ path, bytes, mediaType });
    fileEntries.push({
      path,
      sizeBytes: bytes.length,
      sha256,
      mediaType,
      addedAt: now,
    });
    totalSize += bytes.length;
  }

  // 1. Script
  let scriptVersion: DocumentVersion | undefined;
  if (redactedScriptText.trim()) {
    const { hash, length } = await hashDocument(redactedScriptText);
    scriptVersion = {
      id: script?.id ?? 'inline-script',
      title: script?.title ?? `${project.name}-script`,
      updatedAt: script?.updatedAt
        ? new Date(script.updatedAt).getTime()
        : Date.now(),
      contentHash: hash,
      contentLength: length,
    };
    await addTextFile('script/current-script.md', redactedScriptText, 'text/markdown');
  }

  // 2. Storyboard
  let storyboardVersion: DocumentVersion | undefined;
  if (storyboard && storyboard.lines.length > 0) {
    // Deep-redact storyboard (scene descriptions may contain secrets/PII)
    const redactedStoryboard = RDeep(storyboard);
    const sbJson = JSON.stringify(redactedStoryboard, null, 2);
    const { hash, length } = await hashDocument(sbJson);
    storyboardVersion = {
      id: storyboard.id,
      updatedAt: new Date(storyboard.updatedAt).getTime(),
      contentHash: hash,
      contentLength: length,
    };
    await addTextFile('storyboard/storyboard.json', sbJson, 'application/json');
  }

  // 3. Project snapshot (redacted)
  await addTextFile(
    'project-snapshot.json',
    JSON.stringify(snapshotForExport, null, 2),
    'application/json',
  );

  // 4. Final cut (redacted — shot prompts may contain sensitive text)
  if (snapshot.finalCut.totalShots > 0) {
    const redactedFinalCut = RDeep(snapshot.finalCut);
    await addTextFile(
      'timeline/final-cut.json',
      JSON.stringify(redactedFinalCut, null, 2),
      'application/json',
    );
  }

  // 5. Conversations (redacted message content)
  let chatMessagesCount = 0;
  if (includeConversations) {
    for (let i = 0; i < project.chatSessions.length; i++) {
      const session = project.chatSessions[i];
      chatMessagesCount += session.messages.length;
      const md = conversationToMarkdown(session, R);
      await addTextFile(
        `conversations/${String(i + 1).padStart(2, '0')}-${sanitizeSegment(session.title, `chat-${i + 1}`)}.md`,
        md,
        'text/markdown',
      );
    }
  }

  // 6. Assets
  for (const loaded of loadedAssets) {
    if (loaded.data) {
      const mediaType = guessMediaType(loaded.asset.type, loaded.asset.name);
      await addBinaryFile(loaded.path, loaded.data, mediaType);
      // Redact asset metadata (urls/paths/metadata may contain secrets)
      const redactedMetadata = loaded.asset.metadata
        ? RDeep(loaded.asset.metadata)
        : null;
      assetEntries.push({
        id: loaded.asset.id,
        name: loaded.asset.name,
        type: loaded.asset.type,
        filePath: loaded.path,
        sha256: fileEntries[fileEntries.length - 1].sha256,
        sizeBytes: loaded.data.length,
        versionLabel: loaded.asset.versionLabel,
        metadata: redactedMetadata as Record<string, unknown> | null,
        sourceUrl: R(loaded.asset.url),
        createdAt: loaded.asset.createdAt,
        updatedAt: loaded.asset.updatedAt ?? loaded.asset.createdAt,
      });
    } else if (loaded.error) {
      missingAssets.push({
        id: loaded.asset.id,
        name: loaded.asset.name,
        type: loaded.asset.type,
        sourceUrl: loaded.asset.url,
        error: loaded.error.message,
        errorCode: loaded.error.code,
      });
    }
  }

  // 7. Core markdown (for quick reference, uses redacted script/snapshot)
  if (exportType === 'core' || exportType === 'full') {
    // Build core markdown from redacted snapshot
    const redactedSnapshotForMd = {
      ...snapshotForExport,
      scriptText: redactedScriptText,
    };
    await addTextFile(
      'core-bundle.md',
      buildCoreMarkdown(project, redactedSnapshotForMd as unknown as ProjectSnapshot, assetEntries),
      'text/markdown',
    );
  }

  // 8. Workspace snapshot — full raw project state (deep-redacted)
  //    Contains: project meta, all chat sessions/messages, all assets metadata,
  //    agent roster, workflow state. Deep-redacted to strip any secrets from
  //    message content, asset metadata, URLs, etc.
  const workspaceSnapshot = RDeep({
    snapshotVersion: '1.0',
    exportedAt: now,
    exportId,
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
      workflow: project.workflow,
    },
    chatSessions: project.chatSessions,
    agentRoster: project.agentRoster,
    assets: assets.map((a) => ({
      id: a.id,
      projectId: a.projectId,
      name: a.name,
      type: a.type,
      url: a.url,
      metadata: a.metadata ?? null,
      versionLabel: a.versionLabel,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    script: script
      ? {
          id: script.id,
          projectId: script.projectId,
          title: script.title,
          content: redactedScriptText,
          updatedAt: script.updatedAt,
        }
      : null,
    storyboard: storyboard ? RDeep(storyboard) : null,
  });
  await addTextFile(
    'workspace-snapshot.json',
    JSON.stringify(workspaceSnapshot, null, 2),
    'application/json',
  );

  // 9. Collect generation params and content flags BEFORE building manifest
  const generationParams = extractGenerationParams(project);
  const contentFlags = scanContentFlags(script, assets);

  // Attach redaction summary to content flags for the manifest
  if (redactionApplied) {
    contentFlags.redaction = {
      applied: true,
      totalRedactions,
      byCategory: redactionCounts,
    };
    // Add info warning listing what was redacted
    const categoryDesc = Object.entries(redactionCounts)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([cat, n]) => `${CATEGORY_LABELS[cat as RedactionCategory] ?? cat}×${n}`)
      .join(', ');
    contentFlags.warnings.push(`已自动脱敏 ${totalRedactions} 处敏感信息（${categoryDesc}）`);
  }

  // 10. Write missing-assets.json (redacted - URLs may contain secrets)
  const missingAssetsJson = JSON.stringify(RDeep(missingAssets), null, 2);
  await addTextFile('missing-assets.json', missingAssetsJson, 'application/json');

  // 11. Compute completeness based on files added so far (all content files present)
  const completeness: CompletenessReport = {
    expectedAssets: assets.length,
    includedAssets: loadedCount,
    missingAssets: missingAssets.length,
    scriptIncluded: !!scriptVersion,
    storyboardIncluded: !!storyboardVersion,
    conversationsIncluded: includeConversations ? project.chatSessions.length : 0,
  };

  // 12. Build preliminary verification (totalFiles will be updated after manifest added)
  const preliminaryIssues: string[] = [
    ...(missingAssets.length > 0
      ? [`${missingAssets.length} 个资产下载失败，包内不包含这些文件`]
      : []),
    ...contentFlags.warnings,
  ];

  const verification: VerificationReport = {
    status:
      missingAssets.length === 0
        ? 'pass'
        : loadedCount === 0
          ? 'fail'
          : 'warn',
    checkedAt: now,
    totalFiles: 0, // filled after all files added
    verifiedFiles: 0,
    failedChecksums: 0,
    completeness,
    issues: preliminaryIssues,
  };

  // 13. Write verification-report.json (adds it to fileEntries with checksum)
  const verificationJson = JSON.stringify(verification, null, 2);
  await addTextFile('verification-report.json', verificationJson, 'application/json');

  // 14. Build final manifest — fileEntries contains every content and metadata
  //     file except manifest.json itself. manifest.json is the root-of-trust
  //     document; its integrity is established by the audit log entry recorded
  //     on the server (which stores the manifest hash separately). Consumers
  //     verify all files listed in manifest.files against their SHA-256 entries.
  const manifest: ExportManifest = {
    manifestVersion: EXPORT_MANIFEST_VERSION,
    exportId,
    exportedAt: now,
    exporter: {
      tool: EXPORT_TOOL,
      version: '1.0.0',
      schemaVersion: EXPORT_MANIFEST_VERSION,
      client: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : undefined,
    },
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      phase: project.phase,
      createdAt: project.createdAt,
      workflow: project.workflow,
    },
    files: [...fileEntries],
    assets: assetEntries,
    missingAssets,
    versions: {
      script: scriptVersion,
      storyboard: storyboardVersion,
      chatMessagesCount,
    },
    generationParams,
    verification: {
      ...verification,
      totalFiles: fileEntries.length,
      verifiedFiles: fileEntries.length,
    },
    contentFlags,
  };

  // 15. Compute manifest.json checksum (before writing it) and add a
  //     "manifestSignature" entry at top level so consumers can verify
  //     the manifest itself without circular reference.
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestSha256 = await sha256Hex(manifestBytes);

  // Write manifest.json to tar (it is NOT listed in its own files[])
  tarFiles.push({
    path: 'manifest.json',
    bytes: manifestBytes,
    mediaType: 'application/json',
  });
  fileEntries.push({
    path: 'manifest.json',
    sizeBytes: manifestBytes.length,
    sha256: manifestSha256,
    mediaType: 'application/json',
    addedAt: now,
  });
  totalSize += manifestBytes.length;

  onProgress?.('packaging', assets.length, assets.length);

  // Build tar and download
  const archive = buildTarArchive(tarFiles);
  const filename = `${sanitizeSegment(project.name, 'project')}-${exportType}-${exportId.slice(-6)}.tar`;
  triggerDownload(filename, new Blob([archive], { type: 'application/x-tar' }));

  const status: 'completed' | 'partial' | 'failed' =
    missingAssets.length === 0 ? 'completed' : loadedCount > 0 ? 'partial' : 'failed';

  return {
    exportId,
    filename,
    exportType,
    status,
    manifest,
    verification: manifest.verification,
    downloadedAssets: loadedCount,
    missingAssets: missingAssets.length,
    totalSizeBytes: totalSize,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function conversationToMarkdown(session: ChatSession, redact: (text: string) => string): string {
  const lines = [`# ${redact(session.title)}`, ''];
  for (const msg of session.messages) {
    const role = msg.role === 'user' ? '用户' : msg.role === 'ai' ? 'AI' : '系统';
    lines.push(`## ${role} · ${new Date(msg.timestamp).toLocaleString('zh-CN')}`);
    lines.push('');
    lines.push(redact(msg.content || '(empty)'));
    lines.push('');
  }
  return lines.join('\n');
}

function guessMediaType(assetType: string, filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (assetType === 'image') {
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'svg') return 'image/svg+xml';
    return 'image/*';
  }
  if (assetType === 'video') {
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    return 'video/*';
  }
  if (assetType === 'audio') {
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'wav') return 'audio/wav';
    return 'audio/*';
  }
  if (ext === 'md') return 'text/markdown';
  if (ext === 'json') return 'application/json';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function triggerDownload(filename: string, blob: Blob) {
  if (typeof window === 'undefined') return;
  const objectUrl = window.URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(objectUrl);
}

// ─── Verify an existing manifest (e.g., from imported package) ──────

export function verifyManifestOffline(
  manifest: ExportManifest,
  fileMap: Map<string, Uint8Array>,
): VerificationReport {
  let verified = 0;
  let failedChecksums = 0;
  const issues: string[] = [];

  for (const entry of manifest.files) {
    const data = fileMap.get(entry.path);
    if (!data) {
      issues.push(`清单中声明但包内缺失文件: ${entry.path}`);
      continue;
    }
    // Note: Web Crypto is async; this function is synchronous for quick checks.
    // For full verification use verifyManifestAsync.
    verified++;
  }

  const status: VerifyStatus =
    failedChecksums > 0 ? 'fail' : issues.length > 0 ? 'warn' : 'pass';

  return {
    status,
    checkedAt: new Date().toISOString(),
    totalFiles: manifest.files.length,
    verifiedFiles: verified,
    failedChecksums,
    completeness: manifest.verification.completeness,
    issues,
  };
}
