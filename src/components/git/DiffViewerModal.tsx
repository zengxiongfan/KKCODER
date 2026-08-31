/**
 * DiffViewerModal — 文件 diff 查看器（Monaco DiffEditor，VSCode diff 内核本体）
 *
 * 并排/内联(renderSideBySide)、折叠未改区域(hideUnchangedRegions)、字符级高亮、
 * 语法着色、上下块导航、块级回滚箭头(renderMarginRevertIcon) 全部 Monaco 原生自带。
 *
 * 双模式：
 *   - 传入 sha → 历史提交，两侧只读；
 *   - 否则     → 工作区，右侧可编辑 + Ctrl+S 存盘（块级 ↩ 回滚 = 改模型后存盘）。
 *
 * 数据源（后端现有命令，无需新增）：
 *   工作区：original = git_file_content(HEAD)，modified = read_project_file_content(磁盘, 带编码)
 *   提交：  original = git_file_content(<sha>^)，modified = git_file_content(<sha>)
 */

import { useState, useEffect, useMemo, useRef, useCallback, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, RotateCcw, ArrowUp, ArrowDown, FoldVertical, UnfoldVertical, Save } from "lucide-react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { getMonacoTheme, getMonacoLanguage } from "../../utils/monacoSetup";
import { useFloatingModal, FloatModalResizeHandles } from "../../hooks/useFloatingModal";

interface DiffViewerModalProps {
  projectPath: string;
  filePath: string;
  status: string;
  /** 提交模式：传入 commit SHA 时展示该提交内的文件 diff（只读） */
  sha?: string;
  onClose: () => void;
  onRequestDiscard?: () => void;
  /** 工作区模式存盘成功后回调（供外层刷新变更列表） */
  onSaved?: () => void;
  /** 右键「添加到对话」：把选区行号注入终端（与文件模块编辑器同款） */
  onAddSelectionToConversation?: (startLine: number, endLine: number) => void;
}

