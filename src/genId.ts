//! Generate random IDs for panes, temporary sessions, and similar objects.
//!
//! ⚠️ Do not call `crypto.randomUUID()` directly: it is available **only in secure contexts (HTTPS / localhost)**.
//! Remote browser access uses plaintext `http://<LAN-IP>`, which is not a secure context, so
//! `crypto.randomUUID` is undefined there. Calling it throws `crypto.randomUUID is not a function` and breaks
//! every ID-generating interaction, such as opening sessions or splitting panes. Always use this helper: prefer
//! `randomUUID`, fall back to `crypto.getRandomValues`, which also works in insecure contexts, and finally use
//! `Math.random`; these IDs do not require cryptographic strength.

export function genId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
