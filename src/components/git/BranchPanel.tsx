/**
 * BranchPanel — Git 分支面板
 * 功能：
 *   1. 列出本地分支 / 远程分支（可折叠分组）
 *   2. 当前分支高亮、ahead/behind 徽章
 *   3. 点击分支：展开该分支的提交历史（懒加载、可分页）
 *   4. 双击分支：切换到该分支（远程分支自动 --track 创建本地分支）
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  GitBranch,
  GitCommit,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Check,
  Search,
  Cloud,
  HardDrive,
  FolderGit2,
  Copy,
  User,
  Plus,
  Pencil,
  Trash2,
  GitMerge,
  ArrowRightLeft,
} from "lucide-react";
import { DiffViewerModal } from "./DiffViewerModal";
import { FileIcon } from "../../utils/fileIcons";
import { GitFetchIcon, RepoPullIcon } from "./codicons";

// ─────────────────────────── 类型 ───────────────────────────

interface GitCommitBrief {
  sha: string;
  shortSha: string;
  summary: string;
  author: string;
  email: string;
  timestamp: number;
}

interface GitBranchItem {
  name: string;
  fullRef: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: GitCommitBrief | null;
}

interface GitCommitEntry {
  sha: string;
  shortSha: string;
  summary: string;
  body: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
}

interface GitCommitStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface GitCommitFileChange {
  path: string;
  status: string;
  added: number;
  deleted: number;
}

// 提交文件状态配色（与 GitPanel 变更列表一致）
const COMMIT_FILE_STATUS_COLORS: Record<string, string> = {
  M: "#60a5fa",
  A: "#4ade80",
  D: "#f87171",
  R: "#c084fc",
};

interface BranchPanelProps {
  projectPath: string;
  /** diff 弹窗右键「添加到对话」：绝对路径 + 行号范围注入终端 */
  onAddLinesToConversation?: (absolutePath: string, startLine: number, endLine: number) => void;
}

// watcher 启动失败时的轮询兜底间隔（与 GitPanel 保持一致）
const FALLBACK_POLL_INTERVAL_MS = 15000;

interface GitRepoInfo {
  relativePath: string;
  absolutePath: string;
  branch: string | null;
}

// ─────────────────────────── 辅助函数 ───────────────────────────

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 0) return "刚刚";
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${Math.floor(diff / (86400 * 365))} 年前`;
}

function formatDateTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 中文友好的绝对时间，用于 tooltip 头部（例：2026年7月15日 16:24）
function formatFullDateTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("无法复制到剪切板:", err);
  }
}

// ─────────────────────────── 单个分支行 ───────────────────────────

const BranchRow: React.FC<{
  branch: GitBranchItem;
  selected: boolean;
  onSelect: () => void;
  onCheckout: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ branch, selected, onSelect, onCheckout, onContextMenu }) => {
  return (
    <div
      className={`branch-row ${selected ? "selected" : ""} ${branch.isCurrent ? "current" : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={() => {
        if (!branch.isCurrent) onCheckout();
      }}
      title={
        branch.isCurrent
          ? `当前分支：${branch.name}`
          : `双击切换到 ${branch.name}`
      }
    >
      <span className="branch-row-marker">
        {branch.isCurrent ? <Check size={11} strokeWidth={3} /> : <span style={{ width: 11 }} />}
      </span>
      <GitBranch size={12} className="branch-row-icon" />
      <span className="branch-row-name">{branch.name}</span>
      {branch.upstream && !branch.isRemote && (
        <span className="branch-row-upstream" title={`上游：${branch.upstream}`}>
          → {branch.upstream}
        </span>
      )}
      {branch.ahead > 0 && (
        <span className="branch-row-ahead" title={`领先 ${branch.ahead} 个提交`}>
          <ArrowUp size={9} />
          {branch.ahead}
        </span>
      )}
      {branch.behind > 0 && (
        <span className="branch-row-behind" title={`落后 ${branch.behind} 个提交`}>
          <ArrowDown size={9} />
          {branch.behind}
        </span>
      )}
      {branch.lastCommit && (
        <span className="branch-row-time" title={formatDateTime(branch.lastCommit.timestamp)}>
          {formatRelativeTime(branch.lastCommit.timestamp)}
        </span>
      )}
    </div>
  );
};

// ─────────────────────────── 主组件 ───────────────────────────

const COMMITS_PAGE_SIZE = 50;

