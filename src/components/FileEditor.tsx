/**
 * FileEditor — 基于 Monaco 的工作区文件编辑器（VSCode 模型：打开即可编辑）
 *
 * - 语法高亮 / 行号 / 原生查找(Ctrl+F)/跳行(Ctrl+G)
 * - 脏改跟踪 + Ctrl+S 存盘（write_project_file_content）
 * - 只读门控（二进制/超大/历史·远程时 readOnly）
 * - 保留 KKCoder 特色：右键「添加到对话」动作（读选区行号 → 注入终端）
 * - 底部状态栏：语言 / 行列 / 编码 / 只读标记
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { getMonacoLanguage, getMonacoTheme } from "../utils/monacoSetup";

export interface FileEditorHandle {
  save: () => Promise<void>;
  isDirty: () => boolean;
}

interface FileEditorProps {
  projectPath: string;
  relativePath: string;
  initialContent: string;
  /** 读取时检测到的文件编码（utf-8 / gbk），保存时按原编码写回 */
  encoding?: string;
  readOnly?: boolean;
  fontFamily?: string;
  fontSize?: number;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: (content: string) => void;
  onAddSelectionToConversation?: (startLine: number, endLine: number) => void;
}

// 编辑器 + monaco 实例的最小类型（避免全量引入 monaco 类型）
type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];

export const FileEditor = forwardRef<FileEditorHandle, FileEditorProps>(function FileEditor(
  {
    projectPath,
    relativePath,
    initialContent,
    encoding,
    readOnly = false,
    fontFamily,
    fontSize,
    onDirtyChange,
    onSaved,
    onAddSelectionToConversation,
  },
  ref
) {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const originalRef = useRef<string>(initialContent);
  // 始终指向最新回调，供 Monaco command/action 闭包内调用，避免捕获过期值
  const addToConvRef = useRef(onAddSelectionToConversation);
  addToConvRef.current = onAddSelectionToConversation;

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [error, setError] = useState<string | null>(null);

  const language = getMonacoLanguage(relativePath);

  // 保存：直接读编辑器当前值（避免闭包过期），写盘成功后更新基线
  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || readOnly) return;
    const current = editor.getValue();
    if (current === originalRef.current) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("write_project_file_content", {
        projectPath,
        relativePath,
        content: current,
        encoding: encoding ?? null,
      });
      originalRef.current = current;
      setDirty(false);
      onDirtyChange?.(false);
      onSaved?.(current);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [projectPath, relativePath, encoding, readOnly, onDirtyChange, onSaved]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useImperativeHandle(
    ref,
    () => ({
      save: () => saveRef.current(),
      isDirty: () => dirty,
    }),
    [dirty]
  );

  // 切换文件 / 外部内容变化 → 重置基线与脏态
  useEffect(() => {
    originalRef.current = initialContent;
    setDirty(false);
    onDirtyChange?.(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath, initialContent]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Ctrl+S 存盘（通过 ref 调最新 save）
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });

    // 光标位置 → 状态栏
    editor.onDidChangeCursorPosition((e) => {
      setCursor({ line: e.position.lineNumber, col: e.position.column });
    });

    // ── 自建中文右键菜单项：只保留「添加到对话」 ──
    // 添加到对话（无选中时回退到当前光标行）
    editor.addAction({
      id: "kkcoder.addToConversation",
      label: "添加到对话",
      contextMenuGroupId: "1_kkcoder",
      contextMenuOrder: 1,
      run: (ed) => {
        const sel = ed.getSelection();
        if (sel && !sel.isEmpty()) {
          addToConvRef.current?.(sel.startLineNumber, sel.endLineNumber);
        } else {
          const pos = ed.getPosition();
          if (pos) addToConvRef.current?.(pos.lineNumber, pos.lineNumber);
        }
      },
    });

    // 精简右键菜单：只保留上面自建的项，隐藏所有 Monaco 内置项。
    // 注：剪切/复制/粘贴不放入菜单，用系统快捷键 Ctrl+X/C/V 即可。
    // addAction 注册的菜单项真实 id 为 "<editorId>:<descriptor.id>"（带实例前缀），
    // 故用后缀匹配而非精确相等；包裹 _getMenuActions 过滤（防御式，失败则不过滤）。
    try {
      const isAllowed = (id?: string) =>
        !!id &&
        ["kkcoder.addToConversation"].some((k) => id === k || id.endsWith(":" + k));
      const contextmenu = editor.getContribution("editor.contrib.contextmenu") as unknown as {
        _getMenuActions?: (...args: unknown[]) => Array<{ id?: string }>;
      } | null;
      if (contextmenu && typeof contextmenu._getMenuActions === "function") {
        const original = contextmenu._getMenuActions.bind(contextmenu);
        contextmenu._getMenuActions = (...args: unknown[]) => {
          const items = original(...args);
          const filtered = items.filter((item) => isAllowed(item?.id));
          // 安全兵底：若过滤后竟为空（版本差异导致 id 规则变化），则不过滤，避免菜单打不开
          return filtered.length > 0 ? filtered : items;
        };
      }
    } catch {
      /* 版本差异导致内部 API 不可用时，退化为显示完整菜单 */
    }
  };

  const handleChange = (value: string | undefined) => {
    const v = value ?? "";
    const isDirty = v !== originalRef.current;
    setDirty(isDirty);
    onDirtyChange?.(isDirty);
  };

  return (
    <div className="file-editor-wrapper">
      {error && <div className="file-editor-error">保存失败：{error}</div>}
      <div className="file-editor-monaco">
        <Editor
          path={relativePath}
          language={language}
          value={initialContent}
          theme={getMonacoTheme()}
          onMount={handleMount}
          onChange={handleChange}
          options={{
            readOnly,
            fontFamily: fontFamily || undefined,
            fontSize: fontSize || 13,
            minimap: { enabled: true, maxColumn: 80 },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            renderWhitespace: "selection",
            smoothScrolling: true,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          }}
        />
      </div>
      <div className="file-editor-status">
        <span className="fe-st-lang">{language}</span>
        <span className="fe-st-enc">{(encoding || "utf-8").toUpperCase()}</span>
        <span className="fe-st-pos">Ln {cursor.line}, Col {cursor.col}</span>
        {readOnly ? (
          <span className="fe-st-flag readonly">只读</span>
        ) : (
          <button
            className={`fe-st-flag as-btn ${dirty ? "dirty" : ""}`}
            onClick={() => void save()}
            disabled={!dirty || saving}
            title="保存 (Ctrl+S)"
          >
            {saving ? "保存中…" : dirty ? "● 未保存 · 保存" : "已保存"}
          </button>
        )}
      </div>
    </div>
  );
});
