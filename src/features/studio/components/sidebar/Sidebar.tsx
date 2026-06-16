import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderPlus,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  MessageSquarePlus,
  Trash2,
  Database,
  Bot,
  Zap,
  Image,
  Video,
  Music,
  File,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  X,
  MoreHorizontal,
  Edit3,
} from 'lucide-react';
import { useAppStore } from '../../../../store';
import { useShallow } from 'zustand/react/shallow';

import { useAppActions } from '../../../../context/useAppActions';
import { useToast } from '../../../../context/useToast';
import type { Asset } from '../../../../types';
import { useAssetPreviewUrl } from '../../../../hooks/useAssetPreviewUrl';
import {
  ASSET_TYPE_LABELS,
  type AssetLibraryFilterType,
} from '../../../../lib/assetLibraryView';
import styles from './Sidebar.module.css';
import { SettingsMenu } from './SettingsMenu';

const ASSET_CATEGORY_OPTIONS: Array<{ type: AssetLibraryFilterType; icon: React.ReactNode }> = [
  { type: 'all', icon: <Database size={13} /> },
  { type: 'image', icon: <Image size={13} /> },
  { type: 'video', icon: <Video size={13} /> },
  { type: 'audio', icon: <Music size={13} /> },
  { type: 'document', icon: <File size={13} /> },
];

const SidebarAssetThumb: React.FC<{ asset: Asset }> = ({ asset }) => {
  const { previewUrl, status } = useAssetPreviewUrl(asset);

  if (asset.type === 'image' && status === 'ready' && previewUrl) {
    return <img src={previewUrl} alt={asset.name} loading="lazy" />;
  }

  if (asset.type === 'video') {
    return <Video size={16} />;
  }
  if (asset.type === 'audio') {
    return <Music size={16} />;
  }
  if (asset.type === 'document') {
    return <File size={16} />;
  }
  return <Image size={16} />;
};

