//! Lightweight, dependency-free syntax highlighting for the Files preview. A single regex splits
//! text into comments, strings, numbers, keywords, and plain text, using the existing `.c-com`,
//! `.c-str`, `.c-num`, and `.c-key` classes in styles/vlinx.css. It aims for an IDE-like appearance,
//! not parser-level accuracy.
//!
//! Performance guard: although the backend limits previews to 64 KB, wrapping very long text in a
//! span per token can still be slow. Content beyond HL_LIMIT is rendered as plain text.

import React from "react";

/** Render plain text beyond this length to protect rendering performance. */
const HL_LIMIT = 40000;

/** Broad keyword set across JS/TS, Rust, Python, Go, and C-like languages; false positives are inexpensive. */
const KEYWORDS = new Set([
  // Declarations and modules
  "const", "let", "var", "function", "fn", "func", "def", "class", "struct", "enum",
  "interface", "type", "trait", "impl", "import", "export", "from", "use", "mod",
  "package", "namespace", "public", "private", "protected", "static", "final",
  "abstract", "extends", "implements", "pub", "module",
  // Control flow
  "return", "if", "else", "elif", "for", "while", "do", "switch", "case", "default",
  "break", "continue", "match", "when", "try", "catch", "except", "finally", "throw",
  "raise", "yield", "await", "async", "go", "defer", "with", "in", "of", "as",
  // Values and types
  "true", "false", "null", "nil", "none", "undefined", "void", "this", "self",
  "super", "new", "delete", "typeof", "instanceof", "and", "or", "not",
  "int", "float", "bool", "string", "str", "char", "let", "mut",
]);

/** Split text into syntax-highlighted React fragments. */
export function highlight(code: string): React.ReactNode {
  if (code.length > HL_LIMIT) return code;

  const out: React.ReactNode[] = [];
  let key = 0;
  const push = (text: string, cls?: string) => {
    if (!text) return;
    out.push(cls ? React.createElement("span", { key: key++, className: cls }, text) : text);
  };

  // First pass: line comments (// or #), block comments, strings, and numbers.
  // Split keywords only within plain-text segments to avoid highlighting inside strings or comments.
  const TOKEN =
    /(\/\/[^\n]*|#[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(code)) !== null) {
    if (m.index > last) pushPlain(code.slice(last, m.index), push, () => key++);
    if (m[1] || m[2]) push(m[0], "c-com");
    else if (m[3]) push(m[0], "c-str");
    else if (m[4]) push(m[0], "c-num");
    last = m.index + m[0].length;
  }
  if (last < code.length) pushPlain(code.slice(last), push, () => key++);

  return out;
}

/** Highlight keywords in plain text outside strings, comments, and numbers. */
function pushPlain(
  text: string,
  push: (t: string, cls?: string) => void,
  _nextKey: () => number,
): void {
  // Split at word boundaries and look up each contiguous identifier in the keyword set.
  const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    push(m[0], KEYWORDS.has(m[0]) ? "c-key" : undefined);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
}
