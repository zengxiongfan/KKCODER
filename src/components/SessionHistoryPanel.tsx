import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

// ==================== 类型定义 ====================
interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  timestamp?: string | null;
  content: string;
  toolName?: string | null;
  toolInput?: any;
  toolResult?: string | null;
  model?: string | null;
  /** 用于在 xterm buffer 中定位的短锚点；tool 类型无值 */
  anchor?: string;
}

interface SessionHistoryResult {
  available: boolean;
  reason?: string | null;
  sessionId: string;
  agentType: string;
  total: number;
  messages: HistoryMessage[];
}

interface Props {
  open: boolean;
  sessionId: string;
  sessionName: string;
  projectPath: string;
  onClose: () => void;
  onJumpToTerminal: (anchor: string) => void;
}

// ==================== 工具函数 ====================
function formatTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 高亮所有命中（不区分大小写），返回 React 片段
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  try {
    const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
    return parts.map((p, i) =>
      p.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="history-search-highlight">{p}</mark>
        : <React.Fragment key={i}>{p}</React.Fragment>
    );
  } catch {
    return text;
  }
}

// ==================== 角色徽章 ====================
// 颜色使用硬编码，不跟主题走：在 amber 主题下 primary 和 orange 都是金黄色
// 会导致 YOU 和 CLAUDE 徽章颜色一致无法区分。固定用蓝 + Claude 品牌橙。
const ROLE_META: Record<string, { label: string; color: string }> = {
  user: { label: "YOU", color: "#3b82f6" },
  assistant: { label: "CLAUDE", color: "#D97757" },
  tool_use: { label: "TOOL", color: "#8b5cf6" },
  tool_result: { label: "RESULT", color: "#10b981" },
  system: { label: "SYSTEM", color: "#94a3b8" },
};

