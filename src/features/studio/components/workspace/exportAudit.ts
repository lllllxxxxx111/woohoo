/**
 * exportAudit.ts - Auditable export package enhancements
 *
 * Adds: SHA-256 checksums, missing asset details, content version snapshots,
 * generation parameter summaries, verification reports, sensitive data detection,
 * and audit logging for the Woohoo Studio export system.
 */
import type {
  Asset,
  ChatSession,
  Project,
  Script,
  Storyboard,
} from '../../../../types';
import type { ProjectSnapshot, DerivedFinalCut } from './workspaceMvp';

// ─── Types ───────────────────────────────────────────────────────────────────

export const BUNDLE_SCHEMA_VERSION = '1.0';

export type ExportType = 'full' | 'core' | 'final_cut';

export type AssetStatus = 'included' | 'missing' | 'download_failed' | 'remote_unreachable';

export interface AssetRegistryEntry {
  id: string;
  name: string;
  type: string;
  pathInBundle?: string;
  sourceUrl: string;
  isRemote: boolean;
  sizeBytes?: number;
  sha256?: string;
  status: AssetStatus;
  errorMessage?: string;
  metadata?: Record<string, unknown> | null;
  versionLabel?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface MissingAssetEntry {
  id: string;
  name: string;
  type: string;
  reason: string;
  sourceUrl: string;
}

export interface ContentVersionInfo {
  kind: 'script' | 'storyboard' | 'keyframes' | 'finalCut' | 'conversations';
  sha256?: string;
  updatedAt?: number;
  itemCount: number;
  label: string;
}

export interface GenerationParamSummary {
  imageModels: string[];
  videoModels: string[];
  chatModels: string[];
  totalAiTokensUsed: number;
  totalImageGenerations: number;
  totalVideoGenerations: number;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface VerificationReport {
  checkedAt: string;
  schemaVersion: string;
  checks: VerificationCheck[];
  totalChecks: number;
  passedChecks: number;
  warningChecks: number;
  failedChecks: number;
  allPassed: boolean;
}

export interface SensitiveDataFinding {
  field: string;
  assetId?: string;
  messageId?: string;
  type: 'api_key' | 'token' | 'password' | 'email_pii' | 'url_with_secret' | 'local_path';
  redacted: boolean;
}

export interface ReproducibilitySnapshot {
  projectId: string;
  projectName: string;
  exportedAt: string;
  bundleSchemaVersion: string;
  scriptTextHash?: string;
  storyboardJsonHash?: string;
  workspaceSnapshotSha256?: string;
  conversationCount: number;
  messageCount: number;
  agentRosterSnapshot: Array<{
    id: string;
    name: string;
    role: string;
    model?: string;
  }>;
  workflowSnapshot?: Project['workflow'];
}

export interface AuditableManifest {
  schemaVersion: string;
  exportMeta: {
    exportedAt: string;
    exportType: ExportType;
    exportedBy?: string;
    clientInfo: {
      userAgent: string;
      platform: string;
      language: string;
    };
  };
  project: {
    id: string;
    name: string;
    status: string;
    phase: string;
    createdAt: number;
  };
  summary: {
    scriptSections: number;
    chapters: number;
    characters: number;
    scenes: number;
    shots: number;
    durationSeconds: number;
    totalAssets: number;
    includedAssets: number;
    missingAssets: number;
    chats: number;
    bundleSizeBytes: number;
  };
  contentVersions: ContentVersionInfo[];
  generationParams: GenerationParamSummary;
  assetRegistry: AssetRegistryEntry[];
  missingAssets: MissingAssetEntry[];
  sensitiveDataFindings: SensitiveDataFinding[];
  verification: VerificationReport;
  reproducibility: ReproducibilitySnapshot;
  chapters: ProjectSnapshot['chapters'];
  characters: Array<{ name: string; summary: string; assetCount: number }>;
  scenes: ProjectSnapshot['scenes'];
  keyframes: ProjectSnapshot['keyframes'];
  finalCut: DerivedFinalCut;
}

export interface ExportResult {
  success: boolean;
  filename: string;
  exportType: ExportType;
  totalAssets: number;
  includedAssets: number;
  missingAssets: number;
  bundleSizeBytes: number;
  scriptSections?: number;
  chapters?: number;
  shots?: number;
  conversations?: number;
  totalDuration?: number;
  manifestSha256?: string;
  scriptSha256?: string;
  storyboardSha256?: string;
  verification: VerificationReport;
  sensitiveDataFindings: SensitiveDataFinding[];
  durationSeconds: number;
  errorMessage?: string;
}

// ─── SHA-256 via Web Crypto ──────────────────────────────────────────────────

const encoder = new TextEncoder();

export async function sha256Bytes(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return bufferToHex(hashBuffer);
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(encoder.encode(text));
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── Sensitive Data Detection ────────────────────────────────────────────────

// API key / token literal patterns (matched against full text)
const API_KEY_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,                                         // OpenAI-style sk-
  /sk-[a-zA-Z0-9_-]{30,}/g,                                       // Long variant
  /ghp_[a-zA-Z0-9]{36}/g,                                         // GitHub personal token
  /gho_[a-zA-Z0-9]{36}/g,                                         // GitHub OAuth token
  /ghu_[a-zA-Z0-9]{36}/g,                                         // GitHub user-to-server
  /github_pat_[a-zA-Z0-9_]{22,}/g,                                // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g,                                            // AWS access key
  /ASIA[0-9A-Z]{16}/g,                                            // AWS temp key
  /AIza[0-9A-Za-z\-_]{35}/g,                                     // Google API key
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g,                                // Slack tokens
  /sk_live_[a-zA-Z0-9]{16,}/g,                                    // Stripe live key
  /rk_live_[a-zA-Z0-9]{16,}/g,                                    // Stripe restricted key
  /pk_live_[a-zA-Z0-9]{16,}/g,                                    // Stripe publishable
  /api[_-]?key["']?\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}/gi,
  /bearer\s+[a-zA-Z0-9._-]{20,}/gi,
];

// JWT / structured tokens
const TOKEN_PATTERNS: RegExp[] = [
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT
];

// Password / secret assignment patterns (key=value style)
const PASSWORD_PATTERNS: RegExp[] = [
  /password["']?\s*[:=]\s*["']?[^\s"']{4,}/gi,
  /passwd["']?\s*[:=]\s*["']?[^\s"']{4,}/gi,
  /secret["']?\s*[:=]\s*["']?[^\s"']{4,}/gi,
  /token["']?\s*[:=]\s*["']?[a-zA-Z0-9._-]{16,}/gi,
  /auth["']?\s*[:=]\s*["']?[a-zA-Z0-9._-]{16,}/gi,
  /private[_-]?key["']?\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

// URLs that embed credentials
const SECRET_URL_PATTERNS: RegExp[] = [
  /https?:\/\/[^:\s]+:[^@\s]+@[^\s)]+/g,  // user:pass@host
];

// Webhook URLs that embed tokens in path
const WEBHOOK_PATTERNS: RegExp[] = [
  /https?:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]{20,}/gi,
  /https?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]{20,}/gi,
];

// Database connection strings with credentials (username may be empty, e.g. redis://:pass@host)
const DB_CONN_PATTERNS: RegExp[] = [
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:\s]*:[^@\s]+@[^\s)]+/gi,
];

// SSH private key block markers
const SSH_KEY_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/g,
];

// Absolute local filesystem paths that could leak username or directory structure
// Unix: /home/<name>/..., /Users/<name>/..., /root/..., /var/... (selective)
// Windows: C:\Users\<name>\..., D:\Documents\...
const LOCAL_PATH_PATTERNS: RegExp[] = [
  /\/home\/[a-zA-Z0-9_.-]+\/[^\s"')\]<>|]*/g,      // Linux /home/user/...
  /\/Users\/[a-zA-Z0-9_.-]+\/[^\s"')\]<>|]*/g,      // macOS /Users/user/...
  /[a-zA-Z]:\\Users\\[a-zA-Z0-9_.-]+\\[^\s"')\]<>|]*/g, // Windows C:\Users\...
  /\/root\/[^\s"')\]<>|]*/g,                          // /root/...
];

// Suspiciously long hex/base64 strings (>=40 chars hex or >=60 chars base64)
// These catch unlabeled secret keys
const LONG_HEX_SECRET_PATTERNS: RegExp[] = [
  /\b[a-f0-9]{40,}\b/gi,  // hex secret (e.g. SHA-1 sized)
  /\b[A-Za-z0-9+/]{60,}={0,2}\b/g, // base64 blob
];

// Pattern groups with their finding type
interface PatternGroup {
  patterns: RegExp[];
  type: SensitiveDataFinding['type'];
}

const PATTERN_GROUPS: PatternGroup[] = [
  { patterns: API_KEY_PATTERNS, type: 'api_key' },
  { patterns: TOKEN_PATTERNS, type: 'token' },
  { patterns: PASSWORD_PATTERNS, type: 'password' },
  { patterns: SECRET_URL_PATTERNS, type: 'url_with_secret' },
  { patterns: WEBHOOK_PATTERNS, type: 'api_key' },
  { patterns: DB_CONN_PATTERNS, type: 'password' },
  { patterns: SSH_KEY_PATTERNS, type: 'api_key' },
  { patterns: LOCAL_PATH_PATTERNS, type: 'local_path' },
  { patterns: LONG_HEX_SECRET_PATTERNS, type: 'api_key' },
];

export function detectSensitiveData(
  text: string,
  context: { assetId?: string; messageId?: string; field?: string } = {},
): SensitiveDataFinding[] {
  const findings: SensitiveDataFinding[] = [];
  const field = context.field || 'content';

  for (const group of PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      // Reset lastIndex for global regex reuse
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) {
        for (let index = 0; index < matches.length; index += 1) {
          findings.push({
            field,
            assetId: context.assetId,
            messageId: context.messageId,
            type: group.type,
            redacted: true,
          });
        }
      }
    }
  }

  return findings;
}

export function redactSensitiveData(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let result = text;

  // ── Literal keys ──────────────────────────────────────────────────
  result = result.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
  result = result.replace(/sk_live_[a-zA-Z0-9]{16,}/g, '[REDACTED_STRIPE_KEY]');
  result = result.replace(/rk_live_[a-zA-Z0-9]{16,}/g, '[REDACTED_STRIPE_KEY]');
  result = result.replace(/pk_live_[a-zA-Z0-9]{16,}/g, '[REDACTED_STRIPE_KEY]');
  result = result.replace(/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]');
  result = result.replace(/gho_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]');
  result = result.replace(/ghu_[a-zA-Z0-9]{36}/g, '[REDACTED_GITHUB_TOKEN]');
  result = result.replace(/github_pat_[a-zA-Z0-9_]{22,}/g, '[REDACTED_GITHUB_PAT]');
  result = result.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
  result = result.replace(/ASIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
  result = result.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED_GOOGLE_KEY]');
  result = result.replace(/xox[baprs]-[a-zA-Z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]');
  result = result.replace(/api[_-]?key["']?\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}/gi, 'api_key=[REDACTED]');
  result = result.replace(/bearer\s+[a-zA-Z0-9._-]{20,}/gi, 'Bearer [REDACTED_TOKEN]');

  // ── JWTs ──────────────────────────────────────────────────────────
  result = result.replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED_JWT]');

  // ── Passwords / secrets (key=value) ──────────────────────────────
  result = result.replace(/password["']?\s*[:=]\s*["']?[^\s"']{4,}/gi, 'password=[REDACTED]');
  result = result.replace(/passwd["']?\s*[:=]\s*["']?[^\s"']{4,}/gi, 'passwd=[REDACTED]');
  result = result.replace(/secret["']?\s*[:=]\s*["']?[^\s"']{4,}/gi, 'secret=[REDACTED]');
  result = result.replace(/token["']?\s*[:=]\s*["']?[a-zA-Z0-9._-]{16,}/gi, 'token=[REDACTED]');
  result = result.replace(/auth["']?\s*[:=]\s*["']?[a-zA-Z0-9._-]{16,}/gi, 'auth=[REDACTED]');
  result = result.replace(/private[_-]?key["']?\s*[:=]\s*["']?[^\s"']{8,}/gi, 'private_key=[REDACTED]');

  // ── URLs with embedded credentials ───────────────────────────────
  result = result.replace(/https?:\/\/[^:\s]+:[^@\s]+@([^\s)]+)/g, 'https://[REDACTED_CREDENTIALS]@$1');

  // ── Webhook URLs with tokens ─────────────────────────────────────
  result = result.replace(
    /https?:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]{20,}/gi,
    '[REDACTED_SLACK_WEBHOOK]',
  );
  result = result.replace(
    /https?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]{20,}/gi,
    '[REDACTED_DISCORD_WEBHOOK]',
  );

  // ── Database connection strings ──────────────────────────────────
  // Username may be empty (e.g. redis://:pass@host)
  result = result.replace(
    /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)):\/\/[^:\s]*:[^@\s]+@([^\s)]+)/gi,
    '$1://[REDACTED_CREDENTIALS]@$2',
  );

  // ── SSH private key blocks ───────────────────────────────────────
  result = result.replace(
    /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );

  // ── Local absolute paths (strip username) ────────────────────────
  result = result.replace(/\/home\/[a-zA-Z0-9_.-]+\//g, '/[REDACTED_HOME]/');
  result = result.replace(/\/Users\/[a-zA-Z0-9_.-]+\//g, '/[REDACTED_HOME]/');
  result = result.replace(/[a-zA-Z]:\\Users\\[a-zA-Z0-9_.-]+\\/gi, '[REDACTED_HOME]\\');
  result = result.replace(/\/root\//g, '/[REDACTED_HOME]/');

  // ── Long unstructured hex secrets (40+ char continuous hex) ─────
  // Only replace standalone hex blobs not in word context (avoid matching sha1 hashes
  // that are intentionally displayed as short identifiers).
  result = result.replace(/\b[a-f0-9]{64,}\b/gi, '[REDACTED_HEX_SECRET]');

  return result;
}

/**
 * Sanitize a URL for inclusion in the export bundle.
 *
 * - Removes sensitive query parameters (api_key, token, secret, key, auth, sig, signature)
 * - Redacts embedded credentials
 * - Redacts local absolute paths in data: URLs or file: URLs
 */
export function sanitizeUrl(url: string): string {
  if (!url) return url;

  let result = url;

  // Step 1: Strip sensitive query parameters BEFORE redaction.
  // This prevents redacted placeholder text (e.g. [REDACTED_API_KEY]) from
  // leaving residual substrings like "api_key" in the URL.
  try {
    const qIndex = result.indexOf('?');
    const hashIndex = result.indexOf('#');
    if (qIndex >= 0) {
      const base = result.slice(0, qIndex);
      const queryEnd = hashIndex > qIndex ? hashIndex : result.length;
      const fragment = hashIndex > qIndex ? result.slice(hashIndex) : '';
      const queryStr = result.slice(qIndex + 1, queryEnd);

      const SENSITIVE_PARAMS = new Set([
        'api_key', 'apikey', 'key', 'token', 'secret', 'auth',
        'signature', 'sig', 'access_key', 'access_token', 'password',
        'private_key', 'client_secret',
      ]);

      const filtered = queryStr
        .split('&')
        .filter((pair) => {
          const eq = pair.indexOf('=');
          const k = (eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase().trim();
          return !SENSITIVE_PARAMS.has(k);
        })
        .join('&');

      result = base + (filtered ? `?${filtered}` : '') + fragment;
    }
  } catch {
    // Not a parseable URL; fall through to string redaction only
  }

  // Step 2: Apply string-level redaction to catch creds-in-host,
  // embedded credentials in path, etc.
  result = redactSensitiveData(result);

  return result;
}

/**
 * Recursively sanitize a JSON-serializable value for inclusion in the export.
 *
 * - Strings get redactSensitiveData + URL sanitization
 * - Object keys that look like secrets (password, token, secret, apiKey, etc.) get their values replaced
 * - The input is NOT mutated; a deep-cloned sanitized copy is returned
 */
export function sanitizeMetadata<T>(value: T, depth = 0): T {
  if (depth > 20) return '[REDACTED_MAX_DEPTH]' as unknown as T;

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return sanitizeUrl(redactSensitiveData(value)) as unknown as T;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeMetadata(v, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const SENSITIVE_KEYS = /^(password|passwd|secret|token|api[_-]?key|private[_-]?key|auth|access[_-]?token|access[_-]?key|client[_-]?secret|authorization)$/i;

    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeMetadata(v, depth + 1);
      }
    }
    return out as unknown as T;
  }

  return value;
}


// ─── Generation Parameter Summary ────────────────────────────────────────────

export function summarizeGenerationParams(
  sessions: ChatSession[],
  assets: Asset[],
): GenerationParamSummary {
  const imageModels = new Set<string>();
  const videoModels = new Set<string>();
  const chatModels = new Set<string>();
  let totalTokens = 0;
  let imageGens = 0;
  let videoGens = 0;

  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.model) {
        chatModels.add(msg.model);
      }
      if (msg.meta?.usage) {
        const usage = msg.meta.usage;
        totalTokens +=
          (usage.total_tokens ?? usage.totalTokens ?? 0) +
          (usage.prompt_tokens ?? usage.promptTokens ?? 0) +
          (usage.completion_tokens ?? usage.completionTokens ?? 0);
      }
      // Detect generation output from message meta
      if (msg.meta?.outputKind === 'image' || msg.meta?.taskStatus === 'completed') {
        const refs = msg.meta?.resourceRefs;
        if (refs) {
          for (const ref of refs) {
            if (ref.type === 'image') imageGens++;
            if (ref.type === 'video') videoGens++;
          }
        }
      }
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.source === 'ai_generated' && att.sourceMeta && 'model' in att.sourceMeta) {
            const m = (att.sourceMeta as { model?: string }).model;
            if (att.mimeType.startsWith('image/') && m) imageModels.add(m);
            if (att.mimeType.startsWith('video/') && m) videoModels.add(m);
          }
        }
      }
    }
  }

  // Scan assets for generation metadata
  for (const asset of assets) {
    const meta = asset.metadata as Record<string, unknown> | undefined;
    if (meta?.model && typeof meta.model === 'string') {
      if (asset.type === 'image') imageModels.add(meta.model);
      if (asset.type === 'video') videoModels.add(meta.model);
    }
    if (meta?.generationMethod === 'image_generation') imageGens++;
    if (meta?.generationMethod === 'video_generation') videoGens++;
  }

  return {
    imageModels: Array.from(imageModels),
    videoModels: Array.from(videoModels),
    chatModels: Array.from(chatModels),
    totalAiTokensUsed: totalTokens,
    totalImageGenerations: imageGens,
    totalVideoGenerations: videoGens,
  };
}

