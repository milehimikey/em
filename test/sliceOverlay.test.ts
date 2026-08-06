// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { layout } from "../src/layout/grid.js";
import { parseNodeRects } from "../src/render/svgGeometry.js";
import { sliceOverlayIds, tagSliceAttrs, buildSliceOverlay, cropToSlice } from "../src/render/sliceOverlay.js";

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

  it("converts graph-space rects through the graph's own scale/translate before embedding them", () => {
    // Real Graphviz output always carries a transform (even just its default
    // ~4pt margin translate) on <g class="graph"> — SVG's fixture above has none,
    // which silently exercises only the sx=1/tx=0 identity case. rects from
    // parseNodeRects() are graph-space (pre-transform); embedding them as-is
    // would hand the viewer root-space viewBox math in the wrong coordinate
    // system. scale(2 1) here exaggerates the effect so a regression to "use the
    // raw rect" fails loudly rather than by an easy-to-miss +4.
    const TRANSFORMED = SVG.replace(
      '<g class="graph">',
      '<g class="graph" transform="scale(2 1) rotate(0) translate(4 4)">',
    );
    const { model, grid } = build();
    const rects = parseNodeRects(TRANSFORMED, new Set([...model.byId.keys(), ...sliceOverlayIds(grid)]));
    const out = buildSliceOverlay(TRANSFORMED, grid, rects);
    const json = /<metadata id="em-slices">([\s\S]*?)<\/metadata>/.exec(out)![1];
    const payload = JSON.parse(json);

    // toRoot(x) = sx * (x + tx) = 2 * (x + 4)
    expect(payload.slices).toEqual([
      { index: 0, name: "Place Order", x0: 8, x1: 208 }, // 2*(0+4), 2*(100+4)
      { index: 1, name: "Ship Order", x0: 248, x1: 448 }, // 2*(120+4), 2*(220+4)
    ]);
    // Row-label range shifts/scales the same way as the untransformed-fixture
    // test's {x0: -94, x1: 59}: 2*(-94+4)=-180, 2*(59+4)=126.
    expect(payload.rowLabels).toEqual({ x0: -180, x1: 126 });
  });
});

// Same fixture as above, plus the root viewBox/width/height cropCanvas needs —
// generous enough to contain every element/header-cell/row-label coordinate above.
const CROPPABLE_SVG = SVG.replace(
  "<svg>",
  '<svg viewBox="-150 -250 400 260" width="400pt" height="260pt">',
);

describe("cropToSlice", () => {
  it("crops to a slice's header-cell x-range, unioned with its LOCALLY-relocated row labels, leaving y untouched", () => {
    const { grid } = build();
    const out = cropToSlice(CROPPABLE_SVG, grid, 0);
    // Row labels are relocated to sit just left of slice 0's header cell (x=[0,100])
    // before the union — NOT unioned with their original far-away position (see
    // relocateRowLabels; that would drag every slice back to the label gutter).
    // "Customer" (halfWidth 44) relocates to x=0-12-44=-56, giving [-100,-12]; that's
    // the widest of the three relocated rows, so it sets the union's left bound.
    // Union with the header cell [0,100] is [-100,100], padded by CROP_PAD=24:
    // [-124,124], width 248.
    expect(out).toContain('viewBox="-124 -250 248 260"');
    expect(out).toContain('width="248pt"'); // 400 * (248/400)
    expect(out).toContain('height="260pt"'); // unchanged
  });

  it("crops a different slice to its own (equally narrow) x-range, not a wider one", () => {
    const { grid } = build();
    const out = cropToSlice(CROPPABLE_SVG, grid, 1);
    // Same relocation, now snugged against slice 1's header cell (x=[120,220]):
    // "Customer" relocates to x=120-12-44=64, giving [20,108]. Union with [120,220]
    // is [20,220], padded: [-4,244], width 248 — the SAME width as slice 0's crop
    // above, confirming every slice gets an equally narrow snippet regardless of
    // how far from column 0 it sits (the bug this test guards against: unioning
    // with the label column's real, far-left position would make this crop far
    // wider than slice 0's).
    expect(out).toContain('viewBox="-4 -250 248 260"');
    expect(out).toContain('width="248pt"');
  });

  it("returns the input unchanged for an out-of-range slice index", () => {
    const { grid } = build();
    expect(cropToSlice(CROPPABLE_SVG, grid, 5)).toBe(CROPPABLE_SVG);
  });
});
