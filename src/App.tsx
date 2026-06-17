import { useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Sidebar, Session, ClaudeIcon, PiIcon } from "./components/Sidebar";
import { TerminalTab } from "./components/TerminalTab";
import { NewSessionModal } from "./components/NewSessionModal";
import { SettingsModal } from "./components/SettingsModal";
import { MdEditorModal } from "./components/MdEditorModal";
import { ProjectTree } from "./components/ProjectTree";
import { renderMarkdownToHtml } from "./utils/markdown";
import { getHighlightedLines } from "./utils/highlighter";
import { FileText } from "lucide-react";
import {
  addUnreadCompletion,
  getUnreadCompletionCount,
  markSessionRead,
} from "./utils/unreadCompletions";
import { updateSessionLastUserMessageAt } from "./utils/sessionActivity";
import { readSessionCleanupSettings } from "./utils/sessionCleanup";
import { shouldResumeSession } from "./utils/sessionResume";
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
    const existingLogs = JSON.parse(localStorage.getItem("kkcoder_logs") || "[]");
    existingLogs.push(fullMsg);
    if (existingLogs.length > 200) {
      existingLogs.shift();
    }
    localStorage.setItem("kkcoder_logs", JSON.stringify(existingLogs));
  } catch (e) {}
}

function getFolderName(path: string): string {
  if (!path) return "";
  // 去除末尾斜杠，避免 split 后最后一个元素为空导致显示异常
  const cleanPath = path.replace(/[\\/]+$/, "");
  const parts = cleanPath.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const CLAUDE_VERSION_CACHE_KEY = "kkcoder_cached_claude_version";

function App() {

  const appWindow = useMemo(() => getCurrentWindow(), []);

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
    const path = localStorage.getItem("kkcoder_setting_ccswitch_path") || "";
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
  const [selectedAgent, setSelectedAgent] = useState<"claude" | "pi">("claude");
  const [showModal, setShowModal] = useState<boolean>(false);
  const [prefilledProjectPath, setPrefilledProjectPath] = useState<string | undefined>(undefined);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showMdEditor, setShowMdEditor] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [newSessionIds, setNewSessionIds] = useState<string[]>([]);

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
    return localStorage.getItem("kkcoder_setting_theme") || "light-premium";
  });
  const [isInitLoaded, setIsInitLoaded] = useState<boolean>(false);

  const [claudeVersion, setClaudeVersion] = useState<string>(() => {
    return localStorage.getItem(CLAUDE_VERSION_CACHE_KEY) || "Claude Code";
  });

  // 侧边栏拖拽调宽状态与拖拽处理
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem("kkcoder_sidebar_width");
    return saved ? parseInt(saved, 10) : 300;
  });
  const [isResizing, setIsResizing] = useState<boolean>(false);

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
      localStorage.setItem("kkcoder_sidebar_width", newWidth.toString());
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
    const saved = localStorage.getItem("kkcoder_project_tree_width");
    return saved ? parseInt(saved, 10) : 260;
  });
  const [isResizingProjectTree, setIsResizingProjectTree] = useState<boolean>(false);
  const [showProjectTree, setShowProjectTree] = useState<boolean>(() => {
    return localStorage.getItem("kkcoder_show_project_tree") === "true";
  });
  const [previewFile, setPreviewFile] = useState<{ 
    path: string; 
    content: string; 
    cannotPreview?: boolean;
    errorMsg?: string;
  } | null>(null);
  const [mdMode, setMdMode] = useState<"preview" | "source">("source");
  const [previewFontFamily, setPreviewFontFamily] = useState<string>(() => {
    return localStorage.getItem("kkcoder_setting_preview_font_family") || "monospace";
  });
  const [previewFontSize, setPreviewFontSize] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_preview_font_size");
    return val ? parseFloat(val) : 12.5;
  });
  // 预览区内部快捷查找与行号跳转状态
  const [fileSearchQuery, setFileSearchQuery] = useState<string>("");
  const [showFileSearchBar, setShowFileSearchBar] = useState<boolean>(false);
  const [showGoToLineBar, setShowGoToLineBar] = useState<boolean>(false);
  const [goToLineNumber, setGoToLineNumber] = useState<string>("");
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);
  const [matchedLines, setMatchedLines] = useState<number[]>([]);
  const [previewContextMenu, setPreviewContextMenu] = useState<{
    x: number;
    y: number;
    startLine: number;
    endLine: number;
  } | null>(null);

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
      localStorage.setItem("kkcoder_project_tree_width", newWidth.toString());
      window.dispatchEvent(new Event("resize"));
    };

    const handleMouseUp = () => {
      setIsResizingProjectTree(false);
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
  }, [isResizingProjectTree]);

  useEffect(() => {
    const handleFontChange = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      setPreviewFontFamily(customEvent.detail || "monospace");
    };
    const handleFontSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent<number>;
      setPreviewFontSize(customEvent.detail || 12.5);
    };

    window.addEventListener("kkcoder-preview-font-change", handleFontChange);
    window.addEventListener("kkcoder-preview-font-size-change", handleFontSizeChange);

    return () => {
      window.removeEventListener("kkcoder-preview-font-change", handleFontChange);
      window.removeEventListener("kkcoder-preview-font-size-change", handleFontSizeChange);
    };
  }, []);

  // 快捷短语状态
  const [shortcutsEnabled, setShortcutsEnabled] = useState<boolean>(() => {
    const val = localStorage.getItem("kkcoder_shortcuts_enabled");
    return val === null ? false : val === "true";
  });

  const [shortcutsList, setShortcutsList] = useState<{ title: string; content: string }[]>(() => {
    const val = localStorage.getItem("kkcoder_shortcuts_list");
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
      const enabledVal = localStorage.getItem("kkcoder_shortcuts_enabled");
      setShortcutsEnabled(enabledVal === null ? false : enabledVal === "true");

      const listVal = localStorage.getItem("kkcoder_shortcuts_list");
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

    window.addEventListener("kkcoder-shortcuts-change", handleShortcutsChange);
    return () => {
      window.removeEventListener("kkcoder-shortcuts-change", handleShortcutsChange);
    };
  }, []);

  const handleTriggerShortcut = (content: string) => {
    if (!activeSessionId) return;
    const isBusy = sessionBusy[activeSessionId] || false;
    if (isBusy) {
      if (queue.length >= 2) {
        alert("队列已满！目前最多只允许队列中有 2 个排队任务。");
        return;
      }
      setQueue(prev => [...prev, { id: generateUUID(), prompt: content }]);
    } else {
      setSessionBusy(prev => ({ ...prev, [activeSessionId]: true }));
      invoke("write_to_terminal", { sessionId: activeSessionId, data: content + "\r\n" })
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

  // 📋 任务队列状态与自动调度引擎
  interface QueueTask {
    id: string;
    prompt: string;
  }
  const [queue, setQueue] = useState<QueueTask[]>([]);
  const [showQueueModal, setShowQueueModal] = useState<boolean>(false);
  const [queueInput, setQueueInput] = useState<string>("");
  const [sessionBusy, setSessionBusy] = useState<Record<string, boolean>>({});

  const handleUserSubmittedInput = (sessionId: string, submittedAt: string = new Date().toISOString()) => {
    localStorage.setItem(`kkcoder_session_has_dialogue_${sessionId}`, "true");
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
    try { return JSON.parse(localStorage.getItem("kkcoder_last_rename_times") || "{}") as Record<string, number>; }
    catch { return {} as Record<string, number>; }
  })();
  const lastRenameTimesRef = useRef<Record<string, number>>(initialRenameTimes);
  const triggerAutoRename = (source: string) => {
    const mode = localStorage.getItem("kkcoder_setting_namer_mode") || "heuristic";
    const skipFav = localStorage.getItem("kkcoder_setting_auto_rename_skip_favorites") !== "false";

    const cmd = mode === "llm" ? "llm_rename_sessions" : "auto_rename_sessions";
    const params: Record<string, unknown> = { skipFavorites: skipFav, projectFilter: null };

    if (mode === "llm") {
      const apiKey = localStorage.getItem("kkcoder_setting_llm_api_key") || "";
      if (!apiKey) {
        log(`${source} auto-rename: LLM mode enabled but API key is empty, skipping.`);
        return;
      }
      params.apiUrl = localStorage.getItem("kkcoder_setting_llm_api_url") || "https://api.deepseek.com";
      params.apiKey = apiKey;
      params.model = localStorage.getItem("kkcoder_setting_llm_model") || "deepseek-v4-flash";
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
          try { localStorage.setItem("kkcoder_last_rename_times", JSON.stringify(lastRenameTimesRef.current)); } catch {}
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
      if (localStorage.getItem("kkcoder_setting_auto_rename_idle") !== "true") return;

      const now = Date.now();
      const idleMinutes = parseInt(localStorage.getItem("kkcoder_setting_idle_minutes") || "5", 10);
      const IDLE_MS = idleMinutes * 60 * 1000;
      const skipFav = localStorage.getItem("kkcoder_setting_auto_rename_skip_favorites") !== "false";

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

  const handleAddToQueue = () => {
    const trimmed = queueInput.trim();
    if (!trimmed) {
      alert("请输入要排队执行的提示词！");
      return;
    }
    if (queue.length >= 2) {
      alert("队列已满！目前最多只允许队列中有 2 个排队任务。");
      return;
    }
    setQueue(prev => [...prev, { id: generateUUID(), prompt: trimmed }]);
    setQueueInput("");
    setShowQueueModal(false);
  };

  // 队列自动调度引擎
  useEffect(() => {
    if (!activeSessionId) return;
    const isActiveBusy = sessionBusy[activeSessionId] || false;
    if (!isActiveBusy && queue.length > 0) {
      // 弹出并执行下一个排队任务
      const nextTask = queue[0];
      log(`[Queue] Auto-triggering queued task: "${nextTask.prompt}" for session: ${activeSessionId}`);
      
      // 立即在前端置为繁忙，防范异步重入和并发发送
      setSessionBusy(prev => ({ ...prev, [activeSessionId]: true }));
      
      // 写入终端
      invoke("write_to_terminal", { sessionId: activeSessionId, data: nextTask.prompt + "\r\n" })
        .then(() => {
          handleUserSubmittedInputWithRenameReset(activeSessionId);
          log(`[Queue] Successfully sent task to terminal. Removing from queue...`);
          setQueue(prev => prev.slice(1));
        })
        .catch((err) => {
          log(`[Queue] Failed to send queued task: ${err}`);
          // 发送失败恢复闲置状态
          setSessionBusy(prev => ({ ...prev, [activeSessionId]: false }));
        });
    }
  }, [queue, activeSessionId, sessionBusy]);

  // 当队列长度或显示状态变化时，强力触发 resize 事件，确保 xterm.js 虚拟终端完美重测尺寸且不遮挡输入框
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 80); // 80ms 确保 DOM 树重排与 CSS 动画过渡彻底完成
    return () => clearTimeout(timer);
  }, [queue.length]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const insertConversationTagToActiveTerminal = useCallback((text: string) => {
    if (!activeSessionId || !text) return;
    window.dispatchEvent(new CustomEvent("kkcoder-insert-conversation-tag", {
      detail: {
        sessionId: activeSessionId,
        text,
      },
    }));
  }, [activeSessionId]);

  // 切换会话项目路径时自动清空文件预览
  useEffect(() => {
    setPreviewFile(null);
  }, [activeSession?.path]);

  // 监听点击外部关闭预览右键菜单
  useEffect(() => {
    const closeMenu = () => setPreviewContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  const handlePreviewContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !previewFile) return;

    // 检查选中的文本是否在预览面板内
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer as HTMLElement;
    
    let isInsidePreview = false;
    let curr: HTMLElement | null = container;
    while (curr && curr !== document.body) {
      if (curr.classList && (curr.classList.contains("preview-body") || curr.classList.contains("file-preview-panel"))) {
        isInsidePreview = true;
        break;
      }
      curr = curr.parentElement;
    }
    
    if (!isInsidePreview) return;

    e.preventDefault();
    e.stopPropagation();

    let startLine = Infinity;
    let endLine = -Infinity;

    const getLineNumberFromNode = (node: Node | null): number | null => {
      let temp: HTMLElement | null = node as HTMLElement;
      while (temp && temp !== document.body) {
        if (temp.classList && temp.classList.contains("preview-code-line")) {
          const attr = temp.getAttribute("data-line");
          return attr ? parseInt(attr, 10) : null;
        }
        temp = temp.parentElement;
      }
      return null;
    };

    const anchorLine = getLineNumberFromNode(selection.anchorNode);
    const focusLine = getLineNumberFromNode(selection.focusNode);

    if (anchorLine !== null) {
      startLine = Math.min(startLine, anchorLine);
      endLine = Math.max(endLine, anchorLine);
    }
    if (focusLine !== null) {
      startLine = Math.min(startLine, focusLine);
      endLine = Math.max(endLine, focusLine);
    }

    try {
      const allLines = document.querySelectorAll(".preview-code-line");
      allLines.forEach((lineEl) => {
        if (selection.containsNode(lineEl, true)) {
          const attr = lineEl.getAttribute("data-line");
          if (attr) {
            const l = parseInt(attr, 10);
            startLine = Math.min(startLine, l);
            endLine = Math.max(endLine, l);
          }
        }
      });
    } catch (err) {}

    if (startLine === Infinity || endLine === -Infinity) return;

    let x = e.clientX;
    let y = e.clientY;
    if (x + 160 > window.innerWidth) {
      x = Math.max(0, x - 160);
    }

    setPreviewContextMenu({
      x,
      y,
      startLine,
      endLine
    });
  }, [previewFile]);

  // 监听预览内匹配项列表和当前索引，自动滚动定位到当前匹配行
  useEffect(() => {
    if (matchedLines.length > 0 && activeMatchIndex >= 0 && activeMatchIndex < matchedLines.length) {
      const lineNum = matchedLines[activeMatchIndex];
      const el = document.querySelector(`.preview-code-line[data-line="${lineNum}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }, [activeMatchIndex, matchedLines]);

  // 从 Selection 提取起始行号 and 结束行号的通用工具函数
  const getSelectionLineRange = useCallback((selection: Selection) => {
    let startLine = Infinity;
    let endLine = -Infinity;

    const getLineNumberFromNode = (node: Node | null): number | null => {
      let temp: HTMLElement | null = node as HTMLElement;
      while (temp && temp !== document.body) {
        if (temp.classList && temp.classList.contains("preview-code-line")) {
          const attr = temp.getAttribute("data-line");
          return attr ? parseInt(attr, 10) : null;
        }
        temp = temp.parentElement;
      }
      return null;
    };

    const anchorLine = getLineNumberFromNode(selection.anchorNode);
    const focusLine = getLineNumberFromNode(selection.focusNode);

    if (anchorLine !== null) {
      startLine = Math.min(startLine, anchorLine);
      endLine = Math.max(endLine, anchorLine);
    }
    if (focusLine !== null) {
      startLine = Math.min(startLine, focusLine);
      endLine = Math.max(endLine, focusLine);
    }

    try {
      const allLines = document.querySelectorAll(".preview-code-line");
      allLines.forEach((lineEl) => {
        if (selection.containsNode(lineEl, true)) {
          const attr = lineEl.getAttribute("data-line");
          if (attr) {
            const l = parseInt(attr, 10);
            startLine = Math.min(startLine, l);
            endLine = Math.max(endLine, l);
          }
        }
      });
    } catch (err) {}

    if (startLine === Infinity || endLine === -Infinity) return null;
    return { startLine, endLine };
  }, []);

  // 将框选的部分代码添加到对话（末尾带空格，且自动聚焦终端）
  const handleAddToConversationFromSelection = useCallback((selection: Selection) => {
    if (!previewFile || !activeSessionId) return;
    const range = getSelectionLineRange(selection);
    if (!range) return;

    const { startLine, endLine } = range;
    const isSingleLine = startLine === endLine;
    const rangeStr = isSingleLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
    
    // 路径用双引号，且行号后面要自带一个空格
    const data = `"${previewFile.path}":${rangeStr} `;

    insertConversationTagToActiveTerminal(data);
  }, [previewFile, activeSessionId, getSelectionLineRange, insertConversationTagToActiveTerminal]);

  // 全局键盘快捷键绑定（Escape关闭, Ctrl+F查找, Ctrl+G跳转行, Ctrl+U选中添加到对话）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showFileSearchBar) {
          setShowFileSearchBar(false);
          setFileSearchQuery("");
          e.preventDefault();
          e.stopPropagation();
        } else if (showGoToLineBar) {
          setShowGoToLineBar(false);
          setGoToLineNumber("");
          e.preventDefault();
          e.stopPropagation();
        } else if (previewFile) {
          setPreviewFile(null);
          setMdMode("source");
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (previewFile) {
        // Ctrl + A 全选限制在预览框中
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          const selection = window.getSelection();
          const previewPanel = document.querySelector(".file-preview-panel");
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

        // Ctrl + F 文件内查找
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setShowFileSearchBar(true);
          setShowGoToLineBar(false);
          setTimeout(() => {
            const input = document.getElementById("file-search-input");
            if (input) input.focus();
          }, 50);
        }
        // Ctrl + G 跳转到指定行号
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
          e.preventDefault();
          setShowGoToLineBar(true);
          setShowFileSearchBar(false);
          setTimeout(() => {
            const input = document.getElementById("go-to-line-input");
            if (input) input.focus();
          }, 50);
        }
        // Ctrl + U 选中内容添加到对话
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            e.preventDefault();
            handleAddToConversationFromSelection(selection);
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [previewFile, showFileSearchBar, showGoToLineBar, goToLineNumber, fileSearchQuery, matchedLines, activeMatchIndex, handleAddToConversationFromSelection]);

  const handleFileClick = useCallback(async (relativePath: string) => {
    if (!activeSession?.path) return;
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
      const content = await invoke<string>("read_project_file_content", {
        projectPath: activeSession.path,
        relativePath
      });
      setPreviewFile({ path: relativePath, content, cannotPreview: false });
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
    const formatted = `"${relativePath}" `;
    insertConversationTagToActiveTerminal(formatted);
  }, [insertConversationTagToActiveTerminal]);



  // 处理文件内查找内容改变（更新匹配的行号列表和当前匹配项索引）
  const handleFileSearchChange = (query: string) => {
    setFileSearchQuery(query);
    if (!query.trim() || !previewFile) {
      setMatchedLines([]);
      setActiveMatchIndex(0);
      return;
    }
    const lines = previewFile.content.split("\n");
    const matched: number[] = [];
    const lowerQuery = query.toLowerCase();
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        matched.push(idx + 1);
      }
    });
    setMatchedLines(matched);
    setActiveMatchIndex(matched.length > 0 ? 0 : -1);
  };

  // 处理跳转到行号逻辑（闪烁并滚动定位到该行）
  const handleGoToLine = () => {
    const lineNum = parseInt(goToLineNumber, 10);
    if (isNaN(lineNum) || !previewFile) return;
    
    const totalLines = previewFile.content.split("\n").length;
    const target = Math.max(1, Math.min(totalLines, lineNum));
    
    const el = document.querySelector(`.preview-code-line[data-line="${target}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("line-highlight-pulse");
      setTimeout(() => {
        el.classList.remove("line-highlight-pulse");
      }, 1500);
    }
    setShowGoToLineBar(false);
    setGoToLineNumber("");
  };

  // 辅助防正则注入函数
  const escapeRegExp = (str: string) => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  // 渲染高亮的匹配行文本
  const renderHighlightedLineText = (lineText: string) => {
    if (!fileSearchQuery.trim()) return lineText || " ";
    const parts = lineText.split(new RegExp(`(${escapeRegExp(fileSearchQuery)})`, "gi"));
    return (
      <>
        {parts.map((part, index) => 
          part.toLowerCase() === fileSearchQuery.toLowerCase() ? (
            <mark key={index} className="search-highlight-mark">
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const highlightedData = useMemo(() => {
    if (!previewFile || previewFile.cannotPreview) return { tokens: [], isPlain: true };
    return getHighlightedLines(previewFile.content, previewFile.path);
  }, [previewFile]);

  const renderToken = (token: any, key: string | number): React.ReactNode => {
    if (!token.type) {
      return renderHighlightedLineText(token.content);
    }

    const content = Array.isArray(token.content)
      ? token.content.map((child: any, i: number) => renderToken(child, i))
      : renderHighlightedLineText(token.content);

    return (
      <span key={key} className={`token ${token.type}`}>
        {content}
      </span>
    );
  };

  // 记住最后的会话和打开的 Tab 标签页
  useEffect(() => {
    if (isInitLoaded) {
      localStorage.setItem("kkcoder_last_active_session_id", activeSessionId);
    }
  }, [activeSessionId, isInitLoaded]);

  useEffect(() => {
    if (isInitLoaded) {
      localStorage.setItem("kkcoder_last_open_tab_ids", JSON.stringify(openTabIds));
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
    const savedWidth = localStorage.getItem("kkcoder_window_width");
    const savedHeight = localStorage.getItem("kkcoder_window_height");
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
          localStorage.setItem("kkcoder_window_width", String(w));
          localStorage.setItem("kkcoder_window_height", String(h));
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

  // 监听归档还原事件，重新加载所有会话
  useEffect(() => {
    const handleArchiveRestored = () => {
      invoke<Session[]>("get_sessions")
        .then((data) => {
          setSessions(data || []);
        })
        .catch((err) => console.error("Failed to reload sessions after archive restore:", err));
    };
    window.addEventListener("archive-sessions-restored", handleArchiveRestored);
    return () => window.removeEventListener("archive-sessions-restored", handleArchiveRestored);
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
          const behavior = localStorage.getItem("kkcoder_setting_close_behavior") || "exit";
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
          const persistedLogs = JSON.parse(localStorage.getItem("kkcoder_logs") || "[]");
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

    const scheduleClaudeVersionFetch = () => {
      claudeVersionTimer = window.setTimeout(fetchClaudeVersion, 1500);
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
          const lastActiveId = localStorage.getItem("kkcoder_last_active_session_id");
          const lastOpenTabsStr = localStorage.getItem("kkcoder_last_open_tab_ids");
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
        scheduleDeferredDiagnostics();

        // 启动时自动修正会话名称（延迟执行，不阻塞 UI 加载）
        if (localStorage.getItem("kkcoder_setting_auto_rename_startup") === "true") {
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
        scheduleDeferredDiagnostics();
      });

    return () => {
      if (claudeVersionTimer !== null) window.clearTimeout(claudeVersionTimer);
      if (diagnosticsTimer !== null) window.clearTimeout(diagnosticsTimer);
    };
  }, []);

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
    const agentSessionId = generateUUID(); // 生成安全标准的 RFC 4122 持久化会话 UUID
    log(`Generated new session UUIDs: id=${newId}, agentSessionId=${agentSessionId}`);
    
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
    const agentSessionId = generateUUID();
    
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


  // 监听主题发生变动的全局广播事件
  useEffect(() => {
    const handleThemeEvent = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      setCurrentTheme(customEvent.detail);
    };
    window.addEventListener("kkcoder-theme-change", handleThemeEvent);
    return () => window.removeEventListener("kkcoder-theme-change", handleThemeEvent);
  }, []);

  const applyTheme = (themeName: string) => {
    const root = document.documentElement;
    let target = themeName;
    if (themeName === "auto") {
      target = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark-zinc" : "light-premium";
    }
    root.setAttribute("data-theme", target);

    if (target === "dark-blue") {
      root.style.setProperty("--bg-main", "#090d16");
      root.style.setProperty("--bg-sidebar", "#121620");
      root.style.setProperty("--bg-terminal", "#000000");
      root.style.setProperty("--border-color", "#1e293b");
      root.style.setProperty("--text-primary", "#f8fafc");
      root.style.setProperty("--text-secondary", "#94a3b8");
      root.style.setProperty("--color-primary", "#3b82f6");
      root.style.setProperty("--color-primary-hover", "#2563eb");
      root.style.setProperty("--color-orange", "#f97316");
      root.style.setProperty("--color-orange-light", "rgba(249, 115, 22, 0.15)");
      root.style.setProperty("--bg-active-item", "#1e293b");
      root.style.setProperty("--text-active-item", "#ffffff");
      root.style.setProperty("--bg-hover-item", "rgba(59, 130, 246, 0.15)");
      root.style.setProperty("--bg-agent-selector", "rgba(0, 0, 0, 0.25)");
      root.style.setProperty("--bg-agent-slider", "#1e293b");
      root.style.setProperty("--shadow-agent-slider", "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)");
    } else if (target === "dark-purple") {
      root.style.setProperty("--bg-main", "#0c0a12");
      root.style.setProperty("--bg-sidebar", "#171424");
      root.style.setProperty("--bg-terminal", "#000000");
      root.style.setProperty("--border-color", "#2e2540");
      root.style.setProperty("--text-primary", "#f5f3ff");
      root.style.setProperty("--text-secondary", "#b7a8d6");
      root.style.setProperty("--color-primary", "#8b5cf6");
      root.style.setProperty("--color-primary-hover", "#7c3aed");
      root.style.setProperty("--color-orange", "#f97316");
      root.style.setProperty("--color-orange-light", "rgba(249, 115, 22, 0.15)");
      root.style.setProperty("--bg-active-item", "#2f2647");
      root.style.setProperty("--text-active-item", "#ffffff");
      root.style.setProperty("--bg-hover-item", "rgba(139, 92, 246, 0.15)");
      root.style.setProperty("--bg-agent-selector", "rgba(0, 0, 0, 0.25)");
      root.style.setProperty("--bg-agent-slider", "#2f2647");
      root.style.setProperty("--shadow-agent-slider", "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)");
    } else if (target === "dark-zinc") {
      root.style.setProperty("--bg-main", "#0c0b0a");
      root.style.setProperty("--bg-sidebar", "#1d1b18");
      root.style.setProperty("--bg-terminal", "#000000");
      root.style.setProperty("--border-color", "#332f29");
      root.style.setProperty("--text-primary", "#fafaf9");
      root.style.setProperty("--text-secondary", "#cbd5e1");
      root.style.setProperty("--color-primary", "#d97706");
      root.style.setProperty("--color-primary-hover", "#b55c04");
      root.style.setProperty("--color-orange", "#d97706");
      root.style.setProperty("--color-orange-light", "rgba(217, 119, 6, 0.15)");
      root.style.setProperty("--bg-active-item", "#383227");
      root.style.setProperty("--text-active-item", "#ffffff");
      root.style.setProperty("--bg-hover-item", "rgba(245, 158, 11, 0.15)");
      root.style.setProperty("--bg-agent-selector", "rgba(0, 0, 0, 0.25)");
      root.style.setProperty("--bg-agent-slider", "#383227");
      root.style.setProperty("--shadow-agent-slider", "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)");
    } else if (target === "light-blue") {
      root.style.setProperty("--bg-main", "#ffffff");
      root.style.setProperty("--bg-sidebar", "#f0f7ff");
      root.style.setProperty("--bg-terminal", "#f8fafc");
      root.style.setProperty("--border-color", "#bae6fd");
      root.style.setProperty("--text-primary", "#0369a1");
      root.style.setProperty("--text-secondary", "#0284c7");
      root.style.setProperty("--color-primary", "#0284c7");
      root.style.setProperty("--color-primary-hover", "#0369a1");
      root.style.setProperty("--color-orange", "#f97316");
      root.style.setProperty("--color-orange-light", "#fff7ed");
      root.style.setProperty("--bg-active-item", "#e0f2fe");
      root.style.setProperty("--text-active-item", "#0369a1");
      root.style.setProperty("--bg-hover-item", "rgba(2, 132, 199, 0.08)");
      root.style.setProperty("--bg-agent-selector", "rgba(2, 132, 199, 0.06)");
      root.style.setProperty("--bg-agent-slider", "#ffffff");
      root.style.setProperty("--shadow-agent-slider", "0 2px 4px rgba(2, 132, 199, 0.1), 0 1px 2px rgba(2, 132, 199, 0.05)");
    } else if (target === "light-orange") {
      root.style.setProperty("--bg-main", "#ffffff");
      root.style.setProperty("--bg-sidebar", "#fffcf5");
      root.style.setProperty("--bg-terminal", "#fffdfa");
      root.style.setProperty("--border-color", "#fed7aa");
      root.style.setProperty("--text-primary", "#7c2d12");
      root.style.setProperty("--text-secondary", "#ea580c");
      root.style.setProperty("--color-primary", "#c2410c");
      root.style.setProperty("--color-primary-hover", "#9a3412");
      root.style.setProperty("--color-orange", "#ea580c");
      root.style.setProperty("--color-orange-light", "#fff7ed");
      root.style.setProperty("--bg-active-item", "#ffedd5");
      root.style.setProperty("--text-active-item", "#7c2d12");
      root.style.setProperty("--bg-hover-item", "rgba(234, 88, 12, 0.08)");
      root.style.setProperty("--bg-agent-selector", "rgba(234, 88, 12, 0.05)");
      root.style.setProperty("--bg-agent-slider", "#ffffff");
      root.style.setProperty("--shadow-agent-slider", "0 2px 4px rgba(234, 88, 12, 0.08), 0 1px 2px rgba(234, 88, 12, 0.04)");
    } else {
      root.style.setProperty("--bg-main", "#ffffff");
      root.style.setProperty("--bg-sidebar", "#f8fafc");
      root.style.setProperty("--bg-terminal", "#f8fafc");
      root.style.setProperty("--border-color", "#e2e8f0");
      root.style.setProperty("--text-primary", "#1e293b");
      root.style.setProperty("--text-secondary", "#64748b");
      root.style.setProperty("--color-primary", "#2563eb");
      root.style.setProperty("--color-primary-hover", "#1d4ed8");
      root.style.setProperty("--color-orange", "#f97316");
      root.style.setProperty("--color-orange-light", "#fff7ed");
      root.style.setProperty("--bg-active-item", "#dbeafe");
      root.style.setProperty("--text-active-item", "#1e40af");
      root.style.setProperty("--bg-hover-item", "rgba(59, 130, 246, 0.08)");
      root.style.setProperty("--bg-agent-selector", "rgba(15, 23, 42, 0.05)");
      root.style.setProperty("--bg-agent-slider", "#ffffff");
      root.style.setProperty("--shadow-agent-slider", "0 2px 4px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)");
    }
  };

  const handleSelectTheme = (newTheme: string) => {
    setCurrentTheme(newTheme);
    localStorage.setItem("kkcoder_setting_theme", newTheme);
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
        setActiveSessionId(updatedTabs[updatedTabs.length - 1]);
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
          setActiveSessionId(remaining[remaining.length - 1]);
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
      localStorage.removeItem(`kkcoder_session_has_dialogue_${id}`);
    } catch (err) {
      alert(`彻底删除会话失败: ${err}`);
    }
  };

  // 🗑️ 清空回收站
  const handleEmptyTrash = async () => {
    try {
      sessions.forEach((s) => {
        if (s.deleted === 1) {
          localStorage.removeItem(`kkcoder_session_has_dialogue_${s.id}`);
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
      ids.forEach((id) => localStorage.removeItem(`kkcoder_session_has_dialogue_${id}`));
      setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
      setOpenTabIds((prev) => prev.filter((tid) => !ids.includes(tid)));
      if (ids.includes(activeSessionId)) {
        const remaining = openTabIds.filter((tid) => !ids.includes(tid));
        if (remaining.length > 0) {
          setActiveSessionId(remaining[remaining.length - 1]);
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

  // 📥 首次启动 Pi 会话后自动捕获其 session ID 并同步回 SQLite 数据库与 React 状态
  const handleCaptureSessionId = async (sessionId: string, agentSessionId: string) => {
    log(`handleCaptureSessionId triggered: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    try {
      const s = sessions.find((sess) => sess.id === sessionId);
      if (s) {
        const updatedSession = { ...s, agentSessionId };
        await invoke("add_session", { session: updatedSession });
        setSessions((prev) =>
          prev.map((sess) => (sess.id === sessionId ? updatedSession : sess))
        );
        log(`Successfully captured and updated Pi session ID in database for ${sessionId} to ${agentSessionId}`);
      }
    } catch (err) {
      log(`Failed to update captured session ID in database: ${err}`);
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
          {/* 🍊 高档黑橙 KK 矢量徽标 */}
          <div className="titlebar-logo-icon">
            KK
          </div>
          <span className="logo-title-text">KKCoder 极简 AI 终端管理器</span>
        </div>

        <div className="titlebar-actions" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="titlebar-btn ccswitch-btn"
            onClick={handleLaunchCcswitch}
            title="打开 CCSwitch"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="5" width="22" height="14" rx="7" ry="7"></rect>
              <circle cx="16" cy="12" r="3"></circle>
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
                <div className="theme-dropdown-section">
                  <div className="theme-dropdown-section-title">深色</div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "dark-blue" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("dark-blue")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#121620" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#3b82f6" }}></span>
                    </span>
                    <span className="theme-name">深空墨</span>
                  </div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "dark-purple" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("dark-purple")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#171424" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#8b5cf6" }}></span>
                    </span>
                    <span className="theme-name">赛博紫</span>
                  </div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "dark-zinc" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("dark-zinc")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#1d1b18" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#d97706" }}></span>
                    </span>
                    <span className="theme-name">琥珀金</span>
                  </div>
                </div>

                <div className="theme-dropdown-section">
                  <div className="theme-dropdown-section-title">浅色</div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "light-premium" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("light-premium")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#ffffff", border: "1px solid #e2e8f0" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#2563eb" }}></span>
                    </span>
                    <span className="theme-name">经典白</span>
                  </div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "light-orange" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("light-orange")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#ffffff", border: "1px solid #fed7aa" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#ea580c" }}></span>
                    </span>
                    <span className="theme-name">暖沙</span>
                  </div>
                  <div
                    className={`theme-dropdown-item ${currentTheme === "light-blue" ? "active" : ""}`}
                    onClick={() => handleSelectTheme("light-blue")}
                  >
                    <span className="theme-preview-dots">
                      <span className="theme-dot" style={{ backgroundColor: "#ffffff", border: "1px solid #bae6fd" }}></span>
                      <span className="theme-dot" style={{ backgroundColor: "#0284c7" }}></span>
                    </span>
                    <span className="theme-name">天空蓝</span>
                  </div>
                </div>

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
                const newVal = !showProjectTree;
                setShowProjectTree(newVal);
                localStorage.setItem("kkcoder_show_project_tree", String(newVal));
              }}
              title={showProjectTree ? "关闭工作区文件树" : "打开工作区文件树"}
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
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
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
        <main className="main-workspace">
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
                      isActive && s.type === "pi" ? "pi-tab" : ""
                    } ${isGlowing ? (s.type === "pi" ? "glowing-pi" : "glowing-claude") : ""} ${
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
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        const ev = { stopPropagation: () => {} } as React.MouseEvent;
                        handleCloseTab(ev, s.id);
                      }
                    }}
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
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        {sessionBusy[s.id] ? (
                          <span className="tab-loading-spinner" title="思考中..." />
                        ) : (
                          s.type === "claude" ? <ClaudeIcon size={14} color="#D97757" /> : <PiIcon size={14} color="var(--color-green)" />
                        )}
                        <span className="tab-title-text" title={s.isTemp ? s.name : `${s.name} (${s.project})`}>{s.isTemp ? s.name : `${s.name} (${s.project})`}</span>
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
          </div>

          {/* 终端区 / 空白提示状态 (采用 Keep-Alive 常驻 DOM 设计，防止切换 Tab 时重新初始化) */}
          <div style={{ flex: 1, display: "flex", flexDirection: "row", position: "relative", overflow: "hidden" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden", height: "100%" }}>
              {openTabIds.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-icon">🖥️</span>
                  <div className="empty-state-title">KKCoder AI 终端管理器</div>
                  <div className="empty-state-desc">
                    当前没有处于活动状态的会话标签。
                    请选择左上角的 Agent 类型并点击“**新建 AI 终端**”按钮来开启一个托管终端。
                  </div>
                </div>
              ) : (
                sessions.map((s) => {
                  const isOpen = openTabIds.includes(s.id);
                  if (!isOpen) return null;
                  const isActive = activeSessionId === s.id;
                  const shouldResume = shouldResumeSession(s.id, newSessionIds);
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
                        onCaptureSessionId={handleCaptureSessionId}
                        busy={sessionBusy[s.id] || false}
                        onStateChange={(busy) => {
                          setSessionBusy(prev => ({ ...prev, [s.id]: busy }));
                        }}
                        isActive={isActive}
                        onCommandComplete={() => handleCommandComplete(s.id)}
                        onUserSubmittedInput={handleUserSubmittedInputWithRenameReset}
                        onRenameSession={handleRenameSession}
                      />
                      {sessionBusy[s.id] && (
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
              <div 
                className="file-preview-panel"
                onContextMenu={handlePreviewContextMenu}
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
                    onClick={() => {
                      setPreviewFile(null);
                      setMdMode("source");
                    }}
                    title="关闭文件预览"
                  >
                    ×
                  </button>
                </div>
                <div className="preview-body">
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
                    <div 
                      className="preview-text-content"
                      style={{
                        fontFamily: previewFontFamily,
                        fontSize: `${previewFontSize}px`
                      }}
                    >
                      {highlightedData.tokens.map((lineTokens, idx) => {
                        const lineNum = idx + 1;
                        const isActiveMatchLine = matchedLines.length > 0 && 
                          activeMatchIndex >= 0 && 
                          activeMatchIndex < matchedLines.length && 
                          matchedLines[activeMatchIndex] === lineNum;
                        return (
                          <div 
                            key={idx} 
                            className={`preview-code-line ${isActiveMatchLine ? "active-match-line" : ""}`} 
                            data-line={lineNum}
                          >
                            <span className="line-number">{lineNum}</span>
                            <span className="line-text">
                              {lineTokens.length === 0 ? " " : lineTokens.map((t, tIdx) => renderToken(t, tIdx))}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 悬浮文件内查找输入栏 */}
                {showFileSearchBar && (
                  <div className="file-search-bar-floating">
                    <input 
                      id="file-search-input"
                      type="text" 
                      placeholder="查找内容..." 
                      className="file-search-bar-input"
                      value={fileSearchQuery}
                      onChange={(e) => handleFileSearchChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (e.shiftKey) {
                            if (matchedLines.length > 0) {
                              setActiveMatchIndex(prev => (prev - 1 + matchedLines.length) % matchedLines.length);
                            }
                          } else {
                            if (matchedLines.length > 0) {
                              setActiveMatchIndex(prev => (prev + 1) % matchedLines.length);
                            }
                          }
                        }
                      }}
                    />
                    <span className="file-search-bar-count">
                      {matchedLines.length > 0 ? `${activeMatchIndex + 1}/${matchedLines.length}` : "0/0"}
                    </span>
                    <button 
                      className="file-search-bar-nav-btn"
                      onClick={() => {
                        if (matchedLines.length > 0) {
                          setActiveMatchIndex(prev => (prev - 1 + matchedLines.length) % matchedLines.length);
                        }
                      }}
                      title="上一个"
                    >
                      ▲
                    </button>
                    <button 
                      className="file-search-bar-nav-btn"
                      onClick={() => {
                        if (matchedLines.length > 0) {
                          setActiveMatchIndex(prev => (prev + 1) % matchedLines.length);
                        }
                      }}
                      title="下一个"
                    >
                      ▼
                    </button>
                    <button 
                      className="file-search-bar-close-btn"
                      onClick={() => {
                        setShowFileSearchBar(false);
                        setFileSearchQuery("");
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}

                {/* 悬浮跳转行号输入栏 */}
                {showGoToLineBar && (
                  <div className="file-search-bar-floating go-to-line-bar">
                    <input 
                      id="go-to-line-input"
                      type="text" 
                      placeholder="输入行号并回车..." 
                      className="file-search-bar-input"
                      value={goToLineNumber}
                      onChange={(e) => setGoToLineNumber(e.target.value.replace(/\D/g, ""))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleGoToLine();
                        }
                      }}
                    />
                    <button 
                      className="file-search-bar-go-btn"
                      onClick={handleGoToLine}
                    >
                      跳转
                    </button>
                    <button 
                      className="file-search-bar-close-btn"
                      onClick={() => {
                        setShowGoToLineBar(false);
                        setGoToLineNumber("");
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 新增的队列列表面板 */}
          {queue.length > 0 && (
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
                  <span>任务队列 ({queue.length})</span>
                </div>
                <button 
                  className="queue-clear-btn"
                  onClick={() => setQueue([])}
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
                {queue.map((task, index) => (
                  <div key={task.id} className="queue-item">
                    <span className="queue-item-index">{index + 1}</span>
                    <span className="queue-item-text">{task.prompt}</span>
                    <button
                      className="queue-item-delete"
                      onClick={() => setQueue(prev => prev.filter(t => t.id !== task.id))}
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
                  className={`folder-button ${activeSession.type === "pi" ? "pi-hover" : ""}`}
                  onClick={handleOpenFolder}
                  title={`项目物理路径: ${activeSession.path}\n点击在 Windows 资源管理器中打开`}
                >
                  <svg className="folder-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="#EAB308" stroke="#EAB308" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.95, marginRight: "4px" }}>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                  <span>{getFolderName(activeSession.path)}</span>
                </button>

                <button
                  className={`md-button ${activeSession.type === "pi" ? "pi-hover" : ""}`}
                  onClick={() => setShowMdEditor(true)}
                  title={activeSession.type === "pi" ? "快速生成/编辑 AGENTS.md" : "快速生成/编辑 CLAUDE.md"}
                >
                  <svg className="doc-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "2px", opacity: 0.85 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                  <span>{activeSession.type === "pi" ? "AGENTS.md" : "CLAUDE.md"}</span>
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
                  {queue.length > 0 && (
                    <span className="queue-badge">{queue.length}</span>
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
                  {activeSession.type === "claude" ? claudeVersion : "Pi 终端"}
                </span>
              ) : (
                <span>{claudeVersion} 准备就绪</span>
              )}
            </div>
          </div>
        </main>

        {showProjectTree && !activeSession?.isTemp && (
          <>
            <div 
              className={`project-tree-resizer ${isResizingProjectTree ? "dragging" : ""}`} 
              onMouseDown={startProjectTreeResize} 
              data-agent-type={activeSession?.type || "claude"}
            />
            <aside 
              className="project-tree-aside"
              style={{ width: `${projectTreeWidth}px` }}
            >
              <div className="project-tree-aside-header">
                <span className="aside-header-title">项目文件</span>
                {activeSession && activeSession.path && (
                  <span className="aside-header-path" title={activeSession.path}>
                    {activeSession.path.split(/[/\\]/).pop()}
                  </span>
                )}
              </div>
              {activeSession && activeSession.path ? (
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
              )}
            </aside>
          </>
        )}

        {previewContextMenu && previewFile && (
          <div 
            className="tree-context-menu"
            style={{
              position: "fixed",
              left: `${previewContextMenu.x}px`,
              top: `${previewContextMenu.y}px`,
              zIndex: 9999,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              onClick={() => {
                const isSingleLine = previewContextMenu.startLine === previewContextMenu.endLine;
                const rangeStr = isSingleLine 
                  ? `L${previewContextMenu.startLine}` 
                  : `L${previewContextMenu.startLine}-L${previewContextMenu.endLine}`;
                const data = `"${previewFile.path}":${rangeStr} `;
                
                insertConversationTagToActiveTerminal(data);
                
                setPreviewContextMenu(null);
              }}
            >
              添加到对话
            </button>
          </div>
        )}
      </div>

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
          filename={activeSession.type === "pi" ? "AGENTS.md" : "CLAUDE.md"}
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
                <span>当前队列: {queue.length}/2</span>
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
              <span className="modal-title" style={{ fontSize: "15px", fontWeight: 700 }}>退出 KKCoder</span>
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
                    localStorage.setItem("kkcoder_setting_close_behavior", "minimize");
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
                    localStorage.setItem("kkcoder_setting_close_behavior", "exit");
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
                          {s.type === "claude" ? "claude-code" : "pi"} · {s.path}
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
    </div>
  );
}

export default App;
