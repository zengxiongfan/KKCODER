/**
 * Monaco 初始化（副作用模块，需在使用编辑器前 import 一次）
 *
 * 关键点：Tauri 桌面可能离线，@monaco-editor/react 默认从 CDN 拉 Monaco，
 * 这里改为使用本地打包的 monaco-editor + 本地 worker（Vite `?worker`），彻底离线可用。
 */

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Vite worker 本地化：各语言服务 worker 从本地 bundle 加载
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// 关闭 TS/JS 语义与语法诊断：Monaco 内置的是单文件语言服务，看不到 tsconfig/其它文件/node_modules，
// 对 .tsx（JSX）和跨文件 import 会大量误报红波浪线。此处只保留语法高亮，去掉误导性诊断。
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
  noSuggestionDiagnostics: true,
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
  noSuggestionDiagnostics: true,
});
// 关闭 JSON 校验：很多配置文件（如 tsconfig.json）是 JSONC，带注释/尾逗号，
// 标准 JSON 校验器会误报红波浪线；与 TS/JS 一致只保留高亮。
monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: false,
  allowComments: true,
  schemaValidation: "ignore",
});

// ── 动态主题：跟随应用当前主题的 CSS 变量（--bg-main 等），切主题即时同步 ──

const DYNAMIC_THEME = "kkcoder-auto";

// 读 CSS 变量并归一化为 Monaco 可用的 hex 颜色（支持 #rgb/#rrggbb/rgb()/rgba()）
function readCssColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (raw.startsWith("#")) {
    if (raw.length === 4) {
      return "#" + [...raw.slice(1)].map((c) => c + c).join("");
    }
    return raw;
  }
  const m = raw.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (m) {
    const to2 = (n: number) => n.toString(16).padStart(2, "0");
    let hex = "#" + to2(+m[1]) + to2(+m[2]) + to2(+m[3]);
    if (m[4] !== undefined) hex += to2(Math.round(parseFloat(m[4]) * 255));
    return hex;
  }
  return fallback;
}

function isLightTheme(): boolean {
  return (document.documentElement.getAttribute("data-theme") || "").startsWith("light");
}

/** 按当前应用主题的 CSS 变量重定义并应用 Monaco 主题；返回主题名 */
export function syncMonacoTheme(): string {
  const light = isLightTheme();
  const bg = readCssColor("--bg-main", light ? "#ffffff" : "#1e1e2e");
  const fg = readCssColor("--text-primary", light ? "#1e293b" : "#e2e8f0");
  const secondary = readCssColor("--text-secondary", light ? "#64748b" : "#5c6370");
  const border = readCssColor("--border-color", light ? "#e2e8f0" : "#2c2c3a");
  // 右键菜单配色对齐文件树 .context-menu（背景 --bg-main、hover 用 --bg-active-item / --text-active-item）
  const menuHoverBg = readCssColor("--bg-active-item", light ? "#e2e8f0" : "#2a2a3a");
  const menuHoverFg = readCssColor("--text-active-item", fg);
  monaco.editor.defineTheme(DYNAMIC_THEME, {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorGutter.background": bg,
      "editorLineNumber.foreground": secondary,
      "editorLineNumber.activeForeground": fg,
      "minimap.background": bg,
      // 右键上下文菜单（与文件树右键菜单同色系）
      "menu.background": bg,
      "menu.foreground": fg,
      "menu.border": border,
      "menu.selectionBackground": menuHoverBg,
      "menu.selectionForeground": menuHoverFg,
      "menu.separatorBackground": border,
    },
  });
  monaco.editor.setTheme(DYNAMIC_THEME);
  return DYNAMIC_THEME;
}

// 应用切换主题（data-theme 属性 / 内联 CSS 变量变化）→ 即时同步已打开的编辑器
new MutationObserver(() => {
  syncMonacoTheme();
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme", "style"],
});

// 让 @monaco-editor/react 使用本地 monaco 实例，而非 CDN
loader.config({ monaco });

/** 获取当前应该使用的 Monaco 主题名（同时按最新 CSS 变量刷新主题定义） */
export function getMonacoTheme(): string {
  return syncMonacoTheme();
}

/** 按文件扩展名映射 Monaco 语言 id（覆盖常见类型，未知返回 plaintext） */
export function getMonacoLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
    case "xhtml":
      return "html";
    case "xml":
    case "svg":
      return "xml";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
    case "pyw":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "sql":
      return "sql";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "ini";
    case "sh":
    case "bash":
      return "shell";
    case "bat":
    case "cmd":
      return "bat";
    case "properties":
      return "ini";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "hpp":
      return "cpp";
    default:
      return "plaintext";
  }
}
