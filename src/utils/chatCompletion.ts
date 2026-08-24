export type ChatCompletionTrigger = {
  kind: "file" | "slash";
  query: string;
  start: number;
  end: number;
};

/** Detect the active Claude-style completion token immediately before the caret. */
export function detectChatCompletionTrigger(
  text: string,
  caret: number,
): ChatCompletionTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, safeCaret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);

  const slash = line.match(/^\s*\/([^\s/]*)$/);
  if (slash) {
    const slashOffset = line.indexOf("/");
    return {
      kind: "slash",
      query: slash[1] ?? "",
      start: lineStart + slashOffset,
      end: safeCaret,
    };
  }

  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) {
    const token = at[0];
    const atOffset = token.lastIndexOf("@");
    return {
      kind: "file",
      query: at[1] ?? "",
      start: safeCaret - token.length + atOffset,
      end: safeCaret,
    };
  }
  return null;
}

export function replaceChatCompletionTrigger(
  text: string,
  trigger: ChatCompletionTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return {
    text: next,
    caret: trigger.start + replacement.length,
  };
}
