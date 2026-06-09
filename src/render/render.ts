// Renders a model to an image.
//
// Graphviz lays out the grid and renders boxes/labels to SVG; it does NOT route
// the arrows. We read each box's rectangle back out of that SVG, draw the edges
// ourselves (straight within a slice, curved across slices), and inject them.
// SVG is written directly; other formats are produced from the rounded SVG via
// `rsvg-convert`.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { parseNodeRects } from "./svgGeometry.js";
import { buildEdgeOverlay } from "./drawEdges.js";

const DOT_BIN = process.env.EM_DOT || "dot";
const RSVG_BIN = process.env.EM_RSVG || "rsvg-convert";

export function formatFromPath(outPath: string, fallback = "svg"): string {
  const ext = extname(outPath).replace(/^\./, "").toLowerCase();
  return ext || fallback;
}

export async function renderDot(
  dot: string,
  model: NormalizedModel,
  outPath: string,
  format = formatFromPath(outPath),
): Promise<void> {
  const svg = withEdges(await runDot(dot, "svg"), model);

  if (format === "svg") {
    await writeFile(outPath, svg, "utf8");
    return;
  }

  if (await hasBin(RSVG_BIN)) {
    await rsvgConvert(svg, outPath, format);
    return;
  }

  throw new Error(
    `'${RSVG_BIN}' is required to render '${format}' (the arrows are drawn into the SVG). ` +
      `Install librsvg or render to .svg instead.`,
  );
}

/** Draw the semantic edges into a Graphviz-rendered SVG. */
function withEdges(svg: string, model: NormalizedModel): string {
  const rects = parseNodeRects(svg, new Set(model.byId.keys()));
  const { defs, group } = buildEdgeOverlay(model, rects);

  let out = svg;
  // markers go just inside <svg …>
  out = out.replace(/(<svg\b[^>]*>)/, `$1${defs}`);
  // edges go under the boxes: just before the first node group
  const nodeAt = out.search(/<g\b[^>]*class="node"[^>]*>/);
  if (nodeAt >= 0) out = out.slice(0, nodeAt) + group + out.slice(nodeAt);
  else out = out.replace(/<\/svg>/, `${group}</svg>`);
  return out;
}

/** Run `dot` and capture stdout for the given format. */
function runDot(dot: string, format: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(DOT_BIN, [`-T${format}`]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`failed to run '${DOT_BIN}' (is Graphviz installed?): ${e.message}`)),
    );
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`dot exited with code ${code}: ${err.trim()}`)),
    );
    child.stdin.write(dot);
    child.stdin.end();
  });
}

/** Convert an SVG string to the requested format with rsvg-convert. */
function rsvgConvert(svg: string, outPath: string, format: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(RSVG_BIN, [`--format=${format}`, "-o", outPath]);
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`failed to run '${RSVG_BIN}': ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${RSVG_BIN} exited with code ${code}: ${err.trim()}`)),
    );
    child.stdin.write(svg);
    child.stdin.end();
  });
}

function hasBin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
