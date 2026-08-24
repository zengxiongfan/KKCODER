import { Marked } from "marked";

// 与 highlighter.ts 对齐的渲染上限：超限降级为纯文本，避免大文件解析 + Prism 高亮阻塞主线程
export const MAX_MARKDOWN_SIZE = 300 * 1024; // 300KB
export const MAX_MARKDOWN_LINES = 3000; // 3000行

/** 与渲染端 heading id 同一套的 slug 化（中文标题保留原文） */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

export interface MarkdownTocEntry {
  id: string;
  text: string;
  depth: number;
}

// 独立的 lexer 实例：TOC 只需解析标题结构，不依赖 Prism 高亮（保持本模块可在 Node 测试环境直接运行）
const tocMarked = new Marked();
tocMarked.setOptions({ gfm: true, breaks: false, pedantic: false });

/**
 * 提取 Markdown 标题构建目录（与渲染端的 heading id 使用同一套 slugify，可精确锚定）。
 * 空文档或超限文档返回空数组。
 */
export function buildMarkdownToc(mdText: string): MarkdownTocEntry[] {
  if (
    !mdText.trim() ||
    mdText.length > MAX_MARKDOWN_SIZE ||
    mdText.split("\n").length > MAX_MARKDOWN_LINES
  ) {
    return [];
  }
  try {
    const tokens = tocMarked.lexer(mdText);
    const entries: MarkdownTocEntry[] = [];
    for (const token of tokens) {
      if (token.type !== "heading") continue;
      const text = (token.tokens ?? [])
        .map((t) => ("text" in t ? String((t as { text?: string }).text ?? "") : ""))
        .join("");
      if (!text.trim()) continue;
      entries.push({ id: slugify(text), text, depth: token.depth });
    }
    return entries;
  } catch {
    return [];
  }
}
