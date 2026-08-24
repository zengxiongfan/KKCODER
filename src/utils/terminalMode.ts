export type ClaudeTerminalMode = "standard" | "native";

export const CLAUDE_TERMINAL_MODE_KEY = "kkcoder_setting_claude_terminal_mode";

export const resolveClaudeTerminalMode = (value: string | null): ClaudeTerminalMode => {
  return value === "native" ? "native" : "standard";
};

export const shouldUseNativeTerminal = (
  agentType: string,
  mode: ClaudeTerminalMode,
): boolean => {
  return agentType === "claude" && mode === "native";
};
