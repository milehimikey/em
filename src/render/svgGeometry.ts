// SPDX-License-Identifier: MIT
// Reads box rectangles back out of a Graphviz-rendered SVG.
//
// Each node is emitted as `<g class="node"><title>ID</title> … <polygon|path …>`
// with coordinates in the same 1:1 user space we later inject our edges into, so
// the numbers can be used directly. We take the bounding box of the first shape
// in each node group.

export interface Rect {
  left: number;
  right: number;
  top: number; // smaller (more negative) y is visually higher in graphviz SVG
  bottom: number;
  cx: number;
  cy: number;
}

const NODE_GROUP = /<g\b[^>]*class="node"[^>]*>([\s\S]*?)<\/g>/g;
const TITLE = /<title>([\s\S]*?)<\/title>/;
const SHAPE = /<(?:polygon|path)\b[^>]*\b(?:points|d)="([^"]*)"/;
const NUM = /-?\d*\.?\d+(?:e-?\d+)?/gi;

/** Map each requested node id to its rectangle in SVG coordinates. */
export function parseNodeRects(svg: string, ids: Set<string>): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const m of svg.matchAll(NODE_GROUP)) {
    const body = m[1];
    const id = decode(TITLE.exec(body)?.[1] ?? "");
    if (!ids.has(id)) continue;
    const shape = SHAPE.exec(body);
    if (!shape) continue;
    const nums = (shape[1].match(NUM) ?? []).map(Number);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(nums[i]);
      ys.push(nums[i + 1]);
    }
    if (xs.length === 0) continue;
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    rects.set(id, { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 });
  }
  return rects;
}

/** A bounding box in the graph's own (post-transform) coordinate space. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const FIT_PAD = 10; // breathing room, and enough for an arrowhead at the boundary

/**
 * Grow the canvas so content drawn in graph space isn't clipped by the root viewBox.
 * Edge detours can legitimately run outside the box grid Graphviz sized the canvas for
 * (an arc under the bottom lane, say), and anything past the viewBox is simply lost.
 */
export function fitCanvas(svg: string, box: Box | null): string {
  if (!box) return svg;
  const vb = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
  const wpt = /width="([\d.eE+-]+)pt"/.exec(svg);
  const hpt = /height="([\d.eE+-]+)pt"/.exec(svg);
  if (!vb || !wpt || !hpt) return svg; // can't resize safely — leave it alone

  // Graphviz wraps the graph in `transform="scale(sx sy) rotate(0) translate(tx ty)"`,
  // applied right to left, so a graph-space point lands at scale * (p + translate).
  const tf = /<g\b[^>]*class="graph"[^>]*transform="([^"]*)"/.exec(svg)?.[1] ?? "";
  const sc = /scale\(([\d.eE+-]+)[\s,]+([\d.eE+-]+)\)/.exec(tf);
  const tr = /translate\(([\d.eE+-]+)[\s,]+([\d.eE+-]+)\)/.exec(tf);
  const [sx, sy] = sc ? [+sc[1], +sc[2]] : [1, 1];
  const [tx, ty] = tr ? [+tr[1], +tr[2]] : [0, 0];

  const minX = +vb[1];
  const minY = +vb[2];
  const vw = +vb[3];
  const vh = +vb[4];
  if (vw <= 0 || vh <= 0) return svg;

  const x0 = Math.min(sx * (box.minX + tx), sx * (box.maxX + tx));
  const x1 = Math.max(sx * (box.minX + tx), sx * (box.maxX + tx));
  const y0 = Math.min(sy * (box.minY + ty), sy * (box.maxY + ty));
  const y1 = Math.max(sy * (box.minY + ty), sy * (box.maxY + ty));

  const left = Math.min(minX, Math.floor(x0 - FIT_PAD));
  const top = Math.min(minY, Math.floor(y0 - FIT_PAD));
  const right = Math.max(minX + vw, Math.ceil(x1 + FIT_PAD));
  const bottom = Math.max(minY + vh, Math.ceil(y1 + FIT_PAD));
  const nvw = right - left;
  const nvh = bottom - top;
  if (left === minX && top === minY && nvw === vw && nvh === vh) return svg;

  return svg
    .replace(wpt[0], `width="${round(+wpt[1] * (nvw / vw))}pt"`)
    .replace(hpt[0], `height="${round(+hpt[1] * (nvh / vh))}pt"`)
    .replace(vb[0], `viewBox="${round(left)} ${round(top)} ${round(nvw)} ${round(nvh)}"`);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#45;/g, "-");
}