export const Sidebar: React.FC = () => {
  const {
    projects,
    assets,
    activeState,
    isSidebarCollapsed,
    setSidebarCollapsed,
    setActiveProject,
    setActiveChat,
    switchTab,
    setAssetLibraryView,
  } = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      assets: state.assets,
      activeState: state.activeState,
      isSidebarCollapsed: state.isSidebarCollapsed,
      setSidebarCollapsed: state.setSidebarCollapsed,
      setActiveProject: state.setActiveProject,
      setActiveChat: state.setActiveChat,
      switchTab: state.switchTab,
      setAssetLibraryView: state.setAssetLibraryView,
    })),
  );
  const {
    createChatInProject,
    deleteChatInProject,
    createProject,
    updateProject,
    deleteProject,
    suggestProjectName,
  } = useAppActions();
  const { showToast } = useToast();

  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [expandedAssetProjects, setExpandedAssetProjects] = useState<Record<string, boolean>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<{
    projectId: string;
    chatId: string;
    chatTitle: string;
  } | null>(null);

  // 项目菜单状态
  const [activeProjectMenu, setActiveProjectMenu] = useState<string | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [pendingDeleteProject, setPendingDeleteProject] = useState<{
    projectId: string;
    projectName: string;
  } | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭项目菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setActiveProjectMenu(null);
      }
    };

    if (activeProjectMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeProjectMenu]);

  const normalizedFilter = projectFilter.trim().toLowerCase();
  const filteredProjects = useMemo(() => {
    if (!normalizedFilter) {
      return projects.map((project) => ({
        project,
        visibleChats: project.chatSessions,
      }));
    }

    return projects
      .map((project) => {
        const projectMatched = project.name.toLowerCase().includes(normalizedFilter);
        const matchedChats = project.chatSessions.filter((chat) =>
          chat.title.toLowerCase().includes(normalizedFilter),
        );

        if (!projectMatched && matchedChats.length === 0) {
          return null;
        }

        return {
          project,
          visibleChats: projectMatched ? project.chatSessions : matchedChats,
        };
      })
      .filter(
        (
          item,
        ): item is {
          project: (typeof projects)[number];
          visibleChats: (typeof projects)[number]['chatSessions'];
        } => Boolean(item),
      );
  }, [projects, normalizedFilter]);

  const projectAssetsById = useMemo(() => {
    const nextMap = new Map<string, Asset[]>();
    for (const asset of assets) {
      const projectAssets = nextMap.get(asset.projectId) ?? [];
      projectAssets.push(asset);
      nextMap.set(asset.projectId, projectAssets);
    }

    for (const projectAssets of nextMap.values()) {
      projectAssets.sort((left, right) => right.createdAt - left.createdAt);
    }

    return nextMap;
  }, [assets]);

  const toggleProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const openProjectAssets = (projectId: string, filterType: AssetLibraryFilterType) => {
    setActiveProject(projectId);
    switchTab('assets');
    setAssetLibraryView({
      projectId,
      scope: 'current',
      filterType,
      groupMode: filterType === 'all' ? 'type' : 'none',
    });
  };

  const toggleProjectAssets = (projectId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setExpandedProjects((prev) => ({ ...prev, [projectId]: true }));
    setExpandedAssetProjects((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
    openProjectAssets(projectId, 'all');
  };

  const openProjectAssetCategory = (
    projectId: string,
    filterType: AssetLibraryFilterType,
    event: React.MouseEvent,
  ) => {
    event.stopPropagation();
    openProjectAssets(projectId, filterType);
  };

  /**
   * 打开创建项目弹窗
   */
  /**
   * 打开创建项目弹窗
   */
  const openCreateModal = () => {
    setNewProjectName(suggestProjectName());
    setShowCreateModal(true);
  };

  /**
   * 确认创建项目
   */
  const confirmCreateProject = async () => {
    const name = newProjectName.trim() || '新项目';
    setShowCreateModal(false);
    try {
      const project = await createProject(name);
      setActiveProject(project.id);
    } catch (error) {
      showToast({
        type: 'error',
        title: '创建项目失败',
        message: error instanceof Error ? error.message : '无法创建项目',
      });
    }
  };

  const handleNewChat = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    createChatInProject(projectId);
    setExpandedProjects((prev) => ({ ...prev, [projectId]: true })); // Ensure folder is open
  };

  const requestDeleteChat = (
    projectId: string,
    chatId: string,
    chatTitle: string,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (deletingChatId) {
      return;
    }
    setPendingDeleteChat({ projectId, chatId, chatTitle });
  };

  const confirmDeleteChat = async () => {
    if (!pendingDeleteChat || deletingChatId) {
      return;
    }

    try {
      setDeletingChatId(pendingDeleteChat.chatId);
      await deleteChatInProject(pendingDeleteChat.projectId, pendingDeleteChat.chatId);
    } catch (error) {
      showToast({
        type: 'error',
        title: '删除对话失败',
        message: error instanceof Error ? error.message : '无法删除该对话',
      });
    } finally {
      setDeletingChatId(null);
      setPendingDeleteChat(null);
    }
  };

  // 项目菜单处理函数
  const handleProjectMenuClick = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveProjectMenu(activeProjectMenu === projectId ? null : projectId);
  };

  const handleRenameProject = (projectId: string, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveProjectMenu(null);
    setRenameProjectId(projectId);
    setRenameProjectName(currentName);
    setShowRenameModal(true);
  };

  const confirmRenameProject = async () => {
    if (!renameProjectId || !renameProjectName.trim()) {
      setShowRenameModal(false);
      return;
    }

    try {
      await updateProject(renameProjectId, renameProjectName.trim());
      showToast({
        type: 'success',
        title: '修改成功',
        message: '项目名称已更新',
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '修改失败',
        message: error instanceof Error ? error.message : '无法修改项目名称',
      });
    } finally {
      setShowRenameModal(false);
      setRenameProjectId(null);
      setRenameProjectName('');
    }
  };

  const handleDeleteProject = (projectId: string, projectName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveProjectMenu(null);
    setPendingDeleteProject({ projectId, projectName });
  };

  const confirmDeleteProject = async () => {
    if (!pendingDeleteProject) {
      return;
    }

    try {
      await deleteProject(pendingDeleteProject.projectId);
      showToast({
        type: 'success',
        title: '删除成功',
        message: `项目 "${pendingDeleteProject.projectName}" 已删除`,
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: '删除失败',
        message: error instanceof Error ? error.message : '无法删除该项目',
      });
    } finally {
      setPendingDeleteProject(null);
    }
  };

  if (isSidebarCollapsed) {
    return (
      <div className={`${styles.sidebar} ${styles.collapsed}`}>
        <div className={styles.header}>
          <button onClick={() => setSidebarCollapsed(false)} className={styles.iconBtn}>
            <PanelLeftOpen size={20} />
          </button>
        </div>
        <SettingsMenu />
      </div>
    );
  }

  return (
    <>
      <div
        className={`${styles.mobileOverlay} ${!isSidebarCollapsed ? styles.mobileOverlayActive : ''}`}
        onClick={() => setSidebarCollapsed(true)}
      />
      <div className={styles.sidebar}>
        <div className={styles.header}>
          <h2>Studio</h2>
          <button onClick={() => setSidebarCollapsed(true)} className={styles.iconBtn}>
            <PanelLeftClose size={20} />
          </button>
        </div>

        <div className={styles.topMenu}>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'chat' ? styles.activeTab : ''}`}
            onClick={() => switchTab('chat')}
          >
            <MessageSquare size={18} />
            <span>创意对话</span>
          </div>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'pipeline' ? styles.activeTab : ''}`}
            onClick={() => switchTab('pipeline')}
          >
            <LayoutDashboard size={18} />
            <span>制作流程</span>
          </div>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'assets' ? styles.activeTab : ''}`}
            onClick={() => switchTab('assets')}
          >
            <Database size={18} />
            <span>资产库</span>
          </div>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'imageGeneration' ? styles.activeTab : ''}`}
            onClick={() => switchTab('imageGeneration')}
          >
            <Image size={18} />
            <span>图片生成</span>
          </div>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'automation' ? styles.activeTab : ''}`}
            onClick={() => switchTab('automation')}
          >
            <Zap size={18} />
            <span>自动化</span>
          </div>
          <div
            className={`${styles.menuItem} ${activeState.currentTab === 'skills' ? styles.activeTab : ''}`}
            onClick={() => switchTab('skills')}
          >
            <Bot size={18} />
            <span>技能</span>
          </div>
        </div>

        <div className={styles.projectListContainer}>
          <div className={styles.projectListHeader}>
            <span>项目列表</span>
            <button onClick={openCreateModal} className={styles.iconBtn} title="新建项目">
              <FolderPlus size={16} />
            </button>
          </div>

          <div className={styles.projectFilterWrap}>
            <input
              className={styles.projectFilterInput}
              type="text"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              placeholder="筛选项目 / 对话"
            />
          </div>

          <div className={styles.projectList}>
            {filteredProjects.map(({ project, visibleChats }) => {
              const isExpanded = normalizedFilter ? true : Boolean(expandedProjects[project.id]);
              const isAssetExpanded = Boolean(expandedAssetProjects[project.id]);
              const projectAssets = projectAssetsById.get(project.id) ?? [];
              const getAssetCategoryCount = (type: AssetLibraryFilterType) =>
                type === 'all'
                  ? projectAssets.length
                  : projectAssets.filter((asset) => asset.type === type).length;
              return (
                <div key={project.id} className={styles.projectGroup}>
                  <div
                    className={`${styles.projectHeader} ${activeState.projectId === project.id ? styles.active : ''}`}
                    onClick={() => setActiveProject(project.id)}
                  >
                    <div
                      className={styles.projectTitle}
                      onClick={(e) => toggleProject(project.id, e)}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <FolderOpen size={16} className={styles.folderIcon} />
                      <span className={styles.truncate}>{project.name}</span>
                    </div>

                    <button
                      onClick={(e) => handleNewChat(project.id, e)}
                      className={styles.iconBtnSmall}
                      title="新建对话"
                    >
                      <MessageSquarePlus size={14} />
                    </button>

                    <div className={styles.projectMenuContainer} ref={projectMenuRef}>
                      <button
                        onClick={(e) => handleProjectMenuClick(project.id, e)}
                        className={styles.iconBtnSmall}
                        title="更多操作"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {activeProjectMenu === project.id && (
                        <div className={styles.projectMenuDropdown}>
                          <button
                            className={styles.projectMenuItem}
                            onClick={(e) => handleRenameProject(project.id, project.name, e)}
                          >
                            <Edit3 size={14} />
                            <span>修改名称</span>
                          </button>
                          <button
                            className={styles.projectMenuItem}
                            onClick={(e) => handleDeleteProject(project.id, project.name, e)}
                          >
                            <Trash2 size={14} />
                            <span>删除项目</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className={styles.projectContent}>
                      <button
                        type="button"
                        className={styles.assetLibraryToggle}
                        onClick={(event) => toggleProjectAssets(project.id, event)}
                        title="打开项目资产库"
                      >
                        {isAssetExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <Database size={14} />
                        <span className={styles.truncate}>项目资产库</span>
                        <span>{projectAssets.length || project.assetsCount}</span>
                      </button>
                      {isAssetExpanded && (
                        <div className={styles.assetCategoryList}>
                          {ASSET_CATEGORY_OPTIONS.map((category) => {
                            const categoryAssets =
                              category.type === 'all'
                                ? projectAssets
                                : projectAssets.filter((asset) => asset.type === category.type);
                            const count = getAssetCategoryCount(category.type);
                            return (
                              <button
                                key={category.type}
                                type="button"
                                className={styles.assetCategoryItem}
                                onClick={(event) =>
                                  openProjectAssetCategory(project.id, category.type, event)
                                }
                                disabled={count === 0}
                              >
                                {category.icon}
                                <span>{ASSET_TYPE_LABELS[category.type]}</span>
                                <strong>{count}</strong>
                                <div className={styles.assetCategoryPreview}>
                                  <span>{ASSET_TYPE_LABELS[category.type]}资产预览</span>
                                  {categoryAssets.length > 0 ? (
                                    <div className={styles.assetThumbGrid}>
                                      {categoryAssets.slice(0, 4).map((asset) => (
                                        <div key={asset.id} className={styles.assetThumb}>
                                          <SidebarAssetThumb asset={asset} />
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p>暂无资产</p>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className={styles.chatList}>
                        {visibleChats.map((chat) => (
                          <div
                            key={chat.id}
                            className={`${styles.chatItem} ${activeState.chatSessionId === chat.id ? styles.activeChat : ''}`}
                            onClick={() => setActiveChat(project.id, chat.id)}
                          >
                            <span className={`${styles.truncate} ${styles.chatTitle}`}>
                              {chat.title}
                            </span>
                            <button
                              className={styles.chatDeleteBtn}
                              title="删除对话"
                              onClick={(e) => requestDeleteChat(project.id, chat.id, chat.title, e)}
                              disabled={deletingChatId === chat.id}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {projects.length === 0 && (
              <div className={styles.emptyProjects}>暂无项目，可在对话区创建。</div>
            )}
            {projects.length > 0 && filteredProjects.length === 0 && (
              <div className={styles.emptyProjects}>未找到匹配的项目或对话。</div>
            )}
          </div>
        </div>
        <SettingsMenu />

        {showCreateModal && (
          <div className={styles.modalOverlay} onClick={() => setShowCreateModal(false)}>
            <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3>新建项目</h3>
                <button className={styles.iconBtn} onClick={() => setShowCreateModal(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <label className={styles.modalLabel}>项目名称</label>
                <input
                  className={styles.modalInput}
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="请输入项目名称..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmCreateProject();
                  }}
                  autoFocus
                />
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.modalBtnCancel} onClick={() => setShowCreateModal(false)}>
                  取消
                </button>
                <button
                  className={styles.modalBtnConfirm}
                  onClick={() => void confirmCreateProject()}
                  disabled={!newProjectName.trim()}
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDeleteChat && (
          <div className={styles.modalOverlay} onClick={() => setPendingDeleteChat(null)}>
            <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3>删除对话</h3>
                <button
                  className={styles.iconBtn}
                  onClick={() => setPendingDeleteChat(null)}
                  disabled={Boolean(deletingChatId)}
                >
                  <X size={18} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <label className={styles.modalLabel}>
                  确认删除「{pendingDeleteChat.chatTitle || '未命名对话'}」吗？删除后不可恢复。
                </label>
              </div>
              <div className={styles.modalFooter}>
                <button
                  className={styles.modalBtnCancel}
                  onClick={() => setPendingDeleteChat(null)}
                  disabled={Boolean(deletingChatId)}
                >
                  取消
                </button>
                <button
                  className={styles.modalBtnConfirm}
                  onClick={() => void confirmDeleteChat()}
                  disabled={Boolean(deletingChatId)}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 重命名项目弹窗 */}
        {showRenameModal && (
          <div className={styles.modalOverlay} onClick={() => setShowRenameModal(false)}>
            <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3>修改项目名称</h3>
                <button className={styles.iconBtn} onClick={() => setShowRenameModal(false)}>
                  <X size={18} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <label className={styles.modalLabel}>新名称</label>
                <input
                  className={styles.modalInput}
                  type="text"
                  value={renameProjectName}
                  onChange={(e) => setRenameProjectName(e.target.value)}
                  placeholder="请输入新项目名称..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmRenameProject();
                  }}
                  autoFocus
                />
              </div>
              <div className={styles.modalFooter}>
                <button className={styles.modalBtnCancel} onClick={() => setShowRenameModal(false)}>
                  取消
                </button>
                <button
                  className={styles.modalBtnConfirm}
                  onClick={() => void confirmRenameProject()}
                  disabled={!renameProjectName.trim()}
                >
                  确认
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除项目确认弹窗 */}
        {pendingDeleteProject && (
          <div className={styles.modalOverlay} onClick={() => setPendingDeleteProject(null)}>
            <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHeader}>
                <h3>删除项目</h3>
                <button
                  className={styles.iconBtn}
                  onClick={() => setPendingDeleteProject(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <div className={styles.modalBody}>
                <label className={styles.modalLabel}>
                  确认删除项目「{pendingDeleteProject.projectName}」吗？<br />
                  该项目下的所有对话、资产、脚本和分镜都将被删除，此操作不可恢复。
                </label>
              </div>
              <div className={styles.modalFooter}>
                <button
                  className={styles.modalBtnCancel}
                  onClick={() => setPendingDeleteProject(null)}
                >
                  取消
                </button>
                <button
                  className={styles.modalBtnConfirm}
                  onClick={() => void confirmDeleteProject()}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