export const DiffViewerModal: FC<DiffViewerModalProps> = ({
  projectPath,
  filePath,
  status,
  sha,
  onClose,
  onRequestDiscard,
  onSaved,
  onAddSelectionToConversation,
}) => {
  const [original, setOriginal] = useState<string>("");
  const [modified, setModified] = useState<string>("");
  const [encoding, setEncoding] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [viewType, setViewType] = useState<"split" | "unified">(() =>
    localStorage.getItem("agentdesk_diff_view") === "unified" ? "unified" : "split"
  );
  const [collapseUnchanged, setCollapseUnchanged] = useState<boolean>(
    () => localStorage.getItem("agentdesk_diff_collapse") !== "off"
  );

  const [themeName] = useState(() => getMonacoTheme());
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const baselineRef = useRef<string>("");
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const addToConvRef = useRef(onAddSelectionToConversation);
  const changeIdxRef = useRef(-1);

  useEffect(() => {
    addToConvRef.current = onAddSelectionToConversation;
  }, [onAddSelectionToConversation]);

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const isUntracked = status === "U" || status === "??";
  const isDeleted = status === "D";
  // 工作区且文件存在于磁盘（删除态无法写回）→ 右侧可编辑
  const editable = !sha && !isDeleted;
  // 整文件“丢弃”：仅工作区已跟踪文件
  const canDiscard = !sha && !isUntracked;
  const language = useMemo(() => getMonacoLanguage(filePath), [filePath]);

  // ── 拉取两侧全文 ──
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        if (sha) {
          // 提交模式：original=父提交，modified=该提交
          const [orig, mod] = await Promise.all([
            invoke<string>("git_file_content", { projectPath, filePath, rev: `${sha}^` }).catch(() => ""),
            invoke<string>("git_file_content", { projectPath, filePath, rev: sha }).catch(() => ""),
          ]);
          if (!cancelled) {
            setOriginal(orig);
            setModified(mod);
            setEncoding(undefined);
          }
        } else {
          // 工作区模式：original=HEAD（未跟踪无旧版本），modified=磁盘（删除态为空）
          const origP = isUntracked
            ? Promise.resolve("")
            : invoke<string>("git_file_content", { projectPath, filePath, rev: "HEAD" }).catch(() => "");
          const modP = isDeleted
            ? Promise.resolve({ content: "", encoding: "utf-8" })
            : invoke<{ content: string; encoding: string }>("read_project_file_content", {
                projectPath,
                relativePath: filePath,
              }).catch(() => ({ content: "", encoding: "utf-8" }));
          const [orig, mod] = await Promise.all([origP, modP]);
          if (!cancelled) {
            setOriginal(orig);
            setModified(mod.content);
            setEncoding(mod.encoding);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath, status, sha, isUntracked, isDeleted]);

  // 载入新内容后重置脏态基线
  useEffect(() => {
    baselineRef.current = modified;
    setDirty(false);
    changeIdxRef.current = -1;
  }, [modified]);

  // ── 存盘（仅工作区可编辑） ──
  const save = useCallback(async () => {
    if (!editable) return;
    const modEditor = diffEditorRef.current?.getModifiedEditor();
    if (!modEditor) return;
    const content = modEditor.getValue();
    if (content === baselineRef.current) return;
    setSaving(true);
    try {
      await invoke("write_project_file_content", {
        projectPath,
        relativePath: filePath,
        content,
        encoding: encoding ?? null,
      });
      baselineRef.current = content;
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError("保存失败：" + String(e));
    } finally {
      setSaving(false);
    }
  }, [editable, projectPath, filePath, encoding, onSaved]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // ── Monaco 挂载：脏态跟踪 + Ctrl+S + 右键菜单精简（与文件模块编辑器一致，只留「添加到对话」） ──
  const handleMount: DiffOnMount = (diffEditor, monaco) => {
    diffEditorRef.current = diffEditor;
    const modEditor = diffEditor.getModifiedEditor();
    modEditor.onDidChangeModelContent(() => {
      setDirty(modEditor.getValue() !== baselineRef.current);
    });
    modEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    // diff 重算后重置块导航索引
    diffEditor.onDidUpdateDiff(() => {
      changeIdxRef.current = -1;
    });

    // 左右两侧编辑器各有独立右键菜单，逐个处理：自建「添加到对话」 + 白名单过滤内置项。
    // 注：addAction 注册的菜单项真实 id 为 "<editorId>:<descriptor.id>"（带实例前缀），
    // 故用后缀匹配；包裹 _getMenuActions 过滤（防御式，失败则不过滤）。
    const setupContextMenu = (ed: editor.IStandaloneCodeEditor) => {
      ed.addAction({
        id: "agentdesk.addToConversation",
        label: "添加到对话",
        contextMenuGroupId: "1_agentdesk",
        contextMenuOrder: 1,
        run: (e) => {
          const sel = e.getSelection();
          if (sel && !sel.isEmpty()) {
            addToConvRef.current?.(sel.startLineNumber, sel.endLineNumber);
          } else {
            const pos = e.getPosition();
            if (pos) addToConvRef.current?.(pos.lineNumber, pos.lineNumber);
          }
        },
      });
      try {
        const isAllowed = (id?: string) =>
          !!id &&
          ["agentdesk.addToConversation"].some((k) => id === k || id.endsWith(":" + k));
        const contextmenu = ed.getContribution("editor.contrib.contextmenu") as unknown as {
          _getMenuActions?: (...args: unknown[]) => Array<{ id?: string }>;
        } | null;
        if (contextmenu && typeof contextmenu._getMenuActions === "function") {
          const original = contextmenu._getMenuActions.bind(contextmenu);
          contextmenu._getMenuActions = (...args: unknown[]) => {
            const items = original(...args);
            const filtered = items.filter((item) => isAllowed(item?.id));
            // 安全兜底：若过滤后竟为空（版本差异导致 id 规则变化），则不过滤，避免菜单打不开
            return filtered.length > 0 ? filtered : items;
          };
        }
      } catch {
        /* 内部 API 不可用时退化为完整菜单 */
      }
    };
    setupContextMenu(modEditor);
    setupContextMenu(diffEditor.getOriginalEditor());
  };

  // ── 视图 / 折叠开关：即时更新 options ──
  const options = useMemo<editor.IStandaloneDiffEditorConstructionOptions>(
    () => ({
      readOnly: !editable,
      originalEditable: false,
      renderSideBySide: viewType === "split",
      // 关掉窄宽度自动降级内联（默认断点 900px，弹窗宽度以内会导致并排切换失效），视图完全由按钮控制
      useInlineViewWhenSpaceIsLimited: false,
      renderMarginRevertIcon: editable, // 块级 ↩ 回滚箭头（仅可编辑时可点）
      hideUnchangedRegions: {
        enabled: collapseUnchanged,
        minimumLineCount: 8, // 小于 8 行的未改间隙不折叠（避免碎片）
        contextLineCount: 3,
        revealLineCount: 20,
      },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbersMinChars: 3,
      ignoreTrimWhitespace: false, // 与 git 一致，保留空白差异
      renderOverviewRuler: false,
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
      padding: { top: 6, bottom: 6 },
    }),
    [editable, viewType, collapseUnchanged]
  );

  useEffect(() => {
    diffEditorRef.current?.updateOptions({
      renderSideBySide: viewType === "split",
      useInlineViewWhenSpaceIsLimited: false,
      hideUnchangedRegions: { enabled: collapseUnchanged },
    });
  }, [viewType, collapseUnchanged]);

  const switchView = (v: "split" | "unified") => {
    setViewType(v);
    localStorage.setItem("agentdesk_diff_view", v);
  };

  const toggleCollapse = () => {
    setCollapseUnchanged((prev) => {
      const next = !prev;
      localStorage.setItem("agentdesk_diff_collapse", next ? "on" : "off");
      return next;
    });
  };

  // ── 上一个/下一个更改：基于 diff 计算结果跳转并居中 ──
  const goToChange = (dir: 1 | -1) => {
    const de = diffEditorRef.current;
    if (!de) return;
    const changes = de.getLineChanges();
    if (!changes || changes.length === 0) return;
    let idx = changeIdxRef.current + dir;
    if (idx < 0) idx = changes.length - 1;
    if (idx >= changes.length) idx = 0;
    changeIdxRef.current = idx;
    const c = changes[idx];
    const line = Math.max(1, c.modifiedStartLineNumber || c.modifiedEndLineNumber || 1);
    const modEditor = de.getModifiedEditor();
    modEditor.revealLineInCenter(line);
    modEditor.setPosition({ lineNumber: line, column: 1 });
    modEditor.focus();
  };

  // ── 关闭（有未保存改动先确认） ──
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  // ESC 关闭（编辑器内部的 ESC 交给 Monaco，如关闭查找框）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.(".monaco-editor")) return;
      requestClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  // 可拖动 + 可缩放（位置/尺寸持久化到 localStorage）
  const { rect, startMove, startResize } = useFloatingModal({
    storageKey: "kkcoder_setting_diff_modal_rect",
    defaultWidth: Math.round(window.innerWidth * 0.86),
    defaultHeight: Math.round(window.innerHeight * 0.76),
    minWidth: 480,
    minHeight: 320,
  });

  return (
    <div className="diff-modal-overlay" onClick={requestClose}>
      <div
        className="diff-modal"
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部（按住可拖动，按钮/输入等内部控件除外） */}
        <div className="diff-modal-header" onPointerDown={startMove}>
          <span className="diff-modal-title">
            {fileName}
            {sha && <span className="diff-modal-sha">@ {sha.slice(0, 7)}</span>}
            {dirty && <span className="diff-dirty-dot" title="未保存的更改">●</span>}
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
            {/* 保存（可编辑模式） */}
            {editable && (
              <button
                className="diff-modal-btn"
                onClick={() => void save()}
                disabled={!dirty || saving}
                title="保存 (Ctrl+S)"
              >
                <Save size={13} />
                {saving ? "保存中…" : "保存"}
              </button>
            )}
            {/* 整文件丢弃 */}
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
            <button className="diff-modal-close" onClick={requestClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 内容：Monaco DiffEditor */}
        <div className="diff-modal-body diff-editor-host">
          {error ? (
            <div className="diff-error">{error}</div>
          ) : loading ? (
            <div className="diff-loading">加载 diff...</div>
          ) : (
            <DiffEditor
              original={original}
              modified={modified}
              language={language}
              theme={themeName}
              options={options}
              onMount={handleMount}
              loading={<div className="diff-loading">加载编辑器…</div>}
            />
          )}
        </div>
        {/* 八方向边界缩放手柄 */}
        <FloatModalResizeHandles startResize={startResize} />
      </div>

      {/* 关闭前未保存确认 */}
      {confirmClose && (
        <div className="git-confirm-overlay" onClick={() => setConfirmClose(false)}>
          <div className="git-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-confirm-title">放弃未保存的更改？</div>
            <div className="git-confirm-desc">你在此文件中的编辑尚未保存，关闭将丢失这些改动。</div>
            <div className="git-confirm-actions">
              <button className="git-btn cancel" onClick={() => setConfirmClose(false)}>
                继续编辑
              </button>
              <button
                className="git-btn danger"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
              >
                放弃并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
