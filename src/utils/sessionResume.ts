export function shouldResumeSession(
  sessionId: string,
  newSessionIds: string[],
): boolean {
  return !newSessionIds.includes(sessionId);
}
