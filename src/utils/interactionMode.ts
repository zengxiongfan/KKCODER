export type ClaudeInteractionMode = "cli" | "gui";

export const CLAUDE_INTERACTION_MODE_KEY = "kkcoder_setting_claude_interaction_mode";

export const CLAUDE_INTERACTION_MODE_CHANGE_EVENT = "kkcoder-claude-interaction-mode-change";

/** 解析交互模式：仅显式 "cli" 才走 CLI，其余（含首次未设置 null）默认 GUI */
export const resolveClaudeInteractionMode = (value: string | null): ClaudeInteractionMode => {
  return value === "cli" ? "cli" : "gui";
};

/** Claude Code 的交互模式：gui 时才走聊天界面（仅 Claude 存在，恒 claude 会话） */
export const shouldUseGuiChat = (
  agentType: string,
  mode: ClaudeInteractionMode,
): boolean => {
  return agentType === "claude" && mode === "gui";
};
