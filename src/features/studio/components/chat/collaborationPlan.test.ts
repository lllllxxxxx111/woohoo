import { describe, expect, it } from 'vitest';
import { buildCollaborationPlan } from './collaborationPlan';
import type { AgentContact } from '../../../../types';

const agents: AgentContact[] = [
  { id: 'outline', name: '大纲架构师', role: '剧情大纲', systemPrompt: '设计结构' },
  { id: 'review', name: '合规审核官', role: '风控审核', systemPrompt: '审核风险' },
  { id: 'editor', name: '主编统筹官', role: '主编统筹', systemPrompt: '负责汇总' },
];

describe('buildCollaborationPlan', () => {
  it('creates parallel specialists, then review, then synthesis', () => {
    const plan = buildCollaborationPlan(agents);
    expect(plan.orchestratorAgentId).toBe('editor');
    expect(plan.assignments.map((item) => item.agentId)).toEqual(['outline', 'review', 'editor']);
    expect(plan.assignments[0].dependsOn).toBeUndefined();
    expect(plan.assignments[1].dependsOn).toEqual(['outline']);
    expect(plan.assignments[2].dependsOn).toEqual(['outline', 'review']);
  });

  it('falls back to the first available agent as orchestrator', () => {
    const plan = buildCollaborationPlan([
      { id: 'a', name: '专家A', role: '分析', systemPrompt: '分析' },
      { id: 'b', name: '专家B', role: '设计', systemPrompt: '设计' },
    ]);
    expect(plan.orchestratorAgentId).toBe('a');
    expect(plan.assignments.at(-1)?.taskType).toBe('synthesis');
  });
});
