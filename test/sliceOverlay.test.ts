// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { layout } from "../src/layout/grid.js";
import { parseNodeRects } from "../src/render/svgGeometry.js";
import { sliceOverlayIds, tagSliceAttrs, buildSliceOverlay } from "../src/render/sliceOverlay.js";

// Two slices, three bands (ui/api/event) — enough to exercise element tagging
// across slices, header-cell ranges, and a multi-row swimlane label range.
const SRC = `
persona Customer
context Order

slice "Place Order" {
  ui Order Screen @Customer
  command Place Order
  event Order Placed @Order
}
slice "Ship Order" {
  event Order Shipped @Order
}
`;

function build() {
  const model = normalize(parse(SRC));
  const grid = layout(model);
  return { model, grid };
}

// A hand-built Graphviz-shaped SVG matching the fixture above: header cells,
// element boxes (polygon), and row-label nodes (bare <text>, no shape — exactly
// how Graphviz renders `shape=plaintext`). Row 0 (the header band) deliberately
// carries NO <text>, same as real output — its label is always "".
const SVG = `<svg><g class="graph">
<g class="node"><title>__hdr_0</title><polygon points="0,-50 100,-50 100,-10 0,-10 0,-50"/></g>
<g class="node"><title>__hdr_1</title><polygon points="120,-50 220,-50 220,-10 120,-10 120,-50"/></g>
<g class="node"><title>order_screen</title><polygon points="0,-100 100,-100 100,-60 0,-60 0,-100"/></g>
<g class="node"><title>place_order</title><polygon points="0,-150 100,-150 100,-110 0,-110 0,-150"/></g>
<g class="node"><title>order_placed</title><polygon points="0,-200 100,-200 100,-160 0,-160 0,-200"/></g>
<g class="node"><title>order_shipped</title><polygon points="120,-200 220,-200 220,-160 120,-160 120,-200"/></g>
<g class="node"><title>__row_0</title></g>
<g class="node"><title>__row_1</title><text text-anchor="middle" x="-50" y="-80" font-size="10.00">Customer</text></g>
<g class="node"><title>__row_2</title><text text-anchor="middle" x="-10" y="-130" font-size="10.00">API</text></g>
<g class="node"><title>__row_3</title><text text-anchor="middle" x="30" y="-180" font-size="10.00">Order</text></g>
</g></svg>`;

describe("sliceOverlayIds", () => {
  it("lists every slice's header-cell id", () => {
    const { grid } = build();
    expect(sliceOverlayIds(grid)).toEqual(["__hdr_0", "__hdr_1"]);
  });
});

describe("tagSliceAttrs", () => {
  it("tags each element's node group with its own slice index, leaving header/row-label groups untouched", () => {
    const { model } = build();
    const out = tagSliceAttrs(SVG, model);
    expect(out).toContain('<g data-slice="0" class="node"><title>order_screen</title>');
    expect(out).toContain('<g data-slice="0" class="node"><title>place_order</title>');
    expect(out).toContain('<g data-slice="0" class="node"><title>order_placed</title>');
    expect(out).toContain('<g data-slice="1" class="node"><title>order_shipped</title>');
    expect(out).toContain('<g class="node"><title>__hdr_0</title>');
    expect(out).toContain('<g class="node"><title>__row_1</title>');
  });
});

describe("buildSliceOverlay", () => {
  it("emits one slice range per header cell, in index order", () => {
    const { model, grid } = build();
    const rects = parseNodeRects(SVG, new Set([...model.byId.keys(), ...sliceOverlayIds(grid)]));
    const out = buildSliceOverlay(SVG, grid, rects);

    expect(out).toContain('<metadata id="em-slices">');
    expect(out).toContain("<style>.em-slice-dim{opacity:.15");
    const json = /<metadata id="em-slices">([\s\S]*?)<\/metadata>/.exec(out)![1];
    const payload = JSON.parse(json);
    expect(payload.slices).toEqual([
      { index: 0, name: "Place Order", x0: 0, x1: 100 },
      { index: 1, name: "Ship Order", x0: 120, x1: 220 },
    ]);
  });

  it("unions the row-label column's x-range across every labeled row, skipping the label-less header row", () => {
    const { model, grid } = build();
    const rects = parseNodeRects(SVG, new Set([...model.byId.keys(), ...sliceOverlayIds(grid)]));
    const out = buildSliceOverlay(SVG, grid, rects);
    const json = /<metadata id="em-slices">([\s\S]*?)<\/metadata>/.exec(out)![1];
    const payload = JSON.parse(json);

    // "Customer" (leftmost, x=-50) sets x0; "Order" (rightmost, x=30) sets x1 —
    // different rows set each bound, so this catches a regression to "just use
    // one row" as well as a text-window bleed into a neighboring row's label
    // (the header row immediately before "Customer" has no <text> of its own).
    expect(payload.rowLabels).toEqual({ x0: -94, x1: 59 });
  });

  it("returns '' when no slice has a header-cell rect", () => {
    const { grid } = build();
    const out = buildSliceOverlay("<svg></svg>", grid, new Map());
    expect(out).toBe("");
  });
});
