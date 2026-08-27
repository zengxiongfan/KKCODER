import React, { useState, useEffect, useCallback } from "react";
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Bug,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  FolderKanban,
  Globe,
  Info,
  Keyboard,
  Layers,
  MessageSquare,
  Palette,
  Sliders,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

const GitHubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = "" }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

/** 导航栏 Claude 品牌图标：ClaudeIcon 用 currentColor 会跟随文字色变灰，
 *  这里显式补上品牌橙（对齐原版设置页 <ClaudeIcon color="#D97757" />） */
const ClaudeNavIcon: React.FC<{ size?: number }> = ({ size }) => (
  <ClaudeIcon size={size} color="#D97757" />
);

/** 导航栏 Codex 品牌图标：补上品牌绿（对齐原版设置页 <CodexIcon color="var(--color-green)" />） */
const CodexNavIcon: React.FC<{ size?: number }> = ({ size }) => (
  <CodexIcon size={size} color="var(--color-green, #22c55e)" />
);
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { ClaudeIcon, CodexIcon, CcSwitchIcon } from "./Sidebar";
import {
  DEFAULT_SESSION_CLEANUP_DAYS,
  MIN_SESSION_CLEANUP_DAYS,
  normalizeSessionCleanupDays,
  SESSION_CLEANUP_DAYS_KEY,
  SESSION_CLEANUP_ENABLED_KEY,
} from "../utils/sessionCleanup";
import {
  CLAUDE_TERMINAL_MODE_KEY,
  resolveClaudeTerminalMode,
  type ClaudeTerminalMode,
} from "../utils/terminalMode";
import {
  CLAUDE_INTERACTION_MODE_KEY,
  CLAUDE_INTERACTION_MODE_CHANGE_EVENT,
  resolveClaudeInteractionMode,
  type ClaudeInteractionMode,
} from "../utils/interactionMode";
import { RemoteSettingsPanel } from "./RemoteSettingsPanel";
import {
  TERMINAL_SCHEME_MODE_KEY,
  TERMINAL_SCHEME_JSON_KEY,
  resolveTerminalSchemeMode,
  parseWindowsTerminalScheme,
  dispatchTerminalSchemeChange,
  type TerminalSchemeMode,
} from "../utils/terminalScheme";
import { applyTheme, readStoredTheme, THEME_STORAGE_KEY, THEME_DEFINITIONS } from "../utils/theme";
import agentdeskIcon from "../assets/brand/agentdesk-icon.png";
import { log, isDebugLogEnabled, DEBUG_LOG_KEY } from "../utils/log";
import { notifyError, notifySuccess, formatFeedbackError } from "../utils/appFeedback";

// 会话名称修正 localStorage keys
const AUTO_RENAME_ON_STARTUP_KEY = "kkcoder_setting_auto_rename_startup";
const AUTO_RENAME_ON_IDLE_KEY = "kkcoder_setting_auto_rename_idle";
const AUTO_RENAME_SKIP_FAVORITES_KEY = "kkcoder_setting_auto_rename_skip_favorites";
const NAMER_MODE_KEY = "kkcoder_setting_namer_mode";
const LLM_API_URL_KEY = "kkcoder_setting_llm_api_url";
const LLM_API_KEY_KEY = "kkcoder_setting_llm_api_key";
const LLM_MODEL_KEY = "kkcoder_setting_llm_model";
const IDLE_MINUTES_KEY = "kkcoder_setting_idle_minutes";

// CLI 工具 npm 包名
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const CODEX_NPM_PACKAGE = "@openai/codex";

interface RenameResult {
  session_id: string;
  old_name: string;
  new_name: string;
  changed: boolean;
}


type SettingsMenuId =
  | "basic"
  | "claude"
  | "codex"
  | "chat"
  | "ccswitch"
  | "terminal"
  | "preview"
  | "notifications"
  | "shortcuts"
  | "sessions"
  | "remote"
  | "debug"
  | "about";

interface SettingsMenuEntry {
  id: SettingsMenuId;
  label: string;
  group: string;
  description: string;
}

const SETTINGS_MENU: SettingsMenuEntry[] = [
  { id: "basic", label: "常规外观", group: "基础设置", description: "主题配色、界面语言与窗口关闭行为" },
  { id: "claude", label: "Claude Code", group: "基础设置", description: "Claude Code 安装版本、更新检测与安装命令" },
  { id: "codex", label: "Codex", group: "基础设置", description: "Codex 安装版本、更新检测与安装命令" },
  { id: "chat", label: "GUI 界面", group: "基础设置", description: "GUI 聊天对话、命令记录与思考过程展示" },
  { id: "ccswitch", label: "CC Switch", group: "基础设置", description: "CC Switch 助手配置切换器路径" },
  { id: "terminal", label: "CLI 终端", group: "基础设置", description: "终端字体、字号、配色、兼容模式与回滚缓冲" },
  { id: "preview", label: "文件预览", group: "基础设置", description: "右侧预览面板与 Monaco 代码编辑器字体与字号" },
  { id: "notifications", label: "通知音效", group: "基础设置", description: "AI 回答完成通知、提示音色与音量调节" },
  { id: "shortcuts", label: "短语与工具", group: "基础设置", description: "底部状态栏常用短语配置与第三方工具切换" },
  { id: "sessions", label: "会话管理", group: "管理", description: "会话历史自动清理与 AI 自动命名" },
  { id: "remote", label: "远程访问", group: "管理", description: "远程访问 / FRP 穿透 / 设备配对" },
  { id: "debug", label: "调试日志", group: "其他", description: "调试日志开关与一键清理" },
  { id: "about", label: "关于", group: "其他", description: "版本信息与致谢" },
];

const SETTINGS_GROUPS = ["基础设置", "管理", "其他"] as const;

/** 左侧菜单项图标（align CC-GUI settings-nav 带图标样式；Claude/CC Switch 保留原始品牌图标） */
const SETTINGS_NAV_ICONS: Record<SettingsMenuId, React.ElementType> = {
  basic: Palette,
  claude: ClaudeNavIcon,
  codex: CodexNavIcon,
  chat: MessageSquare,
  ccswitch: CcSwitchIcon,
  terminal: TerminalSquare,
  preview: FileText,
  notifications: Bell,
  shortcuts: Keyboard,
  sessions: FolderKanban,
  remote: Globe,
  debug: Bug,
  about: Info,
};

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  onSessionsRenamed?: () => void; // 修正完成后刷新会话列表
}

// ==================== CLI 工具设置面板 (Claude Code 原始版式) ====================

interface CliToolPanelProps {
  Icon: React.FC<{ size?: number; color?: string }>;
  iconColor: string;
  title: string;
  packageName: string;
  installedVersion: string;
  onCheckLatest: () => Promise<{ latest: string; isLatest: boolean }>;
}

