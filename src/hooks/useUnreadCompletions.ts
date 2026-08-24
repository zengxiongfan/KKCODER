import { useEffect, useRef, useState } from "react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { addUnreadCompletion, markSessionRead } from "../utils/unreadCompletions";
import { log } from "../utils/log";

export function useUnreadCompletions(
  activeSessionId: string,
  appWindow: TauriWindow,
) {
  const [glowingSessionIds, setGlowingSessionIds] = useState<string[]>([]);
  const glowingSessionIdsRef = useRef<string[]>([]);
  glowingSessionIdsRef.current = glowingSessionIds;
  const activeSessionIdRef = useRef(activeSessionId);
  const isWindowFocusedRef = useRef(true);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSessionId) {
      setGlowingSessionIds((previous) => markSessionRead(previous, activeSessionId));
    }
  }, [activeSessionId]);

  // 记录窗口聚焦状态：用于「聚焦时完成不加未读」的决策（任务栏角标已移除，仅保留闪烁逻辑）
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    appWindow
      .isFocused()
      .then((focused) => {
        isWindowFocusedRef.current = focused;
      })
      .catch((error) => log(`Failed to read window focus state: ${error}`));

    appWindow
      .onFocusChanged(({ payload: focused }) => {
        isWindowFocusedRef.current = focused;
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((error) => log(`Failed to register window focus listener: ${error}`));

    return () => {
      if (unlisten) unlisten();
    };
  }, [appWindow]);

  const handleCommandComplete = (sessionId: string) => {
    const next = addUnreadCompletion(
      glowingSessionIdsRef.current,
      sessionId,
      activeSessionIdRef.current,
      isWindowFocusedRef.current,
    );
    log(
      `[unread] complete session=${sessionId} focused=${isWindowFocusedRef.current} active=${activeSessionIdRef.current} count=${next.length}`,
    );
    setGlowingSessionIds(next);
  };

  return {
    glowingSessionIds,
    setGlowingSessionIds,
    activeSessionIdRef,
    isWindowFocusedRef,
    handleCommandComplete,
  };
}
