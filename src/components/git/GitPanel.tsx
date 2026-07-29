/**
 * GitPanel — Git 变更面板主容器
 * 完整移植自 CLI-Manager 的 GitChangesPanel
 * 功能：Directory/Module 分组、三态复选框、折叠展开、全选/全不选、
 *       未跟踪选中、A文件勾选、丢弃全部、多仓库切换、提交/推送/拉取
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  GitBranch,
  GitCommit,
  GitCommitHorizontal,
  RefreshCw,
  Undo2,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Minus,
  FolderTree,
  Layers,
  FolderGit2,
  Upload,
  Download,
  FilePen,
  FilePlus,
  FileMinus,
  ArrowUp,
  ArrowDown,
  FolderOpen,
  FileText,
  Folder,
  Cloud,
  HardDrive,
} from "lucide-react";
import { DiffViewerModal } from "./DiffViewerModal";
import { FileIcon } from "../../utils/fileIcons";

// 剪贴板复制辅助
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("无法复制到剪切板:", err);
  }
};

// ─────────────────────────── 类型定义 ───────────────────────────

interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
  added: number;
  deleted: number;
}

interface GitBranchStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  detached: boolean;
  pending_op: string | null;
}

interface GitRepoInfo {
  relativePath: string;
  absolutePath: string;
  branch: string | null;
}

// 分支下拉项（复用 git_list_branches，本地 + 远程分组展示，样式对齐分支面板）
interface GitLocalBranch {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream: string | null;
  lastCommit: { timestamp: number } | null;
}

interface GitTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  isModuleRoot?: boolean;
  children: GitTreeNode[];
  change?: GitFileChange;
  fileCount: number;
}

type StageState = "checked" | "unchecked" | "indeterminate";
type GitStatusFilter = "all" | "M" | "A" | "D";
type GroupByMode = "directory" | "module";

interface GitPanelProps {
  projectPath: string;
  onInsertPathToTerminal?: (relativePath: string) => void;
}

// ─────────────────────────── 常量 ───────────────────────────

const STATUS_CONFIG: Record<string, { label: string; symbol: string; tooltip: string; color: string }> = {
  M: { label: "M", symbol: "M", tooltip: "Modified", color: "#60a5fa" },
  A: { label: "A", symbol: "A", tooltip: "Added", color: "#4ade80" },
  D: { label: "D", symbol: "D", tooltip: "Deleted", color: "#f87171" },
  U: { label: "U", symbol: "U", tooltip: "Untracked", color: "#a9b1d6" },
  "??": { label: "?", symbol: "U", tooltip: "Untracked", color: "#a9b1d6" },
  R: { label: "R", symbol: "R", tooltip: "Renamed", color: "#c084fc" },
  C: { label: "C", symbol: "C", tooltip: "Conflict", color: "#db4b4b" },
};

const FALLBACK_POLL_INTERVAL_MS = 15000;

// Git 网络错误码 → 本地化提示
function formatGitError(raw: string): string {
  if (raw.includes("auth_failed")) return "认证失败：请检查用户名/密码或 SSH 密钥";
  if (raw.includes("not_fast_forward")) return "推送被拒绝：远端有新的提交，请先拉取";
  if (raw.includes("no_upstream")) return "未设置上游分支";
  if (raw.includes("no_remote")) return "未配置远程仓库";
  if (raw.includes("pull_conflict")) return "拉取冲突：请解决冲突后继续";
  if (raw.includes("git_not_found")) return "未找到 Git：请确认已安装 Git 并加入 PATH";
  if (raw.includes("no_git_identity")) return "未配置 Git 用户信息：请运行 git config --global user.name/email";
  if (raw.includes("nothing_staged")) return "没有暂存的更改";
  if (raw.includes("empty_message")) return "提交信息不能为空";
  return `Git 操作失败: ${raw.replace(/^[a-z_]+:\s*/, "").slice(0, 200)}`;
}

// ─────────────────────────── 辅助函数 ───────────────────────────

function isUntracked(status: string): boolean {
  return status === "U" || status === "??";
}

// 分支下拉里的相对时间（与 BranchPanel 展示口径一致）
function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${Math.floor(diff / (86400 * 365))} 年前`;
}

const PULL_STRATEGY_LABELS: Record<string, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "ff-only": "FF-only",
};

function collectFileChanges(node: GitTreeNode): GitFileChange[] {
  if (!node.isDir) return node.change ? [node.change] : [];
  return node.children.flatMap(collectFileChanges);
}

// 收集目录下所有目录路径
function collectDirectoryPaths(nodes: GitTreeNode[], treeId: string): string[] {
  const paths: string[] = [];
  const visit = (items: GitTreeNode[]) => {
    for (const node of items) {
      if (!node.isDir) continue;
      paths.push(`${treeId}:${node.path}`);
      visit(node.children ?? []);
    }
  };
  visit(nodes);
  return paths;
}

// JetBrains 风格目录链压缩
function collectCompactDirectoryChain(node: GitTreeNode): { suffixParts: string[]; leaf: GitTreeNode } {
  const suffixParts: string[] = [];
  let leaf = node;

  if (leaf.isDir && leaf.children?.length === 1 && leaf.children[0].isDir && !leaf.children[0].isModuleRoot) {
    let current = leaf.children[0];
    suffixParts.push(current.name);
    leaf = current;

    while (leaf.children?.length === 1 && leaf.children[0].isDir && !leaf.children[0].isModuleRoot) {
      const next = leaf.children[0];
      suffixParts.push(next.name);
      leaf = next;
    }
  }

  return { suffixParts, leaf };
}

// 构建目录树
function buildTree(changes: GitFileChange[], groupBy: GroupByMode): GitTreeNode {
  const root: GitTreeNode = { name: "root", path: "", isDir: true, children: [], fileCount: 0 };
  const dirMap = new Map<string, GitTreeNode>();

  const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));

  for (const change of sorted) {
    const parts = change.path.split("/");
    let current = root;
    let currentPath = "";

    // Module 模式：第一段作为模块根
    const isModuleMode = groupBy === "module" && parts.length > 1;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      // Module 模式下，第一段作为 module root
      if (isModuleMode && i === 0 && !isLast) {
        let moduleNode = dirMap.get("__module__" + part);
        if (!moduleNode) {
          moduleNode = {
            name: part,
            path: currentPath,
            isDir: true,
            isModuleRoot: true,
            children: [],
            fileCount: 0,
          };
          dirMap.set("__module__" + part, moduleNode);
          current.children.push(moduleNode);
        }
        current = moduleNode;
        continue;
      }

      if (isLast) {
        current.children.push({
          name: part,
          path: change.path,
          isDir: false,
          children: [],
          change,
          fileCount: 1,
        });
      } else {
        let dirNode = dirMap.get(currentPath);
        if (!dirNode) {
          dirNode = {
            name: part,
            path: currentPath,
            isDir: true,
            children: [],
            fileCount: 0,
          };
          dirMap.set(currentPath, dirNode);
          current.children.push(dirNode);
        }
        current = dirNode;
      }
    }
  }

  function countFiles(node: GitTreeNode): number {
    if (!node.isDir) return 1;
    node.fileCount = node.children.reduce((sum, child) => sum + countFiles(child), 0);
    return node.fileCount;
  }
  countFiles(root);

  return root;
}

// ─────────────────────────── 三态复选框组件 ───────────────────────────

