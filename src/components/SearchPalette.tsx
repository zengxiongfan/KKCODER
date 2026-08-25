import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  formatRelativeSessionActivityTime,
  sortSessionsByActivityDesc,
} from "../utils/sessionActivity";
import "./SearchPalette.css";

/**
 * 会话搜索面板（结构参考 CC-GUI `SearchPalette`）：
 * - 输入防抖 150ms、IME 组合输入即时提交、过滤零宽不可见字符
 * - 两类来源，按种类分组：
 *   1) 会话：按名称 / 项目 / 路径匹配会话元数据
 *   2) 消息：走后端 `search_session_contents` 检索会话内聊天记录，逐条展示匹配片段
 * - 范围切换：当前项目（正在聊天的标签对应项目）/ 全局
 * - ↑↓ 移动选择、Enter 打开会话、Esc 关闭
 */

const INVISIBLE_QUERY_CHARS_REGEX = /[\u200B-\u200D\uFEFF]/g;
const SEARCH_QUERY_DEBOUNCE_MS = 150;

export interface SearchPaletteSession {
  id: string;
  name: string;
  project: string;
  path: string;
  createdAt?: string;
  lastUserMessageAt?: string;
}

interface SearchPaletteProps {
  isOpen: boolean;
  sessions: SearchPaletteSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onClose: () => void;
}

type SearchScope = "current-project" | "global";

/** 扁平结果条目：会话元数据命中 或 聊天记录片段命中 */
type SearchEntry =
  | { kind: "session"; session: SearchPaletteSession }
  | { kind: "message"; session: SearchPaletteSession; snippet: string };

function sanitizeSearchQueryInput(value: string): string {
  return value.replace(INVISIBLE_QUERY_CHARS_REGEX, "");
}

const escapeRegExp = (str: string) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/** 关键字高亮：命中片段用主题主色加粗 */
export function highlightKeyword(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text;
  try {
    const parts = text.split(new RegExp(`(${escapeRegExp(keyword)})`, "gi"));
    return parts.map((part, index) =>
      part.toLowerCase() === keyword.toLowerCase() ? (
        <strong key={index} className="search-palette-mark">
          {part}
        </strong>
      ) : (
        part
      ),
    );
  } catch {
    return text;
  }
}

