// Workspace MVP — re-exports the MVP workspace functions
// These are the core domain helpers for scripts, storyboards, keyframes, video plans.

export function countScriptLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

export function estimateReadingTimeMinutes(content: string): number {
  if (!content) return 0;
  const words = content.split(/\s+/).filter(Boolean).length;
  return Math.round((words / 200) * 10) / 10; // ~200 wpm
}

export function getStoryboardSceneCount(storyboard: { scenes?: unknown[] }): number {
  return storyboard.scenes?.length ?? 0;
}

export function getTotalKeyframeCount(storyboards: Array<{ scenes?: Array<{ keyframeIds?: string[] }> }>): number {
  return storyboards.reduce(
    (total, sb) => total + (sb.scenes?.reduce((n, sc) => n + (sc.keyframeIds?.length ?? 0), 0) ?? 0),
    0,
  );
}

export function createEmptyScript(projectId: string, sessionId?: string) {
  return {
    id: crypto.randomUUID(),
    projectId,
    sessionId,
    title: 'Untitled Script',
    content: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createEmptyStoryboard(projectId: string, sessionId?: string) {
  return {
    id: crypto.randomUUID(),
    projectId,
    sessionId,
    title: 'Untitled Storyboard',
    scenes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createEmptyVideoPlan(projectId: string, sessionId?: string) {
  return {
    id: crypto.randomUUID(),
    projectId,
    sessionId,
    config: {
      resolution: '1920x1080',
      fps: 24,
      duration: 60,
    },
    createdAt: new Date().toISOString(),
  };
}
