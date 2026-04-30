import React, { useState } from 'react';
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

export const SkillsArea: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');

  const [skills, setSkills] = useState<Skill[]>([
    {
      id: '1',
      name: '智能剧本生成',
      description: '根据项目主题自动生成高质量的视频剧本',
      icon: <Wand2 size={20} />,
      status: 'enabled',
      category: 'AI创作',
      author: '系统技能',
    },
    {
      id: '2',
      name: '图像风格转换',
      description: '将素材图片转换为指定的艺术风格',
      icon: <Image size={20} />,
      status: 'enabled',
      category: '图像处理',
      author: '系统技能',
    },
    {
      id: '3',
      name: '背景音乐生成',
      description: '为视频自动生成和匹配背景音乐',
      icon: <Music size={20} />,
      status: 'disabled',
      category: '音频处理',
      author: '系统技能',
    },
    {
      id: '4',
      name: '多语言翻译',
      description: '自动翻译剧本和字幕到多种语言',
      icon: <Languages size={20} />,
      status: 'enabled',
      category: '语言处理',
      author: '社区技能',
    },
    {
      id: '5',
      name: '智能剪辑助手',
      description: 'AI辅助视频剪辑和转场效果优化',
      icon: <Sparkles size={20} />,
      status: 'disabled',
      category: '视频编辑',
      author: '系统技能',
    },
    {
      id: '6',
      name: '性能优化引擎',
      description: '自动优化渲染性能和输出质量',
      icon: <Cpu size={20} />,
      status: 'enabled',
      category: '系统优化',
      author: '系统技能',
    },
  ]);

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

  const toggleSkillStatus = (skillId: string) => {
    setSkills(
      skills.map((skill) => {
        if (skill.id === skillId) {
          return { ...skill, status: skill.status === 'enabled' ? 'disabled' : 'enabled' };
        }
        return skill;
      }),
    );
  };

  const filteredSkills = skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase()),
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
          <button className={styles.toolBtn}>
            <Filter size={16} /> 筛选
          </button>
          <button className={styles.primaryBtn}>
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
                    <button className={styles.actionBtn} title="配置">
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