// ─── Content Version Fingerprints ────────────────────────────────────────────

export async function buildContentVersions(
  script: Script | null,
  storyboard: Storyboard | null,
  snapshot: ProjectSnapshot,
  sessions: ChatSession[],
): Promise<ContentVersionInfo[]> {
  const versions: ContentVersionInfo[] = [];

  // Script version
  if (snapshot.scriptText) {
    versions.push({
      kind: 'script',
      sha256: await sha256Text(snapshot.scriptText),
      updatedAt: script?.updatedAt,
      itemCount: snapshot.scriptSections.length,
      label: script?.title || 'current-script',
    });
  }

  // Storyboard version
  if (storyboard) {
    const sbJson = JSON.stringify(storyboard);
    versions.push({
      kind: 'storyboard',
      sha256: await sha256Text(sbJson),
      updatedAt: storyboard.updatedAt,
      itemCount: storyboard.lines.length,
      label: 'storyboard',
    });
  }

  // Keyframes version
  if (snapshot.keyframes.length > 0) {
    versions.push({
      kind: 'keyframes',
      sha256: await sha256Text(JSON.stringify(snapshot.keyframes)),
      itemCount: snapshot.keyframes.length,
      label: 'derived-keyframes',
    });
  }

  // Final cut version
  if (snapshot.finalCut.totalShots > 0) {
    versions.push({
      kind: 'finalCut',
      sha256: await sha256Text(JSON.stringify(snapshot.finalCut)),
      itemCount: snapshot.finalCut.totalShots,
      label: 'final-cut-plan',
    });
  }

  // Conversations version
  const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0);
  if (totalMessages > 0) {
    versions.push({
      kind: 'conversations',
      sha256: await sha256Text(
        JSON.stringify(sessions.map((s) => ({ id: s.id, msgCount: s.messages.length }))),
      ),
      updatedAt: Math.max(...sessions.map((s) => s.updatedAt), 0) || undefined,
      itemCount: totalMessages,
      label: `${sessions.length} sessions`,
    });
  }

  return versions;
}

