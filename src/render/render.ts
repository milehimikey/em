// SPDX-License-Identifier: MIT
// Renders a model to an image.
//
// Graphviz (bundled as WebAssembly) lays out the grid and renders boxes/labels
// to SVG; it does NOT route the arrows. We read each box's rectangle back out of
// that SVG, draw the edges ourselves (straight within a slice, curved across
// slices) plus the note markers, and inject them. SVG is written directly; PNG
// is rasterized in-process with resvg. PDF/other formats use an optional system
// `rsvg-convert` if one is installed. No system Graphviz is required.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { Resvg } from "@resvg/resvg-js";
import { Element, NormalizedModel } from "../model/model.js";
import { Grid } from "../layout/grid.js";
import { fitCanvas, parseNodeRects } from "./svgGeometry.js";
import { buildEdgeOverlay } from "./drawEdges.js";
import { buildNoteMarkers, buildIssueMarkers, buildDivergenceMarkers, appendNoteLegend } from "./drawNotes.js";
import { sliceOverlayIds, tagSliceAttrs, buildSliceOverlay } from "./sliceOverlay.js";
import { readSliceStatuses } from "./sliceStatus.js";
import { applyStatusColors, appendStatusLegend } from "./statusOverlay.js";

const RSVG_BIN = process.env.EM_RSVG || "rsvg-convert";

// The WASM Graphviz module is loaded once and reused across renders.
let graphvizModule: Promise<Graphviz> | undefined;
function graphviz(): Promise<Graphviz> {
  return (graphvizModule ??= Graphviz.load());
}

export function formatFromPath(outPath: string, fallback = "svg"): string {
  const ext = extname(outPath).replace(/^\./, "").toLowerCase();
  return ext || fallback;
}

/** Run the Graphviz WASM layout pass only — the part shared by every caller that
 *  needs to compose the same layout for more than one output location (a full
 *  diagram and a slice diagram of it, note hrefs recomputed for each — see
 *  buildCatalog and `em render --slice`), so it isn't paid for twice. */
export async function layoutDot(dot: string): Promise<string> {
  const gv = await graphviz();
  return gv.layout(dot, "svg", "dot");
}

/**
 * Compose a laid-out SVG with edges, notes, slice tags/metadata, and the legend —
 * the pure/string half of rendering, split out from layoutDot's WASM call. `outDir`
 * is where the composed SVG will ultimately be written; note links are authored
 * relative to `baseDir` (the .em file) and get rewritten relative to `outDir` here,
 * so a caller composing the *same* layout for two different output locations (e.g.
 * a full diagram and a slice diagram one directory deeper) must call this twice,
 * once per real outDir, rather than reuse one composed string for both.
 */
export function composeSvg(
  rawSvg: string,
  model: NormalizedModel,
  grid: Grid,
  baseDir: string,
  outDir: string,
): string {
  const hrefOf = (el: Element) => noteHref(el.note ?? "", baseDir, outDir);
  const statuses = readSliceStatuses(model, baseDir);
  return withOverlays(rawSvg, model, grid, hrefOf, statuses);
}

/** Serialize a composed SVG string to `outPath` in the requested format — split out
 *  so a caller can transform the composed string in between composing and writing it. */
export async function writeRendered(
  svg: string,
  outPath: string,
  format = formatFromPath(outPath),
): Promise<void> {
  if (format === "svg") {
    await writeFile(outPath, svg, "utf8");
    return;
  }

  if (format === "png") {
    const png = new Resvg(svg).render().asPng();
    await writeFile(outPath, png);
    return;
  }

  // Other formats (pdf, ps, …) aren't built in; use a system rsvg-convert if present.
  if (await hasBin(RSVG_BIN)) {
    await rsvgConvert(svg, outPath, format);
    return;
  }

  throw new Error(
    `format '${format}' is not built in (svg and png are). Install librsvg ` +
      `(provides '${RSVG_BIN}') to render '${format}', or use -o file.svg / -o file.png.`,
  );
}

