import { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Sidebar, Session, ClaudeIcon, CodexIcon } from "./components/Sidebar";
import { TerminalTab } from "./components/TerminalTab";
import { ChatTab } from "./components";
import { NewSessionModal } from "./components/NewSessionModal";
import { SettingsModal } from "./components/SettingsModal";
import { MdEditorModal } from "./components/MdEditorModal";
import { ProjectTree } from "./components/ProjectTree";
import { GitPanel } from "./components/git/GitPanel";
import { BranchPanel } from "./components/git/BranchPanel";
import { SessionHistoryPanel } from "./components/SessionHistoryPanel";
import { renderMarkdownToHtml } from "./utils/markdown";
import { applyTheme, readStoredTheme, THEME_DEFINITIONS, THEME_STORAGE_KEY } from "./utils/theme";
import { FileEditor, type FileEditorHandle } from "./components/FileEditor";
import { FileText, Folder, GitBranch, GitCommit } from "lucide-react";
import agentdeskIcon from "./assets/brand/agentdesk-icon.png";
import { AppToastHost } from "./components/AppToastHost";
import { ConfirmModal } from "./components/ConfirmModal";
import { useAppFeedback, useSessionQueueEngine } from "./hooks";
import { getSessionQueue, MAX_SESSION_QUEUE_SIZE } from "./utils/sessionQueue";
import { notifyWarning, formatFeedbackError } from "./utils/appFeedback";
import {
  addUnreadCompletion,
  getUnreadCompletionCount,
  markSessionRead,
} from "./utils/unreadCompletions";
import { updateSessionLastUserMessageAt } from "./utils/sessionActivity";
import { readSessionCleanupSettings } from "./utils/sessionCleanup";
import { shouldResumeSession } from "./utils/sessionResume";
import {
  CLAUDE_INTERACTION_MODE_KEY,
  CLAUDE_INTERACTION_MODE_CHANGE_EVENT,
  resolveClaudeInteractionMode,
  shouldUseGuiChat,
  type ClaudeInteractionMode,
} from "./utils/interactionMode";
import {
  loadClaudeModelInfo,
  loadSelectedModel,
  saveSelectedModel,
  setClaudeModelBackend,
  setClaudeProviderBackend,
  type ClaudeModelInfo,
} from "./utils/claudeModel";
import { syncTaskbarUnreadBadge } from "./utils/taskbarBadge";
import "./App.css";