const CliToolPanel: React.FC<CliToolPanelProps> = ({
  Icon,
  iconColor,
  title,
  packageName,
  installedVersion,
  onCheckLatest,
}) => {
  const installCmd = `npm install -g ${packageName}`;
  const updateCmd = `npm install -g ${packageName}@latest`;
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [latestResult, setLatestResult] = useState<{
    latest: string;
    isLatest: boolean;
  } | null>(null);

  const handleCopy = (cmd: string) => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1500);
    }).catch(() => {});
  };

  const versionLabel = installedVersion && installedVersion !== title ? installedVersion : "未检测到（未安装）";
  const versionMissing = !installedVersion || installedVersion === title;

  const handleCheck = async (): Promise<void> => {
    setChecking(true);
    setLatestResult(null);
    try {
      const result = await onCheckLatest();
      setLatestResult(result);
    } catch (err) {
      setLatestResult(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-content">
      {/* 标题与图标 */}
      <div className="settings-group">
        <div className="cli-tool-header">
          <Icon size={28} color={iconColor} />
          <div className="cli-tool-header-info">
            <div className="cli-tool-title">{title}</div>
            <div className={`cli-tool-version ${versionMissing ? "missing" : ""}`}>
              {versionMissing && <span style={{ color: "var(--color-danger, #e5484d)" }}>● </span>}
              {versionLabel}
            </div>
          </div>
          <button
            className="settings-toggle-btn"
            onClick={handleCheck}
            disabled={checking}
            title="联网检测 npm 上的最新版本"
          >
            {checking ? "检测中..." : "检测版本更新"}
          </button>
        </div>
      </div>

      {/* 检测结果 */}
      {latestResult && (
        <div className="settings-group">
          <div className="settings-group-label">版本更新检测</div>
          <div className="cli-check-result">
            {latestResult.isLatest ? (
              <div className="cli-check-latest">
                <span className="cli-check-icon">✓</span>
                <span>当前已是最新版本</span>
                <span className="cli-check-version">v{latestResult.latest}</span>
              </div>
            ) : (
              <div className="cli-check-outdated">
                <span className="cli-check-icon">⬆</span>
                <div className="cli-check-info">
                  <span>有新版本可用：<strong>v{latestResult.latest}</strong></span>
                  <span className="cli-check-hint">请使用下方更新命令升级</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* npm 安装命令 */}
      <div className="settings-group">
        <div className="settings-group-label">安装命令</div>
        <div className="cli-cmd-row">
          <code className="cli-cmd">{installCmd}</code>
          <button
            className={`cli-copy-btn ${copiedCmd === installCmd ? "copied" : ""}`}
            onClick={() => handleCopy(installCmd)}
          >
            {copiedCmd === installCmd ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      {/* npm 更新命令 */}
      <div className="settings-group">
        <div className="settings-group-label">更新命令（安装最新版）</div>
        <div className="cli-cmd-row">
          <code className="cli-cmd">{updateCmd}</code>
          <button
            className={`cli-copy-btn ${copiedCmd === updateCmd ? "copied" : ""}`}
            onClick={() => handleCopy(updateCmd)}
          >
            {copiedCmd === updateCmd ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ show, onClose, onSessionsRenamed }) => {
  const [activeMenu, setActiveMenu] = useState<SettingsMenuId>("basic");
  const [showFilePicker, setShowFilePicker] = useState(false);
  // 返回应用：先播放退场动画再真正关闭（丝滑返回）
  const [closing, setClosing] = useState(false);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      setClosing(false);
      onClose();
    }, 180);
  }, [closing, onClose]);

  // 无边框窗口拖拽（对齐主界面 custom-titlebar：左键拖曳移动，双击最大化）。
  // 设置页盖住了主标题栏，须在自身顶部拖拽区接管 startDragging
  const handleDragMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const win = getCurrentWindow();
    if (e.detail === 2) {
      win.toggleMaximize().catch((err) => log(`Failed to toggle maximize: ${err}`));
    } else {
      win.startDragging().catch((err) => log(`Failed to start window dragging: ${err}`));
    }
  };

  useEffect(() => {
    if (show) {
      setShowFilePicker(false);
    }
  }, [show]);

  // 播放提示音效预览（不显示通知气泡）
  const triggerPreview = (tone: string, volume: number) => {
    invoke("play_notification_sound", {
      tone,
      volume,
      title: null,
      message: null,
    }).catch((err) => console.error("播放音效预览失败:", err));
  };

  // --- 1. 读取并配置各项通用设置 (持久化存储) ---
  const [theme, setTheme] = useState<string>(() => {
    return readStoredTheme();
  });
  // 调试日志开关（默认开启）
  const [debugLogEnabled, setDebugLogEnabled] = useState<boolean>(() => isDebugLogEnabled());
  // 清理中状态，防止重复点击
  const [clearingLogs, setClearingLogs] = useState(false);
  // Language state removed to satisfy TS6133 strict check
  const [closeBehavior, setCloseBehavior] = useState<string>(() => {
    return localStorage.getItem("kkcoder_setting_close_behavior") || "exit";
  });
  const [notifyOnComplete, setNotifyOnComplete] = useState<boolean>(() => {
    const val = localStorage.getItem("kkcoder_setting_notify_on_complete");
    return val === null ? true : val === "true";
  });
  const [notifyThreshold, setNotifyThreshold] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_notify_threshold");
    return val === null ? 2.0 : parseFloat(val);
  });
  const [playSound, setPlaySound] = useState<boolean>(() => {
    const val = localStorage.getItem("kkcoder_setting_play_sound");
    return val === null ? true : val === "true";
  });
  const [soundTone, setSoundTone] = useState<string>(() => {
    const stored = localStorage.getItem("kkcoder_setting_sound_tone");
    // 新音色体系（CC GUI）：default/chime/bell/ding/success；旧值兼容归一
    if (stored === "chime" || stored === "bell" || stored === "ding" || stored === "success") {
      return stored;
    }
    if (stored === "crystal") return "chime";
    if (stored === "dream") return "success";
    if (stored === "dingdong") return "ding";
    return "default";
  });
  const [soundVolume, setSoundVolume] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_sound_volume");
    return val === null ? 80 : parseInt(val, 10);
  });
  const [fontFamily, setFontFamily] = useState<string>(() => {
    return localStorage.getItem("kkcoder_setting_font_family") || "Cascadia Mono";
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_font_size");
    return val === null ? 13.5 : parseFloat(val);
  });
  const [previewFontFamily, setPreviewFontFamily] = useState<string>(() => {
    return localStorage.getItem("kkcoder_setting_preview_font_family") || "monospace";
  });
  const [previewFontSize, setPreviewFontSize] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_preview_font_size");
    return val === null ? 12.5 : parseFloat(val);
  });
  const [scrollback, setScrollback] = useState<number>(() => {
    const val = localStorage.getItem("kkcoder_setting_scrollback");
    return val === null ? 10000 : parseInt(val, 10);
  });
  const [claudeTerminalMode, setClaudeTerminalMode] = useState<ClaudeTerminalMode>(() => {
    return resolveClaudeTerminalMode(localStorage.getItem(CLAUDE_TERMINAL_MODE_KEY));
  });
  const [claudeInteractionMode, setClaudeInteractionMode] = useState<ClaudeInteractionMode>(() => {
    return resolveClaudeInteractionMode(localStorage.getItem(CLAUDE_INTERACTION_MODE_KEY));
  });

  // --- Claude Code / Codex CLI 工具版本（原版 CLI 工具面板） ---
  const [claudeInstalled, setClaudeInstalled] = useState<string>(() => {
    return localStorage.getItem("agentdesk_cached_claude_version") || "";
  });
  const [codexInstalled, setCodexInstalled] = useState<string>(() => {
    return localStorage.getItem("agentdesk_cached_codex_version") || "";
  });

  // 从 "Claude Code 2.1.206" 提取纯版本号 "2.1.206"
  const extractVersionNumber = (ver: string): string => {
    const match = ver.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : ver.replace(/^[^\d]*/, "").trim();
  };

  // 刷新本地已安装版本
  const refreshClaudeInstalled = () => {
    invoke<string>("get_claude_version")
      .then((ver) => {
        setClaudeInstalled(ver);
        localStorage.setItem("agentdesk_cached_claude_version", ver);
        window.dispatchEvent(new CustomEvent("agentdesk-claude-version-change", { detail: ver }));
      })
      .catch(() => {});
  };
  const refreshCodexInstalled = () => {
    invoke<string>("get_codex_version")
      .then((ver) => {
        const normalized = (() => {
          const trimmed = ver.trim();
          const m = trimmed.match(/^codex[-_]?(cli|client)?\s*[:\-]?\s*(.*)$/i);
          if (m) {
            const version = (m[2] || "").trim();
            return version ? `Codex ${version}` : "Codex";
          }
          return trimmed ? `Codex ${trimmed}` : "Codex";
        })();
        setCodexInstalled(normalized);
        localStorage.setItem("agentdesk_cached_codex_version", normalized);
        window.dispatchEvent(new CustomEvent("agentdesk-codex-version-change", { detail: normalized }));
      })
      .catch(() => {});
  };

  // 检测 Claude Code 最新版本（返回 npm 最新版号 + 是否与本地一致）
  const checkClaudeLatest = async (): Promise<{ latest: string; isLatest: boolean }> => {
    const latest = await invoke<string>("get_claude_latest_version");
    // 同步刷新本地版本显示
    refreshClaudeInstalled();
    const latestNum = latest.trim();
    const installedNum = extractVersionNumber(claudeInstalled);
    const isLatest = installedNum === latestNum;
    return { latest: latestNum, isLatest };
  };

  // 检测 Codex 最新版本
  const checkCodexLatest = async (): Promise<{ latest: string; isLatest: boolean }> => {
    const latest = await invoke<string>("get_codex_latest_version");
    refreshCodexInstalled();
    const latestNum = latest.trim();
    const installedNum = extractVersionNumber(codexInstalled);
    const isLatest = installedNum === latestNum;
    return { latest: latestNum, isLatest };
  };

  useEffect(() => {
    refreshClaudeInstalled();
    refreshCodexInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  // 命令记录自动折叠（GUI 聊天多条命令时折叠为一行摘要）
  const COLLAPSE_TOOLS_KEY = "kkcoder_setting_collapse_tool_cards";
  const [collapseToolCards, setCollapseToolCards] = useState<boolean>(() => {
    const val = localStorage.getItem(COLLAPSE_TOOLS_KEY);
    return val === null ? true : val === "true";
  });
  // 思考过程显示：聚合（合并为一块，默认）/ 分开（被工具打断的多段思考各自成块）
  const SPLIT_REASONING_KEY = "kkcoder_setting_split_reasoning";
  const [splitReasoning, setSplitReasoning] = useState<boolean>(() => {
    return localStorage.getItem(SPLIT_REASONING_KEY) === "true";
  });
  const [terminalSchemeMode, setTerminalSchemeMode] = useState<TerminalSchemeMode>(() => {
    return resolveTerminalSchemeMode(localStorage.getItem(TERMINAL_SCHEME_MODE_KEY));
  });
  const [terminalSchemeJson, setTerminalSchemeJson] = useState<string>(() => {
    return localStorage.getItem(TERMINAL_SCHEME_JSON_KEY) || "";
  });
  const [terminalSchemeError, setTerminalSchemeError] = useState<string>("");
  const [terminalSchemeName, setTerminalSchemeName] = useState<string>(() => {
    const raw = localStorage.getItem(TERMINAL_SCHEME_JSON_KEY);
    if (!raw) return "";
    const parsed = parseWindowsTerminalScheme(raw);
    return parsed.ok ? (parsed.scheme.name || "自定义") : "";
  });
  const [sessionCleanupEnabled, setSessionCleanupEnabled] = useState<boolean>(() => {
    return localStorage.getItem(SESSION_CLEANUP_ENABLED_KEY) === "true";
  });
  const [sessionCleanupDays, setSessionCleanupDays] = useState<number>(() => {
    return normalizeSessionCleanupDays(localStorage.getItem(SESSION_CLEANUP_DAYS_KEY));
  });

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
          // 确保长度为 3，若不足补齐，若超出截断
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

  const [ccswitchPath, setCcswitchPath] = useState<string>(() => {
    return localStorage.getItem("kkcoder_setting_ccswitch_path") || "";
  });

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_ccswitch_path", ccswitchPath);
    window.dispatchEvent(new CustomEvent("kkcoder-ccswitch-path-change", { detail: ccswitchPath }));
  }, [ccswitchPath]);

  // --- 调试日志开关与一键清理 ---
  const handleToggleDebugLog = (enabled: boolean) => {
    if (enabled) {
      // 先开启再记录，让"启用"这一动作留痕
      localStorage.setItem(DEBUG_LOG_KEY, "true");
      setDebugLogEnabled(true);
      log("[debug-log] enabled via settings");
    } else {
      // 先记录再关闭，让"关闭"这一动作留痕
      log("[debug-log] disabled via settings");
      localStorage.setItem(DEBUG_LOG_KEY, "false");
      setDebugLogEnabled(false);
    }
    invoke("set_debug_log_enabled", { enabled }).catch((err) => {
      notifyError(`同步日志开关失败：${formatFeedbackError(err)}`);
    });
  };

  const handleClearLogs = async () => {
    if (clearingLogs) return;
    setClearingLogs(true);
    try {
      await invoke("clear_log_files");
      notifySuccess("日志文件已清理");
    } catch (err) {
      notifyError(`清理日志失败：${formatFeedbackError(err)}`);
    } finally {
      setClearingLogs(false);
    }
  };



  // --- 会话名称修正设置 ---
  const [autoRenameOnStartup, setAutoRenameOnStartup] = useState<boolean>(() => {
    return localStorage.getItem(AUTO_RENAME_ON_STARTUP_KEY) === "true";
  });
  const [autoRenameOnIdle, setAutoRenameOnIdle] = useState<boolean>(() => {
    return localStorage.getItem(AUTO_RENAME_ON_IDLE_KEY) === "true";
  });
  const [autoRenameSkipFavorites, setAutoRenameSkipFavorites] = useState<boolean>(() => {
    const val = localStorage.getItem(AUTO_RENAME_SKIP_FAVORITES_KEY);
    return val === null ? true : val === "true";
  });
  const [isRenaming, setIsRenaming] = useState(false);
  const [lastRenameResult, setLastRenameResult] = useState<string | null>(null);

  // LLM 模式配置
  const [namerMode, setNamerMode] = useState<"heuristic" | "llm">(() => {
    return (localStorage.getItem(NAMER_MODE_KEY) as "heuristic" | "llm") || "heuristic";
  });
  const [llmApiUrl, setLlmApiUrl] = useState<string>(() => {
    return localStorage.getItem(LLM_API_URL_KEY) || "https://api.deepseek.com";
  });
  const [llmApiKey, setLlmApiKey] = useState<string>(() => {
    return localStorage.getItem(LLM_API_KEY_KEY) || "";
  });
  const [llmModel, setLlmModel] = useState<string>(() => {
    return localStorage.getItem(LLM_MODEL_KEY) || "deepseek-v4-flash";
  });
  const [idleMinutes, setIdleMinutes] = useState<number>(() => {
    const val = localStorage.getItem(IDLE_MINUTES_KEY);
    return val === null ? 5 : parseInt(val, 10);
  });


  // --- 2. 写入各项设置至 localStorage ---
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent("kkcoder-theme-change", { detail: theme }));
    log(`[settings] theme -> ${theme}`);
  }, [theme]);

  // 监听外部（如调色盘）的主题变动事件以同步本地 theme 状态
  useEffect(() => {
    const handleExternalThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      const newTheme = customEvent.detail;
      if (newTheme !== theme) {
        setTheme(newTheme);
      }
    };
    window.addEventListener("kkcoder-theme-change", handleExternalThemeChange);
    return () => {
      window.removeEventListener("kkcoder-theme-change", handleExternalThemeChange);
    };
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_close_behavior", closeBehavior);
  }, [closeBehavior]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_notify_on_complete", String(notifyOnComplete));
    localStorage.setItem("agentdesk_setting_notify_on_complete", String(notifyOnComplete));
  }, [notifyOnComplete]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_notify_threshold", String(notifyThreshold));
    localStorage.setItem("agentdesk_setting_notify_threshold", String(notifyThreshold));
  }, [notifyThreshold]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_play_sound", String(playSound));
    localStorage.setItem("agentdesk_setting_play_sound", String(playSound));
  }, [playSound]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_sound_tone", soundTone);
    localStorage.setItem("agentdesk_setting_sound_tone", soundTone);
  }, [soundTone]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_sound_volume", String(soundVolume));
    localStorage.setItem("agentdesk_setting_sound_volume", String(soundVolume));
  }, [soundVolume]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_font_family", fontFamily);
    localStorage.setItem("agentdesk_setting_font_family", fontFamily);
    window.dispatchEvent(new CustomEvent("kkcoder-font-change", { detail: fontFamily }));
    window.dispatchEvent(new CustomEvent("agentdesk-font-change", { detail: fontFamily }));
  }, [fontFamily]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_font_size", String(fontSize));
    localStorage.setItem("agentdesk_setting_font_size", String(fontSize));
    window.dispatchEvent(new CustomEvent("kkcoder-font-size-change", { detail: fontSize }));
    window.dispatchEvent(new CustomEvent("agentdesk-font-size-change", { detail: fontSize }));
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_preview_font_family", previewFontFamily);
    window.dispatchEvent(new CustomEvent("kkcoder-preview-font-change", { detail: previewFontFamily }));
  }, [previewFontFamily]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_preview_font_size", String(previewFontSize));
    window.dispatchEvent(new CustomEvent("kkcoder-preview-font-size-change", { detail: previewFontSize }));
  }, [previewFontSize]);

  useEffect(() => {
    localStorage.setItem(SESSION_CLEANUP_ENABLED_KEY, String(sessionCleanupEnabled));
  }, [sessionCleanupEnabled]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_scrollback", String(scrollback));
    localStorage.setItem("agentdesk_setting_scrollback", String(scrollback));
  }, [scrollback]);

  useEffect(() => {
    localStorage.setItem(CLAUDE_TERMINAL_MODE_KEY, claudeTerminalMode);
    window.dispatchEvent(new CustomEvent("kkcoder-claude-terminal-mode-change", {
      detail: claudeTerminalMode,
    }));
    log(`[settings] claude terminal mode -> ${claudeTerminalMode}`);
  }, [claudeTerminalMode]);

  useEffect(() => {
    localStorage.setItem(CLAUDE_INTERACTION_MODE_KEY, claudeInteractionMode);
    window.dispatchEvent(new CustomEvent(CLAUDE_INTERACTION_MODE_CHANGE_EVENT, {
      detail: claudeInteractionMode,
    }));
    log(`[settings] claude interaction mode -> ${claudeInteractionMode}`);
  }, [claudeInteractionMode]);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_TOOLS_KEY, String(collapseToolCards));
  }, [collapseToolCards]);

  useEffect(() => {
    localStorage.setItem(SPLIT_REASONING_KEY, String(splitReasoning));
  }, [splitReasoning]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_SCHEME_MODE_KEY, terminalSchemeMode);
    dispatchTerminalSchemeChange();
  }, [terminalSchemeMode]);

  // --- 关于页面状态与辅助函数 ---
  const [copiedVersion, setCopiedVersion] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  const handleCopyVersion = () => {
    navigator.clipboard.writeText("AgentDesk v1.2.0").then(() => {
      setCopiedVersion(true);
      notifySuccess("版本号已复制到剪贴板");
      setTimeout(() => setCopiedVersion(false), 2000);
    });
  };

  const handleCopyDiagnosticInfo = () => {
    const diag = [
      `=== AgentDesk Diagnostic Info ===`,
      `Version: v1.2.0`,
      `Platform: ${navigator.userAgent}`,
      `Theme: ${theme}`,
      `Claude Terminal Mode: ${claudeTerminalMode}`,
      `Interaction Mode: ${claudeInteractionMode}`,
      `Repository: https://github.com/zengxiongfan/KKCODER (branch: simon-dev)`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n");
    navigator.clipboard.writeText(diag).then(() => {
      setCopiedDiag(true);
      notifySuccess("系统诊断信息已复制");
      setTimeout(() => setCopiedDiag(false), 2000);
    });
  };

  const openExternalUrl = (url: string) => {
    import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(url))
      .catch(() => window.open(url, "_blank"));
  };

  const applyCustomScheme = () => {
    const result = parseWindowsTerminalScheme(terminalSchemeJson);
    if (!result.ok) {
      setTerminalSchemeError(result.error);
      return;
    }
    setTerminalSchemeError("");
    setTerminalSchemeName(result.scheme.name || "自定义");
    // 规范化后存一份，确保下次加载稳定
    const normalized = JSON.stringify(
      {
        name: result.scheme.name || "Custom",
        background: result.theme.background,
        foreground: result.theme.foreground,
        cursorColor: result.theme.cursor,
        selectionBackground: result.theme.selectionBackground,
        black: result.theme.black,
        red: result.theme.red,
        green: result.theme.green,
        yellow: result.theme.yellow,
        blue: result.theme.blue,
        purple: result.theme.magenta,
        cyan: result.theme.cyan,
        white: result.theme.white,
        brightBlack: result.theme.brightBlack,
        brightRed: result.theme.brightRed,
        brightGreen: result.theme.brightGreen,
        brightYellow: result.theme.brightYellow,
        brightBlue: result.theme.brightBlue,
        brightPurple: result.theme.brightMagenta,
        brightCyan: result.theme.brightCyan,
        brightWhite: result.theme.brightWhite,
      },
      null,
      2,
    );
    setTerminalSchemeJson(normalized);
    localStorage.setItem(TERMINAL_SCHEME_JSON_KEY, normalized);
    setTerminalSchemeMode("custom");
    dispatchTerminalSchemeChange();
  };

  useEffect(() => {
    localStorage.setItem(SESSION_CLEANUP_DAYS_KEY, String(normalizeSessionCleanupDays(sessionCleanupDays)));
  }, [sessionCleanupDays]);

  useEffect(() => {
    localStorage.setItem("kkcoder_shortcuts_enabled", String(shortcutsEnabled));
    localStorage.setItem("agentdesk_shortcuts_enabled", String(shortcutsEnabled));
    window.dispatchEvent(new Event("kkcoder-shortcuts-change"));
    window.dispatchEvent(new Event("agentdesk-shortcuts-change"));
  }, [shortcutsEnabled]);

  useEffect(() => {
    localStorage.setItem("kkcoder_shortcuts_list", JSON.stringify(shortcutsList));
    localStorage.setItem("agentdesk_shortcuts_list", JSON.stringify(shortcutsList));
    window.dispatchEvent(new Event("kkcoder-shortcuts-change"));
    window.dispatchEvent(new Event("agentdesk-shortcuts-change"));
  }, [shortcutsList]);

  useEffect(() => {
    localStorage.setItem(AUTO_RENAME_ON_STARTUP_KEY, String(autoRenameOnStartup));
  }, [autoRenameOnStartup]);

  useEffect(() => {
    localStorage.setItem(AUTO_RENAME_ON_IDLE_KEY, String(autoRenameOnIdle));
  }, [autoRenameOnIdle]);

  useEffect(() => {
    localStorage.setItem(AUTO_RENAME_SKIP_FAVORITES_KEY, String(autoRenameSkipFavorites));
  }, [autoRenameSkipFavorites]);

  useEffect(() => {
    localStorage.setItem(NAMER_MODE_KEY, namerMode);
  }, [namerMode]);

  useEffect(() => {
    localStorage.setItem(LLM_API_URL_KEY, llmApiUrl);
  }, [llmApiUrl]);

  useEffect(() => {
    localStorage.setItem(LLM_API_KEY_KEY, llmApiKey);
  }, [llmApiKey]);

  useEffect(() => {
    localStorage.setItem(LLM_MODEL_KEY, llmModel);
  }, [llmModel]);

  useEffect(() => {
    localStorage.setItem(IDLE_MINUTES_KEY, String(idleMinutes));
  }, [idleMinutes]);


  // 监听键盘 ESC 键关闭设置弹窗与子弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showFilePicker) {
          setShowFilePicker(false);
        } else {
          handleClose();
        }
      }
    };
    if (show) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [show, handleClose, showFilePicker]);

  if (!show) return null;

  const activeMenuEntry = SETTINGS_MENU.find((item) => item.id === activeMenu);
  const menuTitle = activeMenuEntry?.label ?? "设置";
  const menuDescription = activeMenuEntry?.description ?? "";

  // 手动触发修正
  const handleManualRename = async () => {
    if (isRenaming) return;
    setIsRenaming(true);
    setLastRenameResult(null);
    try {
      let results: RenameResult[];
      if (namerMode === "llm") {
        if (!llmApiKey.trim()) {
          setLastRenameResult("请先填写 API Key");
          setIsRenaming(false);
          return;
        }
        let lastTimes: Record<string, number> = {};
        try { lastTimes = JSON.parse(localStorage.getItem("kkcoder_last_rename_times") || "{}"); } catch {}
        results = await invoke<RenameResult[]>("llm_rename_sessions", {
          apiUrl: llmApiUrl,
          apiKey: llmApiKey,
          model: llmModel,
          skipFavorites: autoRenameSkipFavorites,
          projectFilter: null,
          lastRenameTimes: JSON.stringify(lastTimes),
        });
        // 更新修正时间表
        const now = Date.now() / 1000;
        for (const r of results.filter((r) => r.changed)) {
          lastTimes[r.session_id] = now;
        }
        try { localStorage.setItem("kkcoder_last_rename_times", JSON.stringify(lastTimes)); } catch {}
      } else {
        results = await invoke<RenameResult[]>("auto_rename_sessions", {
          skipFavorites: autoRenameSkipFavorites,
          projectFilter: null,
        });
      }
      const changed = results.filter((r) => r.changed).length;
      const total = results.length;
      if (changed === 0) {
        setLastRenameResult(`扫描了 ${total} 个会话，所有名称已是最新`);
      } else {
        setLastRenameResult(`已修正 ${changed} / ${total} 个会话名称`);
      }
      if (changed > 0 && onSessionsRenamed) {
        onSessionsRenamed();
      }
    } catch (err) {
      setLastRenameResult(`修正失败: ${err}`);
    } finally {
      setIsRenaming(false);
    }
  };
