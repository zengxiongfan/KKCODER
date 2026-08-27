import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowUp,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Command,
  Copy,
  File,
  FileText,
  Folder,
  ListChecks,
  Loader2,
  MessageSquare,
  PencilLine,
  Search,
  Send,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { renderChatMarkdownToHtml } from "../utils/markdown";
import { formatFeedbackError, notifyError, notifyInfo, notifyWarning } from "../utils/appFeedback";
import { isEditableFocusTarget } from "../utils/terminalFocus";
import { generateUUID } from "../utils/uuid";
import { log } from "../utils/log";
import { ModelSelector } from "./ModelSelector";
import { GitBranchSelector } from "./GitBranchSelector";
import type { ClaudeModelInfo } from "../utils/claudeModel";
import {
  detectChatCompletionTrigger,
  replaceChatCompletionTrigger,
  type ChatCompletionTrigger,
} from "../utils/chatCompletion";

const CHAT_EVENT_CHANNEL = "claude-chat-event";

/* ===== 访问模式（对齐 CC-GUI：全自动 / 规划模式 / 默认 / 当前） ===== */

const ACCESS_MODE_STORAGE_PREFIX = "kkcoder_chat_access_mode_";

const ACCESS_MODES: Array<{ id: string; label: string; title: string }> = [
  {
    id: "full-access",
    label: "auto",
    title: "auto（全自动）：跳过所有权限检查，模型可直接执行",
  },
  {
    id: "read-only",
    label: "plan",
    title: "plan（规划模式）：只读规划，模型只调研并输出方案，不修改文件；满意后切回 auto 继续执行",
  },
];

interface ChatTabProps {
  sessionId: string;
  directory: string;
  agentSessionId: string;
  isActive?: boolean;
  selectedModel: string | null;
  modelInfo: ClaudeModelInfo | null;
  onSelectModel: (model: string | null) => void;
  onSelectProvider: (providerId: string) => void;
  onRefreshModelInfo?: () => void;
  onSpawned?: () => void;
  onStateChange?: (busy: boolean) => void;
  onCommandComplete?: () => void;
  onUserSubmittedInput?: (sessionId: string, submittedAt?: string) => void;
  /** AI 思考中发送的消息自动加入队列（App 层队列引擎），空闲后自动投递回来 */
  onEnqueuePrompt?: (sessionId: string, prompt: string) => void;
  /** 当前会话的排队任务 */
  queueTasks?: Array<{ id: string; prompt: string }>;
  onRemoveQueueTask?: (sessionId: string, taskId: string) => void;
  onUpdateQueueTask?: (sessionId: string, taskId: string, newPrompt: string) => void;
  onPauseQueue?: (sessionId: string) => void;
  onResumeQueue?: (sessionId: string) => void;
  /** 打开项目规则编辑器（CLAUDE.md / AGENTS.md），由 App 层渲染弹窗 */
  onOpenRulesEditor?: () => void;
}

interface ToolCardData {
  id: string;
  name: string;
  input?: unknown;
  status: "running" | "done" | "error";
  output?: string;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 该条消息发送时实际使用的模型（selectedModel 或供应商默认），仅用户消息带 */
  model?: string;
  /** 思考过程分段（对齐 cc-gui：相邻思考合并一段，被工具调用打断则开新段）。
   *  afterToolCount = 该段开始前已有的工具数，用于与工具卡片交错渲染 */
  reasoning?: Array<{ text: string; afterToolCount: number }>;
  tools: ToolCardData[];
  status: "streaming" | "done" | "error";
  costUsd?: number;
  /** 本次回答耗时（秒），完成时记录 */
  elapsedSec?: number;
  error?: string;
  images?: ChatImageAttachment[];
  contextUsage?: ContextUsageData | null;
}

/** 后端 claude-chat-event 的扁平载荷（字段按需出现） */
interface ChatStreamEvent {
  sessionId: string;
  type: string;
  text?: string;
  toolId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;
  error?: string;
  message?: string;
  costUsd?: number;
  isError?: boolean;
  requestId?: string;
  questions?: ChatQuestion[];
}

interface CompletionEntry {
  kind: "file" | "directory" | "command" | "skill";
  name: string;
  description?: string;
  source: string;
  path?: string;
  isDir: boolean;
}

interface ChatQuestionOption {
  label: string;
  description?: string;
}

interface ChatQuestion {
  id: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: ChatQuestionOption[];
}

interface PendingQuestionRequest {
  requestId: string;
  questions: ChatQuestion[];
}

/** 后端 chat_get_context_usage 返回的归一化 token 用量 */
interface ContextUsageBreakdown {
  input: number;
  cached: number;
  output: number;
}

interface ContextUsageData {
  threadId?: string | null;
  model?: string | null;
  last?: ContextUsageBreakdown | null;
  session?: ContextUsageBreakdown | null;
  contextWindow?: number | null;
  /** Claude context_window 实时遥测：已用上下文、已用/剩余百分比 */
  contextUsed?: number | null;
  contextUsedPercent?: number | null;
  contextRemainingPercent?: number | null;
}

const CONTEXT_COLORS = {
  input: "#4f8cff",
  cached: "#22c55e",
  output: "#f59e0b",
};

