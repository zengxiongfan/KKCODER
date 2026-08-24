import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearSessionQueue,
  enqueueSessionTask,
  getSessionQueue,
  removeSessionTask,
  updateSessionTask,
  MAX_SESSION_QUEUE_SIZE,
  type QueueBySession,
} from "../utils/sessionQueue";
import { generateUUID } from "../utils/uuid";
import { log } from "../utils/log";
import { notifyWarning } from "../utils/appFeedback";

export interface UseSessionQueueEngineOptions {
  activeSessionId: string;
  openTabIds: string[];
  /** 投递一条队列任务：CLI 终端写 PTY、GUI 聊天走 chat 发送（由 App 层按会话模式路由） */
  dispatchTask: (sessionId: string, prompt: string) => Promise<void>;
  onTaskSubmitted: (sessionId: string) => void;
}

export function useSessionQueueEngine({
  activeSessionId,
  openTabIds,
  dispatchTask,
  onTaskSubmitted,
}: UseSessionQueueEngineOptions) {
  const [queueBySession, setQueueBySession] = useState<QueueBySession>({});
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [queueInput, setQueueInput] = useState("");
  const [queueTargetSessionId, setQueueTargetSessionId] = useState("");
  const [sessionBusy, setSessionBusy] = useState<Record<string, boolean>>({});

  const dispatchTaskRef = useRef(dispatchTask);
  dispatchTaskRef.current = dispatchTask;
  const onTaskSubmittedRef = useRef(onTaskSubmitted);
  onTaskSubmittedRef.current = onTaskSubmitted;
  const openTabIdsRef = useRef(openTabIds);
  openTabIdsRef.current = openTabIds;
  const dispatchingSessionsRef = useRef<Set<string>>(new Set());
  const pausedSessionsRef = useRef<Set<string>>(new Set());

  const activeQueue = getSessionQueue(queueBySession, activeSessionId);
  const queueModalQueue = getSessionQueue(queueBySession, queueTargetSessionId);

  const handleAddToQueue = useCallback(() => {
    const trimmed = queueInput.trim();
    if (!trimmed) {
      notifyWarning("请输入要排队的提示词");
      return;
    }
    if (!queueTargetSessionId || !openTabIds.includes(queueTargetSessionId)) {
      notifyWarning("目标会话已关闭，无法加入队列");
      setShowQueueModal(false);
      return;
    }
    if (queueModalQueue.length >= MAX_SESSION_QUEUE_SIZE) {
      notifyWarning(`队列已满（${MAX_SESSION_QUEUE_SIZE}/${MAX_SESSION_QUEUE_SIZE}）`);
      return;
    }
    setQueueBySession((previous) =>
      enqueueSessionTask(previous, queueTargetSessionId, {
        id: generateUUID(),
        prompt: trimmed,
      }),
    );
    setQueueInput("");
    setShowQueueModal(false);
  }, [openTabIds, queueInput, queueModalQueue.length, queueTargetSessionId]);

  // Dispatch queued prompts without depending on unstable parent callbacks every render.
  useEffect(() => {
    for (const [sessionId, tasks] of Object.entries(queueBySession)) {
      if (tasks.length === 0) continue;
      if (sessionBusy[sessionId]) continue;
      if (pausedSessionsRef.current.has(sessionId)) continue;
      if (!openTabIdsRef.current.includes(sessionId)) continue;
      if (dispatchingSessionsRef.current.has(sessionId)) continue;

      const nextTask = tasks[0];
      dispatchingSessionsRef.current.add(sessionId);
      log(`[Queue] Auto-triggering queued task: "${nextTask.prompt}" for session: ${sessionId}`);
      setSessionBusy((previous) => ({ ...previous, [sessionId]: true }));

      dispatchTaskRef
        .current(sessionId, nextTask.prompt)
        .then(() => {
          onTaskSubmittedRef.current(sessionId);
          log(
            `[Queue] Successfully sent task to session ${sessionId}. Removing it from that session queue...`,
          );
          setQueueBySession((previous) => removeSessionTask(previous, sessionId, nextTask.id));
        })
        .catch((error) => {
          log(`[Queue] Failed to send queued task for session ${sessionId}: ${error}`);
          setSessionBusy((previous) => ({ ...previous, [sessionId]: false }));
        })
        .finally(() => {
          dispatchingSessionsRef.current.delete(sessionId);
        });
    }
  }, [queueBySession, sessionBusy]);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 80);
    return () => clearTimeout(timer);
  }, [activeQueue.length]);

  const enqueuePrompt = useCallback((sessionId: string, prompt: string) => {
    setQueueBySession((previous) =>
      enqueueSessionTask(previous, sessionId, {
        id: generateUUID(),
        prompt,
      }),
    );
  }, []);

  const clearQueueForSession = useCallback((sessionId: string) => {
    setQueueBySession((previous) => clearSessionQueue(previous, sessionId));
  }, []);

  const removeQueuedTask = useCallback((sessionId: string, taskId: string) => {
    setQueueBySession((previous) => removeSessionTask(previous, sessionId, taskId));
  }, []);

  const updateQueuedTask = useCallback((sessionId: string, taskId: string, newPrompt: string) => {
    setQueueBySession((previous) => updateSessionTask(previous, sessionId, taskId, newPrompt));
  }, []);

  const pauseSessionQueue = useCallback((sessionId: string) => {
    pausedSessionsRef.current.add(sessionId);
  }, []);

  const resumeSessionQueue = useCallback((sessionId: string) => {
    pausedSessionsRef.current.delete(sessionId);
  }, []);

  return {
    queueBySession,
    setQueueBySession,
    showQueueModal,
    setShowQueueModal,
    queueInput,
    setQueueInput,
    queueTargetSessionId,
    setQueueTargetSessionId,
    sessionBusy,
    setSessionBusy,
    activeQueue,
    queueModalQueue,
    handleAddToQueue,
    enqueuePrompt,
    clearQueueForSession,
    removeQueuedTask,
    updateQueuedTask,
    pauseSessionQueue,
    resumeSessionQueue,
  };
}
