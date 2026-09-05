import React from 'react';
import { Film, Image, Workflow } from 'lucide-react';
import styles from './SkillsArea.module.css';

/**
 * 技能系统占位视图。
 *
 * 此前这里展示的是一个写死的"技能列表"，添加/配置/启停按钮全部只弹
 * "正在开发中" toast、开关也只写 localStorage 且无任何消费方——对用户
 * 是一组假功能。技能后端尚未立项，先以诚实的规划中占位替代，
 * 并把真实存在的对应能力指路到既有入口。
 */
export const SkillsArea: React.FC = () => {
  return (
    <div className={styles.container}>
      <div className={styles.emptyContainer}>
        <div className={styles.emptyIcon}>
          <SkillsEmpty />
        </div>
        <h3>技能系统规划中</h3>
        <p>
          可管理的技能（安装、启用/禁用、配置）尚未接入后端，上线前不提供任何开关，
          以免产生无效操作。下面是当前版本已经可用的相关能力入口：
        </p>
        <div className={styles.capabilityList}>
          <div className={styles.capabilityItem}>
            <Workflow size={16} />
            <span>剧本 / 分镜 / 多智能体编排 —— 「制作流程」标签页</span>
          </div>
          <div className={styles.capabilityItem}>
            <Image size={16} />
            <span>图片生成 —— 「图片生成」标签页</span>
          </div>
          <div className={styles.capabilityItem}>
            <Film size={16} />
            <span>视频镜头生成 —— 「制作流程」的 VideoView</span>
          </div>
        </div>
      </div>
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
