/**
 * DiffViewerModal — 文件 diff 查看器（VSCode 风格）
 *
 * - 全文件视图：未改动区域折叠为「展开 N 行」占位，点击按需展开（useSourceExpansion）
 * - 字符级行内高亮：同一行只高亮真正变化的片段（markEdits）
 * - 并排 / 内联视图切换（持久化）
 * - 语法高亮（refractor）+ Hunk/行级回滚（仅工作区模式）
 *
 * 数据源双模式：传入 sha → 历史提交只读；否则 → 工作区可回滚。
 * 展开/折叠依赖旧版文件全文 oldSource（git_file_content 提供）。
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RotateCcw, ArrowUp, ArrowDown, FoldVertical, UnfoldVertical } from "lucide-react";
import {
  parseDiff,
  Diff,
  Hunk,
  Decoration,
  tokenize,
  markEdits,
  getChangeKey,
  getCollapsedLinesCountBetween,
  expandFromRawCode,
  useSourceExpansion,
  useMinCollapsedLines,
} from "react-diff-view";
import { refractor, detectLanguage } from "./diffHighlight";
import "react-diff-view/style/index.css";
import "./diffViewer.css";

type FileData = ReturnType<typeof parseDiff>[number];
type HunkType = FileData["hunks"][number];
type ChangeType = HunkType["changes"][number];

// 小于该行数的未改动间隙自动展开（避免出现「展开 1 行」这种碎片占位）
const MIN_COLLAPSED_LINES = 8;
// 稳定空数组引用，避免 hooks 依赖每次变化
const EMPTY_HUNKS: HunkType[] = [];

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
  const [oldSource, setOldSource] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [viewType, setViewType] = useState<"split" | "unified">(() =>
    localStorage.getItem("kkcoder_diff_view") === "unified" ? "unified" : "split"
  );
  // 折叠未更改区域开关：true = 折叠（默认），false = 全文件展开
  const [collapseUnchanged, setCollapseUnchanged] = useState<boolean>(
    () => localStorage.getItem("kkcoder_diff_collapse") !== "off"
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const currentChangeIdx = useRef(-1);

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const isUntracked = status === "U" || status === "??";
  // 未跟踪文件与历史提交（只读）不可回滚
  const canDiscard = !sha && !isUntracked;

  // ── 拉取 diff 文本 + 旧版全文（oldSource，供展开/折叠） ──
  useEffect(() => {
    let cancelled = false;

    const fetchAll = async () => {
      setLoading(true);
      setError(null);
      try {
        const diffPromise = sha
          ? invoke<string>("git_commit_file_diff", { projectPath, sha, filePath })
          : invoke<string>("git_get_file_diff", { projectPath, filePath, status });
        // 旧版全文：工作区模式取 HEAD；提交模式取该提交的父（<sha>^）；未跟踪无旧版本
        const rev = sha ? `${sha}^` : "HEAD";
        const oldPromise = isUntracked
          ? Promise.resolve("")
          : invoke<string>("git_file_content", { projectPath, filePath, rev }).catch(() => "");

        const [diff, old] = await Promise.all([diffPromise, oldPromise]);
        if (!cancelled) {
          setDiffText(diff);
          setOldSource(old);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, status, sha, isUntracked]);

  // ── 切换文件时清空行选择 ──
  useEffect(() => {
    setSelectedKeys([]);
  }, [diffText]);

  // ── diff / 折叠态 / 视图变化时重置“当前更改”导航索引 ──
  useEffect(() => {
    currentChangeIdx.current = -1;
  }, [diffText, collapseUnchanged, viewType]);

  // ── ESC 关闭 ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ── 解析 diff ──
  const parsedFile = useMemo<FileData | null>(() => {
    if (!diffText) return null;
    try {
      const files = parseDiff(diffText);
      return files.length > 0 ? files[0] : null;
    } catch (err) {
      console.error("[DiffViewer] 解析 diff 失败:", err);
      return null;
    }
  }, [diffText]);

  const baseHunks = parsedFile?.hunks ?? EMPTY_HUNKS;
  const oldLines = useMemo(() => (oldSource ? oldSource.split("\n") : []), [oldSource]);

  // ── 展开/折叠（hooks 必须无条件调用，均以 oldSource 为源） ──
  const [expandedHunks, expandRange] = useSourceExpansion(baseHunks, oldSource);
  const collapsedHunks = useMinCollapsedLines(MIN_COLLAPSED_LINES, expandedHunks, oldSource);
  // 全展开模式：把整份文件（1..N）填入，未更改区域全部铺开
  const fullyExpandedHunks = useMemo(() => {
    if (collapseUnchanged || oldLines.length === 0 || expandedHunks.length === 0) return null;
    try {
      return expandFromRawCode(expandedHunks, oldLines, 1, oldLines.length);
    } catch {
      return null;
    }
  }, [collapseUnchanged, oldLines, expandedHunks]);
  const hunks = fullyExpandedHunks ?? collapsedHunks;

  // ── 语法高亮 + 字符级行内高亮（markEdits） ──
  const tokens = useMemo(() => {
    if (!parsedFile || hunks.length === 0) return null;
    const language = detectLanguage(fileName);
    const enhancers = [markEdits(hunks, { type: "block" })];
    try {
      if (language) {
        return tokenize(hunks, { highlight: true, refractor, language, enhancers });
      }
      return tokenize(hunks, { enhancers });
    } catch (highlightErr) {
      console.warn("[DiffViewer] 语法高亮失败，回退无高亮:", highlightErr);
      try {
        return tokenize(hunks, { enhancers });
      } catch {
        return null;
      }
    }
  }, [hunks, parsedFile, fileName]);

  // ── 切换单个变更行选中（仅 insert/delete 可选） ──
  const toggleSelect = useCallback(({ change }: { change: ChangeType | null }) => {
    if (!change || change.type === "normal") return;
    const key = getChangeKey(change);
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }, []);

  // ── 收集变更行 → 行号（回滚基于行号，对展开/折叠鲁棒） ──
  const changeToLine = (change: ChangeType): { side: "old" | "new"; lineNumber: number } | null => {
    if (change.type === "insert") return { side: "new", lineNumber: change.lineNumber };
    if (change.type === "delete") return { side: "old", lineNumber: change.lineNumber };
    return null;
  };

  const collectSelectedLines = (): { side: "old" | "new"; lineNumber: number }[] => {
    const result: { side: "old" | "new"; lineNumber: number }[] = [];
    for (const hunk of hunks) {
      for (const change of hunk.changes) {
        if (change.type === "normal") continue;
        if (!selectedKeys.includes(getChangeKey(change))) continue;
        const line = changeToLine(change);
        if (line) result.push(line);
      }
    }
    return result;
  };

  // ── 回滚整块改动（收集该 hunk 全部变更行 → 行级回滚，不依赖 hunk 索引） ──
  const handleRevertHunk = async (hunk: HunkType) => {
    const lines = hunk.changes
      .map(changeToLine)
      .filter((l): l is { side: "old" | "new"; lineNumber: number } => l !== null);
    if (lines.length === 0) return;
    try {
      await invoke("git_revert_lines", { projectPath, diffText, selectedLines: lines });
      onClose();
    } catch {
      setError("回滚失败，请刷新后重试");
    }
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

  const switchView = (v: "split" | "unified") => {
    setViewType(v);
    localStorage.setItem("kkcoder_diff_view", v);
  };

  const toggleCollapse = () => {
    setCollapseUnchanged((prev) => {
      const next = !prev;
      localStorage.setItem("kkcoder_diff_collapse", next ? "on" : "off");
      return next;
    });
  };

  // ── 上一个 / 下一个更改：收集变更块起始行，滚动居中定位（对并排/内联/展开均适用） ──
  const getChangeAnchors = (): HTMLElement[] => {
    const root = bodyRef.current;
    if (!root) return [];
    const rows = Array.from(root.querySelectorAll("tr")) as HTMLElement[];
    const anchors: HTMLElement[] = [];
    let prevWasChange = false;
    for (const row of rows) {
      const isChange = !!row.querySelector(
        ".diff-code-insert, .diff-code-delete, .diff-gutter-insert, .diff-gutter-delete"
      );
      if (isChange && !prevWasChange) anchors.push(row);
      prevWasChange = isChange;
    }
    return anchors;
  };

  const goToChange = (dir: 1 | -1) => {
    const anchors = getChangeAnchors();
    if (anchors.length === 0) return;
    let idx = currentChangeIdx.current + dir;
    if (idx < 0) idx = anchors.length - 1;
    if (idx >= anchors.length) idx = 0;
    currentChangeIdx.current = idx;
    anchors[idx].scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // ── 纯文本 fallback（diff 无法解析时） ──
  const renderFallbackDiff = () => {
    if (!diffText) return null;
    return (
      <pre className="diff-content">
        {diffText.split("\n").map((line, idx) => {
          let className = "diff-line";
          if (line.startsWith("+") && !line.startsWith("+++")) className += " diff-line-add";
          else if (line.startsWith("-") && !line.startsWith("---")) className += " diff-line-del";
          else if (line.startsWith("@@")) className += " diff-hunk";
          return (
            <div key={idx} className={className}>
              <span className="diff-line-content">{line || " "}</span>
            </div>
          );
        })}
      </pre>
    );
  };

  // ── 展开占位条（点击展开一段未改动区域） ──
  const oldLineCount = oldLines.length;

  const renderExpandBar = (key: string, start: number, end: number, count: number) => (
    <Decoration key={key}>
      <button
        type="button"
        className="diff-expand-bar"
        onClick={() => expandRange(start, end)}
        title="展开这段未改动的代码"
      >
        ⋯ 展开 {count} 行未改动 ⋯
      </button>
    </Decoration>
  );

  // ── 渲染 hunks：间隙插展开条，每块头部显示 @@ + 回滚 ──
  const renderHunks = (hunksToRender: HunkType[]): React.ReactElement[] => {
    const elements: React.ReactElement[] = [];
    hunksToRender.forEach((hunk, i) => {
      const previous = i > 0 ? hunksToRender[i - 1] : null;
      // 该 hunk 之前折叠的行数
      const collapsed = previous
        ? getCollapsedLinesCountBetween(previous, hunk)
        : hunk.oldStart - 1;
      if (oldSource && collapsed > 0) {
        const start = previous ? previous.oldStart + previous.oldLines : 1;
        const end = hunk.oldStart - 1;
        elements.push(renderExpandBar(`expand-${hunk.content}`, start, end, collapsed));
      }
      elements.push(
        <Decoration key={`deco-${hunk.content}`} contentClassName="diff-decoration-cell">
          <div className="diff-decoration-row">
            <span className="diff-hunk-content">{hunk.content}</span>
            {canDiscard && (
              <button
                onClick={() => handleRevertHunk(hunk)}
                className="diff-revert-hunk-btn"
                title="回滚此块改动"
              >
                <RotateCcw size={11} />
                回滚
              </button>
            )}
          </div>
        </Decoration>
      );
      elements.push(<Hunk key={`hunk-${hunk.content}`} hunk={hunk} />);
    });
    // 末尾折叠区
    const last = hunksToRender[hunksToRender.length - 1];
    if (oldSource && last) {
      const start = last.oldStart + last.oldLines;
      if (start <= oldLineCount) {
        elements.push(renderExpandBar("expand-trailing", start, oldLineCount, oldLineCount - start + 1));
      }
    }
    return elements;
  };

  return (
    <div className="diff-modal-overlay" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="diff-modal-header">
          <span className="diff-modal-title">
            {fileName}
            {sha && <span className="diff-modal-sha">@ {sha.slice(0, 7)}</span>}
          </span>
          <div className="diff-modal-actions">
            {/* 上一个/下一个更改 */}
            <div className="diff-nav-group">
              <button className="diff-icon-btn" onClick={() => goToChange(-1)} title="上一个更改">
                <ArrowUp size={14} />
              </button>
              <button className="diff-icon-btn" onClick={() => goToChange(1)} title="下一个更改">
                <ArrowDown size={14} />
              </button>
            </div>
            {/* 折叠未更改区域开关 */}
            <button
              className={`diff-icon-btn ${collapseUnchanged ? "on" : ""}`}
              onClick={toggleCollapse}
              disabled={!oldSource}
              title={collapseUnchanged ? "展开全部未更改区域" : "折叠未更改区域"}
            >
              {collapseUnchanged ? <FoldVertical size={14} /> : <UnfoldVertical size={14} />}
            </button>
            {/* 视图切换 */}
            <div className="diff-view-toggle">
              <button
                className={viewType === "split" ? "on" : ""}
                onClick={() => switchView("split")}
                title="并排视图"
              >
                并排
              </button>
              <button
                className={viewType === "unified" ? "on" : ""}
                onClick={() => switchView("unified")}
                title="内联视图"
              >
                内联
              </button>
            </div>
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
        <div className="diff-modal-body" ref={bodyRef}>
          {loading ? (
            <div className="diff-loading">加载 diff...</div>
          ) : error ? (
            <div className="diff-error">{error}</div>
          ) : diffText && parsedFile && hunks.length > 0 ? (
            <div className="diff-viewer-container">
              <Diff
                viewType={viewType}
                diffType={parsedFile.type}
                hunks={hunks}
                tokens={tokens ?? undefined}
                selectedChanges={selectedKeys}
                gutterEvents={canDiscard ? { onClick: toggleSelect } : undefined}
              >
                {(renderedHunks) => renderHunks(renderedHunks as unknown as HunkType[])}
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
            <button onClick={() => setSelectedKeys([])} className="diff-revert-bar-btn" title="取消选中">
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
