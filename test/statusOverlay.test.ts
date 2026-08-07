// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { layout } from "../src/layout/grid.js";
import { HEADER_FILL, HEADER_BORDER, HEADER_FONT } from "../src/emit/dot.js";
import { styleFor } from "../src/emit/theme.js";
import { applyStatusColors, appendStatusLegend } from "../src/render/statusOverlay.js";

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
slice "Refund Order" {
  event Order Refunded @Order
}
`;

function build() {
  const model = normalize(parse(SRC));
  const grid = layout(model);
  return { model, grid };
}

// A hand-built Graphviz-shaped header-cell fixture, matching exactly what
// dot.ts's headerCell() + real Graphviz rendering produce: a filled polygon
// (fill/stroke) and a bold <text> label (fill = font color) inside one <g>.
function headerFixture(id: string, x0: number, x1: number): string {
  return (
    `<g class="node"><title>${id}</title>` +
    `<polygon fill="${HEADER_FILL}" stroke="${HEADER_BORDER}" points="${x0},-46 ${x0},0 ${x1},0 ${x1},-46"/>` +
    `<text text-anchor="middle" x="${(x0 + x1) / 2}" y="-19" font-family="Helvetica-Bold" ` +
    `font-size="10.00" fill="${HEADER_FONT}">Slice</text></g>`
  );
}

function fixtureSvg(headers: string[]): string {
  return `<svg viewBox="0 0 300 200" width="300pt" height="200pt"><g class="graph">${headers.join("\n")}</g></svg>`;
}

describe("applyStatusColors", () => {
  it("recolors only the header cell whose slice resolved to a known status", () => {
    const { grid } = build();
    const svg = fixtureSvg([headerFixture("__hdr_0", 0, 100), headerFixture("__hdr_1", 120, 220)]);
    const out = applyStatusColors(svg, grid, ["reviewed", null]);

    const commandStyle = styleFor("command");
    expect(out).toContain(`fill="${commandStyle.fill}"`);
    expect(out).toContain(`stroke="${commandStyle.stroke}"`);
    expect(out).toContain(`fill="${commandStyle.fontColor}"`); // recolored label text too
    // second header is untouched — still the default colors
    const secondHeader = /<title>__hdr_1<\/title>[\s\S]*?<\/g>/.exec(out)![0];
    expect(secondHeader).toContain(`fill="${HEADER_FILL}"`);
    expect(secondHeader).toContain(`stroke="${HEADER_BORDER}"`);
  });

  it("leaves headers untouched for draft, no doc, and unrecognized status strings", () => {
    const { grid } = build();
    const svg = fixtureSvg([
      headerFixture("__hdr_0", 0, 100),
      headerFixture("__hdr_1", 120, 220),
      headerFixture("__hdr_2", 240, 340),
    ]);
    const out = applyStatusColors(svg, grid, ["draft", null, "some-custom-workflow-state"]);
    expect(out).toBe(svg);
  });

  it("matches status case-insensitively", () => {
    const { grid } = build();
    const svg = fixtureSvg([headerFixture("__hdr_0", 0, 100)]);
    const out = applyStatusColors(svg, grid, ["Implemented"]);
    expect(out).toContain(`fill="${styleFor("view").fill}"`);
  });
});

describe("appendStatusLegend", () => {
  it("returns the SVG unchanged when no slice resolved to a known status", () => {
    const { grid } = build();
    const svg = fixtureSvg([headerFixture("__hdr_0", 0, 100)]);
    expect(appendStatusLegend(svg, grid, [null, "draft", "typo-status"])).toBe(svg);
  });

  it("lists one row per distinct known status present, in canonical lifecycle order regardless of column order", () => {
    const { grid } = build();
    const svg = fixtureSvg([
      headerFixture("__hdr_0", 0, 100),
      headerFixture("__hdr_1", 120, 220),
      headerFixture("__hdr_2", 240, 340),
    ]);
    // columns are implemented, reviewed, ready-to-implement — legend should still
    // read reviewed -> ready-to-implement -> implemented
    const out = appendStatusLegend(svg, grid, ["implemented", "reviewed", "ready-to-implement"]);

    expect(out).toContain('class="em-status-legend"');
    expect(out).toContain(">Slice Status<");
    const order = [">Reviewed<", ">Ready to implement<", ">Implemented<"].map((label) => out.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("grows the viewBox/height to make room for the legend", () => {
    const { grid } = build();
    const svg = fixtureSvg([headerFixture("__hdr_0", 0, 100)]);
    const out = appendStatusLegend(svg, grid, ["reviewed"]);
    const vb = /viewBox="[\d.]+ [\d.]+ [\d.]+ ([\d.]+)"/.exec(out)![1];
    expect(+vb).toBeGreaterThan(200);
  });
});
