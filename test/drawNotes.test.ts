import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { buildNoteMarkers } from "../src/render/drawNotes.js";
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
