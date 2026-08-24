export const THEME_STORAGE_KEY = "kkcoder_setting_theme";
export const DEFAULT_THEME = "auto";

export type ThemeName =
  | "auto"
  | "dark-zinc"
  | "dark-gray"
  | "dark-blue"
  | "dark-purple"
  | "light-premium"
  | "light-orange";

export type ThemeGroup = "dark" | "light" | "system";

export interface ThemeDefinition {
  id: ThemeName;
  name: string;
  group: ThemeGroup;
  description?: string;
  preview: {
    bg: string;
    accent: string;
    border?: string;
    split?: boolean;
  };
}

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  // 深色 4 种风格
  {
    id: "dark-zinc",
    name: "KK金",
    group: "dark",
    description: "经典碳黑底色与沉稳温暖的KK金",
    preview: { bg: "#1d1b18", accent: "#d97706" },
  },
  {
    id: "dark-gray",
    name: "暗夜灰",
    group: "dark",
    description: "纯净冷调炭灰与极简中性色",
    preview: { bg: "#16181e", accent: "#334155" },
  },
  {
    id: "dark-blue",
    name: "深空墨",
    group: "dark",
    description: "经典深蓝深邃暗色风格",
    preview: { bg: "#121620", accent: "#3b82f6" },
  },
  {
    id: "dark-purple",
    name: "赛博紫",
    group: "dark",
    description: "高级暗调霓虹紫",
    preview: { bg: "#171424", accent: "#8b5cf6" },
  },

  // 浅色 2 种风格
  {
    id: "light-premium",
    name: "极简白",
    group: "light",
    description: "现代清洁的高级极简白主题",
    preview: { bg: "#ffffff", accent: "#0f172a", border: "#e2e8f0" },
  },
  {
    id: "light-orange",
    name: "暖沙橙",
    group: "light",
    description: "温暖护眼的暖沙与蜜橘色调",
    preview: { bg: "#ffffff", accent: "#ea580c", border: "#fed7aa" },
  },

  // 跟随系统
  {
    id: "auto",
    name: "跟随系统",
    group: "system",
    description: "根据操作系统明暗模式自动切换（深色默认KK金）",
    preview: { bg: "#ffffff", accent: "#1e293b", split: true },
  },
];

type ThemeCssVariables = Record<string, string>;

