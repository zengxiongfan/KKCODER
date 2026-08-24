import { useCallback, useEffect, useRef, useState } from "react";
import {
  subscribeConfirms,
  subscribeToasts,
  type ConfirmRequest,
  type ToastPayload,
} from "../utils/appFeedback";
import { requestActiveTerminalFocus } from "../utils/terminalFocus";

const MAX_VISIBLE_TOASTS = 3;

export interface UseAppFeedbackResult {
  toasts: ToastPayload[];
  dismissToast: (toastId: string) => void;
  activeConfirm: ConfirmRequest | null;
  resolveConfirm: (confirmed: boolean) => void;
}

/**
 * 在应用根挂载一次：承接反馈总线，驱动 Toast 与确认弹窗。
 * 自动消失由 AppToastHost 按 durationMs 处理，以保留退场动画。
 * 确认框关闭且队列清空后归还终端焦点。
 */
export function useAppFeedback(): UseAppFeedbackResult {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);
  const [activeConfirm, setActiveConfirm] = useState<ConfirmRequest | null>(null);
  const confirmQueueRef = useRef<ConfirmRequest[]>([]);
  const hadConfirmRef = useRef(false);

  const dismissToast = useCallback((toastId: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== toastId));
  }, []);

  useEffect(() => {
    const unsubscribeToasts = subscribeToasts((toast) => {
      setToasts((previous) => {
        const next = [...previous, toast];
        if (next.length <= MAX_VISIBLE_TOASTS) return next;
        return next.slice(-MAX_VISIBLE_TOASTS);
      });
    });

    const unsubscribeConfirms = subscribeConfirms((request) => {
      setActiveConfirm((current) => {
        if (current) {
          confirmQueueRef.current.push(request);
          return current;
        }
        return request;
      });
    });

    return () => {
      unsubscribeToasts();
      unsubscribeConfirms();
      confirmQueueRef.current.forEach((queued) => queued.resolve(false));
      confirmQueueRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (activeConfirm) {
      hadConfirmRef.current = true;
      return;
    }
    if (hadConfirmRef.current) {
      hadConfirmRef.current = false;
      requestActiveTerminalFocus({ delayMs: 56 });
    }
  }, [activeConfirm]);

  const resolveConfirm = useCallback((confirmed: boolean) => {
    setActiveConfirm((current) => {
      if (current) {
        current.resolve(confirmed);
      }
      return confirmQueueRef.current.shift() ?? null;
    });
  }, []);

  return {
    toasts,
    dismissToast,
    activeConfirm,
    resolveConfirm,
  };
}