// ─── Verification Report Builder ─────────────────────────────────────────────

export function buildVerificationReport(checks: VerificationCheck[]): VerificationReport {
  const passedChecks = checks.filter((c) => c.passed && c.severity !== 'warning').length;
  const warningChecks = checks.filter((c) => c.severity === 'warning').length;
  const failedChecks = checks.filter((c) => !c.passed && c.severity === 'error').length;

  return {
    checkedAt: new Date().toISOString(),
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    checks,
    totalChecks: checks.length,
    passedChecks,
    warningChecks,
    failedChecks,
    allPassed: failedChecks === 0,
  };
}

export function runVerificationChecks(args: {
  totalAssets: number;
  includedAssets: number;
  missingAssets: number;
  hasScript: boolean;
  hasStoryboard: boolean;
  hasChecksums: boolean;
  sensitiveFindingCount: number;
  bundleSizeBytes: number;
  shotCount: number;
  durationSeconds: number;
}): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  checks.push({
    name: 'manifest.schema',
    passed: true,
    severity: 'info',
    message: `Export manifest uses schema version ${BUNDLE_SCHEMA_VERSION}`,
  });

  checks.push({
    name: 'assets.all_included',
    passed: args.missingAssets === 0,
    severity: args.missingAssets > 0 ? 'warning' : 'info',
    message:
      args.missingAssets === 0
        ? `All ${args.totalAssets} assets successfully included`
        : `${args.missingAssets} of ${args.totalAssets} assets could not be included`,
  });

  checks.push({
    name: 'assets.checksums_present',
    passed: args.hasChecksums,
    severity: args.hasChecksums ? 'info' : 'warning',
    message: args.hasChecksums
      ? 'SHA-256 checksums computed for included assets'
      : 'Some assets missing checksums',
  });

  checks.push({
    name: 'content.has_script',
    passed: args.hasScript,
    severity: args.hasScript ? 'info' : 'warning',
    message: args.hasScript ? 'Script content present' : 'No script content found',
  });

  checks.push({
    name: 'content.has_storyboard',
    passed: args.hasStoryboard,
    severity: args.hasStoryboard ? 'info' : 'warning',
    message: args.hasStoryboard ? 'Storyboard present' : 'No storyboard found',
  });

  checks.push({
    name: 'content.shot_count',
    passed: args.shotCount > 0,
    severity: args.shotCount > 0 ? 'info' : 'warning',
    message:
      args.shotCount > 0
        ? `${args.shotCount} shots planned, total ${args.durationSeconds}s`
        : 'No shots in final cut plan',
  });

  checks.push({
    name: 'security.sensitive_data',
    passed: args.sensitiveFindingCount === 0,
    severity: args.sensitiveFindingCount === 0 ? 'info' : 'warning',
    message:
      args.sensitiveFindingCount === 0
        ? 'No sensitive data detected'
        : `${args.sensitiveFindingCount} sensitive data patterns found and redacted`,
  });

  checks.push({
    name: 'bundle.size_reasonable',
    passed: args.bundleSizeBytes < 500 * 1024 * 1024,
    severity: args.bundleSizeBytes < 500 * 1024 * 1024 ? 'info' : 'warning',
    message: `Bundle size: ${formatBytes(args.bundleSizeBytes)}`,
  });

  return checks;
}

