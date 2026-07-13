/**
 * storyOutlineUtils - 故事大纲辅助函数
 *
 * 包含故事大纲草稿的标准化、JSON 提取和 AI 内容解析等工具函数。
 */
import type { StoryOutlineSupplementDraft } from '../ChatMessageGroupItem';

/** 故事大纲空草稿常量 */
export const STORY_OUTLINE_EMPTY_DRAFT: StoryOutlineSupplementDraft = {
  genre: '', protagonist: '', conflict: '', usage: '', ending: '', extraNotes: '',
};

/** 标准化故事大纲草稿，确保所有字段为字符串 */
export function normalizeStoryOutlineDraft(draft?: Partial<StoryOutlineSupplementDraft> | null): StoryOutlineSupplementDraft {
  return {
    genre: (draft?.genre || '').trim(),
    protagonist: (draft?.protagonist || '').trim(),
    conflict: (draft?.conflict || '').trim(),
    usage: (draft?.usage || '').trim(),
    ending: (draft?.ending || '').trim(),
    extraNotes: (draft?.extraNotes || '').trim(),
  };
}

/** 从 AI 内容中提取 JSON 对象 */
export function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

/** 从 AI 回复内容中解析故事大纲草稿 */
export function parseStoryOutlineDraftFromAiContent(content: string) {
  const candidate = extractJsonObject(content);
  const parsed = JSON.parse(candidate) as Partial<StoryOutlineSupplementDraft>;
  return normalizeStoryOutlineDraft({ ...STORY_OUTLINE_EMPTY_DRAFT, ...parsed });
}
