//! Pure string helpers for Markdown images, with no external dependencies so they are easy to test headlessly.

/**
 * Milkdown stores a block image's scale ratio as two decimal places in alt text, serializing it as
 * `![1.00](src)`. External renderers such as GitHub and Typora do not apply that ratio; it only leaves behind
 * meaningless numeric alt text. At the Markdown-text boundary, clear this numeric-only alt value to produce the
 * clean standard form `![](src)`, while retaining the URL and optional title
 * (`![1.00](x.png "caption")` → `![](x.png "caption")`).
 *
 * The shape is fixed at `\d+\.\d{2}`, as produced by toFixed(2). Normal alt text is extremely unlikely to match,
 * minimizing false positives. The tradeoff is that .md files do not retain image scale and reopen at 100%; that
 * ratio was already ineffective outside Milkdown, so it is safe to discard.
 */
export function stripImageRatioAlt(md: string): string {
  return md.replace(/!\[\d+\.\d{2}\]\(/g, "![](");
}