const StageCheckbox: React.FC<{
  state: StageState;
  onToggle: () => void;
  title?: string;
}> = ({ state, onToggle, title }) => {
  const active = state === "checked" || state === "indeterminate";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "indeterminate" ? "mixed" : state === "checked"}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="git-stage-checkbox"
      style={{
        width: 13,
        height: 13,
        border: `1.5px solid ${active ? "#4ade80" : "var(--text-secondary)"}`,
        backgroundColor: active ? "#4ade80" : "transparent",
        borderRadius: 3,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        opacity: active ? 1 : 0.7,
        transition: "all 0.15s",
      }}
    >
      {state === "checked" && <Check size={9} strokeWidth={3.5} style={{ color: "#1e1e2e" }} />}
      {state === "indeterminate" && <Minus size={9} strokeWidth={3.5} style={{ color: "#1e1e2e" }} />}
    </button>
  );
};

// ─────────────────────────── 树节点组件 ───────────────────────────

const GitTreeNodeRow: React.FC<{
  node: GitTreeNode;
  depth: number;
  treeId: string;
  collapsedDirs: Set<string>;
  selectedUntracked: Set<string>;
  deselectedAdded: Set<string>;
  onToggleDir: (key: string) => void;
  onToggleUntrackedSelection: (paths: string[]) => void;
  onToggleAddedDeselection: (paths: string[]) => void;
  onToggleStage: (filePath: string, staged: boolean) => void;
  onToggleStagePaths: (paths: string[], allStaged: boolean) => void;
  onSetAddedDeselection: (paths: string[], deselected: boolean) => void;
  onFileClick: (filePath: string, status: string) => void;
  onRequestDiscard: (path: string, status: string) => void;
  onContextMenu: (e: React.MouseEvent, filePath: string, isDir: boolean) => void;
  discarding: string | null;
  staging: string | null;
}> = ({
  node,
  depth,
  treeId,
  collapsedDirs,
  selectedUntracked,
  deselectedAdded,
  onToggleDir,
  onToggleUntrackedSelection,
  onToggleAddedDeselection,
  onToggleStage,
  onToggleStagePaths,
  onSetAddedDeselection,
  onFileClick,
  onRequestDiscard,
  onContextMenu,
  discarding,
  staging,
}) => {
  const indentPx = depth * 12 + 8;

  // ── 文件节点 ──
  if (!node.isDir) {
    if (!node.change) return null;
    const change = node.change;
    const config = STATUS_CONFIG[change.status] || STATUS_CONFIG["M"];
    const canDiscard = change.status !== "U" && change.status !== "??";
    const isUntrackedFile = isUntracked(change.status);
    const isAdded = change.status === "A";
    const untrackedSelected = isUntrackedFile && selectedUntracked.has(node.path);
    const addedSelected = isAdded && !deselectedAdded.has(node.path);

    // 三态：未跟踪→选中态，A文件→勾选态，其他→真实暂存态
    const checkboxState: StageState = isUntrackedFile
      ? untrackedSelected
        ? "checked"
        : "unchecked"
      : isAdded
        ? addedSelected
          ? "checked"
          : "unchecked"
        : change.staged
          ? "checked"
          : "unchecked";

    const handleCheckboxToggle = () => {
      if (isUntrackedFile) {
        onToggleUntrackedSelection([node.path]);
      } else if (isAdded) {
        onToggleAddedDeselection([node.path]);
      } else {
        onToggleStage(node.path, change.staged);
      }
    };

    // 文件名颜色
    let fileNameColor = "var(--text-primary)";
    switch (change.status) {
      case "M": fileNameColor = "#60a5fa"; break;
      case "A": fileNameColor = "#4ade80"; break;
      case "D": fileNameColor = "#808080"; break;
      case "U": case "??": fileNameColor = "#f87171"; break;
      case "R": fileNameColor = "#c084fc"; break;
    }

    return (
      <div
        className="git-file-row"
        style={{ paddingLeft: indentPx }}
        onClick={() => onFileClick(node.path, change.status)}
        onContextMenu={(e) => onContextMenu(e, node.path, false)}
      >
        {/* 占位对齐 */}
        <span style={{ width: 10, flexShrink: 0 }} aria-hidden="true" />
        <StageCheckbox
          state={checkboxState}
          onToggle={handleCheckboxToggle}
          title={
            isUntrackedFile
              ? "选中以在提交时包含"
              : isAdded
                ? addedSelected
                  ? "取消勾选（仍保持跟踪）"
                  : "勾选以包含在本次提交"
                : change.staged
                  ? "取消暂存"
                  : "暂存"
          }
        />
        <FileIcon name={node.name} size={12} className="git-file-icon" />
        <span className="git-file-name" style={{ color: fileNameColor }}>{node.name}</span>
        {canDiscard && (
          <button
            className="git-discard-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (discarding !== node.path) onRequestDiscard(node.path, change.status);
            }}
            title="丢弃更改"
          >
            <Undo2 size={11} />
          </button>
        )}
        {/* 行统计 */}
        {change.added > 0 && <span className="git-line-stats plus">+{change.added}</span>}
        {change.deleted > 0 && <span className="git-line-stats minus">-{change.deleted}</span>}
        {/* 状态徽章 */}
        <span className="status-badge" style={{ color: config.color, background: config.color + "20" }} title={config.tooltip}>
          {config.symbol}
        </span>
      </div>
    );
  }

  // ── 目录节点 ──
  const isModuleRoot = node.isModuleRoot === true;
  const { suffixParts, leaf: displayNode } = isModuleRoot
    ? { suffixParts: [], leaf: node }
    : collectCompactDirectoryChain(node);
  const displayCollapseKey = `${treeId}:${displayNode.path}`;
  const displayCollapsed = collapsedDirs.has(displayCollapseKey);
  const hasChildren = displayNode.children && displayNode.children.length > 0;
  const dirFiles = collectFileChanges(displayNode);

  // 目录级三态计算
  const dirAllUntracked = dirFiles.length > 0 && dirFiles.every((f) => isUntracked(f.status));
  const dirSelectedCount = dirAllUntracked
    ? dirFiles.filter((f) => selectedUntracked.has(f.path)).length
    : 0;
  const dirUntrackedState: StageState =
    dirSelectedCount === 0 ? "unchecked" : dirSelectedCount === dirFiles.length ? "checked" : "indeterminate";

  const dirModFiles = dirFiles.filter((f) => !isUntracked(f.status) && f.status !== "A");
  const dirAddedFiles = dirFiles.filter((f) => f.status === "A");
  const dirCheckedCount =
    dirModFiles.filter((f) => f.staged).length +
    dirAddedFiles.filter((f) => !deselectedAdded.has(f.path)).length;
  const dirTrackedState: StageState =
    dirCheckedCount === 0 ? "unchecked" : dirCheckedCount === dirFiles.length ? "checked" : "indeterminate";

  const dirState: StageState = dirAllUntracked ? dirUntrackedState : dirTrackedState;

  const handleDirToggle = () => {
    if (dirFiles.length === 0) return;
    if (dirAllUntracked) {
      // 切换：全选中→全取消，否则全选中
      onToggleUntrackedSelection(dirFiles.map((f) => f.path));
      return;
    }
    const makeChecked = dirTrackedState !== "checked";
    if (dirModFiles.length > 0) {
      onToggleStagePaths(dirModFiles.map((f) => f.path), !makeChecked);
    }
    if (dirAddedFiles.length > 0) {
      onSetAddedDeselection(dirAddedFiles.map((f) => f.path), !makeChecked);
    }
  };

  return (
    <div>
      <div
        className="git-dir-row"
        style={{
          paddingLeft: indentPx,
          fontWeight: isModuleRoot ? 600 : 500,
        }}
        onClick={() => onToggleDir(displayCollapseKey)}
        onContextMenu={(e) => onContextMenu(e, displayNode.path, true)}
      >
        <span
          style={{
            transform: displayCollapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 0.15s",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <ChevronRight size={10} strokeWidth={2} />
        </span>
        {dirFiles.length > 0 && (
          <StageCheckbox
            state={dirState}
            onToggle={handleDirToggle}
            title={
              dirAllUntracked
                ? "选中以在提交时包含"
                : dirState === "checked"
                  ? "取消全选"
                  : "全选"
            }
          />
        )}
        {displayCollapsed ? (
          <Folder size={13} className="git-dir-folder-icon" />
        ) : (
          <FolderOpen size={13} className="git-dir-folder-icon" />
        )}
        <span className="git-dir-name">{node.name}</span>
        {suffixParts.length > 0 && (
          <span className="git-dir-suffix">/{suffixParts.join("/")}</span>
        )}
        {hasChildren && (
          <span className="git-dir-count">{displayNode.children!.length}</span>
        )}
      </div>
      {!displayCollapsed && hasChildren && (
        <div>
          {[...displayNode.children!]
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <GitTreeNodeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                treeId={treeId}
                collapsedDirs={collapsedDirs}
                selectedUntracked={selectedUntracked}
                deselectedAdded={deselectedAdded}
                onToggleDir={onToggleDir}
                onToggleUntrackedSelection={onToggleUntrackedSelection}
                onToggleAddedDeselection={onToggleAddedDeselection}
                onToggleStage={onToggleStage}
                onToggleStagePaths={onToggleStagePaths}
                onSetAddedDeselection={onSetAddedDeselection}
                onFileClick={onFileClick}
                onRequestDiscard={onRequestDiscard}
                onContextMenu={onContextMenu}
                discarding={discarding}
                staging={staging}
              />
            ))}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────── 主组件 ───────────────────────────

export const GitPanel: React.FC<GitPanelProps> = ({ projectPath, onInsertPathToTerminal }) => {
  // ── 状态 ──
  const [changes, setChanges] = useState<GitFileChange[]>([]);
  const [branchStatus, setBranchStatus] = useState<GitBranchStatus | null>(null);
  const [repositories, setRepositories] = useState<GitRepoInfo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<GitStatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupByMode>("directory");
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [selectedUntracked, setSelectedUntracked] = useState<Set<string>>(new Set());
  const [deselectedAdded, setDeselectedAdded] = useState<Set<string>>(new Set());

  const [discarding, setDiscarding] = useState<string | null>(null);
  const [staging, setStaging] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [fetching, setFetching] = useState(false);

  // 底部状态行：分支下拉切换 / 提交模式分裂按钮 / 无上游推送确认
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchList, setBranchList] = useState<GitLocalBranch[]>([]);
  const [branchFilter, setBranchFilter] = useState("");
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [commitMode, setCommitMode] = useState<"commit" | "commit-push">(() =>
    localStorage.getItem("kkcoder_git_commit_mode") === "commit-push" ? "commit-push" : "commit"
  );
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [pushConfirm, setPushConfirm] = useState(false);
  const [pullStrategy, setPullStrategy] = useState<string>(
    () => localStorage.getItem("kkcoder_git_pull_strategy") || "merge"
  );

  const [commitMsg, setCommitMsg] = useState("");
  const [diffFile, setDiffFile] = useState<{ path: string; status: string } | null>(null);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{ path: string; status: string } | null>(null);

  const [groupByMenuOpen, setGroupByMenuOpen] = useState(false);
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [hideFilterLabels, setHideFilterLabels] = useState(false);
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const [pullMenuOpen, setPullMenuOpen] = useState(false);
  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filePath: string; isDir: boolean } | null>(null);

  const projectPathRef = useRef(projectPath);
  const loadingRef = useRef(false);

  // ── 计算属性 ──
  const repoPath = activeRepoPath ?? projectPath;
  const activeRepo = activeRepoPath ? repositories.find((r) => r.absolutePath === activeRepoPath) : null;
  const rootRepoLabel = projectPath?.split(/[\\/]/).filter(Boolean).pop() || "根仓库";
  const activeRepoLabel = activeRepo?.relativePath || rootRepoLabel;

  const allCount = changes.length;
  const modifiedCount = changes.filter((c) => c.status === "M").length;
  const addedCount = changes.filter((c) => c.status === "A" || isUntracked(c.status)).length;
  const deletedCount = changes.filter((c) => c.status === "D").length;
  const trackableCount = changes.filter((c) => !isUntracked(c.status)).length;
  const totalAdded = changes.reduce((sum, c) => sum + (c.added || 0), 0);
  const totalDeleted = changes.reduce((sum, c) => sum + (c.deleted || 0), 0);
  const stagedCount = changes.filter((c) => c.staged).length;
  const deselectedAddedCount = changes.filter((c) => c.status === "A" && deselectedAdded.has(c.path)).length;
  const selectedUntrackedCount = selectedUntracked.size;
  const committableCount = stagedCount - deselectedAddedCount + selectedUntrackedCount;

  // 过滤：已跟踪文件按状态筛选；未跟踪文件仅在 M/D 筛选时隐藏（与原始项目一致）
  const filteredChanges = useMemo(() => {
    if (statusFilter === "all") return changes;
    // M/D 筛选：只显示对应状态的已跟踪文件，隐藏未跟踪
    if (statusFilter === "M" || statusFilter === "D") {
      return changes.filter((c) => c.status === statusFilter);
    }
    // A 筛选：显示 A 文件 + 所有未跟踪文件（U/??）
    return changes.filter((c) => c.status === "A" || isUntracked(c.status));
  }, [changes, statusFilter]);

  const trackedChanges = filteredChanges.filter((c) => !isUntracked(c.status));
  const untrackedChanges = filteredChanges.filter((c) => isUntracked(c.status));

  // 构建树
  const tree = useMemo(() => buildTree(trackedChanges, groupBy), [trackedChanges, groupBy]);
  const untrackedTree = useMemo(() => buildTree(untrackedChanges, groupBy), [untrackedChanges, groupBy]);

  // 是否有目录
  const hasDirectories = useMemo(() => {
    const check = (nodes: GitTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.isDir && node.children.length > 0) return true;
      }
      return false;
    };
    return check(tree.children) || check(untrackedTree.children);
  }, [tree, untrackedTree]);

  // 全选三态
  const selectAllState: StageState =
    changes.length === 0 || committableCount === 0
      ? "unchecked"
      : committableCount >= changes.length
        ? "checked"
        : "indeterminate";

  // 路径分组
  const allUntrackedPaths = changes.filter((c) => isUntracked(c.status)).map((c) => c.path);
  const addedPaths = changes.filter((c) => c.status === "A").map((c) => c.path);
  const trackedModPaths = changes.filter((c) => !isUntracked(c.status) && c.status !== "A").map((c) => c.path);

  // 冲突检测
  const hasConflicts = changes.some((c) => c.status === "C");
  const pendingOp = branchStatus?.pending_op ?? null;

  // ── 数据获取 ──
  const fetchChanges = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    const requestProjectPath = repoPath; // 捕获当前路径用于竞态守卫
    loadingRef.current = true;
    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await invoke<GitFileChange[]>("git_get_changes", { projectPath: requestProjectPath });
      // 竞态守卫：请求期间项目/仓库已切换 → 丢弃过期结果
      if (projectPathRef.current !== projectPath || repoPath !== requestProjectPath) return;
      setChanges(result);
      // 裁剪选中集合
      const untrackedNow = new Set(result.filter((c) => isUntracked(c.status)).map((c) => c.path));
      setSelectedUntracked((prev) => new Set([...prev].filter((p) => untrackedNow.has(p))));
      const addedNow = new Set(result.filter((c) => c.status === "A").map((c) => c.path));
      setDeselectedAdded((prev) => new Set([...prev].filter((p) => addedNow.has(p))));
    } catch (e) {
      // 竞态守卫：请求期间项目/仓库已切换 → 丢弃过期错误
      if (projectPathRef.current !== projectPath || repoPath !== requestProjectPath) return;
      const msg = String(e);
      if (!silent) {
        if (!msg.includes("不是 Git 仓库")) {
          setError(msg);
        }
        setChanges([]);
      }
    } finally {
      loadingRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [repoPath, projectPath]);

  const fetchBranchStatus = useCallback(async () => {
    const requestProjectPath = repoPath;
    try {
      const result = await invoke<GitBranchStatus>("git_branch_status", { projectPath: requestProjectPath });
      // 竞态守卫
      if (projectPathRef.current !== projectPath || repoPath !== requestProjectPath) return;
      setBranchStatus(result);
    } catch {
      if (projectPathRef.current !== projectPath || repoPath !== requestProjectPath) return;
      setBranchStatus(null);
    }
  }, [repoPath, projectPath]);

  const fetchRepositories = useCallback(async () => {
    try {
      const result = await invoke<GitRepoInfo[]>("git_list_repositories", { projectPath });
      setRepositories(result);
    } catch {
      setRepositories([]);
    }
  }, [projectPath]);

  const refresh = useCallback(async () => {
    await Promise.all([fetchChanges(false), fetchBranchStatus(), fetchRepositories()]);
  }, [fetchChanges, fetchBranchStatus, fetchRepositories]);

  // 初始加载 + 项目切换（仅依赖 projectPath，避免 refresh 引用变化导致循环重置）
  useEffect(() => {
    projectPathRef.current = projectPath;
    setActiveRepoPath(null);
    setSelectedUntracked(new Set());
    setDeselectedAdded(new Set());
    fetchChanges(false);
    fetchBranchStatus();
    fetchRepositories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // fs-watcher
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const setupWatcher = async () => {
      try {
        await invoke("git_watch_start", { projectPath: repoPath });
        const window = await getCurrentWindow();
        unlisten = await window.listen<{ projectPath: string }>("git-changed", (event) => {
          if (event.payload.projectPath === repoPath) {
            fetchChanges(true);
            fetchBranchStatus();
          }
        });
      } catch {
        intervalId = setInterval(() => {
          fetchChanges(true);
          fetchBranchStatus();
        }, FALLBACK_POLL_INTERVAL_MS);
        unlisten = () => { if (intervalId) clearInterval(intervalId); };
      }
    };

    setupWatcher();

    return () => {
      if (unlisten) unlisten();
      invoke("git_watch_stop").catch(() => {});
    };
  }, [repoPath, fetchChanges, fetchBranchStatus]);

  // 焦点刷新：窗口活跃且可见时才刷新
  useEffect(() => {
    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const handleFocus = () => {
      if (isActive()) {
        fetchChanges(true);
        fetchBranchStatus();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchChanges(true);
        fetchBranchStatus();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchChanges, fetchBranchStatus]);

  // 过滤栏 ResizeObserver：窄面板时隐藏文字标签
  useEffect(() => {
    const filterRow = filterRowRef.current;
    if (!filterRow) return;

    const updateLabelVisibility = (width: number) => {
      setHideFilterLabels(width < 260);
    };

    updateLabelVisibility(filterRow.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLabelVisibility(entry.contentRect.width);
    });
    observer.observe(filterRow);

    return () => observer.disconnect();
  }, [changes.length]);

  // 仓库切换后自动刷新变更列表与分支状态
  const prevActiveRepoPath = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveRepoPath.current !== activeRepoPath && projectPath) {
      prevActiveRepoPath.current = activeRepoPath;
      fetchChanges(true);
      fetchBranchStatus();
    }
  }, [activeRepoPath, projectPath, fetchChanges, fetchBranchStatus]);


  // ── 用户操作 ──

  // 右键菜单
  const handleContextMenu = (e: React.MouseEvent, filePath: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, filePath, isDir });
  };

  const closeContextMenu = () => setCtxMenu(null);

  const handleAddToConversation = () => {
    if (ctxMenu && onInsertPathToTerminal) {
      onInsertPathToTerminal(ctxMenu.filePath);
    }
    closeContextMenu();
  };

  const handleOpenInFileManager = () => {
    if (ctxMenu) {
      const separator = projectPath.endsWith("/") || projectPath.endsWith("\\") ? "" : "/";
      const absolutePath = `${projectPath}${separator}${ctxMenu.filePath}`;
      invoke("open_in_file_manager", { path: absolutePath })
        .catch(err => console.error("在文件管理器中打开失败:", err));
    }
    closeContextMenu();
  };

  const handleCopyAbsolutePath = () => {
    if (ctxMenu) {
      const separator = projectPath.endsWith("/") || projectPath.endsWith("\\") ? "" : "/";
      const absolutePath = `${projectPath}${separator}${ctxMenu.filePath}`;
      copyToClipboard(absolutePath);
    }
    closeContextMenu();
  };

  const handleGroupByChange = (mode: GroupByMode) => {
    setGroupByMenuOpen(false);
    setGroupBy(mode);
  };

  const handleToggleSelectAll = () => {
    if (selectAllState === "checked") {
      // 全部取消：取消暂存 M/D/R + 清空未跟踪选中 + 取消勾选全部 A
      if (trackedModPaths.length > 0) {
        void invoke("git_unstage_paths", { projectPath: repoPath, paths: trackedModPaths })
          .then(() => refresh())
          .catch(() => {});
      }
      setSelectedUntracked(new Set());
      if (addedPaths.length > 0) {
        setDeselectedAdded(new Set(addedPaths));
      }
    } else {
      // 全选：暂存 M/D/R + 选中全部未跟踪 + 勾选回全部 A
      if (trackedModPaths.length > 0) {
        void invoke("git_stage_paths", { projectPath: repoPath, paths: trackedModPaths })
          .then(() => refresh())
          .catch(() => {});
      }
      if (allUntrackedPaths.length > 0) {
        setSelectedUntracked(new Set(allUntrackedPaths));
      }
      if (addedPaths.length > 0) {
        setDeselectedAdded(new Set());
      }
    }
  };

  const handleToggleStage = (filePath: string, currentlyStaged: boolean) => {
    setStaging(filePath);
    invoke(currentlyStaged ? "git_unstage_file" : "git_stage_file", { projectPath: repoPath, filePath })
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setStaging(null));
  };

  const handleToggleStagePaths = (paths: string[], allStaged: boolean) => {
    setStaging("*");
    invoke(allStaged ? "git_unstage_paths" : "git_stage_paths", { projectPath: repoPath, paths })
      .then(() => refresh())
      .catch(() => {})
      .finally(() => setStaging(null));
  };

  const handleDiscardFile = async (filePath: string, status: string) => {
    setDiscarding(filePath);
    try {
      await invoke("git_discard_file", { projectPath: repoPath, filePath, status });
      await refresh();
    } catch (e) {
      console.error("丢弃失败:", e);
    } finally {
      setDiscarding(null);
    }
  };

  const handleDiscardAll = async () => {
    setConfirmDiscardAll(false);
    setDiscarding("*");
    try {
      for (const change of changes) {
        if (!isUntracked(change.status)) {
          await invoke("git_discard_file", { projectPath: repoPath, filePath: change.path, status: change.status });
        }
      }
      await refresh();
    } catch (e) {
      console.error("全部丢弃失败:", e);
    } finally {
      setDiscarding(null);
    }
  };

  const handleCommit = async (): Promise<boolean> => {
    const msg = commitMsg.trim();
    if (!msg || committableCount === 0 || committing) return false;
    setCommitting(true);
    try {
      // 先暂存选中的未跟踪文件
      if (selectedUntracked.size > 0) {
        await invoke("git_stage_paths", {
          projectPath: repoPath,
          paths: Array.from(selectedUntracked),
        });
      }
      // 如果有取消勾选的 A 文件，走 pathspec 提交
      if (deselectedAddedCount > 0) {
        const pathsToCommit = changes
          .filter((c) => !deselectedAdded.has(c.path) && (c.staged || isUntracked(c.status)))
          .map((c) => c.path);
        await invoke("git_commit_paths", { projectPath: repoPath, message: msg, paths: pathsToCommit });
      } else {
        await invoke("git_commit", { projectPath: repoPath, message: msg });
      }
      setCommitMsg("");
      setSelectedUntracked(new Set());
      setDeselectedAdded(new Set());
      await refresh();
      return true;
    } catch (e) {
      console.error("提交失败:", e);
      setError(formatGitError(String(e)));
      return false;
    } finally {
      setCommitting(false);
    }
  };

  const doPush = async () => {
    setPushing(true);
    try {
      const upstream = branchStatus?.has_upstream;
      await invoke("git_push", {
        projectPath: repoPath,
        setUpstream: !upstream,
        branch: branchStatus?.branch ?? null,
      });
      await refresh();
    } catch (e) {
      console.error("推送失败:", e);
      setError(formatGitError(String(e)));
    } finally {
      setPushing(false);
    }
  };

  // 无上游分支时先弹确认（将执行 push -u origin，需用户知情推送目标）
  const requestPush = () => {
    if (pushing || committing) return;
    if (branchStatus && !branchStatus.has_upstream && branchStatus.branch) {
      setPushConfirm(true);
    } else {
      void doPush();
    }
  };

  // 提交主按钮：按记忆模式执行 提交 / 提交并推送
  const runCommitAction = async () => {
    const ok = await handleCommit();
    if (ok && commitMode === "commit-push") {
      requestPush();
    }
  };

  const handleFetch = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      await invoke("git_fetch", { projectPath: repoPath });
      await Promise.all([fetchChanges(true), fetchBranchStatus()]);
    } catch (e) {
      console.error("获取更新失败:", e);
      setError(formatGitError(String(e)));
    } finally {
      setFetching(false);
    }
  };

  // 打开分支下拉时懒加载分支列表（本地 + 远程，过滤掉 origin/HEAD 指针）
  const handleOpenBranchMenu = async () => {
    if (branchMenuOpen) {
      setBranchMenuOpen(false);
      return;
    }
    setBranchFilter("");
    setBranchMenuOpen(true);
    try {
      const list = await invoke<GitLocalBranch[]>("git_list_branches", { projectPath: repoPath });
      setBranchList(list.filter((b) => !b.name.endsWith("/HEAD")));
    } catch {
      setBranchList([]);
    }
  };

  const handleCheckoutBranch = async (name: string, isCurrent: boolean, isRemote: boolean) => {
    setBranchMenuOpen(false);
    if (isCurrent || switchingBranch) return;
    setSwitchingBranch(true);
    try {
      await invoke("git_checkout_branch", { projectPath: repoPath, branch: name, isRemote });
      await refresh();
    } catch (e) {
      const msg = String(e);
      let friendly = msg;
      if (msg.includes("would be overwritten") || msg.includes("local changes")) {
        friendly = "切换失败：工作区有未提交的更改，请先提交或暂存";
      } else if (msg.startsWith("git_failed:")) {
        friendly = msg.replace(/^git_failed:\s*/, "").slice(0, 200);
      }
      setError(friendly);
    } finally {
      setSwitchingBranch(false);
    }
  };

  const handlePull = async (strategy: string) => {
    setPullMenuOpen(false);
    setPullStrategy(strategy);
    localStorage.setItem("kkcoder_git_pull_strategy", strategy);
    setPulling(true);
    try {
      await invoke("git_pull", { projectPath: repoPath, strategy });
      await refresh();
    } catch (e) {
      const msg = String(e);
      console.error("拉取失败:", e);
      // 冲突时刷新以显示冲突横幅
      if (msg.includes("pull_conflict")) {
        await refresh();
      }
      setError(formatGitError(msg));
    } finally {
      setPulling(false);
    }
  };

  const handleToggleDir = (key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const collapseAllDirs = () => {
    const allDirPaths = [
      ...collectDirectoryPaths(tree.children, "tracked"),
      ...collectDirectoryPaths(untrackedTree.children, "untracked"),
    ];
    setCollapsedDirs(new Set(allDirPaths));
  };

  const expandAllDirs = () => {
    setCollapsedDirs(new Set());
  };

  const allCollapsed = useMemo(() => {
    const allDirPaths = [
      ...collectDirectoryPaths(tree.children, "tracked"),
      ...collectDirectoryPaths(untrackedTree.children, "untracked"),
    ];
    return allDirPaths.length > 0 && allDirPaths.every((p) => collapsedDirs.has(p));
  }, [collapsedDirs, tree, untrackedTree]);

  const handleFileClick = (filePath: string, status: string) => {
    setDiffFile({ path: filePath, status });
  };

  // ── 渲染 ──

  const FILTER_LABELS: Record<GitStatusFilter, string> = {
    all: "全部",
    M: "修改",
    A: "新增",
    D: "删除",
  };

  const filterButtons: { value: GitStatusFilter; count: number; color: string; icon: React.FC<{ size?: number; color?: string }> }[] = [
    { value: "all", count: allCount, color: "var(--text-primary)", icon: FileText },
    { value: "M", count: modifiedCount, color: "#60a5fa", icon: FilePen },
    { value: "A", count: addedCount, color: "#4ade80", icon: FilePlus },
    { value: "D", count: deletedCount, color: "#f87171", icon: FileMinus },
  ];

  return (
    <div className="git-panel">
      {/* ── Header ── */}
      <div className="git-header">
        <div className="git-header-row1">
          <span className="git-title">
            <GitCommit size={13} />
            提交
          </span>
          <div className="git-header-actions">
            {/* Group By 切换 */}
            <div className="git-dropdown-wrapper">
              <button
                className="git-action-btn git-groupby-btn"
                onClick={() => setGroupByMenuOpen(!groupByMenuOpen)}
                title="分组方式"
              >
                {groupBy === "module" ? <Layers size={10} /> : <FolderTree size={10} />}
                <ChevronDown size={8} />
              </button>
              {groupByMenuOpen && (
                <>
                  <div className="git-dropdown-overlay" onClick={() => setGroupByMenuOpen(false)} />
                  <div className="git-dropdown-menu">
                    <button
                      className={`git-dropdown-item ${groupBy === "directory" ? "active" : ""}`}
                      onClick={() => handleGroupByChange("directory")}
                    >
                      <FolderTree size={12} />
                      <span>Directory</span>
                      {groupBy === "directory" && <Check size={11} />}
                    </button>
                    <button
                      className={`git-dropdown-item ${groupBy === "module" ? "active" : ""}`}
                      onClick={() => handleGroupByChange("module")}
                    >
                      <Layers size={12} />
                      <span>Module</span>
                      {groupBy === "module" && <Check size={11} />}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* 全选三态复选框 */}
            {changes.length > 0 && (
              <StageCheckbox
                state={selectAllState}
                onToggle={handleToggleSelectAll}
                title={selectAllState === "checked" ? "取消全选" : "全选"}
              />
            )}

            {/* 折叠/展开全部 */}
            {hasDirectories && (
              <button
                className="git-action-btn"
                onClick={allCollapsed ? expandAllDirs : collapseAllDirs}
                title={allCollapsed ? "展开全部" : "折叠全部"}
              >
                {allCollapsed ? "展开" : "折叠"}
              </button>
            )}

            {/* 丢弃全部 */}
            {trackableCount > 0 && (
              <button
                className="git-action-btn git-discard-all-btn"
                onClick={() => setConfirmDiscardAll(true)}
                disabled={discarding === "*"}
                title="丢弃全部已跟踪文件的更改"
              >
                <Undo2 size={11} />
              </button>
            )}

            {/* 刷新 */}
            <button
              className={`git-action-btn ${loading ? "spinning" : ""}`}
              onClick={() => refresh()}
              title="刷新"
            >
              <RefreshCw size={11} />
            </button>
          </div>
        </div>

        {/* 过滤栏 */}
        {changes.length > 0 && (
          <div className="git-filters" ref={filterRowRef}>
            {filterButtons.map((btn) => {
              const Icon = btn.icon;
              const active = statusFilter === btn.value;
              const label = FILTER_LABELS[btn.value];
              return (
                <button
                  key={btn.value}
                  className={`git-filter-btn ${active ? "active" : ""}`}
                  onClick={() => setStatusFilter(btn.value)}
                  title={`${label} ${btn.count}`}
                  style={{
                    backgroundColor: active ? btn.color + "30" : "transparent",
                    color: active ? btn.color : "var(--text-secondary)",
                    border: active ? `1px solid ${btn.color}` : "1px solid transparent",
                  }}
                >
                  <Icon size={11} color={btn.color} />
                  {!hideFilterLabels && <span>{label}</span>}
                  <span className="filter-count">{btn.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 仓库切换 ── */}
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
                  const selected = isRoot ? activeRepoPath === null : activeRepoPath === repo.absolutePath;
                  const label = isRoot ? projectPath.split(/[\\/]/).filter(Boolean).pop() || "根仓库" : repo.relativePath;
                  return (
                    <button
                      key={repo.absolutePath}
                      className={`git-dropdown-item ${selected ? "active" : ""}`}
                      onClick={() => {
                        setRepoMenuOpen(false);
                        setActiveRepoPath(isRoot ? null : repo.absolutePath);
                        setSelectedUntracked(new Set());
                        setDeselectedAdded(new Set());
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

      {/* ── 摘要（格式参考原始项目：N 个文件 · n 修改 · n 新增 · n 删除 · +added -deleted） ── */}
      {changes.length > 0 && (
        <div className="git-summary">
          <span style={{ color: "var(--text-primary)" }}>{allCount} 个文件</span>
          {modifiedCount > 0 && (
            <>
              <span className="sep"> · </span>
              <span className="count-mod">{modifiedCount} 修改</span>
            </>
          )}
          {addedCount > 0 && (
            <>
              <span className="sep"> · </span>
              <span className="count-add">{addedCount} 新增</span>
            </>
          )}
          {deletedCount > 0 && (
            <>
              <span className="sep"> · </span>
              <span className="count-del">{deletedCount} 删除</span>
            </>
          )}
          {(totalAdded > 0 || totalDeleted > 0) && (
            <>
              <span className="sep"> · </span>
              {totalAdded > 0 && <span className="add">+{totalAdded}</span>}
              {totalAdded > 0 && totalDeleted > 0 && " "}
              {totalDeleted > 0 && <span className="del">-{totalDeleted}</span>}
            </>
          )}
        </div>
      )}

      {/* ── 树内容 ── */}
      <div className="git-body">
        {loading && changes.length === 0 ? (
          <div className="git-loading">加载中...</div>
        ) : error ? (
          <div className="git-error">{error}</div>
        ) : changes.length === 0 ? (
          <div className="git-empty">无文件变更</div>
        ) : (
          <>
            {tree.children.length > 0 && (
              <div>
                <div className="git-section-label">
                  <span className="dot" />
                  改动
                </div>
                {tree.children.map((node) => (
                  <GitTreeNodeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    treeId="tracked"
                    collapsedDirs={collapsedDirs}
                    selectedUntracked={selectedUntracked}
                    deselectedAdded={deselectedAdded}
                    onToggleDir={handleToggleDir}
                    onToggleUntrackedSelection={(paths) => {
                      setSelectedUntracked((prev) => {
                        const next = new Set(prev);
                        const allSelected = paths.every((p) => next.has(p));
                        if (allSelected) {
                          paths.forEach((p) => next.delete(p));
                        } else {
                          paths.forEach((p) => next.add(p));
                        }
                        return next;
                      });
                    }}
                    onToggleAddedDeselection={(paths) => {
                      setDeselectedAdded((prev) => {
                        const next = new Set(prev);
                        const allDeselected = paths.every((p) => next.has(p));
                        if (allDeselected) {
                          paths.forEach((p) => next.delete(p));
                        } else {
                          paths.forEach((p) => next.add(p));
                        }
                        return next;
                      });
                    }}
                    onToggleStage={handleToggleStage}
                    onToggleStagePaths={handleToggleStagePaths}
                    onSetAddedDeselection={(paths, deselected) => {
                      setDeselectedAdded((prev) => {
                        const next = new Set(prev);
                        if (deselected) {
                          paths.forEach((p) => next.add(p));
                        } else {
                          paths.forEach((p) => next.delete(p));
                        }
                        return next;
                      });
                    }}
                    onFileClick={handleFileClick}
                    onRequestDiscard={(path, status) => setDiscardTarget({ path, status })}
                    onContextMenu={handleContextMenu}
                    discarding={discarding}
                    staging={staging}
                  />
                ))}
              </div>
            )}
            {untrackedTree.children.length > 0 && statusFilter !== "M" && statusFilter !== "D" && (
              <div className={tree.children.length > 0 ? "git-untracked-section" : ""}>
                <div className="git-section-label untracked">
                  <span className="dot" />
                  未跟踪文件
                </div>
                {untrackedTree.children.map((node) => (
                  <GitTreeNodeRow
                    key={`untracked-${node.path}`}
                    node={node}
                    depth={0}
                    treeId="untracked"
                    collapsedDirs={collapsedDirs}
                    selectedUntracked={selectedUntracked}
                    deselectedAdded={deselectedAdded}
                    onToggleDir={handleToggleDir}
                    onToggleUntrackedSelection={(paths) => {
                      setSelectedUntracked((prev) => {
                        const next = new Set(prev);
                        const allSelected = paths.every((p) => next.has(p));
                        if (allSelected) {
                          paths.forEach((p) => next.delete(p));
                        } else {
                          paths.forEach((p) => next.add(p));
                        }
                        return next;
                      });
                    }}
                    onToggleAddedDeselection={() => {}}
                    onToggleStage={() => {}}
                    onToggleStagePaths={() => {}}
                    onSetAddedDeselection={() => {}}
                    onFileClick={handleFileClick}
                    onRequestDiscard={() => {}}
                    onContextMenu={handleContextMenu}
                    discarding={null}
                    staging={null}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 冲突横幅 ── */}
      {(pendingOp || hasConflicts) && (
        <div className="git-conflict-banner">
          <span className="git-conflict-title">
            <GitBranch size={12} />
            {pendingOp === "rebase" ? "变基进行中" : "合并进行中"}
            {hasConflicts && <span className="git-conflict-hint">· 存在冲突</span>}
          </span>
          <span className="git-conflict-desc">
            {pendingOp === "rebase" ? "解决冲突后继续变基，或中止回到之前状态" : "解决冲突后继续合并，或中止回到之前状态"}
          </span>
          <div className="git-conflict-actions">
            {pendingOp === "rebase" && (
              <button
                className="git-btn continue"
                disabled={pulling || hasConflicts}
                onClick={() => {
                  setPulling(true);
                  invoke("git_rebase_continue", { projectPath: repoPath })
                    .then(() => refresh())
                    .catch(() => {})
                    .finally(() => setPulling(false));
                }}
              >
                <Check size={11} /> 继续
              </button>
            )}
            <button
              className="git-btn abort"
              disabled={pulling}
              onClick={() => {
                setPulling(true);
                invoke("git_pull_abort", { projectPath: repoPath })
                  .then(() => refresh())
                  .catch(() => {})
                  .finally(() => setPulling(false));
              }}
            >
              <X size={11} /> 中止
            </button>
          </div>
        </div>
      )}

      {/* ── 提交区（常驻） ── */}
      <div className="git-commit-bar">
        <textarea
          className="git-commit-input"
          placeholder={
            allCount === 0
              ? "工作区干净，无更改"
              : committableCount > 0
                ? "提交信息 (Ctrl+Enter 提交)"
                : "无待提交文件"
          }
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void runCommitAction();
            }
          }}
          rows={4}
        />
        <div className="git-commit-row">
          <span className="git-commit-count">
            {allCount === 0
              ? "工作区干净"
              : committableCount > 0
                ? `${committableCount} 个文件待提交`
                : "无暂存文件"}
            {selectedUntrackedCount > 0 && (
              <span className="git-commit-untracked">包含 {selectedUntrackedCount} 个未跟踪文件</span>
            )}
          </span>
        </div>
        <div className="git-commit-split git-dropdown-wrapper">
          <button
            className="git-commit-btn main"
            onClick={() => void runCommitAction()}
            disabled={committing || pushing || committableCount === 0 || commitMsg.trim().length === 0}
          >
            <GitCommitHorizontal size={12} />
            {committing
              ? "提交中..."
              : commitMode === "commit-push"
                ? `提交并推送 (${committableCount})`
                : `提交 (${committableCount})`}
          </button>
          <button
            className="git-commit-btn caret"
            onClick={() => setCommitMenuOpen(!commitMenuOpen)}
            disabled={committing}
            title="切换提交方式"
          >
            <ChevronDown size={11} />
          </button>
          {commitMenuOpen && (
            <>
              <div className="git-dropdown-overlay" onClick={() => setCommitMenuOpen(false)} />
              <div className="git-dropdown-menu git-commit-menu">
                <button
                  className={`git-dropdown-item ${commitMode === "commit" ? "active" : ""}`}
                  onClick={() => {
                    setCommitMode("commit");
                    localStorage.setItem("kkcoder_git_commit_mode", "commit");
                    setCommitMenuOpen(false);
                  }}
                >
                  <span>提交</span>
                  {commitMode === "commit" && <Check size={11} />}
                </button>
                <button
                  className={`git-dropdown-item ${commitMode === "commit-push" ? "active" : ""}`}
                  onClick={() => {
                    setCommitMode("commit-push");
                    localStorage.setItem("kkcoder_git_commit_mode", "commit-push");
                    setCommitMenuOpen(false);
                  }}
                >
                  <span>提交并推送</span>
                  {commitMode === "commit-push" && <Check size={11} />}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 底部状态行：分支切换 + 同步图标组（常驻） ── */}
      {branchStatus && (branchStatus.branch || branchStatus.detached) && (
        <div className="git-status-line">
          <div className="git-dropdown-wrapper git-branch-chip-wrapper">
            <button
              className="git-branch-chip"
              onClick={() => void handleOpenBranchMenu()}
              disabled={switchingBranch || branchStatus.detached}
              title={branchStatus.detached ? "detached HEAD" : `${activeRepoLabel}/${branchStatus.branch}（点击切换分支）`}
            >
              <GitBranch size={11} />
              <span className="git-branch-chip-name">
                {switchingBranch ? "切换中..." : branchStatus.detached ? "detached" : branchStatus.branch}
              </span>
              <ChevronDown size={9} />
            </button>
            {branchMenuOpen && (
              <>
                <div className="git-dropdown-overlay" onClick={() => setBranchMenuOpen(false)} />
                <div className="git-dropdown-menu git-branch-menu">
                  <input
                    type="text"
                    className="git-branch-menu-search"
                    placeholder="搜索分支..."
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    autoFocus
                  />
                  <div className="git-branch-menu-list">
                    {(() => {
                      const kw = branchFilter.trim().toLowerCase();
                      const filtered = branchList.filter((b) => !kw || b.name.toLowerCase().includes(kw));
                      const locals = filtered.filter((b) => !b.isRemote);
                      const remotes = filtered.filter((b) => b.isRemote);
                      // 远程按 remote 名分组：origin 置顶，其余字母序（与分支面板一致）
                      const remoteGroups = new Map<string, GitLocalBranch[]>();
                      for (const b of remotes) {
                        const slash = b.name.indexOf("/");
                        const remoteName = slash > 0 ? b.name.slice(0, slash) : "未知";
                        const list = remoteGroups.get(remoteName);
                        if (list) list.push(b);
                        else remoteGroups.set(remoteName, [b]);
                      }
                      const sortedGroups = Array.from(remoteGroups.entries()).sort(([a], [b]) => {
                        if (a === b) return 0;
                        if (a === "origin") return -1;
                        if (b === "origin") return 1;
                        return a.localeCompare(b);
                      });
                      const showRemoteName = sortedGroups.length > 1;
                      const renderItem = (b: GitLocalBranch) => (
                        <button
                          key={b.name}
                          className={`git-dropdown-item git-branch-menu-item ${b.isCurrent ? "active" : ""}`}
                          onClick={() => void handleCheckoutBranch(b.name, b.isCurrent, b.isRemote)}
                          title={b.isRemote ? `检出 ${b.name}（自动创建本地跟踪分支）` : b.name}
                        >
                          <span className="git-branch-menu-check">{b.isCurrent ? <Check size={11} /> : null}</span>
                          <GitBranch size={10} className="git-branch-menu-icon" />
                          <span className="git-branch-menu-name">{b.name}</span>
                          {!b.isRemote && b.upstream && (
                            <span className="git-branch-menu-upstream">→ {b.upstream}</span>
                          )}
                          {b.lastCommit && (
                            <span className="git-branch-menu-time">{formatRelativeTime(b.lastCommit.timestamp)}</span>
                          )}
                        </button>
                      );
                      return (
                        <>
                          <div className="git-branch-menu-group">
                            <HardDrive size={10} className="branch-group-icon" />
                            <span className="git-branch-menu-group-label">本地分支</span>
                            <span className="branch-group-count">{locals.length}</span>
                          </div>
                          {locals.length > 0 ? (
                            locals.map(renderItem)
                          ) : (
                            <div className="git-branch-menu-empty">无本地分支</div>
                          )}
                          {sortedGroups.map(([remoteName, list]) => (
                            <React.Fragment key={remoteName}>
                              <div className="git-branch-menu-group">
                                <Cloud size={10} className="branch-group-icon" />
                                <span className="git-branch-menu-group-label">
                                  远程分支
                                  {showRemoteName && (
                                    <>
                                      <span className="branch-remote-sep">：</span>
                                      <span className="branch-remote-name">{remoteName}</span>
                                    </>
                                  )}
                                </span>
                                <span className="branch-group-count">{list.length}</span>
                              </div>
                              {list.map(renderItem)}
                            </React.Fragment>
                          ))}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </>
            )}
          </div>

          {!branchStatus.detached && branchStatus.has_upstream ? (
            <span className="git-sync-badges">
              <span className={`git-sync-badge ${branchStatus.behind > 0 ? "lit behind" : ""}`}>
                <ArrowDown size={10} />
                {branchStatus.behind}
              </span>
              <span className={`git-sync-badge ${branchStatus.ahead > 0 ? "lit ahead" : ""}`}>
                <ArrowUp size={10} />
                {branchStatus.ahead}
              </span>
            </span>
          ) : !branchStatus.detached ? (
            <span className="branch-no-upstream">无上游</span>
          ) : null}

          <div className="git-sync-icons">
            <button
              className="git-sync-icon-btn"
              onClick={() => void handleFetch()}
              disabled={fetching || pulling || pushing}
              title="从远程获取更新 (Fetch)"
            >
              <Cloud size={13} className={fetching ? "spinning" : ""} />
            </button>
            <div className="git-dropdown-wrapper git-pull-split">
              <button
                className="git-sync-icon-btn"
                onClick={() => void handlePull(pullStrategy)}
                disabled={pulling || fetching || branchStatus.detached || !branchStatus.has_upstream}
                title={`拉取 Pull (${PULL_STRATEGY_LABELS[pullStrategy] || pullStrategy})`}
              >
                <Download size={13} className={pulling ? "spinning" : ""} />
                {branchStatus.behind > 0 && <span className="git-sync-num">{branchStatus.behind}</span>}
              </button>
              <button
                className="git-sync-caret"
                onClick={() => setPullMenuOpen(!pullMenuOpen)}
                disabled={pulling}
                title="拉取策略"
              >
                <ChevronDown size={8} />
              </button>
              {pullMenuOpen && (
                <>
                  <div className="git-dropdown-overlay" onClick={() => setPullMenuOpen(false)} />
                  <div className="git-dropdown-menu pull-menu">
                    <button className="git-dropdown-item" onClick={() => handlePull("merge")}>
                      <span>Merge</span>
                      <span className="git-menu-desc">合并提交</span>
                    </button>
                    <button className="git-dropdown-item" onClick={() => handlePull("rebase")}>
                      <span>Rebase</span>
                      <span className="git-menu-desc">变基</span>
                    </button>
                    <button className="git-dropdown-item" onClick={() => handlePull("ff-only")}>
                      <span>Fast-forward only</span>
                      <span className="git-menu-desc">仅快进</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              className="git-sync-icon-btn"
              onClick={requestPush}
              disabled={pushing || committing || fetching || branchStatus.detached || !branchStatus.branch}
              title={branchStatus.has_upstream ? "推送 (Push)" : "推送并创建上游 (Push -u)"}
            >
              <Upload size={13} className={pushing ? "spinning" : ""} />
              {branchStatus.ahead > 0 && <span className="git-sync-num">{branchStatus.ahead}</span>}
            </button>
          </div>
        </div>
      )}

      {/* ── Diff 弹窗 ── */}
      {diffFile && (
        <DiffViewerModal
          projectPath={repoPath}
          filePath={diffFile.path}
          status={diffFile.status}
          onClose={() => setDiffFile(null)}
          onRequestDiscard={() => {
            handleDiscardFile(diffFile.path, diffFile.status);
            setDiffFile(null);
          }}
        />
      )}

      {/* ── 丢弃确认弹窗 ── */}
      {confirmDiscardAll && (
        <div className="git-confirm-overlay" onClick={() => setConfirmDiscardAll(false)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-confirm-title">确认丢弃全部更改？</div>
            <div className="git-confirm-desc">
              这将丢弃所有 {trackableCount} 个已跟踪文件的未提交更改，操作不可撤销。
            </div>
            <div className="git-confirm-actions">
              <button className="git-btn cancel" onClick={() => setConfirmDiscardAll(false)}>取消</button>
              <button className="git-btn danger" onClick={handleDiscardAll}>确认丢弃</button>
            </div>
          </div>
        </div>
      )}

      {discardTarget && (
        <div className="git-confirm-overlay" onClick={() => setDiscardTarget(null)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-confirm-title">确认丢弃此文件更改？</div>
            <div className="git-confirm-desc">
              将丢弃 {discardTarget.path} 的更改，操作不可撤销。
            </div>
            <div className="git-confirm-actions">
              <button className="git-btn cancel" onClick={() => setDiscardTarget(null)}>取消</button>
              <button className="git-btn danger" onClick={() => {
                handleDiscardFile(discardTarget.path, discardTarget.status);
                setDiscardTarget(null);
              }}>确认丢弃</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 无上游推送确认弹窗 ── */}
      {pushConfirm && (
        <div className="git-confirm-overlay" onClick={() => setPushConfirm(false)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-confirm-title">推送到新的上游分支？</div>
            <div className="git-confirm-desc">
              当前分支 {branchStatus?.branch} 没有上游，将执行 git push -u origin {branchStatus?.branch}。
              若需推送到其他远程（如 fork），请先在终端手动设置上游。
            </div>
            <div className="git-confirm-actions">
              <button className="git-btn cancel" onClick={() => setPushConfirm(false)}>取消</button>
              <button className="git-btn danger" onClick={() => { setPushConfirm(false); void doPush(); }}>确认推送到 origin</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 右键菜单 ── */}
      {ctxMenu && (
        <>
          <div className="git-context-menu-overlay" onClick={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
          <div
            className="git-context-menu"
            style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={handleAddToConversation}>添加到对话</button>
            <div className="menu-divider" />
            <button onClick={handleOpenInFileManager}>在文件管理器中打开</button>
            <button onClick={handleCopyAbsolutePath}>复制绝对路径</button>
          </div>
        </>
      )}
    </div>
  );
};
