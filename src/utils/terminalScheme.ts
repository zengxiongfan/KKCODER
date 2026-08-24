/** Windows Terminal / windowsterminalthemes.dev scheme → xterm theme */

export type TerminalSchemeMode = "default" | "custom";

export const TERMINAL_SCHEME_MODE_KEY = "kkcoder_setting_terminal_scheme_mode";
export const TERMINAL_SCHEME_JSON_KEY = "kkcoder_setting_terminal_scheme_json";
export const TERMINAL_SCHEME_CHANGE_EVENT = "kkcoder-terminal-scheme-change";

export interface WindowsTerminalScheme {
  name?: string;
  background?: string;
  foreground?: string;
  cursorColor?: string;
  selectionBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  purple?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightPurple?: string;
  brightCyan?: string;
  brightWhite?: string;
  // some themes use magenta naming already
  magenta?: string;
  brightMagenta?: string;
  cursor?: string;
}

export type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  /** 选区文字色；不设时 xterm 保留原前景，浅色选区上容易糊成白底白字 */
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^rgba?\([^)]+\)$/;

const isColor = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && COLOR_RE.test(value.trim());

const pickColor = (...candidates: unknown[]): string | undefined => {
  for (const c of candidates) {
    if (isColor(c)) return (c as string).trim();
  }
  return undefined;
};

/** Rough luminance check so custom schemes get a readable selectionForeground */
const isLikelyDarkBackground = (color: string): boolean => {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    let body = hex.slice(1);
    if (body.length === 3) {
      body = body
        .split("")
        .map((ch) => ch + ch)
        .join("");
    }
    if (body.length === 8) body = body.slice(0, 6);
    if (body.length === 6) {
      const r = Number.parseInt(body.slice(0, 2), 16);
      const g = Number.parseInt(body.slice(2, 4), 16);
      const b = Number.parseInt(body.slice(4, 6), 16);
      // relative luminance approximation
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
    }
  }
  // rgba / unknown → assume dark-ish to keep light text
  return true;
};

export const resolveTerminalSchemeMode = (raw: string | null): TerminalSchemeMode =>
  raw === "custom" ? "custom" : "default";

/** Built-in fallback that mirrors TerminalTab's dark/light derivation from app theme */
export const getDefaultTerminalTheme = (appThemeName?: string): XtermTheme => {
  const themeName = appThemeName || localStorage.getItem("kkcoder_setting_theme") || "auto";
  let isDark = false;
  if (themeName.startsWith("dark-")) {
    isDark = true;
  } else if (themeName === "auto") {
    isDark = !window.matchMedia("(prefers-color-scheme: light)").matches;
  }

  return {
    background: isDark ? "#000000" : "#ffffff",
    foreground: isDark ? "#f8fafc" : "#334155",
    cursor: isDark ? "#f8fafc" : "#334155",
    selectionBackground: isDark ? "rgba(59, 130, 246, 0.45)" : "rgba(37, 99, 235, 0.28)",
    selectionForeground: isDark ? "#ffffff" : "#0f172a",
    black: isDark ? "#000000" : "#0f172a",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#8b5cf6",
    cyan: "#06b6d4",
    // 浅色：ANSI White 映射为深灰，防止思考展开/反色块白底白字
    white: isDark ? "#e2e8f0" : "#475569",
    brightBlack: isDark ? "#94a3b8" : "#64748b",
    brightRed: isDark ? "#f87171" : "#dc2626",
    brightGreen: isDark ? "#34d399" : "#16a34a",
    brightYellow: isDark ? "#fbbf24" : "#d97706",
    brightBlue: isDark ? "#60a5fa" : "#2563eb",
    brightMagenta: isDark ? "#a78bfa" : "#7c3aed",
    brightCyan: isDark ? "#22d3ee" : "#0891b2",
    brightWhite: isDark ? "#ffffff" : "#0f172a",
  };
};

export const parseWindowsTerminalScheme = (
  input: string,
): { ok: true; scheme: WindowsTerminalScheme; theme: XtermTheme } | { ok: false; error: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "JSON 格式无效，请粘贴完整的配色方案 JSON" };
  }

  // Accept either a single scheme object, or { schemes: [scheme] }, or an array
  let schemeObj: unknown = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, error: "JSON 数组为空" };
    schemeObj = parsed[0];
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { schemes?: unknown }).schemes)) {
    const schemes = (parsed as { schemes: unknown[] }).schemes;
    if (schemes.length === 0) return { ok: false, error: "schemes 数组为空" };
    schemeObj = schemes[0];
  }

  if (!schemeObj || typeof schemeObj !== "object") {
    return { ok: false, error: "JSON 必须是配色对象" };
  }

  const s = schemeObj as WindowsTerminalScheme;
  const background = pickColor(s.background);
  const foreground = pickColor(s.foreground);
  if (!background || !foreground) {
    return { ok: false, error: "缺少必要字段 background / foreground" };
  }

  const theme: XtermTheme = {
    background,
    foreground,
    cursor: pickColor(s.cursorColor, s.cursor) || foreground,
    selectionBackground: pickColor(s.selectionBackground) || "rgba(148, 163, 184, 0.35)",
    // 自定义方案通常不带 selectionForeground；按背景亮度给默认反差色
    selectionForeground: isLikelyDarkBackground(background) ? "#ffffff" : "#0f172a",
    black: pickColor(s.black) || "#000000",
    red: pickColor(s.red) || "#ef4444",
    green: pickColor(s.green) || "#10b981",
    yellow: pickColor(s.yellow) || "#f59e0b",
    blue: pickColor(s.blue) || "#3b82f6",
    magenta: pickColor(s.magenta, s.purple) || "#8b5cf6",
    cyan: pickColor(s.cyan) || "#06b6d4",
    white: pickColor(s.white) || "#f8fafc",
    brightBlack: pickColor(s.brightBlack) || "#94a3b8",
    brightRed: pickColor(s.brightRed) || "#f87171",
    brightGreen: pickColor(s.brightGreen) || "#34d399",
    brightYellow: pickColor(s.brightYellow) || "#fbbf24",
    brightBlue: pickColor(s.brightBlue) || "#60a5fa",
    brightMagenta: pickColor(s.brightMagenta, s.brightPurple) || "#a78bfa",
    brightCyan: pickColor(s.brightCyan) || "#22d3ee",
    brightWhite: pickColor(s.brightWhite) || "#ffffff",
  };

  return { ok: true, scheme: s, theme };
};

export const loadSavedCustomTheme = (): XtermTheme | null => {
  const raw = localStorage.getItem(TERMINAL_SCHEME_JSON_KEY);
  if (!raw) return null;
  const result = parseWindowsTerminalScheme(raw);
  return result.ok ? result.theme : null;
};

export const getActiveTerminalTheme = (appThemeName?: string): XtermTheme => {
  const mode = resolveTerminalSchemeMode(localStorage.getItem(TERMINAL_SCHEME_MODE_KEY));
  if (mode === "custom") {
    return loadSavedCustomTheme() || getDefaultTerminalTheme(appThemeName);
  }
  return getDefaultTerminalTheme(appThemeName);
};

export const dispatchTerminalSchemeChange = () => {
  window.dispatchEvent(new CustomEvent(TERMINAL_SCHEME_CHANGE_EVENT));
};
