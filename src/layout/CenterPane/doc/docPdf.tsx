//! Vector PDF document export based on @react-pdf/renderer.
//!
//! html2canvas plus jsPDF captures one long image and slices it at fixed page heights, producing
//! inconsistent margins and split text lines. react-pdf performs real layout: Page padding provides
//! uniform margins, content paginates without cutting lines, and output remains compact selectable text.
//!
//! react-pdf-html leaked `<code class=...>` markup as text and mishandled list markers. Instead,
//! `marked` parses Markdown into tokens that map directly and deterministically to react-pdf components.
//!
//! react-pdf cannot use system fonts, so Noto Sans SC Regular and Bold are embedded to cover CJK and Latin text.
//!
//! react-pdf inserts hyphens at word-break points, including long unspaced mixed-language strings.
//! Disable its Latin hyphenation and insert zero-width spaces (U+200B) as clean break opportunities;
//! breaks there add no hyphen. See softBreak.
//!
//! DocView imports this module only during export, keeping fonts and react-pdf off the document-open path.

import { Document, Font, Link, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer";
import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import notoRegular from "../../../assets/fonts/NotoSansSC-Regular.ttf?url";
import notoBold from "../../../assets/fonts/NotoSansSC-Bold.ttf?url";

/** Resolved `#rrggbb` editor theme colors used to match PDF appearance. */
export interface DocPdfTheme {
  bg: string;
  text: string;
  muted: string;
  link: string;
  codeBg: string;
  codeText: string;
  border: string;
}

const ZWSP = "​";
// CJK and full-width punctuation characters after which a line may break.
const CJK_RE = /[⺀-⻿　-〿㐀-鿿豈-﫿＀-￯]/;
/** Insert zero-width spaces after CJK characters and path/identifier separators (`/ . _ -`) to give
 * react-pdf clean line-break points without hyphens. Latin words remain intact. */
function softBreak(s: string): string {
  let out = "";
  for (const ch of s) {
    out += ch;
    if (CJK_RE.test(ch) || ch === "/" || ch === "." || ch === "_" || ch === "-") out += ZWSP;
  }
  return out;
}

let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  Font.register({
    family: "NotoSC",
    fonts: [
      { src: notoRegular, fontWeight: "normal" },
      { src: notoBold, fontWeight: "bold" },
    ],
  });
  // Disable react-pdf's Latin hyphenation, which could split "automation" as "auto-mation". Return
  // whole words and rely on softBreak's zero-width spaces for line-break opportunities.
  Font.registerHyphenationCallback((word) => [word]);
  fontReady = true;
}

function makeStyles(t: DocPdfTheme) {
  return StyleSheet.create({
    page: {
      paddingTop: 42,
      paddingBottom: 48,
      paddingLeft: 46,
      paddingRight: 46,
      backgroundColor: t.bg,
      color: t.text,
      fontFamily: "NotoSC",
      fontSize: 10.5,
      lineHeight: 1.6,
    },
    h1: { fontSize: 21, fontWeight: "bold", marginTop: 16, marginBottom: 8, lineHeight: 1.3 },
    h2: { fontSize: 17, fontWeight: "bold", marginTop: 15, marginBottom: 6, lineHeight: 1.3 },
    h3: { fontSize: 14.5, fontWeight: "bold", marginTop: 13, marginBottom: 5, lineHeight: 1.35 },
    h4: { fontSize: 12.5, fontWeight: "bold", marginTop: 11, marginBottom: 4, lineHeight: 1.4 },
    h5: { fontSize: 11.5, fontWeight: "bold", marginTop: 9, marginBottom: 4 },
    h6: { fontSize: 11, fontWeight: "bold", marginTop: 9, marginBottom: 4, color: t.muted },
    p: { fontSize: 10.5, marginBottom: 6, lineHeight: 1.7 },
    link: { color: t.link },
    codeInline: { fontSize: 9.5, color: t.codeText, backgroundColor: t.codeBg },
    pre: { backgroundColor: t.codeBg, borderRadius: 4, padding: 8, marginTop: 6, marginBottom: 8 },
    preText: { fontSize: 9, color: t.text, lineHeight: 1.5 },
    blockquote: { borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: 10, marginTop: 6, marginBottom: 8 },
    hr: { borderBottomWidth: 1, borderBottomColor: t.border, marginTop: 10, marginBottom: 10 },
    list: { marginTop: 2, marginBottom: 6, paddingLeft: 4 },
    li: { flexDirection: "row", marginBottom: 3 },
    marker: { width: 16, fontSize: 10.5, lineHeight: 1.7 },
    liBody: { flex: 1 },
    liText: { fontSize: 10.5, lineHeight: 1.7 },
    table: { marginTop: 6, marginBottom: 8, borderWidth: 1, borderColor: t.border, borderBottomWidth: 0, borderRightWidth: 0 },
    tr: { flexDirection: "row" },
    cell: { flex: 1, padding: 4, borderColor: t.border, borderRightWidth: 1, borderBottomWidth: 1 },
    thText: { fontSize: 9.5, fontWeight: "bold" },
    tdText: { fontSize: 9.5 },
    thFill: { backgroundColor: t.codeBg },
  });
}

type S = ReturnType<typeof makeStyles>;

