import assert from "node:assert/strict";
import test from "node:test";
import { buildMarkdownToc, slugify } from "./markdownToc.ts";
import { renderChatMarkdownToHtml } from "./markdown.ts";

test("builds TOC entries with depth and slug ids", () => {
  const md = [
    "# 标题一",
    "",
    "## 小节 A",
    "",
    "### 三级标题",
    "",
    "正文内容",
    "",
    "## 小节 B",
  ].join("\n");

  const toc = buildMarkdownToc(md);
  assert.deepEqual(toc, [
    { id: "标题一", text: "标题一", depth: 1 },
    { id: "小节-a", text: "小节 A", depth: 2 },
    { id: "三级标题", text: "三级标题", depth: 3 },
    { id: "小节-b", text: "小节 B", depth: 2 },
  ]);
});

test("TOC ids follow the shared slugify rule used by the renderer", () => {
  const md = "# Alpha\n\n## Beta 版\n\n### C/D:e";
  const toc = buildMarkdownToc(md);
  assert.equal(toc[0].id, slugify("Alpha"));
  assert.equal(toc[1].id, slugify("Beta 版"));
  assert.equal(toc[2].id, slugify("C/D:e"));
  // 同一份 slugify：渲染端 heading anchor 与 TOC 锚点必然一致
  assert.equal(slugify("Beta 版"), "beta-版");
  assert.equal(slugify("C/D:e"), "cde");
});

test("returns empty TOC for empty or oversized documents", () => {
  assert.deepEqual(buildMarkdownToc(""), []);
  assert.deepEqual(buildMarkdownToc("   \n  "), []);

  // 超过 3000 行上限 → 空目录（与渲染降级策略一致）
  const oversized = "# 标题\n\n" + "内容行\n".repeat(3100);
  assert.deepEqual(buildMarkdownToc(oversized), []);
});

test("chat markdown escapes raw HTML and blocks unsafe URL protocols", () => {
  const html = renderChatMarkdownToHtml(
    '<script>alert("x")</script> [bad](javascript:alert(1)) ![local](file:///secret)',
  );

  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="file:\/\//i);
  assert.match(html, /&lt;script&gt;/i);
});

test("chat markdown keeps safe web links", () => {
  const html = renderChatMarkdownToHtml("[docs](https://example.com/docs)");

  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
