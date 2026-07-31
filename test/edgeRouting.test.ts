// SPDX-License-Identifier: MIT
// Geometry contract for the drawn overlay: an arrow may never pass through a box it
// does not connect. A line entering one box and leaving the other side reads as a
// connection that isn't in the model — which is exactly how a `view X again` continuity
// arrow used to look like an illegal command -> read model edge, since commands and read
// models share the API lane. examples/timeline-rules.em is the fixture.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compile } from "../src/pipeline.js";
import { renderDot } from "../src/render/render.js";
import { parseNodeRects, Rect } from "../src/render/svgGeometry.js";
import { normalize } from "../src/model/model.js";
import { parse } from "../src/parser/parser.js";
import { semanticEdges } from "../src/model/edges.js";

const EXAMPLE = "examples/timeline-rules.em";

async function renderExample(): Promise<string> {
  const { dot, model } = compile(readFileSync(EXAMPLE, "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "em-routing-"));
  try {
    const out = join(dir, "out.svg");
    await renderDot(dot, model, out, "svg", dirname(EXAMPLE));
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Points along an SVG path built from M / L / C segments. */
function samplePath(d: string, per = 60): [number, number][] {
  const tokens = d.match(/[MLC][^MLC]*/g) ?? [];
  const pts: [number, number][] = [];
  let cur: [number, number] = [0, 0];
  for (const tok of tokens) {
    const n = (tok.slice(1).match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (tok[0] === "M") cur = [n[0], n[1]];
    else if (tok[0] === "L") {
      for (let i = 1; i <= per; i++) {
        const t = i / per;
        pts.push([cur[0] + (n[0] - cur[0]) * t, cur[1] + (n[1] - cur[1]) * t]);
      }
      cur = [n[0], n[1]];
    } else {
      const [x0, y0] = cur;
      for (let i = 1; i <= per; i++) {
        const t = i / per;
        const u = 1 - t;
        pts.push([
          u * u * u * x0 + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * n[4],
          u * u * u * y0 + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * n[5],
        ]);
      }
      cur = [n[4], n[5]];
    }
  }
  return pts;
}

const inside = (x: number, y: number, r: Rect) =>
  x > r.left && x < r.right && y > r.top && y < r.bottom;

/** Boxes an endpoint sits on — a path legitimately touches the two it connects. */
const touching = (pts: [number, number][], rects: Map<string, Rect>) => {
  const ends = [pts[0], pts[pts.length - 1]];
  const ids = new Set<string>();
  for (const [id, r] of rects) {
    for (const [x, y] of ends) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) ids.add(id);
    }
  }
  return ids;
};

describe("edge routing never crosses an unrelated box", () => {
  it("draws every arrow in the example clear of every box it doesn't connect", async () => {
    const svg = await renderExample();
    const model = normalize(parse(readFileSync(EXAMPLE, "utf8")));
    const rects = parseNodeRects(svg, new Set(model.byId.keys()));
    const group = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
    const ds = [...group.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

    expect(ds.length).toBe(semanticEdges(model).length);

    const crossings: string[] = [];
    for (const d of ds) {
      const pts = samplePath(d);
      const skip = touching(pts, rects);
      for (const [id, r] of rects) {
        if (skip.has(id)) continue;
        if (pts.some(([x, y]) => inside(x, y, r))) {
          crossings.push(`${model.byId.get(id)!.name} (${model.byId.get(id)!.kind})`);
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it("still has an obstruction worth routing around — the fixture keeps its teeth", async () => {
    // Refund Backlog reads an event twelve slices back, across the whole Ticket lane.
    // A straight run between the two centres hits boxes, so the clean result above is
    // the router working, not the layout happening to be easy.
    const svg = await renderExample();
    const model = normalize(parse(readFileSync(EXAMPLE, "utf8")));
    const rects = parseNodeRects(svg, new Set(model.byId.keys()));
    const from = model.byName.get("refund requested")![0];
    const to = model.byName.get("refund backlog")![0];
    const f = rects.get(from.id)!;
    const t = rects.get(to.id)!;

    const blocked = [...rects].filter(([id, r]) => {
      if (id === from.id || id === to.id) return false;
      for (let i = 1; i < 200; i++) {
        const s = i / 200;
        if (inside(f.cx + (t.cx - f.cx) * s, f.cy + (t.cy - f.cy) * s, r)) return true;
      }
      return false;
    });
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("grows the canvas so a detour outside the box grid isn't clipped", async () => {
    const svg = await renderExample();
    const vb = /viewBox="([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)"/.exec(svg)!;
    const [minX, minY, vw, vh] = vb.slice(1).map(Number);
    const tf = /<g\b[^>]*class="graph"[^>]*transform="([^"]*)"/.exec(svg)![1];
    const tr = /translate\(([\d.eE+-]+)[\s,]+([\d.eE+-]+)\)/.exec(tf)!;
    const [tx, ty] = [+tr[1], +tr[2]];

    const group = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
    for (const d of [...group.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])) {
      for (const [x, y] of samplePath(d)) {
        expect(x + tx).toBeGreaterThanOrEqual(minX);
        expect(x + tx).toBeLessThanOrEqual(minX + vw);
        expect(y + ty).toBeGreaterThanOrEqual(minY);
        expect(y + ty).toBeLessThanOrEqual(minY + vh);
      }
    }
  });

  it("draws no arrow between instances of the repeated read model", async () => {
    const model = normalize(parse(readFileSync(EXAMPLE, "utf8")));
    const instances = model.byName.get("ticket queue")!;
    expect(instances.length).toBe(4);
    const ids = new Set(instances.map((i) => i.id));
    const between = semanticEdges(model).filter((e) => ids.has(e.from) && ids.has(e.to));
    expect(between).toEqual([]);
  });
});
