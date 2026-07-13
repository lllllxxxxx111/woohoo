import React, { useState, useEffect } from 'react';
import { X, Keyboard, Zap, FileText, Info } from 'lucide-react';
import { useAppStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';

import styles from './HelpModal.module.css';

/**
 * 帮助和快捷键模态框组件
 * 展示 Woohoo Studio 的帮助文档、快捷键说明、快速入门和功能介绍
 * @returns 帮助模态框 JSX 元素
 */
export const HelpModal: React.FC = () => {
  const { isHelpOpen, setHelpOpen } = useAppStore(
    useShallow((state) => ({ isHelpOpen: state.isHelpOpen, setHelpOpen: state.setHelpOpen })),
  );
  const [activeTab, setActiveTab] = useState('shortcuts');

  /**
   * 处理键盘事件监听
   * 支持 ? 键打开/关闭帮助，ESC 键关闭帮助
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setHelpOpen(!isHelpOpen);
      }
      if (e.key === 'Escape' && isHelpOpen) {
        setHelpOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHelpOpen, setHelpOpen]);

  /**
   * 渲染快捷键标签页内容
   * 展示 Woohoo Studio 的所有键盘快捷键
   * @returns 快捷键内容 JSX 元素
   */
  const renderShortcutsContent = () => (
    <div className={styles.shortcutsSection}>
      <p className={styles.desc}>
        使用以下键盘快捷键可以更快地操作 Woohoo Studio。按 <kbd>?</kbd> 可随时打开此帮助窗口。
      </p>

      <div className={styles.shortcutGroup}>
        <h4>通用操作</h4>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>打开帮助</span>
          <div className={styles.keyCombo}>
            <kbd>?</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>打开设置</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>,</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>关闭弹窗</span>
          <div className={styles.keyCombo}>
            <kbd>Esc</kbd>
          </div>
        </div>
      </div>

      <div className={styles.shortcutGroup}>
        <h4>导航</h4>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>切换侧边栏</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>B</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>新建项目</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>N</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>新建对话</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>Shift</kbd>
            <kbd>N</kbd>
          </div>
        </div>
      </div>

      <div className={styles.shortcutGroup}>
        <h4>编辑</h4>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>保存</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>S</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>撤销</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>Z</kbd>
          </div>
        </div>
        <div className={styles.shortcutRow}>
          <span className={styles.shortcutLabel}>重做</span>
          <div className={styles.keyCombo}>
            <kbd>⌘</kbd>
            <kbd>Shift</kbd>
            <kbd>Z</kbd>
          </div>
        </div>
      </div>
    </div>
  );

  /**
   * 渲染快速入门标签页内容
   * 展示 Woohoo Studio 的使用步骤
   * @returns 快速入门内容 JSX 元素
   */
  const renderGettingStartedContent = () => (
    <div className={styles.gettingStarted}>
      <p className={styles.desc}>欢迎使用 Woohoo Studio！以下是帮助您快速上手的步骤。</p>

      <div className={styles.stepCard}>
        <div className={styles.stepNumber}>1</div>
        <div className={styles.stepContent}>
          <h4>创建新项目</h4>
          <p>点击左侧面板的「+ 新建项目」按钮，输入项目名称开始您的创作。</p>
        </div>
      </div>

      <div className={styles.stepCard}>
        <div className={styles.stepNumber}>2</div>
        <div className={styles.stepContent}>
          <h4>开始对话</h4>
          <p>在聊天区域输入您的想法，AI 会帮助您进行剧本创作、角色设计和场景规划。</p>
        </div>
      </div>

      <div className={styles.stepCard}>
        <div className={styles.stepNumber}>3</div>
        <div className={styles.stepContent}>
          <h4>管理资源</h4>
          <p>在资源库中查看和管理您的剧本、分镜和其他资产文件。</p>
        </div>
      </div>

      <div className={styles.stepCard}>
        <div className={styles.stepNumber}>4</div>
        <div className={styles.stepContent}>
          <h4>自定义设置</h4>
          <p>通过设置面板配置主题、模型和其他偏好选项。</p>
        </div>
      </div>
    </div>
  );

  /**
   * 渲染功能说明标签页内容
   * 展示 Woohoo Studio 的核心功能
   * @returns 功能说明内容 JSX 元素
   */
  const renderFeaturesContent = () => (
    <div className={styles.featuresSection}>
      <p className={styles.desc}>了解 Woohoo Studio 的核心功能和特色。</p>

      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>🤖</div>
        <div className={styles.featureContent}>
          <h4>AI 协作创作</h4>
          <p>与多个专业 AI 代理协作，包括大纲架构师、人设生成专家、分镜渲染师等。</p>
        </div>
      </div>

      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>📚</div>
        <div className={styles.featureContent}>
          <h4>资产库管理</h4>
          <p>集中管理您的剧本、分镜、角色设定等所有创作资产。</p>
        </div>
      </div>

      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>🎨</div>
        <div className={styles.featureContent}>
          <h4>双主题支持</h4>
          <p>支持深色和浅色主题，保护您的视力，提升创作体验。</p>
        </div>
      </div>

      <div className={styles.featureCard}>
        <div className={styles.featureIcon}>🛡️</div>
        <div className={styles.featureContent}>
          <h4>内容审核</h4>
          <p>智能风控审核机制确保创作内容的安全性和合规性。</p>
        </div>
      </div>
    </div>
  );

  /**
   * 渲染关于标签页内容
   * 展示 Woohoo Studio 的版本信息
   * @returns 关于内容 JSX 元素
   */
  const renderAboutContent = () => (
    <div className={styles.aboutSection}>
      <div className={styles.logoSection}>
        <div className={styles.whLogo}>
          <span className={styles.whText}>WH</span>
          <div className={styles.whGlow}></div>
        </div>
        <h3>Woohoo Studio</h3>
        <p className={styles.version}>v1.0.0</p>
      </div>

      <div className={styles.aboutContent}>
        <p className={styles.desc}>
          Woohoo Studio 是一款专为创意工作者打造的 AI
          协作创作平台。我们致力于通过人工智能技术，帮助创作者更高效地进行剧本创作、影视制作和创意项目管理。
        </p>

        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>© 2024 Woohoo Studio</span>
          <span className={styles.infoValue}>保留所有权利</span>
        </div>
      </div>
    </div>
  );

  /**
   * 根据当前激活的标签页渲染对应的内容
   * @returns 对应标签页的 JSX 元素
   */
  const renderTabContent = () => {
    switch (activeTab) {
      case 'shortcuts':
        return renderShortcutsContent();
      case 'getting-started':
        return renderGettingStartedContent();
      case 'features':
        return renderFeaturesContent();
      case 'about':
        return renderAboutContent();
      default:
        return renderShortcutsContent();
    }
  };

  if (!isHelpOpen) return null;

  return (
    <div className={styles.overlay} onClick={() => setHelpOpen(false)}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sidebar}>
          <h3>帮助中心</h3>
          <div className={styles.navConfig}>
            <button
              className={`${styles.navBtn} ${activeTab === 'shortcuts' ? styles.active : ''}`}
              onClick={() => setActiveTab('shortcuts')}
            >
              <Keyboard size={16} /> 快捷键
            </button>
            <button
              className={`${styles.navBtn} ${activeTab === 'getting-started' ? styles.active : ''}`}
              onClick={() => setActiveTab('getting-started')}
            >
              <Zap size={16} /> 快速入门
            </button>
            <button
              className={`${styles.navBtn} ${activeTab === 'features' ? styles.active : ''}`}
              onClick={() => setActiveTab('features')}
            >
              <FileText size={16} /> 功能说明
            </button>
            <button
              className={`${styles.navBtn} ${activeTab === 'about' ? styles.active : ''}`}
              onClick={() => setActiveTab('about')}
            >
              <Info size={16} /> 关于
            </button>
          </div>
        </div>

        <div className={styles.content}>
          <div className={styles.header}>
            <h2>
              {activeTab === 'shortcuts' && '键盘快捷键'}
              {activeTab === 'getting-started' && '快速入门'}
              {activeTab === 'features' && '功能说明'}
              {activeTab === 'about' && '关于 Woohoo Studio'}
            </h2>
            <button className={styles.closeBtn} onClick={() => setHelpOpen(false)}>
              <X size={20} />
            </button>
          </div>

          <div className={styles.scrollArea}>{renderTabContent()}</div>

          <div className={styles.footer}>
            <button className={styles.primaryBtn} onClick={() => setHelpOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