/** Render inline tokens such as emphasis, code, and links into react-pdf text nodes. */
function inline(tokens: Token[] | undefined, s: S, kp: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((tk, i): ReactNode => {
    const key = `${kp}.${i}`;
    switch (tk.type) {
      case "text": {
        const sub = (tk as Tokens.Text).tokens;
        return sub ? <Text key={key}>{inline(sub, s, key)}</Text> : softBreak((tk as Tokens.Text).text);
      }
      case "escape":
        return softBreak((tk as Tokens.Escape).text);
      case "strong":
        return (
          <Text key={key} style={{ fontWeight: "bold" }}>
            {inline((tk as Tokens.Strong).tokens, s, key)}
          </Text>
        );
      case "em":
        // The CJK font has no italic face; render emphasis at regular weight to avoid missing-font errors.
        return <Text key={key}>{inline((tk as Tokens.Em).tokens, s, key)}</Text>;
      case "del":
        return (
          <Text key={key} style={{ textDecoration: "line-through" }}>
            {inline((tk as Tokens.Del).tokens, s, key)}
          </Text>
        );
      case "codespan":
        // Do not insert zero-width spaces into code, preserving clean copied text.
        return (
          <Text key={key} style={s.codeInline}>
            {(tk as Tokens.Codespan).text}
          </Text>
        );
      case "link":
        return (
          <Link key={key} src={(tk as Tokens.Link).href} style={s.link}>
            {inline((tk as Tokens.Link).tokens, s, key)}
          </Link>
        );
      case "br":
        return "\n";
      case "image":
        return (
          <Text key={key} style={s.link}>
            {softBreak((tk as Tokens.Image).text || (tk as Tokens.Image).href)}
          </Text>
        );
      case "html":
        return null;
      default: {
        const txt = (tk as { text?: string }).text;
        return txt ? softBreak(txt) : null;
      }
    }
  });
}

/** Render block tokens into react-pdf elements. */
function blocks(tokens: Token[] | undefined, s: S, kp: string): ReactNode[] {
  const out: ReactNode[] = [];
  if (!tokens) return out;
  tokens.forEach((tk, i) => {
    const key = `${kp}.${i}`;
    switch (tk.type) {
      case "heading": {
        const h = tk as Tokens.Heading;
        const style = [s.h1, s.h2, s.h3, s.h4, s.h5, s.h6][Math.min(h.depth, 6) - 1] || s.h6;
        out.push(
          <Text key={key} style={style}>
            {inline(h.tokens, s, key)}
          </Text>,
        );
        break;
      }
      case "paragraph":
        out.push(
          <Text key={key} style={s.p}>
            {inline((tk as Tokens.Paragraph).tokens, s, key)}
          </Text>,
        );
        break;
      case "text": {
        const tt = tk as Tokens.Text;
        out.push(
          <Text key={key} style={s.liText}>
            {tt.tokens ? inline(tt.tokens, s, key) : softBreak(tt.text)}
          </Text>,
        );
        break;
      }
      case "code":
        out.push(
          <View key={key} style={s.pre}>
            <Text style={s.preText}>{(tk as Tokens.Code).text}</Text>
          </View>,
        );
        break;
      case "blockquote":
        out.push(
          <View key={key} style={s.blockquote}>
            {blocks((tk as Tokens.Blockquote).tokens, s, key)}
          </View>,
        );
        break;
      case "list": {
        const l = tk as Tokens.List;
        out.push(
          <View key={key} style={s.list}>
            {l.items.map((it, j) => (
              <View key={`${key}-${j}`} style={s.li}>
                <Text style={s.marker}>{l.ordered ? `${Number(l.start || 1) + j}.` : "•"}</Text>
                <View style={s.liBody}>{blocks(it.tokens, s, `${key}-${j}`)}</View>
              </View>
            ))}
          </View>,
        );
        break;
      }
      case "table": {
        const tb = tk as Tokens.Table;
        out.push(
          <View key={key} style={s.table}>
            <View style={s.tr}>
              {tb.header.map((c, j) => (
                <View key={j} style={[s.cell, s.thFill]}>
                  <Text style={s.thText}>{inline(c.tokens, s, `${key}h${j}`)}</Text>
                </View>
              ))}
            </View>
            {tb.rows.map((row, r) => (
              <View key={r} style={s.tr}>
                {row.map((c, j) => (
                  <View key={j} style={s.cell}>
                    <Text style={s.tdText}>{inline(c.tokens, s, `${key}r${r}c${j}`)}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>,
        );
        break;
      }
      case "hr":
        out.push(<View key={key} style={s.hr} />);
        break;
      case "space":
        break;
      case "html":
        break;
      default: {
        const sub = (tk as { tokens?: Token[] }).tokens;
        if (sub) out.push(...blocks(sub, s, key));
        break;
      }
    }
  });
  return out;
}

/** Generate an A4 PDF Blob from Markdown with uniform margins, automatic pagination, intact lines,
 * and a full-page theme background. */
export async function buildDocPdfBlob(markdown: string, theme: DocPdfTheme): Promise<Blob> {
  ensureFont();
  const s = makeStyles(theme);
  const tokens = marked.lexer(markdown);

  const docNode = (
    <Document>
      <Page size="A4" style={s.page} wrap>
        {blocks(tokens, s, "b")}
      </Page>
    </Document>
  );

  return await pdf(docNode).toBlob();
}
