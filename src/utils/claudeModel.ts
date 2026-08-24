import { invoke } from "@tauri-apps/api/core";

/** 后端 claude_model_info 返回的供应商（来自 cc-switch.db，只读） */
export interface ClaudeProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  /** 仅支持路由：apiFormat 非 anthropic（openai_chat 等），无法直连 */
  routeOnly: boolean;
}

/** 后端 claude_model_info 返回的模型清单（去重、去 [1m] 后缀） */
export interface ClaudeModelInfo {
  models: string[];
  defaultModel?: string | null;
  providerName?: string | null;
  routeMode: boolean;
  /** CC Switch 路由开关是否开启（明确的开关状态） */
  routeEnabled: boolean;
  providerRemoved: boolean;
  providers: ClaudeProviderInfo[];
}

export const CLAUDE_MODEL_KEY = "kkcoder_claude_model";

export function loadSelectedModel(): string | null {
  return localStorage.getItem(CLAUDE_MODEL_KEY);
}

export function saveSelectedModel(model: string | null): void {
  if (model) {
    localStorage.setItem(CLAUDE_MODEL_KEY, model);
  } else {
    localStorage.removeItem(CLAUDE_MODEL_KEY);
  }
}

/** 读取 CC Switch 当前配置的模型清单与默认模型 */
export function loadClaudeModelInfo(): Promise<ClaudeModelInfo> {
  return invoke<ClaudeModelInfo>("claude_model_info");
}

/** 通知后端全局模型覆盖（null = 不传 --model，用 settings.json 旋钮现状） */
export function setClaudeModelBackend(model: string | null): void {
  invoke("set_claude_model", { model }).catch((err) => {
    console.error("set_claude_model failed:", err);
  });
}

/** 选择供应商（仅 KKCODER 内生效，不写任何外部配置），返回刷新后的模型信息 */
export function setClaudeProviderBackend(providerId: string): Promise<ClaudeModelInfo> {
  return invoke<ClaudeModelInfo>("set_claude_provider", { providerId });
}
