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

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#45;/g, "-");
}