export const SearchPalette: React.FC<SearchPaletteProps> = ({
  isOpen,
  sessions,
  activeSessionId,
  onSelectSession,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  // 输入值本地即时更新，防抖后才推给真正驱动结果计算的 query（避免每次按键重算整棵列表）
  const [query, setQuery] = useState("");
  const [inputValue, setInputValue] = useState("");
  const lastPushedQueryRef = useRef("");
  const queryCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scope, setScope] = useState<SearchScope>("global");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 聊天记录内容搜索结果：sessionId → 匹配片段（最多 3 条/会话）
  const [contentResults, setContentResults] = useState<Record<string, string[]>>({});
  const [contentLoading, setContentLoading] = useState(false);
  const contentQueryRef = useRef("");

  // 外部重置（每次打开面板清空）
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setInputValue("");
      setScope("global");
      setSelectedIndex(0);
      setContentResults({});
      setContentLoading(false);
    }
  }, [isOpen]);

  const commitQuery = useCallback((value: string) => {
    setInputValue(value);
    if (queryCommitTimerRef.current) {
      clearTimeout(queryCommitTimerRef.current);
    }
    queryCommitTimerRef.current = setTimeout(() => {
      queryCommitTimerRef.current = null;
      lastPushedQueryRef.current = value;
      setQuery(value);
    }, SEARCH_QUERY_DEBOUNCE_MS);
  }, []);

  // IME 组合输入结束得到最终文本 → 立即提交（中文输入不等待防抖）
  const flushQuery = useCallback((value: string) => {
    if (queryCommitTimerRef.current) {
      clearTimeout(queryCommitTimerRef.current);
      queryCommitTimerRef.current = null;
    }
    setInputValue(value);
    lastPushedQueryRef.current = value;
    setQuery(value);
  }, []);

  // 关闭时取消挂起的提交，避免关闭后还触发一次结果计算
  useEffect(() => {
    if (isOpen) return;
    if (queryCommitTimerRef.current) {
      clearTimeout(queryCommitTimerRef.current);
      queryCommitTimerRef.current = null;
    }
  }, [isOpen]);

  // 当前项目 = 正在聊天的标签对应会话的项目名
  const activeProject = useMemo(() => {
    if (!activeSessionId) return null;
    return sessions.find((s) => s.id === activeSessionId)?.project ?? null;
  }, [activeSessionId, sessions]);

  const normalizedQuery = sanitizeSearchQueryInput(query).trim();
  const hasVisibleQuery = normalizedQuery.length > 0;

  // 范围过滤：当前项目只保留该项目下的会话（对两类来源统一生效）
  const scopedSessions = useMemo(() => {
    if (scope === "current-project" && activeProject) {
      return sessions.filter((s) => s.project === activeProject);
    }
    return sessions;
  }, [sessions, scope, activeProject]);

  // 会话元数据匹配（名称 / 项目 / 路径），对齐 CC-GUI threadProvider 的位置计分：
  // score = index === 0 ? 15 : 160 + index（前缀命中远优先，匹配越靠后分数越大）
  const visibleSessions = useMemo(() => {
    if (!hasVisibleQuery) return [];
    const lower = normalizedQuery.toLowerCase();
    const scored = scopedSessions
      .map((s) => {
        const scores = [s.name, s.project, s.path]
          .map((field) => {
            const index = field.toLowerCase().indexOf(lower);
            return index < 0 ? null : index === 0 ? 15 : 160 + index;
          })
          .filter((v): v is number => v !== null);
        return scores.length > 0 ? { session: s, score: Math.min(...scores) } : null;
      })
      .filter((v): v is { session: SearchPaletteSession; score: number } => v !== null);
    // 活动时间降序的名次作为并列时的次级排序键（对齐 CC-GUI：score → updatedAt 降序）
    const activityRank = new Map(
      sortSessionsByActivityDesc(scored.map((e) => e.session)).map((s, index) => [s.id, index]),
    );
    return scored
      .sort(
        (a, b) =>
          a.score - b.score || activityRank.get(a.session.id)! - activityRank.get(b.session.id)!,
      )
      .map((e) => e.session);
  }, [scopedSessions, normalizedQuery, hasVisibleQuery]);

  // 聊天记录内容搜索：query 已经过输入防抖，这里直接请求后端
  useEffect(() => {
    if (!isOpen) return;
    const q = normalizedQuery;
    if (!q) {
      setContentResults({});
      setContentLoading(false);
      return;
    }
    contentQueryRef.current = q;
    setContentLoading(true);
    let cancelled = false;
    invoke<Array<{ sessionId: string; snippets: string[] }>>("search_session_contents", {
      query: q,
    })
      .then((results) => {
        if (cancelled || contentQueryRef.current !== q) return;
        const map: Record<string, string[]> = {};
        results?.forEach((r) => {
          map[r.sessionId] = r.snippets;
        });
        setContentResults(map);
      })
      .catch((err) => {
        console.error("Content search failed:", err);
        if (!cancelled || contentQueryRef.current !== q) {
          setContentResults({});
        }
      })
      .finally(() => {
        if (!cancelled && contentQueryRef.current === q) {
          setContentLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedQuery, isOpen]);

  // 聊天记录匹配条目：每段片段一条结果，会话按最近活动降序
  const messageEntries = useMemo<SearchEntry[]>(() => {
    if (!hasVisibleQuery) return [];
    const hits = scopedSessions
      .filter((s) => contentResults[s.id] && contentResults[s.id].length > 0)
      .map((s) => ({ session: s, snippets: contentResults[s.id] }));
    const ordered = sortSessionsByActivityDesc(hits.map((h) => h.session));
    const byId = new Map(scopedSessions.map((s) => [s.id, s]));
    const entries: SearchEntry[] = [];
    for (const session of ordered) {
      const snippets = contentResults[session.id] ?? [];
      snippets.forEach((snippet) => {
        entries.push({ kind: "message", session: byId.get(session.id) ?? session, snippet });
      });
    }
    return entries;
  }, [scopedSessions, contentResults, hasVisibleQuery]);

  // 扁平结果列表 + 按种类分组（对齐 CC-GUI 的分组骨架）
  const visibleEntries = useMemo<SearchEntry[]>(
    () => [
      ...visibleSessions.map((s) => ({ kind: "session" as const, session: s })),
      ...messageEntries,
    ],
    [visibleSessions, messageEntries],
  );

  const resultGroups = useMemo(() => {
    const groups: Array<{ kind: "session" | "message"; entries: SearchEntry[] }> = [];
    const sessionEntries = visibleEntries.filter((e) => e.kind === "session");
    const msgEntries = visibleEntries.filter((e) => e.kind === "message");
    if (sessionEntries.length > 0) groups.push({ kind: "session", entries: sessionEntries });
    if (msgEntries.length > 0) groups.push({ kind: "message", entries: msgEntries });
    return groups;
  }, [visibleEntries]);

  const selectedEntry =
    selectedIndex >= 0 && selectedIndex < visibleEntries.length
      ? visibleEntries[selectedIndex]
      : null;

  const openSession = useCallback(
    (session: SearchPaletteSession) => {
      onSelectSession(session.id);
      onClose();
    },
    [onSelectSession, onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const isRecentlyComposing = Date.now() - lastCompositionEndAtRef.current < 120;
      if (isComposingRef.current || isRecentlyComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, Math.max(visibleEntries.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        if (!selectedEntry) return;
        event.preventDefault();
        openSession(selectedEntry.session);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, openSession, selectedEntry, visibleEntries.length]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="search-palette-overlay" onClick={onClose} role="presentation">
      <div
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索会话"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 输入行 */}
        <div className="search-palette-input-row">
          <svg
            className="search-palette-search-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={inputRef}
            className="search-palette-input"
            placeholder="搜索会话与聊天记录（名称 / 项目 / 路径 / 消息内容）"
            aria-label="搜索会话"
            value={inputValue}
            onChange={(event) => commitQuery(sanitizeSearchQueryInput(event.target.value))}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              flushQuery(sanitizeSearchQueryInput(event.currentTarget.value));
            }}
          />
        </div>

        {/* 范围切换：当前项目 / 全局 */}
        <div className="search-palette-scope">
          <span className="search-palette-scope-label">范围</span>
          <div className="search-palette-scope-toggle" role="group" aria-label="搜索范围">
            <button
              type="button"
              className={`search-palette-scope-btn${scope === "current-project" ? " is-active" : ""}`}
              disabled={!activeProject}
              title={activeProject ? `仅搜索「${activeProject}」项目下的会话与聊天记录` : "请先激活一个会话"}
              onClick={() => {
                setScope("current-project");
                setSelectedIndex(0);
              }}
            >
              当前项目
            </button>
            <button
              type="button"
              className={`search-palette-scope-btn${scope === "global" ? " is-active" : ""}`}
              onClick={() => {
                setScope("global");
                setSelectedIndex(0);
              }}
            >
              全局
            </button>
          </div>
          <span className="search-palette-scope-value">
            {scope === "current-project" && activeProject
              ? `当前项目（${activeProject}）`
              : scope === "current-project"
                ? "当前项目（未激活会话）"
                : "全部会话"}
          </span>
        </div>

        {/* 结果区 */}
        <div className="search-palette-results">
          {hasVisibleQuery && contentLoading && resultGroups.length === 0 ? (
            <div className="search-palette-file-index-status" role="status">
              正在搜索聊天记录…
            </div>
          ) : null}
          {resultGroups.length === 0 ? (
            <div className="search-palette-empty">
              <div className="search-palette-empty-title">
                {hasVisibleQuery ? "无匹配结果" : "输入关键词开始搜索"}
              </div>
              <div className="search-palette-empty-hint">
                {hasVisibleQuery
                  ? "试试其他关键词，支持匹配会话名称、项目名、路径与聊天记录内容"
                  : "支持按会话名称、项目名、路径与聊天记录内容搜索，↑↓ 选择，Enter 打开"}
              </div>
            </div>
          ) : (
            resultGroups.map((group) => (
              <section className="search-palette-result-group" key={group.kind}>
                <h2 className="search-palette-result-group-title">
                  {group.kind === "session" ? "会话" : "消息"}
                </h2>
                {group.entries.map((entry, groupIndex) => {
                  const flatIndex = visibleEntries.indexOf(entry);
                  const isActive = flatIndex === selectedIndex;
                  const { session } = entry;
                  if (entry.kind === "message") {
                    return (
                      <button
                        key={`m:${session.id}:${groupIndex}`}
                        type="button"
                        className={`search-palette-result${isActive ? " is-active" : ""}`}
                        onClick={() => openSession(session)}
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                      >
                        <span className="search-palette-result-main">
                          <span className="search-palette-result-title">
                            {highlightKeyword(session.name, normalizedQuery)}
                          </span>
                          <span className="search-palette-result-subtitle">
                            <span className="search-palette-result-snippet">
                              {highlightKeyword(entry.snippet, normalizedQuery)}
                            </span>
                          </span>
                          <span className="search-palette-result-tags">
                            <span className="search-palette-result-tag">
                              项目: {session.project}
                            </span>
                            <span className="search-palette-result-tag">
                              最近活动: {formatRelativeSessionActivityTime(session)}
                            </span>
                          </span>
                        </span>
                        <span className="search-palette-kind-badge">消息</span>
                      </button>
                    );
                  }
                  return (
                    <button
                      key={`s:${session.id}`}
                      type="button"
                      className={`search-palette-result${isActive ? " is-active" : ""}`}
                      onClick={() => openSession(session)}
                      onMouseEnter={() => setSelectedIndex(flatIndex)}
                    >
                      <span className="search-palette-result-main">
                        <span className="search-palette-result-title">
                          {highlightKeyword(session.name, normalizedQuery)}
                        </span>
                        <span className="search-palette-result-subtitle">
                          {highlightKeyword(session.project, normalizedQuery)}
                          <span className="search-palette-result-path">
                            {highlightKeyword(session.path, normalizedQuery)}
                          </span>
                        </span>
                        <span className="search-palette-result-tags">
                          <span className="search-palette-result-tag">
                            项目: {session.project}
                          </span>
                          <span className="search-palette-result-tag">
                            最近活动: {formatRelativeSessionActivityTime(session)}
                          </span>
                        </span>
                      </span>
                      <span className="search-palette-kind-badge">会话</span>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="search-palette-footer">
          <span className="search-palette-key-hint">
            <kbd>↑↓</kbd> 选择
          </span>
          <span className="search-palette-key-hint">
            <kbd>Enter</kbd> 打开
          </span>
          <span className="search-palette-key-hint">
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
};
