import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  captureUserInputData,
  deriveSessionTitleFromInput,
} from "../utils/sessionTitle";

interface TerminalTabProps {
  sessionId: string;
  directory: string;
  agentType: "claude" | "codex";
  agentSessionId: string;
  isReopen: boolean;
  onSpawned?: () => void;
  onStateChange?: (busy: boolean) => void;
  busy?: boolean;
  isActive?: boolean;
  onCommandComplete?: () => void;
  onUserSubmittedInput?: (sessionId: string, submittedAt: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  /** Codex session 绑定后通知父组件更新 sessions 状态 */
  onSessionBound?: (sessionId: string, agentSessionId: string) => void;
}

const getTerminalThemeColors = (themeName: string) => {
  let isDark = false;
  if (themeName === "dark-blue" || themeName === "dark-purple" || themeName === "dark-zinc") {
    isDark = true;
  } else if (themeName === "auto") {
    isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    isDark = false;
  }

  return {
    background: isDark ? "#000000" : "#ffffff",
    foreground: isDark ? "#f8fafc" : "#334155",
    cursor: isDark ? "#f8fafc" : "#334155", // 使用原生前景色，消除多余亮色闪烁光标
    selectionBackground: isDark ? "rgba(29, 78, 216, 0.45)" : "rgba(59, 130, 246, 0.3)",
    black: isDark ? "#000000" : "#0f172a",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#8b5cf6",
    cyan: "#06b6d4",
    // 浅色模式下，ANSI White 必须映射为深灰色，否则白底白字无法看清
    white: isDark ? "#ffffff" : "#475569",
    // 浅色模式下，明亮色版本需要降低亮度（使用深沉的高饱和度色），保证高对比度与易读性
    brightBlack: isDark ? "#94a3b8" : "#64748b",
    brightRed: isDark ? "#f87171" : "#dc2626",
    brightGreen: isDark ? "#34d399" : "#16a34a",
    brightYellow: isDark ? "#fbbf24" : "#d97706",
    brightBlue: isDark ? "#60a5fa" : "#2563eb",
    brightMagenta: isDark ? "#a78bfa" : "#7c3aed",
    brightCyan: isDark ? "#22d3ee" : "#0891b2",
    // 浅色模式下，ANSI Bright White 必须映射为炭黑色，保证完美易读性
    brightWhite: isDark ? "#ffffff" : "#0f172a",
  };
};

interface ConversationTagInsertDetail {
  sessionId: string;
  text: string;
}

interface AtomicInputTag {
  id: number;
  start: number;
  end: number;
  text: string;
}

const getTextCharLength = (text: string) => Array.from(text).length;

const sliceTextByChars = (text: string, start: number, end?: number) => {
  return Array.from(text).slice(start, end).join("");
};

export const TerminalTab: React.FC<TerminalTabProps> = ({
  sessionId,
  directory,
  agentType,
  agentSessionId,
  isReopen,
  onSpawned,
  onStateChange,
  busy,
  isActive,
  onCommandComplete,
  onUserSubmittedInput,
  onRenameSession,
  onSessionBound,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const onCommandCompleteRef = useRef(onCommandComplete);
  useEffect(() => {
    onCommandCompleteRef.current = onCommandComplete;
  }, [onCommandComplete]);

  const isAnsweringRef = useRef<boolean>(false);
  const commandStartTimeRef = useRef<number>(0);
  const lastOutputTimeRef = useRef<number>(0);
  const debounceTimeoutRef = useRef<any>(null);


  // 0. 用于 Codex session 反查的轮询状态
  const codexSessionPollRef = useRef<boolean>(false);
  const codexSessionStartTsRef = useRef<number>(0);
  const codexPollTimerRef = useRef<any>(null);

  // 0. 用于自动命名的用户输入累积 buffer
  const userInputBufferRef = useRef<string>("");
  const atomicInputTagsRef = useRef<AtomicInputTag[]>([]);
  const atomicInputTagCounterRef = useRef<number>(0);
  const autoTitleDoneStorageKey = `kkcoder_session_auto_title_done_${sessionId}`;
  const isPastingRef = useRef(false);

  // 1. 用于还原粘贴内容的缓存 Ref
  const pastedTextsRef = useRef<Record<number, string>>({});
  const pasteCounterRef = useRef<number>(0);

  const registerPastedText = (text: string) => {
    if (text && (text.includes("\n") || text.includes("\r"))) {
      pasteCounterRef.current += 1;
      pastedTextsRef.current[pasteCounterRef.current] = text;
      log(`Registered folded paste #${pasteCounterRef.current} (len=${text.length})`);
    }
  };

  const processSelectionTextBeforeCopy = (text: string): string => {
    if (!text) return text;
    return text.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (match, idStr) => {
      const id = parseInt(idStr, 10);
      const originalText = pastedTextsRef.current[id];
      if (originalText !== undefined) {
        log(`Replacing placeholder [Pasted text #${id}...] with original text (len=${originalText.length})`);
        return originalText;
      }
      return match;
    });
  };

  // 2. 智能检测终端 buffer 末尾是否包含提示符
  const checkPromptAtEnd = (): boolean => {
    try {
      const term = xtermRef.current;
      if (!term) return false;
      const buffer = term.buffer.active;
      let lastLinesText = "";
      const startLine = Math.max(0, buffer.length - 4);
      for (let i = buffer.length - 1; i >= startLine; i--) {
        const line = buffer.getLine(i);
        if (line) {
          lastLinesText = line.translateToString() + "\n" + lastLinesText;
        }
      }
      const trimmed = lastLinesText.trim();
      
      const isPrompt = 
        />\s*$/.test(trimmed) ||
        /\$\s*$/.test(trimmed) ||
        /#\s*$/.test(trimmed) ||
        /\?\s*$/.test(trimmed) ||
        /bypass\s+permissions/i.test(trimmed) ||
        /shift\+tab\s+to\s+cycle/i.test(trimmed) ||
        /⇠\s+for\s+agents/i.test(trimmed);
        
      return isPrompt;
    } catch (e) {
      log(`Error checking prompt at end of buffer: ${e}`);
    }
    return false;
  };

  const log = (msg: string) => {
    const time = new Date().toISOString();
    const fullMsg = `[JS][TerminalTab][${sessionId}][${time}] ${msg}`;
    console.log(fullMsg);
    try {
      const existingLogs = JSON.parse(localStorage.getItem("kkcoder_logs") || "[]");
      existingLogs.push(fullMsg);
      if (existingLogs.length > 200) {
        existingLogs.shift();
      }
      localStorage.setItem("kkcoder_logs", JSON.stringify(existingLogs));
    } catch (e) {}
  };

  // ⭐ Codex session 反查：用户首次发消息后，轮询找到 codex 生成的 session 文件并持久化绑定
  const pollCodexSession = (sid: string) => {
    if (codexSessionPollRef.current) return;
    codexSessionPollRef.current = true;
    codexSessionStartTsRef.current = Date.now();
    log(`[CodexSession] ${sid} 开始轮询 codex session 文件...`);

    const POLL_INTERVAL = 1500;
    const POLL_TIMEOUT = 60000;
    const INITIAL_DELAY = 2000;
    let isFirstTick = true;

    codexPollTimerRef.current = setInterval(async () => {
      const elapsed = Date.now() - codexSessionStartTsRef.current;

      // 60s 超时放弃
      if (elapsed > POLL_TIMEOUT) {
        clearInterval(codexPollTimerRef.current);
        codexPollTimerRef.current = null;
        codexSessionPollRef.current = false;
        log(`[CodexSession] ${sid} 轮询超时（60s），放弃`);
        return;
      }

      // 首次 tick 等待初始延迟
      if (isFirstTick) {
        isFirstTick = false;
        if (elapsed < INITIAL_DELAY) {
          return;
        }
      }

      try {
        // ⭐ 调试：记录每个 tick 的实际查询
        log(`[CodexSession] ${sid} 第 ${Math.round(elapsed/1000)}s 调用 find_latest_codex_session...`);

        const result = await invoke<{ agentSessionId: string; jsonlPath: string } | null>(
          "find_latest_codex_session",
          { sessionId: sid }  // 对应 Rust: FindCodexSessionRequest { session_id } + #[serde(rename_all = "camelCase")]
        );

        // ⭐ 调试：记录返回值
        log(`[CodexSession] ${sid} find_latest 返回: ${JSON.stringify(result)}`);

        if (result?.agentSessionId) {
          clearInterval(codexPollTimerRef.current);
          codexPollTimerRef.current = null;
          codexSessionPollRef.current = false;
          log(`[CodexSession] ${sid} 查得 codex session_id=${result.agentSessionId}, path=${result.jsonlPath}`);

          // 持久化绑定到 SQLite
          try {
            await invoke("bind_codex_session", {
              sessionId: sid,
              agentSessionId: result.agentSessionId,
            });
            log(`[CodexSession] ${sid} 已持久化绑定 agentSessionId=${result.agentSessionId}`);
          } catch (bindErr) {
            log(`[CodexSession] ${sid} bind 调用失败: ${bindErr}`);
            return;
          }

          // 通知父组件更新 sessions 状态
          onSessionBound?.(sid, result.agentSessionId);
        } else {
          // ⭐ 调试：本轮未返回有效结果
          log(`[CodexSession] ${sid} 第 ${Math.round(elapsed/1000)}s 未命中（result=${JSON.stringify(result)}），继续轮询...`);
        }
      } catch (err) {
        log(`[CodexSession] ${sid} invoke 异常: ${err}`);
      }
    }, POLL_INTERVAL);
  };

  // 监听来自父组件的 busy 繁忙状态信号，自动同步 isAnsweringRef 并开始 PTY 静默监测
  useEffect(() => {
    if (busy) {
      log("TerminalTab busy prop changed to true. Activating isAnsweringRef for PTY tracking...");
      isAnsweringRef.current = true;
      commandStartTimeRef.current = Date.now();
      lastOutputTimeRef.current = Date.now();
    }
  }, [busy, sessionId]);

  useEffect(() => {
    let resizeTimeout: any = null;

    log(`useEffect triggered: directory=${directory}, agentType=${agentType}, isReopen=${isReopen}`);
    if (!terminalRef.current) {
      log("Error: terminalRef.current is null! Returning.");
      return;
    }

    log("Initializing Terminal instance...");
    // 1. 根据当前选择的主题自适应配置终端黑白底色 (前三个黑底，后三个白底)
    const savedTheme = localStorage.getItem("kkcoder_setting_theme") || "light-premium";
    const savedFont = localStorage.getItem("kkcoder_setting_font_family") || "Cascadia Mono";
    const savedSizeStr = localStorage.getItem("kkcoder_setting_font_size");
    const savedSize = savedSizeStr ? parseFloat(savedSizeStr) : 13.5;
    const initialColors = getTerminalThemeColors(savedTheme);

    const savedScrollbackStr = localStorage.getItem("kkcoder_setting_scrollback");
    let savedScrollback = savedScrollbackStr ? parseInt(savedScrollbackStr, 10) : 10000;
    if (isNaN(savedScrollback) || savedScrollback < 1000) {
      savedScrollback = 1000;
    } else if (savedScrollback > 100000) {
      savedScrollback = 100000;
    }

    const term = new Terminal({
      scrollback: savedScrollback, // 根据设置读取终端可回看的最大行数
      cursorBlink: true,
      fontSize: savedSize,
      fontFamily: `${savedFont}, Fira Code, Consolas, Monaco, monospace`,
      theme: initialColors,
      convertEol: true,
      minimumContrastRatio: 4.5,
    });

    // 注册自定义 LinkProvider 支持网页链接和 Windows 本地路径点击打开
    term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }

        // 拼接字符串并映射每一字符在 terminal 中的 1-indexed 起始列 (解决中文字符双宽 cell 偏移问题)
        let lineStr = "";
        const colMap: number[] = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) continue;
          const chars = cell.getChars();
          const width = cell.getWidth();
          if (width === 0) continue; // 宽字符占位续格，跳过
          
          const startIdx = lineStr.length;
          lineStr += chars;
          for (let i = startIdx; i < lineStr.length; i++) {
            colMap[i] = x + 1;
          }
        }