return (
    <div className={`settings-embedded ${closing ? "is-closing" : "is-open"}`}>
      {/* 全宽顶部拖拽条：设置页盖住主标题栏后由它接管窗口拖拽（左键拖移、双击最大化） */}
      <div className="settings-drag-bar" onMouseDown={handleDragMouseDown} />
      <div className="settings-body">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-drag" onMouseDown={handleDragMouseDown} />
          <button
            type="button"
            className="settings-nav settings-nav-return"
            onClick={handleClose}
            aria-label="返回应用"
            title="返回应用"
          >
            <ArrowLeft size={13} aria-hidden />
            <span className="settings-nav-label">返回应用</span>
          </button>
          <nav className="settings-sidebar-nav" aria-label="设置分类">
            {SETTINGS_GROUPS.map((groupName) => {
              const items = SETTINGS_MENU.filter((item) => item.group === groupName);
              if (items.length === 0) return null;
              return (
                <div key={groupName} className="settings-nav-group">
                  <div className="settings-nav-group-label">{groupName}</div>
                  {items.map((item) => {
                    const NavIcon = SETTINGS_NAV_ICONS[item.id];
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`settings-nav ${activeMenu === item.id ? "active" : ""}`}
                        onClick={() => setActiveMenu(item.id)}
                        title={item.label}
                      >
                        <NavIcon size={17} aria-hidden />
                        <span className="settings-nav-label">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </aside>

        <div className="settings-content-wrap">
          <div className="settings-page-head" onMouseDown={handleDragMouseDown}>
            <div className="settings-page-head-inner">
              <h1 className="settings-page-title">{menuTitle}</h1>
              <p className="settings-page-description">{menuDescription}</p>
            </div>
          </div>

          <div className="settings-scroll">
            {activeMenu === "basic" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <Palette size={12} aria-hidden />
                    <span>主题与外观</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">界面主题</div>
                        <div className="settings-pref-desc">选择应用主色调与明暗风格，即时生效</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="theme-grid">
                          {THEME_DEFINITIONS.map((t) => {
                            const isChecked = theme === t.id;
                            return (
                              <div
                                key={t.id}
                                className={`theme-box ${isChecked ? "checked" : ""}`}
                                onClick={() => setTheme(t.id)}
                                title={`${t.name}${t.description ? ` (${t.description})` : ""}`}
                                style={{
                                  backgroundColor: t.preview.bg,
                                  borderColor: t.preview.border || undefined,
                                }}
                              >
                                {t.preview.split ? (
                                  <span className="auto-text">Auto</span>
                                ) : (
                                  <div
                                    className="theme-dot"
                                    style={{ backgroundColor: t.preview.accent }}
                                  />
                                )}
                                {isChecked && <span className="theme-checkmark">✓</span>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">界面语言</div>
                        <div className="settings-pref-desc">更多语言即将支持</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          <button type="button" className="settings-pref-segment is-active">简体中文</button>
                          <button type="button" className="settings-pref-segment is-disabled" title="English 暂不可选" disabled>
                            English
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">关闭窗口时</div>
                        <div className="settings-pref-desc">关闭主窗口时的系统行为</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          <button
                            type="button"
                            className={`settings-pref-segment ${closeBehavior === "ask" ? "is-active" : ""}`}
                            onClick={() => setCloseBehavior("ask")}
                          >
                            每次询问
                          </button>
                          <button
                            type="button"
                            className={`settings-pref-segment ${closeBehavior === "minimize" ? "is-active" : ""}`}
                            onClick={() => setCloseBehavior("minimize")}
                          >
                            最小化到托盘
                          </button>
                          <button
                            type="button"
                            className={`settings-pref-segment ${closeBehavior === "exit" ? "is-active" : ""}`}
                            onClick={() => setCloseBehavior("exit")}
                          >
                            直接退出
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "claude" && (
              <CliToolPanel
                key="claude"
                Icon={ClaudeIcon}
                iconColor="#D97757"
                title="Claude Code"
                packageName={CLAUDE_NPM_PACKAGE}
                installedVersion={claudeInstalled}
                onCheckLatest={checkClaudeLatest}
              />
            )}

            {activeMenu === "codex" && (
              <CliToolPanel
                key="codex"
                Icon={CodexIcon}
                iconColor="var(--color-green, #22c55e)"
                title="Codex"
                packageName={CODEX_NPM_PACKAGE}
                installedVersion={codexInstalled}
                onCheckLatest={checkCodexLatest}
              />
            )}

            {activeMenu === "chat" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <Bot size={12} aria-hidden />
                    <span>AI 助手与模式</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">Claude Code</div>
                        <div className="settings-pref-desc">本应用专注 Claude Code 单一助手（Pi / Codex 集成已移除）</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input type="checkbox" checked disabled />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">默认交互模式</div>
                        <div className="settings-pref-desc">GUI 为聊天式卡片界面；CLI 为原始终端界面，仅影响新建标签</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          <button
                            type="button"
                            className={`settings-pref-segment ${claudeInteractionMode === "gui" ? "is-active" : ""}`}
                            onClick={() => setClaudeInteractionMode("gui")}
                          >
                            GUI 聊天
                          </button>
                          <button
                            type="button"
                            className={`settings-pref-segment ${claudeInteractionMode === "cli" ? "is-active" : ""}`}
                            onClick={() => setClaudeInteractionMode("cli")}
                          >
                            CLI 终端
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <MessageSquare size={12} aria-hidden />
                    <span>聊天消息流</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">命令记录自动折叠</div>
                        <div className="settings-pref-desc">GUI 聊天中多条工具调用折叠为一行摘要，消息流更紧凑</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input
                            type="checkbox"
                            checked={collapseToolCards}
                            onChange={(e) => setCollapseToolCards(e.target.checked)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">分开显示多段思考</div>
                        <div className="settings-pref-desc">被工具调用打断的思考各自成块；关闭则合并为单一思考气泡</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input
                            type="checkbox"
                            checked={splitReasoning}
                            onChange={(e) => setSplitReasoning(e.target.checked)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "ccswitch" && (
              <div className="settings-content">
                <div className="settings-group">
                  <div className="cli-tool-header">
                    <CcSwitchIcon size={28} />
                    <div className="cli-tool-header-info">
                      <div className="cli-tool-title">CC Switch</div>
                      <div className="cli-tool-version">
                        {ccswitchPath ? ccswitchPath : "未配置路径"}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="settings-group">
                  <div className="settings-group-label">可执行文件路径</div>
                  <div style={{ display: "flex", gap: "8px", width: "100%" }}>
                    <input
                      type="text"
                      placeholder="例如: C:\Program Files\ccswitch\ccswitch.exe"
                      value={ccswitchPath}
                      onChange={(e) => setCcswitchPath(e.target.value)}
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        borderRadius: "6px",
                        border: "1px solid var(--border-color)",
                        backgroundColor: "var(--bg-input)",
                        color: "var(--text-primary)",
                        fontSize: "13px",
                        outline: "none",
                        transition: "border-color var(--transition-smooth)",
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = "var(--color-primary)";
                      }}
                      onBlurCapture={(e) => {
                        e.target.style.borderColor = "var(--border-color)";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowFilePicker(true)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid var(--border-color)",
                        backgroundColor: "var(--bg-hover-item)",
                        color: "var(--text-primary)",
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      浏览...
                    </button>
                  </div>
                </div>
                <div className="settings-group">
                  <button
                    className="settings-toggle-btn"
                    onClick={() => {
                      const path = ccswitchPath.trim();
                      if (!path) {
                        alert("请先在「CC Switch」中配置 ccswitch.exe 的路径。");
                        return;
                      }
                      invoke("launch_ccswitch", { path }).catch((err) => {
                        alert(`启动 ccswitch.exe 失败:\n${err}`);
                      });
                    }}
                  >
                    打开 CC Switch
                  </button>
                </div>
              </div>
            )}

            {activeMenu === "terminal" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <TerminalSquare size={12} aria-hidden />
                    <span>终端字体与渲染</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">终端字体</div>
                        <div className="settings-pref-desc">CLI 画布等宽字体，切换后立即生效</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          {(["Cascadia Mono", "Fira Code", "Consolas", "monospace"] as const).map((family) => (
                            <button
                              key={family}
                              type="button"
                              className={`settings-pref-segment ${fontFamily === family ? "is-active" : ""}`}
                              onClick={() => setFontFamily(family)}
                            >
                              {family === "monospace" ? "System" : family}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">终端字号</div>
                        <div className="settings-pref-desc">CLI 终端文字渲染大小</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-slider">
                          <input
                            type="range"
                            min="11.0"
                            max="22.0"
                            step="0.5"
                            className="settings-slider"
                            value={fontSize}
                            onChange={(e) => setFontSize(parseFloat(e.target.value))}
                          />
                          <span className="settings-pref-value">{fontSize.toFixed(1)}px</span>
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">终端配色</div>
                        <div className="settings-pref-desc">默认跟随 App 主题；可粘贴 Windows Terminal 配色 JSON</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          <button
                            type="button"
                            className={`settings-pref-segment ${terminalSchemeMode === "default" ? "is-active" : ""}`}
                            onClick={() => { setTerminalSchemeMode("default"); setTerminalSchemeError(""); }}
                          >
                            默认
                          </button>
                          <button
                            type="button"
                            className={`settings-pref-segment ${terminalSchemeMode === "custom" ? "is-active" : ""}`}
                            onClick={() => setTerminalSchemeMode("custom")}
                          >
                            自定义{terminalSchemeName ? ` · ${terminalSchemeName}` : ""}
                          </button>
                        </div>
                      </div>
                    </div>
                    {terminalSchemeMode === "custom" && (
                      <div className="settings-pref-row settings-pref-row--stack">
                        <div className="settings-pref-hint">
                          支持 windowsterminalthemes.dev 导出格式，普通模式与兼容模式均生效。
                        </div>
                        <textarea
                          className="settings-textarea"
                          value={terminalSchemeJson}
                          onChange={(e) => { setTerminalSchemeJson(e.target.value); setTerminalSchemeError(""); }}
                          placeholder={'{\n  "name": "Alabaster",\n  "background": "#f7f7f7",\n  ...\n}'}
                          rows={7}
                        />
                        <div className="settings-pref-actions">
                          <button type="button" className="settings-pref-btn settings-pref-btn--primary" onClick={applyCustomScheme}>
                            应用配色
                          </button>
                          <button
                            type="button"
                            className="settings-pref-btn"
                            onClick={() => {
                              setTerminalSchemeJson("");
                              setTerminalSchemeName("");
                              setTerminalSchemeError("");
                              localStorage.removeItem(TERMINAL_SCHEME_JSON_KEY);
                              setTerminalSchemeMode("default");
                            }}
                          >
                            清除
                          </button>
                          {terminalSchemeError ? (
                            <span className="settings-pref-status settings-pref-status--error">{terminalSchemeError}</span>
                          ) : terminalSchemeName ? (
                            <span className="settings-pref-status settings-pref-status--ok">已应用：{terminalSchemeName}</span>
                          ) : null}
                        </div>
                      </div>
                    )}
                    {/Windows/i.test(navigator.userAgent) && (
                      <div className="settings-pref-row">
                        <div className="settings-pref-meta">
                          <div className="settings-pref-title">Claude 兼容模式</div>
                          <div className="settings-pref-desc">使用独立安全 PTY 与 xterm 渲染链路，仅影响新打开的 Claude 标签</div>
                        </div>
                        <div className="settings-pref-control">
                          <label className="switch-container">
                            <input
                              type="checkbox"
                              checked={claudeTerminalMode === "native"}
                              onChange={(e) => setClaudeTerminalMode(e.target.checked ? "native" : "standard")}
                            />
                            <span className="switch-slider" />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <Sliders size={12} aria-hidden />
                    <span>CLI 缓冲区</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">回滚缓冲（Scrollback）</div>
                        <div className="settings-pref-desc">CLI 终端历史可回看行数，重启会话后生效</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-number">
                          <input
                            type="number"
                            min={1000}
                            max={100000}
                            step={10000}
                            value={scrollback || ""}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              setScrollback(Number.isNaN(val) ? 0 : val);
                            }}
                            onBlur={() => {
                              let val = scrollback;
                              if (Number.isNaN(val) || val < 1000) val = 1000;
                              if (val > 100000) val = 100000;
                              setScrollback(val);
                            }}
                            className="no-native-spinners settings-number-input"
                          />
                          <div className="settings-number-steppers">
                            <button type="button" className="settings-stepper-btn" onClick={() => setScrollback((prev) => Math.min(100000, Math.max(1000, prev + 10000)))}>▲</button>
                            <button type="button" className="settings-stepper-btn" onClick={() => setScrollback((prev) => Math.min(100000, Math.max(1000, prev - 10000)))}>▼</button>
                          </div>
                          <span className="settings-pref-helper">1,000 – 100,000</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "preview" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <FileText size={12} aria-hidden />
                    <span>代码与文本预览</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">预览等宽字体</div>
                        <div className="settings-pref-desc">右侧文件预览面板与 Monaco 代码编辑器的等宽字体</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          {(["Cascadia Mono", "Fira Code", "Consolas", "monospace"] as const).map((family) => (
                            <button
                              key={family}
                              type="button"
                              className={`settings-pref-segment ${previewFontFamily === family ? "is-active" : ""}`}
                              onClick={() => setPreviewFontFamily(family)}
                            >
                              {family === "monospace" ? "System" : family}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">预览字号大小</div>
                        <div className="settings-pref-desc">代码及文本预览界面的字体大小</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-slider">
                          <input
                            type="range"
                            min="10.0"
                            max="24.0"
                            step="0.5"
                            className="settings-slider"
                            value={previewFontSize}
                            onChange={(e) => setPreviewFontSize(parseFloat(e.target.value))}
                          />
                          <span className="settings-pref-value">{previewFontSize.toFixed(1)}px</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "notifications" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <Bell size={12} aria-hidden />
                    <span>通知与提示音</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">系统通知</div>
                        <div className="settings-pref-desc">AI 回答结束且窗口处于后台时弹出通知气泡</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input type="checkbox" checked={notifyOnComplete} onChange={(e) => setNotifyOnComplete(e.target.checked)} />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">通知阈值</div>
                        <div className="settings-pref-desc">AI 思考与生成持续超过此时长才触发通知</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-slider">
                          <input
                            type="range"
                            min="0.5"
                            max="10.0"
                            step="0.5"
                            className="settings-slider"
                            value={notifyThreshold}
                            onChange={(e) => setNotifyThreshold(parseFloat(e.target.value))}
                          />
                          <span className="settings-pref-value">{notifyThreshold.toFixed(1)}s</span>
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">播放提示音</div>
                        <div className="settings-pref-desc">回答完毕时播放声音提醒（需先启用系统通知）</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input type="checkbox" checked={playSound} onChange={(e) => setPlaySound(e.target.checked)} />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">提示音色</div>
                        <div className="settings-pref-desc">点击即可试听并设置为默认提示音</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-segmented">
                          {(["默认", "清脆铃声", "钟声", "叮咚", "成功提示"] as const).map((tone) => {
                            const toneKey = {
                              默认: "default",
                              清脆铃声: "chime",
                              钟声: "bell",
                              叮咚: "ding",
                              成功提示: "success",
                            }[tone];
                            const isActive = soundTone === toneKey;
                            return (
                              <button
                                key={tone}
                                type="button"
                                className={`settings-pref-segment ${isActive ? "is-active" : ""}`}
                                onClick={() => {
                                  const finalTone = toneKey || "default";
                                  setSoundTone(finalTone);
                                  triggerPreview(finalTone, soundVolume);
                                }}
                              >
                                {tone}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">音量大小</div>
                        <div className="settings-pref-desc">调节提示音播放音量，松开滑块即可试听</div>
                      </div>
                      <div className="settings-pref-control">
                        <div className="settings-pref-slider">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            className="settings-slider"
                            value={soundVolume}
                            onChange={(e) => setSoundVolume(parseInt(e.target.value, 10))}
                            onMouseUp={() => triggerPreview(soundTone, soundVolume)}
                          />
                          <span className="settings-pref-value">{soundVolume}%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "shortcuts" && (
              <div className="settings-content settings-basic-surface">
                <div className="settings-pref-group">
                  <div className="settings-pref-card-label">
                    <Keyboard size={12} aria-hidden />
                    <span>状态栏快捷短语</span>
                  </div>
                  <div className="settings-pref-card">
                    <div className="settings-pref-row">
                      <div className="settings-pref-meta">
                        <div className="settings-pref-title">启用快捷短语</div>
                        <div className="settings-pref-desc">在主界面底部状态栏常驻显示常用短语，点击快速填入或发送</div>
                      </div>
                      <div className="settings-pref-control">
                        <label className="switch-container">
                          <input
                            type="checkbox"
                            checked={shortcutsEnabled}
                            onChange={(e) => setShortcutsEnabled(e.target.checked)}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    </div>
                    {shortcutsEnabled && (
                      <div className="settings-pref-row settings-pref-row--stack">
                        <div className="settings-shortcut-list">
                          {shortcutsList.map((item, idx) => (
                            <div key={idx} className="settings-shortcut-row">
                              <span className="settings-shortcut-index">#{idx + 1}</span>
                              <input
                                type="text"
                                className="settings-text-input"
                                placeholder="显示名称"
                                value={item.title}
                                onChange={(e) => {
                                  const next = [...shortcutsList];
                                  next[idx] = { ...next[idx], title: e.target.value };
                                  setShortcutsList(next);
                                }}
                              />
                              <input
                                type="text"
                                className="settings-text-input settings-text-input-wide"
                                placeholder="发送内容"
                                value={item.content}
                                onChange={(e) => {
                                  const next = [...shortcutsList];
                                  next[idx] = { ...next[idx], content: e.target.value };
                                  setShortcutsList(next);
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeMenu === "sessions" && (
              <div className="settings-content">
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-section-title">定时清理</h3>
                    <p className="settings-section-desc">启动时自动清理长期未交互的会话记录</p>
                  </div>
                  <div className="settings-group">
                    <div className="settings-switch-row">
                      <label className="switch-container">
                        <input type="checkbox" checked={sessionCleanupEnabled} onChange={(e) => setSessionCleanupEnabled(e.target.checked)} />
                        <span className="switch-slider" />
                      </label>
                      <span className="switch-label">启用启动清理</span>
                    </div>
                  </div>
                  <div className="settings-group">
                    <div className="settings-group-label">未交互天数</div>
                    <div className="slider-row">
                      <input
                        type="range"
                        min={MIN_SESSION_CLEANUP_DAYS}
                        max={365}
                        step={1}
                        className="settings-slider"
                        value={sessionCleanupDays}
                        onChange={(e) => setSessionCleanupDays(normalizeSessionCleanupDays(e.target.value))}
                        disabled={!sessionCleanupEnabled}
                      />
                      <span className="slider-value">{sessionCleanupDays} 天</span>
                    </div>
                    <div className="settings-helper-text">
                      默认 {DEFAULT_SESSION_CLEANUP_DAYS} 天；清理后的会话记录 7 天后自动永久删除
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-section-title">会话名称修正</h3>
                    <p className="settings-section-desc">根据对话内容自动生成更可读的标题</p>
                  </div>
                  <div className="settings-group">
                    <div className="settings-btn-group">
                      <button type="button" className={`settings-toggle-btn ${namerMode === "heuristic" ? "active" : ""}`} onClick={() => setNamerMode("heuristic")}>
                        快速（本地）
                      </button>
                      <button type="button" className={`settings-toggle-btn ${namerMode === "llm" ? "active" : ""}`} onClick={() => setNamerMode("llm")}>
                        精准（LLM）
                      </button>
                    </div>
                    <div className="settings-helper-text">
                      {namerMode === "heuristic"
                        ? "纯本地字符串处理，零消耗，速度更快"
                        : "调用 LLM 理解对话，生成更准确标题"}
                    </div>
                  </div>

                  {namerMode === "llm" && (
                    <div className="settings-group settings-llm-fields">
                      <div className="settings-group-label">LLM 配置（OpenAI 兼容）</div>
                      <div className="settings-field-row">
                        <span className="settings-field-label">URL</span>
                        <input type="text" className="settings-text-input" value={llmApiUrl} onChange={(e) => setLlmApiUrl(e.target.value)} placeholder="https://api.deepseek.com" />
                      </div>
                      <div className="settings-field-row">
                        <span className="settings-field-label">Key</span>
                        <input type="password" className="settings-text-input" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} placeholder="sk-..." />
                      </div>
                      <div className="settings-field-row">
                        <span className="settings-field-label">模型</span>
                        <input type="text" className="settings-text-input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="deepseek-v4-flash" />
                      </div>
                    </div>
                  )}

                  <div className="settings-group">
                    <div className="settings-group-label">触发规则</div>
                    <div className="settings-switch-row">
                      <label className="switch-container">
                        <input type="checkbox" checked={autoRenameOnStartup} onChange={(e) => setAutoRenameOnStartup(e.target.checked)} />
                        <span className="switch-slider" />
                      </label>
                      <span className="switch-label">启动时自动修正</span>
                    </div>
                    <div className="settings-switch-row">
                      <label className="switch-container">
                        <input type="checkbox" checked={autoRenameOnIdle} onChange={(e) => setAutoRenameOnIdle(e.target.checked)} />
                        <span className="switch-slider" />
                      </label>
                      <span className="switch-label">空闲后自动修正</span>
                    </div>
                    {autoRenameOnIdle && (
                      <div className="settings-nested">
                        <div className="slider-row">
                          <input type="range" min={1} max={60} step={1} className="settings-slider" value={idleMinutes} onChange={(e) => setIdleMinutes(parseInt(e.target.value, 10))} />
                          <span className="slider-value">{idleMinutes} 分钟</span>
                        </div>
                        <div className="settings-helper-text">空闲超过此时长且有新对话时触发</div>
                      </div>
                    )}
                    <div className="settings-switch-row">
                      <label className="switch-container">
                        <input type="checkbox" checked={autoRenameSkipFavorites} onChange={(e) => setAutoRenameSkipFavorites(e.target.checked)} />
                        <span className="switch-slider" />
                      </label>
                      <span className="switch-label">跳过收藏的会话</span>
                    </div>
                  </div>

                  <div className="settings-group settings-inline-actions">
                    <button type="button" className="settings-toggle-btn active" onClick={handleManualRename} disabled={isRenaming} style={{ opacity: isRenaming ? 0.6 : 1 }}>
                      {isRenaming ? "修正中…" : "立即修正全部"}
                    </button>
                    {lastRenameResult && <span className="settings-status">{lastRenameResult}</span>}
                  </div>
                </section>
              </div>
            )}

            {activeMenu === "remote" && (
              <div className="settings-content">
                <RemoteSettingsPanel />
              </div>
            )}

            {activeMenu === "debug" && (
              <div className="settings-content">
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h3 className="settings-section-title">调试日志</h3>
                    <p className="settings-section-desc">记录前端操作与各会话的后端行为，用于问题定位；日志目录：{`<应用目录>/logs/`}</p>
                  </div>
                  <div className="settings-group">
                    <div className="settings-switch-row">
                      <label className="switch-container">
                        <input
                          type="checkbox"
                          checked={debugLogEnabled}
                          onChange={(e) => handleToggleDebugLog(e.target.checked)}
                        />
                        <span className="switch-slider" />
                      </label>
                      <span className="switch-label">启用调试日志（关闭后不再产生日志）</span>
                    </div>
                    <div className="settings-switch-row" style={{ justifyContent: "space-between" }}>
                      <span className="switch-label" style={{ flex: 1 }}>
                        一键清理日志文件
                      </span>
                      <button
                        type="button"
                        className="settings-toggle-btn"
                        disabled={clearingLogs}
                        onClick={handleClearLogs}
                        style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.4)" }}
                      >
                        {clearingLogs ? "清理中..." : "立即清理"}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeMenu === "about" && (
              <div className="settings-content settings-basic-surface">
                <div className="about-page-wrapper">
                  {/* 品牌 Hero 卡片 */}
                  <div className="about-hero-card">
                    <div className="about-hero-glow" />
                    <div className="about-logo-wrapper">
                      <img className="about-logo" src={agentdeskIcon} alt="AgentDesk" draggable={false} />
                    </div>
                    <div className="about-title-row">
                      <div className="about-title">AgentDesk AI 终端管理器</div>
                      <button
                        type="button"
                        className="about-version-badge"
                        onClick={handleCopyVersion}
                        title="点击复制版本号"
                      >
                        {copiedVersion ? <Check size={11} /> : <Copy size={11} />}
                        <span>v1.2.0</span>
                      </button>
                    </div>
                    <div className="about-tagline">极简 · 现代 · 克制的原生 AI 终端心流工作台</div>
                    <div className="about-desc">
                      基于 Tauri 2.x 与 React 19 构建，深度融合多 Agent 统一托管、Rust 原生终端管道与 TokenTracker 吞吐洞察，为开发者打造丝滑的原生终端心流体验。
                    </div>
                    <div className="about-actions">
                      <button
                        type="button"
                        className="about-action-btn about-action-btn-primary"
                        onClick={() => openExternalUrl("https://github.com/zengxiongfan/KKCODER")}
                      >
                        <GitHubIcon size={14} />
                        <span>GitHub 仓库</span>
                        <ExternalLink size={11} />
                      </button>
                      <button
                        type="button"
                        className="about-action-btn about-action-btn-secondary"
                        onClick={() => openExternalUrl("https://github.com/zengxiongfan/KKCODER/issues")}
                      >
                        <Bug size={13} />
                        <span>问题与建议</span>
                        <ExternalLink size={11} />
                      </button>
                      <button
                        type="button"
                        className="about-action-btn about-action-btn-secondary"
                        onClick={() => openExternalUrl("https://github.com/zengxiongfan/KKCODER/releases")}
                      >
                        <Sparkles size={13} />
                        <span>版本发布日志</span>
                        <ExternalLink size={11} />
                      </button>
                    </div>
                  </div>

                  {/* 核心特性 */}
                  <div className="settings-pref-group">
                    <div className="settings-pref-card-label">
                      <Sparkles size={12} aria-hidden />
                      <span>核心架构与特性</span>
                    </div>
                    <div className="about-features-grid">
                      <div className="about-feature-card">
                        <div className="about-feature-icon-box">
                          <TerminalSquare size={18} />
                        </div>
                        <div className="about-feature-content">
                          <div className="about-feature-title">原生终端心流</div>
                          <div className="about-feature-desc">Rust PTY 底层通道，Xterm.js 硬件加速渲染与零延迟流式输出。</div>
                        </div>
                      </div>
                      <div className="about-feature-card">
                        <div className="about-feature-icon-box">
                          <Bot size={18} />
                        </div>
                        <div className="about-feature-content">
                          <div className="about-feature-title">多 Agent 统一托管</div>
                          <div className="about-feature-desc">无缝纳管 Claude Code、Codex、Antigravity 等 CLI 会话与上下文。</div>
                        </div>
                      </div>
                      <div className="about-feature-card">
                        <div className="about-feature-icon-box">
                          <Activity size={18} />
                        </div>
                        <div className="about-feature-content">
                          <div className="about-feature-title">Token 深度洞察</div>
                          <div className="about-feature-desc">精准追踪 Token 消耗、活跃天数、费用趋势与 3D 活动热力图。</div>
                        </div>
                      </div>
                      <div className="about-feature-card">
                        <div className="about-feature-icon-box">
                          <Layers size={18} />
                        </div>
                        <div className="about-feature-content">
                          <div className="about-feature-title">全生态扩展系统</div>
                          <div className="about-feature-desc">支持 Skills 技能集市、MCP 服务器配置、自定义短语与快捷工具。</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 运行环境与技术规格 */}
                  <div className="settings-pref-group">
                    <div className="settings-pref-card-label">
                      <Cpu size={12} aria-hidden />
                      <span>运行环境与系统规格</span>
                    </div>
                    <div className="settings-pref-card">
                      <div className="about-spec-grid">
                        <div className="about-spec-item">
                          <span className="about-spec-label">当前版本</span>
                          <span className="about-spec-value">v1.2.0 (Stable)</span>
                        </div>
                        <div className="about-spec-item">
                          <span className="about-spec-label">开源项目</span>
                          <span className="about-spec-value">zengxiongfan/KKCODER · simon-dev</span>
                        </div>
                        <div className="about-spec-item">
                          <span className="about-spec-label">底层运行时</span>
                          <span className="about-spec-value">Tauri 2.x • Rust Core</span>
                        </div>
                        <div className="about-spec-item">
                          <span className="about-spec-label">前端架构</span>
                          <span className="about-spec-value">React 19 • TypeScript • Vite</span>
                        </div>
                        <div className="about-spec-item">
                          <span className="about-spec-label">终端渲染引擎</span>
                          <span className="about-spec-value">Xterm.js • WebGL Accelerated</span>
                        </div>
                        <div className="about-spec-item">
                          <span className="about-spec-label">开源许可</span>
                          <span className="about-spec-value">MIT License</span>
                        </div>
                      </div>
                      <div className="settings-pref-row" style={{ borderTop: "1px solid var(--border-color)", paddingTop: "12px", marginTop: "4px" }}>
                        <div className="settings-pref-meta">
                          <div className="settings-pref-title">运行环境诊断</div>
                          <div className="settings-pref-desc">一键复制当前客户端版本与系统运行时信息，便于提交 Issue 反馈</div>
                        </div>
                        <div className="settings-pref-control">
                          <button
                            type="button"
                            className="about-action-btn about-action-btn-secondary"
                            onClick={handleCopyDiagnosticInfo}
                          >
                            {copiedDiag ? <Check size={13} /> : <Copy size={13} />}
                            <span>{copiedDiag ? "已复制诊断信息" : "复制诊断信息"}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 底部致谢与版权 */}
                  <div className="about-footer">
                    <div className="about-footer-links">
                      <span>致谢开源生态：</span>
                      <span>Tauri</span>
                      <span>·</span>
                      <span>React</span>
                      <span>·</span>
                      <span>Lucide</span>
                      <span>·</span>
                      <span>Monaco Editor</span>
                      <span>·</span>
                      <span>Xterm.js</span>
                    </div>
                    <div className="about-footer-copy">
                      © 2026 AgentDesk Studio. Crafted with craftsmanship for developers.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <DirectoryPickerModal
        show={showFilePicker}
        onClose={() => setShowFilePicker(false)}
        onSelect={(path) => setCcswitchPath(path)}
        initialPath={ccswitchPath || "D:\\"}
        mode="file"
        extensions={["exe"]}
        title="选择 ccswitch.exe 路径"
      />
    </div>
  );
};

