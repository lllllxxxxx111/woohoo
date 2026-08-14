import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_LINES,
  diffScriptText,
  diffStoryboardLines,
  storyboardLinesToViews,
  isSameScriptContent,
  type StoryboardLineView,
} from './contentDiff';

describe('diffScriptText', () => {
  it('报告完全相同的内容为无变化', () => {
    const text = '第一行\n第二行\n第三行';
    const result = diffScriptText(text, text);
    expect(result.kind).toBe('script');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.unchanged).toBe(3);
    expect(result.entries).toHaveLength(0);
    expect(result.summary).toContain('无变化');
  });

  it('处理两个空版本', () => {
    const result = diffScriptText('', '');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.unchanged).toBe(0);
  });

  it('识别新增行', () => {
    const result = diffScriptText('A\nB', 'A\nB\nC');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.unchanged).toBe(2);
    const added = result.entries.filter((entry) => entry.op === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('C');
  });

  it('识别删除行', () => {
    const result = diffScriptText('A\nB\nC', 'A\nC');
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    const removed = result.entries.filter((entry) => entry.op === 'remove');
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe('B');
  });

  it('将紧邻的删除+新增识别为修改', () => {
    const result = diffScriptText('旧的一行', '新的一行');
    expect(result.modified).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    const ops = result.entries.map((entry) => entry.op);
    expect(ops).toContain('modify_from');
    expect(ops).toContain('modify_to');
  });

  it('首次保存（从空到有内容）全部计为新增', () => {
    const result = diffScriptText('', '第一场\n第二场');
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.modified).toBe(0);
  });

  it('超大内容会截断并标记 truncated', () => {
    const makeLines = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join('\n');
    const base = makeLines(MAX_DIFF_LINES + 50, 'base');
    const target = makeLines(MAX_DIFF_LINES + 50, 'target');
    const result = diffScriptText(base, target);
    expect(result.truncated).toBe(true);
    // 条目数有上限保护
    expect(result.entries.length).toBeLessThanOrEqual(400 + 2);
  });
});

describe('diffStoryboardLines', () => {
  const makeLine = (
    id: string,
    sceneNumber: number,
    description: string,
    duration = 3,
    assetIds: string[] = [],
  ): StoryboardLineView => ({ id, sceneNumber, description, duration, assetIds });

  it('报告完全相同的分镜为无变化', () => {
    const lines = [makeLine('l1', 1, '开场'), makeLine('l2', 2, '结尾')];
    const result = diffStoryboardLines(lines, lines);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.unchanged).toBe(2);
  });

  it('处理空分镜之间的差异', () => {
    const result = diffStoryboardLines([], []);
    expect(result.unchanged).toBe(0);
    expect(result.summary).toContain('新增 0');
  });

  it('识别新增镜头', () => {
    const base = [makeLine('l1', 1, '开场')];
    const target = [makeLine('l1', 1, '开场'), makeLine('l2', 2, '新增镜头')];
    const result = diffStoryboardLines(base, target);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].lineId).toBe('l2');
    expect(result.unchanged).toBe(1);
  });

  it('识别删除镜头', () => {
    const base = [makeLine('l1', 1, '开场'), makeLine('l2', 2, '被删')];
    const target = [makeLine('l1', 1, '开场')];
    const result = diffStoryboardLines(base, target);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].lineId).toBe('l2');
  });

  it('识别字段级修改并列出变化字段', () => {
    const base = [makeLine('l1', 1, '旧描述', 3)];
    const target = [makeLine('l1', 1, '新描述', 5)];
    const result = diffStoryboardLines(base, target);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changedFields).toContain('description');
    expect(result.modified[0].changedFields).toContain('duration');
    expect(result.modified[0].changedFields).not.toContain('sceneNumber');
  });

  it('识别资产引用变化', () => {
    const base = [makeLine('l1', 1, '镜头', 3, ['asset-1'])];
    const target = [makeLine('l1', 1, '镜头', 3, ['asset-1', 'asset-2'])];
    const result = diffStoryboardLines(base, target);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].changedFields).toContain('assetIds');
  });
});

describe('storyboardLinesToViews', () => {
  it('把带 assets 的分镜行转为视图（提取 asset id）', () => {
    const views = storyboardLinesToViews([
      {
        id: 'l1',
        sceneNumber: 1,
        description: '开场',
        duration: 2,
        assets: [{ id: 'a1' }, { id: 'a2' }],
      },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].assetIds).toEqual(['a1', 'a2']);
    expect(views[0].sceneNumber).toBe(1);
  });
});

describe('isSameScriptContent', () => {
  it('判断剧本内容是否一致', () => {
    expect(isSameScriptContent('abc', 'abc')).toBe(true);
    expect(isSameScriptContent('abc', 'abd')).toBe(false);
    expect(isSameScriptContent('', '')).toBe(true);
  });
});