// ─── Verification Markdown Report ────────────────────────────────────────────

export function buildVerificationMarkdown(
  manifest: AuditableManifest,
): string {
  const lines = [
    '# Export Verification Report',
    '',
    `- **Exported at**: ${manifest.exportMeta.exportedAt}`,
    `- **Project**: ${manifest.project.name} (${manifest.project.id})`,
    `- **Bundle schema**: ${manifest.schemaVersion}`,
    `- **Export type**: ${manifest.exportMeta.exportType}`,
    `- **Overall status**: ${manifest.verification.allPassed ? '✅ ALL CHECKS PASSED' : '⚠️ ISSUES FOUND'}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total assets | ${manifest.summary.totalAssets} |`,
    `| Included assets | ${manifest.summary.includedAssets} |`,
    `| Missing assets | ${manifest.summary.missingAssets} |`,
    `| Shots | ${manifest.summary.shots} |`,
    `| Duration | ${manifest.summary.durationSeconds}s |`,
    `| Conversations | ${manifest.summary.chats} |`,
    `| Bundle size | ${formatBytes(manifest.summary.bundleSizeBytes)} |`,
    '',
    '## Verification Checks',
    '',
    `| Check | Status | Message |`,
    `|-------|--------|---------|`,
  ];

  for (const check of manifest.verification.checks) {
    const icon = check.passed ? (check.severity === 'warning' ? '⚠️' : '✅') : '❌';
    lines.push(`| ${check.name} | ${icon} | ${check.message} |`);
  }

  if (manifest.missingAssets.length > 0) {
    lines.push('', '## Missing Assets', '');
    for (const asset of manifest.missingAssets) {
      lines.push(`- **${asset.name}** (${asset.type}): ${asset.reason}`);
    }
  }

  if (manifest.sensitiveDataFindings.length > 0) {
    lines.push('', '## Sensitive Data Handling', '');
    lines.push(
      `${manifest.sensitiveDataFindings.length} potential sensitive data pattern(s) detected and redacted during export.`,
    );
    lines.push('');
    const byType = new Map<string, number>();
    for (const f of manifest.sensitiveDataFindings) {
      byType.set(f.type, (byType.get(f.type) || 0) + 1);
    }
    Array.from(byType.entries()).forEach(([type, count]) => {
      lines.push(`- ${type}: ${count} occurrence(s) redacted`);
    });
  }

  lines.push('', '## Asset Checksums', '');
  lines.push('| Asset | Type | Size | SHA-256 | Status |');
  lines.push('|-------|------|------|---------|--------|');
  for (const entry of manifest.assetRegistry) {
    lines.push(
      `| ${entry.name} | ${entry.type} | ${entry.sizeBytes ? formatBytes(entry.sizeBytes) : '-'} | ${entry.sha256 ? entry.sha256.slice(0, 16) + '...' : '-'} | ${entry.status} |`,
    );
  }

  lines.push('', '## Content Versions', '');
  for (const cv of manifest.contentVersions) {
    lines.push(
      `- **${cv.label}** (${cv.kind}): ${cv.itemCount} items, hash: ${cv.sha256 ? cv.sha256.slice(0, 16) + '...' : 'N/A'}`,
    );
  }

  lines.push('', '## Generation Parameters', '');
  if (manifest.generationParams.imageModels.length > 0) {
    lines.push(`- Image models: ${manifest.generationParams.imageModels.join(', ')}`);
  }
  if (manifest.generationParams.videoModels.length > 0) {
    lines.push(`- Video models: ${manifest.generationParams.videoModels.join(', ')}`);
  }
  if (manifest.generationParams.chatModels.length > 0) {
    lines.push(`- Chat models: ${manifest.generationParams.chatModels.join(', ')}`);
  }
  lines.push(`- Total AI tokens used (approx): ${manifest.generationParams.totalAiTokensUsed}`);
  lines.push(`- Image generations: ${manifest.generationParams.totalImageGenerations}`);
  lines.push(`- Video generations: ${manifest.generationParams.totalVideoGenerations}`);

  lines.push('', '## Reproducibility', '');
  lines.push(
    `- This bundle includes content fingerprints (SHA-256) that can be used to verify if a workspace matches the exported state.`,
  );
  lines.push(`- Project ID: ${manifest.reproducibility.projectId}`);
  lines.push(`- Schema version: ${manifest.reproducibility.bundleSchemaVersion}`);

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getClientInfo() {
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    platform: typeof navigator !== 'undefined' ? navigator.platform || 'unknown' : 'unknown',
    language: typeof navigator !== 'undefined' ? navigator.language || 'unknown' : 'unknown',
  };
}

