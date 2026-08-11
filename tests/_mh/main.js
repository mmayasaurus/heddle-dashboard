// Final verification on a dark background:
//  (A) Current behavior: Mermaid's default htmlLabels (foreignObject) + SVG-only DOMPurify removes labels.
//  (B) Proposed fix: htmlLabels:false (labels become <text>) + the same SVG-only DOMPurify preserves them.
import mermaid from "mermaid";
import DOMPurify from "dompurify";

document.documentElement.dataset.theme = "dark";
document.body.style.background = "#16181a"; // Simulate the app's dark editor background.
document.body.style.color = "#ddd";

const app = document.getElementById("app");
const out = document.getElementById("out");
const log = (...a) => { const d = document.createElement("div"); d.textContent = a.join(" "); out.appendChild(d); };

const SRC = `flowchart TD
    A[User types in the terminal] --> B[xterm.js DOM renderer]
    B --> C[IPC command layer]
    C -->|invoke| D[Tauri backend]
    E --> F[(Child process shell)]`;

function box(title, bg) {
  const w = document.createElement("div");
  w.style.cssText = `margin:16px; padding:14px; border:1px solid #333; border-radius:8px; background:${bg}; display:flex; justify-content:center`;
  const h = document.createElement("div"); h.textContent = title; h.style.cssText = "position:absolute; margin-top:-26px; font:12px monospace; color:#8af";
  w.appendChild(h);
  app.appendChild(w);
  return w;
}

let idn = 0;
async function renderCase(tag, htmlLabels, container) {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", flowchart: { htmlLabels }, htmlLabels });
  const { svg } = await mermaid.render("mhid" + idn++, SRC);
  const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
  container.innerHTML += clean;
  // Count the text/label nodes that remain after sanitization.
  const tmp = document.createElement("div"); tmp.innerHTML = clean;
  const texts = tmp.querySelectorAll("text, foreignObject");
  const visibleText = (tmp.textContent || "").replace(/\s+/g, "");
  log(`${tag}: text/foreignObject nodes=${texts.length} | visible text="${visibleText.slice(0, 30)}"`);
}

app.style.cssText = "flex:1; padding:8px; position:relative";
await renderCase("A-current(htmlLabels defaults to true)", true, box("A current behaviour (labels lost)", "#16181a"));
await renderCase("B-fix(htmlLabels=false)", false, box("B proposed fix (htmlLabels:false)", "#16181a"));
log("=== comparison complete ===");
