import type { AgentContact, DispatchAssignmentReq } from '../../../../types';

export type CollaborationPlan = {
  orchestratorAgentId: string;
  assignments: DispatchAssignmentReq[];
};

function matchesRole(agent: AgentContact, terms: string[]) {
  const haystack = `${agent.name} ${agent.role} ${agent.badge}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/**
 * Build a real collaboration graph:
 * specialists run in parallel, a reviewer waits for them, and the chief editor
 * waits for both the specialists and the review before producing the deliverable.
 */
export function buildCollaborationPlan(agents: AgentContact[]): CollaborationPlan {
  if (agents.length === 0) {
    return { orchestratorAgentId: '', assignments: [] };
  }

  const orchestrator =
    agents.find((agent) => matchesRole(agent, ['主编', 'chief', 'editor'])) ??
    agents.find((agent) => matchesRole(agent, ['项目管理', 'manager', 'project'])) ??
    agents[0];

  const remaining = agents.filter((agent) => agent.id !== orchestrator.id);
  const reviewer = remaining.find((agent) => matchesRole(agent, ['审核', 'review', '合规']));
  const specialists = remaining.filter((agent) => agent.id !== reviewer?.id);
  const specialistIds = specialists.map((agent) => agent.id);
  const assignments: DispatchAssignmentReq[] = specialists.map((agent) => ({
    agentId: agent.id,
    taskType: 'specialist',
    goal:
      `独立完成${agent.role || agent.name}分析，输出结构化、可被下游复用的具体成果。` +
      `重点遵循你的职责：${agent.systemPrompt || agent.role || agent.name}`,
  }));

  if (reviewer) {
    assignments.push({
      agentId: reviewer.id,
      taskType: 'review',
      goal:
        '审阅所有上游专家成果，指出冲突、缺漏和风险，并给出明确的修改建议。' +
        '只输出可执行的审核结论，不要重新从零创作。',
      dependsOn: specialistIds,
    });
  }

  const synthesisDependencies = reviewer ? [...specialistIds, reviewer.id] : specialistIds;
  assignments.push({
    agentId: orchestrator.id,
    taskType: 'synthesis',
    goal:
      '作为主编统筹官，整合上游专家成果和审核意见，做出取舍并输出一份完整、统一、可直接交付的最终成果。' +
      '不要只写总结，要给出后续工作区可以直接使用的正文或结构化内容。',
    dependsOn: synthesisDependencies,
  });

  return { orchestratorAgentId: orchestrator.id, assignments };
}
