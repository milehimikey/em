// SPDX-License-Identifier: MIT
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

  it("wires automation: read model -> processor (slice before) and processor -> command (own slice)", () => {
    const model = modelFrom(`
context P
slice "Trigger" {
  command Make It
  event Thing Happened @P
}
slice "Todo" {
  view Todo List from "Thing Happened"
}
slice "Do" {
  processor Worker from "Todo List"
  command Do Work
  event Work Done @P
}
`);
    const es = semanticEdges(model);
    const todo = model.byName.get("todo list")![0].id;
    const worker = model.byName.get("worker")![0].id;
    const cmd = model.byName.get("do work")![0].id;
    expect(edge(es, todo, worker)).toBe(true); // reads read model from the slice before
    expect(edge(es, worker, cmd)).toBe(true); // triggers command in its own slice
  });

  it("suppresses ui -> command when a reaction shares the slice — no legitimate dual trigger", () => {
    // A `ui` misplaced in a reaction's slice must render with no outgoing edge (validate.ts's
    // "renders disconnected here" warning depends on this being literally true), even when that
    // slice also has the reaction's own command — the ui/command pairing that would normally
    // wire an ordinary State Change slice is suppressed here instead of drawing a false second
    // trigger on the same command.
    const model = modelFrom(`
context Shipping
slice "Weird" {
  ui Something @Ops
  translation Carrier Adapter
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
`);
    const es = semanticEdges(model);
    const ui = model.byName.get("something")![0].id;
    const auto = model.byName.get("carrier adapter")![0].id;
    const cmd = model.byName.get("confirm delivery")![0].id;
    expect(edge(es, ui, cmd)).toBe(false); // no false dual trigger
    expect(edge(es, auto, cmd)).toBe(true); // the reaction's own trigger still wires
    expect(es.some((e) => e.from === ui)).toBe(false); // ui has no outgoing edge at all
  });
});

describe("semanticEdges provenance (MIL-191 refactor)", () => {
  it("labels every edge with its source — pattern, from, or arrow — and carries no colour", () => {
    const model = modelFrom(`
context Order
persona Customer
slice "A" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}
slice "B" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
arrow "Order List" -> "Place Order"
`);
    const es = semanticEdges(model);
    const id = (name: string, kind?: string) =>
      model.byName.get(name)!.find((e) => kind === undefined || e.kind === kind)!.id;
    const sourceOf = (a: string, b: string) => es.find((e) => e.from === a && e.to === b)?.source;
    expect(sourceOf(id("checkout"), id("place order", "command"))).toBe("pattern");
    expect(sourceOf(id("order placed"), id("open orders"))).toBe("from");
    expect(sourceOf(id("order list"), id("place order", "command"))).toBe("arrow");
    for (const e of es) expect(Object.keys(e).sort()).toEqual(["from", "source", "to"]);
  });

  it("dedupes a (from, to) pair first-wins in pattern -> from -> arrow order — an arrow restating an inferred edge is the same line", () => {
    const model = modelFrom(`
context Order
slice "A" {
  command Place Order
  event Order Placed @Order
}
arrow "Place Order" -> "Order Placed"
`);
    const es = semanticEdges(model);
    const cmd = model.byName.get("place order")![0].id;
    const ev = model.byName.get("order placed")![0].id;
    const matches = es.filter((e) => e.from === cmd && e.to === ev);
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("pattern");
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