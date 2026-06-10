import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { buildNoteMarkers, appendNoteLegend } from "../src/render/drawNotes.js";
import { Rect } from "../src/render/svgGeometry.js";

const modelFrom = (src: string) => normalize(parse(src));

const box = (cx: number, cy: number): Rect => ({
  left: cx - 50,
  right: cx + 50,
  top: cy - 20,
  bottom: cy + 20,
  cx,
  cy,
});

describe("buildNoteMarkers", () => {
  it("emits a linked corner marker for a noted element", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(100, 100)]]));

    expect(group).toContain('<a');
    expect(group).toContain('href="notes/order-placed.md"');
    expect(group).toContain("<path");
    // anchored near the box's top-right corner (right=150, top=80), inset by 5
    expect(group).toContain("145,85");
    // carries a footnote number
    expect(group).toContain(">1</text>");
  });

  it("emits nothing for an element without a note", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(100, 100)]]));
    expect(group).not.toContain("<a");
    expect(group).not.toContain("<path");
  });

  it("xml-escapes the href", () => {
    const model = modelFrom(`
slice "S" {
  event E note "a&b.md"
}
`);
    const id = model.byName.get("e")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(0, 0)]]));
    expect(group).toContain("a&amp;b.md");
    expect(group).not.toContain('href="a&b.md"');
  });
});

describe("appendNoteLegend", () => {
  const fakeSvg = (w: number, h: number) =>
    `<svg width="${w}pt" height="${h}pt"\n viewBox="0.00 0.00 ${w}.00 ${h}.00" ` +
    `xmlns="http://www.w3.org/2000/svg"><g id="graph0" transform="scale(1 1) ` +
    `rotate(0) translate(0 ${h})"><polygon points="0,0"/></g></svg>`;

  it("grows the canvas and lists each note with its number, name and path", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md"
}
slice "T" {
  command Capture Payment note "notes/capture.md"
}
`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    const newH = Number(/height="([\d.]+)pt"/.exec(out)![1]);
    expect(newH).toBeGreaterThan(200); // canvas grew to fit the legend
    expect(out).toContain("Notes");
    expect(out).toContain("Order Placed");
    expect(out).toContain("notes/order-placed.md");
    expect(out).toContain("Capture Payment");
    expect(out).toContain("notes/capture.md");
    expect(out).toContain(">1.</tspan>");
    expect(out).toContain(">2.</tspan>");
    // viewBox height grew in step with the pt height
    expect(out).toMatch(/viewBox="0.00 0.00 400.00 [\d.]+"/);
  });

  it("leaves the SVG untouched when there are no notes", () => {
    const model = modelFrom(`slice "S" {\n  event Order Placed\n}`);
    const svg = fakeSvg(400, 200);
    expect(appendNoteLegend(svg, model)).toBe(svg);
  });
});
