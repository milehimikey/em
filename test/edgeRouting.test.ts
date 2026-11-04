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
const exampleSrc = () => readFileSync(EXAMPLE, "utf8");

// OBSTRUCTED's event -> view path as drawn by main before side entry existed.
const BASE_PATH = "M151,0 C151,14 1334,14 1334,-161.28";

// A deliberately awkward layout, which the shipped example is not: the read model sits six
// slices from the event that feeds it, in a different context lane, so the direct curve
// between them runs straight through the Ticket lane. Real models should keep arrows span-1
// (see docs/timeline.md) — this exists purely to give the router something to route around.
const OBSTRUCTED = `model "Obstructed"
persona Agent
context Ticket
context Billing
slice "Request Refund" {
  ui Refund Form @Agent
  command Request Refund
  event Refund Requested @Billing
}
slice "Assign" {
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue A" {
  view Ticket Queue from "Ticket Assigned"
}
slice "Reply" {
  ui Reply Composer @Agent
  command Reply To Customer
  event Reply Sent @Ticket
}
slice "Queue B" {
  view Ticket Queue again from "Reply Sent"
}
slice "Close" {
  ui Queue Board @Agent
  command Close Ticket
  event Ticket Closed @Ticket
}
slice "Queue C" {
  view Ticket Queue again from "Ticket Closed"
}
slice "Refund Backlog" {
  view Refund Backlog from "Refund Requested"
}
`;

