import React, { useEffect, useState } from "react";
import type { FeedbackTone, ToastPayload } from "../utils/appFeedback";

export interface AppToastHostProps {
  toasts: ToastPayload[];
  onDismiss: (toastId: string) => void;
}

function toneLabel(tone: FeedbackTone): string {
  if (tone === "success") return "完成";
  if (tone === "warning") return "注意";
  if (tone === "error") return "错误";
  return "提示";
}

const EXIT_MS = 180;

const AppToastItem: React.FC<{
  toast: ToastPayload;
  onDismiss: (toastId: string) => void;
}> = ({ toast, onDismiss }) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = window.setTimeout(() => setIsExiting(true), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.durationMs, toast.id]);

  useEffect(() => {
    if (!isExiting) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [isExiting, onDismiss, toast.id]);

  return (
    <div
      className={`app-toast app-toast--${toast.tone}${isExiting ? " app-toast--exit" : ""}`}
      role={toast.tone === "error" || toast.tone === "warning" ? "alert" : "status"}
    >
      <span className="app-toast-rail" aria-hidden />
      <div className="app-toast-body">
        <span className="app-toast-kicker">{toneLabel(toast.tone)}</span>
        <span className="app-toast-message">{toast.message}</span>
      </div>
      <button
        type="button"
        className="app-toast-dismiss"
        aria-label="关闭提示"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setIsExiting(true)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
};

/**
 * 底部居中 Toast 栈：入场轻抬 + 退场淡出，不抢焦点、不挡终端主区。
 */
export const AppToastHost: React.FC<AppToastHostProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="app-toast-host" aria-live="polite" aria-relevant="additions text">
      {toasts.map((toast) => (
        <AppToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};
