/**
 * 终端焦点契约：活动会话终端是默认键盘归宿。
 * 叠加层（弹窗 / 确认 / 菜单）关闭后应调用 requestActiveTerminalFocus。
 * 分屏时可通过 sessionId 精确落到某一格。
 */

export const FOCUS_ACTIVE_TERMINAL_EVENT = "kkcoder-focus-active-terminal";

export interface RequestActiveTerminalFocusOptions {
  /** 等待布局/卸载完成后再聚焦，默认 48ms */
  delayMs?: number;
  /** 指定会话；省略时由「当前活动会话」标签自行判定 */
  sessionId?: string;
}

export interface FocusActiveTerminalDetail {
  sessionId?: string;
}

let pendingFocusTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFocusFrame: number | null = null;

function clearPendingFocusSchedule(): void {
  if (pendingFocusTimer !== null) {
    clearTimeout(pendingFocusTimer);
    pendingFocusTimer = null;
  }
  if (pendingFocusFrame !== null) {
    cancelAnimationFrame(pendingFocusFrame);
    pendingFocusFrame = null;
  }
}

function dispatchFocusActiveTerminal(sessionId?: string): void {
  const detail: FocusActiveTerminalDetail = sessionId ? { sessionId } : {};
  window.dispatchEvent(
    new CustomEvent(FOCUS_ACTIVE_TERMINAL_EVENT, { detail }),
  );
}

/**
 * 请求将系统焦点还给当前活动终端。
 * 多次快速调用会合并为一次，避免弹窗连关时抖动。
 */
export function requestActiveTerminalFocus(
  options?: RequestActiveTerminalFocusOptions,
): void {
  const delayMs = options?.delayMs ?? 48;
  const sessionId = options?.sessionId;
  clearPendingFocusSchedule();

  const run = () => {
    pendingFocusTimer = null;
    pendingFocusFrame = requestAnimationFrame(() => {
      pendingFocusFrame = requestAnimationFrame(() => {
        pendingFocusFrame = null;
        dispatchFocusActiveTerminal(sessionId);
      });
    });
  };

  if (delayMs <= 0) {
    run();
    return;
  }

  pendingFocusTimer = setTimeout(run, delayMs);
}

/** 语义别名：UI 路径结束后归还焦点 */
export function returnFocusToActiveTerminal(
  options?: RequestActiveTerminalFocusOptions,
): void {
  requestActiveTerminalFocus(options);
}

/**
 * 当前焦点是否在可编辑控件内（输入框/文本域/contenteditable）。
 * 用于全局快捷键：编辑中时勿抢终端焦点。
 */
export function isEditableFocusTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * 判断元素是否属于应拦截终端焦点的叠加层（弹窗、确认框、右键菜单等）。
 */
export function isFocusBlockingOverlay(element: Element | null): boolean {
  if (!element) return false;
  return Boolean(
    element.closest(
      [
        ".modal-overlay",
        ".modal-card",
        ".context-menu",
        ".tree-context-menu",
        ".app-toast-host",
        ".settings-modal",
        "[data-focus-trap]",
      ].join(", "),
    ),
  );
}
