/**
 * 内容差异辅助（剧本 / 分镜）
 *
 * 纯函数实现，可在浏览器与 vitest（node 环境）中运行：
 *   - 剧本文本：基于 LCS 的逐行差异，输出新增/删除/修改摘要；
 *   - 分镜结构：按行 id 对齐，输出新增/删除/字段级修改；
 *   - 对超大内容有上限保护，避免一次性渲染无上限 diff。
 */

export type ContentKind = 'script' | 'storyboard';

/** 参与逐行 LCS 对比的最大行数 */
export const MAX_DIFF_LINES = 1200;
/** 返回的最大 diff 条目数 */
export const MAX_DIFF_ENTRIES = 400;
/** 分镜 diff 最大变更条目数 */
export const MAX_STORYBOARD_CHANGES = 200;
/** 单行预览最大字符数 */
export const MAX_LINE_PREVIEW_CHARS = 200;

export interface ScriptDiffEntry {
  op: 'add' | 'remove' | 'modify_from' | 'modify_to' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ScriptDiffResult {
  kind: 'script';
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  truncated: boolean;
  entries: ScriptDiffEntry[];
  summary: string;
}

export interface StoryboardLineView {
  id: string;
  sceneNumber: number;
  description: string;
  duration: number;
  assetIds: string[];
}

export interface StoryboardLineChange {
  lineId: string;
  sceneNumber: number;
  description?: string;
  changedFields: string[];
}

export interface StoryboardDiffResult {
  kind: 'storyboard';
  added: StoryboardLineChange[];
  removed: StoryboardLineChange[];
  modified: StoryboardLineChange[];
  unchanged: number;
  truncated: boolean;
  summary: string;
}

export type ContentDiffResult = ScriptDiffResult | StoryboardDiffResult;

function truncatePreview(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const chars = Array.from(trimmed);
  if (chars.length <= MAX_LINE_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${chars.slice(0, MAX_LINE_PREVIEW_CHARS).join('')}…`;
}

type RawDiffItem =
  | { type: 'keep'; text: string; oldLine: number; newLine: number }
  | { type: 'add'; text: string; newLine: number }
  | { type: 'remove'; text: string; oldLine: number };

/** 经典 LCS 逐行 diff（行号从 1 开始） */
function lcsLineDiff(baseLines: string[], targetLines: string[]): RawDiffItem[] {
  const n = baseLines.length;
  const m = targetLines.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        baseLines[i] === targetLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: RawDiffItem[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseLines[i] === targetLines[j]) {
      result.push({ type: 'keep', text: baseLines[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'remove', text: baseLines[i], oldLine: i + 1 });
      i += 1;
    } else {
      result.push({ type: 'add', text: targetLines[j], newLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: baseLines[i], oldLine: i + 1 });
    i += 1;
  }
  while (j < m) {
    result.push({ type: 'add', text: targetLines[j], newLine: j + 1 });
    j += 1;
  }
  return result;
}

/** 剧本文本差异：新增/删除/修改摘要 + 有界条目列表 */
export function diffScriptText(base: string, target: string): ScriptDiffResult {
  if (base === target) {
    const lineCount = target.length === 0 ? 0 : target.split('\n').length;
    return {
      kind: 'script',
      added: 0,
      removed: 0,
      modified: 0,
      unchanged: lineCount,
      truncated: false,
      entries: [],
      summary: '内容无变化',
    };
  }

  // 行切分同时归一化换行：来自粘贴/AI 输出的 CRLF 与库内 LF 混存时，
  // 若保留 \r，完全相同的行也会被判为“整行修改”，整份 diff 全是噪音。
  const splitLines = (text: string): string[] =>
    text.length === 0 ? [] : text.split(/\r\n|\r|\n/);
  let baseLines = splitLines(base);
  let targetLines = splitLines(target);
  let truncated = false;
  if (baseLines.length > MAX_DIFF_LINES || targetLines.length > MAX_DIFF_LINES) {
    truncated = true;
    baseLines = baseLines.slice(0, MAX_DIFF_LINES);
    targetLines = targetLines.slice(0, MAX_DIFF_LINES);
  }

  const raw = lcsLineDiff(baseLines, targetLines);

  // 将紧邻的 remove+add 配对为 modify，提高可读性
  const removes: Array<{ text: string; oldLine: number }> = [];
  const paired: Array<
    | { type: 'keep'; text: string; oldLine: number; newLine: number }
    | { type: 'add'; text: string; newLine: number }
    | { type: 'remove'; text: string; oldLine: number }
    | { type: 'modify'; fromText: string; toText: string; oldLine: number; newLine: number }
  > = [];

  const flushRemoves = () => {
    while (removes.length > 0) {
      const item = removes.shift();
      if (item) {
        paired.push({ type: 'remove', text: item.text, oldLine: item.oldLine });
      }
    }
  };

  for (const item of raw) {
    if (item.type === 'remove') {
      removes.push({ text: item.text, oldLine: item.oldLine });
    } else if (item.type === 'add') {
      // FIFO 配对（shift 而非 pop）：连续多行修改时按文档顺序配对
      // 第 1 个旧行 ↔ 第 1 个新行；LIFO 会把行序倒过来，输出错乱的 diff。
      const from = removes.shift();
      if (from) {
        paired.push({
          type: 'modify',
          fromText: from.text,
          toText: item.text,
          oldLine: from.oldLine,
          newLine: item.newLine,
        });
      } else {
        paired.push({ type: 'add', text: item.text, newLine: item.newLine });
      }
    } else {
      flushRemoves();
      paired.push(item);
    }
  }
  flushRemoves();

  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;
  const entries: ScriptDiffEntry[] = [];

  for (const item of paired) {
    if (item.type === 'keep') {
      unchanged += 1;
      if (entries.length < MAX_DIFF_ENTRIES) {
        entries.push({
          op: 'context',
          text: truncatePreview(item.text),
          oldLine: item.oldLine,
          newLine: item.newLine,
        });
      }
    } else if (item.type === 'add') {
      added += 1;
      if (entries.length < MAX_DIFF_ENTRIES) {
        entries.push({ op: 'add', text: truncatePreview(item.text), newLine: item.newLine });
      }
    } else if (item.type === 'remove') {
      removed += 1;
      if (entries.length < MAX_DIFF_ENTRIES) {
        entries.push({ op: 'remove', text: truncatePreview(item.text), oldLine: item.oldLine });
      }
    } else {
      modified += 1;
      // modify 会产出两条条目（from/to），预留检查按 +2 计，
      // 否则上限会被超出 1 条。
      if (entries.length + 2 <= MAX_DIFF_ENTRIES) {
        entries.push({ op: 'modify_from', text: truncatePreview(item.fromText), oldLine: item.oldLine });
        entries.push({ op: 'modify_to', text: truncatePreview(item.toText), newLine: item.newLine });
      } else {
        truncated = true;
      }
    }
  }

  if (entries.length >= MAX_DIFF_ENTRIES) {
    truncated = true;
  }

  const summary = `新增 ${added} 行，删除 ${removed} 行，修改 ${modified} 行，未变 ${unchanged} 行${
    truncated ? '（内容过大，仅统计前 1200 行/前 400 条，未显示的部分可能还有差异）' : ''
  }`;

  return {
    kind: 'script',
    added,
    removed,
    modified,
    unchanged,
    truncated,
    entries,
    summary,
  };
}

/** 分镜结构差异：按行 id 对齐，输出新增/删除/字段级修改 */
export function diffStoryboardLines(
  base: StoryboardLineView[],
  target: StoryboardLineView[],
): StoryboardDiffResult {
  const baseById = new Map<string, StoryboardLineView>();
  for (const line of base) {
    if (!baseById.has(line.id)) {
      baseById.set(line.id, line);
    }
  }
  const targetIds = new Set<string>();
  for (const line of target) {
    targetIds.add(line.id);
  }

  const added: StoryboardLineChange[] = [];
  const removed: StoryboardLineChange[] = [];
  const modified: StoryboardLineChange[] = [];
  let unchanged = 0;
  let truncated = false;

  for (const targetLine of target) {
    const baseLine = baseById.get(targetLine.id);
    if (!baseLine) {
      if (added.length < MAX_STORYBOARD_CHANGES) {
        added.push({
          lineId: targetLine.id,
          sceneNumber: targetLine.sceneNumber,
          description: truncatePreview(targetLine.description),
          changedFields: [],
        });
      } else {
        truncated = true;
      }
      continue;
    }

    const changedFields: string[] = [];
    if (baseLine.sceneNumber !== targetLine.sceneNumber) {
      changedFields.push('sceneNumber');
    }
    if (baseLine.description !== targetLine.description) {
      changedFields.push('description');
    }
    if (baseLine.duration !== targetLine.duration) {
      changedFields.push('duration');
    }
    if (JSON.stringify(baseLine.assetIds) !== JSON.stringify(targetLine.assetIds)) {
      changedFields.push('assetIds');
    }

    if (changedFields.length === 0) {
      unchanged += 1;
    } else if (modified.length < MAX_STORYBOARD_CHANGES) {
      modified.push({
        lineId: targetLine.id,
        sceneNumber: targetLine.sceneNumber,
        description: truncatePreview(targetLine.description),
        changedFields,
      });
    } else {
      truncated = true;
    }
  }

  for (const baseLine of base) {
    if (!targetIds.has(baseLine.id)) {
      if (removed.length < MAX_STORYBOARD_CHANGES) {
        removed.push({
          lineId: baseLine.id,
          sceneNumber: baseLine.sceneNumber,
          description: truncatePreview(baseLine.description),
          changedFields: [],
        });
      } else {
        truncated = true;
      }
    }
  }

  return {
    kind: 'storyboard',
    added,
    removed,
    modified,
    unchanged,
    truncated,
    summary: `新增 ${added.length} 个镜头，删除 ${removed.length} 个镜头，修改 ${modified.length} 个镜头，未变 ${unchanged} 个`,
  };
}

/** 判断两段剧本内容是否一致（用于去重展示） */
export function isSameScriptContent(a: string, b: string): boolean {
  return a === b;
}

/** 将分镜行转为差异视图（assetIds 取自 assets） */
export function storyboardLinesToViews(
  lines: Array<{ id: string; sceneNumber: number; description: string; duration: number; assets: Array<{ id: string }> }>,
): StoryboardLineView[] {
  return lines.map((line) => ({
    id: line.id,
    sceneNumber: line.sceneNumber,
    description: line.description,
    duration: line.duration,
    assetIds: line.assets.map((asset) => asset.id),
  }));
}