const ContextUsageCard: React.FC<{ data: ContextUsageData | null }> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  const fmt = (value: number) =>
    Math.max(0, Math.round(value)).toLocaleString("en-US");
  const pct = (value: number, total: number) =>
    total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0%";

  const last = data?.last;
  const session = data?.session;
  const sessionTotal = session
    ? (session.input ?? 0) + (session.cached ?? 0) + (session.output ?? 0)
    : 0;
  const lastUsed = last ? (last.input ?? 0) + (last.cached ?? 0) : 0;
  const sessionUsed = session ? (session.input ?? 0) + (session.cached ?? 0) : 0;
  // 优先用 Claude 实时遥测的已用上下文，回退到 last/session 估算
  const used =
    data?.contextUsed != null && data.contextUsed > 0
      ? data.contextUsed
      : lastUsed > 0
        ? lastUsed
        : sessionUsed > 0
          ? sessionUsed
          : null;
  const windowSize = data?.contextWindow ?? null;
  const usedPercent =
    data?.contextUsedPercent != null
      ? data.contextUsedPercent
      : windowSize && windowSize > 0 && used != null
        ? Math.min(Math.max((used / windowSize) * 100, 0), 100)
        : null;
  const remaining =
    data?.contextRemainingPercent != null
      ? data.contextRemainingPercent
      : usedPercent != null
        ? Math.max(0, 100 - usedPercent)
        : null;

  const segments = session
    ? [
        { label: "输入", value: session.input ?? 0, color: CONTEXT_COLORS.input },
        { label: "缓存输入", value: session.cached ?? 0, color: CONTEXT_COLORS.cached },
        { label: "输出", value: session.output ?? 0, color: CONTEXT_COLORS.output },
      ]
    : [];

  const donutStyle: React.CSSProperties =
    sessionTotal > 0
      ? (() => {
          let acc = 0;
          const stops = segments.map((s) => {
            const start = (acc / sessionTotal) * 100;
            acc += s.value;
            const end = (acc / sessionTotal) * 100;
            return `${s.color} ${start}% ${end}%`;
          });
          return { background: `conic-gradient(${stops.join(", ")})` };
        })()
      : { background: "var(--bg-hover)" };

  const copyThread = () => {
    if (!data?.threadId) return;
    navigator.clipboard?.writeText(data.threadId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (!data || !session) {
    return (
      <div className="chat-context-card">
        <div className="chat-context-head">
          <div>
            <span className="chat-context-kicker">/context</span>
            <strong>上下文用量</strong>
          </div>
        </div>
        <div className="chat-context-empty">
          暂无该会话的用量数据，发送至少一轮后再试。
        </div>
      </div>
    );
  }

  const metric = (label: string, value: string) => (
    <div className="chat-context-metric">
      <span className="chat-context-metric-label">{label}</span>
      <span className="chat-context-metric-value">{value}</span>
    </div>
  );

  const rows = (title: string, items: Array<{ label: string; value: number }>) => (
    <div className="chat-context-section">
      <div className="chat-context-section-title">{title}</div>
      {items.map((item) => (
        <div className="chat-context-row" key={item.label}>
          <span>{item.label}</span>
          <span>{fmt(item.value)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="chat-context-card">
      <div className="chat-context-head">
        <div>
          <span className="chat-context-kicker">/context</span>
          <strong>上下文用量</strong>
        </div>
        {data.model && (
          <span className="chat-context-model" title={data.model}>
            {data.model}
          </span>
        )}
        {data.threadId && (
          <button
            type="button"
            className="chat-context-thread"
            onClick={copyThread}
            title="复制会话 ID"
          >
            {copied ? "已复制" : `${data.threadId.slice(0, 8)}…`}
          </button>
        )}
      </div>

      <div className="chat-context-main">
        <div className="chat-context-donut" style={donutStyle}>
          <div className="chat-context-donut-hole">
            <span className="chat-context-donut-value">{fmt(sessionTotal)}</span>
            <span className="chat-context-donut-label">总 token</span>
          </div>
        </div>
        <div className="chat-context-legend">
          {segments.map((s) => (
            <div className="chat-context-legend-item" key={s.label}>
              <span className="chat-context-dot" style={{ background: s.color }} />
              <span className="chat-context-legend-label">{s.label}</span>
              <span className="chat-context-legend-value">{fmt(s.value)}</span>
              <span className="chat-context-legend-pct">{pct(s.value, sessionTotal)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-context-metrics">
        {metric("已用上下文", used != null ? fmt(used) : "n/a")}
        {metric("上下文窗口", windowSize && windowSize > 0 ? fmt(windowSize) : "n/a")}
        {metric("已用占比", usedPercent != null ? `${usedPercent.toFixed(1)}%` : "n/a")}
        {metric("剩余", remaining != null ? `${remaining.toFixed(1)}%` : "n/a")}
      </div>

      <div className="chat-context-sections">
        {rows("最近一轮明细", [
          { label: "输入", value: last?.input ?? 0 },
          { label: "缓存输入", value: last?.cached ?? 0 },
          { label: "输出", value: last?.output ?? 0 },
        ])}
        {rows("会话累计", [
          { label: "输入", value: session.input ?? 0 },
          { label: "缓存输入", value: session.cached ?? 0 },
          { label: "输出", value: session.output ?? 0 },
          { label: "总 token", value: sessionTotal },
        ])}
      </div>
    </div>
  );
};

interface ChatImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
}

const MAX_CHAT_IMAGES = 5;
const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

type ChatAction =
  | { type: "history"; messages: ChatMessage[] }
  | { type: "user:sent"; text: string; id: string; images: ChatImageAttachment[]; model: string }
  | { type: "assistant:local"; text: string; contextUsage?: ContextUsageData | null }
  | { type: "send:failed"; id: string; message: string }
  | { type: "turn:started" }
  | { type: "text:delta"; text: string }
  /** 开新思考段：reasoning 流被工具调用打断后到达时触发 */
  | { type: "reasoning:segment" }
  | { type: "reasoning:delta"; text: string }
  | { type: "tool:started"; card: ToolCardData }
  | { type: "tool:input"; id: string; input?: unknown }
  | { type: "tool:completed"; id: string; name?: string; output?: string; error?: string }
  | { type: "turn:finished"; costUsd?: number; isError?: boolean; elapsedSec?: number }
  /** silent：用户主动取消，不把消息标红显示错误 */
  | { type: "turn:error"; message: string; silent?: boolean };

function patchLast(
  state: ChatMessage[],
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (state.length === 0) return state;
  const next = state.slice();
  const last = next[next.length - 1];
  if (last.role !== "assistant") return state;
  next[next.length - 1] = fn(last);
  return next;
}

function messagesReducer(state: ChatMessage[], action: ChatAction): ChatMessage[] {
  switch (action.type) {
    case "history":
      return action.messages;
    case "user:sent":
      return [
        ...state,
        {
          id: action.id,
          role: "user",
          text: action.text,
          model: action.model,
          tools: [],
          status: "done",
          images: action.images,
        },
      ];
    case "send:failed":
      return state.map((m) =>
        m.id === action.id ? { ...m, error: action.message } : m,
      );
    case "assistant:local":
      return [
        ...state,
        {
          id: generateUUID(),
          role: "assistant",
          text: action.text,
          contextUsage: action.contextUsage ?? null,
          reasoning: [],
          tools: [],
          status: "done",
        },
      ];
    case "turn:started":
      return [
        ...state,
        {
          id: generateUUID(),
          role: "assistant",
          text: "",
          reasoning: [],
          tools: [],
          status: "streaming",
        },
      ];
    case "text:delta":
      return patchLast(state, (m) => ({ ...m, text: m.text + action.text }));
    case "reasoning:segment":
      // 开新段：记录当前已有工具数，渲染时与工具卡片交错
      return patchLast(state, (m) => ({
        ...m,
        reasoning: [...(m.reasoning ?? []), { text: "", afterToolCount: m.tools.length }],
      }));
    case "reasoning:delta":
      return patchLast(state, (m) => {
        const segments = m.reasoning ?? [];
        if (segments.length === 0) {
          return { ...m, reasoning: [{ text: action.text, afterToolCount: 0 }] };
        }
        const last = segments[segments.length - 1];
        return {
          ...m,
          reasoning: [...segments.slice(0, -1), { ...last, text: last.text + action.text }],
        };
      });
    case "tool:started":
      return patchLast(state, (m) => ({
        ...m,
        tools: [...m.tools, action.card],
      }));
    case "tool:input":
      return patchLast(state, (m) => ({
        ...m,
        tools: m.tools.map((t) =>
          t.id === action.id ? { ...t, input: action.input } : t,
        ),
      }));
    case "tool:completed":
      return patchLast(state, (m) => ({
        ...m,
        tools: m.tools.map((t) =>
          t.id === action.id
            ? {
                ...t,
                status: action.error ? "error" : "done",
                output: action.output,
                error: action.error,
                name: action.name ?? t.name,
              }
            : t,
        ),
      }));
    case "turn:finished":
      return patchLast(state, (m) => ({
        ...m,
        status: action.isError ? "error" : "done",
        costUsd: action.costUsd,
        elapsedSec: action.elapsedSec,
      }));
    case "turn:error":
      return patchLast(state, (m) => ({
        ...m,
        // 用户主动取消（两次 ESC）：不标红、不显示错误文案，保留已输出的内容
        status: action.silent ? "done" : "error",
        error: action.silent ? undefined : action.message,
      }));
  }
}

const extractSkillName = (card: ToolCardData): string | null => {
  // 1. Check card.input as object
  if (card.input && typeof card.input === "object") {
    const inp = card.input as Record<string, any>;
    if (typeof inp.skill === "string" && inp.skill.trim()) return inp.skill.trim();
    if (typeof inp.skill_name === "string" && inp.skill_name.trim()) return inp.skill_name.trim();
    if (typeof inp.skillName === "string" && inp.skillName.trim()) return inp.skillName.trim();
    if (typeof inp.name === "string" && inp.name.trim() && card.name.toLowerCase().includes("skill")) return inp.name.trim();
  }

  // 2. Check card.input as string (e.g. JSON)
  if (typeof card.input === "string" && card.input.trim()) {
    try {
      const parsed = JSON.parse(card.input);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.skill === "string" && parsed.skill.trim()) return parsed.skill.trim();
        if (typeof parsed.skill_name === "string" && parsed.skill_name.trim()) return parsed.skill_name.trim();
        if (typeof parsed.skillName === "string" && parsed.skillName.trim()) return parsed.skillName.trim();
        if (typeof parsed.name === "string" && parsed.name.trim() && card.name.toLowerCase().includes("skill")) return parsed.name.trim();
      }
    } catch {
      const match = card.input.match(/"skill"\s*:\s*"([^"]+)"/i) ||
                    card.input.match(/"skill_name"\s*:\s*"([^"]+)"/i) ||
                    card.input.match(/"skillName"\s*:\s*"([^"]+)"/i);
      if (match && match[1]) return match[1].trim();
    }
  }

  // 3. Check card.output or error (e.g. "Launching skill: update-config")
  const text = (card.output ?? "") + (card.error ?? "");
  if (text) {
    const match = text.match(/Launching skill:\s*([a-zA-Z0-9_\-./]+)/i) ||
                  text.match(/Running skill:\s*([a-zA-Z0-9_\-./]+)/i) ||
                  text.match(/Using skill:\s*([a-zA-Z0-9_\-./]+)/i);
    if (match && match[1]) return match[1].trim();
  }

  // 4. Check card.name (e.g. "skill:update-config" or "skill/update-config")
  if (card.name.includes(":") || card.name.includes("/")) {
    const parts = card.name.split(/[:/]/);
    if (parts[0].toLowerCase().includes("skill") && parts[1]) {
      return parts.slice(1).join("/").trim();
    }
  }

  return null;
};

const extractToolParamSummary = (card: ToolCardData): string | null => {
  if (!card.input) return null;
  if (typeof card.input === "object") {
    const inp = card.input as Record<string, any>;
    if (typeof inp.command === "string" && inp.command.trim()) return truncate(inp.command.trim(), 50);
    if (typeof inp.cmd === "string" && inp.cmd.trim()) return truncate(inp.cmd.trim(), 50);
    if (typeof inp.file_path === "string" && inp.file_path.trim()) return truncate(inp.file_path.trim(), 50);
    if (typeof inp.path === "string" && inp.path.trim()) return truncate(inp.path.trim(), 50);
    if (typeof inp.query === "string" && inp.query.trim()) return truncate(inp.query.trim(), 50);
    if (typeof inp.pattern === "string" && inp.pattern.trim()) return truncate(inp.pattern.trim(), 50);
  }
  return null;
};

const getToolMeta = (name: string, isSkill = false) => {
  const n = name.toLowerCase();
  if (isSkill || n.includes("skill") || n.includes("custom_tool") || n.includes("invoke_skill") || n.includes("use_skill")) {
    return { type: "skill", label: "技能", icon: <Wrench size={13} /> };
  }
  if (n.includes("bash") || n.includes("terminal") || n.includes("powershell") || n.includes("exec") || n.includes("command")) {
    return { type: "terminal", label: "终端", icon: <TerminalIcon size={13} /> };
  }
  if (n.includes("read") || n.includes("view") || n.includes("cat")) {
    return { type: "read", label: "读取", icon: <FileText size={13} /> };
  }
  if (n.includes("write") || n.includes("edit") || n.includes("patch") || n.includes("replace") || n.includes("create")) {
    return { type: "write", label: "编辑", icon: <PencilLine size={13} /> };
  }
  if (n.includes("glob") || n.includes("grep") || n.includes("search") || n.includes("find") || n.includes("list")) {
    return { type: "search", label: "检索", icon: <Search size={13} /> };
  }
  return { type: "generic", label: "工具", icon: <Wrench size={13} /> };
};

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** 耗时格式化：42 秒 / 1 分 23 秒 / 5 分钟 */
const formatElapsed = (sec: number): string => {
  if (sec < 60) return `${sec} 秒`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
};

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

const extractTodosFromTool = (card: ToolCardData): TodoItem[] | null => {
  const name = card.name.toLowerCase();
  if (name !== "todowrite" && name !== "todo_write") return null;
  if (!card.input) return null;
  let raw: any = card.input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const list = raw?.todos;
  if (!Array.isArray(list)) return null;
  return list
    .filter(
      (t: any): t is { content: string; status: string } =>
        typeof t === "object" && t !== null && typeof t.content === "string",
    )
    .map((t: any) => ({
      content: t.content,
      status:
        t.status === "completed" || t.status === "done"
          ? "completed"
          : t.status === "in_progress" || t.status === "running"
            ? "in_progress"
            : "pending",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
    }));
};

/** 待办计划卡片（TodoWrite 对齐 CC-GUI：清晰展示任务规划、进行中项与完成进度） */
const TodoCard: React.FC<{ todos: TodoItem[] }> = ({ todos }) => {
  const [collapsed, setCollapsed] = useState(false);
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const inProgressItem = todos.find((t) => t.status === "in_progress");
  const totalCount = todos.length;
  const progressPercent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const isAllDone = totalCount > 0 && completedCount === totalCount;

  return (
    <div
      className={`chat-todo-card ${isAllDone ? "is-all-done" : inProgressItem ? "is-in-progress" : ""}`}
    >
      <button
        type="button"
        className="chat-todo-card-header"
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? "点击展开待办清单" : "点击收起待办清单"}
      >
        <div className="chat-todo-card-title">
          <ListChecks size={14} className="chat-todo-card-icon" />
          <span className="chat-todo-card-name">待办计划 · Todo List</span>
          {inProgressItem && (
            <span className="chat-todo-active-pill" title={inProgressItem.content}>
              正在执行: {inProgressItem.content}
            </span>
          )}
        </div>
        <div className="chat-todo-card-meta">
          <div
            className="chat-todo-progress-bar-wrap"
            title={`进度: ${completedCount}/${totalCount} (${progressPercent}%)`}
          >
            <div
              className="chat-todo-progress-bar-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="chat-todo-badge">
            {completedCount}/{totalCount}
          </span>
          <ChevronRight
            size={13}
            className={`chat-todo-chevron ${collapsed ? "" : "is-open"}`}
          />
        </div>
      </button>
      {!collapsed && (
        <div className="chat-todo-items">
          {todos.map((todo, idx) => {
            const isCompleted = todo.status === "completed";
            const isInProgress = todo.status === "in_progress";
            return (
              <div
                key={`${todo.content}-${idx}`}
                className={`chat-todo-item is-${todo.status}`}
              >
                <span className="chat-todo-item-icon">
                  {isCompleted ? (
                    <CheckCircle2 size={13} className="chat-todo-check" />
                  ) : isInProgress ? (
                    <Loader2 size={13} className="chat-spin-icon chat-todo-spinner" />
                  ) : (
                    <Circle size={13} className="chat-todo-circle" />
                  )}
                </span>
                <span className="chat-todo-item-text">{todo.content}</span>
                {isInProgress && (
                  <span className="chat-todo-item-tag">进行中</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const ToolCard: React.FC<{ card: ToolCardData }> = ({ card }) => {
  const todos = extractTodosFromTool(card);
  if (todos && todos.length > 0) {
    return <TodoCard todos={todos} />;
  }

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const skillName = extractSkillName(card);
  const paramSummary = !skillName ? extractToolParamSummary(card) : null;
  const inputText = card.input
    ? JSON.stringify(card.input, null, 1)
    : "";
  const output = card.output ?? card.error ?? "";
  const meta = getToolMeta(card.name, Boolean(skillName));
  const statusLabel =
    card.status === "running"
      ? "运行中"
      : card.status === "error"
        ? "失败"
        : "完成";
  const showDoneCheck = card.status === "done";
  const showErrorCross = card.status === "error";

  const copyOutput = () => {
    navigator.clipboard?.writeText(output).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`chat-tool-card status-${card.status} type-${meta.type}`}>
      <button
        type="button"
        className="chat-tool-head"
        onClick={() => setOpen(!open)}
      >
        <span className={`chat-tool-icon type-${meta.type}`}>{meta.icon}</span>
        <div className="chat-tool-title-group">
          <span className="chat-tool-name">{card.name}</span>
          {skillName && (
            <span className="chat-tool-skill-tag" title={`技能: ${skillName}`}>
              {skillName}
            </span>
          )}
          {paramSummary && (
            <span className="chat-tool-param-summary" title={paramSummary}>
              {paramSummary}
            </span>
          )}
        </div>
        <span className="chat-tool-status">
          {card.status === "running" && <span className="chat-tool-status-spinner" />}
          {showDoneCheck && (
            <CircleCheck size={12} className="chat-tool-status-check" />
          )}
          {showErrorCross && (
            <CircleX size={12} className="chat-tool-status-cross" />
          )}
          <span>{statusLabel}</span>
        </span>
        <ChevronRight className={`chat-tool-chevron ${open ? "is-open" : ""}`} size={13} />
      </button>
      {open && (
        <div className="chat-tool-body">
          {inputText && (
            <pre className="chat-tool-input">{truncate(inputText, 500)}</pre>
          )}
          {output && (
            <div className="chat-tool-output-wrap">
              <button
                type="button"
                className="chat-tool-copy"
                onClick={copyOutput}
                title="复制输出"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              <pre className="chat-tool-output">{truncate(output, 3000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** 命令记录自动折叠的 localStorage key（设置 → AI 助手 可开关） */
const COLLAPSE_TOOLS_KEY = "kkcoder_setting_collapse_tool_cards";

/** 普通工具折叠/平铺列表 */
const NormalToolList: React.FC<{ tools: ToolCardData[] }> = ({ tools }) => {
  const [collapsed, setCollapsed] = useState(true);

  if (tools.length <= 1) {
    return <>{tools.map((tool) => <ToolCard key={tool.id} card={tool} />)}</>;
  }
  if (localStorage.getItem(COLLAPSE_TOOLS_KEY) === "false") {
    return <>{tools.map((tool) => <ToolCard key={tool.id} card={tool} />)}</>;
  }

  const doneCount = tools.filter((tool) => tool.status === "done").length;
  const hasRunning = tools.some((tool) => tool.status === "running");
  return (
    <div className="chat-tool-list">
      <button
        type="button"
        className="chat-tool-list-summary"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? "点击展开全部工具调用" : "收起工具调用列表"}
      >
        <span className="chat-tool-icon type-terminal"><TerminalIcon size={13} /></span>
        <span className="chat-tool-list-label">
          {tools.length} 个工具操作 · 完成 {doneCount}
          {hasRunning && <span className="chat-tool-list-running"> · 运行中</span>}
        </span>
        <ChevronRight className={`chat-tool-chevron ${collapsed ? "" : "is-open"}`} size={13} />
      </button>
      {!collapsed && (
        <div className="chat-tool-list-items">
          {tools.map((tool) => <ToolCard key={tool.id} card={tool} />)}
        </div>
      )}
    </div>
  );
};

/**
 * 多条命令（工具调用）列表：
 * - TodoWrite 工具独立展示为清晰的待办计划进度卡片（对齐 CC-GUI）
 * - 普通工具根据设置折叠或平铺
 */
const ToolList: React.FC<{ tools: ToolCardData[] }> = ({ tools }) => {
  const todoTools: ToolCardData[] = [];
  const normalTools: ToolCardData[] = [];

  for (const tool of tools) {
    if (extractTodosFromTool(tool)) {
      todoTools.push(tool);
    } else {
      normalTools.push(tool);
    }
  }

  // 待办清单取最新的一条展示
  const latestTodoTool = todoTools[todoTools.length - 1];

  return (
    <>
      {latestTodoTool && <ToolCard key={latestTodoTool.id} card={latestTodoTool} />}
      {normalTools.length > 0 && <NormalToolList tools={normalTools} />}
    </>
  );
};

const CompletionMenu: React.FC<{
  items: CompletionEntry[];
  activeIndex: number;
  loading: boolean;
  onSelect: (item: CompletionEntry) => void;
  onHover: (index: number) => void;
}> = ({ items, activeIndex, loading, onSelect, onHover }) => (
  <div className="chat-completion-menu" role="listbox">
    <div className="chat-completion-header">
      <span>{loading ? "正在搜索…" : `${items.length} 个候选`}</span>
      <span>↑↓ 选择 · Enter/Tab 插入 · Esc 关闭</span>
    </div>
    <div className="chat-completion-list">
      {!loading && items.length === 0 && (
        <div className="chat-completion-empty">没有匹配项</div>
      )}
      {items.map((item, index) => (
        <button
          type="button"
          key={`${item.kind}:${item.path ?? item.name}`}
          className={`chat-completion-item ${index === activeIndex ? "is-active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(item)}
          role="option"
          aria-selected={index === activeIndex}
          ref={(element) => {
            if (index === activeIndex) element?.scrollIntoView({ block: "nearest" });
          }}
        >
          <span className="chat-completion-icon">
            {item.kind === "directory" ? (
              <Folder size={15} />
            ) : item.kind === "file" ? (
              <File size={15} />
            ) : item.kind === "skill" ? (
              <Sparkles size={15} />
            ) : (
              <Command size={15} />
            )}
          </span>
          <span className="chat-completion-copy">
            <span className="chat-completion-label">
              {item.kind === "file" || item.kind === "directory"
                ? item.path
                : `/${item.name}`}
            </span>
            {item.description && (
              <span className="chat-completion-description">{item.description}</span>
            )}
          </span>
          <span className="chat-completion-source">{item.source}</span>
        </button>
      ))}
    </div>
  </div>
);

const QuestionCard: React.FC<{
  request: PendingQuestionRequest;
  submitting: boolean;
  error: string | null;
  /** 已提交态：卡片转为答案摘要展示（内嵌对话流中等待 Claude 继续） */
  answered?: boolean;
  onSubmit: (answers: Record<string, { answers: string[] }>) => void;
  onSkip: () => void;
}> = ({ request, submitting, error, answered, onSubmit, onSkip }) => {
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const question = request.questions[activeQuestion];

  const toggleOption = (questionId: string, label: string, multiSelect: boolean) => {
    setSelections((previous) => {
      const current = new Set(previous[questionId] ?? []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...previous, [questionId]: current };
    });
  };

  /** 明确选中（不取消）：双击快速确认时使用 */
  const selectOption = (questionId: string, label: string, multiSelect: boolean) => {
    setSelections((previous) => {
      const current = new Set(previous[questionId] ?? []);
      if (multiSelect) {
        current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...previous, [questionId]: current };
    });
  };

  /** 组装答案；override 用于双击确认：把双击的选项直接写入对应问题的答案 */
  const submit = (override?: { questionId: string; label: string }) => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const item of request.questions) {
      let values = [...(selections[item.id] ?? [])];
      if (override && item.id === override.questionId) {
        values = item.multiSelect
          ? values.includes(override.label)
            ? values
            : [...values, override.label]
          : [override.label];
      }
      const custom = customAnswers[item.id]?.trim();
      if (custom) values.push(custom);
      answers[item.id] = { answers: values };
    }
    onSubmit(answers);
  };

  /** 双击选项：选中该选项；非最后一题则前进到下一题，最后一题直接提交 */
  const handleDoubleClickOption = (label: string) => {
    selectOption(question.id, label, !!question.multiSelect);
    if (activeQuestion < request.questions.length - 1) {
      setActiveQuestion((index) => index + 1);
    } else {
      submit({ questionId: question.id, label });
    }
  };

  if (!question) return null;
  const selected = selections[question.id] ?? new Set<string>();

  // 已提交态：卡片转为答案摘要，等待 Claude 继续（内嵌于对话流，不再弹窗）
  if (answered) {
    return (
      <div className="chat-question-inline is-answered">
        <div className="chat-question-header">
          <div>
            <span className="chat-question-kicker">Claude 需要你的选择</span>
            <strong>
              {request.questions.length > 1
                ? `已提交 ${request.questions.length} 个问题的选择`
                : request.questions[0].header || "选择"}
            </strong>
          </div>
          <span className="chat-question-progress">✓ 已提交</span>
        </div>
        <div className="chat-question-answered">
          <div className="chat-question-answered-head">
            <Check size={13} />
            已提交你的选择，Claude 正在继续…
          </div>
          {request.questions.map((item) => {
            const picks = [...(selections[item.id] ?? [])];
            const custom = customAnswers[item.id]?.trim();
            if (!picks.length && !custom) return null;
            return (
              <div key={item.id} className="chat-question-answered-block">
                <div className="chat-question-answered-q">{item.header || item.question}</div>
                <div className="chat-question-answered-summary">
                  {picks.map((label) => (
                    <span key={label} className="chat-question-answered-chip">
                      {label}
                    </span>
                  ))}
                  {custom && (
                    <span className="chat-question-answered-chip is-custom">{custom}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-question-inline" role="dialog" aria-label="Claude 需要你的选择">
      {/* 顶部栏：标题与多题切换标签 */}
      <div className="chat-question-header">
        <div>
          <span className="chat-question-kicker">Claude 需要你的选择</span>
          <strong>{question.header || "选择"}</strong>
        </div>
        {request.questions.length > 1 && (
          <span className="chat-question-progress">
            {activeQuestion + 1}/{request.questions.length}
          </span>
        )}
      </div>
      {request.questions.length > 1 && (
        <div className="chat-question-tabs" role="tablist">
          {request.questions.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={index === activeQuestion ? "is-active" : ""}
              onClick={() => setActiveQuestion(index)}
            >
              {item.header || `问题 ${index + 1}`}
            </button>
          ))}
        </div>
      )}

      {/* 问题内容与选项 */}
      <div className="chat-question-scroll">
        <div className="chat-question-text">{question.question}</div>
        <div className="chat-question-options">
          {question.options.map((option, index) => {
            const isSelected = selected.has(option.label);
            return (
              <button
                type="button"
                key={`${option.label}:${index}`}
                className={`chat-question-option ${isSelected ? "is-selected" : ""}`}
                onClick={() => toggleOption(question.id, option.label, !!question.multiSelect)}
                onDoubleClick={() => handleDoubleClickOption(option.label)}
                disabled={submitting}
                title="单击选择，双击直接确认"
              >
                <span className="chat-question-marker">
                  {question.multiSelect ? (isSelected ? "✓" : "") : index + 1}
                </span>
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            );
          })}
          <textarea
            className="chat-question-custom"
            value={customAnswers[question.id] ?? ""}
            onChange={(event) =>
              setCustomAnswers((previous) => ({
                ...previous,
                [question.id]: event.target.value,
              }))
            }
            placeholder="其他回答（可选）"
            rows={2}
            disabled={submitting}
          />
        </div>
      </div>
      {error && <div className="chat-question-error">{error}</div>}
      <div className="chat-question-actions">
        <button type="button" onClick={onSkip} disabled={submitting}>
          跳过
        </button>
        <div>
          {activeQuestion > 0 && (
            <button
              type="button"
              onClick={() => setActiveQuestion((index) => index - 1)}
              disabled={submitting}
            >
              上一步
            </button>
          )}
          {activeQuestion < request.questions.length - 1 ? (
            <button
              type="button"
              className="is-primary"
              onClick={() => setActiveQuestion((index) => index + 1)}
              disabled={submitting}
            >
              下一步
            </button>
          ) : (
            <button
              type="button"
              className="is-primary"
              onClick={() => submit()}
              disabled={submitting}
            >
              {submitting ? "正在提交…" : "提交选择"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/** 计划模式退出批准卡片：模型调用 ExitPlanMode，展示真实规划方案 Markdown 并等待用户批准/拒绝 */
const PlanApprovalCard: React.FC<{
  approval: {
    requestId: string;
    plan?: string;
    planFilePath?: string;
    planFileName?: string;
  };
  submitting?: boolean;
  onApprove: () => void;
  onReject: () => void;
}> = ({ approval, submitting, onApprove, onReject }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!approval.plan) return;
    navigator.clipboard
      .writeText(approval.plan)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div
      className="chat-question-inline chat-plan-approval"
      role="dialog"
      aria-label="计划模式确认"
    >
      <div className="chat-question-header">
        <div>
          <span className="chat-question-kicker">
            <BrainCircuit size={13} style={{ display: "inline-block", verticalAlign: "text-bottom", marginRight: 4 }} />
            计划模式 · 方案就绪
          </span>
          <strong>模型已规划完成，退出计划模式并开始执行？</strong>
        </div>
        <span className="chat-question-progress is-plan-badge">等待你确认</span>
      </div>
      <div className="chat-plan-approval-scroll">
        {approval.plan ? (
          <>
            <div className="chat-plan-approval-meta">
              <span
                className="chat-plan-approval-file"
                title={approval.planFilePath || approval.planFileName || "规划方案"}
              >
                <FileText size={12} />
                {approval.planFileName || "规划方案文件"}
              </span>
              <button
                type="button"
                className="chat-plan-approval-copy-btn"
                onClick={handleCopy}
                title="复制方案 Markdown"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                <span>{copied ? "已复制" : "复制方案"}</span>
              </button>
            </div>
            <div
              className="chat-plan-approval-markdown preview-markdown-content"
              dangerouslySetInnerHTML={{
                __html: renderChatMarkdownToHtml(approval.plan),
              }}
            />
          </>
        ) : (
          <div className="chat-plan-approval-hint">
            批准后模型将退出计划模式，按计划直接修改文件并执行；拒绝则留在计划模式继续调整方案。
          </div>
        )}
      </div>
      <div className="chat-question-actions">
        <button type="button" onClick={onReject} disabled={submitting}>
          拒绝 · 继续修改方案
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={onApprove}
          disabled={submitting}
        >
          {submitting ? "正在处理…" : "批准并执行"}
        </button>
      </div>
    </div>
  );
};

/** 粘贴标签预览/编辑弹窗：全宽等宽文本编辑，Enter 无关、Ctrl/Cmd+Enter 保存、Esc 取消 */
const PasteEditModal: React.FC<{
  initialText: string;
  onSave: (text: string) => void;
  onDelete: () => void;
  onCancel: () => void;
}> = ({ initialText, onSave, onDelete, onCancel }) => {
  const [text, setText] = useState(initialText);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    editorRef.current?.focus();
    editorRef.current?.select();
  }, []);

  return createPortal(
    <div className="chat-paste-overlay" onMouseDown={(event) => event.stopPropagation()}>
      <div className="chat-paste-card">
        <div className="chat-paste-head">
          <span className="chat-paste-title">粘贴文本预览 / 编辑</span>
          <button
            type="button"
            className="chat-paste-close"
            onClick={onCancel}
            title="关闭（Esc）"
          >
            <X size={13} />
          </button>
        </div>
        <textarea
          ref={editorRef}
          className="chat-paste-editor"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // 阻止冒泡：不触发全局「终止生成」交互
              event.stopPropagation();
              onCancel();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              onSave(text);
            }
          }}
        />
        <div className="chat-paste-actions">
          <button type="button" className="chat-paste-delete" onClick={onDelete}>
            删除该标签
          </button>
          <div className="chat-paste-actions-right">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="is-primary" onClick={() => onSave(text)}>
              保存（Ctrl+Enter）
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/**
 * 单条消息视图。React.memo：消息对象引用不变时跳过重渲染，
 * 避免输入框打字等无关重渲染导致 markdown 重新计算/HTML 代码块 DOM 被重注入
 * （「源码/预览」切换状态依赖 DOM 稳定性）。
 */
const MessageView: React.FC<{ message: ChatMessage }> = React.memo(({ message }) => {
  if (message.role === "user") {
    return (
      <div className="chat-msg chat-msg-user">
        <div className="chat-bubble chat-bubble-user">
          {!!message.images?.length && (
            <div className="chat-message-images">
              {message.images.map((image) => (
                <img key={image.id} src={image.dataUrl} alt={image.name} />
              ))}
            </div>
          )}
          <div className="chat-bubble-user-text">{message.text}</div>
        </div>
        {message.model && (
          <div className="chat-msg-meta">
            <span className="chat-msg-model-badge">{message.model}</span>
          </div>
        )}
        {message.error && (
          <div className="chat-msg-error">{message.error}</div>
        )}
      </div>
    );
  }
  // 思考显示设置：聚合（全部合并为一块，默认）/ 分开（被工具打断的多段思考各自成块并交错工具卡）
  const splitReasoning = localStorage.getItem("kkcoder_setting_split_reasoning") === "true";
  const reasoningSegments = (message.reasoning ?? []).filter((seg) => seg.text.trim().length > 0);
  const isLive = message.status === "streaming";
  const mergedReasoning = reasoningSegments.map((seg) => seg.text).join("\n\n");
  // 单个思考块：live 时标题「思考中」+ 脉冲点动效，完成时「思考过程」+ 箭头
  const reasoningBlock = (text: string, key: string | number) => (
    <details className={`chat-reasoning ${isLive ? "is-live" : ""}`} key={key}>
      <summary>
        <BrainCircuit size={13} className="chat-reasoning-icon" />
        <span className="chat-reasoning-title">{isLive ? "思考中" : "思考过程"}</span>
        {isLive ? (
          <span className="chat-reasoning-live-dot" />
        ) : (
          <ChevronRight size={12} className="chat-reasoning-chevron" />
        )}
      </summary>
      <div
        className="chat-reasoning-body markdown-body"
        dangerouslySetInnerHTML={{
          // 思考区：绝不渲染 HTML（代码块纯源码，无预览开关）
          __html: renderChatMarkdownToHtml(text),
        }}
      />
    </details>
  );
  // 分开显示：多段思考与工具卡片交错渲染（工具平铺为独立卡片，对齐 cc-gui 的独立块视觉）
  const blocks: React.ReactNode[] = [];
  if (splitReasoning && reasoningSegments.length > 1) {
    let toolCursor = 0;
    reasoningSegments.forEach((seg, index) => {
      // 本段开始前应已出现的工具（afterToolCount 为开段时已有的工具数）
      while (toolCursor < Math.min(seg.afterToolCount, message.tools.length)) {
        const tool = message.tools[toolCursor];
        blocks.push(<ToolCard key={tool.id} card={tool} />);
        toolCursor += 1;
      }
      blocks.push(reasoningBlock(seg.text, `reasoning-${index}`));
    });
    while (toolCursor < message.tools.length) {
      const tool = message.tools[toolCursor];
      blocks.push(<ToolCard key={tool.id} card={tool} />);
      toolCursor += 1;
    }
  }

  return (
    <div className="chat-msg chat-msg-assistant">
      {blocks.length > 0 ? (
        blocks
      ) : (
        <>
          {reasoningSegments.length > 0 && reasoningBlock(mergedReasoning, "reasoning-merged")}
          {message.tools.length > 0 && <ToolList tools={message.tools} />}
        </>
      )}
      {message.contextUsage ? (
        <ContextUsageCard data={message.contextUsage} />
      ) : message.text ? (
        <div
          className="chat-bubble chat-bubble-assistant markdown-body"
          dangerouslySetInnerHTML={{
            // 回答区：HTML 默认源码展示，点击「预览」开关才渲染
            __html: renderChatMarkdownToHtml(message.text, { htmlPreview: true }),
          }}
        />
      ) : null}
      {message.status === "done" && message.elapsedSec != null && (
        <div className="chat-cost">
          <span className="chat-cost-elapsed">耗时 {formatElapsed(message.elapsedSec)}</span>
        </div>
      )}
      {message.status === "error" && message.error && (
        <div className="chat-msg-error">{message.error}</div>
      )}
    </div>
  );
});

export const ChatTab: React.FC<ChatTabProps> = React.memo((props) => {
  const {
    sessionId,
    directory,
    agentSessionId,
    isActive,
    selectedModel,
    modelInfo,
    onSelectModel,
    onSelectProvider,
    onRefreshModelInfo,
    onSpawned,
    onStateChange,
    onCommandComplete,
    onUserSubmittedInput,
    onEnqueuePrompt,
    queueTasks,
    onRemoveQueueTask,
    onUpdateQueueTask,
    onPauseQueue,
    onResumeQueue,
    onOpenRulesEditor,
  } = props;

  const [messages, dispatch] = useReducer(messagesReducer, []);
  // 事件监听器闭包经 ref 读最新消息流（mount-once 模式）
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  // 最近一次发送的消息内容：取消回退时恢复回输入框
  const lastSentRef = useRef<{ text: string; images: ChatImageAttachment[] } | null>(null);
  const [draft, setDraft] = useState("");
  // 访问模式（auto: full-access / plan: read-only）：按会话持久化，发送时传给后端
  const [accessMode, setAccessModeState] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(ACCESS_MODE_STORAGE_PREFIX + sessionId);
      if (saved === "full-access" || saved === "read-only") {
        return saved;
      }
      return "full-access";
    } catch {
      return "full-access";
    }
  });
  const setAccessMode = (mode: string) => {
    setAccessModeState(mode);
    try {
      localStorage.setItem(ACCESS_MODE_STORAGE_PREFIX + sessionId, mode);
    } catch {
      // localStorage 不可用时仅会话内生效
    }
  };
  const [busy, setBusy] = useState(false);
  // busy 的 ref 镜像：队列投递事件监听器读取最新状态，防止重复投递
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [ready, setReady] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 运行中两次 ESC 终止交互：第一次按下后终止按钮显示 ESC 提示，第二次按下才终止
  const [escArmed, setEscArmed] = useState(false);
  const [completionTrigger, setCompletionTrigger] = useState<ChatCompletionTrigger | null>(null);
  const [completionItems, setCompletionItems] = useState<CompletionEntry[]>([]);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [slashCatalog, setSlashCatalog] = useState<CompletionEntry[]>([]);
  const [slashCatalogLoaded, setSlashCatalogLoaded] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestionRequest | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  /** 当前问题卡片是否已提交（内嵌卡片转为摘要态，等待 Claude 继续） */
  const [questionAnswered, setQuestionAnswered] = useState(false);
  /** 计划模式退出批准：模型调用了 ExitPlanMode，等待用户批准/拒绝 */
  const [pendingPlanApproval, setPendingPlanApproval] = useState<{
    requestId: string;
    plan?: string;
    planFilePath?: string;
    planFileName?: string;
  } | null>(null);
  const [planApprovalSubmitting, setPlanApprovalSubmitting] = useState(false);
  const [images, setImages] = useState<ChatImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  // 思考中已运行秒数：从发送消息起计时，与完成时耗时（turnStartTimeRef）同源
  const [streamingElapsed, setStreamingElapsed] = useState(0);
  // 队列项行内编辑状态
  const [editingQueueTaskId, setEditingQueueTaskId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  // 发送历史：↑/↓ 加载本会话之前发送过的消息（localStorage 持久，跨重启保留）
  const SEND_HISTORY_KEY_PREFIX = "kkcoder_chat_send_history_";
  const sendHistoryRef = useRef<string[]>([]);
  const historyCursorRef = useRef(-1);
  const historyDraftBackupRef = useRef("");
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEND_HISTORY_KEY_PREFIX + sessionId);
      sendHistoryRef.current = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      sendHistoryRef.current = [];
    }
    historyCursorRef.current = -1;
    historyDraftBackupRef.current = "";
  }, [sessionId]);
  const pushSendHistory = useCallback(
    (text: string) => {
      const list = sendHistoryRef.current;
      if (list[list.length - 1] === text) return;
      list.push(text);
      if (list.length > 10) list.splice(0, list.length - 10);
      try {
        localStorage.setItem(SEND_HISTORY_KEY_PREFIX + sessionId, JSON.stringify(list));
      } catch {
        // localStorage 满/不可用时静默放弃持久化，会话内仍可浏览
      }
      historyCursorRef.current = -1;
    },
    [sessionId],
  );
  // 粘贴折叠：>3 行的大段文本折叠为 [Pasted text #N +M lines] 标签（可读性），
  // 原文暂存于此，发送时还原为完整文本；sourcePath 为源码视图选取时的来源文件
  const pastedTextsRef = useRef<
    Array<{ id: number; text: string; lines: number; sourcePath?: string }>
  >([]);
  const nextPasteIdRef = useRef(1);
  // 文件引用标签：添加文件到上下文（"path" 引用）时登记，支持退格整体删除
  const fileRefsRef = useRef<Array<{ id: number; text: string }>>([]);
  const nextFileRefIdRef = useRef(1);
  // 粘贴标签预览/编辑弹窗：当前编辑的标签 id（null = 关闭）
  const [pasteEditId, setPasteEditId] = useState<number | null>(null);
  // 思考分段：工具事件（started/completed）到达后置 true，下一个 reasoning:delta 开新段
  const toolEventSeenRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const completionRequestRef = useRef(0);
  const composingRef = useRef(false);
  // ESC 提示态与超时定时器（状态 + ref 镜像，避免监听器闭包读到旧值）
  const escArmedRef = useRef(false);
  const escArmTimerRef = useRef<number | null>(null);
  // 用户是否钉在消息流底部：在底部附近才自动跟随新输出，浏览上方信息时不抢滚动
  const pinnedToBottomRef = useRef(true);
  // 本轮（turn）开始时间：完成时计算耗时
  const turnStartTimeRef = useRef(0);
  // 用户是否主动取消（两次 ESC）：收到 turn:error 时不显示"已取消"红字
  const userCancelledRef = useRef(false);

  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onCommandCompleteRef = useRef(onCommandComplete);
  onCommandCompleteRef.current = onCommandComplete;
  const onUserSubmittedInputRef = useRef(onUserSubmittedInput);
  onUserSubmittedInputRef.current = onUserSubmittedInput;
  useEffect(() => {
    if (isActive && ready && !busy) {
      inputRef.current?.focus();
    }
  }, [busy, isActive, ready]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    setBusy(false);
    setCancelling(false);
    setReady(false);
    setPendingQuestion(null);
    setQuestionAnswered(false);
    setQuestionError(null);
    setPendingPlanApproval(null);
    setCompletionTrigger(null);

    const handleEvent = (payload: ChatStreamEvent) => {
      switch (payload.type) {
        case "turn:started":
          // 新的一轮：重置工具打断标记，避免上一轮残留导致误开新思考段
          toolEventSeenRef.current = false;
          dispatch({ type: "turn:started" });
          break;
        case "text:delta":
          if (payload.text) {
            dispatch({ type: "text:delta", text: payload.text });
          }
          break;
        case "reasoning:delta":
          if (payload.text) {
            // 思考流被工具调用打断后到达 → 开新段（对齐 cc-gui：工具分隔的思考各自成块）
            if (toolEventSeenRef.current) {
              toolEventSeenRef.current = false;
              dispatch({ type: "reasoning:segment" });
            }
            dispatch({ type: "reasoning:delta", text: payload.text });
          }
          break;
        case "tool:started":
          toolEventSeenRef.current = true;
          dispatch({
            type: "tool:started",
            card: {
              id: payload.toolId ?? generateUUID(),
              name: payload.toolName ?? "tool",
              input: payload.input,
              status: "running",
            },
          });
          break;
        case "tool:input":
          if (payload.toolId) {
            dispatch({
              type: "tool:input",
              id: payload.toolId,
              input: payload.input,
            });
          }
          break;
        case "tool:completed":
          toolEventSeenRef.current = true;
          if (
            payload.toolName === "mcp__kkcoder__AskUserQuestion" ||
            payload.toolName === "AskUserQuestion"
          ) {
            if (!questionAnswered) {
              setPendingQuestion(null);
            }
          }
          if (payload.toolId) {
            dispatch({
              type: "tool:completed",
              id: payload.toolId,
              name: payload.toolName,
              output: payload.output,
              error: payload.error,
            });
          }
          break;
        case "turn:finished": {
          const elapsedSec =
            turnStartTimeRef.current > 0
              ? Math.round((Date.now() - turnStartTimeRef.current) / 1000)
              : undefined;
          dispatch({
            type: "turn:finished",
            costUsd: payload.costUsd,
            isError: payload.isError,
            elapsedSec,
          });
          setBusy(false);
          setCancelling(false);
          setPendingQuestion(null);
          setPendingPlanApproval(null);
          setPlanApprovalSubmitting(false);
          onStateChangeRef.current?.(false);
          onCommandCompleteRef.current?.();
          // 回答完成：按设置播放提示音（与终端模式一致，走后端 play_notification_sound）
          const chatPlaySound =
            localStorage.getItem("kkcoder_setting_play_sound") !== "false";
          if (chatPlaySound) {
            const chatTone = localStorage.getItem("kkcoder_setting_sound_tone") || "default";
            const chatVolumeStr = localStorage.getItem("kkcoder_setting_sound_volume");
            const chatVolume = chatVolumeStr ? parseInt(chatVolumeStr, 10) : 80;
            const chatNotify =
              localStorage.getItem("kkcoder_setting_notify_on_complete") !== "false";
            invoke("play_notification_sound", {
              tone: chatTone,
              volume: chatVolume,
              title: chatNotify ? "AgentDesk · 任务完成" : null,
              message: chatNotify ? "✨ Claude 已回复完毕，点击切回查看" : null,
            }).catch((err) => log(`[chat] play notification failed: ${err}`));
          }

          // 对话执行完成：自动触发右侧项目文件树刷新（保持已展开的目录结构）
          window.dispatchEvent(
            new CustomEvent("kkcoder-refresh-project-tree", {
              detail: { projectPath: directory },
            }),
          );
          break;
        }
        case "turn:error":
          // 用户主动取消（两次 ESC）：静默结束，不显示"已取消"红字
          const silentCancel = userCancelledRef.current;
          userCancelledRef.current = false;
          log(`[chat] turn:error silent=${silentCancel} message=${payload.message ?? ""}`);
          if (silentCancel) {
            // 主动取消：界面消息一律保留（不撤销任何输出），仅把提示词恢复回输入框
            restoreDraftAfterCancel();
          }
          dispatch({
            type: "turn:error",
            message: payload.message ?? "Claude 执行出错",
            silent: silentCancel,
          });
          setBusy(false);
          setCancelling(false);
          setPendingQuestion(null);
          setPendingPlanApproval(null);
          setPlanApprovalSubmitting(false);
          onStateChangeRef.current?.(false);

          // 异常或主动终止后同样刷新一次文件树
          window.dispatchEvent(
            new CustomEvent("kkcoder-refresh-project-tree", {
              detail: { projectPath: directory },
            }),
          );
          break;
        case "question:requested":
          if (payload.requestId && payload.questions?.length) {
            setPendingPlanApproval(null);
            setPendingQuestion({
              requestId: payload.requestId,
              questions: payload.questions,
            });
            setQuestionAnswered(false);
            setQuestionSubmitting(false);
            setQuestionError(null);
            setCompletionTrigger(null);
          }
          break;
        case "plan:approval":
          if (payload.requestId) {
            const input = payload.input as {
              plan?: unknown;
              planFilePath?: unknown;
              planFileName?: unknown;
            } | undefined;
            setPendingQuestion(null);
            setPendingPlanApproval({
              requestId: payload.requestId,
              plan: typeof input?.plan === "string" ? input.plan : undefined,
              planFilePath: typeof input?.planFilePath === "string" ? input.planFilePath : undefined,
              planFileName: typeof input?.planFileName === "string" ? input.planFileName : undefined,
            });
            setPlanApprovalSubmitting(false);
            setCompletionTrigger(null);
          }
          break;
        default:
          break;
      }
    };

    const initialize = async () => {
      try {
        unlisten = await listen<ChatStreamEvent>(CHAT_EVENT_CHANNEL, (event) => {
          if (event.payload.sessionId !== sessionId) return;
          handleEvent(event.payload);
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
          return;
        }

        try {
          const history = await invoke<Array<{ role: string; text: string }>>(
            "chat_get_history",
            { directory, agentSessionId },
          );
          if (disposed) return;
          const msgs: ChatMessage[] = history.map((item) => ({
            id: generateUUID(),
            role: item.role === "assistant" ? "assistant" : "user",
            text: item.text,
            tools: [],
            status: "done",
          }));
          dispatch({ type: "history", messages: msgs });
        } catch (error) {
          // 新会话没有转录文件属正常情况，不阻止输入。
          log(`[chat] history load failed: ${error}`);
        }

        if (!disposed) {
          setReady(true);
          onSpawnedRef.current?.();
        }
      } catch (error) {
        if (!disposed) {
          log(`[chat] event listener setup failed: ${error}`);
        }
      }
    };
    void initialize();

    // 与 CLI 终端一致：文件树/预览面板「添加到对话」经全局事件注入当前输入框。
    // kind=text：选中内容，等价复制粘贴（>3 行折叠为 [Pasted text #N +M lines] 标签；
    //   源码视图选取时 sourcePath 携带来源文件路径，发送时随包裹标记带出）；
    // kind=file：文件路径引用，登记为可整体删除的引用标签。
    const handleInsertConversationTag = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string; kind?: string; sourcePath?: string }>)
        .detail;
      if (!detail || detail.sessionId !== sessionId || !detail.text) return;
      if (detail.kind === "file") {
        const id = nextFileRefIdRef.current++;
        fileRefsRef.current.push({ id, text: detail.text });
        appendToDraft(detail.text);
      } else if (countLines(detail.text) > 3) {
        foldPastedText(detail.text, "end", detail.sourcePath);
      } else {
        appendToDraft(detail.text);
      }
    };
    window.addEventListener("kkcoder-insert-conversation-tag", handleInsertConversationTag);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(
        "kkcoder-insert-conversation-tag",
        handleInsertConversationTag,
      );
      invoke("chat_cancel", { sessionId }).catch((error) => {
        log(`[chat] cleanup cancel failed: ${error}`);
      });
    };
  }, [sessionId, directory, agentSessionId]);

  useEffect(() => {
    if (!completionTrigger) {
      setCompletionItems([]);
      setCompletionLoading(false);
      return;
    }

    const requestId = ++completionRequestRef.current;
    const query = completionTrigger.query.toLowerCase();
    setCompletionLoading(true);
    setCompletionIndex(0);

    if (completionTrigger.kind === "slash") {
      const applyCatalog = (catalog: CompletionEntry[]) => {
        if (requestId !== completionRequestRef.current) return;
        const filtered = catalog
          .filter((item) => !query || item.name.toLowerCase().includes(query))
          .slice(0, 80);
        setCompletionItems(filtered);
        setCompletionLoading(false);
      };
      if (slashCatalogLoaded) {
        applyCatalog(slashCatalog);
        return;
      }
      invoke<CompletionEntry[]>("chat_get_slash_items", { directory })
        .then((catalog) => {
          setSlashCatalog(catalog);
          setSlashCatalogLoaded(true);
          applyCatalog(catalog);
        })
        .catch((error) => {
          log(`[chat] slash catalog failed: ${error}`);
          if (requestId === completionRequestRef.current) {
            setCompletionItems([]);
            setCompletionLoading(false);
          }
        });
      return;
    }

    const timer = window.setTimeout(() => {
      invoke<CompletionEntry[]>("chat_search_project_entries", {
        directory,
        query: completionTrigger.query,
      })
        .then((items) => {
          if (requestId !== completionRequestRef.current) return;
          setCompletionItems(items);
          setCompletionLoading(false);
        })
        .catch((error) => {
          log(`[chat] file completion failed: ${error}`);
          if (requestId === completionRequestRef.current) {
            setCompletionItems([]);
            setCompletionLoading(false);
          }
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [completionTrigger, directory, slashCatalog, slashCatalogLoaded]);

  // 新消息/流式输出：使用 requestAnimationFrame 批量跟进，消除流式刷字/思考展开时的微抖动
  const autoScrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottomRef.current) {
      if (autoScrollRafRef.current == null) {
        autoScrollRafRef.current = requestAnimationFrame(() => {
          autoScrollRafRef.current = null;
          if (el && pinnedToBottomRef.current) {
            el.scrollTop = el.scrollHeight;
          }
        });
      }
    }
    return () => {
      if (autoScrollRafRef.current != null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };
  }, [messages]);

  // 问题卡片 / 计划模式退出批准出现：自动将消息流滚动到底部，确保最新上下文可见
  useEffect(() => {
    if ((pendingQuestion && !questionAnswered) || pendingPlanApproval) {
      const el = scrollRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
      }
    }
  }, [pendingQuestion, questionAnswered, pendingPlanApproval]);

  // 计划模式退出批准：若 plan 内容为空，主动调用后端拉取最新规划方案
  useEffect(() => {
    if (pendingPlanApproval && !pendingPlanApproval.plan) {
      invoke<{ plan?: string; planFilePath?: string; planFileName?: string }>(
        "chat_get_latest_plan",
        {
          agentSessionId,
          directory,
        },
      )
        .then((res) => {
          if (res && res.plan) {
            setPendingPlanApproval((prev) => {
              if (!prev || prev.requestId !== pendingPlanApproval.requestId) return prev;
              return {
                ...prev,
                plan: res.plan,
                planFilePath: res.planFilePath || prev.planFilePath,
                planFileName: res.planFileName || prev.planFileName,
              };
            });
          }
        })
        .catch(() => {});
    }
  }, [pendingPlanApproval, agentSessionId, directory]);

  // 思考计时：从发送消息（turnStartTimeRef）起每 500ms 刷新「已运行 N 秒」，
  // 与完成时「耗时 X 秒」同一时间起点、同一取整（Math.round），保证两者一致
  useEffect(() => {
    if (!busy) {
      setStreamingElapsed(0);
      return;
    }
    const timer = window.setInterval(() => {
      if (turnStartTimeRef.current > 0) {
        setStreamingElapsed(
          Math.max(0, Math.round((Date.now() - turnStartTimeRef.current) / 1000)),
        );
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [busy]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 48;
  };

  /** 真正发送一条消息给模型（用户手动发送与队列投递共用）。返回是否发送成功 */
  const sendText = useCallback(
    async (
      text: string,
      sendImages: ChatImageAttachment[],
      options?: { silentFail?: boolean; fallbackText?: string },
    ): Promise<boolean> => {
      const msgId = generateUUID();
      // 记录该条消息实际使用的模型：手动选择优先，否则用供应商默认（旋钮映射）
      const msgModel = selectedModel || modelInfo?.defaultModel || "默认";
      // 发送消息：无论当前是否在浏览历史，强制钉回底部——定位到刚发出的这条消息
      pinnedToBottomRef.current = true;
      // 新一轮对话：清除可能残留的主动取消标记
      userCancelledRef.current = false;
      // 记录本次发送内容：取消/停止时恢复回输入框（界面消息一律保留）。
      // 手动发送传入 fallbackText（发送前的折叠形态 draft，含标签），
      // 恢复时原样还原，避免包裹标记或展开原文带回输入框；
      // 队列投递无 fallbackText，用 foldBackPastedTexts 反向折叠兜底。
      lastSentRef.current = {
        text: options?.fallbackText ?? foldBackPastedTexts(text),
        images: sendImages,
      };
      // 记录本轮开始时间：turn:finished 时计算本次耗时
      turnStartTimeRef.current = Date.now();
      dispatch({ type: "user:sent", text, id: msgId, images: sendImages, model: msgModel });
      setDraft("");
      setImages([]);
      setAttachmentError(null);
      setCompletionTrigger(null);
      setBusy(true);
      onStateChangeRef.current?.(true);
      try {
        await invoke("chat_send_message", {
          sessionId,
          directory,
          agentSessionId,
          text,
          images: sendImages.map((image) => image.dataUrl),
          accessMode,
        });
        onUserSubmittedInputRef.current?.(sessionId);
        return true;
      } catch (err) {
        // 队列投递失败（如后端 turn 收尾竞态）静默返回 false，由调用方重试；
        // 手动发送失败仍标红提示
        if (!options?.silentFail) {
          dispatch({
            type: "send:failed",
            id: msgId,
            message: formatFeedbackError(err, "发送失败"),
          });
        }
        log(`[chat] send failed: ${formatFeedbackError(err, "发送失败")}`);
        setBusy(false);
        onStateChangeRef.current?.(false);
        setImages(sendImages);
        return false;
      }
    },
    [accessMode, agentSessionId, directory, dispatch, modelInfo, selectedModel, sessionId],
  );

  const handleSend = async () => {
    // 还原粘贴折叠标签（[Pasted text #N +M lines] → 完整原文）后发送
    const text = restorePastedTexts(draft.trim());
    if ((!text && images.length === 0) || !ready || pendingQuestion) return;

    // 内置 slash 命令本地处理：/clear /reset 只清界面，/new 再清上下文。
    // 不发给模型，避免 claude -p 返回 "(no content)"。
    const command = text.toLowerCase();
    if (command === "/clear" || command === "/reset" || command === "/new") {
      dispatch({ type: "history", messages: [] });
      setDraft("");
      setCompletionTrigger(null);
      setAttachmentError(null);
      if (command === "/new") {
        try {
          await invoke("chat_reset_context", {
            sessionId,
            agentSessionId,
            directory,
          });
        } catch (error) {
          log(`[chat] reset context failed: ${error}`);
        }
      }
      return;
    }

    // /context：本地展示 Context Usage 报告，不发给模型
    if (command === "/context") {
      setDraft("");
      setCompletionTrigger(null);
      setAttachmentError(null);
      let usage: ContextUsageData | null = null;
      try {
        usage = await invoke<ContextUsageData | null>("chat_get_context_usage", {
          sessionId,
          directory,
          agentSessionId,
        });
      } catch (error) {
        log(`[chat] get context usage failed: ${error}`);
      }
      dispatch({ type: "assistant:local", text: "", contextUsage: usage });
      return;
    }

    // AI 思考中：发送的纯文本消息自动加入队列，空闲后自动投递
    if (busy) {
      if (images.length > 0) {
        notifyWarning("AI 正在思考，请等待完成后发送图片消息");
        return;
      }
      onEnqueuePrompt?.(sessionId, text);
      pushSendHistory(text);
      setDraft("");
      setCompletionTrigger(null);
      log(`[chat] busy: queued prompt "${text}" for session ${sessionId}`);
      notifyInfo("AI 思考中，已加入队列，完成后自动发送");
      return;
    }

    // fallbackText = 发送前的折叠形态（含 [Pasted text #N] 标签），取消回退时原样恢复
    const sent = await sendText(text, images, { fallbackText: draft });
    if (sent) {
      // 发送成功才记入历史：↑/↓ 可把之前发过的消息重新加载到输入框
      pushSendHistory(text);
    }
  };

  // 队列引擎投递任务（GUI 聊天）：收到事件后自动发送，不重复进队列。
  // 发送失败（如后端 turn 收尾竞态："正在生成中"）时静默延迟重试，最多 3 次
  useEffect(() => {
    const handleQueuedSend = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; prompt: string }>).detail;
      if (!detail || detail.sessionId !== sessionId || !detail.prompt?.trim()) return;
      if (busyRef.current) {
        log(`[chat] queued dispatch skipped (still busy): ${detail.prompt}`);
        return;
      }
      const prompt = detail.prompt.trim();
      const trySend = async (attempt: number) => {
        log(`[chat] queued dispatch (attempt ${attempt + 1}): "${prompt}"`);
        const ok = await sendText(prompt, [], { silentFail: true });
        if (!ok && attempt < 2) {
          log(`[chat] queued dispatch failed, retrying in 800ms...`);
          window.setTimeout(() => void trySend(attempt + 1), 800);
        }
      };
      void trySend(0);
    };
    window.addEventListener("kkcoder-chat-send-queued", handleQueuedSend);
    return () => window.removeEventListener("kkcoder-chat-send-queued", handleQueuedSend);
  }, [sendText, sessionId]);

  const updateCompletion = (value: string, caret: number) => {
    // 输入法组合输入期间不触发补全：箭头/回车归输入法候选窗使用，
    // 避免候选窗与补全菜单互相抢焦点。
    if (composingRef.current) {
      setCompletionTrigger(null);
      return;
    }
    if (busy || pendingQuestion) {
      setCompletionTrigger(null);
      return;
    }
    setCompletionTrigger(detectChatCompletionTrigger(value, caret));
  };

  const selectCompletion = (item: CompletionEntry) => {
    if (!completionTrigger) return;
    const replacement =
      item.kind === "file" || item.kind === "directory"
        ? `@${item.path}${item.kind === "directory" ? "/" : ""} `
        : `/${item.name} `;
    const next = replaceChatCompletionTrigger(draft, completionTrigger, replacement);
    setDraft(next.text);
    setCompletionTrigger(null);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const answerQuestion = async (answers: Record<string, { answers: string[] }>) => {
    if (!pendingQuestion || questionSubmitting) return;
    setQuestionSubmitting(true);
    setQuestionError(null);
    try {
      await invoke("chat_answer_question", {
        sessionId,
        requestId: pendingQuestion.requestId,
        answers: { answers },
      });
      // 内嵌卡片保留在对话流中并转为「已提交」摘要态，等 Claude 继续；
      // 本轮结束（turn:finished/error）时随 pendingQuestion 一起清除。
      setQuestionAnswered(true);
    } catch (error) {
      setQuestionError(formatFeedbackError(error, "提交回答失败"));
    } finally {
      setQuestionSubmitting(false);
    }
  };

  /** 计划模式退出批准：批准 → 注入 tool_result 让 Claude 退出计划模式继续执行；拒绝 → 继续修改方案 */
  const answerPlanApproval = async (approve: boolean) => {
    if (!pendingPlanApproval || planApprovalSubmitting) return;
    setPlanApprovalSubmitting(true);
    try {
      await invoke("chat_answer_plan_approval", {
        sessionId,
        requestId: pendingPlanApproval.requestId,
        approve,
      });
      setPendingPlanApproval(null);
    } catch (error) {
      notifyError(formatFeedbackError(error, "批准失败"));
    } finally {
      setPlanApprovalSubmitting(false);
    }
  };

  const handleStartEditQueueTask = (task: { id: string; prompt: string }) => {
    setEditingQueueTaskId(task.id);
    setEditingQueueText(task.prompt);
  };

  const handleSaveEditQueueTask = (taskId: string) => {
    const trimmed = editingQueueText.trim();
    if (trimmed) {
      onUpdateQueueTask?.(sessionId, taskId, trimmed);
    }
    setEditingQueueTaskId(null);
  };

  const handleCancelEditQueueTask = () => {
    setEditingQueueTaskId(null);
  };

  const handleInterruptAndSendQueueTask = async (task: { id: string; prompt: string }) => {
    if (editingQueueTaskId === task.id) {
      setEditingQueueTaskId(null);
    }
    // 1. 立即锁定该会话的队列调度引擎，防止在终止当前 turn 时错误触发第 1 条排队任务
    onPauseQueue?.(sessionId);

    // 2. 仅将当前被点击选中的 task (例如第 2 条) 从队列中移除，其余任务（如第 1 条、第 3 条）严格保留
    onRemoveQueueTask?.(sessionId, task.id);

    try {
      // 3. 如果当前有正在运行的 AI 生成，立即终止当前的 turn
      if (busyRef.current) {
        log(`[chat] interrupt & send: cancelling active turn for session ${sessionId}`);
        userCancelledRef.current = true;
        disarmEsc();
        try {
          await invoke("chat_cancel", { sessionId });
        } catch (err) {
          log(`[chat] cancel before interrupt failed: ${err}`);
        }
        // 等待 160ms 确保后端取消并重置 turn 状态
        await new Promise((resolve) => setTimeout(resolve, 160));
      }

      // 4. 立即把该排队消息作为新指令发送给 AI
      log(`[chat] interrupt & send: dispatching "${task.prompt}"`);
      await sendText(task.prompt, [], {});
    } finally {
      // 5. 新任务已发出（busy 已被置为 true），解除队列暂停锁定；
      // 本轮生成自然结束后，队列调度引擎会自动按顺序继续执行队列中剩下的第 1 条、第 3 条任务
      onResumeQueue?.(sessionId);
    }
  };

  const addImageFiles = async (files: File[]) => {
    setAttachmentError(null);
    const available = Math.max(0, MAX_CHAT_IMAGES - images.length);
    if (available === 0) {
      setAttachmentError(`最多添加 ${MAX_CHAT_IMAGES} 张图片`);
      return;
    }
    const accepted = files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type)).slice(0, available);
    if (accepted.length === 0) {
      // 拖入/粘贴非图片文件：静默忽略，不提示
      return;
    }
    const next: ChatImageAttachment[] = [];
    for (const file of accepted) {
      if (file.size > MAX_CHAT_IMAGE_BYTES) {
        setAttachmentError(`${file.name} 超过 10 MB`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
        reader.readAsDataURL(file);
      }).catch((error) => {
        setAttachmentError(formatFeedbackError(error, "图片读取失败"));
        return "";
      });
      if (dataUrl) {
        next.push({
          id: generateUUID(),
          name: file.name || "pasted-image",
          mediaType: file.type,
          dataUrl,
        });
      }
    }
    if (next.length) setImages((previous) => [...previous, ...next]);
  };

  /** 粘贴文本行数（忽略末尾空行） */
  const countLines = (text: string) => text.replace(/\n$/, "").split("\n").length;

  /** 大段粘贴折叠：把 >3 行的文本替换为占位标签，原文存 ref，发送时还原。
   *  mode: "cursor" 光标处插入（粘贴）；"end" 追加到末尾（添加到对话事件）。
   *  sourcePath：源码视图选取时携带的来源文件路径（发送时随包裹标记带出）。
   *  当前文本优先读 DOM value（受控 textarea 最新值），避免 mount-once 监听器闭包读到旧 draft */
  const foldPastedText = (text: string, mode: "cursor" | "end" = "cursor", sourcePath?: string) => {
    const el = inputRef.current;
    const current = el?.value ?? draft;
    const id = nextPasteIdRef.current++;
    const lines = countLines(text);
    pastedTextsRef.current.push({ id, text, lines, sourcePath });
    const label = `[Pasted text #${id} +${lines} lines]`;
    const start = mode === "end" ? current.length : (el?.selectionStart ?? current.length);
    const end = mode === "end" ? current.length : (el?.selectionEnd ?? current.length);
    const next = current.slice(0, start) + label + current.slice(end);
    setDraft(next);
    setCompletionTrigger(null);
    // 光标移到标签之后，恢复输入框高度自适应
    window.setTimeout(() => {
      if (!el) return;
      el.focus();
      const pos = start + label.length;
      el.setSelectionRange(pos, pos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }, 0);
  };

  /** 追加文本到输入框末尾（智能空格分隔），聚焦并恢复高度自适应 */
  const appendToDraft = (text: string) => {
    const el = inputRef.current;
    const current = el?.value ?? draft;
    const separator = current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : "";
    const next = `${current}${separator}${text}`;
    setDraft(next);
    window.setTimeout(() => {
      if (!el) return;
      el.focus();
      const pos = next.length;
      el.setSelectionRange(pos, pos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }, 0);
  };

  /** 生成粘贴块的发送形态（restore 与 foldBack 共用同一格式，保证匹配一致）：
   *  [Pasted text #N +M lines]（来自 xxx）
   *  <<<PASTE_BLOCK:N source="xxx">>>
   *  ……完整原文……
   *  <<<END_PASTE_BLOCK:N>>>
   */
  const buildPasteWrapped = (item: {
    id: number;
    text: string;
    lines: number;
    sourcePath?: string;
  }) => {
    const label = `[Pasted text #${item.id} +${item.lines} lines]`;
    const sourceSuffix = item.sourcePath ? `（来自 ${item.sourcePath}）` : "";
    const sourceAttr = item.sourcePath ? ` source="${item.sourcePath}"` : "";
    return `${label}${sourceSuffix}\n<<<PASTE_BLOCK:${item.id}${sourceAttr}>>>\n${item.text}\n<<<END_PASTE_BLOCK:${item.id}>>>`;
  };

  /** 发送前还原所有折叠标签为原文，并用特殊语义包裹标记包住粘贴块，便于 AI 识别整体性 */
  const restorePastedTexts = (text: string) => {
    let result = text;
    for (const item of pastedTextsRef.current) {
      const label = `[Pasted text #${item.id} +${item.lines} lines]`;
      result = result.split(label).join(buildPasteWrapped(item));
    }
    return result;
  };

  /** 反向折叠：把发送文本中的整个粘贴块（标签头 + 包裹 + 原文）还原为单个标签。
   *  仅用于队列投递文本的回退兜底；手动发送的回退直接用发送前的折叠 draft（fallbackText） */
  const foldBackPastedTexts = (text: string) => {
    let result = text;
    for (const item of pastedTextsRef.current) {
      const label = `[Pasted text #${item.id} +${item.lines} lines]`;
      result = result.split(buildPasteWrapped(item)).join(label);
    }
    return result;
  };

  /** 找出 draft 中所有真实粘贴标签的区间（仅识别 ref 中登记过的，手打相似文本不误判） */
  const findPasteLabelSpans = (
    text: string,
  ): Array<{ start: number; end: number; id: number; lines: number }> => {
    const spans: Array<{ start: number; end: number; id: number; lines: number }> = [];
    const re = /\[Pasted text #(\d+) \+(\d+) lines\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const id = Number(match[1]);
      const lines = Number(match[2]);
      if (pastedTextsRef.current.some((item) => item.id === id && item.lines === lines)) {
        spans.push({ start: match.index, end: match.index + match[0].length, id, lines });
      }
    }
    return spans;
  };

  /** 找出 draft 中所有登记的"文件引用"区间（仅匹配 ref 中登记过的文本，不误伤手打内容） */
  const findFileRefSpans = (text: string): Array<{ start: number; end: number; id: number }> => {
    const spans: Array<{ start: number; end: number; id: number }> = [];
    for (const item of fileRefsRef.current) {
      let index = text.indexOf(item.text);
      while (index >= 0) {
        spans.push({ start: index, end: index + item.text.length, id: item.id });
        index = text.indexOf(item.text, index + item.text.length);
      }
    }
    return spans;
  };

  /** 保存标签编辑：更新原文与行数，行数变化时同步更新输入框中的标签文本 */
  const savePasteEdit = (id: number, newText: string) => {
    const item = pastedTextsRef.current.find((p) => p.id === id);
    if (!item) return;
    const oldLabel = `[Pasted text #${item.id} +${item.lines} lines]`;
    item.text = newText;
    item.lines = countLines(newText);
    const newLabel = `[Pasted text #${item.id} +${item.lines} lines]`;
    setPasteEditId(null);
    const next = draft.replace(oldLabel, newLabel);
    setDraft(next);
    // 光标移到新标签之后
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = next.indexOf(newLabel) + newLabel.length;
      el.setSelectionRange(pos, pos);
    });
  };

  /** 删除标签：原文从 ref 移除，输入框中的标签一并删除 */
  const removePasteItem = (id: number) => {
    const index = pastedTextsRef.current.findIndex((p) => p.id === id);
    if (index >= 0) {
      const item = pastedTextsRef.current[index];
      const label = `[Pasted text #${item.id} +${item.lines} lines]`;
      pastedTextsRef.current.splice(index, 1);
      setDraft(draft.replace(label, ""));
    }
    setPasteEditId(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** 粘贴标签键盘交互：←/→ 整体跳过标签，Backspace 光标贴标签后时整体删除。返回 true 表示已处理 */
  const handlePasteLabelKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = inputRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) return false;
    const pos = el.selectionStart ?? 0;
    const spans = findPasteLabelSpans(draft);
    if (e.key === "ArrowLeft") {
      // 光标在标签末尾向左 → 整体跳过到标签前
      const span = spans.find((s) => s.end === pos);
      if (span) {
        e.preventDefault();
        el.setSelectionRange(span.start, span.start);
        return true;
      }
    } else if (e.key === "ArrowRight") {
      // 光标在标签开头向右 → 整体跳过到标签后
      const span = spans.find((s) => s.start === pos);
      if (span) {
        e.preventDefault();
        el.setSelectionRange(span.end, span.end);
        return true;
      }
    } else if (e.key === "Backspace") {
      // 光标紧贴标签末尾按退格 → 整体删除整个标签
      const span = spans.find((s) => s.end === pos);
      if (span) {
        e.preventDefault();
        setDraft(draft.slice(0, span.start) + draft.slice(span.end));
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(span.start, span.start);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        });
        return true;
      }
      // 光标紧贴文件引用末尾按退格 → 整体删除该引用
      const fileSpans = findFileRefSpans(draft);
      const fileSpan = fileSpans.find((s) => s.end === pos);
      if (fileSpan) {
        e.preventDefault();
        setDraft(draft.slice(0, fileSpan.start) + draft.slice(fileSpan.end));
        // 同步移除登记，避免手动输入相同文本被误判
        const refIndex = fileRefsRef.current.findIndex((item) => item.id === fileSpan.id);
        if (refIndex >= 0) fileRefsRef.current.splice(refIndex, 1);
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(fileSpan.start, fileSpan.start);
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        });
        return true;
      }
    }
    return false;
  };

  const disarmEsc = useCallback(() => {
    escArmedRef.current = false;
    setEscArmed(false);
    if (escArmTimerRef.current !== null) {
      window.clearTimeout(escArmTimerRef.current);
      escArmTimerRef.current = null;
    }
  }, []);

  const armEsc = useCallback(() => {
    escArmedRef.current = true;
    setEscArmed(true);
    if (escArmTimerRef.current !== null) {
      window.clearTimeout(escArmTimerRef.current);
    }
    // 2.5s 内未按第二次 ESC 则收回提示，避免误以为还处于待确认状态
    escArmTimerRef.current = window.setTimeout(() => {
      escArmedRef.current = false;
      setEscArmed(false);
      escArmTimerRef.current = null;
    }, 2500);
  }, []);

  /** 取消/停止：界面消息一律保留（不撤销任何已输出的内容），
   *  仅把用户刚发送的提示词恢复回输入框（折叠标签形态），便于修改后重新发送 */
  const restoreDraftAfterCancel = useCallback(() => {
    const sent = lastSentRef.current;
    if (sent) {
      setDraft(sent.text);
      setImages(sent.images);
      inputRef.current?.focus();
    }
  }, []);

  const handleCancel = useCallback(() => {
    if (cancelling) return;
    log("[chat] user cancel requested (double ESC)");
    // 标记主动取消：随后的 turn:error（"已取消"）不再以红字展示
    userCancelledRef.current = true;
    disarmEsc();
    setCancelling(true);
    invoke("chat_cancel", { sessionId })
      .then(() => {
        // 兜底：若后端没有活跃 turn（不会发 turn:error），
        // 则自行把提示词恢复回输入框（界面消息保留）
        window.setTimeout(() => {
          if (!userCancelledRef.current) return; // 已收到 turn:error 并处理过
          restoreDraftAfterCancel();
        }, 600);
      })
      .catch((err) => {
        log(`[chat] cancel failed: ${err}`);
        setCancelling(false);
        userCancelledRef.current = false;
      });
  }, [cancelling, disarmEsc, restoreDraftAfterCancel, sessionId]);

  // 运行中两次 ESC 终止：第一次按下 → 终止按钮显示 ESC 提示；第二次按下 → 终止任务。
  // 仅在当前会话运行中且本 tab 激活时生效；问题弹窗打开期间不劫持 ESC。
  useEffect(() => {
    if (!busy || pendingQuestion || !isActive) {
      disarmEsc();
      return;
    }
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isEditableFocusTarget(event.target)) {
        // 仅当焦点在本会话聊天输入框、思考中（busy）且按的是 ESC 时才接管终止交互
        // （输入法组合中除外，ESC 留给候选窗；补全菜单的 ESC 已在输入框内
        // stopPropagation 处理，不会走到这里）；其他可编辑元素（搜索框等）不劫持
        if (event.target !== inputRef.current) return;
        if (!busy || event.key !== "Escape" || composingRef.current) return;
      }
      if (event.key !== "Escape") {
        // 按下其他键视为放弃 ESC 终止意图
        if (escArmedRef.current) disarmEsc();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (escArmedRef.current) {
        disarmEsc();
        handleCancel();
      } else {
        armEsc();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      disarmEsc();
    };
  }, [armEsc, busy, disarmEsc, handleCancel, isActive, pendingQuestion]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合输入期间把箭头/回车让给输入法候选窗；
    // 阻止冒泡：组合中的 ESC 用于取消候选窗，不应触发全局「终止生成」交互
    if (e.nativeEvent.isComposing) {
      e.stopPropagation();
      return;
    }
    // 粘贴标签：←/→ 整体跳过、Backspace 整体删除（光标贴标签后时）
    if (handlePasteLabelKey(e)) return;
    if (completionTrigger) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const len = completionItems.length;
        if (len > 0) {
          setCompletionIndex((current) => {
            const valid = current >= 0 && current < len ? current : 0;
            // 上箭头：向上一格，最顶格回绕到最后一条（选中最下面那条）
            return e.key === "ArrowUp"
              ? (valid - 1 + len) % len
              : (valid + 1) % len;
          });
        }
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && completionItems[completionIndex]) {
        e.preventDefault();
        selectCompletion(completionItems[completionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // 只关补全菜单，不触发全局 ESC 终止交互
        setCompletionTrigger(null);
        return;
      }
    }
    // 发送历史浏览：↑ 加载上一条（更早）已发送消息到输入框，↓ 下一条，到末尾恢复原草稿。
    // 仅加载到输入框供编辑，按回车才真正发送；补全菜单打开时 ↑/↓ 优先服务补全导航。
    if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const el = e.currentTarget;
      // 光标不在首行时不拦截（保留默认光标上移），输入框为空时直接浏览
      const firstLineEnd = draft.indexOf("\n");
      const firstLineLimit = firstLineEnd === -1 ? draft.length : firstLineEnd;
      if (draft && (el.selectionStart ?? 0) > firstLineLimit) return;
      const list = sendHistoryRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      if (historyCursorRef.current < 0) {
        // 首次进入浏览：暂存当前草稿，跳到最近发送的一条
        historyDraftBackupRef.current = draft;
        historyCursorRef.current = list.length - 1;
      } else if (historyCursorRef.current > 0) {
        historyCursorRef.current -= 1;
      }
      setDraft(list[historyCursorRef.current]);
      requestAnimationFrame(() => {
        const target = inputRef.current;
        if (target) target.setSelectionRange(target.value.length, target.value.length);
      });
      return;
    }
    if (e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (historyCursorRef.current < 0) return;
      e.preventDefault();
      historyCursorRef.current += 1;
      if (historyCursorRef.current >= sendHistoryRef.current.length) {
        // 已到最新一条之后：退出浏览，恢复进入浏览前的草稿
        historyCursorRef.current = -1;
        setDraft(historyDraftBackupRef.current);
      } else {
        setDraft(sendHistoryRef.current[historyCursorRef.current]);
      }
      requestAnimationFrame(() => {
        const target = inputRef.current;
        if (target) target.setSelectionRange(target.value.length, target.value.length);
      });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (draft.trim()) {
        void handleSend();
      } else if (queueTasks && queueTasks.length > 0) {
        void handleInterruptAndSendQueueTask(queueTasks[0]);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="chat-root">
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {!ready ? (
              <div className="chat-empty-loading">
                <div className="chat-empty-spinner" />
                <div className="chat-empty-title">正在加载会话历史…</div>
                <div className="chat-empty-desc">正在读取当前工作区的 Claude 会话记录</div>
              </div>
            ) : (
              <div className="chat-empty-welcome">
                <div className="chat-empty-badge">
                  <Sparkles size={20} className="chat-empty-badge-icon" />
                </div>
                <h2 className="chat-empty-title">今天想构建什么？</h2>
                <p className="chat-empty-desc">随时输入指令开始编程，支持多模态与上下文精准引用</p>
                <div className="chat-starters">
                  {[
                    { label: "检查未提交代码改动", prompt: "检查当前工作区未提交的代码改动并分析其影响" },
                    { label: "分析项目架构与模块", prompt: "分析当前项目的整体架构、主要模块与技术栈" },
                    { label: "为关键功能编写测试", prompt: "为当前项目中的核心功能编写单元测试" },
                    { label: "代码审查与重构建议", prompt: "审查最近的代码改动并给出极简重构与优化建议" },
                  ].map((starter, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="chat-starter-btn"
                      onClick={() => {
                        setDraft(starter.prompt);
                        requestAnimationFrame(() => inputRef.current?.focus());
                      }}
                    >
                      <span className="chat-starter-text">{starter.label}</span>
                      <span className="chat-starter-arrow">→</span>
                    </button>
                  ))}
                </div>
                <div className="chat-empty-shortcuts">
                  <span><code>@</code> 引用文件</span>
                  <span><code>/</code> 快捷技能</span>
                  <span>支持拖拽图片</span>
                </div>
              </div>
            )}
          </div>
        )}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {/* 问题卡片已提交态：保留在消息流历史中展示用户的选择摘要 */}
        {pendingQuestion && questionAnswered && (
          <QuestionCard
            request={pendingQuestion}
            submitting={false}
            error={null}
            answered={true}
            onSubmit={() => {}}
            onSkip={() => {}}
          />
        )}
        {/* AI 思考中：消息流末尾统一的三点跳动指示 + 从发送起的运行秒数。
            等待用户回答/批准期间不显示（卡片本身就是等待态）。 */}
        {busy && !(pendingQuestion && !questionAnswered) && !pendingPlanApproval && (
          <div className={`chat-thinking ${escArmed ? "is-esc-armed" : ""}`}>
            <div className="chat-typing">
              <span />
              <span />
              <span />
            </div>
            {streamingElapsed > 0 && (
              <span className="chat-thinking-elapsed">
                已运行 {streamingElapsed} 秒
              </span>
            )}
          </div>
        )}
      </div>
      {/* 活跃待交互卡片（问题提问 / 计划退出批准）：常驻吸附在输入框上方，无论窗口缩放或滚动都常驻可见，避免被遮挡或裁切 */}
      {((pendingQuestion && !questionAnswered) || pendingPlanApproval) && (
        <div className="chat-interactive-dock" role="region" aria-label="交互确认">
          {pendingQuestion && !questionAnswered && (
            <QuestionCard
              request={pendingQuestion}
              submitting={questionSubmitting}
              error={questionError}
              answered={false}
              onSubmit={(answers) => void answerQuestion(answers)}
              onSkip={() => void answerQuestion({})}
            />
          )}
          {pendingPlanApproval && (
            <PlanApprovalCard
              approval={pendingPlanApproval}
              submitting={planApprovalSubmitting}
              onApprove={() => void answerPlanApproval(true)}
              onReject={() => void answerPlanApproval(false)}
            />
          )}
        </div>
      )}
      <div
        className={`chat-composer ${draggingImage ? "is-dragging" : ""}`}
        onDragEnter={(event) => {
          if ([...event.dataTransfer.types].includes("Files")) {
            event.preventDefault();
            setDraggingImage(true);
          }
        }}
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingImage(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingImage(false);
          void addImageFiles([...event.dataTransfer.files]);
        }}
      >
        {completionTrigger && (
          <CompletionMenu
            items={completionItems}
            activeIndex={completionIndex}
            loading={completionLoading}
            onSelect={selectCompletion}
            onHover={setCompletionIndex}
          />
        )}
        {/* 排队队列栏：吸附在输入框顶部，支持编辑、删除、插话发送 */}
        {queueTasks && queueTasks.length > 0 && (
          <div className="chat-composer-queue">
            {queueTasks.map((task) => {
              const isEditing = editingQueueTaskId === task.id;
              return (
                <div key={task.id} className="chat-composer-queue-item">
                  {isEditing ? (
                    <div className="chat-composer-queue-edit-row">
                      <MessageSquare size={13} className="chat-composer-queue-icon" />
                      <input
                        type="text"
                        className="chat-composer-queue-edit-input"
                        value={editingQueueText}
                        onChange={(e) => setEditingQueueText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSaveEditQueueTask(task.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            handleCancelEditQueueTask();
                          }
                        }}
                        autoFocus
                      />
                      <div className="chat-composer-queue-actions">
                        <button
                          type="button"
                          className="chat-composer-queue-btn chat-composer-queue-btn-confirm"
                          onClick={() => handleSaveEditQueueTask(task.id)}
                          title="保存修改 (Enter)"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          className="chat-composer-queue-btn chat-composer-queue-btn-cancel"
                          onClick={handleCancelEditQueueTask}
                          title="取消编辑 (Esc)"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="chat-composer-queue-row">
                      <div className="chat-composer-queue-main">
                        <MessageSquare size={13} className="chat-composer-queue-icon" />
                        <span className="chat-composer-queue-text" title={task.prompt}>
                          {task.prompt}
                        </span>
                      </div>
                      <div className="chat-composer-queue-actions">
                        <button
                          type="button"
                          className="chat-composer-queue-btn"
                          onClick={() => handleStartEditQueueTask(task)}
                          title="编辑排队消息"
                        >
                          <PencilLine size={13} />
                        </button>
                        <button
                          type="button"
                          className="chat-composer-queue-btn chat-composer-queue-btn-delete"
                          onClick={() => onRemoveQueueTask?.(sessionId, task.id)}
                          title="删除排队消息"
                        >
                          <Trash2 size={13} />
                        </button>
                        <button
                          type="button"
                          className="chat-composer-queue-btn chat-composer-queue-btn-send"
                          onClick={() => void handleInterruptAndSendQueueTask(task)}
                          title="插话发送：暂停当前生成并立即发送本条消息"
                        >
                          <ArrowUp size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className={`chat-composer-island ${draggingImage ? "is-dragging" : ""}`}>
          {!!images.length && (
            <div className="chat-attachment-strip">
              {images.map((image) => (
                <div className="chat-attachment" key={image.id} title={image.name}>
                  <img src={image.dataUrl} alt={image.name} />
                  <button
                    type="button"
                    onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                    title="移除图片"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {(attachmentError || draggingImage) && (
            <div className={`chat-attachment-hint ${attachmentError ? "is-error" : ""}`}>
              {attachmentError || "松开以添加图片"}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="chat-input"
            value={draft}
            onChange={(event) => {
              // 用户手动输入（非 ↑/↓ 加载历史）即退出历史浏览模式
              historyCursorRef.current = -1;
              setDraft(event.target.value);
              updateCompletion(event.target.value, event.target.selectionStart);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
            }}
            onClick={(event) => {
              const pos = event.currentTarget.selectionStart ?? 0;
              const selEnd = event.currentTarget.selectionEnd ?? pos;
              updateCompletion(event.currentTarget.value, pos);
              // 点击粘贴标签内部（无选区时）：打开预览/编辑弹窗
              if (pos === selEnd) {
                const spans = findPasteLabelSpans(event.currentTarget.value);
                const span = spans.find((s) => pos >= s.start && pos < s.end);
                if (span) setPasteEditId(span.id);
              }
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
              setCompletionTrigger(null);
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              // 组合结束后重新检测，让补全菜单正常响应方向键
              updateCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onPaste={(event) => {
              const pastedImages = [...event.clipboardData.files].filter((file) =>
                file.type.startsWith("image/"),
              );
              if (pastedImages.length) {
                event.preventDefault();
                void addImageFiles(pastedImages);
                return;
              }
              // 大段文本（>3 行）折叠为 [Pasted text #N +M lines] 标签：
              // 提升提示词可读性，发送时自动还原全部文字
              const pastedText = event.clipboardData.getData("text/plain");
              if (pastedText && countLines(pastedText) > 3) {
                event.preventDefault();
                foldPastedText(pastedText);
              }
            }}
            placeholder={
              pendingQuestion && !questionAnswered
                ? "请先回答上方的问题…"
                : pendingPlanApproval
                  ? "请先确认上方的计划执行…"
                  : "输入消息，@ 引用文件，/ 触发技能，回车发送..."
            }
            rows={1}
            disabled={!ready || (!!pendingQuestion && !questionAnswered) || !!pendingPlanApproval}
          />
          <div className="chat-composer-toolbar">
            <ModelSelector
              selectedModel={selectedModel}
              modelInfo={modelInfo}
              onSelectModel={onSelectModel}
              onSelectProvider={onSelectProvider}
              onRefreshModelInfo={onRefreshModelInfo}
              disabled={busy}
            />
            <div className="chat-access-mode" role="group" aria-label="访问模式">
              {ACCESS_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`chat-access-mode-btn${accessMode === mode.id ? " is-active" : ""}`}
                  disabled={busy}
                  onClick={() => setAccessMode(mode.id)}
                  title={mode.title}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <GitBranchSelector
              directory={directory}
              disabled={busy}
              onSendAiConflictPrompt={(prompt: string) => {
                setDraft(prompt);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onTriggerSmartCommit={(prompt: string) => {
                if (busy) {
                  notifyWarning("AI 正在运行中，已将智能提交指令填入输入框");
                  setDraft(prompt);
                  requestAnimationFrame(() => inputRef.current?.focus());
                } else {
                  void sendText(prompt, []);
                }
              }}
            />
            {onOpenRulesEditor && (
              <button
                type="button"
                className="md-button"
                onClick={onOpenRulesEditor}
                title="编辑项目规则（默认 CLAUDE.md，保存后同步 AGENTS.md）"
              >
                <svg className="doc-svg-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "2px", opacity: 0.85 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                <span>规则</span>
              </button>
            )}
            <div className="chat-composer-toolbar-spacer" />
            <button
              type="button"
              className={`chat-send-btn ${busy ? "is-cancel" : ""} ${escArmed ? "is-esc-armed" : ""}`}
              onClick={busy ? handleCancel : () => void handleSend()}
              disabled={
                cancelling ||
                (!busy && (!ready || !!pendingQuestion || (!draft.trim() && images.length === 0)))
              }
              title={
                cancelling
                  ? "正在取消"
                  : busy
                    ? escArmed
                      ? "再按一次 ESC 终止任务（或点击直接终止）"
                      : "终止生成（按 ESC 两次）"
                    : "发送 (Enter)"
              }
            >
              {busy ? (
                escArmed ? (
                  <span className="chat-cancel-esc">ESC</span>
                ) : (
                  <Square size={12} fill="currentColor" />
                )
              ) : (
                <Send size={13} />
              )}
            </button>
          </div>
        </div>
      </div>
      {busy && escArmed && (
        <div className="chat-busy-hint is-esc-armed">
          再按一次 ESC 终止任务
        </div>
      )}

      {/* 粘贴标签预览/编辑弹窗 */}
      {pasteEditId != null && (
        <PasteEditModal
          initialText={pastedTextsRef.current.find((item) => item.id === pasteEditId)?.text ?? ""}
          onSave={(text) => savePasteEdit(pasteEditId, text)}
          onDelete={() => removePasteItem(pasteEditId)}
          onCancel={() => {
            setPasteEditId(null);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        />
      )}
    </div>
  );
});
