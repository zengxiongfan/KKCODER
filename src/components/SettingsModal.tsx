import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SESSION_CLEANUP_DAYS,
  MIN_SESSION_CLEANUP_DAYS,
  normalizeSessionCleanupDays,
  SESSION_CLEANUP_DAYS_KEY,
  SESSION_CLEANUP_ENABLED_KEY,
} from "../utils/sessionCleanup";

// 会话名称修正 localStorage keys
const AUTO_RENAME_ON_STARTUP_KEY = "kkcoder_setting_auto_rename_startup";
const AUTO_RENAME_ON_IDLE_KEY = "kkcoder_setting_auto_rename_idle";
const AUTO_RENAME_SKIP_FAVORITES_KEY = "kkcoder_setting_auto_rename_skip_favorites";
const NAMER_MODE_KEY = "kkcoder_setting_namer_mode";
const LLM_API_URL_KEY = "kkcoder_setting_llm_api_url";
const LLM_API_KEY_KEY = "kkcoder_setting_llm_api_key";
const LLM_MODEL_KEY = "kkcoder_setting_llm_model";
const IDLE_MINUTES_KEY = "kkcoder_setting_idle_minutes";

interface RenameResult {
  session_id: string;
  old_name: string;
  new_name: string;
  changed: boolean;
}

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  onSessionsRenamed?: () => void; // 修正完成后刷新会话列表
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ show, onClose, onSessionsRenamed }) => {
  const [activeMenu, setActiveMenu] = useState<"general" | "sessions" | "about">("general");

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
    return localStorage.getItem("kkcoder_setting_theme") || "light-premium";
  });
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
    return localStorage.getItem("kkcoder_setting_sound_tone") || "dingdong";
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
    localStorage.setItem("kkcoder_setting_theme", theme);
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent("kkcoder-theme-change", { detail: theme }));
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
    return () => window.removeEventListener("kkcoder-theme-change", handleExternalThemeChange);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_close_behavior", closeBehavior);
  }, [closeBehavior]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_notify_on_complete", String(notifyOnComplete));
  }, [notifyOnComplete]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_notify_threshold", String(notifyThreshold));
  }, [notifyThreshold]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_play_sound", String(playSound));
  }, [playSound]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_sound_tone", soundTone);
  }, [soundTone]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_sound_volume", String(soundVolume));
  }, [soundVolume]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_font_family", fontFamily);
    window.dispatchEvent(new CustomEvent("kkcoder-font-change", { detail: fontFamily }));
  }, [fontFamily]);

  useEffect(() => {
    localStorage.setItem("kkcoder_setting_font_size", String(fontSize));
    window.dispatchEvent(new CustomEvent("kkcoder-font-size-change", { detail: fontSize }));
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
  }, [scrollback]);

  useEffect(() => {
    localStorage.setItem(SESSION_CLEANUP_DAYS_KEY, String(normalizeSessionCleanupDays(sessionCleanupDays)));
  }, [sessionCleanupDays]);

  useEffect(() => {
    localStorage.setItem("kkcoder_shortcuts_enabled", String(shortcutsEnabled));
    window.dispatchEvent(new Event("kkcoder-shortcuts-change"));
  }, [shortcutsEnabled]);

  useEffect(() => {
    localStorage.setItem("kkcoder_shortcuts_list", JSON.stringify(shortcutsList));
    window.dispatchEvent(new Event("kkcoder-shortcuts-change"));
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


  // 监听键盘 ESC 键关闭设置弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    if (show) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [show, onClose]);

  // --- 3. 动态应用主题色彩系统 ---
  const applyTheme = (themeName: string) => {
    const root = document.documentElement;
    if (themeName === "dark-blue") {
      // 1. 深蓝主题 (对标 Screenshot 1)
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
    } else if (themeName === "dark-purple") {
      // 2. 暗紫主题 (对标 Screenshot 2)
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
    } else if (themeName === "dark-zinc") {
      // 3. 碳黑主题 (对标 Screenshot 3)
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
    } else if (themeName === "light-blue") {
      // 4. 冰蓝主题 (对标 Screenshot 4)
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
    } else if (themeName === "light-orange") {
      // 5. 蜜橘主题 (对标 Screenshot 5)
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
      // 6. 经典高雅 (默认)
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

  if (!show) return null;

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
    <div className="modal-overlay show" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        {/* 左侧菜单栏 */}
        <div className="settings-sidebar">
          <div className="settings-sidebar-header">设置</div>
          <button
            className={`settings-menu-item ${activeMenu === "general" ? "active" : ""}`}
            onClick={() => setActiveMenu("general")}
          >
            通用
          </button>
          <button
            className={`settings-menu-item ${activeMenu === "sessions" ? "active" : ""}`}
            onClick={() => setActiveMenu("sessions")}
          >
            终端设置
          </button>
          <button
            className={`settings-menu-item ${activeMenu === "about" ? "active" : ""}`}
            onClick={() => setActiveMenu("about")}
          >
            关于
          </button>
        </div>

        {/* 右侧主设置面板 */}
        <div className="settings-main">
          {/* 头部标题与关闭按钮 */}
          <div className="settings-header">
            <span className="settings-title">
              {activeMenu === "general" ? "通用" : activeMenu === "sessions" ? "终端设置" : "关于"}
            </span>
            <button className="settings-close" onClick={onClose}>
              ×
            </button>
          </div>

          <div className="settings-body">
            {activeMenu === "general" ? (
              <div className="settings-content">
                {/* 1. 主题风格 */}
                <div className="settings-group">
                  <div className="settings-group-label">主题风格</div>
                  <div className="theme-grid">
                    {/* Row 1: 深色主题 */}
                    <div
                      className={`theme-box dark-blue-box ${theme === "dark-blue" ? "checked" : ""}`}
                      onClick={() => setTheme("dark-blue")}
                      title="深蓝主题"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#3b82f6" }}></div>
                    </div>
                    <div
                      className={`theme-box dark-purple-box ${theme === "dark-purple" ? "checked" : ""}`}
                      onClick={() => setTheme("dark-purple")}
                      title="暗紫主题"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#8b5cf6" }}></div>
                    </div>
                    <div
                      className={`theme-box dark-zinc-box ${theme === "dark-zinc" ? "checked" : ""}`}
                      onClick={() => setTheme("dark-zinc")}
                      title="碳黑主题"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#f59e0b" }}></div>
                    </div>

                    {/* Row 2: 浅色主题 */}
                    <div
                      className={`theme-box light-blue-box ${theme === "light-blue" ? "checked" : ""}`}
                      onClick={() => setTheme("light-blue")}
                      title="冰蓝主题 (浅色)"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#3b82f6" }}></div>
                    </div>
                    <div
                      className={`theme-box light-orange-box ${theme === "light-orange" ? "checked" : ""}`}
                      onClick={() => setTheme("light-orange")}
                      title="蜜橘主题 (浅色)"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#ea580c" }}></div>
                    </div>
                    <div
                      className={`theme-box light-premium-box ${theme === "light-premium" ? "checked" : ""}`}
                      onClick={() => setTheme("light-premium")}
                      title="经典高雅 (默认)"
                    >
                      <div className="theme-dot" style={{ backgroundColor: "#2563eb" }}></div>
                      {theme === "light-premium" && <span className="theme-checkmark">✓</span>}
                    </div>

                    {/* Auto 随系统 */}
                    <div
                      className={`theme-box auto-box ${theme === "auto" ? "checked" : ""}`}
                      onClick={() => setTheme("auto")}
                      title="跟随系统"
                    >
                      <span className="auto-text">Auto</span>
                    </div>
                  </div>
                </div>

                {/* 2. 语言 */}
                <div className="settings-group">
                  <div className="settings-group-label">语言</div>
                  <div className="settings-btn-group">
                    <button
                      className="settings-toggle-btn active"
                    >
                      简体中文
                    </button>
                    <button
                      className="settings-toggle-btn disabled"
                      title="English 暂不可选"
                      disabled
                    >
                      English
                    </button>
                  </div>
                </div>

                {/* 2b. 终端字体 */}
                <div className="settings-group">
                  <div className="settings-group-label">终端字体</div>
                  <div className="settings-btn-group">
                    <button
                      className={`settings-toggle-btn ${fontFamily === "Cascadia Mono" ? "active" : ""}`}
                      onClick={() => setFontFamily("Cascadia Mono")}
                    >
                      Cascadia Mono
                    </button>
                    <button
                      className={`settings-toggle-btn ${fontFamily === "Fira Code" ? "active" : ""}`}
                      onClick={() => setFontFamily("Fira Code")}
                    >
                      Fira Code
                    </button>
                    <button
                      className={`settings-toggle-btn ${fontFamily === "Consolas" ? "active" : ""}`}
                      onClick={() => setFontFamily("Consolas")}
                    >
                      Consolas
                    </button>
                    <button
                      className={`settings-toggle-btn ${fontFamily === "monospace" ? "active" : ""}`}
                      onClick={() => setFontFamily("monospace")}
                    >
                      System Monospace
                    </button>
                  </div>
                </div>

                {/* 2c. 终端字号 */}
                <div className="settings-group">
                  <div className="settings-group-label">终端字号</div>
                  <div className="slider-row">
                    <input
                      type="range"
                      min="11.0"
                      max="22.0"
                      step="0.5"
                      className="settings-slider"
                      value={fontSize}
                      onChange={(e) => setFontSize(parseFloat(e.target.value))}
                    />
                    <span className="slider-value">{fontSize.toFixed(1)}px</span>
                  </div>
                </div>

                {/* 3. 关闭窗口时 */}
                <div className="settings-group">
                  <div className="settings-group-label">关闭窗口时</div>
                  <div className="settings-btn-group">
                    <button
                      className={`settings-toggle-btn ${closeBehavior === "ask" ? "active" : ""}`}
                      onClick={() => setCloseBehavior("ask")}
                    >
                      每次询问
                    </button>
                    <button
                      className={`settings-toggle-btn ${closeBehavior === "minimize" ? "active" : ""}`}
                      onClick={() => setCloseBehavior("minimize")}
                    >
                      最小化到系统托盘
                    </button>
                    <button
                      className={`settings-toggle-btn ${closeBehavior === "exit" ? "active" : ""}`}
                      onClick={() => setCloseBehavior("exit")}
                    >
                      直接退出应用
                    </button>
                  </div>
                </div>

                {/* 4. 通知 */}
                <div className="settings-group">
                  <div className="settings-group-label">通知</div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={notifyOnComplete}
                        onChange={(e) => setNotifyOnComplete(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">CLI 工具回答完毕时发送系统通知</span>
                  </div>
                </div>

                {/* 5. 通知阈值 */}
                <div className="settings-group">
                  <div className="settings-group-label">
                    通知阈值 (回答持续时间超过此值才通知)
                  </div>
                  <div className="slider-row">
                    <input
                      type="range"
                      min="0.5"
                      max="10.0"
                      step="0.5"
                      className="settings-slider"
                      value={notifyThreshold}
                      onChange={(e) => setNotifyThreshold(parseFloat(e.target.value))}
                    />
                    <span className="slider-value">{notifyThreshold.toFixed(1)}s</span>
                  </div>
                </div>

                {/* 6. 完成提示音 */}
                <div className="settings-group">
                  <div className="settings-group-label">完成提示音</div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={playSound}
                        onChange={(e) => setPlaySound(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">
                      回答完毕时播放本地提示音（需先启用通知）
                    </span>
                  </div>
                </div>

                {/* 7. 提示音音色 */}
                <div className="settings-group">
                  <div className="settings-group-label">提示音音色</div>
                  <div className="settings-btn-group wrap-group">
                    {["叮咚", "钟声", "成功音", "闹铃", "气泡", "水晶", "梦幻", "水滴"].map(
                      (tone) => {
                        const toneKey = {
                          叮咚: "dingdong",
                          钟声: "bell",
                          成功音: "success",
                          闹铃: "alarm",
                          气泡: "bubble",
                          水晶: "crystal",
                          梦幻: "dream",
                          水滴: "water",
                        }[tone];
                        const isActive = soundTone === toneKey;
                        return (
                          <button
                            key={tone}
                            className={`settings-toggle-btn ${isActive ? "active" : ""}`}
                            onClick={() => {
                              const finalTone = toneKey || "dingdong";
                              setSoundTone(finalTone);
                              triggerPreview(finalTone, soundVolume);
                            }}
                          >
                            {tone}
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>

                {/* 8. 音量 */}
                <div className="settings-group">
                  <div className="settings-group-label">音量</div>
                  <div className="slider-row">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      className="settings-slider"
                      value={soundVolume}
                      onChange={(e) => setSoundVolume(parseInt(e.target.value, 10))}
                      onMouseUp={() => triggerPreview(soundTone, soundVolume)}
                    />
                    <span className="slider-value">{soundVolume}%</span>
                  </div>
                </div>

                {/* 9. 快捷短语 */}
                <div className="settings-group">
                  <div className="settings-group-label">快捷短语</div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={shortcutsEnabled}
                        onChange={(e) => setShortcutsEnabled(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">启用快捷短语功能（于最下方状态栏显示）</span>
                  </div>
                  {shortcutsEnabled && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
                      {shortcutsList.map((item, idx) => (
                        <div key={idx} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <span style={{ fontSize: "12px", width: "40px", color: "var(--text-secondary)" }}>
                            按钮 {idx + 1}
                          </span>
                          <input
                            type="text"
                            placeholder="显示名称 (如: 继续)"
                            value={item.title}
                            onChange={(e) => {
                              const newList = [...shortcutsList];
                              newList[idx] = { ...newList[idx], title: e.target.value };
                              setShortcutsList(newList);
                            }}
                            style={{
                              flex: "1",
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid var(--border-color)",
                              backgroundColor: "var(--bg-terminal)",
                              color: "var(--text-primary)",
                              fontSize: "12px",
                              outline: "none"
                            }}
                          />
                          <input
                            type="text"
                            placeholder="发送内容 (如: 继续完成)"
                            value={item.content}
                            onChange={(e) => {
                              const newList = [...shortcutsList];
                              newList[idx] = { ...newList[idx], content: e.target.value };
                              setShortcutsList(newList);
                            }}
                            style={{
                              flex: "2",
                              padding: "4px 8px",
                              borderRadius: "4px",
                              border: "1px solid var(--border-color)",
                              backgroundColor: "var(--bg-terminal)",
                              color: "var(--text-primary)",
                              fontSize: "12px",
                              outline: "none"
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

            ) : activeMenu === "sessions" ? (
              <div className="settings-content">
                {/* ccswitch.exe 路径 */}
                <div className="settings-group">
                  <div className="settings-group-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>ccswitch.exe 路径</span>
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: "normal" }}>
                      （点击右上角图标时启动的程序路径）
                    </span>
                  </div>
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
                      onClick={async () => {
                        try {
                          const selected = await invoke<string | null>("select_ccswitch_file");
                          if (selected) {
                            setCcswitchPath(selected);
                          }
                        } catch (err) {
                          console.error("选择文件失败:", err);
                        }
                      }}
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

                <div style={{ borderTop: "1px solid var(--border-color)", margin: "8px 0" }} />

                {/* 1. 回滚行数 */}
                <div className="settings-group">
                  <div className="settings-group-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span>回滚行数</span>
                    <span style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: "normal" }}>
                      （终端可回看的最大行数，重启会话生效）
                    </span>
                  </div>
                  <div style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    width: "160px",
                  }}>
                    <input
                      type="number"
                      min="1000"
                      max="100000"
                      step="10000"
                      value={scrollback || ""}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        setScrollback(isNaN(val) ? 0 : val);
                      }}
                      onBlur={() => {
                        let val = scrollback;
                        if (isNaN(val) || val < 1000) val = 1000;
                        if (val > 100000) val = 100000;
                        setScrollback(val);
                      }}
                      className="no-native-spinners"
                      style={{
                        width: "100%",
                        padding: "6px 32px 6px 10px",
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
                    <div style={{
                      position: "absolute",
                      right: "1px",
                      top: "1px",
                      bottom: "1px",
                      width: "24px",
                      display: "flex",
                      flexDirection: "column",
                      borderLeft: "1px solid var(--border-color)",
                      borderTopRightRadius: "5px",
                      borderBottomRightRadius: "5px",
                      overflow: "hidden",
                    }}>
                      <button
                        type="button"
                        onClick={() => {
                          setScrollback((prev) => {
                            let next = prev + 10000;
                            if (next > 100000) next = 100000;
                            if (next < 1000) next = 1000;
                            return next;
                          });
                        }}
                        style={{
                          flex: 1,
                          border: "none",
                          background: "none",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--text-secondary)",
                          padding: 0,
                          fontSize: "8px",
                          outline: "none",
                          transition: "background-color 0.1s, color 0.1s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "var(--bg-hover-item)";
                          e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = "var(--text-secondary)";
                        }}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setScrollback((prev) => {
                            let next = prev - 10000;
                            if (next < 1000) next = 1000;
                            if (next > 100000) next = 100000;
                            return next;
                          });
                        }}
                        style={{
                          flex: 1,
                          border: "none",
                          borderTop: "1px solid var(--border-color)",
                          background: "none",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--text-secondary)",
                          padding: 0,
                          fontSize: "8px",
                          outline: "none",
                          transition: "background-color 0.1s, color 0.1s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = "var(--bg-hover-item)";
                          e.currentTarget.style.color = "var(--text-primary)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = "var(--text-secondary)";
                        }}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                </div>
                {/* 分割线 */}
                <div style={{ borderTop: "1px solid var(--border-color)", margin: "8px 0" }} />

                {/* 预览界面字体 */}
                <div className="settings-group">
                  <div className="settings-group-label">预览界面字体</div>
                  <div className="settings-btn-group">
                    <button
                      className={`settings-toggle-btn ${previewFontFamily === "Cascadia Mono" ? "active" : ""}`}
                      onClick={() => setPreviewFontFamily("Cascadia Mono")}
                    >
                      Cascadia Mono
                    </button>
                    <button
                      className={`settings-toggle-btn ${previewFontFamily === "Fira Code" ? "active" : ""}`}
                      onClick={() => setPreviewFontFamily("Fira Code")}
                    >
                      Fira Code
                    </button>
                    <button
                      className={`settings-toggle-btn ${previewFontFamily === "Consolas" ? "active" : ""}`}
                      onClick={() => setPreviewFontFamily("Consolas")}
                    >
                      Consolas
                    </button>
                    <button
                      className={`settings-toggle-btn ${previewFontFamily === "monospace" ? "active" : ""}`}
                      onClick={() => setPreviewFontFamily("monospace")}
                    >
                      System Monospace
                    </button>
                  </div>
                </div>

                {/* 预览界面字号 */}
                <div className="settings-group">
                  <div className="settings-group-label">预览界面字号</div>
                  <div className="slider-row">
                    <input
                      type="range"
                      min="10.0"
                      max="24.0"
                      step="0.5"
                      className="settings-slider"
                      value={previewFontSize}
                      onChange={(e) => setPreviewFontSize(parseFloat(e.target.value))}
                    />
                    <span className="slider-value">{previewFontSize.toFixed(1)}px</span>
                  </div>
                </div>

                {/* 分割线 */}
                <div style={{ borderTop: "1px solid var(--border-color)", margin: "8px 0" }} />

                <div className="settings-group">
                  <div className="settings-group-label">定时清理</div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={sessionCleanupEnabled}
                        onChange={(e) => setSessionCleanupEnabled(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">启动时自动将长期未交互的会话移入垃圾桶</span>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-label">未交互天数</div>
                  <div className="slider-row">
                    <input
                      type="range"
                      min={MIN_SESSION_CLEANUP_DAYS}
                      max="365"
                      step="1"
                      className="settings-slider"
                      value={sessionCleanupDays}
                      onChange={(e) => setSessionCleanupDays(normalizeSessionCleanupDays(e.target.value))}
                      disabled={!sessionCleanupEnabled}
                    />
                    <span className="slider-value">{sessionCleanupDays} 天</span>
                  </div>
                  <div className="settings-helper-text">
                    默认 {DEFAULT_SESSION_CLEANUP_DAYS} 天；只会移动到垃圾桶，可在 7 天内恢复。
                  </div>
                </div>

                {/* 分割线 */}
                <div style={{ borderTop: "1px solid var(--border-color)", margin: "16px 0" }} />

                {/* 会话名称修正 */}
                <div className="settings-group">
                  <div className="settings-group-label">会话名称修正</div>
                  <div className="settings-btn-group">
                    <button
                      className={`settings-toggle-btn ${namerMode === "heuristic" ? "active" : ""}`}
                      onClick={() => setNamerMode("heuristic")}
                    >
                      快速模式（本地）
                    </button>
                    <button
                      className={`settings-toggle-btn ${namerMode === "llm" ? "active" : ""}`}
                      onClick={() => setNamerMode("llm")}
                    >
                      精准模式（LLM）
                    </button>
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "6px", lineHeight: "1.6" }}>
                    {namerMode === "heuristic"
                      ? "纯本地字符串处理，零消耗，速度快但标题较粗糙"
                      : "调用 LLM 理解对话含义，生成精准标题，批量请求节省 token"}
                  </div>
                </div>

                {namerMode === "llm" && (
                  <div className="settings-group">
                    <div className="settings-group-label">LLM 配置（OpenAI 兼容接口）</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12px", width: "60px", color: "var(--text-secondary)" }}>URL</span>
                        <input
                          type="text"
                          value={llmApiUrl}
                          onChange={(e) => setLlmApiUrl(e.target.value)}
                          placeholder="https://api.deepseek.com"
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: "6px",
                            border: "1px solid var(--border-color)",
                            backgroundColor: "var(--bg-terminal)", color: "var(--text-primary)",
                            fontSize: "12px", outline: "none",
                          }}
                        />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12px", width: "60px", color: "var(--text-secondary)" }}>Key</span>
                        <input
                          type="password"
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder="sk-..."
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: "6px",
                            border: "1px solid var(--border-color)",
                            backgroundColor: "var(--bg-terminal)", color: "var(--text-primary)",
                            fontSize: "12px", outline: "none",
                          }}
                        />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "12px", width: "60px", color: "var(--text-secondary)" }}>模型</span>
                        <input
                          type="text"
                          value={llmModel}
                          onChange={(e) => setLlmModel(e.target.value)}
                          placeholder="deepseek-v4-flash"
                          style={{
                            flex: 1, padding: "6px 10px", borderRadius: "6px",
                            border: "1px solid var(--border-color)",
                            backgroundColor: "var(--bg-terminal)", color: "var(--text-primary)",
                            fontSize: "12px", outline: "none",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="settings-group">
                  <div className="settings-group-label">触发规则</div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={autoRenameOnStartup}
                        onChange={(e) => setAutoRenameOnStartup(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">启动时自动修正</span>
                  </div>
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={autoRenameOnIdle}
                        onChange={(e) => setAutoRenameOnIdle(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">会话空闲后自动修正</span>
                  </div>
                  {autoRenameOnIdle && (
                    <div style={{ paddingLeft: "44px", marginTop: "4px" }}>
                      <div className="slider-row">
                        <input
                          type="range"
                          min="1"
                          max="60"
                          step="1"
                          className="settings-slider"
                          value={idleMinutes}
                          onChange={(e) => setIdleMinutes(parseInt(e.target.value, 10))}
                        />
                        <span className="slider-value">{idleMinutes} 分钟</span>
                      </div>
                      <div className="settings-helper-text">
                        空闲超过此时间且有新对话内容时才触发修正
                      </div>
                    </div>
                  )}
                  <div className="settings-switch-row">
                    <label className="switch-container">
                      <input
                        type="checkbox"
                        checked={autoRenameSkipFavorites}
                        onChange={(e) => setAutoRenameSkipFavorites(e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                    <span className="switch-label">跳过收藏的会话</span>
                  </div>
                </div>

                <div className="settings-group">
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <button
                      className="settings-toggle-btn active"
                      onClick={handleManualRename}
                      disabled={isRenaming}
                      style={{ minWidth: "120px", opacity: isRenaming ? 0.6 : 1 }}
                    >
                      {isRenaming ? "修正中..." : "立即修正全部"}
                    </button>
                    {lastRenameResult && (
                      <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                        {lastRenameResult}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="settings-content about-page">
                <div className="about-logo">KK</div>
                <div className="about-title">KKCoder AI 终端管理器</div>
                <div className="about-version">版本: v1.2.0</div>
                <div className="about-desc">
                  极简、现代、克制的 AI 终端托管管理器。基于 Tauri 框架与 React 深度构建，为您提供丝滑的原生开发虚拟终端心流体验。
                </div>
                <div className="about-divider"></div>
                <div className="about-meta">
                  <p>© 2026 KKCoder Studio. All rights reserved.</p>
                  <p>由 Google DeepMind AAC 团队荣誉驱动</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
