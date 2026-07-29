/**
 * DiffViewerModal — 文件 diff 查看器
 * 分栏视图 + 语法高亮 + Hunk 级回滚 + 行级回滚
 *
 * 基于 react-diff-view 的 <Diff>/<Hunk>/<Decoration> 组件渲染，
 * 并通过 tokenize() + refractor 对 diff 行内代码做语法高亮。
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RotateCcw } from "lucide-react";
import {
  parseDiff,
  Diff,
  Hunk,
  Decoration,
  tokenize,
  getChangeKey,
} from "react-diff-view";
import type { ChangeData } from "react-diff-view";
import { refractor, detectLanguage } from "./diffHighlight";
import "react-diff-view/style/index.css";
import "./diffViewer.css";

interface DiffViewerModalProps {
  projectPath: string;
  filePath: string;
  status: string;
  /** 提交模式：传入 commit SHA 时展示该提交内的文件 diff（只读，无回滚操作） */
  sha?: string;
  onClose: () => void;
  onRequestDiscard?: () => void;
}

export const DiffViewerModal: React.FC<DiffViewerModalProps> = ({
  projectPath,
  filePath,
  status,
  sha,
  onClose,
  onRequestDiscard,
}) => {
  const [diffText, setDiffText] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const fileName = filePath.split(/[\\/]/).pop() || filePath;

  // ── 拉取 diff 文本 ──
  useEffect(() => {
    let cancelled = false;

    const fetchDiff = async () => {
      setLoading(true);
      setError(null);
      try {
        // 提交模式拉取历史提交 diff；否则拉取工作区 diff
        const result = sha
          ? await invoke<string>("git_commit_file_diff", {
              projectPath,
              sha,
              filePath,
            })
          : await invoke<string>("git_get_file_diff", {
              projectPath,
              filePath,
              status,
            });
        if (!cancelled) {
          setDiffText(result);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchDiff();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, status, sha]);

  // ── 切换文件时清空行选择 ──
  useEffect(() => {
    setSelectedKeys([]);
  }, [diffText]);

  // ── ESC 关闭 ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ── 解析 diff + 语法高亮 tokenize ──
  const parsed = useMemo(() => {
    if (!diffText) return null;
    try {
      const files = parseDiff(diffText);
      if (files.length > 0) {
        const file = files[0];
        // 按文件扩展名启用语法高亮；失败时回退为无高亮 token
        const language = detectLanguage(fileName);
        if (language) {
          try {
            return {
              file,
              tokens: tokenize(file.hunks, { highlight: true, refractor, language }),
            };
          } catch (highlightErr) {
            console.warn("[DiffViewer] 语法高亮失败，回退无高亮:", highlightErr);
          }
        }
        return { file, tokens: tokenize(file.hunks) };
      }
    } catch (err) {
      console.error("[DiffViewer] 解析 diff 失败:", err);
    }
    return null;
  }, [diffText, fileName]);

  const parsedFile = parsed?.file ?? null;
  const tokens = parsed?.tokens ?? null;

  // ── 未跟踪文件与历史提交（只读）不可回滚 ──
  const canDiscard = !sha && status !== "U" && status !== "??";

  // ── 切换单个变更行选中（仅 insert/delete 可选） ──
  const toggleSelect = useCallback(({ change }: { change: ChangeData | null }) => {
    if (!change || change.type === "normal") return;
    const key = getChangeKey(change);
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }, []);

  // ── Hunk 级回滚 ──
  const handleRevertHunk = async (hunkIndex: number) => {
    if (!diffText) return;
    try {
      await invoke("git_revert_hunk", { projectPath, diffText, hunkIndex });
      onClose();
    } catch {
      setError("回滚 Hunk 失败，请刷新后重试");
    }
  };

  // ── 收集选中行（行级回滚用） ──
  const collectSelectedLines = (): { side: "old" | "new"; lineNumber: number }[] => {
    const result: { side: "old" | "new"; lineNumber: number }[] = [];
    if (!parsedFile) return result;
    for (const hunk of parsedFile.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") continue;
        if (!selectedKeys.includes(getChangeKey(change))) continue;
        if (change.type === "insert") result.push({ side: "new", lineNumber: change.lineNumber });
        else result.push({ side: "old", lineNumber: change.lineNumber });
      }
    }
    return result;
  };

  // ── 行级回滚 ──
  const handleRevertLines = async () => {
    const selectedLines = collectSelectedLines();
    if (selectedLines.length === 0) return;
    try {
      await invoke("git_revert_lines", { projectPath, diffText, selectedLines });
      onClose();
    } catch {
      setError("回滚选中行失败，请刷新后重试");
    }
  };

  // ── 纯文本 fallback（diff 无法解析时） ──
  const renderFallbackDiff = () => {
    if (!diffText) return null;
    return (
      <pre className="diff-content">
        {diffText.split("\n").map((line, idx) => {
          let className = "diff-line";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            className += " diff-line-add";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            className += " diff-line-del";
          } else if (line.startsWith("@@")) {
            className += " diff-hunk";
          }
          return (
            <div key={idx} className={className}>
              <span className="diff-line-content">{line || " "}</span>
            </div>
          );
        })}
      </pre>
    );
  };

  return (
    <div className="diff-modal-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="diff-modal-header">
          <span className="diff-modal-title">
            Diff: {fileName}
            {sha && <span className="diff-modal-sha">@ {sha.slice(0, 7)}</span>}
          </span>
          <div className="diff-modal-actions">
            {canDiscard && onRequestDiscard && (
              <button
                className="diff-modal-btn"
                onClick={() => {
                  onRequestDiscard();
                  onClose();
                }}
                title="丢弃此文件的所有更改"
              >
                <RotateCcw size={13} />
                丢弃
              </button>
            )}
            <button className="diff-modal-close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="diff-modal-body">
          {loading ? (
            <div className="diff-loading">加载 diff...</div>
          ) : error ? (
            <div className="diff-error">{error}</div>
          ) : diffText && parsedFile && tokens ? (
            <div className="diff-viewer-container">
              <Diff
                viewType="split"
                diffType={parsedFile.type}
                hunks={parsedFile.hunks}
                tokens={tokens}
                selectedChanges={selectedKeys}
                gutterEvents={canDiscard ? { onClick: toggleSelect } : undefined}
              >
                {(hunks: ReturnType<typeof parseDiff>[number]["hunks"]) =>
                  hunks.map((hunk, index) => (
                    <React.Fragment key={hunk.content}>
                      <Decoration contentClassName="diff-decoration-cell">
                        <div className="diff-decoration-row">
                          <span className="diff-hunk-content">{hunk.content}</span>
                          {canDiscard && (
                            <button
                              onClick={() => handleRevertHunk(index)}
                              className="diff-revert-hunk-btn"
                              title="回滚此 Hunk"
                            >
                              <RotateCcw size={11} />
                              回滚 Hunk
                            </button>
                          )}
                        </div>
                      </Decoration>
                      <Hunk hunk={hunk} />
                    </React.Fragment>
                  ))
                }
              </Diff>
            </div>
          ) : diffText ? (
            renderFallbackDiff()
          ) : (
            <div className="diff-empty">无变更或无法解析 diff</div>
          )}
        </div>

        {/* 行级回滚操作条 */}
        {canDiscard && parsedFile && selectedKeys.length > 0 && (
          <div className="diff-revert-bar">
            <span>已选 {selectedKeys.length} 行</span>
            <button
              onClick={() => setSelectedKeys([])}
              className="diff-revert-bar-btn"
              title="取消选中"
            >
              取消
            </button>
            <button
              onClick={handleRevertLines}
              className="diff-revert-bar-btn danger"
              title="回滚选中的行"
            >
              <RotateCcw size={11} />
              回滚选中行
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