export async function renderDot(
  dot: string,
  model: NormalizedModel,
  grid: Grid,
  outPath: string,
  format = formatFromPath(outPath),
  baseDir = process.cwd(),
): Promise<void> {
  const outDir = dirname(outPath);
  const raw = await layoutDot(dot);
  const svg = composeSvg(raw, model, grid, baseDir, outDir);
  await writeRendered(svg, outPath, format);
}

/**
 * Resolve a note path (authored relative to the .em file) into an href relative
 * to the output SVG's directory, so links stay valid wherever the SVG is
 * written. URLs and absolute paths are passed through untouched.
 */
export function noteHref(note: string, baseDir: string, outDir: string): string {
  if (!note) return note;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(note) || isAbsolute(note)) return note;
  const rel = relative(outDir, resolve(baseDir, note)) || note;
  return rel.split(sep).join("/"); // posix separators for URLs
}

/** Draw the semantic edges and note markers into a Graphviz-rendered SVG. */
function withOverlays(
  svg: string,
  model: NormalizedModel,
  grid: Grid,
  hrefOf: (el: Element) => string,
  statuses: (string | null)[],
): string {
  const rects = parseNodeRects(svg, new Set([...model.byId.keys(), ...sliceOverlayIds(grid)]));
  const { defs, group, bbox } = buildEdgeOverlay(model, rects);
  const notes = buildNoteMarkers(model, rects, hrefOf);
  const issues = buildIssueMarkers(model, rects);
  const divergences = buildDivergenceMarkers(model, rects);

  // an edge detour can run outside the box grid Graphviz sized the canvas for, so make
  // room before anything else measures or appends to the viewBox
  let out = fitCanvas(svg, bbox);
  // recolor each slice's header cell per its doc status (src/render/sliceStatus.ts) —
  // a scoped string replace keyed on each header's own <title> id, independent of
  // tagSliceAttrs/buildSliceOverlay below, so the ordering here isn't load-bearing.
  out = applyStatusColors(out, grid, statuses);
  // tag each element's node group with data-slice="<index>" so the storyboard
  // viewer (`em watch --serve`) can highlight/zoom to one slice at a time
  // client-side, purely from what's already in the SVG.
  out = tagSliceAttrs(out, model);
  const sliceOverlay = buildSliceOverlay(out, grid, rects);
  // arrowhead markers + slice metadata/style go just inside <svg …>
  out = out.replace(/(<svg\b[^>]*>)/, `$1${defs}${sliceOverlay}`);
  // edges go under the boxes: just before the first node group
  const nodeAt = out.search(/<g\b[^>]*class="node"[^>]*>/);
  if (nodeAt >= 0) out = out.slice(0, nodeAt) + group + out.slice(nodeAt);
  else out = out.replace(/<\/svg>/, `${group}</svg>`);
  // note/issue/divergence markers go on top of the boxes — inside the graph transform
  // group (so they share the box coordinate space) but after every node, as the last
  // children of that group, making them the topmost clickable layer.
  out = out.replace(/(<\/g>\s*)(<\/svg>)/, `${notes}${issues}${divergences}$1$2`);
  // grow the canvas and append the legend below the diagram (root coords)
  out = appendNoteLegend(out, model, hrefOf);
  out = appendStatusLegend(out, grid, statuses);
  return out;
}

/** Convert an SVG string to the requested format with an optional system rsvg-convert. */
function rsvgConvert(svg: string, outPath: string, format: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(RSVG_BIN, [`--format=${format}`, "-o", outPath]);
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => rej(new Error(`failed to run '${RSVG_BIN}': ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`${RSVG_BIN} exited with code ${code}: ${err.trim()}`)),
    );
    child.stdin.write(svg);
    child.stdin.end();
  });
}

function hasBin(bin: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn(bin, ["--version"]);
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}
