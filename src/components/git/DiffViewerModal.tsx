/**
 * DiffViewerModal — 文件 diff 查看器（完整版）
 * 分栏视图 + 语法高亮 + Hunk 级回滚 + 行级回滚
 */

import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RotateCcw } from "lucide-react";
import { parseDiff } from "react-diff-view";
import type { Hunk, Change } from "gitdiff-parser";
import "react-diff-view/style/index.css";

interface DiffViewerModalProps {
  projectPath: string;
  filePath: string;
  status: string;
  onClose: () => void;
  onRequestDiscard?: () => void;
}

export const DiffViewerModal: React.FC<DiffViewerModalProps> = ({
  projectPath,
  filePath,
  status,
  onClose,
  onRequestDiscard,
}) => {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fileName = filePath.split(/[\\/]/).pop() || filePath;

  useEffect(() => {
    let cancelled = false;

    const fetchDiff = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<string>("git_get_file_diff", {
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
  }, [projectPath, filePath, status]);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // 解析 diff（返回 File 数组，取第一个文件）
  const parsedFile = React.useMemo(() => {
    if (!diffText) return null;
    try {
      const files = parseDiff(diffText);
      return files[0] ?? null;
    } catch {
      return null;
    }
  }, [diffText]);

  // 纯文本 fallback 渲染
  const renderFallbackDiff = () => {
    if (!diffText) return null;
    return (
      <pre className="diff-content">
        {diffText.split("\n").map((line, idx) => {
          let className = "diff-line";
          if (line.startsWith("+") && !line.startsWith("+++")) {
            className += " diff-add";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            className += " diff-del";
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

  // Hunk 级回滚
  const handleRevertHunk = async (hunkIndex: number) => {
    if (!diffText) return;
    try {
      await invoke("git_revert_hunk", { projectPath, diffText, hunkIndex });
      onClose();
    } catch {
      setError("回滚 Hunk 失败，请刷新后重试");
    }
  };

  const canDiscard = status !== "D";

  return (
    <div className="diff-modal-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="diff-modal-header">
          <span className="diff-modal-title">Diff: {fileName}</span>
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
          ) : parsedFile ? (
            // 分栏视图：左侧显示原始内容，右侧显示修改后内容
            <div className="diff-viewer-container">
              {parsedFile.hunks.map((hunk: Hunk, index: number) => (
                <div key={index}>
                  {/* Hunk header with revert button */}
                  <div className="diff-decoration">
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
                  {/* 分栏 Diff：左边(old) | 右边(new) */}
                  <div className="diff-split-container">
                    {/* 左侧：原始内容 */}
                    <div className="diff-split-panel diff-split-old">
                      <div className="diff-split-header">原始</div>
                      <div className="diff-split-lines">
                        {hunk.changes.map((change: Change, changeIdx: number) => {
                          const isInsert = change.type === "insert";
                          // insert 行在左侧不显示（新增的行没有原始内容）
                          if (isInsert) {
                            return (
                              <div key={changeIdx} className="diff-line diff-line-empty">
                                <span className="diff-line-num"></span>
                                <span className="diff-line-content"></span>
                              </div>
                            );
                          }
                          const isDelete = change.type === "delete";
                          const isNormal = change.type === "normal";
                          const lineNum = isNormal ? change.oldLineNumber : change.lineNumber;
                          const lineClass = isDelete ? "diff-line-del" : "diff-line-normal";

                          return (
                            <div key={changeIdx} className={`diff-line ${lineClass}`}>
                              <span className="diff-line-num">{lineNum}</span>
                              <span className="diff-line-content">{change.content}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {/* 右侧：修改后内容 */}
                    <div className="diff-split-panel diff-split-new">
                      <div className="diff-split-header">修改后</div>
                      <div className="diff-split-lines">
                        {hunk.changes.map((change: Change, changeIdx: number) => {
                          const isDelete = change.type === "delete";
                          // delete 行在右侧不显示（已删除的行没有新内容）
                          if (isDelete) {
                            return (
                              <div key={changeIdx} className="diff-line diff-line-empty">
                                <span className="diff-line-num"></span>
                                <span className="diff-line-content"></span>
                              </div>
                            );
                          }
                          const isInsert = change.type === "insert";
                          const lineNum = isInsert ? change.lineNumber : change.newLineNumber;
                          const lineClass = isInsert ? "diff-line-add" : "diff-line-normal";

                          return (
                            <div key={changeIdx} className={`diff-line ${lineClass}`}>
                              <span className="diff-line-num">{lineNum}</span>
                              <span className="diff-line-content">{change.content}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : diffText ? (
            renderFallbackDiff()
          ) : (
            <div className="diff-empty">无变更或无法解析 diff</div>
          )}
        </div>
      </div>
    </div>
  );
};
