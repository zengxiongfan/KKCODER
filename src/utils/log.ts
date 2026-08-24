const MAX_PERSISTED_LOGS = 500;
const LOGS_STORAGE_KEY = "kkcoder_logs";
/** 调试日志总开关的 localStorage key（设置中心「调试」页控制） */
export const DEBUG_LOG_KEY = "kkcoder_setting_debug_log_enabled";
/** 防抖落盘间隔：热路径调用只写内存，避免每次 console.log 都同步读写 localStorage */
const FLUSH_DEBOUNCE_MS = 800;
/** 内存积压达到该条数时立即落盘，防止日志堆积丢失 */
const FLUSH_IMMEDIATE_THRESHOLD = 50;

const pendingLogs: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 调试日志是否开启（默认开启；关闭后不再产生任何日志） */
export function isDebugLogEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_LOG_KEY) !== "false";
  } catch {
    return true;
  }
}

/** 批量落盘到后端文件 logs/frontend.log（非 Tauri 环境静默忽略） */
async function persistToFile(batch: string[]): Promise<void> {
  try {
    // Tauri v2 注入 __TAURI_INTERNALS__；动态 import 避免非 Tauri 环境（如 node 测试）报错
    const hasTauri =
      typeof window !== "undefined" &&
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
    if (!hasTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("append_frontend_log", { message: batch.join("\n") });
  } catch {
    // 文件落盘失败不影响主流程
  }
}

function flushLogs(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs.splice(0, pendingLogs.length);
  // 1) localStorage 保险副本（崩溃/重启后仍可追溯）
  try {
    const existingLogs = JSON.parse(localStorage.getItem(LOGS_STORAGE_KEY) || "[]") as string[];
    existingLogs.push(...batch);
    if (existingLogs.length > MAX_PERSISTED_LOGS) {
      existingLogs.splice(0, existingLogs.length - MAX_PERSISTED_LOGS);
    }
    localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(existingLogs));
  } catch {
    // Ignore localStorage failures (private mode / quota).
  }
  // 2) 落盘到后端 logs/frontend.log（异步，不阻塞）
  void persistToFile(batch);
}

/** Persist frontend logs: console + localStorage + logs/frontend.log (via backend). */
export function log(message: string): void {
  // 调试日志关闭时不产生任何日志
  if (!isDebugLogEnabled()) return;
  const timestamp = new Date().toISOString();
  const fullMessage = `[JS][${timestamp}] ${message}`;
  console.log(fullMessage);
  pendingLogs.push(fullMessage);
  if (pendingLogs.length >= FLUSH_IMMEDIATE_THRESHOLD) {
    flushLogs();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flushLogs, FLUSH_DEBOUNCE_MS);
  }
}

// 页面隐藏/卸载时尽力落盘，缩小崩溃追踪的丢失窗口
if (typeof window !== "undefined") {
  const flushOnExit = () => flushLogs();
  window.addEventListener("pagehide", flushOnExit);
  window.addEventListener("beforeunload", flushOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushLogs();
  });
}
