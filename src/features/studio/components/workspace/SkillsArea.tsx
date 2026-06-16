import React, { useEffect, useState } from 'react';
import {
  Search,
  Filter,
  Plus,
  Settings,
  Zap,
  Sparkles,
  Wand2,
  Image,
  Music,
  Languages,
  Cpu,
} from 'lucide-react';
import styles from './SkillsArea.module.css';
import { useToast } from '../../../../context/useToast';

type SkillStatus = 'enabled' | 'disabled';

interface Skill {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  status: SkillStatus;
  category: string;
  author: string;
}

const STORAGE_KEY = 'woohoo-skills-state-v1';

/** 默认技能列表 */
const DEFAULT_SKILLS: Omit<Skill, 'icon'>[] = [
  {
    id: '1',
    name: '智能剧本生成',
    description: '根据项目主题自动生成高质量的视频剧本',
    status: 'enabled',
    category: 'AI创作',
    author: '系统技能',
  },
  {
    id: '2',
    name: '图像风格转换',
    description: '将素材图片转换为指定的艺术风格',
    status: 'enabled',
    category: '图像处理',
    author: '系统技能',
  },
  {
    id: '3',
    name: '背景音乐生成',
    description: '为视频自动生成和匹配背景音乐',
    status: 'disabled',
    category: '音频处理',
    author: '系统技能',
  },
  {
    id: '4',
    name: '多语言翻译',
    description: '自动翻译剧本和字幕到多种语言',
    status: 'enabled',
    category: '语言处理',
    author: '社区技能',
  },
  {
    id: '5',
    name: '智能剪辑助手',
    description: 'AI辅助视频剪辑和转场效果优化',
    status: 'disabled',
    category: '视频编辑',
    author: '系统技能',
  },
  {
    id: '6',
    name: '性能优化引擎',
    description: '自动优化渲染性能和输出质量',
    status: 'enabled',
    category: '系统优化',
    author: '系统技能',
  },
];

/** 技能图标映射 */
const SKILL_ICONS: Record<string, React.ReactNode> = {
  '1': <Wand2 size={20} />,
  '2': <Image size={20} />,
  '3': <Music size={20} />,
  '4': <Languages size={20} />,
  '5': <Sparkles size={20} />,
  '6': <Cpu size={20} />,
};

/** 从 localStorage 读取持久化的技能状态 */
function loadPersistedStatus(): Record<string, SkillStatus> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SkillStatus>;
  } catch {
    return {};
  }
}

/** 将技能状态持久化到 localStorage */
function persistStatus(statusMap: Record<string, SkillStatus>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(statusMap));
  } catch {
    // localStorage 不可用时静默失败
  }
}

/** 根据默认列表和持久化状态构建完整技能列表 */
function buildSkillsWithStatus(): Skill[] {
  const persisted = loadPersistedStatus();
  return DEFAULT_SKILLS.map((s) => ({
    ...s,
    icon: SKILL_ICONS[s.id] ?? <Zap size={20} />,
    status: persisted[s.id] ?? s.status,
  }));
}