// 100% 安全的 UUID 生成器，防止 WebView2 部分版本及非安全上下文抛错闪退
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (e) {
      console.warn("crypto.randomUUID failed, falling back to math.random", e);
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// 持久化前端日志助手，即便窗口发生重载闪退，之前的日志也可以通过 localStorage 追溯
function log(msg: string) {
  const time = new Date().toISOString();
  const fullMsg = `[JS][${time}] ${msg}`;
  console.log(fullMsg);
  try {
    const existingLogs = JSON.parse(localStorage.getItem("agentdesk_logs") || "[]");
    existingLogs.push(fullMsg);
    if (existingLogs.length > 200) {
      existingLogs.shift();
    }
    localStorage.setItem("agentdesk_logs", JSON.stringify(existingLogs));
  } catch (e) {}
}

function getFolderName(path: string): string {
  if (!path) return "";
  // 去除末尾斜杠，避免 split 后最后一个元素为空导致显示异常
  const cleanPath = path.replace(/[\\/]+$/, "");
  const parts = cleanPath.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const CLAUDE_VERSION_CACHE_KEY = "agentdesk_cached_claude_version";
const CODEX_VERSION_CACHE_KEY = "agentdesk_cached_codex_version";

// 将 codex 版本字符串统一规范化为 "Codex <version>"，处理 "0.1.0"、"codex 0.1.0"、"codex-cli 0.144.1" 等
function normalizeCodexVersion(ver: string): string {
  const trimmed = ver.trim();
  const match = trimmed.match(/^codex[-_]?(cli|client)?\s*[:\-]?\s*(.*)$/i);
  if (match) {
    const version = (match[2] || "").trim();
    return version ? `Codex ${version}` : "Codex";
  }
  // 不以 codex 开头但非空，补上 "Codex " 前缀
  return trimmed ? `Codex ${trimmed}` : "Codex";
}

// 版本标签组件：裸名 + 没拿到真实版本时显示"未安装"并标红
function VersionLabel({ name, version, Icon, color }: {
  name: string;
  version: string;
  Icon: React.FC<{ size?: number; color?: string }>;
  color: string;
}) {
  const missing = version.trim() === name;
  return (
    <span className={missing ? "empty-state-version-item missing" : "empty-state-version-item"}>
      <Icon size={16} color={missing ? "var(--color-danger, #e5484d)" : color} />
      {missing ? `${name} 未安装` : version}
    </span>
  );
}

function App() {

  const appWindow = useMemo(() => getCurrentWindow(), []);

  // 应用挂载完成后显示窗口，避免白屏闪烁
  useEffect(() => {
    appWindow.show().catch(() => {});
  }, [appWindow]);

  const handleMinimize = () => {
    appWindow.minimize().catch((err) => log(`Failed to minimize: ${err}`));
  };

  const handleMaximize = () => {
    appWindow.toggleMaximize().catch((err) => log(`Failed to toggle maximize: ${err}`));
  };

  const handleClose = () => {
    appWindow.close().catch((err) => log(`Failed to close window: ${err}`));
  };

  const handleLaunchCcswitch = () => {
    const path = localStorage.getItem("agentdesk_setting_ccswitch_path") || "";
    if (!path.trim()) {
      alert("请先在「设置」->「终端设置」中配置 ccswitch.exe 的路径。");
      return;
    }
    invoke("launch_ccswitch", { path }).catch((err) => {
      alert(`启动 ccswitch.exe 失败:\n${err}`);
    });
  };

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const activeSessionIdRef = useRef<string>("");
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const isWindowFocusedRef = useRef<boolean>(true);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<"claude" | "codex">("claude");
  const [claudeInteractionMode, _setClaudeInteractionMode] = useState<ClaudeInteractionMode>(() => {
    return resolveClaudeInteractionMode(localStorage.getItem(CLAUDE_INTERACTION_MODE_KEY));
  });
  const [interactionModeBySession, _setInteractionModeBySession] = useState<Record<string, ClaudeInteractionMode>>({});

  // 设置中心切换交互模式时实时生效（无桌面监听时默认回退 CLI 由 useCallback 重新解析）
  useEffect(() => {
    const handleInteractionModeChange = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      const next = resolveClaudeInteractionMode(detail ?? null);
      _setClaudeInteractionMode(next);
      log(`[app] interaction mode changed -> ${next}`);
    };
    window.addEventListener(CLAUDE_INTERACTION_MODE_CHANGE_EVENT, handleInteractionModeChange);
    return () => window.removeEventListener(CLAUDE_INTERACTION_MODE_CHANGE_EVENT, handleInteractionModeChange);
  }, []);

  // 模型选择：读取 CC Switch 维护的 ~/.claude/settings.json 清单，
  // 选中即写入 localStorage 并同步后端全局状态（两处 claude 启动都从后端读）
  const [selectedModel, setSelectedModel] = useState<string | null>(() => loadSelectedModel());
  const [modelInfo, setModelInfo] = useState<ClaudeModelInfo | null>(null);
  // 变更检测用的上一次信息 + 失效提示去重标记
  const modelInfoRef = useRef<ClaudeModelInfo | null>(null);
  const notifiedRemovedModelRef = useRef<string | null>(null);
  const notifiedProviderRemovedRef = useRef(false);

  // 刷新模型信息：拉取后做变更检测，关键字段没变就不更新（避免每 10s 轮询触发全量重渲染）
  const refreshModelInfo = useCallback(() => {
    loadClaudeModelInfo()
      .then((info) => {
        const prev = modelInfoRef.current;
        const unchanged =
          !!prev &&
          prev.providerName === info.providerName &&
          prev.routeMode === info.routeMode &&
          prev.providerRemoved === info.providerRemoved &&
          prev.defaultModel === info.defaultModel &&
          prev.models.join("|") === info.models.join("|") &&
          prev.providers.map((p) => p.id).join("|") ===
            info.providers.map((p) => p.id).join("|");
        if (unchanged) return;
        modelInfoRef.current = info;
        setModelInfo(info);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshModelInfo();
    // 启动时把持久化的选择同步给后端（后端重启后需要重建）
    setClaudeModelBackend(loadSelectedModel());
    // 窗口重新获得焦点时刷新 + 每 10s 轻量轮询：
    // CC Switch 增删供应商/模型、改旋钮 → 最多 10s 内自动同步，无需手动操作
    const onFocus = () => refreshModelInfo();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(refreshModelInfo, 10_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refreshModelInfo]);

  // 已选模型失效：被删除/改名 → 自动清空回默认 + 提示（每个失效模型只提示一次）
  useEffect(() => {
    if (!modelInfo) return;
    const selected = selectedModel;
    if (selected && modelInfo.models.length > 0 && !modelInfo.models.includes(selected)) {
      if (notifiedRemovedModelRef.current !== selected) {
        notifiedRemovedModelRef.current = selected;
        notifyWarning(`已选模型 ${selected} 已不在 CC Switch 配置中，已恢复为该供应商默认`);
      }
      setSelectedModel(null);
      setClaudeModelBackend(null);
      saveSelectedModel(null);
    } else {
      notifiedRemovedModelRef.current = null;
    }
  }, [modelInfo, selectedModel]);

  // 当前直连的供应商被删除/改名：提示一次（路由模式下由代理接管，不提示）
  useEffect(() => {
    if (!modelInfo) return;
    if (modelInfo.providerRemoved && !notifiedProviderRemovedRef.current) {
      notifiedProviderRemovedRef.current = true;
      notifyWarning("当前直连的供应商已不在 CC Switch 列表中（可能被删除或改名）");
    }
    if (!modelInfo.providerRemoved) notifiedProviderRemovedRef.current = false;
  }, [modelInfo]);

  const handleSelectModel = useCallback((model: string | null) => {
    setSelectedModel(model);
    setClaudeModelBackend(model);
    saveSelectedModel(model);
  }, []);

  // 选择供应商：只记录到 KKCODER 自己（内存 + localStorage），不写任何外部配置。
  // 启动 claude 时用所选供应商 env 生成临时 settings 文件（--settings 直连），
  // ~/.claude/settings.json 与 cc-switch.db 保持原样（避免 CC Switch 回写污染）。
  // 仅路由供应商（routeOnly）claude 无法直连，提示改用 CC Switch。
  const handleSelectProvider = useCallback((providerId: string) => {
    const routeOnly = modelInfo?.providers.find((p) => p.id === providerId)?.routeOnly;
    if (routeOnly) {
      notifyWarning("该供应商需要 CC Switch 路由代理才能使用，选择后仍由 CC Switch 当前配置转发；请在 CC Switch 中切换该供应商");
    }
    setSelectedModel(null);
    setClaudeModelBackend(null);
    saveSelectedModel(null);
    setClaudeProviderBackend(providerId)
      .then((info) => {
        modelInfoRef.current = info;
        setModelInfo(info);
      })
      .catch((err) => {
        refreshModelInfo();
        notifyWarning(formatFeedbackError(err, "选择供应商失败"));
      });
  }, [refreshModelInfo, modelInfo?.providers]);

  // 应用级反馈宿主：承接 appFeedback 总线的 Toast 与确认框
  const { toasts, dismissToast, activeConfirm, resolveConfirm } = useAppFeedback();

  // 统一封装「激活会话 + 同步左侧 agent 选中态」，避免被动切换路径漏同步 selector
  const activateSession = useCallback((id: string) => {
    setActiveSessionId(id);
    const s = sessions.find((sess) => sess.id === id);
    if (s) {
      setSelectedAgent(s.type);
    }
  }, [sessions]);

  const [showModal, setShowModal] = useState<boolean>(false);
  const [prefilledProjectPath, setPrefilledProjectPath] = useState<string | undefined>(undefined);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showMdEditor, setShowMdEditor] = useState<boolean>(false);
  const [newSessionIds, setNewSessionIds] = useState<string[]>([]);

  // 会话历史面板状态
  const [historyPanelOpen, setHistoryPanelOpen] = useState<boolean>(false);
  const [historySessionId, setHistorySessionId] = useState<string>("");

  const openHistoryPanel = useCallback((sessionId: string) => {
    setHistorySessionId(sessionId);
    setHistoryPanelOpen(true);
  }, []);

  // AI回答完成的闪烁状态
  const [glowingSessionIds, setGlowingSessionIds] = useState<string[]>([]);

  useEffect(() => {
    if (activeSessionId) {
      setGlowingSessionIds((prev) => markSessionRead(prev, activeSessionId));
    }
  }, [activeSessionId]);
  // 恢复会话相关状态
  const [pendingRestoreIds, setPendingRestoreIds] = useState<string[]>([]);
  const [pendingActiveId, setPendingActiveId] = useState<string>("");
  const [showRestoreToast, setShowRestoreToast] = useState<boolean>(false);
  const [showRestoreModal, setShowRestoreModal] = useState<boolean>(false);

  // 颜色调色盘主题切换相关状态
  const [showThemeDropdown, setShowThemeDropdown] = useState<boolean>(false);
  const [currentTheme, setCurrentTheme] = useState<string>(() => {
    return readStoredTheme();
  });
  const [isInitLoaded, setIsInitLoaded] = useState<boolean>(false);

  const [claudeVersion, setClaudeVersion] = useState<string>(() => {
    return localStorage.getItem(CLAUDE_VERSION_CACHE_KEY) || "Claude Code";
  });

  const [codexVersion, setCodexVersion] = useState<string>(() => {
    const cached = localStorage.getItem(CODEX_VERSION_CACHE_KEY);
    return cached ? normalizeCodexVersion(cached) : "Codex";
  });

  // 侧边栏拖拽调宽状态与拖拽处理
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem("agentdesk_sidebar_width");
    return saved ? parseInt(saved, 10) : 300;
  });
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [isDragOverWorkspace, setIsDragOverWorkspace] = useState<boolean>(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(450, e.clientX));
      setSidebarWidth(newWidth);
      localStorage.setItem("agentdesk_sidebar_width", newWidth.toString());
      window.dispatchEvent(new Event("resize"));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, 50);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  // 右侧项目树拖拽调宽状态与拖拽处理
  const [projectTreeWidth, setProjectTreeWidth] = useState<number>(() => {
    const saved = localStorage.getItem("agentdesk_project_tree_width");
    return saved ? parseInt(saved, 10) : 260;
  });
  const [isResizingProjectTree, setIsResizingProjectTree] = useState<boolean>(false);
  const projectTreeAsideRef = useRef<HTMLElement>(null);
  // 右侧项目树默认收起，不做全局记忆：每次启动都保持关闭，由用户手动打开（仅当次会话内保持打开状态）
  const [showProjectTree, setShowProjectTree] = useState<boolean>(false);
  const updateProjectTreeVisibility = useCallback((visible: boolean) => {
    // 仅当次会话内记忆开关状态，不做持久化：每次启动右侧面板始终收起
    setShowProjectTree(visible);

    if (visible) {
      // 抽屉打开后不再让标题栏按钮持有焦点，避免键盘输入误落到隐藏在抽屉后的终端区域。
      window.requestAnimationFrame(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
      });
    } else {
      // 抽屉关闭不会改变终端尺寸，只恢复当前终端输入焦点。
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event("agentdesk-focus-active-terminal"));
      });
    }
  }, []);
  // 右侧面板 Tab 切换：'files' = 项目文件树, 'git' = Git 变更面板, 'branches' = Git 分支面板
  const [rightPanelTab, setRightPanelTab] = useState<"files" | "git" | "branches">(() => {
    const saved = localStorage.getItem("agentdesk_right_panel_tab");
    if (saved === "git" || saved === "branches") return saved;
    return "files";
  });
  const [previewFile, setPreviewFile] = useState<{ 
    path: string; 
    content: string; 
    encoding?: string;
    cannotPreview?: boolean;
    errorMsg?: string;
  } | null>(null);
  const [mdMode, setMdMode] = useState<"preview" | "source">("source");
  const [previewFontFamily, setPreviewFontFamily] = useState<string>(() => {
    return localStorage.getItem("agentdesk_setting_preview_font_family") || "monospace";
  });
  const [previewFontSize, setPreviewFontSize] = useState<number>(() => {
    const val = localStorage.getItem("agentdesk_setting_preview_font_size");
    return val ? parseFloat(val) : 12.5;
  });
  const startProjectTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingProjectTree(true);
  };

  useEffect(() => {
    if (!isResizingProjectTree) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(500, window.innerWidth - e.clientX));
      setProjectTreeWidth(newWidth);
      localStorage.setItem("agentdesk_project_tree_width", newWidth.toString());
    };

    const handleMouseUp = () => {
      setIsResizingProjectTree(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingProjectTree]);

  // 覆盖式工作区抽屉优先于终端处理 Escape；文件预览、主题菜单和模态框保持更高关闭优先级。
  useEffect(() => {
    if (!showProjectTree) return;

    const handleProjectTreeEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(".modal-overlay.show") ||
        document.querySelector(".theme-dropdown") ||
        document.querySelector(".file-preview-modal")
      ) {
        return;
      }

      updateProjectTreeVisibility(false);
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    window.addEventListener("keydown", handleProjectTreeEscape, true);
    return () => window.removeEventListener("keydown", handleProjectTreeEscape, true);
  }, [showProjectTree, updateProjectTreeVisibility]);

  useEffect(() => {
    const handleFontChange = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      setPreviewFontFamily(customEvent.detail || "monospace");
    };
    const handleFontSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent<number>;
      setPreviewFontSize(customEvent.detail || 12.5);
    };

    window.addEventListener("agentdesk-preview-font-change", handleFontChange);
    window.addEventListener("agentdesk-preview-font-size-change", handleFontSizeChange);

    return () => {
      window.removeEventListener("agentdesk-preview-font-change", handleFontChange);
      window.removeEventListener("agentdesk-preview-font-size-change", handleFontSizeChange);
    };
  }, []);

  // 快捷短语状态
  const [shortcutsEnabled, setShortcutsEnabled] = useState<boolean>(() => {
    const val = localStorage.getItem("agentdesk_shortcuts_enabled");
    return val === null ? false : val === "true";
  });

  const [shortcutsList, setShortcutsList] = useState<{ title: string; content: string }[]>(() => {
    const val = localStorage.getItem("agentdesk_shortcuts_list");
    if (val) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          const list = [...parsed];
          while (list.length < 3) list.push({ title: "", content: "" });
          return list.slice(0, 3);
        }
      } catch (e) {
        // ignore
      }
    }
    return [
      { title: "继续", content: "继续完成" },
      { title: "", content: "" },
      { title: "", content: "" },
    ];
  });

  // 监听快捷短语设置变动
  useEffect(() => {
    const handleShortcutsChange = () => {
      const enabledVal = localStorage.getItem("agentdesk_shortcuts_enabled");
      setShortcutsEnabled(enabledVal === null ? false : enabledVal === "true");

      const listVal = localStorage.getItem("agentdesk_shortcuts_list");
      if (listVal) {
        try {
          const parsed = JSON.parse(listVal);
          if (Array.isArray(parsed)) {
            const list = [...parsed];
            while (list.length < 3) list.push({ title: "", content: "" });
            setShortcutsList(list.slice(0, 3));
          }
        } catch (e) {
          // ignore
        }
      }
    };

    window.addEventListener("agentdesk-shortcuts-change", handleShortcutsChange);
    return () => {
      window.removeEventListener("agentdesk-shortcuts-change", handleShortcutsChange);
    };
  }, []);

  // 按会话交互模式路由写入：GUI 聊天走 chat 发送事件，CLI 终端写 PTY
  const writeToSessionTerminal = useCallback(async (
    sessionId: string,
    data: string,
  ) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`会话 ${sessionId} 不存在`);
    const mode = interactionModeBySession[sessionId] ?? claudeInteractionMode;
    if (shouldUseGuiChat(session.type, mode)) {
      await new Promise<void>((resolve) => {
        window.dispatchEvent(new CustomEvent("kkcoder-chat-send-queued", {
          detail: { sessionId, prompt: data.trim() },
        }));
        setTimeout(resolve, 100);
      });
      return;
    }
    await invoke("write_to_terminal", { sessionId, data });
  }, [claudeInteractionMode, interactionModeBySession, sessions]);

  const handleTriggerShortcut = (content: string) => {
    if (!activeSessionId) return;
    const isBusy = sessionBusy[activeSessionId] || false;
    if (isBusy) {
      if (getSessionQueue(queueBySession, activeSessionId).length >= MAX_SESSION_QUEUE_SIZE) {
        notifyWarning(`队列已满（${MAX_SESSION_QUEUE_SIZE}/${MAX_SESSION_QUEUE_SIZE}），请先清空或等待执行`);
        return;
      }
      enqueuePrompt(activeSessionId, content);
    } else {
      setSessionBusy(prev => ({ ...prev, [activeSessionId]: true }));
      dispatchQueueTask(activeSessionId, content)
        .then(() => {
          handleUserSubmittedInputWithRenameReset(activeSessionId);
        })
        .catch((err) => {
          log(`Failed to send shortcut phrase: ${err}`);
          setSessionBusy(prev => ({ ...prev, [activeSessionId]: false }));
        });
    }
  };

  // 标签页右键菜单与高亮闪烁、行内重命名状态
  const [highlightSessionId, setHighlightSessionId] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renamingTabText, setRenamingTabText] = useState<string>("");

  // 标签页 Tooltip 状态管理
  const [tabTooltip, setTabTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    session: Session | null;
  }>({ visible: false, x: 0, y: 0, session: null });
  const tabTooltipShowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabTooltipHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTabMouseEnter = (e: React.MouseEvent, session: Session) => {
    if (tabTooltipHideTimeoutRef.current) {
      clearTimeout(tabTooltipHideTimeoutRef.current);
      tabTooltipHideTimeoutRef.current = null;
    }
    // 在setTimeout前保存rect，因为React合成事件在回调执行时已被回收
    const rect = e.currentTarget.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const bottomY = rect.bottom + 8;
    tabTooltipShowTimeoutRef.current = setTimeout(() => {
      setTabTooltip({
        visible: true,
        x: centerX,
        y: bottomY,
        session,
      });
    }, 300);
  };

  const handleTabMouseLeave = () => {
    if (tabTooltipShowTimeoutRef.current) {
      clearTimeout(tabTooltipShowTimeoutRef.current);
      tabTooltipShowTimeoutRef.current = null;
    }
    tabTooltipHideTimeoutRef.current = setTimeout(() => {
      setTabTooltip(prev => ({ ...prev, visible: false }));
    }, 100);
  };

  const handleTabTooltipMouseEnter = () => {
    if (tabTooltipHideTimeoutRef.current) {
      clearTimeout(tabTooltipHideTimeoutRef.current);
      tabTooltipHideTimeoutRef.current = null;
    }
  };

  const handleTabTooltipMouseLeave = () => {
    tabTooltipHideTimeoutRef.current = setTimeout(() => {
      setTabTooltip(prev => ({ ...prev, visible: false }));
    }, 100);
  };

  const handleOpenFolderPath = async (path: string) => {
    try {
      // tooltip 里点击的可能是文件路径，使用 open_terminal_path 让 Rust 端自动判断：
      //   - 若是文件：在文件管理器中打开父目录并选中该文件
      //   - 若是文件夹：直接打开该文件夹
      await invoke("open_terminal_path", { path });
    } catch (err) {
      console.error("打开文件夹失败:", err);
    }
  };

  // 队列任务投递：按会话交互模式路由——GUI 聊天走 chat 发送事件，CLI 终端写 PTY。
  // GUI 路径延迟 400ms：等后端 turn 收尾（turns map 清理）完成，避免「正在生成中」拒绝；
  // 若仍失败，ChatTab 侧会静默重试。
  const dispatchQueueTask = useCallback(
    (sessionId: string, prompt: string) => {
      const session = sessions.find((s: Session) => s.id === sessionId);
      const mode = interactionModeBySession[sessionId] ?? claudeInteractionMode;
      const useGuiChat = !!session && shouldUseGuiChat(session.type, mode);
      if (useGuiChat) {
        log(`[Queue] Dispatching queued task to GUI chat session ${sessionId}: "${prompt}"`);
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("kkcoder-chat-send-queued", {
              detail: { sessionId, prompt },
            }),
          );
        }, 400);
        return Promise.resolve();
      }
      return writeToSessionTerminal(sessionId, `${prompt}\r\n`);
    },
    [interactionModeBySession, claudeInteractionMode, sessions, writeToSessionTerminal],
  );

  // 构建每个打开标签的运行时属性（是否 GUI 聊天、是否 Native 终端等）
  const tabRuntimeBySession = useMemo(() => {
    const map = new Map<string, { shouldResume: boolean; useGuiChat: boolean }>();
    for (const session of sessions) {
      if (!openTabIds.includes(session.id)) continue;
      const mode = interactionModeBySession[session.id] ?? claudeInteractionMode;
      map.set(session.id, {
        shouldResume: shouldResumeSession(session.id, newSessionIds),
        useGuiChat: shouldUseGuiChat(session.type, mode),
      });
    }
    return map;
  }, [sessions, openTabIds, newSessionIds, interactionModeBySession, claudeInteractionMode]);

  const handleUserSubmittedInput = (sessionId: string, submittedAt: string = new Date().toISOString()) => {
    localStorage.setItem(`agentdesk_session_has_dialogue_${sessionId}`, "true");
    setSessions((prev) => updateSessionLastUserMessageAt(prev, sessionId, submittedAt));

    const targetSession = sessions.find((session) => session.id === sessionId);
    if (!targetSession || targetSession.isTemp) {
      return;
    }

    invoke("touch_session_last_user_message", { id: sessionId }).catch((err) => {
      log(`Failed to persist last user message time for ${sessionId}: ${err}`);
    });
  };

  // 统一的自动修正触发函数（根据命名模式选择 heuristic 或 LLM）
  const initialRenameTimes = (() => {
    try { return JSON.parse(localStorage.getItem("agentdesk_last_rename_times") || "{}") as Record<string, number>; }
    catch { return {} as Record<string, number>; }
  })();
  const lastRenameTimesRef = useRef<Record<string, number>>(initialRenameTimes);
  const triggerAutoRename = (source: string) => {
    const mode = localStorage.getItem("agentdesk_setting_namer_mode") || "heuristic";
    const skipFav = localStorage.getItem("agentdesk_setting_auto_rename_skip_favorites") !== "false";

    const cmd = mode === "llm" ? "llm_rename_sessions" : "auto_rename_sessions";
    const params: Record<string, unknown> = { skipFavorites: skipFav, projectFilter: null };

    if (mode === "llm") {
      const apiKey = localStorage.getItem("agentdesk_setting_llm_api_key") || "";
      if (!apiKey) {
        log(`${source} auto-rename: LLM mode enabled but API key is empty, skipping.`);
        return;
      }
      params.apiUrl = localStorage.getItem("agentdesk_setting_llm_api_url") || "https://api.deepseek.com";
      params.apiKey = apiKey;
      params.model = localStorage.getItem("agentdesk_setting_llm_model") || "deepseek-v4-flash";
      // 传入上次修正时间表，Rust 端只处理有新内容的会话
      params.lastRenameTimes = JSON.stringify(lastRenameTimesRef.current);
    }

    invoke<{ session_id: string; old_name: string; new_name: string; changed: boolean }[]>(cmd, params)
      .then((results) => {
        const changed = results.filter((r) => r.changed);
        if (changed.length > 0) {
          log(`${source} auto-rename (${mode}): ${changed.length} sessions renamed.`);
          // 更新修正时间表
          const now = Date.now() / 1000;
          for (const r of changed) {
            lastRenameTimesRef.current[r.session_id] = now;
          }
          try { localStorage.setItem("agentdesk_last_rename_times", JSON.stringify(lastRenameTimesRef.current)); } catch {}
          invoke<Session[]>("get_sessions").then((updated) => {
            if (updated) setSessions(updated);
          }).catch(() => {});
        }
      })
      .catch((err) => log(`${source} auto-rename failed: ${err}`));
  };

  // 空闲时自动修正会话名称（每 60 秒检查一次）
  const renamedSinceLastInputRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (localStorage.getItem("agentdesk_setting_auto_rename_idle") !== "true") return;

      const now = Date.now();
      const idleMinutes = parseInt(localStorage.getItem("agentdesk_setting_idle_minutes") || "5", 10);
      const IDLE_MS = idleMinutes * 60 * 1000;
      const skipFav = localStorage.getItem("agentdesk_setting_auto_rename_skip_favorites") !== "false";

      // 找出空闲 >= 5 分钟且未被修正过的会话
      let hasIdle = false;
      for (const s of sessions) {
        if (s.deleted || s.type !== "claude") continue;
        if (skipFav && s.favorite) continue;
        if (renamedSinceLastInputRef.current.has(s.id)) continue;
        const lastActive = s.lastUserMessageAt ? new Date(s.lastUserMessageAt).getTime() : 0;
        if (lastActive > 0 && now - lastActive >= IDLE_MS) {
          renamedSinceLastInputRef.current.add(s.id);
          hasIdle = true;
        }
      }

      if (hasIdle) {
        triggerAutoRename("Idle");
      }
    }, 60000);

    return () => window.clearInterval(interval);
  }, [sessions]);

  // 用户发消息时，清除该会话的"已修正"标记，允许下次空闲时再次修正
  const handleUserSubmittedInputWithRenameReset = (sessionId: string, submittedAt?: string) => {
    renamedSinceLastInputRef.current.delete(sessionId);
    handleUserSubmittedInput(sessionId, submittedAt);
  };

  // 会话任务队列引擎（上限 10/暂停恢复/逐条编辑删除，自动调度投递）
  const {
    queueBySession,
    showQueueModal,
    setShowQueueModal,
    queueInput,
    setQueueInput,
    setQueueTargetSessionId,
    sessionBusy,
    setSessionBusy,
    activeQueue,
    queueModalQueue,
    handleAddToQueue,
    enqueuePrompt,
    clearQueueForSession,
    removeQueuedTask,
    updateQueuedTask,
    pauseSessionQueue,
    resumeSessionQueue,
  } = useSessionQueueEngine({
    activeSessionId,
    openTabIds,
    dispatchTask: dispatchQueueTask,
    onTaskSubmitted: handleUserSubmittedInputWithRenameReset,
  });

  // 当队列长度或显示状态变化时，强力触发 resize 事件，确保 xterm.js 虚拟终端完美重测尺寸且不遮挡输入框
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 80); // 80ms 确保 DOM 树重排与 CSS 动画过渡彻底完成
    return () => clearTimeout(timer);
  }, [activeQueue.length]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // 右侧工作区面板展示方式：GUI 聊天会话用"推开式"（面板占位、聊天区收缩，不遮挡），
  // 其余（CLI 终端 / Codex 终端）保留覆盖式抽屉
  const activeWorkspacePanelInflow =
    !!activeSession && activeSessionId
      ? (tabRuntimeBySession.get(activeSessionId)?.useGuiChat ?? false)
      : false;

  // 文件树自适应宽度：监听树内容变化，自动调整面板宽度
  // 右侧项目树打开时一次性计算合适宽度（仅当内容超出当前宽度时自动展宽）
  // 避免每次展开/折叠都触发宽度变动，用户可手动拖拽调整
  useEffect(() => {
    const aside = projectTreeAsideRef.current;
    if (!aside || !showProjectTree) return;

    const timer = setTimeout(() => {
      const root = aside.querySelector(".project-tree-root");
      if (!root) return;

      const htmlRoot = root as HTMLElement;
      // 加 measuring 类临时恢复内容固有宽度（width:max-content + 文件名不截断），测出真实树宽
      htmlRoot.classList.add("measuring");
      const contentWidth = htmlRoot.scrollWidth;
      htmlRoot.classList.remove("measuring");

      const maxW = Math.floor(window.innerWidth * 0.4);
      const idealW = Math.max(200, Math.min(maxW, contentWidth + 24));

      setProjectTreeWidth(prev => {
        if (idealW > prev) {
          localStorage.setItem("agentdesk_project_tree_width", idealW.toString());
          return idealW;
        }
        return prev;
      });
    }, 150);

    return () => clearTimeout(timer);
  }, [showProjectTree, activeSession?.path]);

  // 将相对路径转为绝对路径（路径分隔符自适应，projectPath 为空时回退为原样返回）
  const toAbsolutePath = useCallback((relativePath: string): string => {
    const base = activeSession?.path;
    if (!base) return relativePath;
    const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
    return `${base}${sep}${relativePath}`;
  }, [activeSession?.path]);

  // 插入对话事件同时以新旧两个通道派发：TerminalTab 仍监听 agentdesk-*，ChatTab 监听 kkcoder-*
  const dispatchInsertConversationTag = useCallback((detail: {
    sessionId: string;
    text: string;
    kind?: string;
    sourcePath?: string;
  }) => {
    window.dispatchEvent(new CustomEvent("agentdesk-insert-conversation-tag", { detail }));
    window.dispatchEvent(new CustomEvent("kkcoder-insert-conversation-tag", { detail }));
  }, []);

  const insertConversationTagToActiveTerminal = useCallback((text: string, kind?: string, sourcePath?: string) => {
    if (!activeSessionId || !text) return;
    dispatchInsertConversationTag({
      sessionId: activeSessionId,
      text,
      kind,
      sourcePath,
    });
  }, [activeSessionId, dispatchInsertConversationTag]);

  // 文件拖拽到指定会话：将路径插入到目标会话的终端
  const handleInsertPathToSession = useCallback((sessionId: string, text: string) => {
    if (!sessionId || !text) return;
    dispatchInsertConversationTag({ sessionId, text });
  }, [dispatchInsertConversationTag]);

  // 切换会话项目路径时自动清空文件预览
  useEffect(() => {
    setPreviewFile(null);
  }, [activeSession?.path]);

  // Monaco 编辑器：脏态 + 保存句柄
  const fileEditorRef = useRef<FileEditorHandle>(null);
  const [fileDirty, setFileDirty] = useState(false);

  // 由 Monaco 选区行号直接添加到对话（编辑模式下走此路径）
  const handleAddLinesToConversation = useCallback((startLine: number, endLine: number) => {
    if (!previewFile || !activeSessionId) return;
    const rangeStr = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
    insertConversationTagToActiveTerminal(`"${toAbsolutePath(previewFile.path)}":${rangeStr} `);
  }, [previewFile, activeSessionId, insertConversationTagToActiveTerminal, toAbsolutePath]);

  // 关闭文件弹窗（有未保存改动先确认）
  const closePreview = useCallback(() => {
    if (fileDirty && !window.confirm("有未保存的更改，确定关闭吗？")) return;
    setPreviewFile(null);
    setMdMode("source");
    setFileDirty(false);
  }, [fileDirty]);

  // 全局键盘快捷键绑定（Esc 关闭文件弹窗；Ctrl+A/Ctrl+U 作用于 Markdown 预览等非编辑器内容）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 事件源自 Monaco 编辑器内部时，完全交给 Monaco 接管键盘（Ctrl+F/G、Esc 等原生）
      if ((e.target as HTMLElement | null)?.closest?.(".file-editor-monaco")) return;
      if (e.key === "Escape") {
        if (previewFile) {
          closePreview();
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (previewFile) {
        // Ctrl + A 全选限制在预览框中
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          const selection = window.getSelection();
          const previewPanel = document.querySelector(".file-preview-modal");
          if (previewPanel && selection && selection.anchorNode && previewPanel.contains(selection.anchorNode)) {
            e.preventDefault();
            e.stopPropagation();
            const targetEl = document.querySelector(".preview-markdown-content") || 
                             document.querySelector(".preview-text-content") ||
                             document.querySelector(".preview-body");
            if (targetEl) {
              const range = document.createRange();
              range.selectNodeContents(targetEl);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            return;
          }
        }

        // 保留旧预览区 Ctrl+U 的按键拦截；Monaco 内的添加操作由编辑器 action 接管。
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [previewFile, closePreview]);

  const handleFileClick = useCallback(async (relativePath: string) => {
    if (!activeSession?.path) return;
    if (fileEditorRef.current?.isDirty() && !window.confirm("有未保存的更改，确定切换文件吗？")) return;
    setMdMode("source");
    
    if (relativePath.toLowerCase().endsWith(".svg")) {
      setPreviewFile({
        path: relativePath,
        content: "",
        cannotPreview: true,
        errorMsg: "SVG 文件预览已禁用。"
      });
      return;
    }

    try {
      const result = await invoke<{ content: string; encoding: string }>("read_project_file_content", {
        projectPath: activeSession.path,
        relativePath
      });
      setPreviewFile({ path: relativePath, content: result.content, encoding: result.encoding, cannotPreview: false });
    } catch (err: any) {
      setPreviewFile({
        path: relativePath,
        content: "",
        cannotPreview: true,
        errorMsg: err ? String(err) : "无法读取此文件，可能是二进制文件或非UTF-8编码。"
      });
    }
  }, [activeSession?.path]);

  const handleInsertPathToTerminal = useCallback((relativePath: string) => {
    const absolutePath = toAbsolutePath(relativePath);
    const formatted = `"${absolutePath}" `;
    insertConversationTagToActiveTerminal(formatted);
  }, [insertConversationTagToActiveTerminal, toAbsolutePath]);

  // Git 面板 diff 弹窗右键「添加到对话」：面板传入仓库绝对路径 + 行号范围
  const handleAddGitLinesToConversation = useCallback(
    (absolutePath: string, startLine: number, endLine: number) => {
      const rangeStr = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
      insertConversationTagToActiveTerminal(`"${absolutePath}":${rangeStr} `);
    },
    [insertConversationTagToActiveTerminal]
  );








  // 记住最后的会话和打开的 Tab 标签页
  useEffect(() => {
    if (isInitLoaded) {
      localStorage.setItem("agentdesk_last_active_session_id", activeSessionId);
    }
  }, [activeSessionId, isInitLoaded]);

  useEffect(() => {
    if (isInitLoaded) {
      localStorage.setItem("agentdesk_last_open_tab_ids", JSON.stringify(openTabIds));
    }
  }, [openTabIds, isInitLoaded]);

  // 🖱️ 使用 FLIP (First, Last, Invert, Play) 技术为标签页顺序切换提供丝滑动画
  const lastTabPositions = useRef<Record<string, number>>({});
  useLayoutEffect(() => {
    const tabElements = document.querySelectorAll(".tab");
    const newPositions: Record<string, number> = {};

    tabElements.forEach((el) => {
      const id = el.getAttribute("data-id");
      const htmlEl = el as HTMLElement;
      if (id) {
        newPositions[id] = htmlEl.getBoundingClientRect().left;
        const oldLeft = lastTabPositions.current[id];

        // 仅对已经存在且位置发生变化的标签页做过渡动画（跳过当前正在拖拽的标签页）
        if (oldLeft !== undefined && oldLeft !== newPositions[id] && !htmlEl.classList.contains("dragging")) {
          const deltaX = oldLeft - newPositions[id];

          // 1. Invert: 瞬间移回老位置，不使用过渡动画
          htmlEl.style.transition = "none";
          htmlEl.style.transform = `translate3d(${deltaX}px, 0, 0)`;

          // 触发浏览器重绘以应用位移
          htmlEl.offsetHeight;

          // 2. Play: 启用过渡效果并让它平滑滑向新位置
          htmlEl.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)";
          htmlEl.style.transform = "translate3d(0, 0, 0)";

          // 3. Cleanup: 动画结束后清理行内样式，以防干扰 CSS 的其它 transition
          const cleanup = (e: TransitionEvent) => {
            if (e.propertyName === "transform") {
              htmlEl.style.transition = "";
              htmlEl.style.transform = "";
              htmlEl.removeEventListener("transitionend", cleanup);
            }
          };
          htmlEl.addEventListener("transitionend", cleanup);
        }
      }
    });

    lastTabPositions.current = newPositions;
  }, [openTabIds]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    appWindow.isFocused()
      .then((focused) => {
        isWindowFocusedRef.current = focused;
        if (focused && activeSessionIdRef.current) {
          setGlowingSessionIds((prev) => markSessionRead(prev, activeSessionIdRef.current));
        }
      })
      .catch((err) => log(`Failed to read window focus state: ${err}`));

    appWindow.onFocusChanged(({ payload: focused }) => {
      isWindowFocusedRef.current = focused;
      if (focused && activeSessionIdRef.current) {
        setGlowingSessionIds((prev) => markSessionRead(prev, activeSessionIdRef.current));
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => log(`Failed to register window focus listener: ${err}`));

    return () => {
      if (unlisten) unlisten();
    };
  }, [appWindow]);

  useEffect(() => {
    syncTaskbarUnreadBadge(getUnreadCompletionCount(glowingSessionIds), log);
  }, [glowingSessionIds]);

  useEffect(() => {
    return () => {
      syncTaskbarUnreadBadge(0, log);
    };
  }, []);

  // 💾 自动载入与保存持久化窗口窗体大小 (防抖 300ms 性能极致优化)
  useEffect(() => {
    const savedWidth = localStorage.getItem("agentdesk_window_width");
    const savedHeight = localStorage.getItem("agentdesk_window_height");
    const w = savedWidth ? parseInt(savedWidth, 10) : 1200;
    const h = savedHeight ? parseInt(savedHeight, 10) : 800;
    const clampedW = Math.max(1000, w);
    const clampedH = Math.max(750, h);

    appWindow.setSize(new LogicalSize(clampedW, clampedH))
      .then(() => {
        return appWindow.center();
      })
      .catch((err) => {
        log(`Failed to set window size and center on boot: ${err}`);
      });

    let resizeTimeout: any = null;
    const handleWindowResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const w = window.outerWidth;
        const h = window.outerHeight;
        if (w >= 1000 && h >= 750) {
          localStorage.setItem("agentdesk_window_width", String(w));
          localStorage.setItem("agentdesk_window_height", String(h));
        }
      }, 300);
    };
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, [appWindow]);

  // 点击任何地方关闭标签页右键菜单
  useEffect(() => {
    const closeTabMenu = () => setTabContextMenu(null);
    window.addEventListener("click", closeTabMenu);
    return () => window.removeEventListener("click", closeTabMenu);
  }, []);

  // 监听关闭标签页右键菜单的事件（由侧边栏触发）
  useEffect(() => {
    const handleCloseTabContextMenu = () => setTabContextMenu(null);
    window.addEventListener("close-tab-context-menu", handleCloseTabContextMenu);
    return () => window.removeEventListener("close-tab-context-menu", handleCloseTabContextMenu);
  }, []);

  // 🚫 全局彻底拦截并禁用系统默认右键菜单，彻底实现无菜单点击无反应
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener("contextmenu", handleGlobalContextMenu);
    return () => {
      window.removeEventListener("contextmenu", handleGlobalContextMenu);
    };
  }, []);

  // 💾 监听窗口关闭事件，根据设置执行对应行为 (每次询问 / 最小化托盘 / 直接退出)
  const [showCloseConfirmModal, setShowCloseConfirmModal] = useState<boolean>(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState<boolean>(false);

  useEffect(() => {
    let unlisten: any = null;
    const setupCloseListener = async () => {
      try {
        unlisten = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          const behavior = localStorage.getItem("agentdesk_setting_close_behavior") || "exit";
          log(`onCloseRequested event captured. Current behavior: ${behavior}`);
          
          if (behavior === "exit") {
            appWindow.destroy().catch((err) => log(`Failed to destroy window: ${err}`));
          } else if (behavior === "minimize") {
            appWindow.hide().catch((err) => log(`Failed to hide window: ${err}`));
          } else {
            // "ask" -> 每次询问，唤起前端 custom 退出确认弹窗
            setShowCloseConfirmModal(true);
          }
        });
        log("Window close requested listener registered successfully.");
      } catch (err) {
        log(`Failed to register onCloseRequested: ${err}`);
      }
    };
    setupCloseListener();
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [appWindow]);

  // 1. 初始化挂载时，从本地 SQLite 数据库载入历史会话，并还原上次活跃会话
  useEffect(() => {
    let claudeVersionTimer: number | null = null;
    let diagnosticsTimer: number | null = null;

    const scheduleDeferredDiagnostics = () => {
      diagnosticsTimer = window.setTimeout(() => {
        try {
          const persistedLogs = JSON.parse(localStorage.getItem("agentdesk_logs") || "[]");
          if (persistedLogs.length > 0) {
            console.group("=== KkCoder 历史崩溃/运行追踪日志 ===");
            persistedLogs.forEach((l: string) => console.log(l));
            console.groupEnd();
          }
        } catch (e) {}
      }, 2000);
    };

    const fetchClaudeVersion = () => {
      invoke<string>("get_claude_version")
        .then((ver) => {
          setClaudeVersion(ver);
          localStorage.setItem(CLAUDE_VERSION_CACHE_KEY, ver);
        })
        .catch(() => {});
    };

    const fetchCodexVersion = () => {
      invoke<string>("get_codex_version")
        .then((ver) => {
          // 兜底标准化：始终规范化为 "Codex <version>"，避免缓存残留 "codex-cli" 之类
          const normalized = normalizeCodexVersion(ver);
          setCodexVersion(normalized);
          localStorage.setItem(CODEX_VERSION_CACHE_KEY, normalized);
        })
        .catch(() => {});
    };

    const scheduleClaudeVersionFetch = () => {
      claudeVersionTimer = window.setTimeout(fetchClaudeVersion, 1500);
    };

    const scheduleCodexVersionFetch = () => {
      // 错开 500ms，避免同时请求
      window.setTimeout(fetchCodexVersion, 2000);
    };

    // 启动时清理空白会话（名为"新会话"且无对话内容）
    const emptyCleanupPromise = invoke<number>("cleanup_empty_sessions")
      .then((count) => {
        if (count > 0) log(`Startup empty session cleanup removed ${count} empty sessions.`);
      })
      .catch((err) => log(`Startup empty session cleanup failed: ${err}`));

    const cleanupSettings = readSessionCleanupSettings();
    const staleCleanupPromise = cleanupSettings.enabled
      ? invoke<number>("cleanup_stale_sessions", { days: cleanupSettings.days })
          .then((count) => {
            log(`Startup session cleanup moved ${count} stale sessions to trash.`);
          })
          .catch((err) => {
            log(`Startup session cleanup failed: ${err}`);
          })
      : Promise.resolve();

    log("App mounted. Fetching sessions from SQLite database...");
    Promise.all([emptyCleanupPromise, staleCleanupPromise]).then(() => invoke<Session[]>("get_sessions"))
      .then((data) => {
        log(`Successfully fetched ${data ? data.length : 0} sessions from database.`);
        setSessions(data || []);
        if (data && data.length > 0) {
          const lastActiveId = localStorage.getItem("agentdesk_last_active_session_id");
          const lastOpenTabsStr = localStorage.getItem("agentdesk_last_open_tab_ids");
          let lastOpenTabs: string[] = [];
          try {
            if (lastOpenTabsStr) lastOpenTabs = JSON.parse(lastOpenTabsStr);
          } catch (e) {}

          const validActiveId = data.some((s) => s.id === lastActiveId) ? lastActiveId : data[0].id;
          const validOpenTabs = lastOpenTabs.filter((tid) => data.some((s) => s.id === tid));

          if (validOpenTabs.length > 0) {
            log(`Found ${validOpenTabs.length} sessions from last time. Setting restore states...`);
            setPendingRestoreIds(validOpenTabs);
            if (validActiveId) {
              setPendingActiveId(validActiveId);
            }
            setShowRestoreToast(true);
          }
        }
        setIsInitLoaded(true);
        scheduleClaudeVersionFetch();
        scheduleCodexVersionFetch();
        scheduleDeferredDiagnostics();

        // 启动时自动修正会话名称（延迟执行，不阻塞 UI 加载）
        if (localStorage.getItem("agentdesk_setting_auto_rename_startup") === "true") {
          window.setTimeout(() => {
            triggerAutoRename("Startup");
          }, 3000);
        }
      })
      .catch((err) => {
        log(`Failed to fetch sessions from SQLite: ${err}`);
        console.error("加载 SQLite 本地会话数据失败", err);
        setIsInitLoaded(true);
        scheduleClaudeVersionFetch();
        scheduleCodexVersionFetch();
        scheduleDeferredDiagnostics();
      });

    return () => {
      if (claudeVersionTimer !== null) window.clearTimeout(claudeVersionTimer);
      if (diagnosticsTimer !== null) window.clearTimeout(diagnosticsTimer);
    };
  }, []);

  // 📱 监听远程 spawn 请求事件（手机端发起的新建/唤醒会话）
  useEffect(() => {
    const unlistenPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen("remote-spawn-request", async (event: any) => {
        const { session_id, directory, agent_type, agent_session_id, is_reopen } = event.payload;
        log(`[RemoteSpawn] Received spawn request: session=${session_id}, dir=${directory}, agent=${agent_type}, reopen=${is_reopen}, agent_session_id=${agent_session_id}`);

        try {
          const existing = sessions.find((s) => s.id === session_id);
          const hasAgentSessionId = agent_session_id && agent_session_id.length > 0;
          const finalAgentSessionId = hasAgentSessionId ? agent_session_id : generateUUID();

          if (existing) {
            // 会话已存在于前端列表
            if (!existing.agentSessionId && hasAgentSessionId) {
              await invoke("add_session", { session: { ...existing, agentSessionId: finalAgentSessionId } });
              setSessions((prev) => prev.map(s => s.id === session_id ? { ...s, agentSessionId: finalAgentSessionId } : s));
            }

            try {
              await invoke("spawn_terminal", {
                sessionId: session_id,
                directory: directory,
                agentType: agent_type || "claude",
                agentSessionId: finalAgentSessionId,
                isReopen: hasAgentSessionId && (is_reopen ?? true),
              });
            } catch (spawnErr) {
              const errStr = String(spawnErr);
              if (errStr.includes("already in use") || errStr.includes("already active")) {
                log(`[RemoteSpawn] Session ${session_id} already running, activating tab.`);
              } else {
                throw spawnErr;
              }
            }
          } else {
            // 新会话
            const folderName = directory.split(/[/\\]/).pop() || directory;
            const newSession: Session = {
              id: session_id,
              name: "新对话",
              path: directory,
              project: folderName,
              type: agent_type || "claude",
              agentSessionId: finalAgentSessionId,
              favorite: 0,
            };
            await invoke("add_session", { session: newSession });
            setSessions((prev) => [...prev, newSession]);

            await invoke("spawn_terminal", {
              sessionId: session_id,
              directory: directory,
              agentType: agent_type || "claude",
              agentSessionId: finalAgentSessionId,
              isReopen: false,
            });
          }

          // 打开并激活会话标签
          setOpenTabIds((prev) => prev.includes(session_id) ? prev : [...prev, session_id]);
          setActiveSessionId(session_id);
          log(`[RemoteSpawn] Successfully spawned session ${session_id}`);

          // 刷新会话列表
          invoke<Session[]>("get_sessions").then((updated) => {
            if (updated) setSessions(updated);
          }).catch(() => {});
        } catch (e) {
          log(`[RemoteSpawn] Failed to spawn session ${session_id}: ${e}`);
        }
      })
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [sessions]);

  // 📂 调用 Rust 后端，在资源管理器中打开项目物理文件夹路径
  const handleOpenFolder = async () => {
    if (!activeSession) return;
    try {
      log(`Opening folder in explorer: ${activeSession.path}`);
      await invoke("open_project_folder", { path: activeSession.path });
    } catch (err) {
      log(`Failed to open folder: ${err}`);
      alert(`无法打开文件夹: ${err}`);
    }
  };

  // 创建新会话终端，同步持久化到本地数据库
  const handleCreateSession = async (
    sessionName: string,
    projectPath: string,
    projectName: string
  ) => {
    log(`handleCreateSession triggered: name=${sessionName}, path=${projectPath}, project=${projectName}, agent=${selectedAgent}`);

    const newId = `session-${Date.now().toString()}`;
    // Claude: 预生成 UUID 通过 --session-id 精确恢复；Codex: 留空，发消息后反查绑定
    const agentSessionId = selectedAgent === "claude" ? generateUUID() : "";
    log(`Generated new session UUIDs: id=${newId}, agentSessionId=${agentSessionId}, agent=${selectedAgent}`);
    
    const newSession: Session = {
      id: newId,
      name: sessionName,
      project: projectName,
      path: projectPath,
      type: selectedAgent,
      agentSessionId,
      favorite: 0, // 初始默认为未收藏
      createdAt: new Date().toISOString(),
    };

    log(`Invoking add_session to SQLite...`);
    // 存储入本地 SQLite 数据库中
    invoke("add_session", { session: newSession })
      .then(() => {
        log(`Successfully added session ${newId} to SQLite. Updating React states...`);
        setSessions((prev) => {
          log(`Adding ${newId} to sessions list (previous size: ${prev.length})`);
          return [...prev, newSession];
        });
        setNewSessionIds((prev) => {
          log(`Adding ${newId} to newSessionIds (previous size: ${prev.length})`);
          return [...prev, newId];
        });
        setOpenTabIds((prev) => {
          log(`Adding ${newId} to openTabIds (previous size: ${prev.length})`);
          return [...prev, newId];
        });
        log(`Setting activeSessionId to ${newId}`);
        setActiveSessionId(newId);
        log(`handleCreateSession state updates finished.`);
      })
      .catch((err) => {
        log(`Failed to save session ${newId} to SQLite: ${err}`);
        alert(`保存会话失败: ${err}`);
      });
  };

  // 直接创建会话（跳过模态框）
  const handleCreateSessionDirectly = (projectPath: string) => {
    const cleanPath = projectPath.replace(/[\\/]+$/, "");
    const parts = cleanPath.split(/[\\/]/);
    const projectName = parts[parts.length - 1] || "新项目";
    const sessionTitle = "新会话";
    
    log(`handleCreateSessionDirectly triggered: path=${cleanPath}, project=${projectName}`);
    handleCreateSession(sessionTitle, cleanPath, projectName);
  };

  // 新建无痕临时终端
  const handleCreateTempSession = () => {
    const tempNumbers = sessions
      .filter((s) => s.isTemp)
      .map((s) => {
        const match = s.name.match(/临时终端(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      });
    const nextNumber = tempNumbers.length > 0 ? Math.max(...tempNumbers) + 1 : 1;
    const sessionName = `临时终端${nextNumber}`;

    const newId = `temp-session-${Date.now().toString()}`;
    // Claude: 预生成 UUID；Codex: 留空，发消息后反查绑定
    const agentSessionId = selectedAgent === "claude" ? generateUUID() : "";
    
    const newSession: Session = {
      id: newId,
      name: sessionName,
      project: "无痕临时项目",
      path: "D:\\CODE",
      type: selectedAgent,
      agentSessionId,
      favorite: 0,
      isTemp: true,
    };

    log(`Creating incognito temporary terminal: id=${newId}, name=${sessionName}`);
    
    // 直接更新内存中的状态，不用保存到 SQLite 中
    setSessions((prev) => [...prev, newSession]);
    setNewSessionIds((prev) => [...prev, newId]);
    setOpenTabIds((prev) => [...prev, newId]);
    setActiveSessionId(newId);
  };

  // 选择会话切换 (侧边栏点击逻辑)
  const handleSelectSession = (id: string) => {
    if (!openTabIds.includes(id)) {
      setOpenTabIds((prev) => [...prev, id]);
    }
    setActiveSessionId(id);
    // 联动切换左侧 agent 选中态，确保当前会话所属 agent 在侧边栏可见
    const s = sessions.find((sess) => sess.id === id);
    if (s) {
      setSelectedAgent(s.type);
    }
    // 点击任意会话标签时自动关闭恢复提示
    setShowRestoreToast(false);
    setShowRestoreModal(false);
  };

  // 恢复会话相关处理逻辑
  const handleRestoreSingle = (sid: string) => {
    setOpenTabIds((prev) => {
      if (prev.includes(sid)) return prev;
      return [...prev, sid];
    });
    setActiveSessionId(sid);

    const s = sessions.find((sess) => sess.id === sid);
    if (s) {
      setSelectedAgent(s.type);
    }

    const remaining = pendingRestoreIds.filter((id) => id !== sid);
    setPendingRestoreIds(remaining);

    if (remaining.length === 0) {
      setShowRestoreModal(false);
      setShowRestoreToast(false);
    }
  };

  const handleRestoreAll = () => {
    setOpenTabIds((prev) => {
      const combined = [...prev];
      pendingRestoreIds.forEach((id) => {
        if (!combined.includes(id)) {
          combined.push(id);
        }
      });
      return combined;
    });

    if (pendingRestoreIds.length > 0) {
      const nextActiveId = pendingRestoreIds.includes(pendingActiveId)
        ? pendingActiveId
        : pendingRestoreIds[pendingRestoreIds.length - 1];
      setActiveSessionId(nextActiveId);

      const s = sessions.find((sess) => sess.id === nextActiveId);
      if (s) {
        setSelectedAgent(s.type);
      }
    }

    setPendingRestoreIds([]);
    setShowRestoreModal(false);
    setShowRestoreToast(false);
  };

  const handleRestoreIgnore = () => {
    setPendingRestoreIds([]);
    setShowRestoreModal(false);
    setShowRestoreToast(false);
  };

  const handleCommandComplete = (sid: string) => {
    setGlowingSessionIds((prev) =>
      addUnreadCompletion(
        prev,
        sid,
        activeSessionIdRef.current,
        isWindowFocusedRef.current
      )
    );
  };

  // 点击页面任意位置或按 ESC 关闭调色盘菜单
  useEffect(() => {
    const closeThemeMenu = () => setShowThemeDropdown(false);
    window.addEventListener("mousedown", closeThemeMenu);
    return () => window.removeEventListener("mousedown", closeThemeMenu);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowThemeDropdown(false);
      }
    };
    if (showThemeDropdown) {
      window.addEventListener("keydown", handleKeyDown, true);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [showThemeDropdown]);

  // 全局快捷键 Ctrl+Shift+H 打开当前激活会话的历史面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.shiftKey && e.key.toLowerCase() === "h") {
        if (historyPanelOpen) {
          setHistoryPanelOpen(false);
        } else if (activeSessionId) {
          openHistoryPanel(activeSessionId);
        }
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeSessionId, historyPanelOpen, openHistoryPanel]);

  // 监听主题发生变动的全局广播事件
  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      setCurrentTheme(customEvent.detail);
    };
    window.addEventListener("kkcoder-theme-change", handleThemeEvent);
    return () => window.removeEventListener("kkcoder-theme-change", handleThemeEvent);
  }, []);

  const handleSelectTheme = (newTheme: string) => {
    setCurrentTheme(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    applyTheme(newTheme);
    window.dispatchEvent(new CustomEvent("kkcoder-theme-change", { detail: newTheme }));
  };

  // 💾 保存标签页的行内重命名并同步数据库
  const handleSaveTabRename = (id: string) => {
    if (renamingTabText.trim()) {
      handleRenameSession(id, renamingTabText.trim());
    }
    setRenamingTabId(null);
  };

  // 🎯 在左侧边栏中定位特定会话，确保 Agent 选卡匹配并触发闪烁提醒
  const handleLocateSession = (sessionId: string) => {
    const s = sessions.find((sess) => sess.id === sessionId);
    if (s) {
      setSelectedAgent(s.type);
      setHighlightSessionId(sessionId);
      log(`Locating session ${sessionId} in sidebar. Selected agent type: ${s.type}`);
    }
  };

  // 关闭 Tab 标签
  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    log(`handleCloseTab triggered: id=${id}`);
    
    // 销毁后端 PTY 进程，彻底避免垃圾僵尸进程积累
    invoke("close_terminal", { sessionId: id }).catch((err) => {
      log(`Failed to close terminal PTY process for ${id}: ${err}`);
    });

    // 清除该会话的busy状态，让侧边栏显示绿点
    setSessionBusy(prev => ({ ...prev, [id]: false }));

    const closedSession = sessions.find((s) => s.id === id);
    if (closedSession?.isTemp) {
      setSessions((prev) => prev.filter((s) => s.id !== id));
    }

    const updatedTabs = openTabIds.filter((tid) => tid !== id);
    setOpenTabIds(updatedTabs);

    // 从 newSessionIds 中移去该 ID，确保任何后续重新打开均被正确判定为 PTY Reopen 且执行 /resume
    setNewSessionIds((prev) => prev.filter((nid) => nid !== id));

    if (activeSessionId === id) {
      if (updatedTabs.length > 0) {
        activateSession(updatedTabs[updatedTabs.length - 1]);
      } else {
        setActiveSessionId("");
      }
    }
  };

  // 🗑️ 从本地 SQLite 数据库中软删除该会话记录，移入回收站
  const handleDeleteSession = async (e: React.MouseEvent | null, id: string) => {
    if (e) e.stopPropagation();
    try {
      // 销毁后端 PTY 进程
      invoke("close_terminal", { sessionId: id }).catch(() => {});
      await invoke("delete_session", { id });
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, deleted: 1, deletedAt: new Date().toISOString() } : s));
      setOpenTabIds((prev) => prev.filter((tid) => tid !== id));
      if (activeSessionId === id) {
        const remaining = openTabIds.filter((tid) => tid !== id);
        if (remaining.length > 0) {
          activateSession(remaining[remaining.length - 1]);
        } else {
          setActiveSessionId("");
        }
      }
    } catch (err) {
      alert(`删除会话失败: ${err}`);
    }
  };

  // ⟲ 从回收站中恢复该会话记录
  const handleRestoreSession = async (id: string) => {
    try {
      await invoke("restore_session", { id });
      setSessions((prev) => prev.map((s) => s.id === id ? { ...s, deleted: 0, deletedAt: undefined } : s));
    } catch (err) {
      alert(`恢复会话失败: ${err}`);
    }
  };

  // 🗑️ 物理彻底删除该会话
  const handlePermanentlyDeleteSession = async (id: string) => {
    try {
      await invoke("delete_session_permanently", { id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      localStorage.removeItem(`agentdesk_session_has_dialogue_${id}`);
    } catch (err) {
      alert(`彻底删除会话失败: ${err}`);
    }
  };

  // 🗑️ 清空回收站
  const handleEmptyTrash = async () => {
    try {
      sessions.forEach((s) => {
        if (s.deleted === 1) {
          localStorage.removeItem(`agentdesk_session_has_dialogue_${s.id}`);
        }
      });
      await invoke("empty_trash");
      setSessions((prev) => prev.filter((s) => s.deleted !== 1));
    } catch (err) {
      alert(`清空垃圾桶失败: ${err}`);
    }
  };

  // 🗑️ 批量从 SQLite 数据库与 React 状态中删除会话记录
  const handleDeleteSessionsBatch = async (ids: string[]) => {
    log(`handleDeleteSessionsBatch triggered: ids=[${ids.join(", ")}]`);
    try {
      await Promise.all(ids.map((id) => invoke("delete_session", { id })));
      ids.forEach((id) => localStorage.removeItem(`agentdesk_session_has_dialogue_${id}`));
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
      setOpenTabIds((prev) => prev.filter((tid) => !ids.includes(tid)));
      if (ids.includes(activeSessionId)) {
        const remaining = openTabIds.filter((tid) => !ids.includes(tid));
        if (remaining.length > 0) {
          activateSession(remaining[remaining.length - 1]);
        } else {
          setActiveSessionId("");
        }
      }
      log(`Successfully batch deleted ${ids.length} sessions.`);
    } catch (err) {
      log(`Failed to batch delete sessions: ${err}`);
      alert(`批量删除会话失败: ${err}`);
    }
  };

  // ✏️ 重命名会话，同步写入 SQLite 并更新 React 状态
  const handleRenameSession = async (id: string, newName: string) => {
    log(`handleRenameSession triggered: id=${id}, newName=${newName}`);
    try {
      await invoke("rename_session", { id, newName });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, name: newName } : s))
      );
      log(`Successfully renamed session ${id} to ${newName}`);
    } catch (err) {
      log(`Failed to rename session ${id}: ${err}`);
      alert(`重命名失败: ${err}`);
    }
  };

  // ⭐ Codex session 绑定：更新本地 SQLite 已完成后，同步 React 状态
  const handleSessionBound = (id: string, agentSessionId: string) => {
    log(`handleSessionBound: id=${id}, agentSessionId=${agentSessionId}`);
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, agentSessionId } : s))
    );
    // 关键：从 newSessionIds 中移除，确保下次 reopen 能被 shouldResumeSession 判定为恢复
    setNewSessionIds((prev) => prev.filter((nid) => nid !== id));
  };

  // ⭐ 切换会话收藏状态，同步写入 SQLite 并更新 React 状态
  const handleToggleFavorite = async (id: string, isFavorite: boolean) => {
    const favoriteVal = isFavorite ? 1 : 0;
    log(`handleToggleFavorite triggered: id=${id}, favorite=${favoriteVal}`);
    try {
      await invoke("toggle_favorite", { id, favorite: favoriteVal });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, favorite: favoriteVal } : s))
      );
      log(`Successfully toggled favorite for session ${id} to ${favoriteVal}`);
    } catch (err) {
      log(`Failed to toggle favorite for session ${id}: ${err}`);
      alert(`操作收藏失败: ${err}`);
    }
  };

  // 🖱️ 鼠标滚轮滚动标签栏交互：滚轮向下就是往右滚，往上就是往左滚
  const handleTabWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.currentTarget) {
      e.currentTarget.scrollLeft += e.deltaY;
    }
  };

  // 🖱️ 标签页拖拽调整顺序
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index.toString());
    // 使用 setTimeout 异步设置状态，确保浏览器先生成拖拽影像，防止同步 DOM 节点样式修改导致拖拽被取消
    setTimeout(() => {
      setDraggingIndex(index);
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (draggingIndex !== null && draggingIndex !== targetIndex) {
      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const clientX = e.clientX;

      if (draggingIndex > targetIndex) {
        // 从右向左拖拽（目标在左侧）
        if (clientX < midpoint) {
          const listCopy = [...openTabIds];
          const draggedItem = listCopy[draggingIndex];
          listCopy.splice(draggingIndex, 1);
          listCopy.splice(targetIndex, 0, draggedItem);
          setDraggingIndex(targetIndex);
          setOpenTabIds(listCopy);
        }
      } else {
        // 从左向右拖拽（目标在右侧）
        if (clientX > midpoint) {
          const listCopy = [...openTabIds];
          const draggedItem = listCopy[draggingIndex];
          listCopy.splice(draggingIndex, 1);
          listCopy.splice(targetIndex, 0, draggedItem);
          setDraggingIndex(targetIndex);
          setOpenTabIds(listCopy);
        }
      }
    }
  };

  const handleDragEnd = () => {
    setDraggingIndex(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleTitlebarMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      if (e.detail === 2) {
        appWindow.toggleMaximize().catch((err) => log(`Failed to toggle maximize: ${err}`));
      } else {
        appWindow.startDragging().catch((err) => log(`Failed to start window dragging: ${err}`));
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 极简无边框窗口自定义标题栏 */}
      <div
        className="custom-titlebar"
        onMouseDown={handleTitlebarMouseDown}
      >
        <div className="titlebar-logo">
          {/* 窗口左上角徽标：与 exe / 任务栏图标一致的 icon.ico 图案 */}
          <img
            className="titlebar-logo-icon"
            src={agentdeskIcon}
            alt=""
            draggable={false}
          />
          <span className="logo-title-text">AgentDesk 极简 AI 终端管理器</span>
        </div>

        <div className="titlebar-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="titlebar-btn ccswitch-btn"
            onClick={handleLaunchCcswitch}
            title="打开 CCSwitch"
          >
            <svg width="14" height="14" viewBox="0 0 1045 1008" fill="none">
              <path d="M 345.075 43.729 C 341.282 44.442, 321.592 51.658, 316.888 54.057 C 310.336 57.400, 302.349 66.041, 298.709 73.726 C 295.697 80.084, 295.501 81.175, 295.517 91.500 L 295.534 102.500 319.869 166 C 341.766 223.138, 350.381 245.666, 371.643 301.375 C 375.185 310.656, 377.858 318.475, 377.583 318.750 C 376.960 319.374, 380.148 321.725, 275.011 243.099 C 226.893 207.114, 185.151 176.585, 182.251 175.258 C 170.665 169.953, 153.294 171.577, 142.258 178.995 C 135.192 183.745, 117.129 205.160, 112.733 214 C 109.653 220.192, 109.500 221.045, 109.500 232 C 109.500 243.394, 109.535 243.565, 113.285 250.582 C 115.367 254.476, 118.742 259.248, 120.785 261.185 C 122.828 263.121, 162.525 293.266, 209 328.173 C 255.475 363.079, 301.825 397.934, 312 405.627 C 322.175 413.320, 331.377 419.946, 332.449 420.352 C 333.522 420.758, 341.172 421.508, 349.449 422.019 C 357.727 422.529, 370.800 423.395, 378.500 423.944 C 404.185 425.772, 433.342 427.913, 448.500 429.084 C 456.750 429.721, 464.850 430.076, 466.500 429.872 L 469.500 429.500 476.609 401 C 480.519 385.325, 485.858 363.710, 488.473 352.967 L 493.228 333.434 489.183 322.967 C 484.941 311.993, 479.011 296.410, 453.997 230.500 C 439.552 192.439, 418.186 136.238, 400.772 90.500 C 389.456 60.780, 387.751 57.796, 378.143 50.916 C 369.130 44.462, 356.160 41.643, 345.075 43.729 M 397.547 624.995 C 376.896 638.743, 360 650.397, 360 650.893 C 360 651.827, 343.905 674.147, 279.880 762 C 259.237 790.325, 240.053 816.650, 237.247 820.500 C 229.509 831.121, 227.601 836.583, 227.645 848 C 227.710 864.838, 232.437 872.956, 249.755 885.965 C 262.196 895.311, 268.537 898.076, 279.085 898.752 C 291.041 899.518, 301.993 895.565, 310.319 887.478 C 312.299 885.555, 321.658 873.299, 331.116 860.241 C 340.574 847.183, 353.570 829.300, 359.996 820.500 C 366.421 811.700, 376.551 797.750, 382.507 789.500 C 397.539 768.676, 409.845 751.837, 411.596 749.696 C 413.135 747.816, 413.848 744.768, 417.021 726.500 C 418.072 720.450, 419.856 710.325, 420.986 704 C 422.116 697.675, 424.165 685.975, 425.539 678 C 426.913 670.025, 428.479 661.138, 429.019 658.250 C 430.112 652.400, 430.903 647.991, 433.996 630.500 C 435.163 623.900, 436.767 615.003, 437.559 610.730 C 439.417 600.711, 439.383 600, 437.047 600 C 435.972 600, 418.197 611.248, 397.547 624.995" stroke="none" fill="#60a6a2" fill-rule="evenodd"></path><path d="M 588.746 43.022 C 578.071 45.718, 566.370 54.961, 561.535 64.519 C 558.940 69.648, 525.455 201.527, 492.985 334.500 C 487.882 355.400, 480.510 385.325, 476.603 401 L 469.500 429.500 466.500 429.872 C 464.850 430.076, 456.750 429.721, 448.500 429.084 C 409.057 426.037, 346.946 421.638, 320.500 420.020 C 311.700 419.482, 302.700 418.800, 300.500 418.506 C 298.300 418.211, 286.150 417.305, 273.500 416.492 C 260.850 415.678, 244.200 414.550, 236.500 413.983 C 228.800 413.417, 216.082 412.519, 208.239 411.987 C 189.119 410.692, 154.503 408.233, 138.500 407.034 C 83.231 402.892, 81.588 402.923, 70.714 408.297 C 52.679 417.210, 45.356 434.747, 46.199 467 C 46.464 477.119, 46.833 479.212, 49.277 484.430 C 54.573 495.739, 63.133 503.557, 74.516 507.479 C 79.504 509.198, 95.040 510.841, 126 512.923 C 135.075 513.533, 148.350 514.480, 155.500 515.027 C 162.650 515.574, 184.475 517.165, 204 518.562 C 223.525 519.960, 245.350 521.533, 252.500 522.057 C 273.007 523.562, 290.762 524.823, 314.500 526.458 C 348.247 528.783, 353.018 529.220, 353.518 530.030 C 353.773 530.442, 343.974 537.498, 331.741 545.710 C 304.438 564.038, 163.002 659.271, 146.584 670.382 C 132.538 679.888, 127.223 686.164, 123.869 697.207 C 121.458 705.142, 121.612 716.357, 124.231 723.695 C 126.868 731.084, 136.351 747.205, 141.161 752.477 C 152.067 764.430, 169.282 768.937, 185.226 764.012 C 192.217 761.853, 191.739 762.164, 351.290 655.838 C 397.375 625.127, 435.962 600, 437.040 600 C 439.383 600, 439.418 600.707, 437.559 610.730 C 436.767 615.003, 435.163 623.900, 433.996 630.500 C 430.903 647.991, 430.112 652.400, 429.019 658.250 C 428.479 661.138, 426.913 670.025, 425.539 678 C 424.165 685.975, 422.116 697.675, 420.986 704 C 419.856 710.325, 418.071 720.450, 417.019 726.500 C 414.891 738.729, 411.301 758.545, 407.506 779 C 406.129 786.425, 403.895 799.025, 402.543 807 C 401.191 814.975, 397.856 833.875, 395.132 849 C 392.408 864.125, 389.629 879.695, 388.957 883.600 C 388.284 887.505, 387.935 894.549, 388.182 899.254 C 388.770 910.457, 392.441 918.255, 400.946 926.367 C 408.355 933.434, 414.597 936.358, 427.848 938.970 C 440.729 941.509, 447.123 941.529, 455.073 939.054 C 466.337 935.549, 475.068 928.001, 480.600 916.988 C 483.387 911.440, 483.510 910.830, 497.009 835.500 C 502.035 807.450, 507.022 780.225, 508.090 775 C 509.159 769.775, 510.265 763.925, 510.549 762 C 511.518 755.425, 514.875 736.517, 519.516 711.500 C 522.067 697.750, 525.433 679.075, 526.998 670 C 535.984 617.866, 539.840 598, 540.973 598 C 541.986 598, 548.512 605.629, 561.075 621.500 C 575.687 639.959, 577 641.715, 577 642.787 C 577 643.336, 577.643 644.033, 578.429 644.334 C 579.214 644.636, 615.895 690.021, 659.941 745.191 C 703.988 800.361, 742.518 848.299, 745.564 851.720 C 758.399 866.138, 778.039 869.968, 795.159 861.392 C 800.487 858.723, 815.709 846.725, 819.253 842.401 C 825.868 834.330, 829.022 825.284, 828.958 814.568 C 828.882 802.012, 825.830 794.486, 815.546 781.500 C 807.752 771.658, 791.980 751.768, 775.899 731.500 C 766.299 719.400, 755.091 705.225, 750.993 700 C 746.894 694.775, 735.862 680.825, 726.477 669 C 717.092 657.175, 702.008 638.107, 692.957 626.627 C 683.905 615.147, 671.623 599.622, 665.663 592.127 C 644.113 565.029, 642.043 561.976, 645.250 562.015 C 647.789 562.046, 667.126 565.721, 721.500 576.505 C 730.850 578.359, 743.675 580.840, 750 582.018 C 756.325 583.196, 768.025 585.450, 776 587.026 C 783.975 588.603, 804.225 592.586, 821 595.878 C 837.775 599.170, 869.050 605.315, 890.500 609.534 C 936.125 618.506, 940.491 618.765, 952.141 613.184 C 969.380 604.925, 975.928 593.145, 981.049 561.177 C 984.341 540.624, 969.905 518.762, 949.628 513.594 C 946.257 512.735, 928.200 509.081, 909.500 505.474 C 890.800 501.867, 864.250 496.662, 850.500 493.906 C 836.750 491.150, 819.425 487.784, 812 486.426 C 804.575 485.068, 797.184 483.512, 795.576 482.970 C 793.968 482.427, 789.693 481.525, 786.076 480.966 C 778.943 479.862, 751.942 474.731, 712.500 466.984 C 698.750 464.283, 680.525 460.721, 672 459.068 C 663.475 457.415, 638.950 452.613, 617.500 448.397 C 596.050 444.181, 577.227 440.510, 575.671 440.240 C 572.047 439.612, 571.422 437.847, 572.798 432.122 C 576.587 416.355, 606.724 294.782, 610.013 282 C 612.206 273.475, 616.227 257.500, 618.948 246.500 C 621.669 235.500, 631.344 196.837, 640.448 160.583 C 652.913 110.941, 657 93.148, 657 88.515 C 657 74.625, 649.817 61.056, 638.482 53.532 C 627.309 46.116, 599.645 40.270, 588.746 43.022" stroke="none" fill="#e78b52" fill-rule="evenodd"></path><path d="M 784.734 136.022 C 780.393 137.121, 773.819 140.334, 769.736 143.353 C 768.183 144.502, 744.319 168.629, 716.706 196.970 C 648.388 267.087, 624.395 291.647, 612.271 303.874 L 601.985 314.248 587.951 370.874 C 580.232 402.018, 573.415 429.580, 572.802 432.122 C 571.422 437.846, 572.046 439.612, 575.671 440.240 C 577.227 440.510, 596.050 444.181, 617.500 448.397 C 638.950 452.613, 663.475 457.415, 672 459.068 C 680.525 460.721, 698.750 464.283, 712.500 466.984 C 748.223 474.001, 778.827 479.853, 783.657 480.591 C 786.723 481.059, 789.874 480.558, 795.657 478.681 C 799.971 477.282, 812.050 473.802, 822.500 470.949 C 832.950 468.095, 843.750 465.105, 846.500 464.303 C 852.424 462.576, 864.873 459.253, 870.500 457.898 C 882.919 454.906, 929.440 441.441, 934.725 439.308 C 950.039 433.128, 960 418.081, 960 401.127 C 960 394.810, 959.172 390.569, 955.643 378.810 C 950.268 360.898, 947.892 356.048, 941.872 350.696 C 930.316 340.422, 924.857 338.001, 913.239 337.999 C 904.582 337.998, 909.466 336.745, 819.500 362.047 C 784.906 371.776, 759.790 378.828, 739.636 384.468 C 726.511 388.142, 713.686 391.765, 711.136 392.519 C 708.586 393.273, 702.769 394.842, 698.210 396.005 C 693.650 397.168, 687.125 399.166, 683.710 400.444 C 676.085 403.297, 667 404.704, 667 403.032 C 667 402.397, 677.237 391.214, 689.750 378.182 C 702.263 365.150, 723.291 343.015, 736.481 328.994 C 749.670 314.972, 767.245 296.525, 775.535 288 C 783.826 279.475, 795.301 267.550, 801.035 261.500 C 806.770 255.450, 817.146 244.650, 824.094 237.500 C 844.492 216.510, 846.768 213.567, 850.032 203.960 C 851.843 198.632, 852.131 196.098, 851.678 189.500 C 850.764 176.198, 848.247 171.220, 836.127 158.748 C 823.618 145.875, 817.335 140.879, 810.054 138.016 C 803.846 135.575, 790.614 134.533, 784.734 136.022 M 644 563.161 C 644 564.450, 649.491 571.792, 665.663 592.127 C 671.623 599.622, 683.905 615.147, 692.957 626.627 C 702.008 638.107, 717.092 657.175, 726.477 669 C 735.862 680.825, 746.894 694.775, 750.993 700 C 755.091 705.225, 766.299 719.400, 775.899 731.500 C 791.980 751.768, 807.752 771.658, 815.546 781.500 C 817.288 783.700, 820.368 788.089, 822.390 791.254 C 825.496 796.115, 827.188 797.588, 833.283 800.741 C 840.393 804.418, 840.671 804.473, 852 804.466 C 861.566 804.460, 864.109 804.126, 867.119 802.480 C 869.110 801.391, 872.534 799.511, 874.728 798.302 C 878.914 795.995, 888.863 785.802, 895.706 776.808 C 905.597 763.808, 907.996 749.653, 902.587 736.215 C 897.807 724.343, 900.699 726.864, 834.500 676.854 C 819.100 665.220, 790.975 644.066, 772 629.846 C 753.025 615.625, 734 601.180, 729.722 597.745 C 725.444 594.310, 719.317 589.700, 716.107 587.500 C 709.169 582.745, 701.183 576.403, 698.758 573.723 C 697.017 571.799, 685.036 568.993, 657.297 564.012 C 644.188 561.658, 644 561.646, 644 563.161 M 539.053 603.250 C 537.680 609.859, 530.749 648.238, 526.998 670 C 525.433 679.075, 522.065 697.750, 519.513 711.500 C 511.840 752.833, 510.184 763.308, 511.063 764.954 C 511.517 765.804, 512.763 769.425, 513.831 773 C 515.687 779.207, 516.341 781.834, 519.436 795.500 C 520.184 798.800, 522.218 806.900, 523.957 813.500 C 527.414 826.619, 536.216 860.671, 544.606 893.379 C 551.891 921.780, 556.029 928.381, 571.309 935.974 C 578.791 939.692, 580.040 940, 587.634 940 C 596.648 940, 610.689 936.779, 618.829 932.844 C 625.847 929.451, 632.437 922.254, 636.718 913.306 C 640.211 906.004, 640.454 904.887, 640.476 896 C 640.498 887.294, 639.856 884.076, 632.801 857.500 C 622.676 819.365, 621.481 814.839, 617.490 799.500 C 615.630 792.350, 612.480 780.425, 610.490 773 C 608.501 765.575, 604.419 749.934, 601.419 738.243 C 598.419 726.551, 594.659 712.956, 593.063 708.031 C 591.467 703.106, 589.634 696.472, 588.991 693.288 C 587.007 683.475, 583.757 670.651, 582.454 667.500 C 580.359 662.434, 578.213 653.799, 577.488 647.516 C 576.735 640.993, 577.639 642.426, 561.075 621.500 C 548.512 605.629, 541.986 598, 540.973 598 C 540.517 598, 539.653 600.362, 539.053 603.250" stroke="none" fill="#f9b53c" fill-rule="evenodd"></path>
            </svg>
          </button>
          <div className="theme-selector-wrapper">
            <button
              className={`titlebar-btn theme-palette-btn ${showThemeDropdown ? "active" : ""}`}
              onMouseDown={(e) => {
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                setShowThemeDropdown(!showThemeDropdown);
              }}
              title="选择颜色主题"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22C17.52 22 22 17.52 22 12S17.52 2 12 2 2 6.48 2 12c0 2.2 1.8 4 4 4h1a2 2 0 0 1 2 2v2c0 1.1.9 2 2 2z"></path>
                <circle cx="7.5" cy="10.5" r="1.5" fill="currentColor"></circle>
                <circle cx="11.5" cy="7.5" r="1.5" fill="currentColor"></circle>
                <circle cx="16.5" cy="9.5" r="1.5" fill="currentColor"></circle>
                <circle cx="15.5" cy="14.5" r="1.5" fill="currentColor"></circle>
              </svg>
            </button>
            {showThemeDropdown && (
              <div
                className="theme-dropdown"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {(["dark", "light"] as const).map((group) => (
                  <div className="theme-dropdown-section" key={group}>
                    <div className="theme-dropdown-section-title">{group === "dark" ? "深色" : "浅色"}</div>
                    {THEME_DEFINITIONS.filter((t) => t.group === group).map((t) => (
                      <div
                        key={t.id}
                        className={`theme-dropdown-item ${currentTheme === t.id ? "active" : ""}`}
                        onClick={() => handleSelectTheme(t.id)}
                      >
                        <span className="theme-preview-dots">
                          <span
                            className="theme-dot"
                            style={{
                              backgroundColor: t.preview.bg,
                              ...(t.group === "light" ? { border: `1px solid ${t.preview.border || "#e2e8f0"}` } : {}),
                            }}
                          ></span>
                          <span className="theme-dot" style={{ backgroundColor: t.preview.accent }}></span>
                        </span>
                        <span className="theme-name">{t.name}</span>
                      </div>
                    ))}
                  </div>
                ))}

                <div className="theme-dropdown-divider"></div>

                <div
                  className={`theme-dropdown-item ${currentTheme === "auto" ? "active" : ""}`}
                  onClick={() => handleSelectTheme("auto")}
                >
                  <span className="theme-preview-dots">
                    <span className="theme-dot theme-dot-split"></span>
                  </span>
                  <span className="theme-name">跟随系统</span>
                </div>
              </div>
            )}
          </div>

          {!activeSession?.isTemp && (
            <button
              className={`titlebar-btn toggle-project-tree-btn ${showProjectTree ? "active" : ""}`}
              onClick={() => {
                updateProjectTreeVisibility(!showProjectTree);
              }}
              title={showProjectTree ? "关闭工作区面板" : "打开工作区面板"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="3" x2="16" y2="21"></line>
              </svg>
            </button>
          )}

          <button
            className="titlebar-btn settings-gear-btn"
            onClick={() => setShowSettings(true)}
            title="打开设置"
          >

            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button
            className="titlebar-btn minimize-btn"
            onClick={handleMinimize}
            title="最小化"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button
            className="titlebar-btn maximize-btn"
            onClick={handleMaximize}
            title="最大化"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            </svg>
          </button>
          <button
            className="titlebar-btn close-btn"
            onClick={handleClose}
            title="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* 主布局 */}
      <div className="app-container">
        {/* 左边栏 - 专注于会话与项目管理 */}
        <Sidebar
          selectedAgent={selectedAgent}
          onSelectAgent={setSelectedAgent}
          onOpenNewSession={(path) => {
            setPrefilledProjectPath(path);
            setShowModal(true);
          }}
          onCreateSessionDirectly={handleCreateSessionDirectly}
          onOpenTempSession={handleCreateTempSession}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          openTabIds={openTabIds}
          onRenameSession={handleRenameSession}
          onToggleFavorite={handleToggleFavorite}
          highlightSessionId={highlightSessionId}
          onHighlightEnd={() => setHighlightSessionId(null)}
          onDeleteSessionsBatch={handleDeleteSessionsBatch}
          glowingSessionIds={glowingSessionIds}
          onRestoreSession={handleRestoreSession}
          onPermanentlyDeleteSession={handlePermanentlyDeleteSession}
          onEmptyTrash={handleEmptyTrash}
          width={sidebarWidth}
          sessionBusy={sessionBusy}
        />
        <div className={`sidebar-resizer ${isResizing ? "dragging" : ""}`} onMouseDown={startResize} />

        {/* 右侧主工作区 */}
        <main
          className={`main-workspace ${isDragOverWorkspace ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!isDragOverWorkspace) setIsDragOverWorkspace(true);
          }}
          onDragLeave={(e) => {
            // 只在真正离开 main 区域时清除（忽略子元素冒泡）
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
              setIsDragOverWorkspace(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOverWorkspace(false);
            const text = e.dataTransfer.getData("text/plain");
            if (text) {
              handleInsertPathToSession(activeSessionId, text);
            }
          }}
        >
          {/* 顶部 Tab 标签栏 */}
          <div className="tab-bar">
            <div className="tab-list" onWheel={handleTabWheel}>
              {openTabIds.map((tid, index) => {
                const s = sessions.find((sess) => sess.id === tid);
                if (!s) return null;
                const isActive = activeSessionId === tid;
                const isRenaming = renamingTabId === s.id;
                const isGlowing = glowingSessionIds.includes(s.id);

                return (
                  <div
                    key={s.id}
                    data-id={s.id}
                    className={`tab ${isActive ? "active" : ""} ${
                      isActive && s.type === "codex" ? "codex-tab" : ""
                    } ${isGlowing ? (s.type === "codex" ? "glowing-codex" : "glowing-claude") : ""} ${
                      draggingIndex === index ? "dragging" : ""
                    }`}
                    draggable={!isRenaming}
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDragEnd={handleDragEnd}
                    onDrop={handleDrop}
                    onClick={() => {
                      setActiveSessionId(s.id);
                      setGlowingSessionIds((prev) => prev.filter((id) => id !== s.id));
                      // 联动切换左侧 agent 选中态
                      setSelectedAgent(s.type);
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        const ev = { stopPropagation: () => {} } as React.MouseEvent;
                        handleCloseTab(ev, s.id);
                      }
                    }}
                    onMouseEnter={(e) => handleTabMouseEnter(e, s)}
                    onMouseLeave={handleTabMouseLeave}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTabContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        sessionId: s.id,
                      });
                      // 触发事件关闭侧边栏右键菜单
                      window.dispatchEvent(new CustomEvent("close-sidebar-context-menu"));
                    }}
                  >
                    {isRenaming ? (
                      <input
                        type="text"
                        className="tab-rename-input"
                        value={renamingTabText}
                        onChange={(e) => setRenamingTabText(e.target.value)}
                        onBlur={() => handleSaveTabRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveTabRename(s.id);
                          else if (e.key === "Escape") setRenamingTabId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flex: 1, minWidth: 0 }}>
                        {sessionBusy[s.id] ? (
                          <span className="tab-loading-spinner" title="思考中..." />
                        ) : (
                          s.type === "claude" ? <ClaudeIcon size={14} color="#D97757" /> : <CodexIcon size={14} color="var(--color-green)" />
                        )}
                        <span className="tab-title-text">{s.name}</span>
                        {s.project && !s.isTemp && <span className="tab-project-tag">{s.project}</span>}
                      </span>
                    )}
                    <span
                      className="tab-close"
                      onClick={(e) => handleCloseTab(e, s.id)}
                    >
                      ×
                    </span>
                  </div>
                );
              })}
            </div>

            {/* tab-bar 最右侧固定区域：查看历史按钮（仅在有激活会话时显示） */}
            {activeSessionId && (
              <div className="tab-bar-actions">
                <button
                  className="tab-bar-history-btn"
                  title="查看会话完整历史"
                  onClick={() => openHistoryPanel(activeSessionId)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* 终端区 / 空白提示状态 (采用 Keep-Alive 常驻 DOM 设计，防止切换 Tab 时重新初始化) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "row", position: "relative", overflow: "hidden" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden", height: "100%" }}>
              {openTabIds.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-icon">🖥️</span>
                  <div className="empty-state-title">AgentDesk AI 终端管理器</div>
                  <div className="empty-state-desc">
                    当前没有处于活动状态的会话标签。
                    请选择左上角的 Agent 类型并点击“**新建会话**”按钮来开启一个托管终端。
                  </div>
                  <div className="empty-state-versions">
                    <VersionLabel name="Claude Code" version={claudeVersion} Icon={ClaudeIcon} color="#D97757" />
                    <span className="empty-state-version-sep">|</span>
                    <VersionLabel name="Codex" version={codexVersion} Icon={CodexIcon} color="var(--color-green)" />
                  </div>
                </div>
              ) : (
                sessions.map((s) => {
                  const isOpen = openTabIds.includes(s.id);
                  if (!isOpen) return null;
                  const isActive = activeSessionId === s.id;
                  const shouldResume = shouldResumeSession(s.id, newSessionIds);
                  const runtime = tabRuntimeBySession.get(s.id);
                  const useGuiChat = runtime?.useGuiChat ?? false;
                  return (
                    <div
                      key={s.id}
                      style={{
                        display: isActive ? "flex" : "none",
                        flexDirection: "column",
                        flex: 1,
                        width: "100%",
                        height: "100%",
                        position: "relative",
                      }}
                    >
                      {useGuiChat ? (
                        <ChatTab
                          sessionId={s.id}
                          directory={s.path}
                          agentSessionId={s.agentSessionId}
                          isActive={isActive}
                          selectedModel={selectedModel}
                          modelInfo={modelInfo}
                          onSelectModel={handleSelectModel}
                          onSelectProvider={handleSelectProvider}
                          onRefreshModelInfo={refreshModelInfo}
                          onOpenRulesEditor={() => setShowMdEditor(true)}
                          onSpawned={() => {
                            log(`ChatTab spawn resolved for session: ${s.id}. Removing from newSessionIds...`);
                            setNewSessionIds((prev) => prev.filter((nid) => nid !== s.id));
                          }}
                          onStateChange={(busy) => {
                            setSessionBusy(prev => ({ ...prev, [s.id]: busy }));
                          }}
                          onCommandComplete={() => handleCommandComplete(s.id)}
                          onUserSubmittedInput={handleUserSubmittedInputWithRenameReset}
                          onEnqueuePrompt={enqueuePrompt}
                          queueTasks={s.id === activeSessionId ? activeQueue : []}
                          onRemoveQueueTask={removeQueuedTask}
                          onUpdateQueueTask={updateQueuedTask}
                          onPauseQueue={pauseSessionQueue}
                          onResumeQueue={resumeSessionQueue}
                        />
                      ) : (
                        <TerminalTab
                          sessionId={s.id}
                          directory={s.path}
                          agentType={s.type}
                          agentSessionId={s.agentSessionId}
                          isReopen={shouldResume}
                          onSpawned={() => {
                            log(`TerminalTab spawn resolved for session: ${s.id}. Removing from newSessionIds...`);
                            setNewSessionIds((prev) => prev.filter((nid) => nid !== s.id));
                          }}
                          busy={sessionBusy[s.id] || false}
                          onStateChange={(busy) => {
                            setSessionBusy(prev => ({ ...prev, [s.id]: busy }));
                          }}
                          isActive={isActive}
                          onCommandComplete={() => handleCommandComplete(s.id)}
                          onUserSubmittedInput={handleUserSubmittedInputWithRenameReset}
                          onRenameSession={handleRenameSession}
                          onSessionBound={handleSessionBound}
                        />
                      )}
                      {(sessionBusy[s.id] || (useGuiChat && sessionBusy[s.id])) && (
                        <div className="terminal-thinking-badge">
                          <span className="thinking-dot-pulse"></span>
                          <span className="thinking-text">AI 正在思考...</span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* 右侧文件/Markdown 预览面板 */}
            {previewFile && (
              <div className="file-preview-overlay" onClick={closePreview}>
                <div
                  className="file-preview-modal"
                  onClick={(e) => e.stopPropagation()}
                >
                <div className="preview-header">
                  <div className="preview-title-area">
                    <FileText size={14} className="preview-file-icon" />
                    <span className="preview-file-name" title={previewFile.path.split("/").pop()}>
                      {previewFile.path.split("/").pop()}
                    </span>
                    <span className="preview-file-path" title={previewFile.path}>
                      {previewFile.path}
                    </span>
                  </div>
                  {previewFile.path.endsWith(".md") && !previewFile.cannotPreview && (
                    <div className="preview-md-tabs">
                      <button 
                        className={`preview-md-tab ${mdMode === "preview" ? "active" : ""}`}
                        onClick={() => setMdMode("preview")}
                      >
                        预览
                      </button>
                      <button 
                        className={`preview-md-tab ${mdMode === "source" ? "active" : ""}`}
                        onClick={() => setMdMode("source")}
                      >
                        源码
                      </button>
                    </div>
                  )}
                  <button
                    className="preview-close-btn"
                    onClick={closePreview}
                    title="关闭文件预览"
                  >
                    ×
                  </button>
                </div>
                <div
                  className={`preview-body${
                    !previewFile.cannotPreview &&
                    !(previewFile.path.endsWith(".md") && mdMode === "preview")
                      ? " editor-host"
                      : ""
                  }`}
                >
                  {previewFile.cannotPreview ? (
                    <div className="preview-error-container">
                      <div className="preview-error-icon">⚠️</div>
                      <div className="preview-error-title">该文件不支持直接预览</div>
                      <div className="preview-error-detail">
                        {previewFile.errorMsg || "可能该文件是二进制文件，或者其编码不支持。"}
                      </div>
                      <button 
                        className="preview-open-system-btn"
                        onClick={() => {
                          const separator = activeSession?.path.endsWith("/") || activeSession?.path.endsWith("\\") ? "" : "/";
                          const absolutePath = `${activeSession?.path}${separator}${previewFile.path}`;
                          invoke("open_file_in_system", { path: absolutePath })
                            .catch(err => alert(`打开文件失败: ${err}`));
                        }}
                      >
                        直接打开文件
                      </button>
                    </div>
                  ) : (previewFile.path.endsWith(".md") && mdMode === "preview") ? (
                    <div 
                      className="preview-markdown-content"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(previewFile.content) }}
                    />
                  ) : (
                    <FileEditor
                      ref={fileEditorRef}
                      projectPath={activeSession?.path || ""}
                      relativePath={previewFile.path}
                      initialContent={previewFile.content}
                      encoding={previewFile.encoding}
                      readOnly={false}
                      fontFamily={previewFontFamily}
                      fontSize={previewFontSize}
                      onDirtyChange={setFileDirty}
                      onSaved={(content) => setPreviewFile((prev) => (prev ? { ...prev, content } : prev))}
                      onAddSelectionToConversation={handleAddLinesToConversation}
                    />
                  )}
                </div>

                </div>
              </div>
            )}
          </div>

          {/* 新增的队列列表面板 */}
          {activeQueue.length > 0 && activeSessionId && (
            <div className="queue-list-panel">
              <div className="queue-panel-header">
                <div className="queue-panel-title">
                  <svg className="queue-title-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8, marginRight: "6px" }}>
                    <line x1="8" y1="6" x2="21" y2="6"></line>
                    <line x1="8" y1="12" x2="21" y2="12"></line>
                    <line x1="8" y1="18" x2="21" y2="18"></line>
                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                  </svg>
                  <span>任务队列 ({activeQueue.length}/{MAX_SESSION_QUEUE_SIZE})</span>
                </div>
                <button
                  className="queue-clear-btn"
                  onClick={() => clearQueueForSession(activeSessionId)}
                  title="全部清空队列"
                >
                  <svg className="trash-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </div>
              <div className="queue-panel-body">
                {activeQueue.map((task, index) => (
                  <div key={task.id} className="queue-item">
                    <span className="queue-item-index">{index + 1}</span>
                    <span className="queue-item-text">{task.prompt}</span>
                    <button
                      className="queue-item-delete"
                      onClick={() => removeQueuedTask(activeSessionId, task.id)}
                      title="删除排队任务"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 底部控制状态条 */}
          <div className="bottom-panel">
            {activeSession ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <button
                  className={`folder-button ${activeSession.type === "codex" ? "codex-hover" : ""}`}
                  onClick={handleOpenFolder}
                  title={`项目物理路径: ${activeSession.path}\n点击在 Windows 资源管理器中打开`}
                >
                  <svg className="folder-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="#EAB308" stroke="#EAB308" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.95, marginRight: "4px" }}>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                  <span>{getFolderName(activeSession.path)}</span>
                </button>

                <button
                  className={`md-button ${activeSession.type === "codex" ? "codex-hover" : ""}`}
                  onClick={() => setShowMdEditor(true)}
                  title={activeSession.type === "codex" ? "快速生成/编辑 AGENTS.md" : "快速生成/编辑 CLAUDE.md"}
                >
                  <svg className="doc-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "2px", opacity: 0.85 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                  <span>{activeSession.type === "codex" ? "AGENTS.md" : "CLAUDE.md"}</span>
                </button>
              </div>
            ) : (
              <div style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
                无活动项目会话
              </div>
            )}

            {/* 新增的【队列】状态栏按钮 */}
            {activeSession && (
              <div className="queue-status-btn-container" style={{
                position: "absolute",
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                gap: "8px",
                alignItems: "center"
              }}>
                {/* 快捷短语按钮 */}
                {shortcutsEnabled && shortcutsList.filter(sc => sc.title.trim() && sc.content.trim()).map((sc, idx) => (
                  <button
                    key={idx}
                    className="shortcut-status-btn"
                    onClick={() => handleTriggerShortcut(sc.content)}
                    title={`快捷短语: 点击发送 "${sc.content}"`}
                  >
                    <span>{sc.title}</span>
                  </button>
                ))}

                <button
                  className="queue-status-btn"
                  onClick={() => {
                    setQueueTargetSessionId(activeSessionId);
                    setQueueInput("");
                    setShowQueueModal(true);
                  }}
                  title="点击添加任务到队列"
                >
                  <svg className="queue-svg-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8, marginRight: "4px" }}>
                    <line x1="8" y1="6" x2="21" y2="6"></line>
                    <line x1="8" y1="12" x2="21" y2="12"></line>
                    <line x1="8" y1="18" x2="21" y2="18"></line>
                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                  </svg>
                  <span>队列</span>
                  {activeQueue.length > 0 && (
                    <span className="queue-badge">{activeQueue.length}</span>
                  )}
                </button>

              </div>
            )}

            <div className="system-meta">
              {activeSession ? (
                <span
                  style={{
                    fontWeight: 600,
                    color: activeSession.type === "claude" ? "var(--color-orange)" : "var(--color-green)",
                  }}
                >
                  {activeSession.type === "claude" ? claudeVersion : codexVersion}
                </span>
              ) : null}
            </div>
          </div>
        </main>

        {/* 会话历史面板（右侧抽屉） */}
        {historyPanelOpen && (() => {
          const targetSession = sessions.find((sess) => sess.id === historySessionId);
          if (!targetSession) return null;
          return (
            <SessionHistoryPanel
              open={historyPanelOpen}
              sessionId={historySessionId}
              sessionName={targetSession.name}
              projectPath={targetSession.path}
              onClose={() => setHistoryPanelOpen(false)}
              onJumpToTerminal={(anchor) => {
                // 1. 关闭抽屉
                setHistoryPanelOpen(false);
                // 2. 切到目标 tab（如果还没激活）
                if (activeSessionId !== historySessionId) {
                  if (!openTabIds.includes(historySessionId)) {
                    setOpenTabIds((prev) => [...prev, historySessionId]);
                  }
                  setActiveSessionId(historySessionId);
                }
                // 3. 等 xterm 渲染完成后再派发定位事件（延时两拍：DOM 更新 + fit）
                setTimeout(() => {
                  window.dispatchEvent(
                    new CustomEvent("agentdesk-scroll-to-anchor", {
                      detail: { sessionId: historySessionId, anchor },
                    })
                  );
                }, 220);
              }}
            />
          );
        })()}

        {!activeSession?.isTemp && (
          <div
            className={`project-workspace-drawer ${showProjectTree ? "open" : "closed"} ${
              isResizingProjectTree ? "resizing" : ""
            } ${activeWorkspacePanelInflow ? "inflow" : ""}`}
            style={{
              width: `${
                activeWorkspacePanelInflow
                  ? showProjectTree
                    ? projectTreeWidth
                    : 0
                  : projectTreeWidth
              }px`,
            }}
            aria-hidden={!showProjectTree}
          >
            <div 
              className={`project-tree-resizer ${isResizingProjectTree ? "dragging" : ""}`} 
              onMouseDown={startProjectTreeResize} 
              data-agent-type={activeSession?.type || "claude"}
            />
            <aside
              ref={projectTreeAsideRef}
              className={`project-tree-aside${projectTreeWidth < 250 ? " narrow" : ""}`}
            >
              <div className="project-tree-aside-header">
                <div className="aside-tabs">
                  <button
                    className={`aside-tab ${rightPanelTab === "files" ? "active" : ""}`}
                    title="文件"
                    onClick={() => {
                      setRightPanelTab("files");
                      localStorage.setItem("agentdesk_right_panel_tab", "files");
                    }}
                  >
                    <Folder size={12} />
                    <span className="aside-tab-label">文件</span>
                  </button>
                  <button
                    className={`aside-tab ${rightPanelTab === "git" ? "active" : ""}`}
                    title="提交"
                    onClick={() => {
                      setRightPanelTab("git");
                      localStorage.setItem("agentdesk_right_panel_tab", "git");
                    }}
                  >
                    <GitCommit size={12} />
                    <span className="aside-tab-label">提交</span>
                  </button>
                  <button
                    className={`aside-tab ${rightPanelTab === "branches" ? "active" : ""}`}
                    title="分支"
                    onClick={() => {
                      setRightPanelTab("branches");
                      localStorage.setItem("agentdesk_right_panel_tab", "branches");
                    }}
                  >
                    <GitBranch size={12} />
                    <span className="aside-tab-label">分支</span>
                  </button>
                </div>
                {activeSession && activeSession.path && (
                  <span className="aside-header-path" title={activeSession.path}>
                    {activeSession.path.split(/[/\\]/).pop()}
                  </span>
                )}
              </div>
              <div className="aside-tab-content">
                {rightPanelTab === "files" ? (
                  activeSession && activeSession.path ? (
                    <ProjectTree
                      projectPath={activeSession.path}
                      onFileClick={handleFileClick}
                      onInsertPathToTerminal={handleInsertPathToTerminal}
                    />
                  ) : (
                    <div className="tree-placeholder-container">
                      <div className="tree-placeholder-icon">📂</div>
                      <div className="tree-placeholder-title">未关联项目文件夹</div>
                      <div className="tree-placeholder-desc">
                        请在左侧新建或选择一个关联了本地路径的会话，以在此处浏览项目文件树。
                      </div>
                    </div>
                  )
                ) : rightPanelTab === "git" ? (
                  activeSession && activeSession.path ? (
                    <GitPanel
                      projectPath={activeSession.path}
                      onInsertPathToTerminal={handleInsertPathToTerminal}
                      onAddLinesToConversation={handleAddGitLinesToConversation}
                    />
                  ) : (
                    <div className="tree-placeholder-container">
                      <div className="tree-placeholder-icon">📂</div>
                      <div className="tree-placeholder-title">未关联项目文件夹</div>
                      <div className="tree-placeholder-desc">
                        请在左侧新建或选择一个关联了本地路径的会话，以在此处查看 Git 变更。
                      </div>
                    </div>
                  )
                ) : (
                  activeSession && activeSession.path ? (
                    <BranchPanel
                      projectPath={activeSession.path}
                      onAddLinesToConversation={handleAddGitLinesToConversation}
                    />
                  ) : (
                    <div className="tree-placeholder-container">
                      <div className="tree-placeholder-icon">📂</div>
                      <div className="tree-placeholder-title">未关联项目文件夹</div>
                      <div className="tree-placeholder-desc">
                        请在左侧新建或选择一个关联了本地路径的会话，以在此处查看 Git 分支。
                      </div>
                    </div>
                  )
                )}
              </div>
            </aside>
          </div>
        )}

      </div>

      {/* 标签页 Tooltip */}
      {tabTooltip.visible && tabTooltip.session && (
        <div
          className="tab-tooltip"
          style={{
            position: "fixed",
            left: `${tabTooltip.x}px`,
            top: `${tabTooltip.y}px`,
            transform: "translateX(-50%)",
            zIndex: 10000,
          }}
          onMouseEnter={handleTabTooltipMouseEnter}
          onMouseLeave={handleTabTooltipMouseLeave}
        >
          <div className="tab-tooltip-name">{tabTooltip.session.name}</div>
          {tabTooltip.session.path && !tabTooltip.session.isTemp && (
            <div
              className="tab-tooltip-path"
              onClick={() => handleOpenFolderPath(tabTooltip.session!.path)}
            >
              <span className="tab-tooltip-path-icon">📁</span>
              <span className="tab-tooltip-path-text">{tabTooltip.session.path}</span>
            </div>
          )}
          <div className="tab-tooltip-arrow" />
        </div>
      )}

      {/* 新建会话终端弹窗组件 */}
      <NewSessionModal
        show={showModal}
        onClose={() => setShowModal(false)}
        selectedAgent={selectedAgent}
        onCreate={handleCreateSession}
        initialProjectPath={prefilledProjectPath}
      />

      {/* 设置中心弹窗组件 */}
      <SettingsModal
        show={showSettings}
        onClose={() => setShowSettings(false)}
        onSessionsRenamed={() => {
          invoke<Session[]>("get_sessions")
            .then((data) => { if (data) setSessions(data); })
            .catch(() => {});
        }}
      />

      {/* 📝 Markdown 编辑器弹窗组件 */}
      {activeSession && (
        <MdEditorModal
          show={showMdEditor}
          onClose={() => setShowMdEditor(false)}
          projectPath={activeSession.path}
          filename={activeSession.type === "codex" ? "AGENTS.md" : "CLAUDE.md"}
        />
      )}

      {/* 📋 添加到任务队列弹窗 */}
      {showQueueModal && (
        <div className="modal-overlay show" style={{ zIndex: 1150 }}>
          <div className="modal-card queue-input-modal" style={{ width: "480px" }}>
            <div className="modal-header">
              <span className="modal-title" style={{ fontSize: "15px", fontWeight: 700 }}>添加到任务队列</span>
              <button className="modal-close" onClick={() => setShowQueueModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "10px 0" }}>
              <div className="form-item" style={{ margin: 0 }}>
                <textarea
                  className="modal-input queue-textarea"
                  placeholder="输入要排队执行的任务提示词..."
                  value={queueInput}
                  onChange={(e) => setQueueInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleAddToQueue();
                    } else if (e.key === "Escape") {
                      setShowQueueModal(false);
                    }
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    height: "100px",
                    resize: "none",
                    borderRadius: "6px",
                    padding: "10px",
                    fontFamily: "inherit",
                    fontSize: "13px",
                    border: "1px solid var(--border-color)",
                    backgroundColor: "var(--bg-main)",
                    color: "var(--text-primary)"
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--text-secondary)", fontSize: "11.5px" }}>
                <span>Enter 添加到队列 · Shift+Enter 换行 · Esc 取消</span>
                <span>当前队列: {queueModalQueue.length}/{MAX_SESSION_QUEUE_SIZE}</span>
              </div>
            </div>
            <div className="modal-footer" style={{ marginTop: "10px" }}>
              <button
                className="modal-btn modal-btn-cancel"
                onClick={() => setShowQueueModal(false)}
              >
                取消
              </button>
              <button
                className="modal-btn"
                style={{ backgroundColor: "var(--color-primary)", color: "#ffffff" }}
                onClick={handleAddToQueue}
              >
                加入队列
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 标签页右键悬浮菜单 */}
      {tabContextMenu && (
        <div
          className="context-menu"
          style={{
            top: tabContextMenu.y,
            left: tabContextMenu.x,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const ev = { stopPropagation: () => {} } as React.MouseEvent;
              handleCloseTab(ev, tabContextMenu.sessionId);
              setTabContextMenu(null);
            }}
          >
            关闭标签页
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setOpenTabIds([tabContextMenu.sessionId]);
              setActiveSessionId(tabContextMenu.sessionId);
              setTabContextMenu(null);
            }}
          >
            关闭其他标签
          </button>
          {!sessions.find((sess) => sess.id === tabContextMenu.sessionId)?.isTemp && (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  setRenamingTabId(tabContextMenu.sessionId);
                  const s = sessions.find((sess) => sess.id === tabContextMenu.sessionId);
                  setRenamingTabText(s ? s.name : "");
                  setTabContextMenu(null);
                }}
              >
                重命名会话
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  handleLocateSession(tabContextMenu.sessionId);
                  setTabContextMenu(null);
                }}
              >
                在侧边栏中定位
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  openHistoryPanel(tabContextMenu.sessionId);
                  setTabContextMenu(null);
                }}
              >
                查看完整历史
              </button>
              <div style={{ borderBottom: "1px dashed var(--border-color)", margin: "4px 6px" }} />
              <button
                className="context-menu-item"
                onClick={() => {
                  const s = sessions.find(sess => sess.id === tabContextMenu.sessionId);
                  if (s) {
                    navigator.clipboard.writeText(s.path).catch(() => {});
                  }
                  setTabContextMenu(null);
                }}
              >
                复制项目路径
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  const s = sessions.find(sess => sess.id === tabContextMenu.sessionId);
                  if (s) {
                    invoke("open_project_folder", { path: s.path }).catch(() => {});
                  }
                  setTabContextMenu(null);
                }}
              >
                在文件管理器中打开
              </button>
            </>
          )}
        </div>
      )}

      {/* 💾 极简化关闭行为确认弹窗 */}
      {showCloseConfirmModal && (
        <div className="modal-overlay show" style={{ zIndex: 1100 }}>
          <div className="modal-card select-confirm-modal" style={{ width: "420px" }}>
            <div className="modal-header">
              <span className="modal-title" style={{ fontSize: "15px", fontWeight: 700 }}>退出 AgentDesk</span>
              <button className="modal-close" onClick={() => setShowCloseConfirmModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "10px 0" }}>
              <p style={{ fontSize: "13px", color: "var(--text-primary)", lineHeight: "1.6" }}>
                您想要直接退出应用，还是将它最小化到系统托盘？
              </p>
              <div className="settings-switch-row" style={{ marginTop: "4px", gap: "8px" }}>
                <label className="switch-container">
                  <input
                    type="checkbox"
                    checked={rememberCloseChoice}
                    onChange={(e) => setRememberCloseChoice(e.target.checked)}
                  />
                  <span className="switch-slider"></span>
                </label>
                <span className="switch-label" style={{ fontSize: "12.5px" }}>记住我的选择，下次不再询问</span>
              </div>
            </div>
            <div className="modal-footer" style={{ marginTop: "15px" }}>
              <button
                className="modal-btn modal-btn-cancel"
                onClick={() => setShowCloseConfirmModal(false)}
              >
                取消
              </button>
              <button
                className="modal-btn"
                style={{ backgroundColor: "var(--color-primary)", color: "#ffffff" }}
                onClick={() => {
                  if (rememberCloseChoice) {
                    localStorage.setItem("agentdesk_setting_close_behavior", "minimize");
                  }
                  setShowCloseConfirmModal(false);
                  appWindow.hide().catch((err) => log(`Failed to hide window: ${err}`));
                }}
              >
                最小化到托盘
              </button>
              <button
                className="modal-btn"
                style={{ backgroundColor: "#ef4444", color: "#ffffff" }}
                onClick={() => {
                  if (rememberCloseChoice) {
                    localStorage.setItem("agentdesk_setting_close_behavior", "exit");
                  }
                  setShowCloseConfirmModal(false);
                  appWindow.destroy().catch((err) => log(`Failed to destroy window: ${err}`));
                }}
              >
                直接退出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 恢复上次会话 右上角气泡通知 (Figure 1) */}
      {showRestoreToast && pendingRestoreIds.length > 0 && (
        <div className="restore-toast">
          <div className="restore-toast-header">
            <span className="restore-toast-title">恢复上次会话</span>
            <button className="restore-toast-close" onClick={handleRestoreIgnore}>✕</button>
          </div>
          <div className="restore-toast-body">
            上次关闭时有 {pendingRestoreIds.length} 个会话未恢复，可点此逐个恢复
          </div>
          <div className="restore-toast-footer">
            <button 
              className="restore-toast-btn" 
              onClick={() => {
                setShowRestoreToast(false);
                setShowRestoreModal(true);
              }}
            >
              查看并恢复
            </button>
          </div>
        </div>
      )}

      {/* 恢复上次会话 中央选择弹窗 (Figure 2) */}
      {showRestoreModal && pendingRestoreIds.length > 0 && (
        <div className="modal-overlay show" style={{ zIndex: 1200 }}>
          <div className="modal-card restore-session-modal" style={{ width: "520px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title" style={{ fontSize: "15px", fontWeight: 700 }}>恢复上次会话</span>
              <button className="modal-close" onClick={() => setShowRestoreModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "10px 0" }}>
              <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: "0 0 4px 0" }}>
                选择要恢复的会话，将续上上次的对话上下文。
              </p>
              <div className="restore-session-list">
                {pendingRestoreIds.map((tid) => {
                  const s = sessions.find((sess) => sess.id === tid);
                  if (!s) return null;
                  return (
                    <div key={s.id} className="restore-session-item">
                      <div className="restore-item-info">
                        <div className="restore-item-name">{s.name}</div>
                        <div className="restore-item-path" title={s.path}>
                          {s.type === "claude" ? "claude-code" : "codex"} · {s.path}
                        </div>
                      </div>
                      <button
                        className="restore-item-btn"
                        onClick={() => handleRestoreSingle(s.id)}
                      >
                        恢复
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer" style={{ marginTop: "15px", display: "flex", gap: "12px" }}>
              <button
                className="modal-btn btn-all-restore"
                onClick={handleRestoreAll}
                style={{ flex: 1 }}
              >
                全部恢复
              </button>
              <button
                className="modal-btn modal-btn-cancel"
                onClick={handleRestoreIgnore}
                style={{ flex: 1 }}
              >
                忽略
              </button>
            </div>
          </div>
        </div>
      )}
    {/* 应用级 Toast + 通用确认框宿主（AppToastHost 底部轻抬栈 + ConfirmModal 模态确认） */}
      <AppToastHost toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal
        show={activeConfirm != null}
        title={activeConfirm?.title ?? ""}
        message={activeConfirm?.message ?? ""}
        confirmText={activeConfirm?.confirmText}
        cancelText={activeConfirm?.cancelText}
        isDanger={activeConfirm?.isDanger}
        onConfirm={() => resolveConfirm(true)}
        onCancel={() => resolveConfirm(false)}
      />
    </div>
  );
}

export default App;
