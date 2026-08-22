// SPDX-License-Identifier: MIT
// Renders a model to an image.
//
// Graphviz (bundled as WebAssembly) lays out the grid and renders boxes/labels
// to SVG; it does NOT route the arrows. We read each box's rectangle back out of
// that SVG, draw the edges ourselves (straight within a slice, curved across
// slices) plus the note markers, and inject them. SVG is written directly; PNG
// is rasterized in-process with resvg; PDF is composed in-process with pdfkit +
// svg-to-pdfkit (MIL-26 — both pure JS, no native deps, same "self-contained
// rendering" posture as resvg's PNG path). Any other format (ps, eps, ...) falls
// back to an optional system `rsvg-convert` if one is installed — genuinely rare
// formats aren't worth a bespoke in-process path. No system Graphviz is required.

import { spawn } from "node:child_process";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { Resvg } from "@resvg/resvg-js";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
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
  // Write to a tmp sibling, then rename over outPath: rename within one directory
  // (same filesystem) is atomic, so a concurrent reader — the live viewer fetching
  // mid-render, an open editor preview — never sees a truncated file. On any
  // failure the tmp is unlinked best-effort so a crashed render leaves no litter.
  // The pid in the tmp name keeps concurrent em processes targeting the same
  // output (an `em watch --serve` plus a one-off `em render`) from promoting
  // each other's half-written bytes; within one process, watch already
  // serializes builds.
  const tmp = `${outPath}.${process.pid}.tmp`;
  try {
    if (format === "svg") {
      await writeFile(tmp, svg, "utf8");
    } else if (format === "png") {
      await writeFile(tmp, new Resvg(svg).render().asPng());
    } else if (format === "pdf") {
      await writeFile(tmp, await svgToPdfBuffer(svg));
    } else if (await hasBin(RSVG_BIN)) {
      // Anything else (ps, eps, …) isn't built in; a system rsvg-convert writes the
      // tmp itself (--format is explicit, so the .tmp extension doesn't mislead it)
      // and the rename below only happens after a clean exit.
      await rsvgConvert(svg, tmp, format);
    } else {
      throw new Error(
        `format '${format}' is not built in (svg, png, and pdf are). Install librsvg ` +
          `(provides '${RSVG_BIN}') to render '${format}', or use -o file.svg / -o file.png / -o file.pdf.`,
      );
    }
    await rename(tmp, outPath);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Render a composed SVG string to a PDF buffer, in-process — pdfkit + svg-to-pdfkit,
 * both pure JS, no native deps or system binary (MIL-26). Page size matches the SVG's
 * own viewBox/width/height exactly (Graphviz's "pt" units already map 1:1 to PDF points),
 * so the PDF isn't cropped or rescaled relative to the PNG/SVG siblings of the same render.
 */
function svgToPdfBuffer(svg: string): Promise<Buffer> {
  const { width, height } = svgDimensions(svg);
  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  SVGtoPDF(doc, svg, 0, 0, {
    // Graphviz's own SVG output is in points already — treat px-less numeric
    // coordinates as pt directly instead of applying the library's default
    // 96dpi assumption, or the whole diagram would render at the wrong scale.
    assumePt: true,
    // svg-to-pdfkit's default warningCallback is `console.warn` — anything it can't
    // render (an unsupported feature, a malformed value) would otherwise print
    // straight to the terminal on every `em render -o file.pdf`. Swallow instead:
    // the composed SVG is em's own output, not untrusted input, so a best-effort
    // PDF sibling to the SVG/PNG outputs is the right default, not a build failure
    // or unsolicited console noise over one draw call it couldn't translate.
    warningCallback: () => {},
  });
  doc.end();
  return done;
}

/** Pixel/point dimensions of a composed SVG, from its viewBox (falls back to the
 *  width/height attributes if viewBox is somehow absent) — same regexes svgGeometry.ts
 *  uses for the same attributes, kept local since this is the only pdf-path consumer. */
function svgDimensions(svg: string): { width: number; height: number } {
  const vb = /viewBox="[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
  if (vb) return { width: +vb[1], height: +vb[2] };
  const w = /width="([\d.eE+-]+)pt"/.exec(svg);
  const h = /height="([\d.eE+-]+)pt"/.exec(svg);
  if (w && h) return { width: +w[1], height: +h[1] };
  throw new Error("svgToPdfBuffer: composed SVG has neither a viewBox nor width/height in pt");
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
