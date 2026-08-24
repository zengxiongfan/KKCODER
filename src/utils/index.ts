export { generateUUID } from "./uuid";
export { log, isDebugLogEnabled, DEBUG_LOG_KEY } from "./log";
export {
  addUnreadCompletion,
  getUnreadCompletionCount,
  markSessionRead,
} from "./unreadCompletions";
export { updateSessionLastUserMessageAt } from "./sessionActivity";
export { readSessionCleanupSettings } from "./sessionCleanup";
export { shouldResumeSession } from "./sessionResume";
export {
  CLAUDE_INTERACTION_MODE_KEY,
  CLAUDE_INTERACTION_MODE_CHANGE_EVENT,
  resolveClaudeInteractionMode,
  shouldUseGuiChat,
  type ClaudeInteractionMode,
} from "./interactionMode";
export {
  clearSessionQueue,
  enqueueSessionTask,
  getSessionQueue,
  removeSessionTask,
  updateSessionTask,
  MAX_SESSION_QUEUE_SIZE,
  type QueueBySession,
} from "./sessionQueue";
export {
  notify,
  notifyInfo,
  notifySuccess,
  notifyWarning,
  notifyError,
  confirmAction,
  formatFeedbackError,
  type FeedbackTone,
  type ToastPayload,
  type ConfirmRequestOptions,
} from "./appFeedback";
