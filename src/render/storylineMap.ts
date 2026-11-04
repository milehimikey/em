// SPDX-License-Identifier: MIT
// The storyline canvas (`em render --map`, owner ruling 2026-11-03): one self-contained HTML page
// with every storyline's real diagram in a draggable frame and the flow between storylines drawn
// as connectors between frames. No server, no external assets: open `storylines/map.html` from
// disk. Frame positions are remembered per model in the browser's localStorage ("Reset layout"
// forgets them); the first layout places root storylines left and every `after` storyline one
// column to the right of what it follows.

import { NormalizedModel } from "../model/model.js";
import { StorylineMap } from "../model/storylineMap.js";

export interface StorylineFrame {
  name: string;
  slug: string;
  sliceCount: number;
  /** The storyline's own rendered SVG (render/storylineDiagram.ts through composeSvg). */
  svg: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildStorylineMapHtml(model: NormalizedModel, frames: StorylineFrame[], map: StorylineMap): string {
  const title = `${model.name} — storylines`;
  const data = {
    model: model.name,
    nodes: map.nodes.map((n) => ({ name: n.name, slug: n.slug, after: n.after })),
    edges: map.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      labels: e.elementIds.map((id) => model.byId.get(id)?.name ?? id),
    })),
  };
  const frameHtml = frames
    .map(
      (f) =>
        `<section class="frame" data-name="${esc(f.name)}" data-slug="${esc(f.slug)}">` +
        `<header><span class="title">${esc(f.name)}</span><span class="meta">${f.sliceCount} slice${f.sliceCount === 1 ? "" : "s"}</span>` +
        `<a class="open" href="./${esc(f.slug)}.svg" target="_blank" title="open this storyline's diagram">↗</a></header>` +
        `<div class="body">${f.svg}</div></section>`,
    )
    .join("\n");
  // `</script>` can't appear in the JSON (names are model text; the escape keeps it safe anyway).
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, sans-serif; background: #f3f4f6; overflow: hidden; }
  header.bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; display: flex; align-items: center; gap: .75rem;
    padding: 0 .9rem; background: #1f2933; color: #fff; font-size: 14px; z-index: 10; }
  header.bar .title { font-weight: 600; }
  header.bar .hint { opacity: .7; margin-left: auto; }
  header.bar button { background: #334155; color: #fff; border: 0; border-radius: 4px; padding: .25rem .6rem; cursor: pointer; font-size: 13px; }
  header.bar button:hover { background: #475569; }
  #viewport { position: absolute; inset: 40px 0 0 0; overflow: hidden; cursor: grab; }
  #viewport.panning { cursor: grabbing; }
  #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  svg.links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  svg.links text { font-size: 12px; font-family: system-ui, sans-serif; }
  .frame { position: absolute; background: #fff; border: 2px solid #4a6fb5; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.12);
    display: flex; flex-direction: column; overflow: hidden; }
  .frame header { display: flex; align-items: center; gap: .6rem; padding: .35rem .6rem; background: #dbe7fb; color: #1e3a8a;
    font-size: 13px; cursor: move; user-select: none; }
  .frame header .title { font-weight: 700; }
  .frame header .meta { opacity: .75; }
  .frame header .open { margin-left: auto; color: #1e3a8a; text-decoration: none; font-weight: 700; cursor: pointer; }
  .frame .body { flex: 1; min-height: 0; background: #fff; padding: 16px; box-sizing: border-box; }
  .frame .body svg { width: 100%; height: 100%; display: block; }
  .frame.dragging { box-shadow: 0 6px 24px rgba(0,0,0,.25); z-index: 5; }
</style>
</head>
<body>
<header class="bar">
  <span class="title">${esc(title)}</span>
  <button id="fit" type="button">Fit</button>
  <button id="reset" type="button">Reset layout</button>
  <span class="hint">drag a frame's title to move it · drag the background to pan · wheel to zoom</span>
</header>
<div id="viewport"><div id="world"><svg class="links" width="1" height="1">
  <defs>
    <marker id="m-after" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a6fb5"/></marker>
    <marker id="m-reads" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#b36b00"/></marker>
  </defs>
  <g id="link-paths"></g><g id="link-labels"></g>
</svg>
${frameHtml}
</div></div>
<script id="map-data" type="application/json">${json}</script>
<script>
(() => {
  const DATA = JSON.parse(document.getElementById("map-data").textContent);
  const KEY = "em-storyline-map:" + DATA.model;
  const SCALE = 0.3;          // diagram units -> frame pixels at zoom 1
  const PAD = 16, HEAD = 34;  // frame body padding (each side) and the title bar's height
  const GAP_X = 160, GAP_Y = 90;
  const viewport = document.getElementById("viewport");
  const world = document.getElementById("world");
  const links = world.querySelector("svg.links");
  const paths = document.getElementById("link-paths");
  const labels = document.getElementById("link-labels");
  const frames = [...world.querySelectorAll(".frame")];
  const byName = new Map(frames.map((f) => [f.dataset.name, f]));

  // --- frame size from each diagram's own viewBox, so a 3-slice story is small and a 29-slice one is wide
  for (const f of frames) {
    const svg = f.querySelector("svg");
    const vb = (svg && svg.getAttribute("viewBox") || "0 0 1200 600").split(/\\s+/).map(Number);
    const w = Math.max(240, vb[2] * SCALE) + 2 * PAD, h = Math.max(120, vb[3] * SCALE) + 2 * PAD + HEAD;
    f.style.width = w + "px"; f.style.height = h + "px";
    if (svg) { svg.removeAttribute("width"); svg.removeAttribute("height"); svg.setAttribute("preserveAspectRatio", "xMinYMin meet"); }
  }

  // --- state: positions + camera, remembered per model
  let state = { pos: {}, cam: { x: 24, y: 24, s: 1 } };
  try { const saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved && saved.pos) state = saved; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  function autoLayout() {
    // column = depth along the after chain; rows stack within a column
    const depth = new Map();
    const nodeByName = new Map(DATA.nodes.map((n) => [n.name, n]));
    const depthOf = (name, seen = new Set()) => {
      if (depth.has(name)) return depth.get(name);
      const n = nodeByName.get(name);
      let d = 0;
      if (n && n.after && nodeByName.has(n.after) && !seen.has(name)) { seen.add(name); d = depthOf(n.after, seen) + 1; }
      depth.set(name, d); return d;
    };
    for (const n of DATA.nodes) depthOf(n.name);
    const cols = new Map();
    for (const n of DATA.nodes) { const d = depth.get(n.name) || 0; if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n.name); }
    let x = 0;
    state.pos = {};
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      let y = 0, colW = 0;
      for (const name of cols.get(d)) {
        const f = byName.get(name); if (!f) continue;
        state.pos[f.dataset.slug] = { x, y };
        y += f.offsetHeight + GAP_Y; colW = Math.max(colW, f.offsetWidth);
      }
      x += colW + GAP_X;
    }
  }
  if (!frames.every((f) => state.pos[f.dataset.slug])) autoLayout();

  function applyPositions() {
    for (const f of frames) { const p = state.pos[f.dataset.slug] || { x: 0, y: 0 }; f.style.left = p.x + "px"; f.style.top = p.y + "px"; }
    drawLinks();
  }
  function applyCamera() { world.style.transform = "translate(" + state.cam.x + "px," + state.cam.y + "px) scale(" + state.cam.s + ")"; }

  // --- connectors: centre-to-centre line clipped to each frame's border; labels at the midpoint
  function rectOf(f) { const p = state.pos[f.dataset.slug] || { x: 0, y: 0 }; return { x: p.x, y: p.y, w: f.offsetWidth, h: f.offsetHeight }; }
  function exitPoint(r, tx, ty) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? (r.w / 2) / Math.abs(dx) : Infinity, sy = dy !== 0 ? (r.h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  function drawLinks() {
    paths.innerHTML = ""; labels.innerHTML = "";
    const NS = "http://www.w3.org/2000/svg";
    for (const e of DATA.edges) {
      const a = byName.get(e.from), b = byName.get(e.to); if (!a || !b) continue;
      const ra = rectOf(a), rb = rectOf(b);
      const bc = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 }, ac = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 };
      const p1 = exitPoint(ra, bc.x, bc.y), p2 = exitPoint(rb, ac.x, ac.y);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", "M" + p1.x + "," + p1.y + " L" + p2.x + "," + p2.y);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", e.kind === "after" ? "#4a6fb5" : "#b36b00");
      path.setAttribute("stroke-width", e.kind === "after" ? "4" : "2");
      if (e.kind !== "after") path.setAttribute("stroke-dasharray", "8 6");
      path.setAttribute("marker-end", "url(#m-" + e.kind + ")");
      paths.appendChild(path);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const text = e.kind === "after" ? "after" : (e.labels.slice(0, 3).join(", ") + (e.labels.length > 3 ? " +" + (e.labels.length - 3) : ""));
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", mx); t.setAttribute("y", my - 6); t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", e.kind === "after" ? "#4a6fb5" : "#7a4a00");
      if (e.kind === "after") t.setAttribute("font-weight", "700");
      t.setAttribute("paint-order", "stroke"); t.setAttribute("stroke", "#f3f4f6"); t.setAttribute("stroke-width", "4");
      t.textContent = text;
      labels.appendChild(t);
    }
  }

  // --- interaction: drag frames by their header, pan the background, zoom with the wheel
  let drag = null;
  for (const f of frames) {
    f.querySelector("header").addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("a")) return;
      const p = state.pos[f.dataset.slug];
      drag = { f, sx: ev.clientX, sy: ev.clientY, ox: p.x, oy: p.y };
      f.classList.add("dragging"); f.setPointerCapture(ev.pointerId); ev.preventDefault(); ev.stopPropagation();
    });
    f.addEventListener("pointermove", (ev) => {
      if (!drag || drag.f !== f) return;
      state.pos[f.dataset.slug] = { x: drag.ox + (ev.clientX - drag.sx) / state.cam.s, y: drag.oy + (ev.clientY - drag.sy) / state.cam.s };
      applyPositions();
    });
    const end = () => { if (drag && drag.f === f) { f.classList.remove("dragging"); drag = null; save(); } };
    f.addEventListener("pointerup", end); f.addEventListener("pointercancel", end);
  }
  let pan = null;
  viewport.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest(".frame")) return;
    pan = { sx: ev.clientX, sy: ev.clientY, ox: state.cam.x, oy: state.cam.y };
    viewport.classList.add("panning"); viewport.setPointerCapture(ev.pointerId);
  });
  viewport.addEventListener("pointermove", (ev) => {
    if (!pan) return;
    state.cam.x = pan.ox + (ev.clientX - pan.sx); state.cam.y = pan.oy + (ev.clientY - pan.sy); applyCamera();
  });
  const endPan = () => { if (pan) { pan = null; viewport.classList.remove("panning"); save(); } };
  viewport.addEventListener("pointerup", endPan); viewport.addEventListener("pointercancel", endPan);
  viewport.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const s = Math.min(4, Math.max(0.05, state.cam.s * factor));
    state.cam.x = mx - (mx - state.cam.x) * (s / state.cam.s);
    state.cam.y = my - (my - state.cam.y) * (s / state.cam.s);
    state.cam.s = s; applyCamera(); save();
  }, { passive: false });

  function fit() {
    if (frames.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of frames) { const r = rectOf(f); minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); }
    const vw = viewport.clientWidth, vh = viewport.clientHeight, pad = 32;
    const s = Math.min(4, Math.max(0.05, Math.min((vw - 2 * pad) / (maxX - minX), (vh - 2 * pad) / (maxY - minY))));
    state.cam = { s, x: pad - minX * s + ((vw - 2 * pad) - (maxX - minX) * s) / 2, y: pad - minY * s + ((vh - 2 * pad) - (maxY - minY) * s) / 2 };
    applyCamera(); save();
  }
  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("reset").addEventListener("click", () => { autoLayout(); applyPositions(); fit(); });

  applyPositions();
  if (!localStorage.getItem(KEY)) fit(); else applyCamera();
})();
</script>
</body>
</html>
`;
}