async function renderSource(src: string): Promise<string> {
  const { dot, model, grid } = compile(src);
  const dir = mkdtempSync(join(tmpdir(), "em-routing-"));
  try {
    const out = join(dir, "out.svg");
    await renderDot(dot, model, grid, out, "svg", dirname(EXAMPLE));
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

/** Every box the drawn overlay passes through but doesn't connect. */
function crossingsIn(svg: string, src: string): string[] {
  const model = normalize(parse(src));
  const rects = parseNodeRects(svg, new Set(model.byId.keys()));
  const group = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
  const ds = [...group.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  expect(ds.length).toBe(semanticEdges(model).length);

  const out: string[] = [];
  for (const d of ds) {
    const pts = samplePath(d);
    const skip = touching(pts, rects);
    for (const [id, r] of rects) {
      if (skip.has(id)) continue;
      if (pts.some(([x, y]) => inside(x, y, r))) {
        out.push(`${model.byId.get(id)!.name} (${model.byId.get(id)!.kind})`);
      }
    }
  }
  return out;
}

describe("edge routing never crosses an unrelated box", () => {
  it("draws every arrow in the shipped example clear of every box it doesn't connect", async () => {
    const src = exampleSrc();
    expect(crossingsIn(await renderSource(src), src)).toEqual([]);
  });

  it("routes around an obstruction instead of through it", async () => {
    const svg = await renderSource(OBSTRUCTED);
    expect(crossingsIn(svg, OBSTRUCTED)).toEqual([]);
  });

  it("the obstructed fixture keeps its teeth — a direct run really would hit boxes", async () => {
    // Guards the test above: without this, a layout that happened to be easy would pass
    // and the router could regress unnoticed.
    const svg = await renderSource(OBSTRUCTED);
    const model = normalize(parse(OBSTRUCTED));
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

  it("keeps every arrow in the shipped example span-1, so no slice reads as dangling", () => {
    // A read model far from its event draws a long arrow whose arrowhead lands off-screen
    // from the slice that produced it — the slice looks unconnected even though it isn't.
    const model = normalize(parse(exampleSrc()));
    const long = semanticEdges(model)
      .map((e) => ({ a: model.byId.get(e.from)!, b: model.byId.get(e.to)! }))
      .filter(({ a, b }) => Math.abs(b.sliceIndex - a.sliceIndex) > 1)
      .map(({ a, b }) => `${a.name} -> ${b.name}`);
    expect(long).toEqual([]);
  });

  it("grows the canvas so a detour outside the box grid isn't clipped", async () => {
    const svg = await renderSource(OBSTRUCTED);
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
    expect(instances.length).toBe(6);
    const ids = new Set(instances.map((i) => i.id));
    const between = semanticEdges(model).filter((e) => ids.has(e.from) && ids.has(e.to));
    expect(between).toEqual([]);
  });

  // GH #254 — a `ui` sharing a processor's slice blocks the processor's bottom face (the
  // ui sits directly below it in the same column), so the inbound edge used to loop far
  // above the canvas or fall back to a straight line through the ui box.
  const PROC_WITH_UI = `model "Processor with ui in same slice"
persona Operator
context Item
slice "Create Item" {
  ui Create Item @Operator
  command CreateItem
  event ItemCreated @Item
}
slice "Pending Items" {
  view PendingItems from "ItemCreated"
  ui Read Pending Items @Operator
}
slice "Complete Item" {
  ui Complete Item @Operator
  processor ItemScheduler from "PendingItems"
  command CompleteItem
  event ItemCompleted @Item
}
arrow "Complete Item" -> CompleteItem
`;

  /** 25 slices over 7 contexts; every fifth slice is a processor slice that also holds a ui. */
  function largeProcWithUi(): string {
    const ctx = ["A", "B", "C", "D", "E", "F", "G"];
    let s = `model "Large"\npersona Agent\n${ctx.map((c) => `context ${c}`).join("\n")}\n`;
    for (let i = 0; i < 25; i++) {
      const c = ctx[i % ctx.length];
      if (i % 5 === 4) {
        s +=
          `slice "S${i}" {\n  processor P${i} from "V${i - 1}"\n  ui U${i} @Agent\n` +
          `  command C${i}\n  event E${i} @${c}\n}\n`;
      } else if (i % 5 === 3) {
        s += `slice "S${i}" {\n  view V${i} from "E${i - 1}"\n  ui R${i} @Agent\n}\n`;
      } else {
        s += `slice "S${i}" {\n  ui U${i} @Agent\n  command C${i}\n  event E${i} @${c}\n}\n`;
      }
    }
    return s;
  }

  /** For each edge into a processor: where it ends, and how far its path strays. */
  function processorEdges(svg: string, src: string) {
    const model = normalize(parse(src));
    const rects = parseNodeRects(svg, new Set(model.byId.keys()));
    const group = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
    const ds = [...group.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    const edges = semanticEdges(model);
    const out: { endOnSide: boolean; withinRows: boolean }[] = [];
    edges.forEach((e, i) => {
      if (model.byId.get(e.to)?.kind !== "processor") return;
      const f = rects.get(e.from)!;
      const t = rects.get(e.to)!;
      const nums = [...ds[i].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
      const [ex, ey] = nums[nums.length - 1];
      const ys = nums.map((q) => q[1]);
      out.push({
        endOnSide: (Math.abs(ex - t.left) < 1 || Math.abs(ex - t.right) < 1) && ey > t.top && ey < t.bottom,
        // never strays beyond the rows the two boxes span, plus one gutter
        withinRows:
          Math.min(...ys) >= Math.min(f.top, t.top) - 14 && Math.max(...ys) <= Math.max(f.bottom, t.bottom) + 14,
      });
    });
    return out;
  }

  it("routes the inbound edge of a processor that shares its slice with a ui clear of that ui", async () => {
    const svg = await renderSource(PROC_WITH_UI);
    expect(crossingsIn(svg, PROC_WITH_UI)).toEqual([]);
    const edges = processorEdges(svg, PROC_WITH_UI);
    expect(edges.length).toBe(1);
    expect(edges.every((e) => e.endOnSide && e.withinRows)).toBe(true);
  });

  it("keeps the same inbound edge short and in-canvas in a 25-slice, 7-context model", async () => {
    const src = largeProcWithUi();
    const svg = await renderSource(src);
    expect(crossingsIn(svg, src)).toEqual([]);
    const edges = processorEdges(svg, src);
    expect(edges.length).toBeGreaterThan(3);
    expect(edges.every((e) => e.endOnSide && e.withinRows)).toBe(true);
  });

  it("leaves an event -> view edge on the established route (no side entry into a view)", async () => {
    const svg = await renderSource(OBSTRUCTED);
    const model = normalize(parse(OBSTRUCTED));
    const from = model.byName.get("refund requested")![0];
    const to = model.byName.get("refund backlog")![0];
    const group = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
    const ds = [...group.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    const i = semanticEdges(model).findIndex((e) => e.from === from.id && e.to === to.id);
    // BASE_PATH was captured from main before side entry existed.
    expect(ds[i]).toBe(BASE_PATH);
  });
});

// GH #324 (follow-up to #278): alternatives share one box, but each alternative's outgoing
// arrows leave from ITS OWN row of that box, and its ↩ loops-to badge sits on that row — so
// "Done Jobs from Job Done" and "Failed Jobs from Job Failed" no longer draw as one line out of
// one point, and the badge says which alternative loops. Stacked continuation columns get one
// gutter lane per route instead of one shared trunk.
const ALTERNATIVES = `model "Alt"
slice "Queue" {
  ui Queue Screen @Ops
  command Queue Job
  event Job Queued @Ops
}
slice "Queued" {
  view Queue from "Job Queued"
  ui Queue Board @Ops
}
slice "Run Job" {
  ui Job Screen @Ops
  command Run Job
  event Job Done loops-to "Queue" | Job Failed @Ops
}
slice "Done Jobs" {
  view Done Jobs from "Job Done"
  ui Done Screen @Ops
}
slice "Failed Jobs" {
  view Failed Jobs from "Job Failed"
  ui Failed Screen @Ops
}
`;

const STACKED = `model "Stack"
slice "Place Order" {
  ui Order Form @Customer
  command Place Order
  event Order Placed @Sales
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Orders Board @Customer
}
slice "Order Summary" {
  view Order Summary from "Order Placed"
  ui Summary Page @Customer
}
slice "Approve Order" {
  ui Approval Screen @Customer
  command Approve Order
  event Order Approved @Sales
}
slice "After Approval" {
  view Open Orders again from "Order Approved" shown on "Orders Board"
  view Order Summary again from "Order Approved" shown on "Summary Page"
  ui Orders Board @Customer
  ui Summary Page @Customer
}
`;

/** Every drawn edge path's start point, end point and raw `d`. */
function edgeStarts(svg: string): { x: number; y: number; ex: number; ey: number; d: string }[] {
  return [...svg.matchAll(/<path fill="none" stroke="[^"]+" stroke-width="1.5" d="M(-?[\d.]+),(-?[\d.]+)([^"]*)"/g)].map((m) => {
    const d = `M${m[1]},${m[2]}${m[3]}`;
    const end = /(-?[\d.]+),(-?[\d.]+)$/.exec(d)!;
    return { x: Number(m[1]), y: Number(m[2]), ex: Number(end[1]), ey: Number(end[2]), d };
  });
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;

describe("GH #324: alternatives leave the shared box from their own row", () => {
  it("two views fed by different alternatives have arrows leaving the box's right edge at different y", async () => {
    const svg = await renderSource(ALTERNATIVES);
    const { model } = compile(ALTERNATIVES);
    const rects = parseNodeRects(svg, new Set(model.byId.keys()));
    const box = rects.get("job_done")!;
    expect(rects.get("job_failed")).toBeUndefined(); // still one shared box, drawn under the lead's id (GH #278)
    const outOfBox = edgeStarts(svg).filter((e) => near(e.x, box.right));
    expect(outOfBox).toHaveLength(2);
    const [done, failed] = outOfBox.sort((a, b) => a.y - b.y);
    expect(done.y).toBeGreaterThan(box.top);
    expect(failed.y).toBeLessThan(box.bottom);
    expect(failed.y - done.y).toBeGreaterThan(12); // a full text row apart, not one point
    // The upper row is "Job Done" (first alternative) and feeds Done Jobs; the lower feeds Failed Jobs.
    const doneView = rects.get("done_jobs")!;
    const failedView = rects.get("failed_jobs")!;
    // Each enters its view by the face that points back at the row (the api lane sits above the
    // event lane here, so that is the view's bottom) — the established facing rule, unchanged.
    const enters = (e: { ex: number; ey: number }, r: Rect) => near(e.ex, r.cx) && (near(e.ey, r.top) || near(e.ey, r.bottom));
    expect(enters(done, doneView)).toBe(true);
    expect(enters(failed, failedView)).toBe(true);
    // Nothing else leaves the shared box: the command -> event edge enters it from above as before.
    expect(edgeStarts(svg).filter((e) => near(e.x, box.cx) && near(e.y, box.bottom))).toHaveLength(0);
  });

  it("the ↩ loops-to badge sits on the looping alternative's row, clear of the text, and its tooltip names it", async () => {
    const svg = await renderSource(ALTERNATIVES);
    const { model } = compile(ALTERNATIVES);
    const box = parseNodeRects(svg, new Set(model.byId.keys())).get("job_done")!;
    const loops = /<g class="em-loops-to">([\s\S]*?)<\/g>/.exec(svg)![1];
    expect(loops).toContain('<title>1. "Job Done" loops back to "Queue"</title>');
    const tri = /d="M(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+),(-?[\d.]+) Z"/.exec(loops)!;
    const badgeBottom = Number(tri[2]);
    const badgeTop = Number(tri[6]);
    // The badge spans the "Job Done" row — the top half of the box — not the box's bottom corner.
    expect(badgeTop).toBeGreaterThan(box.top);
    expect(badgeBottom).toBeLessThan(box.cy);
    // And it never overlaps the alternative's own name: the glyph ends before the text starts.
    const nameX = Number(/<text[^>]*x="(-?[\d.]+)"[^>]*>Job Done<\/text>/.exec(svg)![1]);
    expect(Number(tri[1])).toBeLessThan(nameX);
  });

  it("a stacked continuation column routes each view to its own screen in its own gutter lane", async () => {
    const svg = await renderSource(STACKED);
    const { model } = compile(STACKED);
    const rects = parseNodeRects(svg, new Set(model.byId.keys()));
    const views = model.elements.filter((e) => e.kind === "view" && e.sliceIndex === 4);
    expect(views).toHaveLength(2);
    const starts = edgeStarts(svg);
    const routes = views.map((v) => starts.find((e) => near(e.x, rects.get(v.id)!.right) && near(e.y, rects.get(v.id)!.cy))!);
    expect(routes.every(Boolean)).toBe(true);
    // The vertical run of each route: the x of its `L` segment. Distinct lanes, not one trunk.
    const lanes = routes.map((r) => Number(/ L(-?[\d.]+),/.exec(r.d)![1]));
    expect(new Set(lanes).size).toBe(2);
    expect(lanes.every((x) => x > rects.get(views[0].id)!.right)).toBe(true);
  });
});