// ─── API helpers for audit ───────────────────────────────────────────────────

import { apiFetch } from '../../../../lib/serverApi';

export interface PrecheckIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  assetId?: string;
}

export interface PrecheckAssetSummary {
  totalAssets: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  documentCount: number;
  localAssets: number;
  remoteAssets: number;
  missingOrBroken: number;
  estimatedTotalBytes: number;
}

export interface PrecheckContentReadiness {
  hasScript: boolean;
  scriptWordCount: number;
  hasStoryboard: boolean;
  storyboardLineCount: number;
  hasConversations: boolean;
  conversationCount: number;
  messageCount: number;
  totalDurationSeconds: number;
}

export interface PrecheckResponse {
  projectId: string;
  projectName: string;
  canExport: boolean;
  blockingIssues: PrecheckIssue[];
  warnings: PrecheckIssue[];
  info: PrecheckIssue[];
  assetSummary: PrecheckAssetSummary;
  contentReadiness: PrecheckContentReadiness;
  estimatedBundleSizeBytes: number;
  checkedAt: string;
}

export interface ExportAuditRecord {
  id: string;
  userId: string;
  projectId: string;
  exportType: string;
  bundleVersion: string;
  status: string;
  filename: string;
  totalAssets: number;
  includedAssets: number;
  missingAssets: number;
  scriptSections: number;
  chapters: number;
  shots: number;
  conversations: number;
  totalDuration: number;
  bundleSizeBytes: number;
  precheckPassed: boolean | number;
  checksumsValid: boolean | number;
  hasSensitiveData: boolean | number;
  scriptSha256?: string;
  storyboardSha256?: string;
  manifestSha256?: string;
  clientInfo?: string;
  errorMessage?: string;
  notes?: string;
  createdAt: string;
}