// ==================== 消息卡片组件 ====================
const MessageCard: React.FC<{
  msg: HistoryMessage;
  query: string;
  onJump: (anchor: string) => void;
  isActiveHit?: boolean;
  registerRef?: (id: string, el: HTMLDivElement | null) => void;
}> = ({ msg, query, onJump, isActiveHit, registerRef }) => {
  const meta = ROLE_META[msg.role] || ROLE_META.system;
  const [expanded, setExpanded] = useState<boolean>(false);
  const isToolUse = msg.role === "tool_use";
  const isToolResult = msg.role === "tool_result";

  // 对长 content 折叠
  const longContent = (msg.content || "").length > 480;
  const displayContent = !expanded && longContent
    ? (msg.content || "").slice(0, 480) + "…"
    : msg.content || "";

  return (
    <div
      className={`history-msg ${msg.role} ${isActiveHit ? "active-hit" : ""}`}
      ref={(el) => registerRef && registerRef(msg.id, el)}
    >
      <div className="history-msg-header">
        <span
          className="history-msg-role"
          style={{ color: meta.color, borderColor: meta.color }}
        >
          {meta.label}
        </span>
        {msg.toolName && (
          <span className="history-msg-toolname" title={msg.toolName}>
            ⎇ {msg.toolName}
          </span>
        )}
        {msg.model && (
          <span className="history-msg-model" title={msg.model}>{msg.model}</span>
        )}
        {msg.timestamp && (
          <span className="history-msg-time">{formatTime(msg.timestamp)}</span>
        )}
        <button
          className="history-jump-btn"
          disabled={!msg.anchor}
          onClick={() => msg.anchor && onJump(msg.anchor)}
          title={msg.anchor ? "关闭面板并定位到该消息在终端中的位置" : "工具调用消息无法定位到终端"}
        >
          → 跳到终端
        </button>
      </div>

      {isToolUse && msg.toolInput ? (
        <div className="history-tool-call">
          <div className="history-tool-call-header">
            <span style={{ fontWeight: 600 }}>输入参数</span>
            <button
              className="history-tool-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : "展开"}
            </button>
          </div>
          {expanded && (
            <pre className="history-tool-input">
              {JSON.stringify(msg.toolInput, null, 2)}
            </pre>
          )}
        </div>
      ) : isToolResult ? (
        <div className="history-msg-body history-tool-result">
          {highlight(displayContent, query)}
          {longContent && (
            <button
              className="history-tool-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : "展开全部"}
            </button>
          )}
        </div>
      ) : (
        <div className="history-msg-body">
          {highlight(displayContent, query)}
          {longContent && (
            <button
              className="history-tool-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起" : "展开全部"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// ==================== 主组件 ====================
export const SessionHistoryPanel: React.FC<Props> = ({
  open,
  sessionId,
  sessionName,
  projectPath,
  onClose,
  onJumpToTerminal,
}) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<SessionHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery] = useState<string>("");
  /** 当前激活的命中索引（1-based 展示，0-based 内部存储） */
  const [currentHitIndex, setCurrentHitIndex] = useState<number>(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // 搜索防抖 200ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // 打开时拉取历史
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setSearchQuery("");
    setCurrentHitIndex(0);

    invoke<SessionHistoryResult>("get_session_history", {
      sessionId,
      limit: 10000,
      offset: 0,
    })
      .then((res) => {
        if (cancelled) return;
        setResult(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  // 打开时聚焦搜索框
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  // 过滤消息（搜索）
  const filteredMessages = useMemo<HistoryMessage[]>(() => {
    if (!result?.messages) return [];
    if (!debouncedQuery.trim()) return result.messages;
    const q = debouncedQuery.toLowerCase();
    return result.messages.filter((m) => {
      const hay = `${m.content || ""} ${m.toolName || ""} ${m.model || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [result, debouncedQuery]);

  // 命中数变化时重置索引，并保证不越界
  useEffect(() => {
    setCurrentHitIndex((idx) => {
      if (filteredMessages.length === 0) return 0;
      if (idx === 0 || idx > filteredMessages.length) return 1;
      return idx;
    });
  }, [filteredMessages.length]);

  const hitCount = filteredMessages.length;

  // 滚动到当前命中
  useEffect(() => {
    if (filteredMessages.length === 0) return;
    const target = filteredMessages[currentHitIndex - 1];
    if (!target) return;
    const el = messageRefs.current[target.id];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentHitIndex, filteredMessages]);

  const goPrevHit = useCallback(() => {
    if (filteredMessages.length === 0) return;
    setCurrentHitIndex((idx) => (idx <= 1 ? filteredMessages.length : idx - 1));
  }, [filteredMessages.length]);

  const goNextHit = useCallback(() => {
    if (filteredMessages.length === 0) return;
    setCurrentHitIndex((idx) => (idx >= filteredMessages.length ? 1 : idx + 1));
  }, [filteredMessages.length]);


  if (!open) return null;

  return (
    <>
      <div
        className="history-panel-overlay"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="history-panel"
        role="dialog"
        aria-label="会话历史"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏：仅显示会话标题 + 计数徽章 + 关闭按钮 */}
        <div className="history-panel-header">
          <div className="history-panel-title" title={sessionName}>
            {sessionName}
          </div>
          <div className="history-panel-header-right">
            {result && (
              <span className="history-panel-count-badge">
                {result.total} 条消息
              </span>
            )}
            <button
              className="history-panel-close"
              onClick={onClose}
              aria-label="关闭"
              title="关闭 (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        {/* 搜索行：左侧搜索框 + 右侧 1/N + 上下条切换 */}
        <div className="history-panel-subbar">
          <div className="history-panel-search">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", opacity: 0.55 }}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索此会话历史..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) goPrevHit(); else goNextHit();
                }
              }}
            />
            {searchQuery && (
              <button
                className="history-panel-search-clear"
                onClick={() => setSearchQuery("")}
                title="清空"
              >
                ×
              </button>
            )}
          </div>
          <div className="history-panel-hitnav">
            {debouncedQuery && (
              <span className="history-panel-hitcount">
                {hitCount > 0 ? `${currentHitIndex}/${hitCount}` : "0/0"}
              </span>
            )}
            <button
              className="history-panel-hitnav-btn"
              onClick={goPrevHit}
              disabled={hitCount <= 1}
              title="上一条命中 (Shift+Enter)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <button
              className="history-panel-hitnav-btn"
              onClick={goNextHit}
              disabled={hitCount <= 1}
              title="下一条命中 (Enter)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        {/* 消息列表区 */}
        <div className="history-panel-body" ref={bodyRef}>
          {loading && (
            <div className="history-panel-empty">
              <div className="history-panel-empty-icon">⏳</div>
              <div>正在读取会话历史文件...</div>
            </div>
          )}

          {error && !loading && (
            <div className="history-panel-empty">
              <div className="history-panel-empty-icon" style={{ color: "#ef4444" }}>⚠</div>
              <div>加载失败：{error}</div>
            </div>
          )}

          {!loading && !error && result && !result.available && (
            <div className="history-panel-empty">
              <div className="history-panel-empty-icon">📭</div>
              {result.reason === "not_found" && (
                <>
                  <div>未找到该会话的 JSONL 历史文件</div>
                  <div style={{ fontSize: "12px", opacity: 0.7, marginTop: 8 }}>
                    可能该会话尚未产生对话内容，或 agent 还未持久化
                  </div>
                </>
              )}
              {result.reason === "empty" && (
                <>
                  <div>该会话的 JSONL 文件为空</div>
                </>
              )}
              {result.reason === "agent_not_supported" && (
                <>
                  <div>该 Agent 类型 ({result.agentType}) 的历史查看功能即将支持</div>
                  <div style={{ fontSize: "12px", opacity: 0.7, marginTop: 8 }}>
                    当前仅支持 Claude Code agent
                  </div>
                </>
              )}
              {result.reason === "no_agent_id" && (
                <div>该会话尚未生成 agent 会话 ID</div>
              )}
            </div>
          )}

          {!loading && !error && result && result.available && filteredMessages.length === 0 && (
            <div className="history-panel-empty">
              <div className="history-panel-empty-icon">🔍</div>
              {debouncedQuery ? (
                <div>没有匹配 "{debouncedQuery}" 的消息</div>
              ) : (
                <div>该会话暂无历史消息</div>
              )}
            </div>
          )}

          {!loading && !error && result && result.available && filteredMessages.length > 0 && (
            <div className="history-panel-list">
              {filteredMessages.map((m, idx) => (
                <MessageCard
                  key={`${m.id || idx}`}
                  msg={m}
                  query={debouncedQuery}
                  onJump={onJumpToTerminal}
                  isActiveHit={debouncedQuery.trim().length > 0 && idx + 1 === currentHitIndex}
                  registerRef={(id, el) => { messageRefs.current[id] = el; }}
                />
              ))}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="history-panel-footer">
          <span style={{ opacity: 0.65 }}>
            提示：按 <kbd>Esc</kbd> 关闭
          </span>
          {projectPath && (
            <span
              className="history-panel-footer-path"
              title={projectPath}
            >
              📁 {projectPath}
            </span>
          )}
        </div>
      </div>
    </>
  );
};

export default SessionHistoryPanel;
