import { describe, expect, it } from 'vitest';
import type { Message, Project, ProjectWorkflowSummary } from '../../../../types';
import { resolveInlineScriptText } from './workspaceMvp';

const workflow: ProjectWorkflowSummary = {
  status: 'draft',
  phase: 'script',
  progressPercent: 0,
  assetCount: 0,
  scriptReady: false,
  storyboardReady: false,
  storyboardLineCount: 0,
  conversationCount: 1,
  messageCount: 1,
  assignedAgentCount: 0,
  queuedTaskCount: 0,
  runningTaskCount: 0,
  completedTaskCount: 0,
  failedTaskCount: 0,
  roleCounts: {
    design: 0,
    review: 0,
    editor: 0,
    manager: 0,
    custom: 0,
  },
};

function makeProject(messages: Message[]): Project {
  return {
    id: 'project-1',
    name: '测试项目',
    status: 'draft',
    phase: 'script',
    chatSessions: [
      {
        id: 'chat-1',
        projectId: 'project-1',
        title: '创意对话',
        messages,
        updatedAt: 1,
      },
    ],
    agentRoster: [],
    workflow,
    assetsCount: 0,
    createdAt: 1,
  };
}

function makeAiMessage(content: string, timestamp = 1): Message {
  return {
    id: `message-${timestamp}`,
    role: 'ai',
    content,
    timestamp,
    status: 'done',
    type: 'text',
  };
}

describe('resolveInlineScriptText', () => {
  it('does not treat process notes as the script chat fallback', () => {
    const processNotes = `
## 优化方案

### 1. 问题复盘
前两次任务失败原因是接口请求异常，属于系统调用层面的中断，并非内容方向错误。当前项目已经具备完整的创意基础：

- 项目方向：温暖科幻短片
- 片名：《遗忘回收站》
- 核心角色：林澈、小满、回收站 AI
- 核心主题：不要因为害怕难过，就把快乐也一起丢掉

### 2. 本轮调整
为降低失败风险，本轮采取收束式输出，只保留最关键的制作信息。

## 执行结果

《遗忘回收站》协同大纲设计稿 v2
`;

    const result = resolveInlineScriptText(makeProject([makeAiMessage(processNotes)]), null, []);

    expect(result.source).toBe('empty');
    expect(result.content).toBe('');
  });

  it('extracts the screenplay block from a mixed execution result', () => {
    const mixedResult = `
## 执行结果

下面先给出任务摘要，后续内容才是可以进入制作流程的正文。

# 完整剧本

## 第1场 外景 回收站 傍晚

林澈：如果我把这段记忆丢掉，是不是就不会难过了？
小满：可你也会忘记那天为什么开心。
回收站AI：检测到高价值情绪片段，建议保留。

## 第2场 内景 值班室 夜

林澈：那就先存在这里，等我有勇气再取回去。
小满：我会陪你一起等。

## 章节拆解建议

- 第一章建立世界观。
`;

    const result = resolveInlineScriptText(makeProject([makeAiMessage(mixedResult)]), null, []);

    expect(result.source).toBe('chat');
    expect(result.content).toContain('# 完整剧本');
    expect(result.content).toContain('## 第2场 内景 值班室 夜');
    expect(result.content).not.toContain('## 执行结果');
    expect(result.content).not.toContain('章节拆解建议');
  });

  it('normalizes a saved script that accidentally includes process notes', () => {
    const savedScript = `
## 优化方案

上一轮输出混入了过程说明。

## 执行结果

# 完整剧本

## 第1场 内景 旧仓库 夜

林澈推开铁门，灯管闪烁。
林澈：这里就是回收站？
小满：也是你最后一次后悔的地方。

## 第2场 外景 天台 清晨

小满把透明盒子交给林澈。
小满：如果想起来会痛，也不代表它不值得被记住。
林澈：那我想把它带回去。

## 制作备注

- 保留两场结构，第一场建立世界观，第二场完成选择。
- 避免把记忆删除表现为现实自伤行为。
`;

    const result = resolveInlineScriptText(
      makeProject([]),
      {
        id: 'script-1',
        projectId: 'project-1',
        title: '测试剧本',
        content: savedScript,
        updatedAt: 1,
      },
      [],
    );

    expect(result.source).toBe('script');
    expect(result.content).toContain('# 完整剧本');
    expect(result.content).toContain('## 第2场 外景 天台 清晨');
    expect(result.content).toContain('## 制作备注');
    expect(result.content).not.toContain('## 优化方案');
    expect(result.content).not.toContain('## 执行结果');
  });

  it('skips a process-only saved script and falls back to the latest valid chat script', () => {
    const processOnlyScript = `
## 优化方案

### 问题复盘
上一轮接口失败，本轮只输出大纲摘要。

## 执行结果

《遗忘回收站》协同大纲设计稿 v2
`;
    const validChatScript = `
# 完整剧本

## 第1场 外景 回收站 傍晚

林澈站在玻璃门前，看到盒子里的光点忽明忽暗。
林澈：我可以只忘掉难过的部分吗？
小满：如果只剪掉痛，快乐也会没有来处。

## 第2场 内景 值班室 夜

回收站AI把暂存单投到桌面。
回收站AI：建议暂存三十天，再由本人确认。
林澈：那就先暂存，不销毁。
`;

    const result = resolveInlineScriptText(
      makeProject([makeAiMessage(validChatScript, 2)]),
      {
        id: 'script-1',
        projectId: 'project-1',
        title: '过程记录',
        content: processOnlyScript,
        updatedAt: 1,
      },
      [],
    );

    expect(result.source).toBe('chat');
    expect(result.content).toContain('# 完整剧本');
    expect(result.content).toContain('## 第2场 内景 值班室 夜');
    expect(result.content).not.toContain('协同大纲设计稿');
  });
});