        const links: any[] = [];

        // 1. 匹配 Web 网址 (http:// 或 https://)
        const urlRegex = /https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
        let match;
        while ((match = urlRegex.exec(lineStr)) !== null) {
          const matchedText = match[0];
          const startStrIdx = match.index;
          const endStrIdx = match.index + matchedText.length - 1;
          
          const startCol = colMap[startStrIdx];
          const endColCellIdx = colMap[endStrIdx] - 1;
          const endCell = line.getCell(endColCellIdx);
          const endCellWidth = endCell ? endCell.getWidth() : 1;
          const endCol = colMap[endStrIdx] + (endCellWidth - 1);

          links.push({
            text: matchedText,
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber }
            },
            activate(_event: any, text: string) {
              import("@tauri-apps/plugin-opener").then(({ openUrl }) => {
                openUrl(text).catch((err: any) => console.error("打开网址失败:", err));
              });
            }
          });
        }

        // 2. 匹配 Windows 路径 (形如 D:\MyCode\KKCODER 或 D:\MyCode\KKCODER\主题样式_spec.md)
        // 有扩展名时：扩展名后遇到中文括号停止（解决 Claude Code 输出文件大小问题）
        // 无扩展名时：遇到中文括号停止
        const pathRegex = /[a-zA-Z]:\\(?:[^:?"*|<> \t\r\n（）]*\.[^:?"*|<> \t\r\n（）]*|[^\s:?"*|<>（）]+)/g;
        while ((match = pathRegex.exec(lineStr)) !== null) {
          const matchedText = match[0];
          const startStrIdx = match.index;
          const endStrIdx = match.index + matchedText.length - 1;

          const startCol = colMap[startStrIdx];
          const endColCellIdx = colMap[endStrIdx] - 1;
          const endCell = line.getCell(endColCellIdx);
          const endCellWidth = endCell ? endCell.getWidth() : 1;
          const endCol = colMap[endStrIdx] + (endCellWidth - 1);

          links.push({
            text: matchedText,
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber }
            },
            activate(_event: any, text: string) {
              invoke("open_terminal_path", { path: text }).catch((err: any) => {
                console.error("打开路径失败:", err);
              });
            }
          });
        }

        callback(links);
      }
    });

    log("Loading FitAddon and opening terminal in container...");
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    // xterm 6.x 默认使用 DOM Renderer，已内置现代化重写，对 AI 终端场景性能足够。
    // 未插入 CanvasAddon：官方 addon-canvas@0.7.0 的 peer 声明仍为 xterm ^5.0.0，与 6.0 实际尚未完全对齐，强行接入会黑屏，待官方释出 0.8 稳定版后再评估回插。
    let initialTerminalDimensions: { cols: number; rows: number } | null = null;
    try {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.cols >= 20 && dims.rows >= 5) {
        initialTerminalDimensions = { cols: dims.cols, rows: dims.rows };
        log(`Initial terminal dimensions before spawn: cols=${dims.cols}, rows=${dims.rows}`);
      }
    } catch (e) {
      log(`Failed to measure initial terminal dimensions before spawn: ${e}`);
    }

    // 绑定自定义键盘按键处理器：支持 Ctrl+C 进行快捷复制且禁用退出命令，支持 Ctrl+V 完美粘贴且阻断重复
    const pruneAtomicInputTags = () => {
      const buffer = userInputBufferRef.current;
      const bufferLength = getTextCharLength(buffer);
      atomicInputTagsRef.current = atomicInputTagsRef.current.filter((tag) => {
        if (tag.end > bufferLength) return false;
        return sliceTextByChars(buffer, tag.start, tag.end) === tag.text;
      });
    };

    const registerAtomicInputTag = (text: string) => {
      const start = getTextCharLength(userInputBufferRef.current);
      const end = start + getTextCharLength(text);
      atomicInputTagCounterRef.current += 1;
      atomicInputTagsRef.current.push({
        id: atomicInputTagCounterRef.current,
        start,
        end,
        text,
      });
      userInputBufferRef.current += text;
    };

    const tryDeleteTrailingAtomicInputTag = () => {
      pruneAtomicInputTags();
      const buffer = userInputBufferRef.current;
      const bufferLength = getTextCharLength(buffer);
      const tag = [...atomicInputTagsRef.current].reverse().find((candidate) => {
        return candidate.end === bufferLength && sliceTextByChars(buffer, candidate.start, candidate.end) === candidate.text;
      });

      if (!tag) return false;

      const deleteSequence = "\x7f".repeat(getTextCharLength(tag.text));
      userInputBufferRef.current = sliceTextByChars(buffer, 0, tag.start);
      atomicInputTagsRef.current = atomicInputTagsRef.current.filter((candidate) => candidate.id !== tag.id);

      invoke("write_to_terminal", { sessionId, data: deleteSequence }).catch((err) => {
        log(`write_to_terminal atomic tag delete error: ${err}`);
      });
      return true;
    };

    const handleInsertConversationTag = (event: Event) => {
      const { detail } = event as CustomEvent<ConversationTagInsertDetail>;
      if (!detail || detail.sessionId !== sessionId || !detail.text) return;

      registerAtomicInputTag(detail.text);
      invoke("write_to_terminal", { sessionId, data: detail.text })
        .then(() => {
          term.focus();
        })
        .catch((err) => {
          log(`write_to_terminal atomic tag insert error: ${err}`);
        });
    };

    window.addEventListener("kkcoder-insert-conversation-tag", handleInsertConversationTag);

    term.attachCustomKeyEventHandler((arg) => {
      if (arg.code === "Escape" || arg.key === "Escape") {
        if (arg.type === "keydown") {
          // 检查是否有任何弹窗、主题下拉菜单、搜索栏或预览面板处于打开状态
          const hasOpenPanel = !!(
            document.querySelector(".modal-overlay.show") ||
            document.querySelector(".theme-dropdown") ||
            document.querySelector(".file-preview-modal")
          );
          if (hasOpenPanel) {
            // 允许事件冒泡至 window，以便全局按键监听器可以关闭面板/弹窗
            return false;
          } else {
            // 无任何面板打开，直接将 Escape 发送给 PTY 终端进行处理（如清空命令行输入）
            return true;
          }
        }
        return false;
      }

      if ((arg.code === "Backspace" || arg.key === "Backspace") && arg.type === "keydown" && !arg.ctrlKey && !arg.altKey && !arg.metaKey) {
        if (tryDeleteTrailingAtomicInputTag()) {
          return false;
        }
      }

      if (arg.ctrlKey && arg.code === "KeyC") {
        if (arg.type === "keydown") {
          if (term.hasSelection()) {
            const selectedText = term.getSelection();
            const processedText = processSelectionTextBeforeCopy(selectedText);
            navigator.clipboard.writeText(processedText).catch((err) => {
              log(`Failed to copy selected text via Ctrl+C: ${err}`);
            });
          }
        }
        return false; // 返回 false 拦截所有默认行为 (禁用 PTY 响应 Ctrl+C 退出进程)
      }

      if (arg.ctrlKey && arg.code === "KeyV") {
        if (arg.type === "keydown" && !arg.repeat) {
          log("Ctrl+V keydown event captured in terminal. Reading clipboard text first...");
          navigator.clipboard.readText().then(async (text) => {
            let isFilePath = false;
            if (text && text.trim().length > 0) {
              try {
                isFilePath = await invoke<boolean>("check_if_paths_exist", { text });
              } catch (err) {
                log(`Failed to check if paths exist: ${err}`);
              }
            }

            if (isFilePath) {
              log(`Detected file paths in clipboard text: ${text}`);
              const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
              const formatted = lines.map(line => {
                const clean = line.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
                if (/\.(png|jpe?g|gif|webp|bmp|tiff)$/i.test(clean)) {
                  // Append a zero-width space to prevent Claude Code from auto-converting to [Image]
                  return `${clean}​`;
                }
                return clean;
              }).join(" ");
              term.paste(formatted);
            } else {
              try {
                const clipboardItems = await navigator.clipboard.read();
                let hasImage = false;
                for (const clipboardItem of clipboardItems) {
                  for (const type of clipboardItem.types) {
                    if (type.startsWith("image/")) {
                      hasImage = true;
                      log(`Detected image paste of type: ${type}`);
                      try {
                        const blob = await clipboardItem.getType(type);
                        const filename = `clipboard_img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.png`;

                        const reader = new FileReader();
                        reader.onload = async () => {
                          try {
                            const arrayBuffer = reader.result as ArrayBuffer;
                            const bytes = new Uint8Array(arrayBuffer);
                            const filePath = await invoke<string>("save_clipboard_image", {
                              bytes: Array.from(bytes),
                              filename
                            });
                            log(`Successfully saved clipboard image to: ${filePath}`);
                            // Append a zero-width space to prevent Claude Code from auto-converting to [Image]
                            term.paste(`${filePath}​`);
                          } catch (e) {
                            log(`Failed to save clipboard image via Tauri: ${e}`);
                          }
                        };
                        reader.readAsArrayBuffer(blob);
                      } catch (e) {
                        log(`Failed to read clipboard image blob: ${e}`);
                      }
                      break;
                    }
                  }
                  if (hasImage) break;
                }
                
                if (!hasImage) {
                  if (text) {
                    log(`Pasting clipboard text (len=${text.length}).`);
                    registerPastedText(text);
                    term.paste(text);
                  }
                }
              } catch (err) {
                log(`Failed to read clipboard items, falling back to text: ${err}`);
                if (text) {
                  registerPastedText(text);
                  term.paste(text);
                }
              }
            }
          }).catch((err) => {
            log(`Failed to read clipboard text: ${err}`);
            navigator.clipboard.read().then(async (clipboardItems) => {
              let hasImage = false;
              for (const clipboardItem of clipboardItems) {
                for (const type of clipboardItem.types) {
                  if (type.startsWith("image/")) {
                    hasImage = true;
                    log(`Detected image paste of type: ${type}`);
                    try {
                      const blob = await clipboardItem.getType(type);
                      const filename = `clipboard_img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.png`;

                      const reader = new FileReader();
                      reader.onload = async () => {
                        try {
                          const arrayBuffer = reader.result as ArrayBuffer;
                          const bytes = new Uint8Array(arrayBuffer);
                          const filePath = await invoke<string>("save_clipboard_image", {
                            bytes: Array.from(bytes),
                            filename
                          });
                          log(`Successfully saved clipboard image to: ${filePath}`);
                          // Append a zero-width space to prevent Claude Code from auto-converting to [Image]
                          term.paste(`${filePath}​`);
                        } catch (e) {
                          log(`Failed to save clipboard image via Tauri: ${e}`);
                        }
                      };
                      reader.readAsArrayBuffer(blob);
                    } catch (e) {
                      log(`Failed to read clipboard image blob: ${e}`);
                    }
                    break;
                  }
                }
                if (hasImage) break;
              }
            }).catch((e) => {
              log(`Failed all clipboard fallbacks: ${e}`);
            });
          });
        }
        return false; // 返回 false 拦截浏览器默认及 keyup/keydown 重复事件，规避双重粘贴
      }
      return true;
    });

    // 绑定选择改变处理器：当有文本被选中时，自动将其复制到剪贴板中 (高度平替 copyOnSelect)
    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        const selectedText = term.getSelection();
        const processedText = processSelectionTextBeforeCopy(selectedText);
        navigator.clipboard.writeText(processedText).catch((err) => {
          log(`Failed to copy selection on select: ${err}`);
        });
      }
    });
    
    // 延迟少许等 DOM 渲染完成后精准测量尺寸
    log("Scheduling initial fit addon measurement (100ms)...");
    setTimeout(() => {
      try {
        log("Executing fitAddon.fit()");
        fitAddon.fit();
        term.scrollToBottom(); // 确保初次加载和挂载时视口强制滚动到最下方
        log("fitAddon.fit() completed.");
      } catch (e) {
        log(`Error running fitAddon.fit(): ${e}`);
        console.error(e);
      }
    }, 100);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    let unlistenFn: (() => void) | null = null;
    let listenerCancelled = false; // 防范异步 listener 竞态：cleanup 后短路
    let lastSeq: number = 0; // 用于检测并丢弃重复包（防范 ConPTY 屏幕缓冲区重发）

    // 2. 异步注册监听 Rust 后端 PTY Event 消息流
    log("Setting up pty-output listener...");
    const setupListener = async () => {
      try {
        const fn = await listen<{ session_id: string; data: string; seq: number }>(
          "pty-output",
          (event) => {
            if (listenerCancelled) return; // cleanup 后立即短路，防范重复写入
            if (event.payload.session_id === sessionId) {
              // 序列号去重：丢弃重复包（ConPTY 可能重发屏幕内容）
              if (event.payload.seq !== 0 && event.payload.seq <= lastSeq) {
                log(`Duplicate PTY packet detected: seq=${event.payload.seq}, lastSeq=${lastSeq}. Skipping.`);
                return;
              }
              lastSeq = event.payload.seq;
              term.write(event.payload.data);

              // 智能回答/任务执行完毕检测与提示音系统
              if (isAnsweringRef.current) {
                lastOutputTimeRef.current = Date.now();
                if (debounceTimeoutRef.current) {
                  clearTimeout(debounceTimeoutRef.current);
                }

                // 智能检测是否到了命令行/权限提示符：若是则延迟 800ms，否则在代码生成或大段思考中间，延迟 3500ms
                const isPrompt = checkPromptAtEnd();
                const delay = isPrompt ? 800 : 3500;

                debounceTimeoutRef.current = setTimeout(() => {
                  const elapsed = (Date.now() - commandStartTimeRef.current) / 1000;
                  log(`检测到 PTY 静默，延迟 ${delay}ms 后执行结束判定。本次持续耗时: ${elapsed.toFixed(2)} 秒`);

                  const notifyEnabled = localStorage.getItem("kkcoder_setting_notify_on_complete") !== "false";
                  const notifyThresholdStr = localStorage.getItem("kkcoder_setting_notify_threshold");
                  const notifyThreshold = notifyThresholdStr ? parseFloat(notifyThresholdStr) : 2.0;
                  const playSoundEnabled = localStorage.getItem("kkcoder_setting_play_sound") !== "false";
                  const soundTone = localStorage.getItem("kkcoder_setting_sound_tone") || "dingdong";
                  const soundVolumeStr = localStorage.getItem("kkcoder_setting_sound_volume");
                  const soundVolume = soundVolumeStr ? parseInt(soundVolumeStr, 10) : 80;

                  if (notifyEnabled && elapsed >= notifyThreshold) {
                    log(`满足提示阈值 (${elapsed.toFixed(2)}s >= ${notifyThreshold}s)。触发提示音与系统通知。`);
                    
                    invoke("play_notification_sound", {
                      tone: soundTone,
                      volume: soundVolume,
                      title: "KKCoder AI 终端",
                      message: playSoundEnabled 
                        ? `回答完毕！本次运行共耗时 ${elapsed.toFixed(1)} 秒。`
                        : null // 若不启用播放提示音，则仅通过 null 标记静默通知
                    }).catch((err) => {
                      log(`Failed to trigger play_notification_sound: ${err}`);
                    });
                  }

                  isAnsweringRef.current = false;
                  debounceTimeoutRef.current = null;
                  if (onStateChange) {
                    onStateChange(false);
                  }
                  if (onCommandCompleteRef.current) {
                    onCommandCompleteRef.current();
                  }
                }, delay);
              }

              // Codex 暂不在此处捕获 session ID（Codex 的 session 管理是内部的，由 `codex --resume` 处理）
              // TODO: 后续可解析 Codex 输出中的 `session_id: xxx` 实现精确 resume
            }
          }
        );
        // 如果 cleanup 已经执行，立即销毁新注册的 listener，杜绝泄漏
        if (listenerCancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
        log("pty-output listener registered successfully.");
      } catch (e) {
        log(`Failed to set up pty-output listener: ${e}`);
      }
    };
    setupListener();

    // 3. 监听前端的键盘按键并将 keystroke 发送到 Rust PTY
    log("Binding term.onData to write_to_terminal...");
    const onDataDisposable = term.onData((data) => {
      // 粘贴操作不触发提交检测，换行符仅作为普通输入传递给终端
      if (isPastingRef.current) {
        isPastingRef.current = false;
        invoke("write_to_terminal", { sessionId, data }).catch((err) => {
          log(`write_to_terminal error: ${err}`);
        });
        return;
      }

      // 累积用户的实际输入到 buffer：兼容中文 IME、粘贴、多字符批量提交，并过滤控制序列。
      const capturedInput = captureUserInputData(userInputBufferRef.current, data);
      userInputBufferRef.current = capturedInput.buffer;
      pruneAtomicInputTags();

      // 当输入流中含有回车键或换行符时，标志着用户发送了命令，启动回答计时器
      let submittedAt: string | null = null;
      if (capturedInput.submitted) {
        const rawInput = capturedInput.submittedInput.trim();
        log(`User input from buffer: "${rawInput}"`);

        if (rawInput) {
          submittedAt = new Date().toISOString();
        }

        // 只在新建终端里用第一条真实用户输入自动命名，避免恢复会话时误吃终端状态文本。
        if (!isReopen && !localStorage.getItem(autoTitleDoneStorageKey)) {
          // 从累积的用户输入 buffer 中提取第一句提问作为会话的新名称
          try {
            const finalName = deriveSessionTitleFromInput(rawInput);
            if (finalName && onRenameSession) {
              localStorage.setItem(autoTitleDoneStorageKey, "true");
              localStorage.setItem(`kkcoder_session_has_dialogue_${sessionId}`, "true");
              log(`Auto-renaming session ${sessionId} to: "${finalName}"`);
              onRenameSession(sessionId, finalName);
            } else {
              log("Skip auto-renaming: first submitted input was empty or a terminal status prompt.");
            }
          } catch (e) {
            log(`Failed to auto-rename first session phrase: ${e}`);
          }
        }

        // 回车后清空输入 buffer，为下一次输入做准备
        userInputBufferRef.current = "";
        atomicInputTagsRef.current = [];

        // ⭐ Codex 首次提交后，启动轮询反查 session 文件并持久化绑定
        if (agentType === "codex" && !agentSessionId && !codexSessionPollRef.current) {
          pollCodexSession(sessionId);
        }

        isAnsweringRef.current = true;
        commandStartTimeRef.current = Date.now();
        lastOutputTimeRef.current = Date.now();
        if (onStateChange) {
          onStateChange(true);
        }
      }
      invoke("write_to_terminal", { sessionId, data })
        .then(() => {
          if (submittedAt) {
            onUserSubmittedInput?.(sessionId, submittedAt);
          }
        })
        .catch((err) => {
          log(`write_to_terminal error: ${err}`);
        });
    });

    // 4. 监听终端自身的 resize 事件并同步到 PTY
    log("Binding term.onResize to resize_terminal...");
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      invoke("resize_terminal", { sessionId, cols, rows }).catch((err) => {
        log(`resize_terminal error: ${err}`);
      });
    });

    // 5. 调用 Rust spawn_terminal 接口拉起后端 PTY 进程
    log("Calling Backend invoke('spawn_terminal')...");
    invoke("spawn_terminal", {
      sessionId,
      directory,
      agentType,
      agentSessionId,
      isReopen,
      initialCols: initialTerminalDimensions?.cols ?? null,
      initialRows: initialTerminalDimensions?.rows ?? null,
    })
      .then(() => {
        log("Backend spawn_terminal resolved successfully.");
        if (onSpawned) {
          onSpawned();
        }
        // PTY 成功拉起后，强制执行 fit，随后再 proposeDimensions 尺寸同步给 PTY
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            log(`Proposing terminal dimensions: cols=${dims.cols}, rows=${dims.rows}`);
            invoke("resize_terminal", {
              sessionId,
              cols: dims.cols,
              rows: dims.rows,
            }).catch((err) => log(`Initial resize_terminal error: ${err}`));
          }
        } catch (e) {
          log(`Error proposing dimensions: ${e}`);
          console.error(e);
        }
      })
      .catch((err) => {
        log(`Backend spawn_terminal REJECTED: ${err}`);
        term.write(
          `\r\n\x1b[31m[KKCoder 核心错误] 无法拉起本地虚拟终端: ${err}\x1b[0m\r\n`
        );
      });

    // 6. 使用 ResizeObserver 监听容器尺寸的物理变化，比 window.resize 更加灵敏和靠谱
    const handleResize = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        try {
          if (!isActive) {
            // 如果该 Tab 当前处于非激活状态 (display: none)，则直接跳过 fit，防范缩成 0 行的 bug
            return;
          }
          fitAddon.fit();
          term.scrollToBottom(); // 确保容器尺寸改变时，视口强制滚动到最下方，绝不遮挡输入框
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            // 防御：cols 和 rows 必须大于合理值，防范容器大小过渡期瞬时极小而导致的 PTY 强制折行与严重乱码错位
            if (dims.cols < 20 || dims.rows < 5) {
              log(`Ignore micro resize dims: cols=${dims.cols}, rows=${dims.rows}`);
              return;
            }
            invoke("resize_terminal", {
              sessionId,
              cols: dims.cols,
              rows: dims.rows,
            }).catch((err) => log(`Terminal resize sync error: ${err}`));
          }
        } catch (e) {
          // 捕获未挂载时测量的尺寸异常
        }
      }, 120); // 120ms 防抖，过滤高频 resize 触发，让侧边栏拖拽顺畅无比且终端完全不闪烁
    };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          // 只有当尺寸确实大于 0 且处于 active 状态时才执行 fit
          handleResize();
        }
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }
    const handleRawContextMenu = (e: MouseEvent) => {
      if (terminalRef.current && terminalRef.current.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        
        if (term.hasSelection()) {
          const selectedText = term.getSelection();
          const processedText = processSelectionTextBeforeCopy(selectedText);
          navigator.clipboard.writeText(processedText)
            .then(() => {
              log("Copied selection quietly on right-click.");
            })
            .catch((err) => {
              log(`Failed to copy selection on contextmenu: ${err}`);
            });
        }
      }
    };
    document.addEventListener("contextmenu", handleRawContextMenu, true);

    // 注册系统级粘贴静默盾牌，彻底防范任何 WebView2 原生 edit 命令引发的双份粘贴或非预期落盘事件
    const handlePaste = (e: ClipboardEvent) => {
      log("Native paste event captured in silent shield. Silencing standard insertion...");
      isPastingRef.current = true;
      e.preventDefault();
      e.stopPropagation();
    };
    const handleScrollCapture = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      if (target.classList && target.classList.contains("xterm-viewport")) {
        if (target.scrollLeft !== 0) {
          target.scrollLeft = 0;
        }
      } else {
        if (target.scrollLeft !== 0) {
          target.scrollLeft = 0;
        }
        if (target.scrollTop !== 0) {
          target.scrollTop = 0;
        }
      }
    };

    const terminalElement = terminalRef.current;
    const parentElement = terminalElement?.parentElement;

    if (terminalElement) {
      terminalElement.addEventListener("paste", handlePaste, true);
      terminalElement.addEventListener("scroll", handleScrollCapture, true);
      if (parentElement) {
        parentElement.addEventListener("scroll", handleScrollCapture, true);
      }
    }

    // 7. 监听主题切换的全局自定义事件，实现 PTY 终端画布底色实时刷新 (黑底 `#000000` / 白底 `#ffffff`)
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      const newTheme = customEvent.detail;
      log(`Received theme change event: theme=${newTheme}`);
      const newColors = getTerminalThemeColors(newTheme);
      term.options.theme = newColors;
    };
    window.addEventListener("kkcoder-theme-change", handleThemeChange);

    // 7b. 监听终端字体切换的全局自定义事件，实现 PTY 终端字体实时更新
    const handleFontChange = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      const newFont = customEvent.detail;
      log(`Received font change event: font=${newFont}`);
      term.options.fontFamily = `${newFont}, Fira Code, Consolas, Monaco, monospace`;
    };
    window.addEventListener("kkcoder-font-change", handleFontChange);

    // 7c. 监听终端字号切换的全局自定义事件，实现 PTY 终端字号实时更新并自动重测尺寸
    const handleFontSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent<number>;
      const newSize = customEvent.detail;
      log(`Received font size change event: size=${newSize}`);
      term.options.fontSize = newSize;
      
      if (!isActive) {
        // 非激活状态的标签页不进行 fit 计算以防缩至 0 行，激活时自然会重新 fit 覆盖
        return;
      }

      // 精准防抖动触发 fit，等 Canvas 重绘完成
      setTimeout(() => {
        try {
          fitAddon.fit();
          term.scrollToBottom(); // 确保字号发生热切时，视口也强制滚动到最下方
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            invoke("resize_terminal", {
              sessionId,
              cols: dims.cols,
              rows: dims.rows,
            }).catch((err) => log(`Font size change resize sync error: ${err}`));
          }
        } catch (err) {}
      }, 50);
    };
    window.addEventListener("kkcoder-font-size-change", handleFontSizeChange);

    return () => {
      log("TerminalTab unmounting. Cleaning up...");
      // 先标记 listener 已取消，防范异步 listener 竞态泄漏
      listenerCancelled = true;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      document.removeEventListener("contextmenu", handleRawContextMenu, true);
      if (terminalElement) {
        terminalElement.removeEventListener("paste", handlePaste, true);
        terminalElement.removeEventListener("scroll", handleScrollCapture, true);
      }
      if (parentElement) {
        parentElement.removeEventListener("scroll", handleScrollCapture, true);
      }
      resizeObserver.disconnect();
      window.removeEventListener("kkcoder-theme-change", handleThemeChange);
      window.removeEventListener("kkcoder-font-change", handleFontChange);
      window.removeEventListener("kkcoder-font-size-change", handleFontSizeChange);
      window.removeEventListener("kkcoder-insert-conversation-tag", handleInsertConversationTag);
      // 清理 codex session 反查轮询
      if (codexPollTimerRef.current) {
        clearInterval(codexPollTimerRef.current);
        codexPollTimerRef.current = null;
        codexSessionPollRef.current = false;
      }
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
      term.dispose();
      log("TerminalTab cleanup finished.");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, directory, agentType]);

  // 当标签页激活时，自动将物理焦点 focus 绑定给当前终端，实现“一开即写、一切即敲”的高端心流
  // 同时，触发 fitAddon.fit() 重新计算终端画布大小，并同步给 PTY 进程，彻底解决 display: none 到 flex 转换导致的界面缩水/缩成一行的问题
  useEffect(() => {
    if (isActive && xtermRef.current) {
      log(`Auto-focusing and fitting terminal instance for active session: ${sessionId}`);
      // 立即执行一次 fit，防止在布局显示时出现短暂空白或闪烁
      try {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
        }
      } catch (e) {}

      // 延迟 80ms 等 DOM 完全刷新 (display: flex 生效) 后平滑捕获系统焦点并重新测绘画布
      const timer = setTimeout(() => {
        try {
          if (fitAddonRef.current && xtermRef.current) {
            fitAddonRef.current.fit();
            xtermRef.current.scrollToBottom();
            const dims = fitAddonRef.current.proposeDimensions();
            if (dims) {
              log(`Active tab fit dimensions: cols=${dims.cols}, rows=${dims.rows}`);
              invoke("resize_terminal", {
                sessionId,
                cols: dims.cols,
                rows: dims.rows,
              }).catch((err) => log(`Active tab resize sync error: ${err}`));
            }
          }
          xtermRef.current?.focus();
        } catch (e) {
          console.error("Failed to focus or fit terminal", e);
        }
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isActive, sessionId]);

  // 监听来自全局的自动聚焦指令，使得在文件/行号添加到对话等操作后，终端能够瞬间自动重新获得焦点
  useEffect(() => {
    const handleFocusRequest = () => {
      if (isActive && xtermRef.current) {
        xtermRef.current.focus();
      }
    };
    window.addEventListener("kkcoder-focus-active-terminal", handleFocusRequest);
    return () => {
      window.removeEventListener("kkcoder-focus-active-terminal", handleFocusRequest);
    };
  }, [isActive]);

  // 监听"跳到终端锚点"事件：在 xterm buffer 中搜索并滚动到对应行
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ sessionId: string; anchor: string }>;
      const detail = ce.detail;
      if (!detail || detail.sessionId !== sessionId || !detail.anchor) return;

      const term = xtermRef.current;
      if (!term) {
        log(`[scroll-to-anchor] xterm not ready for session=${sessionId}`);
        return;
      }

      // 退避重试：xterm 可能还在重新 fit / buffer 未稳定
      const tryScroll = (attempt: number) => {
        const termNow = xtermRef.current;
        if (!termNow) return;
        const buffer = termNow.buffer.active;
        const total = buffer.length;

        // 优化匹配：用前 20 字符作为关键词，过长容易匹配不到
        const needle = detail.anchor.slice(0, 20);
        if (!needle) {
          log(`[scroll-to-anchor] empty anchor`);
          return;
        }

        let foundY = -1;
        // 优先在可视区附近查找，再向两端扩展
        const viewportY = buffer.viewportY;
        const size = termNow.rows;
        const startY = Math.max(0, viewportY - 200);
        const endY = Math.min(total, viewportY + size + 200);

        for (let y = startY; y < endY; y++) {
          const line = buffer.getLine(y);
          if (!line) continue;
          const text = line.translateToString(true);
          if (text && text.includes(needle)) {
            foundY = y;
            break;
          }
        }
        // 如果附近没找到，全局扫描兜底（限 5k 行以避免卡顿）
        if (foundY < 0 && total < 5000) {
          for (let y = 0; y < total; y++) {
            const line = buffer.getLine(y);
            if (!line) continue;
            const text = line.translateToString(true);
            if (text && text.includes(needle)) {
              foundY = y;
              break;
            }
          }
        }

        if (foundY >= 0) {
          log(`[scroll-to-anchor] found at y=${foundY} for anchor="${needle}"`);
          // 让该行尽量落在视口中央
          const targetY = Math.max(0, foundY - Math.floor(size / 2));
          termNow.scrollToLine(targetY);
        } else {
          if (attempt < 2) {
            log(`[scroll-to-anchor] not found, retry ${attempt + 1}`);
            setTimeout(() => tryScroll(attempt + 1), 200);
          } else {
            log(`[scroll-to-anchor] not found after retries, anchor="${needle}"`);
            // 找不到时仅记录日志，UI 不阻塞
          }
        }
      };

      // 第一次延迟 80ms 等待 fit 完成
      setTimeout(() => tryScroll(0), 80);
    };

    window.addEventListener("kkcoder-scroll-to-anchor", handler);
    return () => window.removeEventListener("kkcoder-scroll-to-anchor", handler);
  }, [sessionId]);

  return (
    <div className={`terminal-container agent-type-${agentType}`}>
      <div className="terminal-ref" ref={terminalRef} />
    </div>
  );
};