export const BranchPanel: React.FC<BranchPanelProps> = ({ projectPath, onAddLinesToConversation }) => {
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsHasMore, setCommitsHasMore] = useState(false);

  const [localCollapsed, setLocalCollapsed] = useState(false);
  // 远程分支按 remote 名分组，每个分组独立折叠状态
  const [collapsedRemotes, setCollapsedRemotes] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);

  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // 提交悬浮信息卡（代替浏览器原生 title tooltip）
  const [commitTooltip, setCommitTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    commit: GitCommitEntry | null;
  }>({ visible: false, x: 0, y: 0, commit: null });
  const [commitStatCache, setCommitStatCache] = useState<Map<string, GitCommitStat>>(new Map());
  const [commitStatLoadingSha, setCommitStatLoadingSha] = useState<string | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);

  // 提交行展开（手风琴）：展示该提交变更的文件列表，点文件弹 diff
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [commitFilesCache, setCommitFilesCache] = useState<Map<string, GitCommitFileChange[]>>(new Map());
  const [commitFilesLoadingSha, setCommitFilesLoadingSha] = useState<string | null>(null);
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null);
  const [commitDiffFile, setCommitDiffFile] = useState<{ sha: string; path: string; status: string } | null>(null);

  // 多仓库切换（与 GitPanel 的机制保持一致）
  const [repositories, setRepositories] = useState<GitRepoInfo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);

  // ── 分支右键菜单 + 操作弹窗 ──
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: GitBranchItem } | null>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const [branchMenuPosition, setBranchMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [branchInput, setBranchInput] = useState<{ mode: "create" | "rename"; branch: GitBranchItem; value: string } | null>(null);
  const [branchConfirm, setBranchConfirm] = useState<{ mode: "delete" | "merge"; branch: GitBranchItem; needForce: boolean } | null>(null);
  const [branchOpBusy, setBranchOpBusy] = useState(false);

  // ── Fetch / Pull（拉取策略与提交面板共享同一 localStorage） ──
  const [fetching, setFetching] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullStrategy] = useState<string>(
    () => localStorage.getItem("kkcoder_git_pull_strategy") || "merge"
  );

  const projectPathRef = useRef(projectPath);
  const loadingRef = useRef(false);

  // 实际使用的仓库路径：若未指定子仓库则使用项目根目录
  const repoPath = activeRepoPath ?? projectPath;
  const activeRepo = activeRepoPath
    ? repositories.find((r) => r.absolutePath === activeRepoPath)
    : null;
  const rootRepoLabel =
    projectPath?.split(/[\\/]/).filter(Boolean).pop() || "根仓库";
  const activeRepoLabel = activeRepo?.relativePath || rootRepoLabel;

  // ── 数据加载 ──
  const fetchBranches = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    const requestPath = repoPath;
    try {
      const result = await invoke<GitBranchItem[]>("git_list_branches", { projectPath: requestPath });
      // 竞态守卫：项目/仓库已切换 → 丢弃过期结果
      if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
      setBranches(result);
      // 首次或没有选中时，自动选中当前分支
      setSelectedRef((prev) => {
        if (prev && result.some((b) => b.fullRef === prev)) return prev;
        const current = result.find((b) => b.isCurrent);
        return current?.fullRef ?? result[0]?.fullRef ?? null;
      });
    } catch (e) {
      if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
      const msg = String(e);
      if (!silent && !msg.includes("not a git repository") && !msg.includes("open_repo_failed")) {
        setError(msg);
      }
      setBranches([]);
    } finally {
      loadingRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [repoPath, projectPath]);

  const fetchCommits = useCallback(
    async (branchRef: string, append: boolean) => {
      setCommitsError(null);
      setCommitsLoading(true);
      const requestPath = repoPath;
      const skip = append ? commits.length : 0;
      try {
        const result = await invoke<GitCommitEntry[]>("git_list_branch_commits", {
          projectPath: requestPath,
          branchRef,
          limit: COMMITS_PAGE_SIZE,
          skip,
        });
        if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
        if (append) {
          setCommits((prev) => [...prev, ...result]);
        } else {
          setCommits(result);
        }
        setCommitsHasMore(result.length >= COMMITS_PAGE_SIZE);
      } catch (e) {
        if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
        setCommitsError(String(e));
        if (!append) setCommits([]);
      } finally {
        setCommitsLoading(false);
      }
    },
    [repoPath, projectPath, commits.length]
  );

  const fetchRepositories = useCallback(async () => {
    try {
      const result = await invoke<GitRepoInfo[]>("git_list_repositories", { projectPath });
      setRepositories(result);
    } catch {
      setRepositories([]);
    }
  }, [projectPath]);

  // 项目切换 → 重置仓库子选择并重新拉取列表
  useEffect(() => {
    projectPathRef.current = projectPath;
    setActiveRepoPath(null);
    setSelectedRef(null);
    setCommits([]);
    setCommitsHasMore(false);
    setCheckoutError(null);
    fetchBranches(false);
    fetchRepositories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // 仓库切换后自动刷新分支列表
  const prevActiveRepoPath = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveRepoPath.current !== activeRepoPath && projectPath) {
      prevActiveRepoPath.current = activeRepoPath;
      setSelectedRef(null);
      setCommits([]);
      setCommitsHasMore(false);
      setCheckoutError(null);
      fetchBranches(false);
    }
  }, [activeRepoPath, projectPath, fetchBranches]);

  // 选中分支变化 → 拉取提交历史
  useEffect(() => {
    if (!selectedRef) {
      setCommits([]);
      setCommitsHasMore(false);
      return;
    }
    fetchCommits(selectedRef, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRef, repoPath]);

  // fs-watcher：启动后端监听（.git/HEAD、index 等变化）→ 同步刷新分支列表；
  // watcher 启动失败时降级为慢轮询兜底
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const setup = async () => {
      try {
        await invoke("git_watch_start", { projectPath: repoPath });
        const win = await getCurrentWindow();
        unlisten = await win.listen<{ projectPath: string }>("git-changed", (event) => {
          if (event.payload.projectPath === repoPath) {
            fetchBranches(true);
          }
        });
      } catch {
        intervalId = setInterval(() => {
          fetchBranches(true);
        }, FALLBACK_POLL_INTERVAL_MS);
        unlisten = () => { if (intervalId) clearInterval(intervalId); };
      }
    };
    setup();
    return () => {
      if (unlisten) unlisten();
      invoke("git_watch_stop").catch(() => {});
    };
  }, [repoPath, fetchBranches]);

  // 焦点刷新兜底：窗口重新活跃/可见时静默刷新分支列表
  useEffect(() => {
    const handleFocus = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        fetchBranches(true);
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchBranches(true);
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchBranches]);

  // ── 派生数据 ──
  const filterLower = filter.trim().toLowerCase();
  const filteredBranches = useMemo(() => {
    if (!filterLower) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(filterLower));
  }, [branches, filterLower]);

  const localBranches = useMemo(
    () => filteredBranches.filter((b) => !b.isRemote),
    [filteredBranches]
  );
  const remoteBranches = useMemo(
    () => filteredBranches.filter((b) => b.isRemote),
    [filteredBranches]
  );

  // 将远程分支按 remote 名（引用前段）分组；origin 置顶，其余按字母序
  const remoteBranchGroups = useMemo(() => {
    if (remoteBranches.length === 0) return [] as [string, GitBranchItem[]][];
    const groups = new Map<string, GitBranchItem[]>();
    for (const b of remoteBranches) {
      const slash = b.name.indexOf("/");
      const remoteName = slash > 0 ? b.name.slice(0, slash) : "未知";
      const list = groups.get(remoteName);
      if (list) list.push(b);
      else groups.set(remoteName, [b]);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === "origin") return -1;
      if (b === "origin") return 1;
      return a.localeCompare(b);
    });
  }, [remoteBranches]);

  // 只有一个 remote 时，保持“远程分支”单分组（不接后缀）；多个时才展开为“远程分支：<name>”
  const showRemoteNameInLabel = remoteBranchGroups.length > 1;

  const toggleRemoteCollapsed = (name: string) => {
    setCollapsedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectedBranch = useMemo(
    () => branches.find((b) => b.fullRef === selectedRef) ?? null,
    [branches, selectedRef]
  );

  // ── 操作 ──
  const handleCheckout = async (branch: GitBranchItem) => {
    if (branch.isCurrent || checkoutBusy) return;
    setCheckoutBusy(branch.fullRef);
    setCheckoutError(null);
    try {
      await invoke("git_checkout_branch", {
        projectPath: repoPath,
        branch: branch.name,
        isRemote: branch.isRemote,
      });
      await fetchBranches(true);
    } catch (e) {
      const msg = String(e);
      // 本地化常见错误
      let friendly = msg;
      if (msg.includes("would be overwritten") || msg.includes("local changes")) {
        friendly = "切换失败：工作区有未提交的更改，请先提交或暂存";
      } else if (msg.includes("already exists")) {
        friendly = "切换失败：本地已存在同名分支";
      } else if (msg.startsWith("git_failed:")) {
        friendly = msg.replace(/^git_failed:\s*/, "").slice(0, 200);
      }
      setCheckoutError(friendly);
    } finally {
      setCheckoutBusy(null);
    }
  };

  // 当前分支（合并确认 / 拉取上游判断等场景用）
  const currentBranch = useMemo(() => branches.find((b) => b.isCurrent) ?? null, [branches]);
  const currentBranchName = currentBranch?.name ?? null;

  // 右键分支 → 打开上下文菜单
  const openBranchMenu = (e: React.MouseEvent, branch: GitBranchItem) => {
    e.preventDefault();
    e.stopPropagation();
    setBranchMenuPosition(null);
    setBranchMenu({ x: e.clientX, y: e.clientY, branch });
  };

  // 菜单内容随分支类型和名称变化，必须按实际尺寸做视口碰撞检测。
  useLayoutEffect(() => {
    if (!branchMenu) {
      setBranchMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const menu = branchMenuRef.current;
      if (!menu) return;

      const viewportPadding = 8;
      const rect = menu.getBoundingClientRect();
      const maxLeft = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
      const maxTop = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding);
      const left = Math.min(Math.max(branchMenu.x, viewportPadding), maxLeft);
      const top = Math.min(Math.max(branchMenu.y, viewportPadding), maxTop);

      setBranchMenuPosition((current) =>
        current?.left === left && current.top === top ? current : { left, top }
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [branchMenu]);

  // git 错误本地化（分支操作通用）
  const localizeGitError = (msg: string): string => {
    if (msg.includes("would be overwritten") || msg.includes("local changes")) {
      return "工作区有未提交的更改，请先提交或暂存";
    }
    if (msg.includes("not fully merged")) {
      return "分支存在未合并的提交";
    }
    if (msg.includes("not_fast_forward") || msg.includes("non-fast-forward") || msg.includes("[rejected]")) {
      return "该分支与远端已分叉，无法快进更新，请先切换到该分支再拉取/合并";
    }
    if (msg.includes("pull_conflict") || msg.includes("conflict") || msg.includes("Automatic merge failed")) {
      return "合并存在冲突，请在终端手动解决后提交";
    }
    if (msg.includes("already exists")) {
      return "已存在同名分支";
    }
    if (msg.startsWith("git_failed:")) {
      return msg.replace(/^git_failed:\s*/, "").slice(0, 200);
    }
    return msg;
  };

  const handleCopyBranchName = async (name: string) => {
    await copyToClipboard(name);
  };

  // 新建 / 重命名 提交
  const submitBranchInput = async () => {
    if (!branchInput || branchOpBusy) return;
    const name = branchInput.value.trim();
    if (!name) return;
    setBranchOpBusy(true);
    setCheckoutError(null);
    try {
      if (branchInput.mode === "create") {
        await invoke("git_create_branch", {
          projectPath: repoPath,
          branchName: name,
          startPoint: branchInput.branch.name,
          checkout: true,
        });
      } else {
        await invoke("git_rename_branch", {
          projectPath: repoPath,
          oldName: branchInput.branch.name,
          newName: name,
        });
      }
      setBranchInput(null);
      await fetchBranches(true);
    } catch (e) {
      setCheckoutError(localizeGitError(String(e)));
    } finally {
      setBranchOpBusy(false);
    }
  };

  // 删除 / 合并 确认（本地删除未合并时转强制删除二次确认）
  const submitBranchConfirm = async (force = false) => {
    if (!branchConfirm || branchOpBusy) return;
    setBranchOpBusy(true);
    setCheckoutError(null);
    try {
      if (branchConfirm.mode === "delete") {
        await invoke("git_delete_branch", {
          projectPath: repoPath,
          branchName: branchConfirm.branch.name,
          isRemote: branchConfirm.branch.isRemote,
          force,
        });
      } else {
        await invoke("git_merge_branch", {
          projectPath: repoPath,
          branchName: branchConfirm.branch.name,
        });
      }
      setBranchConfirm(null);
      await fetchBranches(true);
    } catch (e) {
      const msg = String(e);
      if (branchConfirm.mode === "delete" && !branchConfirm.branch.isRemote && msg.includes("not fully merged")) {
        setBranchConfirm({ ...branchConfirm, needForce: true });
      } else {
        setCheckoutError(localizeGitError(msg));
        setBranchConfirm(null);
      }
    } finally {
      setBranchOpBusy(false);
    }
  };

  // 从所有远程获取更新（不改工作区）→ 刷新分支列表与 ↑↓ 角标
  const handleFetch = async () => {
    if (fetching || pulling) return;
    setFetching(true);
    setCheckoutError(null);
    try {
      await invoke("git_fetch", { projectPath: repoPath });
      await fetchBranches(true);
    } catch (e) {
      setCheckoutError(localizeGitError(String(e)));
    } finally {
      setFetching(false);
    }
  };

  // 拉取当前分支（策略与提交面板共享）→ 刷新分支与当前选中分支的提交历史
  const handlePull = async () => {
    if (fetching || pulling) return;
    setPulling(true);
    setCheckoutError(null);
    try {
      await invoke("git_pull", { projectPath: repoPath, strategy: pullStrategy });
      await fetchBranches(true);
      if (selectedRef) fetchCommits(selectedRef, false);
    } catch (e) {
      setCheckoutError(localizeGitError(String(e)));
    } finally {
      setPulling(false);
    }
  };

  // 从远端更新指定本地分支：当前分支走 pull；非当前分支走快进 fetch（不切换、不碰工作区）
  const handleUpdateBranch = async (b: GitBranchItem) => {
    setBranchMenu(null);
    if (!b.upstream || branchOpBusy || pulling || fetching) return;
    setBranchOpBusy(true);
    setCheckoutError(null);
    try {
      if (b.isCurrent) {
        await invoke("git_pull", { projectPath: repoPath, strategy: pullStrategy });
      } else {
        // upstream 形如 "origin/main" → remote="origin", remoteBranch="main"
        const slash = b.upstream.indexOf("/");
        const remote = slash > 0 ? b.upstream.slice(0, slash) : "origin";
        const remoteBranch = slash > 0 ? b.upstream.slice(slash + 1) : b.upstream;
        await invoke("git_update_branch", {
          projectPath: repoPath,
          remote,
          remoteBranch,
          localBranch: b.name,
        });
      }
      await fetchBranches(true);
      if (selectedRef) fetchCommits(selectedRef, false);
    } catch (e) {
      setCheckoutError(localizeGitError(String(e)));
    } finally {
      setBranchOpBusy(false);
    }
  };

  const handleLoadMoreCommits = () => {
    if (selectedRef && !commitsLoading && commitsHasMore) {
      fetchCommits(selectedRef, true);
    }
  };

  // ── 提交行展开/收起：展开时懒加载该提交的文件变更列表（按 SHA 缓存） ──
  const handleToggleCommitExpand = (sha: string) => {
    // 展开时隐藏悬浮信息卡，避免遮挡文件列表
    setCommitTooltip((prev) => ({ ...prev, visible: false }));
    setCommitFilesError(null);
    setExpandedSha((prev) => {
      const next = prev === sha ? null : sha;
      if (next && !commitFilesCache.has(sha)) {
        setCommitFilesLoadingSha(sha);
        const requestPath = repoPath;
        invoke<GitCommitFileChange[]>("git_commit_files", {
          projectPath: requestPath,
          sha,
        })
          .then((files) => {
            if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
            setCommitFilesCache((prevCache) => {
              const nextCache = new Map(prevCache);
              nextCache.set(sha, files);
              return nextCache;
            });
          })
          .catch((e) => {
            if (projectPathRef.current !== projectPath || repoPath !== requestPath) return;
            setCommitFilesError(String(e));
          })
          .finally(() => {
            setCommitFilesLoadingSha((cur) => (cur === sha ? null : cur));
          });
      }
      return next;
    });
  };

  // ── 提交悬浮信息卡交互（即显即隐，通过 relatedTarget 判断鼠标去向，保证可移入卡片操作） ──
  const isInsideCommitTooltip = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(".commit-tooltip");

  const isInsideCommitRow = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(".branch-commit-row");

  const handleCommitMouseEnter = (e: React.MouseEvent, commit: GitCommitEntry) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.left - 8; // tooltip 右边缘位置
    const y = rect.top + rect.height / 2; // tooltip 垂直中心位置
    const targetSha = commit.sha;
    setCommitTooltip({ visible: true, x, y, commit });
    if (!commitStatCache.has(targetSha) && commitStatLoadingSha !== targetSha) {
      setCommitStatLoadingSha(targetSha);
      invoke<GitCommitStat>("git_commit_stat", {
        projectPath: repoPath,
        sha: targetSha,
      })
        .then((stat) => {
          setCommitStatCache((prev) => {
            const next = new Map(prev);
            next.set(targetSha, stat);
            return next;
          });
        })
        .catch(() => {
          /* 静默失败：tooltip 会显示“无变更统计” */
        })
        .finally(() => {
          setCommitStatLoadingSha((cur) => (cur === targetSha ? null : cur));
        });
    }
  };

  const handleCommitMouseLeave = (e: React.MouseEvent) => {
    // 移入信息卡 → 保持显示，否则立即隐藏
    if (isInsideCommitTooltip(e.relatedTarget)) return;
    setCommitTooltip((prev) => ({ ...prev, visible: false }));
  };

  const handleCommitTooltipMouseLeave = (e: React.MouseEvent) => {
    // 移回提交行 → 由该行的 mouseenter 接管刷新，避免隐藏后重现引起的闪烁
    if (isInsideCommitRow(e.relatedTarget)) return;
    setCommitTooltip((prev) => ({ ...prev, visible: false }));
  };

  const handleCopySha = async (sha: string) => {
    await copyToClipboard(sha);
    setCopiedSha(sha);
    setTimeout(() => setCopiedSha((cur) => (cur === sha ? null : cur)), 1500);
  };

  // 项目/仓库/分支列表刷新时 → 清理 stat/文件列表缓存与展开态（避开遗留旧仓库数据）
  useEffect(() => {
    setCommitStatCache(new Map());
    setCommitTooltip({ visible: false, x: 0, y: 0, commit: null });
    setExpandedSha(null);
    setCommitFilesCache(new Map());
    setCommitFilesError(null);
    setCommitDiffFile(null);
  }, [repoPath]);

  // ── 渲染 ──
  return (
    <div className="branch-panel">
      {/* Header */}
      <div className="branch-header">
        <span className="branch-header-title">
          <GitBranch size={13} />
          分支
        </span>
        <div className="branch-header-actions">
          <button
            className={`git-action-btn ${showFilter ? "active" : ""}`}
            onClick={() => {
              setShowFilter((s) => !s);
              if (showFilter) setFilter("");
            }}
            title="搜索分支"
          >
            <Search size={11} />
          </button>
          <button
            className="git-action-btn"
            onClick={() => void handleFetch()}
            disabled={fetching || pulling}
            title="从所有远程获取更新 (Fetch)"
          >
            <GitFetchIcon size={12} className={fetching ? "spinning" : ""} />
          </button>
          <button
            className="git-action-btn"
            onClick={() => void handlePull()}
            disabled={pulling || fetching || !currentBranch?.upstream}
            title={currentBranch?.upstream ? `拉取当前分支 ${currentBranch.name}（${pullStrategy}）` : "当前分支无上游，无法拉取"}
          >
            <RepoPullIcon size={12} className={pulling ? "spinning" : ""} />
          </button>
          <button
            className={`git-action-btn ${loading ? "spinning" : ""}`}
            onClick={() => fetchBranches(false)}
            title="刷新"
          >
            <RefreshCw size={11} />
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      {showFilter && (
        <div className="branch-filter">
          <Search size={11} className="branch-filter-icon" />
          <input
            type="text"
            className="branch-filter-input"
            placeholder="过滤分支名..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
        </div>
      )}

      {/* 仓库切换（仅当项目下存在多个 Git 仓库时显示） */}
      {repositories.length > 1 && (
        <div className="git-repo-switcher">
          <button
            className="git-repo-btn"
            onClick={() => setRepoMenuOpen(!repoMenuOpen)}
          >
            <FolderGit2 size={13} />
            <span className="git-repo-label">{activeRepoLabel}</span>
            <ChevronDown size={8} />
          </button>
          {repoMenuOpen && (
            <>
              <div className="git-dropdown-overlay" onClick={() => setRepoMenuOpen(false)} />
              <div className="git-dropdown-menu git-repo-menu">
                {repositories.map((repo) => {
                  const isRoot = repo.relativePath === "";
                  const selected = isRoot
                    ? activeRepoPath === null
                    : activeRepoPath === repo.absolutePath;
                  const label = isRoot ? rootRepoLabel : repo.relativePath;
                  return (
                    <button
                      key={repo.absolutePath}
                      className={`git-dropdown-item ${selected ? "active" : ""}`}
                      onClick={() => {
                        setRepoMenuOpen(false);
                        setActiveRepoPath(isRoot ? null : repo.absolutePath);
                      }}
                    >
                      <span>{label}</span>
                      {repo.branch && <span className="git-repo-branch">{repo.branch}</span>}
                      {selected && <Check size={11} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* 切换错误提示 */}
      {checkoutError && (
        <div className="branch-checkout-error">
          {checkoutError}
          <button className="branch-checkout-error-close" onClick={() => setCheckoutError(null)}>
            ×
          </button>
        </div>
      )}

      {/* 分支列表 */}
      <div className="branch-list">
        {loading && branches.length === 0 ? (
          <div className="git-loading">加载中...</div>
        ) : error ? (
          <div className="git-error">{error}</div>
        ) : branches.length === 0 ? (
          <div className="git-empty">未找到分支</div>
        ) : (
          <>
            {/* 本地分支 */}
            <div className="branch-group">
              <div
                className="branch-group-header"
                onClick={() => setLocalCollapsed((c) => !c)}
              >
                <span
                  className="branch-group-arrow"
                  style={{ transform: localCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                >
                  <ChevronRight size={10} strokeWidth={2} />
                </span>
                <HardDrive size={11} className="branch-group-icon" />
                <span className="branch-group-label">本地分支</span>
                <span className="branch-group-count">{localBranches.length}</span>
              </div>
              {!localCollapsed &&
                (localBranches.length === 0 ? (
                  <div className="branch-empty-hint">无本地分支</div>
                ) : (
                  localBranches.map((b) => (
                    <BranchRow
                      key={b.fullRef}
                      branch={b}
                      selected={selectedRef === b.fullRef}
                      onSelect={() => setSelectedRef(b.fullRef)}
                      onCheckout={() => handleCheckout(b)}
                      onContextMenu={(e) => openBranchMenu(e, b)}
                    />
                  ))
                ))}
            </div>

            {/* 远程分支：按 remote 名分组（origin 置顶，其余字母序） */}
            {remoteBranchGroups.length === 0 ? (
              <div className="branch-group">
                <div className="branch-group-header" style={{ cursor: "default" }}>
                  <span className="branch-group-arrow" style={{ transform: "rotate(90deg)" }}>
                    <ChevronRight size={10} strokeWidth={2} />
                  </span>
                  <Cloud size={11} className="branch-group-icon" />
                  <span className="branch-group-label">远程分支</span>
                  <span className="branch-group-count">0</span>
                </div>
                <div className="branch-empty-hint">无远程分支</div>
              </div>
            ) : (
              remoteBranchGroups.map(([remoteName, list]) => {
                const collapsed = collapsedRemotes.has(remoteName);
                return (
                  <div key={remoteName} className="branch-group">
                    <div
                      className="branch-group-header"
                      onClick={() => toggleRemoteCollapsed(remoteName)}
                    >
                      <span
                        className="branch-group-arrow"
                        style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                      >
                        <ChevronRight size={10} strokeWidth={2} />
                      </span>
                      <Cloud size={11} className="branch-group-icon" />
                      <span className="branch-group-label">
                        远程分支
                        {showRemoteNameInLabel && (
                          <>
                            <span className="branch-remote-sep">：</span>
                            <span className="branch-remote-name">{remoteName}</span>
                          </>
                        )}
                      </span>
                      <span className="branch-group-count">{list.length}</span>
                    </div>
                    {!collapsed &&
                      list.map((b) => (
                        <BranchRow
                          key={b.fullRef}
                          branch={b}
                          selected={selectedRef === b.fullRef}
                          onSelect={() => setSelectedRef(b.fullRef)}
                          onCheckout={() => handleCheckout(b)}
                          onContextMenu={(e) => openBranchMenu(e, b)}
                        />
                      ))}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>

      {/* 提交历史 */}
      <div className="branch-commits">
        <div className="branch-commits-header">
          <GitCommit size={11} />
          <span className="branch-commits-title">提交历史</span>
          {selectedBranch && (
            <span className="branch-commits-branch" title={selectedBranch.fullRef}>
              {selectedBranch.name}
            </span>
          )}
        </div>
        <div className="branch-commits-body">
          {!selectedRef ? (
            <div className="git-empty">请选择一个分支</div>
          ) : commitsLoading && commits.length === 0 ? (
            <div className="git-loading">加载中...</div>
          ) : commitsError ? (
            <div className="git-error">{commitsError}</div>
          ) : commits.length === 0 ? (
            <div className="git-empty">无提交记录</div>
          ) : (
            <>
              {commits.map((c) => {
                const expanded = expandedSha === c.sha;
                const files = commitFilesCache.get(c.sha);
                const filesLoading = commitFilesLoadingSha === c.sha;
                return (
                  <React.Fragment key={c.sha}>
                    <div
                      className={`branch-commit-row ${expanded ? "expanded" : ""}`}
                      onClick={() => handleToggleCommitExpand(c.sha)}
                      onMouseEnter={(e) => handleCommitMouseEnter(e, c)}
                      onMouseLeave={handleCommitMouseLeave}
                    >
                      <span
                        className="branch-commit-expand-arrow"
                        style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
                      >
                        <ChevronRight size={10} strokeWidth={2} />
                      </span>
                      <div className="branch-commit-main">
                        <div className="branch-commit-summary">{c.summary || "(无提交信息)"}</div>
                        <div className="branch-commit-meta">
                          <span className="branch-commit-author">{c.author || "unknown"}</span>
                          <span className="branch-commit-sep">·</span>
                          <span className="branch-commit-time">{formatRelativeTime(c.timestamp)}</span>
                          <span className="branch-commit-date">({formatFullDateTime(c.timestamp)})</span>
                          {c.parents.length > 1 && (
                            <>
                              <span className="branch-commit-sep">·</span>
                              <span className="branch-commit-merge">merge</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <div className="branch-commit-files">
                        {filesLoading ? (
                          <div className="branch-commit-files-hint">加载文件列表...</div>
                        ) : commitFilesError ? (
                          <div className="branch-commit-files-hint error">{commitFilesError}</div>
                        ) : !files || files.length === 0 ? (
                          <div className="branch-commit-files-hint">无文件变更</div>
                        ) : (
                          files.map((f) => {
                            const fileName = f.path.split("/").pop() || f.path;
                            const dirPath = f.path.slice(0, f.path.length - fileName.length).replace(/\/$/, "");
                            const statusColor = COMMIT_FILE_STATUS_COLORS[f.status] || "var(--text-secondary)";
                            return (
                              <div
                                key={f.path}
                                className="branch-commit-file-row"
                                title={`${f.path}（点击查看 diff）`}
                                onClick={() => setCommitDiffFile({ sha: c.sha, path: f.path, status: f.status })}
                              >
                                <span className="branch-commit-file-status" style={{ color: statusColor }}>
                                  {f.status}
                                </span>
                                <FileIcon name={fileName} size={12} className="branch-commit-file-icon" />
                                <span className="branch-commit-file-name">{fileName}</span>
                                {dirPath && <span className="branch-commit-file-dir">{dirPath}</span>}
                                {f.added > 0 && <span className="branch-commit-file-stat plus">+{f.added}</span>}
                                {f.deleted > 0 && <span className="branch-commit-file-stat minus">-{f.deleted}</span>}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
              {commitsHasMore && (
                <button
                  className="branch-commits-more"
                  onClick={handleLoadMoreCommits}
                  disabled={commitsLoading}
                >
                  {commitsLoading ? "加载中..." : "加载更多"}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 提交内文件 diff 弹窗（只读提交模式） */}
      {commitDiffFile && (
        <DiffViewerModal
          projectPath={repoPath}
          filePath={commitDiffFile.path}
          status={commitDiffFile.status}
          sha={commitDiffFile.sha}
          onAddSelectionToConversation={
            onAddLinesToConversation
              ? (start, end) => onAddLinesToConversation(`${repoPath}/${commitDiffFile.path}`, start, end)
              : undefined
          }
          onClose={() => setCommitDiffFile(null)}
        />
      )}

      {/* 提交悬浮信息卡 */}
      {commitTooltip.visible && commitTooltip.commit && (() => {
        const c = commitTooltip.commit;
        const stat = commitStatCache.get(c.sha) ?? null;
        const loading = commitStatLoadingSha === c.sha && !stat;
        const isCopied = copiedSha === c.sha;
        return (
          <div
            className="commit-tooltip"
            style={{
              position: "fixed",
              left: `${commitTooltip.x}px`,
              top: `${commitTooltip.y}px`,
              transform: "translate(-100%, -50%)",
              zIndex: 10000,
            }}
            onMouseLeave={handleCommitTooltipMouseLeave}
          >
            {/* Header 行：作者 + 相对时间 + 绝对时间 */}
            <div className="commit-tooltip-header">
              <span className="commit-tooltip-avatar" title={c.email}>
                <User size={11} />
              </span>
              <span className="commit-tooltip-author">{c.author || "unknown"}</span>
              <span className="commit-tooltip-dot">,</span>
              <span className="commit-tooltip-relative">{formatRelativeTime(c.timestamp)}</span>
              <span className="commit-tooltip-absolute">({formatFullDateTime(c.timestamp)})</span>
            </div>

            {/* 提交标题 */}
            <div className="commit-tooltip-title">{c.summary || "(无提交信息)"}</div>

            {/* 提交正文（可选） */}
            {c.body && c.body.trim().length > 0 && (
              <div className="commit-tooltip-body">
                {c.body
                  .replace(/\r/g, "")
                  .split(/\n\n+/)
                  .map((para, i) => {
                    const trimmed = para.trim();
                    if (!trimmed) return null;
                    // 以 - 、*、• 开头已经是列表项 → 直接保留；否则转为“•”开头
                    const looksListed = /^(\s*[-*•])/.test(trimmed);
                    return (
                      <div key={i} className="commit-tooltip-body-para">
                        {looksListed ? trimmed : `• ${trimmed}`}
                      </div>
                    );
                  })}
              </div>
            )}

            {/* 变更统计 */}
            <div className="commit-tooltip-stats">
              {loading ? (
                <span className="commit-tooltip-stats-loading">统计中...</span>
              ) : stat ? (
                <>
                  已修改 <b>{stat.filesChanged}</b> 个文件,{" "}
                  <span className="commit-tooltip-plus">{stat.insertions} 行插入(+)</span>,{" "}
                  <span className="commit-tooltip-minus">{stat.deletions} 行删除(-)</span>
                </>
              ) : (
                <span className="commit-tooltip-stats-empty">无变更统计</span>
              )}
            </div>

            {/* Footer：SHA + 复制 + merge */}
            <div className="commit-tooltip-footer">
              <span className="commit-tooltip-sha" title={c.sha}>{c.shortSha}</span>
              <button
                className="commit-tooltip-copy"
                onClick={() => handleCopySha(c.sha)}
                title="复制完整 SHA"
              >
                {isCopied ? <Check size={11} /> : <Copy size={11} />}
                <span>{isCopied ? "已复制" : "复制"}</span>
              </button>
              {c.parents.length > 1 && (
                <span className="commit-tooltip-merge-tag" title={`合并提交（${c.parents.length} 个父提交）`}>
                  merge
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* 分支右键上下文菜单 */}
      {branchMenu && (() => {
        const b = branchMenu.branch;
        const isCurrent = b.isCurrent;
        const isRemote = b.isRemote;
        return (
          <>
            <div
              className="branch-menu-overlay"
              onClick={() => setBranchMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setBranchMenu(null); }}
            />
            <div
              ref={branchMenuRef}
              className="branch-context-menu"
              style={{
                left: branchMenuPosition?.left ?? branchMenu.x,
                top: branchMenuPosition?.top ?? branchMenu.y,
                visibility: branchMenuPosition ? "visible" : "hidden",
              }}
            >
              {!isCurrent && (
                <button className="branch-menu-item" onClick={() => { setBranchMenu(null); handleCheckout(b); }}>
                  <ArrowRightLeft size={13} />
                  {isRemote ? "检出为本地分支" : "切换到此分支"}
                </button>
              )}
              {!isRemote && (
                <button
                  className="branch-menu-item"
                  disabled={!b.upstream}
                  onClick={() => handleUpdateBranch(b)}
                  title={b.upstream ? `从 ${b.upstream} 快进更新` : "无上游，无法更新"}
                >
                  <RepoPullIcon size={13} />
                  从远端更新此分支
                </button>
              )}
              {(!isCurrent || !isRemote) && <div className="branch-menu-sep" />}
              <button
                className="branch-menu-item"
                onClick={() => { setBranchMenu(null); setBranchInput({ mode: "create", branch: b, value: "" }); }}
              >
                <Plus size={13} />
                基于此分支新建分支…
              </button>
              {!isRemote && (
                <button
                  className="branch-menu-item"
                  onClick={() => { setBranchMenu(null); setBranchInput({ mode: "rename", branch: b, value: b.name }); }}
                >
                  <Pencil size={13} />
                  重命名分支…
                </button>
              )}
              {!isCurrent && (
                <button
                  className="branch-menu-item danger"
                  onClick={() => { setBranchMenu(null); setBranchConfirm({ mode: "delete", branch: b, needForce: false }); }}
                >
                  <Trash2 size={13} />
                  {isRemote ? "删除远程分支" : "删除分支"}
                </button>
              )}
              {!isCurrent && (
                <>
                  <div className="branch-menu-sep" />
                  <button
                    className="branch-menu-item"
                    onClick={() => { setBranchMenu(null); setBranchConfirm({ mode: "merge", branch: b, needForce: false }); }}
                  >
                    <GitMerge size={13} />
                    合并 {b.name} 到当前分支
                  </button>
                </>
              )}
              <div className="branch-menu-sep" />
              <button className="branch-menu-item" onClick={() => { setBranchMenu(null); handleCopyBranchName(b.name); }}>
                <Copy size={13} />
                复制分支名
              </button>
            </div>
          </>
        );
      })()}

      {/* 新建 / 重命名 输入弹窗 */}
      {branchInput && (
        <div className="git-confirm-overlay" onClick={() => !branchOpBusy && setBranchInput(null)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-confirm-title">
              {branchInput.mode === "create" ? "新建分支" : "重命名分支"}
            </div>
            <div className="git-confirm-desc">
              {branchInput.mode === "create" ? (
                <>基于 <b>{branchInput.branch.name}</b> 创建并切换到新分支：</>
              ) : (
                <>将 <b>{branchInput.branch.name}</b> 重命名为：</>
              )}
            </div>
            <input
              className="branch-input-field"
              autoFocus
              value={branchInput.value}
              placeholder="输入分支名"
              onChange={(e) => setBranchInput({ ...branchInput, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void submitBranchInput(); }
                if (e.key === "Escape") setBranchInput(null);
              }}
            />
            <div className="git-confirm-actions">
              <button className="git-btn cancel" disabled={branchOpBusy} onClick={() => setBranchInput(null)}>取消</button>
              <button
                className="git-btn continue"
                disabled={branchOpBusy || !branchInput.value.trim()}
                onClick={() => void submitBranchInput()}
              >
                {branchOpBusy ? "处理中…" : branchInput.mode === "create" ? "创建并切换" : "重命名"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除 / 合并 确认弹窗 */}
      {branchConfirm && (
        <div className="git-confirm-overlay" onClick={() => !branchOpBusy && setBranchConfirm(null)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            {branchConfirm.mode === "delete" ? (
              <>
                <div className="git-confirm-title">
                  {branchConfirm.needForce
                    ? "强制删除未合并分支？"
                    : branchConfirm.branch.isRemote
                      ? "删除远程分支？"
                      : "删除分支？"}
                </div>
                <div className="git-confirm-desc">
                  {branchConfirm.needForce ? (
                    <>分支 <b>{branchConfirm.branch.name}</b> 存在未合并的提交，强制删除将永久丢失这些提交。</>
                  ) : branchConfirm.branch.isRemote ? (
                    <>将删除远程分支 <b>{branchConfirm.branch.name}</b>，这会直接影响远程仓库，其他人也会受影响。</>
                  ) : (
                    <>将删除本地分支 <b>{branchConfirm.branch.name}</b>。</>
                  )}
                </div>
                <div className="git-confirm-actions">
                  <button className="git-btn cancel" disabled={branchOpBusy} onClick={() => setBranchConfirm(null)}>取消</button>
                  <button
                    className="git-btn danger"
                    disabled={branchOpBusy}
                    onClick={() => void submitBranchConfirm(branchConfirm.needForce)}
                  >
                    {branchOpBusy ? "删除中…" : branchConfirm.needForce ? "强制删除" : "确认删除"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="git-confirm-title">合并分支？</div>
                <div className="git-confirm-desc">
                  将分支 <b>{branchConfirm.branch.name}</b> 合并到当前分支 <b>{currentBranchName ?? "?"}</b>。
                </div>
                <div className="git-confirm-actions">
                  <button className="git-btn cancel" disabled={branchOpBusy} onClick={() => setBranchConfirm(null)}>取消</button>
                  <button className="git-btn continue" disabled={branchOpBusy} onClick={() => void submitBranchConfirm()}>
                    {branchOpBusy ? "合并中…" : "确认合并"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
