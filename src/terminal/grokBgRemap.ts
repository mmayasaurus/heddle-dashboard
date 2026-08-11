//! Remap GrokDay canvas grays to pure white for VelaTerm light terminals.
//!
//! Grok Build's current GrokDay theme paints its main canvas as `#eeeeee` (truecolor 238,238,238). That reads
//! as a dull gray next to Codex's pure-white analysis pane. User chat bars use slightly darker grays
//! (`#dedede`, 222) and should stay gray so dialogue remains visually distinct.
//!
//! Rewrite only near-white truecolor *background* SGR / OSC 11 values. Foreground colors and darker
//! grays are left alone.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Truecolor background components that should become pure white (GrokDay canvas). */
function isCanvasGray(r: number, g: number, b: number): boolean {
  // Current GrokDay uses #eeeeee (238) for the canvas and #eaeaea (234) for scrollbar areas.
  // Keep the distinctly darker #dedede (222) user prompt bar intact.
  if (r < 230 || g < 230 || b < 230) return false;
  if (r > 254 && g > 254 && b > 254) return false; // already white-ish
  return Math.max(r, g, b) - Math.min(r, g, b) <= 10;
}

/** Rewrite one SGR parameter body (contents between CSI and final `m`). */
function rewriteSgrBody(body: string): string {
  // ITU colon form: 48:2::r:g:b or 48:2:r:g:b
  let out = body.replace(
    /48:2:?:?(\d+):(\d+):(\d+)/g,
    (full, rs: string, gs: string, bs: string) => {
      const r = Number(rs);
      const g = Number(gs);
      const b = Number(bs);
      return isCanvasGray(r, g, b) ? "48:2::255:255:255" : full;
    },
  );
  // Semicolon form: 48;2;r;g;b, or the ISO-8613-6 color-space form emitted by Grok:
  // 48;2;;r;g;b (the empty field means the default color space).
  out = out.replace(
    /48;2;(;?)(\d+);(\d+);(\d+)/g,
    (full, colorSpace: string, rs: string, gs: string, bs: string) => {
      const r = Number(rs);
      const g = Number(gs);
      const b = Number(bs);
      return isCanvasGray(r, g, b)
        ? `48;2;${colorSpace}255;255;255`
        : full;
    },
  );
  return out;
}

function rewriteOsc11(payload: string): string {
  // rgb:RRRR/GGGG/BBBB (16-bit hex components, often repeated bytes)
  const rgb = payload.match(/^rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)$/);
  if (rgb) {
    const to8 = (h: string) => parseInt(h.length >= 2 ? h.slice(0, 2) : h, 16);
    const r = to8(rgb[1]);
    const g = to8(rgb[2]);
    const b = to8(rgb[3]);
    if (isCanvasGray(r, g, b)) return "rgb:ffff/ffff/ffff";
    return payload;
  }
  // #rrggbb
  const hash = payload.match(/^#([0-9a-fA-F]{6})$/);
  if (hash) {
    const n = parseInt(hash[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    if (isCanvasGray(r, g, b)) return "#ffffff";
  }
  return payload;
}

/**
 * Map GrokDay's near-white canvas backgrounds to pure white.
 * Incomplete escape sequences at chunk boundaries pass through unchanged (rare; next full chunk redraws).
 */
export function remapGrokDayCanvasToWhite(bytes: Uint8Array): Uint8Array {
  let hasEsc = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1b) {
      hasEsc = true;
      break;
    }
  }
  if (!hasEsc) return bytes;

  let s = decoder.decode(bytes);
  // SGR ... m
  s = s.replace(/\x1b\[([0-9;:]*)m/g, (_full, body: string) => {
    if (!body.includes("48")) return `\x1b[${body}m`;
    return `\x1b[${rewriteSgrBody(body)}m`;
  });
  // OSC 11 ; <color> ST/BEL
  s = s.replace(/\x1b\]11;([^\x07\x1b]*)(\x07|\x1b\\)/g, (_full, payload: string, term: string) => {
    return `\x1b]11;${rewriteOsc11(payload)}${term}`;
  });

  // Avoid re-encoding when unchanged.
  const out = encoder.encode(s);
  if (out.length === bytes.length) {
    let same = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== bytes[i]) {
        same = false;
        break;
      }
    }
    if (same) return bytes;
  }
  return out;
}
