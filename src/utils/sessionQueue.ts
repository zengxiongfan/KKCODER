export interface QueueTask {
  id: string;
  prompt: string;
}

export type QueueBySession = Record<string, QueueTask[]>;

/** 每个会话的任务队列上限 */
export const MAX_SESSION_QUEUE_SIZE = 10;

export function getSessionQueue(state: QueueBySession, sessionId: string): QueueTask[] {
  return state[sessionId] ?? [];
}

export function enqueueSessionTask(
  state: QueueBySession,
  sessionId: string,
  task: QueueTask,
  limit = MAX_SESSION_QUEUE_SIZE,
): QueueBySession {
  const queue = getSessionQueue(state, sessionId);
  if (queue.length >= limit) return state;
  return { ...state, [sessionId]: [...queue, task] };
}

export function dequeueSessionTask(state: QueueBySession, sessionId: string): QueueBySession {
  const queue = getSessionQueue(state, sessionId);
  if (queue.length === 0) return state;
  if (queue.length === 1) return clearSessionQueue(state, sessionId);
  return { ...state, [sessionId]: queue.slice(1) };
}

export function removeSessionTask(
  state: QueueBySession,
  sessionId: string,
  taskId: string,
): QueueBySession {
  const queue = getSessionQueue(state, sessionId);
  const nextQueue = queue.filter((task) => task.id !== taskId);
  if (nextQueue.length === queue.length) return state;
  if (nextQueue.length === 0) return clearSessionQueue(state, sessionId);
  return { ...state, [sessionId]: nextQueue };
}

export function updateSessionTask(
  state: QueueBySession,
  sessionId: string,
  taskId: string,
  newPrompt: string,
): QueueBySession {
  const queue = getSessionQueue(state, sessionId);
  const nextQueue = queue.map((task) => (task.id === taskId ? { ...task, prompt: newPrompt } : task));
  return { ...state, [sessionId]: nextQueue };
}

export function clearSessionQueue(state: QueueBySession, sessionId: string): QueueBySession {
  if (!(sessionId in state)) return state;
  const next = { ...state };
  delete next[sessionId];
  return next;
}
