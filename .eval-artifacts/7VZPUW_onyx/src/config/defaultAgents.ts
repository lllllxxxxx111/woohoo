import type { AgentContact } from '../types';

/**
 * 默认智能体联系人列表
 *
 * 当工作区尚未从服务端同步到智能体数据时，使用此列表作为兜底。
 * 包含大纲架构师、人设生成专家、分镜渲染师、合规审核官、主编统筹官、项目管理官六个角色。
 */
export const defaultAgents: AgentContact[] = [
  {
    id: 'agent-outline',
    name: '大纲架构师',
    role: '剧情大纲',
    workCount: 156,
    passRate: 0.92,
    badge: '资深',
    systemPrompt:
      '你负责短剧的大纲与结构设计。回答时优先给出剧情钩子、冲突升级、人物目标和集数拆分。',
  },
  {
    id: 'agent-character',
    name: '人设生成专家',
    role: '人物设定',
    workCount: 51,
    passRate: 0.65,
    badge: '设定',
    systemPrompt: '你负责角色设定。回答时优先生成人物标签、关系张力、外形辨识度和人设反差。',
  },
  {
    id: 'agent-storyboard',
    name: '分镜渲染师',
    role: '视觉分镜',
    workCount: 300,
    passRate: 0.88,
    badge: '视觉',
    systemPrompt: '你负责分镜和画面表达。回答时优先给镜头语言、景别、动作节奏和画面调度建议。',
  },
  {
    id: 'agent-review',
    name: '合规审核官',
    role: '风控审核',
    workCount: 999,
    passRate: 0.99,
    badge: '审核',
    systemPrompt: '你负责内容风险审视。回答时优先指出潜在违规点、敏感表达和可替换说法。',
  },
  {
    id: 'agent-chief-editor',
    name: '主编统筹官',
    role: '主编统筹',
    workCount: 88,
    passRate: 0.9,
    badge: '主编',
    systemPrompt: '你负责项目的主编统筹。回答时优先给出结构取舍、节奏优化、内容统一和交付优先级。',
  },
  {
    id: 'agent-project-manager',
    name: '项目管理官',
    role: '项目管理',
    workCount: 73,
    passRate: 0.94,
    badge: '管理',
    systemPrompt: '你负责项目管理。回答时优先给出任务拆解、责任划分、节点风险和推进建议。',
  },
];
