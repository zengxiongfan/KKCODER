import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmModal } from "./ConfirmModal";
import {
  formatRelativeSessionActivityTime,
  sortSessionsByActivityDesc,
  getSessionActivityTimestamp,
} from "../utils/sessionActivity";

export const ClaudeIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ color, display: "inline-block", verticalAlign: "middle" }}>
    <title>Claude</title>
    <path 
      d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" 
      fill="currentColor" 
      fillRule="nonzero"
    />
  </svg>
);

export const CodexIcon: React.FC<{ size?: number; color?: string }> = ({ size = 18, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" style={{ color, display: "inline-block", verticalAlign: "middle", flex: "0 0 auto", lineHeight: 1 }}>
    <title>Codex</title>
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </svg>
);

// Agent 类型。"pi" 是遗留值（旧数据库中可能仍存在），运行时会被映射到 "codex"。
export type AgentType = "claude" | "codex" | "pi";

export interface Session {
  id: string;
  name: string;
  project: string;
  path: string;
  type: AgentType;
  agentSessionId: string;
  createdAt?: string; // 保存数据库创建时间戳
  lastUserMessageAt?: string;
  favorite: number;   // 0 代表普通，1 代表已收藏
  deleted?: number;   // 0 代表活动，1 代表回收站
  deletedAt?: string; // 保存软删除时间戳
  isTemp?: boolean;
  matchSnippets?: string[]; // 搜索高亮的聊天记录匹配片段 (最多 3 条)
}

export interface ArchivedProject {
  id: number;
  project_name: string;
  project_path: string;
  archived_at: string;
  archive_month: string;
  sessions_data: string; // JSON string of sessions
}

interface SidebarProps {
  selectedAgent: "claude" | "codex";
  onSelectAgent: (agent: "claude" | "codex") => void; // 只接受合法值；旧 "pi" 在调用方已被 clamp
  onOpenNewSession: (prefilledPath?: string) => void;
  onCreateSessionDirectly?: (projectPath: string) => void;
  onOpenTempSession: () => void;
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onDeleteSession: (e: React.MouseEvent | null, id: string) => void;
  openTabIds: string[]; // 用于判断该终端是否“加载到了右边”并点亮绿灯
  onRenameSession?: (id: string, newName: string) => void;
  onToggleFavorite?: (id: string, isFavorite: boolean) => void;
  highlightSessionId?: string | null;
  onHighlightEnd?: () => void;
  onDeleteSessionsBatch: (ids: string[]) => void; // 批量删除会话 callback
  glowingSessionIds?: string[];
  onRestoreSession: (id: string) => void;
  onPermanentlyDeleteSession: (id: string) => void;
  onEmptyTrash: () => void;
  width?: number;
  sessionBusy?: Record<string, boolean>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  selectedAgent,
  onSelectAgent,
  onOpenNewSession,
  onCreateSessionDirectly,
  onOpenTempSession,
  sessions,
  activeSessionId,
  onSelectSession,
  searchQuery,
  onSearchQueryChange,
  onDeleteSession,
  openTabIds,
  onRenameSession,
  onToggleFavorite,
  highlightSessionId,
  onHighlightEnd,
  onDeleteSessionsBatch,
  glowingSessionIds = [],
  onRestoreSession,
  onPermanentlyDeleteSession,
  onEmptyTrash,
  width,
  sessionBusy,
}) => {
  // 1. 折叠项目列表的状态
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  // 展开更多会话的状态（默认只显示前5条）
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  // 收藏区展开更多会话
  const [favoritesExpanded, setFavoritesExpanded] = useState<boolean>(false);
  // 回收站与确认删除 Modal 状态
  const [showTrashModal, setShowTrashModal] = useState<boolean>(false);
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  // 收藏夹折叠状态
  const [favoritesCollapsed, setFavoritesCollapsed] = useState<boolean>(false);
  const [confirmState, setConfirmState] = useState<{
    show: boolean;
    title: string;
    message: string | React.ReactNode;
    onConfirm: () => void;
    isDanger?: boolean;
  } | null>(null);

  // 记住收藏的项目状态
  const [favoriteProjects, setFavoriteProjects] = useState<Array<{ name: string; timestamp: number }>>(() => {
    try {
      const stored = localStorage.getItem("kkcoder_favorite_projects");
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("kkcoder_favorite_projects", JSON.stringify(favoriteProjects));
  }, [favoriteProjects]);

  // 记住项目最后访问时间（打开会话时更新），用于项目排序
  const [projectLastAccessed, setProjectLastAccessed] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem("kkcoder_project_last_accessed");
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem("kkcoder_project_last_accessed", JSON.stringify(projectLastAccessed));
  }, [projectLastAccessed]);

  // 归档区状态
  const [showArchive, setShowArchive] = useState<boolean>(false);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProject[]>([]);
  const [archiveContextMenu, setArchiveContextMenu] = useState<{
    x: number;
    y: number;
    project: ArchivedProject;
  } | null>(null);
  const archiveSectionRef = useRef<HTMLDivElement>(null);

  // 点击归档区外部时自动收起归档区
  useEffect(() => {
    if (!showArchive) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (archiveSectionRef.current && !archiveSectionRef.current.contains(e.target as Node)) {
        setShowArchive(false);
      }
    };
    // 延迟添加监听，避免当前点击事件立即触发
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showArchive]);

  // 增加全局内容搜索相关的状态与防抖请求
  const [isContentSearch, setIsContentSearch] = useState<boolean>(false);
  const [contentSearchResults, setContentSearchResults] = useState<Record<string, string[]>>({});
  const [hoveredSession, setHoveredSession] = useState<{
    session: Session;
    top: number;
  } | null>(null);

  useEffect(() => {
    if (!isContentSearch || !searchQuery.trim()) {
      setContentSearchResults({});
      return;
    }

    const delayDebounceFn = setTimeout(() => {
      invoke<Array<{ sessionId: string; snippets: string[] }>>("search_session_contents", {
        query: searchQuery,
      })
        .then((results) => {
          const map: Record<string, string[]> = {};
          if (results) {
            results.forEach((r) => {
              map[r.sessionId] = r.snippets;
            });
          }
          setContentSearchResults(map);
        })
        .catch((err) => {
          console.error("Content search failed:", err);
        });
    }, 250); // 250ms 防抖

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery, isContentSearch]);

  // 加载归档项目列表
  const loadArchivedProjects = async () => {
    try {
      const data = await invoke<ArchivedProject[]>("get_archived_projects");
      setArchivedProjects(data);
    } catch (err) {
      console.error("Failed to load archived projects:", err);
    }
  };

  useEffect(() => {
    loadArchivedProjects();
  }, []);

  // 归档项目
  const handleArchiveProject = async (projectName: string, projectPath: string) => {
    try {
      // 收集该项目下的所有会话数据用于归档保存
      const projectSessions = sessions.filter(s => s.project === projectName);
      const sessionsJson = JSON.stringify(projectSessions);
      await invoke("archive_project", { projectName, projectPath, sessionsJson });
      // 删除该项目下的所有会话
      const sessionIds = projectSessions.map(s => s.id);
      if (sessionIds.length > 0) {
        onDeleteSessionsBatch(sessionIds);
      }
      loadArchivedProjects();
    } catch (err) {
      alert(`归档项目失败: ${err}`);
    }
  };

  // 还原归档项目
  const handleRestoreArchivedProject = async (id: number) => {
    try {
      const sessionsJson: string = await invoke("restore_archived_project", { id });
      // 解析归档时保存的会话数据并重建会话
      const archivedSessions: Session[] = JSON.parse(sessionsJson || "[]");
      for (const session of archivedSessions) {
        await invoke("add_session", { session: { ...session, deleted: 0, deletedAt: null } });
      }
      loadArchivedProjects();
      // 通知父组件重新加载会话列表
      if (archivedSessions.length > 0) {
        window.dispatchEvent(new CustomEvent("archive-sessions-restored"));
      }
    } catch (err) {
      alert(`还原项目失败: ${err}`);
    }
  };

  // 当 highlightSessionId 发生变化时，确保它隶属的项目文件夹处于展开状态
  useEffect(() => {
    if (highlightSessionId) {
      const session = sessions.find((s) => s.id === highlightSessionId);
      if (session) {
        setCollapsedProjects((prev) => prev.filter((p) => p !== session.project));
      }
    }
  }, [highlightSessionId, sessions]);

  // 2. 行内编辑会话名称状态
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // 3. 右键自定义上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: Session;
  } | null>(null);

  // 3b. 项目右键上下文菜单状态
  const [projectContextMenu, setProjectContextMenu] = useState<{
    x: number;
    y: number;
    projectName: string;
    projectPath: string;
    sessionCount: number;
    isFavorited: boolean;
  } | null>(null);

  // 调整右键菜单位置，防止超出视口
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!contextMenu && !projectContextMenu) {
      setMenuPos(null);
      return;
    }
    const el = contextMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (contextMenu?.x ?? projectContextMenu?.x) ?? 0;
    const y = (contextMenu?.y ?? projectContextMenu?.y) ?? 0;
    let top = y;
    let left = x;
    if (top + rect.height > window.innerHeight - 8) {
      top = window.innerHeight - rect.height - 8;
    }
    if (left + rect.width > window.innerWidth - 8) {
      left = window.innerWidth - rect.width - 8;
    }
    if (top !== y || left !== x) {
      setMenuPos({ top, left });
    }
  }, [contextMenu, projectContextMenu]);

  // 3c. 项目删除确认弹窗状态
  const [projectToDelete, setProjectToDelete] = useState<{
    projectName: string;
    sessionIds: string[];
  } | null>(null);

  // 点击外部自动关闭右键菜单（用 mousedown 确保标题栏拖拽前也能触发）
  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    window.addEventListener("mousedown", closeMenu);
    return () => window.removeEventListener("mousedown", closeMenu);
  }, []);

  // 滚动侧边栏时关闭右键菜单
  useEffect(() => {
    const sidebar = document.querySelector(".sidebar-scroll");
    if (!sidebar) return;
    const closeMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    sidebar.addEventListener("scroll", closeMenu);
    return () => sidebar.removeEventListener("scroll", closeMenu);
  }, []);

  // 监听关闭侧边栏右键菜单的事件（由标签页触发）
  useEffect(() => {
    const handleCloseSidebarContextMenu = () => {
      setContextMenu(null);
      setProjectContextMenu(null);
    };
    window.addEventListener("close-sidebar-context-menu", handleCloseSidebarContextMenu);
    return () => window.removeEventListener("close-sidebar-context-menu", handleCloseSidebarContextMenu);
  }, []);

  // 监听 ESC 键关闭移除确认弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProjectToDelete(null);
      }
    };
    if (projectToDelete) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [projectToDelete]);

  // 监听 ESC 键关闭自定义确认弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmState(null);
      }
    };
    if (confirmState) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [confirmState]);

  // 监听 ESC 键关闭回收站垃圾桶弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowTrashModal(false);
      }
    };
    if (showTrashModal) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [showTrashModal]);

  // 当进入编辑状态时，自动获得焦点并选中文本
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  const toggleProject = (projectName: string) => {
    setCollapsedProjects((prev) =>
      prev.includes(projectName)
        ? prev.filter((p) => p !== projectName)
        : [...prev, projectName]
    );
  };

  // 收藏/取消收藏整个项目
  const handleToggleFavoriteProject = (projectName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFavoriteProjects((prev) => {
      const exists = prev.some((p) => p.name === projectName);
      if (exists) {
        return prev.filter((p) => p.name !== projectName);
      } else {
        return [{ name: projectName, timestamp: Date.now() }, ...prev];
      }
    });
  };

  // 触发项目右键菜单
  const handleProjectContextMenu = (
    e: React.MouseEvent,
    projectName: string,
    projectPath: string,
    sessionsList: Session[],
    isFavorited: boolean
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null); // 关闭会话右键菜单
    setProjectContextMenu({
      x: e.clientX,
      y: e.clientY,
      projectName,
      projectPath,
      sessionCount: sessionsList.length,
      isFavorited,
    });
    // 触发事件关闭标签页右键菜单
    window.dispatchEvent(new CustomEvent("close-tab-context-menu"));
  };

  // 在文件管理器中物理打开项目路径
  const handleOpenProjectInExplorer = async (path: string) => {
    try {
      await invoke("open_project_folder", { path });
    } catch (err) {
      alert(`无法打开文件夹: ${err}`);
    }
  };

  // 4. 根据项目名称动态归类会话列表
  const projectsMap: { [key: string]: { path: string; sessions: Session[] } } = {};
  
  const filteredSessions = sessions.filter((s) => s.type === selectedAgent && s.deleted !== 1 && !s.isTemp);

  filteredSessions.forEach((s) => {
    const matchesTitle = searchQuery ? (
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.path.toLowerCase().includes(searchQuery.toLowerCase())
    ) : true;

    const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
    const matchesContent = !!matchedContentSnippets && matchedContentSnippets.length > 0;

    const isMatched = !searchQuery || matchesTitle || matchesContent;

    if (isMatched) {
      if (!projectsMap[s.project]) {
        projectsMap[s.project] = { path: s.path, sessions: [] };
      }
      const sessionWithSnippet = (matchedContentSnippets && matchedContentSnippets.length > 0)
        ? { ...s, matchSnippets: matchedContentSnippets } 
        : s;
      projectsMap[s.project].sessions.push(sessionWithSnippet);
    }
  });

  Object.values(projectsMap).forEach((project) => {
    project.sessions = sortSessionsByActivityDesc(project.sessions);
  });

  // 提取收藏的会话并附加匹配片段
  const favoriteSessions = sortSessionsByActivityDesc(
    filteredSessions
      .filter((s) => s.favorite === 1)
      .filter((s) => {
        const matchesTitle = searchQuery ? (
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.project.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.path.toLowerCase().includes(searchQuery.toLowerCase())
        ) : true;
        const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
        return !searchQuery || matchesTitle || (!!matchedContentSnippets && matchedContentSnippets.length > 0);
      })
      .map((s) => {
        const matchedContentSnippets = isContentSearch ? contentSearchResults[s.id] : undefined;
        return (matchedContentSnippets && matchedContentSnippets.length > 0) 
          ? { ...s, matchSnippets: matchedContentSnippets } 
          : s;
      })
  );

  // 打开会话时，更新该项目的最后访问时间（用于置顶排序）
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session?.project) return;
    setProjectLastAccessed((prev) => {
      if (prev[session.project] && Date.now() - prev[session.project] < 1000) return prev;
      return { ...prev, [session.project]: Date.now() };
    });
  }, [activeSessionId, sessions]);

  // 按最近访问时间 + 最近活跃会话自动排序项目
  const projectNames = Object.keys(projectsMap);
  const sortByAccessAndActivity = (names: string[]) => {
    return [...names].sort((a, b) => {
      const aAccess = projectLastAccessed[a] || 0;
      const bAccess = projectLastAccessed[b] || 0;
      if (aAccess !== bAccess) return bAccess - aAccess;
      // 回退到会话活跃时间
      const aSessions = projectsMap[a]?.sessions || [];
      const bSessions = projectsMap[b]?.sessions || [];
      const aTime = Math.max(0, ...aSessions.map((s) => getSessionActivityTimestamp(s)));
      const bTime = Math.max(0, ...bSessions.map((s) => getSessionActivityTimestamp(s)));
      return bTime - aTime;
    });
  };
  const favProjNames = useMemo(() => {
    const names = favoriteProjects
      .filter((fp) => projectNames.includes(fp.name))
      .map((fp) => fp.name);
    return sortByAccessAndActivity(names);
  }, [favoriteProjects, projectsMap, projectNames, projectLastAccessed]);
  const regularProjNames = projectNames.filter((name) => !favProjNames.includes(name));
  const regularSortedProjNames = useMemo(() => {
    return sortByAccessAndActivity(regularProjNames);
  }, [regularProjNames, projectsMap, projectLastAccessed]);

  const sortedProjectNames = [...favProjNames, ...regularSortedProjNames];

  // 6. 行内编辑操作
  const startEditing = (session: Session) => {
    setEditingSessionId(session.id);
    setEditingText(session.name);
  };

  const handleSaveEdit = (id: string) => {
    if (editingText.trim() && onRenameSession) {
      onRenameSession(id, editingText.trim());
    }
    setEditingSessionId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter") {
      handleSaveEdit(id);
    } else if (e.key === "Escape") {
      setEditingSessionId(null);
    }
  };

  // 7. 处理右键点击
  const handleItemContextMenu = (e: React.MouseEvent, session: Session) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectContextMenu(null); // 关闭项目右键菜单
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      session,
    });
    // 触发事件关闭标签页右键菜单
    window.dispatchEvent(new CustomEvent("close-tab-context-menu"));
  };



  // 8. 统一会话行渲染函数 (复用在置顶收藏组和常规项目树中)
  const renderSessionRow = (session: Session) => {
    const isActive = activeSessionId === session.id;
    const isLoaded = openTabIds.includes(session.id); // 是否加载到了右边
    const isEditing = editingSessionId === session.id;
    const isHighlighted = highlightSessionId === session.id;
    const isGlowing = glowingSessionIds.includes(session.id);
    const isBusy = sessionBusy && sessionBusy[session.id];

    return (
      <li
        key={session.id}
        className={`session-item ${isActive ? "active" : ""} ${isHighlighted ? "highlight-flash" : ""}`}
        onClick={() => onSelectSession(session.id)}
        onDoubleClick={() => startEditing(session)}
        onContextMenu={(e) => handleItemContextMenu(e, session)}
        onAnimationEnd={() => {
          if (isHighlighted && onHighlightEnd) {
            onHighlightEnd();
          }
        }}
        onMouseEnter={(e) => {
          if (isContentSearch && searchQuery && session.matchSnippets && session.matchSnippets.length > 0) {
            const rect = e.currentTarget.getBoundingClientRect();
            setHoveredSession({
              session,
              top: rect.top,
            });
          }
        }}
        onMouseLeave={() => {
          setHoveredSession(null);
        }}
      >
        <div className="session-content">
          {/* 状态指示器：回答完成且非活动时展示黄色点提醒，否则：加载到右侧点亮(亮绿)，休眠状态(淡灰绿) */}
          <span 
            className={`status-indicator-dot ${isBusy ? "busy-pulse" : (isGlowing ? "glowing-yellow" : (isLoaded ? "lit" : "faded"))}`} 
            title={isBusy ? "正在思考..." : (isGlowing ? "回答完毕" : (isLoaded ? "会话处于活动状态" : "会话处于休眠状态"))}
          />
          
          {/* 橙色收藏小星星 (如果是收藏会话) */}
          {session.favorite === 1 && (
            <span className="favorite-star-badge" title="置顶收藏会话">⭐</span>
          )}

          {isEditing ? (
            <input
              ref={editInputRef}
              type="text"
              className="session-rename-input"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onBlur={() => handleSaveEdit(session.id)}
              onKeyDown={(e) => handleKeyDown(e, session.id)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1, minWidth: 0 }}>
              <span
                className={`session-name-text ${isGlowing ? "glowing-text" : ""}`}
                style={{
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  fontSize: "12.5px"
                }}
                title={session.name}
              >
                {session.name}
              </span>
              {isContentSearch && searchQuery && session.matchSnippets && session.matchSnippets.length > 0 && (
                <span 
                  className="session-match-snippet"
                  style={{
                    fontSize: "10.5px",
                    color: isActive ? "rgba(255,255,255,0.6)" : "var(--text-muted)",
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    marginTop: "2px",
                    fontFamily: "var(--font-mono)",
                    letterSpacing: "-0.2px"
                  }}
                  title={session.matchSnippets[0]}
                >
                  {session.matchSnippets[0]}
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {/* 时间标签 (如 2分钟前) */}
          <span className="session-time-tag">
            {formatRelativeSessionActivityTime(session)}
          </span>
          
          {/* 删除按钮 */}
          <button
            className="session-delete-btn"
            onClick={(e) => onDeleteSession(e, session.id)}
            title="永久删除此会话记录"
          >
            ×
          </button>
        </div>
      </li>
    );
  };

  const isFavoritesExist = favoriteSessions.length > 0;
  const isAllProjectsCollapsed = sortedProjectNames.every((p) => collapsedProjects.includes(p));
  const isFavoritesCollapsed = isFavoritesExist ? favoritesCollapsed : true;
  const allCollapsed = isAllProjectsCollapsed && isFavoritesCollapsed;

  const toggleCollapseAll = () => {
    if (sortedProjectNames.length === 0 && favoriteSessions.length === 0) return;
    
    if (allCollapsed) {
      // 展开全部
      setCollapsedProjects([]);
      if (isFavoritesExist) {
        setFavoritesCollapsed(false);
      }
    } else {
      // 收起全部
      setCollapsedProjects(sortedProjectNames);
      if (isFavoritesExist) {
        setFavoritesCollapsed(true);
      }
    }
  };

  return (
    <aside className="sidebar-aside" style={width !== undefined ? { width: `${width}px` } : undefined}>
      {/* 新建 AI 会话头部区域 */}
      <div className="sidebar-header">
        {/* Agent 选卡切换 */}
        <div className="agent-selector">
          <div className={`agent-selector-slider ${selectedAgent}`} />
          <button
            className={`agent-tab ${selectedAgent === "claude" ? "active claude-style" : ""}`}
            onClick={() => onSelectAgent("claude")}
            title="Claude Code"
          >
            <ClaudeIcon size={18} color={selectedAgent === "claude" ? "#D97757" : "var(--text-secondary)"} />
          </button>
          <button
            className={`agent-tab ${selectedAgent === "codex" ? "active codex-style" : ""}`}
            onClick={() => onSelectAgent("codex")}
            title="Codex"
          >
            <CodexIcon size={18} color={selectedAgent === "codex" ? "var(--color-green)" : "var(--text-secondary)"} />
          </button>
        </div>
        
        {/* 新建会话按钮、机器人按钮与回收站按钮 */}
        <div className="new-session-row" style={{ display: "flex", gap: "6px", width: "100%", marginBottom: "12px" }}>
          <button
            className="new-session-btn"
            style={{ flex: 1, margin: 0 }}
            onClick={() => onOpenNewSession()}
          >
            + 新建会话
          </button>
          <button
            className="sidebar-action-btn bot-btn"
            onClick={onOpenTempSession}
            title="新建无痕临时终端"
            style={{
              width: "28px",
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--bg-active-item)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition: "var(--transition-smooth)",
              padding: 0,
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2"></rect>
              <circle cx="12" cy="5" r="2"></circle>
              <path d="M12 7v4M8 15h.01M16 15h.01"></path>
            </svg>
          </button>
          <button
            className="sidebar-action-btn trash-btn"
            onClick={() => setShowTrashModal(true)}
            title="回收站"
            style={{
              width: "28px",
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "var(--bg-active-item)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              color: "var(--text-secondary)",
              cursor: "pointer",
              transition: "var(--transition-smooth)",
              padding: 0,
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </button>
        </div>

        {/* 快速搜索框 */}
        <div className="search-container" style={{ display: "flex", alignItems: "center", position: "relative" }}>
          <svg
            className="search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            className={`search-input ${selectedAgent === "codex" ? "codex-focus" : ""}`}
            style={{ paddingRight: selectedAgent === "claude" ? "34px" : "12px" }}
            placeholder={isContentSearch ? "✨ 全局搜索聊天记录内容..." : "搜索本地会话项目..."}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
          {selectedAgent === "claude" && (
            <button
              className={`search-enhance-btn ${isContentSearch ? "active" : ""}`}
              onClick={() => setIsContentSearch(!isContentSearch)}
              title={isContentSearch ? "切换为普通标题搜索" : "全局聊天内容搜索 (✨)"}
              style={{
                position: "absolute",
                right: "8px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: isContentSearch ? "var(--color-primary)" : "var(--text-secondary)",
                transition: "var(--transition-smooth)",
                padding: "4px",
                borderRadius: "4px"
              }}
            >
              <svg 
                width="14" 
                height="14" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                strokeWidth="2.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                <line x1="8" y1="9" x2="14" y2="9"></line>
                <line x1="8" y1="13" x2="12" y2="13"></line>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 滚动会话树列表 */}
      <div className="sidebar-scroll">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: "12px", marginBottom: "8px" }}>
          <div className="section-title" style={{ marginBottom: 0 }}>会话管理</div>
          <button 
            className="collapse-all-btn"
            onClick={toggleCollapseAll}
            disabled={sortedProjectNames.length === 0 && favoriteSessions.length === 0}
            title={allCollapsed ? "展开全部" : "收起全部"}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: (sortedProjectNames.length === 0 && favoriteSessions.length === 0) ? "not-allowed" : "pointer",
              padding: "2px 4px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
              transition: "var(--transition-smooth)",
              opacity: (sortedProjectNames.length === 0 && favoriteSessions.length === 0) ? 0.3 : 1,
            }}
            onMouseEnter={(e) => {
              if (sortedProjectNames.length > 0 || favoriteSessions.length > 0) {
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.backgroundColor = "var(--bg-hover-item)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            {allCollapsed ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 13 5 5 5-5"/>
                <path d="m7 6 5 5 5-5"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m17 11-5-5-5 5"/>
                <path d="m17 18-5-5-5 5"/>
              </svg>
            )}
          </button>
        </div>

        {/* 置顶 “⭐ 收藏” 分组 (如果有被收藏的会话) */}
        {favoriteSessions.length > 0 && (
          <div className="project-group favorite-group-wrapper" style={{ marginBottom: "12px" }}>
            <div 
              className="project-header favorite-group-header" 
              onClick={() => setFavoritesCollapsed(!favoritesCollapsed)}
              style={{ cursor: "pointer", userSelect: "none" }}
            >
              <div className="project-title favorite-group-title">
                <span className="project-chevron" style={{ transform: favoritesCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                  ▼
                </span>
                <span style={{ color: "var(--color-orange)", fontWeight: 700 }}>★ 收藏</span>
              </div>
              <span className="project-session-count" style={{ backgroundColor: "var(--color-orange-light)", color: "var(--color-orange)" }}>
                {favoriteSessions.length}
              </span>
            </div>
            
            {!favoritesCollapsed && (() => {
              const visibleSessions = favoritesExpanded ? favoriteSessions : favoriteSessions.slice(0, 5);
              const hiddenCount = favoriteSessions.length - 5;
              return (
                <>
                  <ul className="session-list" style={{ padding: "2px" }}>
                    {visibleSessions.map((session) => renderSessionRow(session))}
                  </ul>
                  {hiddenCount > 0 && (
                    <div
                      className="expand-collapse-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFavoritesExpanded(!favoritesExpanded);
                      }}
                    >
                      {favoritesExpanded ? "收起" : `展开更多 (${hiddenCount})`}
                    </div>
                  )}
                </>
              );
            })()}
            <div className="favorite-divider" style={{ borderBottom: "1px dashed var(--border-color)", margin: "8px 4px 4px 4px" }} />
          </div>
        )}

        {/* 常规项目与会话树 */}
        {sortedProjectNames.length === 0 ? (
          <div style={{ padding: "20px 8px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
            暂无活动会话
          </div>
        ) : (
          sortedProjectNames.map((projName) => {
            const proj = projectsMap[projName];
            if (!proj) return null;
            const isCollapsed = collapsedProjects.includes(projName);
            const isProjectFavorited = favoriteProjects.some((fp) => fp.name === projName);
            return (
              <div
                key={projName}
                data-project-name={projName}
                className="project-group"
              >
                {/* 项目层级标题 */}
                <div
                  className="project-header"
                  onClick={() => toggleProject(projName)}
                  onContextMenu={(e) => handleProjectContextMenu(e, projName, proj.path, proj.sessions, isProjectFavorited)}
                  style={{ cursor: "pointer", userSelect: "none" }}
                >
                  <div className="project-title">
                    <span className="project-chevron" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                      ▼
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <span 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFavoriteProject(projName, e);
                        }}
                        className="project-folder-toggle"
                        style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}
                        title={isProjectFavorited ? "取消收藏" : "收藏项目"}
                      >
                        <svg
                          className="folder-svg-icon"
                          xmlns="http://www.w3.org/2000/svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={isProjectFavorited ? "var(--color-primary)" : "var(--text-secondary)"}
                          strokeWidth="2.0"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ opacity: 0.95, transition: "stroke 0.15s ease" }}
                        >
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                      </span>
                      <span title={proj.path}>{projName}</span>
                    </span>
                    {isProjectFavorited && (
                      <span className="project-star-badge" style={{ color: "#f59e0b", marginLeft: "4px" }}>★</span>
                    )}
                  </div>
                  
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }} onClick={(e) => e.stopPropagation()}>
                    <span className="project-session-count">
                      {proj.sessions.length}
                    </span>
                  </div>
                </div>
                
                {/* 会话列表 */}
                {!isCollapsed && (() => {
                  const isExpanded = expandedProjects.includes(projName);
                  const visibleSessions = isExpanded ? proj.sessions : proj.sessions.slice(0, 5);
                  const hiddenCount = proj.sessions.length - 5;
                  return (
                    <>
                      <ul className="session-list" style={{ padding: "2px" }}>
                        {visibleSessions.map((session) => renderSessionRow(session))}
                      </ul>
                      {hiddenCount > 0 && (
                        <div
                          className="expand-collapse-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedProjects((prev) =>
                              prev.includes(projName) ? prev.filter((p) => p !== projName) : [...prev, projName]
                            );
                          }}
                        >
                          {isExpanded ? "收起" : `展开更多 (${hiddenCount})`}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>

      {/* 归档区 */}
      <div className="archive-section" ref={archiveSectionRef}>
        <div 
          className="archive-header"
          onClick={() => setShowArchive(!showArchive)}
          style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderTop: "1px solid var(--border-color)", backgroundColor: "var(--bg-sidebar)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="21 8 21 21 3 21 3 8"></polyline>
              <rect x="1" y="3" width="22" height="5"></rect>
              <line x1="10" y1="12" x2="14" y2="12"></line>
            </svg>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>归档区</span>
            <span style={{ fontSize: "11px", color: "var(--text-secondary)", backgroundColor: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: "10px" }}>{archivedProjects.length}</span>
          </div>
          <span className="project-chevron" style={{ transform: showArchive ? "rotate(0deg)" : "rotate(-90deg)", fontSize: "9px", color: "var(--text-secondary)" }}>▼</span>
        </div>

        {showArchive && (
          <div className="archive-content" style={{ maxHeight: "200px", overflowY: "auto" }}>
            {archivedProjects.length === 0 ? (
              <div style={{ padding: "12px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>
                暂无归档项目
              </div>
            ) : (
              Object.entries(
                archivedProjects.reduce((acc, proj) => {
                  if (!acc[proj.archive_month]) acc[proj.archive_month] = [];
                  acc[proj.archive_month].push(proj);
                  return acc;
                }, {} as Record<string, ArchivedProject[]>)
              ).map(([month, projects]) => (
                <div key={month} className="archive-month-group">
                  <div style={{ padding: "4px 12px", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", backgroundColor: "var(--bg-active-item)", borderBottom: "1px solid var(--border-color)" }}>
                    {month}
                  </div>
                  {projects.map((proj) => (
                    <div 
                      key={proj.id} 
                      className="archive-item"
                      style={{ padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", transition: "var(--transition-smooth)" }}
                      onClick={() => {
                        setConfirmState({
                          show: true,
                          title: "还原项目",
                          message: (
                            <>
                              确定要将项目「<strong style={{ color: "var(--color-orange)" }}>{proj.project_name}</strong>」还原到工作区吗？
                            </>
                          ),
                          onConfirm: () => {
                            handleRestoreArchivedProject(proj.id);
                            setConfirmState(null);
                          }
                        });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setArchiveContextMenu({ x: e.clientX, y: e.clientY, project: proj });
                      }}
                      title={proj.project_path}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span style={{ fontSize: "12px", color: "var(--text-primary)", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{proj.project_name}</span>
                      </div>
                      <span style={{ fontSize: "10px", color: "var(--text-secondary)" }} title="点击还原到工作区">还原</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 归档项目右键菜单 */}
      {archiveContextMenu && (
        <div 
          className="context-menu"
          style={{ top: archiveContextMenu.y, left: archiveContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              handleRestoreArchivedProject(archiveContextMenu.project.id);
              setArchiveContextMenu(null);
            }}
          >
            还原到工作区
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(archiveContextMenu.project.project_path).catch(() => {});
              setArchiveContextMenu(null);
            }}
          >
            复制路径
          </button>
        </div>
      )}

      {/* 9. 自定义高档白天右键上下文悬浮菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{
            top: menuPos?.top ?? contextMenu.y,
            left: menuPos?.left ?? contextMenu.x
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              if (onToggleFavorite) {
                onToggleFavorite(contextMenu.session.id, contextMenu.session.favorite !== 1);
              }
              setContextMenu(null);
            }}
          >
            {contextMenu.session.favorite === 1 ? "取消收藏" : "收藏"}
          </button>
          
          <div className="context-menu-divider" style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}></div>

          <button 
            className="context-menu-item"
            onClick={() => {
              startEditing(contextMenu.session);
              setContextMenu(null);
            }}
          >
            重命名
          </button>

          <div className="context-menu-divider" style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}></div>

          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.session.agentSessionId).catch(() => {});
              setContextMenu(null);
            }}
          >
            复制 Session ID
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(contextMenu.session.path).catch(() => {});
              setContextMenu(null);
            }}
          >
            复制项目路径
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              invoke("open_project_folder", { path: contextMenu.session.path }).catch(() => {});
              setContextMenu(null);
            }}
          >
            在文件管理器中打开
          </button>

          <button
            className="context-menu-item"
            style={{ color: "#ef4444" }}
            onClick={() => {
              setSessionToDelete(contextMenu.session);
              setContextMenu(null);
            }}
          >
            删除
          </button>
        </div>
      )}

      {/* 项目右键上下文悬浮菜单 */}
      {projectContextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{
            top: menuPos?.top ?? projectContextMenu.y,
            left: menuPos?.left ?? projectContextMenu.x
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            className="context-menu-item"
            onClick={() => {
              if (onCreateSessionDirectly) {
                onCreateSessionDirectly(projectContextMenu.projectPath);
              } else {
                onOpenNewSession(projectContextMenu.projectPath);
              }
              setProjectContextMenu(null);
            }}
          >
            新建会话
          </button>
          <div style={{ borderBottom: "1px dashed var(--border-color)", margin: "4px 6px" }} />
          <button 
            className="context-menu-item"
            onClick={(e) => {
              handleToggleFavoriteProject(projectContextMenu.projectName, e);
              setProjectContextMenu(null);
            }}
          >
            {projectContextMenu.isFavorited ? "取消收藏项目" : "收藏项目"}
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              handleOpenProjectInExplorer(projectContextMenu.projectPath);
              setProjectContextMenu(null);
            }}
          >
            在文件管理器中打开
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard.writeText(projectContextMenu.projectPath).then(() => {
                // 静默复制成功
              }).catch(() => {
                alert("复制路径失败");
              });
              setProjectContextMenu(null);
            }}
          >
            复制路径
          </button>
          <button 
            className="context-menu-item"
            onClick={() => {
              handleArchiveProject(projectContextMenu.projectName, projectContextMenu.projectPath);
              setProjectContextMenu(null);
            }}
          >
            归档项目
          </button>
          <div style={{ borderBottom: "1px dashed var(--border-color)", margin: "4px 6px" }} />
          <button 
            className="context-menu-item"
            style={{ color: "#ef4444" }}
            onClick={() => {
              const proj = projectsMap[projectContextMenu.projectName];
              if (proj) {
                const ids = proj.sessions.map((s) => s.id);
                setProjectToDelete({
                  projectName: projectContextMenu.projectName,
                  sessionIds: ids,
                });
              }
              setProjectContextMenu(null);
            }}
          >
            移除整个目录
          </button>
        </div>
      )}

      {/* 移除目录确认弹窗 */}
      {projectToDelete && (
        <div className="modal-overlay show" onClick={() => setProjectToDelete(null)}>
          <div className="modal-card" style={{ maxWidth: "420px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">移除整个目录</span>
              <button className="modal-close" onClick={() => setProjectToDelete(null)}>×</button>
            </div>
            
            <div style={{ fontSize: "13.5px", lineHeight: "1.6", color: "var(--text-primary)" }}>
              确定要移除该目录「<strong style={{ color: "var(--color-orange)" }}>{projectToDelete.projectName}</strong>」下的 <strong style={{ color: "var(--color-orange)", fontSize: "14.5px" }}>{projectToDelete.sessionIds.length}</strong> 个会话吗？
              <br />
              <span style={{ fontSize: "12px", color: "var(--text-secondary)", display: "inline-block", marginTop: "10px" }}>
                ⚠️ 此操作仅删除应用中的会话记录，不会删除磁盘上的原始文件。
              </span>
            </div>
            
            <div className="modal-footer">
              <button className="modal-btn modal-btn-cancel" onClick={() => setProjectToDelete(null)}>
                取消
              </button>
              <button 
                className="modal-btn modal-btn-create" 
                style={{ backgroundColor: "#ef4444", color: "#fff", boxShadow: "0 2px 4px rgba(239, 68, 68, 0.2)" }}
                onClick={() => {
                  onDeleteSessionsBatch(projectToDelete.sessionIds);
                  setProjectToDelete(null);
                }}
              >
                移除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 确认删除会话弹窗 */}
      {sessionToDelete && (
        <div className="modal-overlay show" style={{ zIndex: 1100 }} onClick={() => setSessionToDelete(null)}>
          <div className="modal-card" style={{ maxWidth: "380px", padding: "20px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
              <span style={{ 
                display: "inline-flex", 
                alignItems: "center", 
                justifyContent: "center", 
                width: "24px", 
                height: "24px", 
                borderRadius: "50%", 
                backgroundColor: "#fef3c7", 
                color: "#d97706",
                fontSize: "14px",
                fontWeight: "bold",
                flexShrink: 0
              }}>
                !
              </span>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: "14.5px", fontWeight: 700, color: "var(--text-primary)" }}>确认删除</h3>
                <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
                  确定要删除该会话吗？删除后将移入回收站。
                </p>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "20px" }}>
              <button 
                className="modal-btn modal-btn-cancel" 
                onClick={() => setSessionToDelete(null)}
              >
                取 消
              </button>
              <button 
                className="modal-btn modal-btn-create" 
                style={{ backgroundColor: "#ef4444", color: "#fff", boxShadow: "0 2px 4px rgba(239, 68, 68, 0.2)" }}
                onClick={() => {
                  onDeleteSession(null, sessionToDelete.id);
                  setSessionToDelete(null);
                }}
              >
                删 除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🗑️ 回收站垃圾桶弹窗 */}
      {showTrashModal && (() => {
        const deletedSessions = sessions.filter((s) => s.deleted === 1 && s.type === selectedAgent);
        return (
          <div className="modal-overlay show" style={{ zIndex: 1100 }} onClick={() => setShowTrashModal(false)}>
            <div className="modal-card trash-modal-card" style={{ maxWidth: "480px", width: "100%" }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                  垃圾桶
                  <span className="trash-count-badge">
                    {deletedSessions.length} 项
                  </span>
                </span>
                <button className="modal-close" onClick={() => setShowTrashModal(false)}>×</button>
              </div>

              <div className="trash-session-list">
                {deletedSessions.length === 0 ? (
                  <div className="trash-empty-placeholder">
                    垃圾桶空空如也
                  </div>
                ) : (
                  deletedSessions.map((s) => (
                    <div key={s.id} className="trash-session-item">
                      <div className="trash-item-info">
                        <div className="trash-item-name" title={s.name}>
                          {s.name}
                        </div>
                        <div className="trash-item-meta">
                          <span className="trash-item-project">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                            {s.project}
                          </span>
                          <span className="trash-item-expiry">
                            7天后删除
                          </span>
                        </div>
                      </div>
                      <div className="trash-item-actions">
                        <button
                          title="恢复会话"
                          onClick={() => onRestoreSession(s.id)}
                          className="trash-action-btn recover"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                          </svg>
                        </button>
                        <button
                          title="彻底删除"
                          onClick={() => {
                            setConfirmState({
                              show: true,
                              title: "彻底删除会话",
                              message: "确定要永久删除该会话吗？此操作不可逆。",
                              isDanger: true,
                              onConfirm: () => {
                                onPermanentlyDeleteSession(s.id);
                                setConfirmState(null);
                              }
                            });
                          }}
                          className="trash-action-btn hard-delete"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="modal-footer trash-modal-footer">
                <span className="trash-expiry-tip">
                  超过 7 天自动永久删除
                </span>
                {deletedSessions.length > 0 && (
                  <button 
                    className="trash-empty-btn"
                    onClick={() => {
                      setConfirmState({
                        show: true,
                        title: "清空垃圾桶",
                        message: "确定要清空垃圾桶中的所有已删除会话吗？此操作不可逆。",
                        isDanger: true,
                        onConfirm: () => {
                          onEmptyTrash();
                          setConfirmState(null);
                        }
                      });
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    清空垃圾桶
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 全局内容搜索悬浮卡片面板 */}
      {hoveredSession && (
        <div 
          className="search-match-popover"
          style={{
            position: "fixed",
            left: `${(width !== undefined ? width : 300) + 8}px`,
            top: `${hoveredSession.top}px`,
            zIndex: 2000,
            width: "320px",
            backgroundColor: "var(--bg-sidebar)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 6px 16px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.2)",
            padding: "10px 12px",
            animation: "fadeInSmooth 0.15s cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "none",
          }}
        >
          <div style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            marginBottom: "8px",
            borderBottom: "1px solid var(--border-color)",
            paddingBottom: "6px"
          }}>
            ✨ 匹配记录 (最多展示 3 条)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {hoveredSession.session.matchSnippets?.slice(0, 3).map((snippet, idx) => (
              <div 
                key={idx} 
                style={{
                  fontSize: "11.5px",
                  color: "var(--text-primary)",
                  lineHeight: "1.5",
                  fontFamily: "var(--font-mono)",
                  wordBreak: "break-all",
                  paddingBottom: idx < 2 && idx < (hoveredSession.session.matchSnippets?.length || 0) - 1 ? "8px" : "0",
                  borderBottom: idx < 2 && idx < (hoveredSession.session.matchSnippets?.length || 0) - 1 ? "1px dashed var(--border-color)" : "none"
                }}
              >
                {highlightKeyword(snippet, searchQuery)}
              </div>
            ))}
          </div>
        </div>
      )}
      {confirmState && (
        <ConfirmModal
          show={confirmState.show}
          title={confirmState.title}
          message={confirmState.message}
          isDanger={confirmState.isDanger}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </aside>
  );
};

const escapeRegExp = (str: string) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const highlightKeyword = (text: string, keyword: string) => {
  if (!keyword) return text;
  try {
    const parts = text.split(new RegExp(`(${escapeRegExp(keyword)})`, "gi"));
    return parts.map((part, index) => 
      part.toLowerCase() === keyword.toLowerCase()
        ? <strong key={index} style={{ color: "var(--color-primary)", fontWeight: 600 }}>{part}</strong>
        : part
    );
  } catch (e) {
    return text;
  }
};
