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
import { parseNodeRects } from "./svgGeometry.js";
import { buildEdgeOverlay } from "./drawEdges.js";
import { buildNoteMarkers, appendNoteLegend } from "./drawNotes.js";

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

export async function renderDot(
  dot: string,
  model: NormalizedModel,
  outPath: string,
  format = formatFromPath(outPath),
  baseDir = process.cwd(),
): Promise<void> {
  // Note links are authored relative to the .em file (baseDir); rewrite them
  // relative to the output SVG so they resolve wherever the SVG is written.
  const outDir = dirname(outPath);
  const hrefOf = (el: Element) => noteHref(el.note ?? "", baseDir, outDir);

  const gv = await graphviz();
  const svg = withOverlays(gv.layout(dot, "svg", "dot"), model, hrefOf);

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
  hrefOf: (el: Element) => string,
): string {
  const rects = parseNodeRects(svg, new Set(model.byId.keys()));
  const { defs, group } = buildEdgeOverlay(model, rects);
  const notes = buildNoteMarkers(model, rects, hrefOf);

  let out = svg;
  // arrowhead markers go just inside <svg …>
  out = out.replace(/(<svg\b[^>]*>)/, `$1${defs}`);
  // edges go under the boxes: just before the first node group
  const nodeAt = out.search(/<g\b[^>]*class="node"[^>]*>/);
  if (nodeAt >= 0) out = out.slice(0, nodeAt) + group + out.slice(nodeAt);
  else out = out.replace(/<\/svg>/, `${group}</svg>`);
  // note markers go on top of the boxes — inside the graph transform group
  // (so they share the box coordinate space) but after every node, as the last
  // child of that group, making them the topmost clickable layer.
  out = out.replace(/(<\/g>\s*)(<\/svg>)/, `${notes}$1$2`);
  // grow the canvas and append the legend below the diagram (root coords)
  out = appendNoteLegend(out, model, hrefOf);
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
