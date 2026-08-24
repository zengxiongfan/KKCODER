import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  Loader2,
  Package,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { notifyInfo, notifyWarning } from "../utils/appFeedback";
import { log } from "../utils/log";

export interface GitBranchInfo {
  isGitRepo: boolean;
  currentBranch: string;
  branches: string[];
  remotes: string[];
  hasUpstream: boolean;
  hasRemote: boolean;
  upstreamBranch: string | null;
  hasChanges: boolean;
}

export interface GitPullResult {
  success: boolean;
  output: string;
  summary: string;
  hasConflict: boolean;
  currentBranch: string;
}

interface GitBranchSelectorProps {
  directory: string;
  disabled?: boolean;
  /** 当遇到冲突时，一键发送给 AI 解决冲突（填入输入框或直接投递） */
  onSendAiConflictPrompt?: (prompt: string) => void;
  /** 触发智能提交工作流：发送分析与提交提示词给 AI */
  onTriggerSmartCommit?: (prompt: string) => void;
}

export const GitBranchSelector: React.FC<GitBranchSelectorProps> = ({
  directory,
  disabled = false,
  onSendAiConflictPrompt,
  onTriggerSmartCommit,
}) => {
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [conflictData, setConflictData] = useState<{
    output: string;
    currentBranch: string;
  } | null>(null);
  const [switchBlockData, setSwitchBlockData] = useState<{
    targetBranch: string;
    errorOutput: string;
  } | null>(null);
  const [stashingSwitch, setStashingSwitch] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // 获取分支信息
  const refreshBranchInfo = useCallback(async () => {
    if (!directory) return;
    try {
      const info = await invoke<GitBranchInfo>("get_git_branch_info", {
        cwd: directory,
      });
      setBranchInfo(info);
    } catch (err) {
      log(`[git] failed to get branch info: ${err}`);
      setBranchInfo(null);
    }
  }, [directory]);

  useEffect(() => {
    void refreshBranchInfo();
  }, [refreshBranchInfo]);

  // 当文件树刷新（代码生成/修改/保存完成）时，联动刷新 Git 状态与分支未提交改动检测
  useEffect(() => {
    const handleGlobalRefresh = (event: Event) => {
      const customEvent = event as CustomEvent<{ path?: string }>;
      const targetPath = customEvent.detail?.path;
      if (!targetPath || !directory || targetPath.toLowerCase().startsWith(directory.toLowerCase())) {
        void refreshBranchInfo();
      }
    };
    window.addEventListener("kkcoder-refresh-project-tree", handleGlobalRefresh);
    return () => window.removeEventListener("kkcoder-refresh-project-tree", handleGlobalRefresh);
  }, [directory, refreshBranchInfo]);

  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const updatePosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dropdownWidth = branchInfo?.isGitRepo ? 340 : 300;
    const margin = 8;

    const bottom = window.innerHeight - rect.top + margin;

    // 默认左对齐，但若超出窗口右边界，则右对齐/限制在窗口内，绝不溢出被侧边栏遮挡
    let left = rect.left;
    if (left + dropdownWidth > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - dropdownWidth - margin);
    }

    setDropdownStyle({
      position: "fixed",
      bottom: `${bottom}px`,
      left: `${left}px`,
      zIndex: 99999,
    });
  }, [branchInfo?.isGitRepo]);

  useEffect(() => {
    if (open) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }
  }, [open, updatePosition]);

  // 点击外侧关闭下拉菜单（通过 portal 挂载到 body 时兼容内部点击）
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !(target as Element).closest?.(".branch-dropdown")
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // 禁用时关闭菜单
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const toggle = () => {
    if (disabled) return;
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen) {
      setSearchQuery("");
      void refreshBranchInfo();
    }
  };

  // 初始化 Git 仓库 (git init)
  const handleInitGitRepo = async () => {
    if (!directory || initializing) return;
    setInitializing(true);
    try {
      await invoke("init_git_repo", { cwd: directory });
      notifyInfo("已成功初始化 Git 仓库！");
      setOpen(false);
      void refreshBranchInfo();
    } catch (err) {
      notifyWarning(`初始化 Git 仓库失败: ${err}`);
    } finally {
      setInitializing(false);
    }
  };

  // 切换分支
  const handleSwitchBranch = async (branchName: string) => {
    if (branchName === branchInfo?.currentBranch) {
      setOpen(false);
      return;
    }
    try {
      await invoke("switch_git_branch", {
        branch: branchName,
        cwd: directory,
      });
      notifyInfo(`已切换到分支 ${branchName}`);
      setOpen(false);
      void refreshBranchInfo();
    } catch (err) {
      const msg = String(err);
      if (
        msg.includes("overwritten by checkout") ||
        msg.includes("stash them before you switch") ||
        msg.includes("commit your changes")
      ) {
        setSwitchBlockData({
          targetBranch: branchName,
          errorOutput: msg,
        });
        setOpen(false);
      } else {
        notifyWarning(`切换分支失败: ${msg}`);
      }
    }
  };

  // 暂存未提交改动并切换分支 (git stash push -> git checkout <target>)
  const handleStashAndSwitch = async () => {
    if (!switchBlockData) return;
    setStashingSwitch(true);
    try {
      const res = await invoke<string>("stash_and_switch_git_branch", {
        branch: switchBlockData.targetBranch,
        cwd: directory,
      });
      notifyInfo(res || `已暂存改动并成功切换至分支 ${switchBlockData.targetBranch}`);
      setSwitchBlockData(null);
      void refreshBranchInfo();
    } catch (err) {
      notifyWarning(`暂存并切换失败: ${err}`);
    } finally {
      setStashingSwitch(false);
    }
  };

  // 触发 AI 在切换分支前智能提交
  const handleAiCommitBeforeSwitch = () => {
    if (!switchBlockData) return;
    const target = switchBlockData.targetBranch;
    const prompt = `我准备切换到 Git 分支 \`${target}\`，但当前工作区有未提交的代码修改：

\`\`\`git
${switchBlockData.errorOutput}
\`\`\`

请帮我对当前所有修改文件进行智能分析，生成规范的 Git Commit 提交信息并完成提交。提交完成后请帮我切换到分支 \`${target}\`。`;
    onTriggerSmartCommit?.(prompt);
    setSwitchBlockData(null);
  };

  // 拉取更新 (git pull)
  const handlePullUpdates = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pulling) return;
    setPulling(true);
    try {
      const res = await invoke<GitPullResult>("pull_git_updates", {
        cwd: directory,
      });
      if (res.hasConflict || !res.success) {
        setConflictData({
          output: res.output,
          currentBranch: res.currentBranch || branchInfo?.currentBranch || "当前分支",
        });
        notifyWarning(res.summary || "Git 拉取更新检测到冲突或异常");
      } else {
        notifyInfo(res.summary || "已成功拉取最新代码更新");
        void refreshBranchInfo();
      }
    } catch (err) {
      const errMsg = String(err);
      setConflictData({
        output: errMsg,
        currentBranch: branchInfo?.currentBranch || "当前分支",
      });
      notifyWarning(`Git 拉取失败: ${errMsg}`);
    } finally {
      setPulling(false);
    }
  };

  // 触发 AI 解决冲突
  const handleResolveConflictWithAi = () => {
    if (!conflictData) return;
    const prompt = `我在拉取分支 \`${conflictData.currentBranch}\` 的最新代码时遇到了 Git 冲突 / 异常报错，请帮我分析并解决冲突：

\`\`\`git
${conflictData.output}
\`\`\`

请逐步帮我分析产生冲突的文件，并提供最佳的代码合并与冲突解决指令。`;

    onSendAiConflictPrompt?.(prompt);
    setConflictData(null);
    setOpen(false);
  };

  // 触发 AI 智能分析与规范提交
  const handleSmartCommit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const hasRemote = branchInfo?.hasRemote ?? false;
    const upstream = branchInfo?.upstreamBranch;

    const pushInstruction = hasRemote
      ? `4. **询问推送**：
   - 提交完成后，展示本次提交的 Commit Hash 与变更概览，并**主动询问我是否需要推送到远程仓库${upstream ? ` (${upstream})` : ""}**。`
      : `4. **完成总结**：
   - 本项目为纯本地 Git 仓库（未配置远程源），提交完成后展示本次提交的 Commit Hash 与变更概览即可，无需询问或提示推送到远程。`;

    const prompt = `请帮我对当前工作区未提交的代码进行智能分析与规范提交：

### 📋 执行要求与交互流程：
1. **分析变更**：
   - 检查 \`git status\` 与未暂存 / 已暂存的代码改动（\`git diff\`）；
   - 对本次修改做基本分析与梳理，列出本次提交的核心内容与主要修改点；
2. **安全检查与排除**：
   - 检查是否有**不建议提交的文件**（如本地临时文件、敏感配置/私钥、构建产物、依赖缓存、测试日志等）；若有，请指出并排除；
3. **执行提交**：
   - 根据 Conventional Commits 规范（如 \`feat:\` / \`fix:\` / \`refactor:\` / \`docs:\` 等）生成清晰规范的提交信息，并执行提交；
${pushInstruction}`;

    onTriggerSmartCommit?.(prompt);
    setOpen(false);
  };

  // 未初始化 Git 仓库时的专属状态展示与一键初始化入口
  if (branchInfo && !branchInfo.isGitRepo) {
    return (
      <div className="chat-branch-select" ref={containerRef}>
        <button
          type="button"
          className={`chat-branch-select-btn is-uninit ${open ? "active" : ""} ${disabled ? "is-disabled" : ""}`}
          onClick={toggle}
          disabled={disabled}
          title="当前目录未初始化 Git 仓库 · 点击一键初始化"
        >
          <GitBranch size={12} className="chat-branch-icon is-uninit" />
          <span className="chat-branch-select-label">初始化 Git</span>
          <ChevronDown
            size={11}
            className={`chat-branch-select-chevron ${open ? "is-open" : ""}`}
          />
        </button>

        {open &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="branch-dropdown branch-init-dropdown"
              style={dropdownStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="branch-init-card">
                <div className="branch-init-icon-wrap">
                  <GitBranch size={22} className="branch-init-icon" />
                </div>
                <div className="branch-init-title">未检测到 Git 仓库</div>
                <div className="branch-init-desc">
                  当前项目目录尚未建立版本控制。初始化后即可使用分支管理、代码追踪与智能变更拉取。
                </div>
                <button
                  type="button"
                  className="branch-init-submit-btn"
                  onClick={() => void handleInitGitRepo()}
                  disabled={initializing}
                >
                  {initializing ? (
                    <Loader2 size={13} className="chat-spin-icon" />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  <span>{initializing ? "正在初始化..." : "初始化 Git 仓库 (git init)"}</span>
                </button>
              </div>
            </div>,
            document.body,
          )}
      </div>
    );
  }

  // 加载中或未知
  if (!branchInfo) {
    return null;
  }

  const hasRemote = branchInfo.hasRemote;
  const hasUpstream = branchInfo.hasUpstream;
  const hasChanges = branchInfo.hasChanges;
  const canPull = hasRemote && hasUpstream;

  const pullButtonTitle = !hasRemote
    ? "未配置远程仓库 (No Remote)"
    : !hasUpstream
      ? "当前分支未关联远程上游分支 (No Upstream)"
      : `从 ${branchInfo.upstreamBranch || "远程"} 拉取最新更新 (git pull)`;

  const commitButtonTitle = hasChanges
    ? "智能提交：让 AI 分析当前变更、排除异常文件、生成规范 Commit 并询问推送"
    : "工作区干净，暂无需要提交的代码修改 (Working tree clean)";

  const filteredBranches = (branchInfo.branches || []).filter((b) =>
    b.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <>
      <div className="chat-branch-select" ref={containerRef}>
        <button
          type="button"
          className={`chat-branch-select-btn ${open ? "active" : ""} ${disabled ? "is-disabled" : ""}`}
          onClick={toggle}
          disabled={disabled}
          title={`当前 Git 分支：${branchInfo.currentBranch || "未知"} ${hasUpstream ? `(${branchInfo.upstreamBranch})` : ""} · 点击切换或拉取`}
        >
          <GitBranch size={12} className="chat-branch-icon" />
          <span className="chat-branch-select-label">
            {branchInfo.currentBranch || "分支"}
          </span>
          <ChevronDown
            size={11}
            className={`chat-branch-select-chevron ${open ? "is-open" : ""}`}
          />
        </button>

        {open &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="branch-dropdown"
              style={dropdownStyle}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 顶栏：当前分支 + 上游状态 + 拉取更新 + 新建分支 */}
              <div className="branch-dropdown-header">
                <div className="branch-dropdown-header-title">
                  <GitBranch size={13} className="branch-header-icon" />
                  <span className="branch-header-name" title={branchInfo.currentBranch}>
                    {branchInfo.currentBranch}
                  </span>
                  <span
                    className={`branch-upstream-badge ${hasUpstream ? "is-tracked" : ""}`}
                    title={pullButtonTitle}
                  >
                    {hasUpstream ? branchInfo.upstreamBranch : hasRemote ? "无上游" : "纯本地"}
                  </span>
                </div>
                <div className="branch-dropdown-header-actions">
                  <button
                    type="button"
                    className={`branch-action-btn ${!canPull ? "is-disabled" : ""}`}
                    onClick={canPull ? handlePullUpdates : undefined}
                    disabled={pulling || !canPull}
                    title={pullButtonTitle}
                  >
                    {pulling ? (
                      <Loader2 size={12} className="chat-spin-icon" />
                    ) : (
                      <Download size={12} />
                    )}
                    <span>{pulling ? "拉取中" : "拉取"}</span>
                  </button>
                  <button
                    type="button"
                    className={`branch-action-btn branch-smart-commit-btn ${!hasChanges ? "is-disabled" : ""}`}
                    onClick={hasChanges ? handleSmartCommit : undefined}
                    disabled={!hasChanges}
                    title={commitButtonTitle}
                  >
                    <Sparkles size={11} className="branch-sparkles-icon" />
                    <span>智能提交</span>
                  </button>
                </div>
              </div>

              {/* 分支搜索过滤 */}
              {branchInfo.branches.length > 5 && (
                <div className="branch-search-box">
                  <Search size={11} className="branch-search-icon" />
                  <input
                    type="text"
                    className="branch-search-input"
                    placeholder="搜索分支..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="branch-search-clear"
                      onClick={() => setSearchQuery("")}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              )}

              <div className="branch-dropdown-divider" />
              <div className="branch-dropdown-section-title">本地分支 · Local Branches</div>

              {/* 分支列表 */}
              <div className="branch-dropdown-list">
                {filteredBranches.length > 0 ? (
                  filteredBranches.map((branch) => {
                    const isCurrent = branch === branchInfo.currentBranch;
                    return (
                      <div
                        key={branch}
                        className={`branch-dropdown-item ${isCurrent ? "active" : ""}`}
                        onClick={() => void handleSwitchBranch(branch)}
                        title={`点击切换到分支: ${branch}`}
                      >
                        <GitBranch size={12} className="branch-item-icon" />
                        <span className="branch-item-name">{branch}</span>
                        {isCurrent && (
                          <Check size={12} strokeWidth={2.5} className="branch-item-check" />
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="branch-dropdown-empty">未找到匹配分支</div>
                )}
              </div>
            </div>,
            document.body,
          )}
      </div>

      {/* Git 冲突/错误弹窗：支持一键交给 AI 解决 */}
      {conflictData &&
        createPortal(
          <div className="git-conflict-modal-overlay" onClick={() => setConflictData(null)}>
            <div
              className="git-conflict-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="git-conflict-modal-header">
                <div className="git-conflict-modal-title">
                  <AlertTriangle size={16} className="git-conflict-icon" />
                  <span>Git 拉取冲突 / 更新异常</span>
                </div>
                <button
                  type="button"
                  className="git-conflict-close"
                  onClick={() => setConflictData(null)}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="git-conflict-modal-desc">
                在拉取分支 <code>{conflictData.currentBranch}</code> 时产生冲突或遇到不可自动合并的改动。您可以将错误信息直接发送给 AI 助手，由 AI 为您分析有冲突的文件并执行修复。
              </div>
              <div className="git-conflict-log">
                <pre>{conflictData.output}</pre>
              </div>
              <div className="git-conflict-modal-footer">
                <button
                  type="button"
                  className="git-conflict-btn-secondary"
                  onClick={() => setConflictData(null)}
                >
                  稍后自行处理
                </button>
                <button
                  type="button"
                  className="git-conflict-btn-primary"
                  onClick={handleResolveConflictWithAi}
                >
                  <Sparkles size={13} />
                  <span>让 AI 解决冲突</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 切换分支受阻（有未提交改动）弹窗 */}
      {switchBlockData &&
        createPortal(
          <div className="git-conflict-modal-overlay" onClick={() => setSwitchBlockData(null)}>
            <div
              className="git-conflict-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="git-conflict-modal-header">
                <div className="git-conflict-modal-title">
                  <AlertTriangle size={16} className="git-conflict-icon" />
                  <span>切换分支受阻：检测到未提交的代码改动</span>
                </div>
                <button
                  type="button"
                  className="git-conflict-close"
                  onClick={() => setSwitchBlockData(null)}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="git-conflict-modal-desc">
                当前工作区包含未提交的代码修改。切换到 <code>{switchBlockData.targetBranch}</code> 会覆盖这些文件。您可以选择<strong>自动暂存并切换</strong>，或让 AI 帮您<strong>智能提交后再切换</strong>。
              </div>
              <div className="git-conflict-log">
                <pre>{switchBlockData.errorOutput}</pre>
              </div>
              <div className="git-conflict-modal-footer">
                <button
                  type="button"
                  className="git-conflict-btn-secondary"
                  onClick={() => setSwitchBlockData(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="git-conflict-btn-secondary"
                  onClick={handleAiCommitBeforeSwitch}
                  title="发送提示词让 AI 整理并提交当前代码，随后切换分支"
                >
                  <Sparkles size={13} className="branch-sparkles-icon" />
                  <span>让 AI 提交后切换</span>
                </button>
                <button
                  type="button"
                  className="git-conflict-btn-primary"
                  onClick={handleStashAndSwitch}
                  disabled={stashingSwitch}
                  title="执行 git stash 暂存修改并切换至目标分支"
                >
                  {stashingSwitch ? (
                    <Loader2 size={13} className="chat-spin-icon" />
                  ) : (
                    <Package size={13} />
                  )}
                  <span>{stashingSwitch ? "正在暂存并切换..." : "暂存改动并切换分支"}</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