const THEME_VARIABLES: Record<Exclude<ThemeName, "auto">, ThemeCssVariables> = {
  // 原版KK金精准色调（沉稳黑金）
  "dark-zinc": {
    "--bg-main": "#0c0b0a",
    "--bg-sidebar": "#1d1b18",
    "--bg-terminal": "#000000",
    "--border-color": "#332f29",
    "--text-primary": "#fafaf9",
    "--text-secondary": "#cbd5e1",
    "--color-primary": "#d97706",
    "--color-primary-hover": "#b55c04",
    "--color-orange": "#d97706",
    "--color-orange-light": "rgba(217, 119, 6, 0.15)",
    "--bg-active-item": "#383227",
    "--text-active-item": "#ffffff",
    "--bg-hover-item": "rgba(245, 158, 11, 0.15)",
    "--bg-agent-selector": "rgba(0, 0, 0, 0.25)",
    "--bg-agent-slider": "#383227",
    "--shadow-agent-slider": "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    "--code-inline-bg": "rgba(217, 119, 6, 0.15)",
    "--code-inline-text": "#f59e0b",
    "--code-inline-border": "rgba(217, 119, 6, 0.3)",
    "--code-block-bg": "rgba(29, 27, 24, 0.85)",
    "--code-block-border": "#332f29",
    "--quote-bg": "rgba(29, 27, 24, 0.7)",
    "--quote-border": "#d97706",
    "--quote-text": "#cbd5e1",
    "--table-header-bg": "#383227",
    "--table-border": "#332f29",
    "--scrollbar-thumb": "rgba(217, 119, 6, 0.25)",
    "--scrollbar-thumb-hover": "rgba(217, 119, 6, 0.45)",
  },
  // 暗夜灰（纯净冷黑/极简石墨灰）
  "dark-gray": {
    "--bg-main": "#0f1115",
    "--bg-sidebar": "#16181e",
    "--bg-terminal": "#090a0d",
    "--border-color": "#252830",
    "--text-primary": "#f3f4f6",
    "--text-secondary": "#9ca3af",
    "--color-primary": "#334155",
    "--color-primary-hover": "#475569",
    "--color-orange": "#f97316",
    "--color-orange-light": "rgba(249, 115, 22, 0.15)",
    "--bg-active-item": "#252830",
    "--text-active-item": "#ffffff",
    "--bg-hover-item": "rgba(255, 255, 255, 0.08)",
    "--bg-agent-selector": "rgba(0, 0, 0, 0.3)",
    "--bg-agent-slider": "#252830",
    "--shadow-agent-slider": "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    "--code-inline-bg": "rgba(255, 255, 255, 0.08)",
    "--code-inline-text": "#e5e7eb",
    "--code-inline-border": "rgba(255, 255, 255, 0.15)",
    "--code-block-bg": "rgba(22, 24, 30, 0.85)",
    "--code-block-border": "#252830",
    "--quote-bg": "rgba(22, 24, 30, 0.7)",
    "--quote-border": "#475569",
    "--quote-text": "#9ca3af",
    "--table-header-bg": "rgba(37, 40, 48, 0.6)",
    "--table-border": "#252830",
    "--scrollbar-thumb": "rgba(156, 163, 175, 0.25)",
    "--scrollbar-thumb-hover": "rgba(156, 163, 175, 0.45)",
  },
  // 深空墨
  "dark-blue": {
    "--bg-main": "#090d16",
    "--bg-sidebar": "#121620",
    "--bg-terminal": "#000000",
    "--border-color": "#1e293b",
    "--text-primary": "#f8fafc",
    "--text-secondary": "#94a3b8",
    "--color-primary": "#3b82f6",
    "--color-primary-hover": "#2563eb",
    "--color-orange": "#f97316",
    "--color-orange-light": "rgba(249, 115, 22, 0.15)",
    "--bg-active-item": "#1e293b",
    "--text-active-item": "#ffffff",
    "--bg-hover-item": "rgba(59, 130, 246, 0.15)",
    "--bg-agent-selector": "rgba(0, 0, 0, 0.25)",
    "--bg-agent-slider": "#1e293b",
    "--shadow-agent-slider": "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    "--code-inline-bg": "rgba(59, 130, 246, 0.12)",
    "--code-inline-text": "#93c5fd",
    "--code-inline-border": "rgba(59, 130, 246, 0.25)",
    "--code-block-bg": "rgba(18, 22, 32, 0.85)",
    "--code-block-border": "#1e293b",
    "--quote-bg": "rgba(18, 22, 32, 0.7)",
    "--quote-border": "#3b82f6",
    "--quote-text": "#94a3b8",
    "--table-header-bg": "#1e293b",
    "--table-border": "#1e293b",
    "--scrollbar-thumb": "rgba(148, 163, 184, 0.25)",
    "--scrollbar-thumb-hover": "rgba(148, 163, 184, 0.45)",
  },
  // 赛博紫
  "dark-purple": {
    "--bg-main": "#0c0a12",
    "--bg-sidebar": "#171424",
    "--bg-terminal": "#000000",
    "--border-color": "#2e2540",
    "--text-primary": "#f5f3ff",
    "--text-secondary": "#b7a8d6",
    "--color-primary": "#8b5cf6",
    "--color-primary-hover": "#7c3aed",
    "--color-orange": "#f97316",
    "--color-orange-light": "rgba(249, 115, 22, 0.15)",
    "--bg-active-item": "#2f2647",
    "--text-active-item": "#ffffff",
    "--bg-hover-item": "rgba(139, 92, 246, 0.15)",
    "--bg-agent-selector": "rgba(0, 0, 0, 0.25)",
    "--bg-agent-slider": "#2f2647",
    "--shadow-agent-slider": "0 2px 5px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    "--code-inline-bg": "rgba(139, 92, 246, 0.12)",
    "--code-inline-text": "#d8b4fe",
    "--code-inline-border": "rgba(139, 92, 246, 0.25)",
    "--code-block-bg": "rgba(23, 20, 36, 0.85)",
    "--code-block-border": "#2e2540",
    "--quote-bg": "rgba(23, 20, 36, 0.7)",
    "--quote-border": "#8b5cf6",
    "--quote-text": "#b7a8d6",
    "--table-header-bg": "#2f2647",
    "--table-border": "#2e2540",
    "--scrollbar-thumb": "rgba(183, 168, 214, 0.25)",
    "--scrollbar-thumb-hover": "rgba(183, 168, 214, 0.45)",
  },
  // 极简白（对标 Codex 纯净极简风格）
  "light-premium": {
    "--bg-main": "#ffffff",
    "--bg-sidebar": "#f7f8fa",
    "--bg-terminal": "#ffffff",
    "--border-color": "#e5e7eb",
    "--text-primary": "#111827",
    "--text-secondary": "#6b7280",
    "--color-primary": "#374151",
    "--color-primary-hover": "#1f2937",
    "--color-orange": "#ea580c",
    "--color-orange-light": "#fff7ed",
    "--bg-active-item": "#eceef1",
    "--text-active-item": "#111827",
    "--bg-hover-item": "rgba(0, 0, 0, 0.035)",
    "--bg-agent-selector": "rgba(0, 0, 0, 0.04)",
    "--bg-agent-slider": "#ffffff",
    "--shadow-agent-slider": "0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03)",
    "--code-inline-bg": "#f3f4f6",
    "--code-inline-text": "#111827",
    "--code-inline-border": "#e5e7eb",
    "--code-block-bg": "#f9fafb",
    "--code-block-border": "#e5e7eb",
    "--quote-bg": "#f9fafb",
    "--quote-border": "#9ca3af",
    "--quote-text": "#4b5563",
    "--table-header-bg": "#f3f4f6",
    "--table-border": "#e5e7eb",
    "--scrollbar-thumb": "rgba(107, 114, 128, 0.22)",
    "--scrollbar-thumb-hover": "rgba(107, 114, 128, 0.42)",
  },
  // 暖沙橙
  "light-orange": {
    "--bg-main": "#ffffff",
    "--bg-sidebar": "#fffbf5",
    "--bg-terminal": "#fafaf9",
    "--border-color": "#f0ebe4",
    "--text-primary": "#1c1917",
    "--text-secondary": "#78716c",
    "--color-primary": "#ea580c",
    "--color-primary-hover": "#c2410c",
    "--color-orange": "#ea580c",
    "--color-orange-light": "#fff7ed",
    "--bg-active-item": "#ffedd5",
    "--text-active-item": "#c2410c",
    "--bg-hover-item": "rgba(234, 88, 12, 0.08)",
    "--bg-agent-selector": "rgba(234, 88, 12, 0.06)",
    "--bg-agent-slider": "#ffffff",
    "--shadow-agent-slider": "0 2px 4px rgba(234, 88, 12, 0.08), 0 1px 2px rgba(234, 88, 12, 0.04)",
    "--code-inline-bg": "#fff7ed",
    "--code-inline-text": "#c2410c",
    "--code-inline-border": "#fed7aa",
    "--code-block-bg": "#fafaf9",
    "--code-block-border": "#fed7aa",
    "--quote-bg": "rgba(255, 247, 237, 0.85)",
    "--quote-border": "#ea580c",
    "--quote-text": "#44403c",
    "--table-header-bg": "#ffedd5",
    "--table-border": "#fed7aa",
    "--scrollbar-thumb": "rgba(234, 88, 12, 0.22)",
    "--scrollbar-thumb-hover": "rgba(234, 88, 12, 0.42)",
  },
};

export function resolveThemeTarget(themeName: string): Exclude<ThemeName, "auto"> {
  if (themeName === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light-premium" : "dark-zinc";
  }
  if (themeName in THEME_VARIABLES) {
    return themeName as Exclude<ThemeName, "auto">;
  }
  return "dark-zinc";
}

/** Apply theme CSS variables to document root. */
export function applyTheme(themeName: string): void {
  const root = document.documentElement;
  const target = resolveThemeTarget(themeName);
  root.setAttribute("data-theme", target);

  const variables = THEME_VARIABLES[target];
  for (const [cssVariable, value] of Object.entries(variables)) {
    root.style.setProperty(cssVariable, value);
  }
}

export function readStoredTheme(): string {
  return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
}

export function persistTheme(themeName: string): void {
  localStorage.setItem(THEME_STORAGE_KEY, themeName);
}
