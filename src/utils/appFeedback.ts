/**
 * 应用级静默反馈总线：替代 window.alert / window.confirm。
 * 宿主（App）订阅后渲染 Toast / ConfirmModal，调用方无需持有 React 上下文。
 */

export type FeedbackTone = "info" | "success" | "warning" | "error";

export interface ToastPayload {
  id: string;
  message: string;
  tone: FeedbackTone;
  durationMs: number;
}

export interface ConfirmRequestOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDanger?: boolean;
}

export interface ConfirmRequest extends ConfirmRequestOptions {
  id: string;
  resolve: (confirmed: boolean) => void;
}

type ToastListener = (toast: ToastPayload) => void;
type ConfirmListener = (request: ConfirmRequest) => void;

const toastListeners = new Set<ToastListener>();
const confirmListeners = new Set<ConfirmListener>();

let toastSequence = 0;
let confirmSequence = 0;

function createToastId(): string {
  toastSequence += 1;
  return `toast-${Date.now()}-${toastSequence}`;
}

function createConfirmId(): string {
  confirmSequence += 1;
  return `confirm-${Date.now()}-${confirmSequence}`;
}

function defaultDurationForTone(tone: FeedbackTone): number {
  if (tone === "error") return 4200;
  if (tone === "warning") return 3600;
  if (tone === "success") return 2600;
  return 3000;
}

export function subscribeToasts(listener: ToastListener): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

export function subscribeConfirms(listener: ConfirmListener): () => void {
  confirmListeners.add(listener);
  return () => {
    confirmListeners.delete(listener);
  };
}

export function notify(
  message: string,
  options?: { tone?: FeedbackTone; durationMs?: number },
): void {
  const trimmed = message.trim();
  if (!trimmed) return;

  const tone = options?.tone ?? "info";
  const toast: ToastPayload = {
    id: createToastId(),
    message: trimmed,
    tone,
    durationMs: options?.durationMs ?? defaultDurationForTone(tone),
  };

  toastListeners.forEach((listener) => {
    listener(toast);
  });
}

export function notifyInfo(message: string, durationMs?: number): void {
  notify(message, { tone: "info", durationMs });
}

export function notifySuccess(message: string, durationMs?: number): void {
  notify(message, { tone: "success", durationMs });
}

export function notifyWarning(message: string, durationMs?: number): void {
  notify(message, { tone: "warning", durationMs });
}

export function notifyError(message: string, durationMs?: number): void {
  notify(message, { tone: "error", durationMs });
}

/**
 * 破坏性或需明确选择的操作。无宿主订阅时返回 false，避免静默放行。
 */
export function confirmAction(options: ConfirmRequestOptions): Promise<boolean> {
  if (confirmListeners.size === 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const request: ConfirmRequest = {
      id: createConfirmId(),
      title: options.title,
      message: options.message,
      confirmText: options.confirmText,
      cancelText: options.cancelText,
      isDanger: options.isDanger,
      resolve,
    };

    confirmListeners.forEach((listener) => {
      listener(request);
    });
  });
}

/** 将未知错误规整为可展示的一行文案 */
export function formatFeedbackError(error: unknown, fallback = "操作失败"): string {
  if (error == null || error === "") return fallback;
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  try {
    return String(error);
  } catch {
    return fallback;
  }
}