export const SkillsArea: React.FC = () => {
  const { showToast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [skills, setSkills] = useState<Skill[]>(buildSkillsWithStatus);

  /** 切换技能启用/禁用状态并持久化 */
  const toggleSkillStatus = (skillId: string) => {
    setSkills((prev) => {
      const next = prev.map((skill) => {
        if (skill.id === skillId) {
          return { ...skill, status: (skill.status === 'enabled' ? 'disabled' : 'enabled') as SkillStatus };
        }
        return skill;
      });

      const statusMap: Record<string, SkillStatus> = {};
      next.forEach((s) => {
        statusMap[s.id] = s.status;
      });
      persistStatus(statusMap);

      return next;
    });
  };

  const getStatusClass = (status: SkillStatus) => {
    switch (status) {
      case 'enabled':
        return styles.statusEnabled;
      case 'disabled':
        return styles.statusDisabled;
      default:
        return styles.statusDisabled;
    }
  };

  const getStatusLabel = (status: SkillStatus) => {
    switch (status) {
      case 'enabled':
        return '已启用';
      case 'disabled':
        return '已禁用';
      default:
        return '未知';
    }
  };

  const filteredSkills = skills.filter(
    (skill) =>
      (skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        skill.description.toLowerCase().includes(searchQuery.toLowerCase())) &&
      (categoryFilter === null || skill.category === categoryFilter),
  );

  return (
    <div className={styles.container}>
      <div className={styles.topToolbar}>
        <div className={styles.searchBox}>
          <Search size={16} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className={styles.actions}>
          <div style={{ position: 'relative' }}>
            <button className={styles.toolBtn} onClick={() => setShowFilterMenu(!showFilterMenu)}>
              <Filter size={16} /> 筛选
            </button>
            {showFilterMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, zIndex: 10,
                background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                borderRadius: 6, padding: '4px 0', minWidth: 120, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              }}>
                <button
                  style={{
                    display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
                    background: categoryFilter === null ? 'var(--color-primary-light-1)' : 'transparent',
                    border: 'none', cursor: 'pointer', fontSize: 13,
                  }}
                  onClick={() => { setCategoryFilter(null); setShowFilterMenu(false); }}
                >
                  全部
                </button>
                {[...new Set(DEFAULT_SKILLS.map((s) => s.category))].map((cat) => (
                  <button
                    key={cat}
                    style={{
                      display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
                      background: categoryFilter === cat ? 'var(--color-primary-light-1)' : 'transparent',
                      border: 'none', cursor: 'pointer', fontSize: 13,
                    }}
                    onClick={() => { setCategoryFilter(cat); setShowFilterMenu(false); }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={styles.primaryBtn} onClick={() => showToast({ type: 'info', title: '即将推出', message: '自定义技能添加功能正在开发中。' })}>
            <Plus size={16} /> 添加技能
          </button>
        </div>
      </div>

      {filteredSkills.length === 0 ? (
        <div className={styles.emptyContainer}>
          <div className={styles.emptyIcon}>
            <SkillsEmpty />
          </div>
          <h3>暂无技能</h3>
          <p>添加和管理AI技能，增强您的工作流程。</p>
        </div>
      ) : (
        <div className={styles.skillList}>
          {filteredSkills.map((skill, index) => (
            <div
              key={skill.id}
              className={styles.skillCard}
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className={styles.skillHeader}>
                <div className={styles.skillTitle}>
                  <div className={styles.skillIcon}>{skill.icon}</div>
                  <div className={styles.skillInfo}>
                    <span className={styles.skillName}>{skill.name}</span>
                    <span className={styles.skillCategory}>{skill.category}</span>
                  </div>
                </div>
                <div className={`${styles.skillStatus} ${getStatusClass(skill.status)}`}>
                  <div className={styles.statusDot}></div>
                  <span>{getStatusLabel(skill.status)}</span>
                </div>
              </div>
              <div className={styles.skillBody}>
                <p className={styles.skillDescription}>{skill.description}</p>
                <div className={styles.skillActions}>
                  <span className={styles.skillAuthor}>
                    <Zap size={14} />
                    {skill.author}
                  </span>
                  <div className={styles.actionButtons}>
                    <button
                      className={`${styles.toggleBtn} ${skill.status === 'enabled' ? styles.toggleEnabled : ''}`}
                      onClick={() => toggleSkillStatus(skill.id)}
                      title={skill.status === 'enabled' ? '禁用' : '启用'}
                    >
                      {skill.status === 'enabled' ? '禁用' : '启用'}
                    </button>
                    <button className={styles.actionBtn} title="配置" onClick={() => showToast({ type: 'info', title: '技能配置', message: `${skill.name} 的详细配置正在开发中。` })}>
                      <Settings size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const SkillsEmpty = () => (
  <svg
    width="64"
    height="64"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
    <polygon points="2 17 12 22 22 17"></polygon>
    <line x1="2" y1="12" x2="12" y2="17"></line>
    <line x1="22" y1="12" x2="12" y2="17"></line>
    <line x1="12" y1="22" x2="12" y2="17"></line>
  </svg>
);