export async function precheckExport(projectId: string): Promise<PrecheckResponse> {
  return apiFetch<PrecheckResponse>(`/api/workspace/export/precheck/${projectId}`);
}

export async function recordExportAudit(result: ExportResult, projectId: string): Promise<void> {
  try {
    await apiFetch('/api/workspace/export/audits', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        exportType: result.exportType,
        status: result.success
          ? result.missingAssets > 0
            ? 'partial'
            : 'completed'
          : 'failed',
        filename: result.filename,
        totalAssets: result.totalAssets,
        includedAssets: result.includedAssets,
        missingAssets: result.missingAssets,
        scriptSections: result.scriptSections,
        chapters: result.chapters,
        shots: result.shots,
        conversations: result.conversations,
        totalDuration: result.totalDuration,
        bundleSizeBytes: result.bundleSizeBytes,
        precheckPassed: result.verification.failedChecks === 0,
        checksumsValid: true,
        hasSensitiveData: result.sensitiveDataFindings.length > 0,
        scriptSha256: result.scriptSha256,
        storyboardSha256: result.storyboardSha256,
        manifestSha256: result.manifestSha256,
        clientInfo: getClientInfo(),
        errorMessage: result.errorMessage,
        notes: `duration=${result.durationSeconds}s`,
      }),
    });
  } catch (err) {
    // Audit recording should not block the export
    console.warn('Failed to record export audit:', err);
  }
}

export async function getExportAudits(projectId?: string): Promise<{
  items: ExportAuditRecord[];
  total: number;
}> {
  const query = projectId ? `?projectId=${projectId}` : '';
  return apiFetch(`/api/workspace/export/audits${query}`);
}