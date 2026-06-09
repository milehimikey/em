import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { semanticEdges } from "../src/model/edges.js";
import { buildEdgeOverlay } from "../src/render/drawEdges.js";
import { Rect } from "../src/render/svgGeometry.js";

const modelFrom = (src: string) => normalize(parse(src));
const edge = (es: { from: string; to: string }[], a: string, b: string) =>
  es.some((e) => e.from === a && e.to === b);

describe("semanticEdges", () => {
  it("draws the event -> view data-flow arrow from a `from` clause", () => {
    const model = modelFrom(`
context Order
slice "A" {
  command Place Order
  event Order Placed @Order
}
slice "B" {
  view Open Orders from "Order Placed"
}
`);
    const placed = model.byName.get("order placed")![0].id;
    const view = model.byName.get("open orders")![0].id;
    expect(edge(semanticEdges(model), placed, view)).toBe(true);
  });

  it("wires automation: read model -> processor (own slice) and processor -> next command", () => {
    const model = modelFrom(`
context P
slice "Trigger" {
  command Make It
  event Thing Happened @P
}
slice "Auto" {
  view Todo List from "Thing Happened"
  processor Worker
}
slice "Do" {
  command Do Work
  event Work Done @P
}
`);
    const es = semanticEdges(model);
    const todo = model.byName.get("todo list")![0].id;
    const worker = model.byName.get("worker")![0].id;
    const cmd = model.byName.get("do work")![0].id;
    expect(edge(es, todo, worker)).toBe(true); // reads read model in its slice
    expect(edge(es, worker, cmd)).toBe(true); // triggers command in the next slice
  });
});

describe("buildEdgeOverlay", () => {
  // helper: a box centred at (cx, cy), 100 wide x 40 tall
  const box = (cx: number, cy: number): Rect => ({
    left: cx - 50,
    right: cx + 50,
    top: cy - 20,
    bottom: cy + 20,
    cx,
    cy,
  });

  it("draws a within-slice edge as a straight vertical (constant x)", () => {
    const model = modelFrom(`
slice "S" {
  command Place Order
  event Order Placed
}
`);
    const cmd = model.byName.get("place order")![0].id;
    const ev = model.byName.get("order placed")![0].id;
    // command above event, same column (x = 100)
    const rects = new Map<string, Rect>([
      [cmd, box(100, 100)],
      [ev, box(100, 200)],
    ]);
    const { group } = buildEdgeOverlay(model, rects);
    const d = /d="([^"]*)"/.exec(group)![1];
    expect(d).not.toContain("C"); // straight, not curved
    const xs = (d.match(/M([\d.]+),|L([\d.]+),/g) ?? []).map((s) => s.replace(/[ML,]/g, ""));
    expect(new Set(xs).size).toBe(1); // single x value -> dead vertical
  });

  it("draws a cross-slice edge as a cubic curve with an arrowhead", () => {
    const model = modelFrom(`
context Order
slice "A" {
  command Place Order
  event Order Placed @Order
}
slice "B" {
  view Open Orders from "Order Placed"
}
`);
    const placed = model.byName.get("order placed")![0].id;
    const view = model.byName.get("open orders")![0].id;
    // event low-left, view higher-right (different columns)
    const rects = new Map<string, Rect>([
      [placed, box(100, 300)],
      [view, box(300, 150)],
    ]);
    const { group, defs } = buildEdgeOverlay(model, rects);
    expect(group).toContain("C"); // cubic bezier
    expect(group).toContain("marker-end");
    expect(defs).toContain("<marker");
  });
});
