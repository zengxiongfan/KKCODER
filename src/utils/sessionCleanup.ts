export const SESSION_CLEANUP_ENABLED_KEY = "agentdesk_setting_session_cleanup_enabled";
export const SESSION_CLEANUP_DAYS_KEY = "agentdesk_setting_session_cleanup_days";
export const DEFAULT_SESSION_CLEANUP_DAYS = 30;
export const MIN_SESSION_CLEANUP_DAYS = 1;
export const MAX_SESSION_CLEANUP_DAYS = 3650;

export function normalizeSessionCleanupDays(value: string | number | null): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_CLEANUP_DAYS;
  return Math.min(MAX_SESSION_CLEANUP_DAYS, Math.max(MIN_SESSION_CLEANUP_DAYS, Math.floor(parsed)));
}

export function readSessionCleanupSettings(storage: Pick<Storage, "getItem"> = localStorage) {
  return {
    enabled: storage.getItem(SESSION_CLEANUP_ENABLED_KEY) === "true",
    days: normalizeSessionCleanupDays(storage.getItem(SESSION_CLEANUP_DAYS_KEY)),
  };
}
