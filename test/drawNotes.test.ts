// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import {
  buildNoteMarkers,
  buildIssueMarkers,
  buildDivergenceMarkers,
  appendNoteLegend,
} from "../src/render/drawNotes.js";
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

  it("MIL-26: draws a white halo behind the marker so it reads on any box color", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(100, 100)]]));

    // two triangle paths: a white-stroked halo first, then the colored marker on top.
    const paths = [...group.matchAll(/<path d="[^"]*Z" [^/]*\/>/g)];
    expect(paths).toHaveLength(2);
    expect(paths[0][0]).toContain('stroke="#FFFFFF"');
    expect(paths[0][0]).toContain('fill="none"');
    expect(paths[1][0]).toContain(`fill="#F4C430"`);
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

  it("MIL-153: excludes a slice's own doc-binding self-reference (note \"slices/<key>.md\")", () => {
    const model = modelFrom(`
slice "Request Payment" {
  command Request Payment note "slices/request-payment.md"
}
`);
    const id = model.byName.get("request payment")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(100, 100)]]));
    expect(group).not.toContain("<a");
    expect(group).not.toContain("<path");
  });

  it("MIL-153: still renders a note naming a DIFFERENT slice's doc (cross-binding) normally", () => {
    const model = modelFrom(`
slice "Request Payment" {
  command Request Payment note "slices/capture-payment.md"
}
`);
    const id = model.byName.get("request payment")![0].id;
    const group = buildNoteMarkers(model, new Map([[id, box(100, 100)]]));
    expect(group).toContain("<a");
    expect(group).toContain('href="slices/capture-payment.md"');
  });
});

describe("buildIssueMarkers", () => {
  it("emits a red corner marker at the box's top-left for an issued element", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed issue "does this fire before payment?"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildIssueMarkers(model, new Map([[id, box(100, 100)]]));

    // anchored near the box's top-left corner (left=50, top=80), inset by 5
    expect(group).toContain("55,85");
    // red fill, not the amber note color
    expect(group).toContain("#E53935");
    expect(group).not.toContain("#F4C430");
    // carries a footnote number
    expect(group).toContain(">1</text>");
    // no anchor — nothing to link to; a tooltip carries the text instead
    expect(group).not.toContain("<a");
    expect(group).toContain("<title>1. does this fire before payment?</title>");
  });

  it("emits nothing for an element without an issue", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildIssueMarkers(model, new Map([[id, box(100, 100)]]));
    expect(group).not.toContain("<path");
  });

  it("xml-escapes the tooltip text", () => {
    const model = modelFrom(`
slice "S" {
  event E issue "a & b?"
}
`);
    const id = model.byName.get("e")![0].id;
    const group = buildIssueMarkers(model, new Map([[id, box(0, 0)]]));
    expect(group).toContain("a &amp; b?");
  });

  it("an element with both note and issue gets both markers, on opposite corners with no overlap", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md" issue "does this fire before payment?"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const rects = new Map([[id, box(100, 100)]]);
    const notes = buildNoteMarkers(model, rects);
    const issues = buildIssueMarkers(model, rects);

    // note marker: top-right (right=150, top=80), inset 5 -> 145,85
    expect(notes).toContain("145,85");
    expect(notes).toContain('href="notes/order-placed.md"');
    // issue marker: top-left (left=50, top=80), inset 5 -> 55,85
    expect(issues).toContain("55,85");
    expect(issues).not.toContain("<a");
    // distinct colors, distinct corners — no shared coordinate between the two
    expect(notes).toContain("#F4C430");
    expect(issues).toContain("#E53935");
  });
});

describe("buildDivergenceMarkers", () => {
  it("emits a teal corner marker at the box's bottom-right for a diverged element", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed divergence "tracking token covers idempotency"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildDivergenceMarkers(model, new Map([[id, box(100, 100)]]));

    // anchored near the box's bottom-right corner (right=150, bottom=120), inset by 5
    expect(group).toContain("145,115");
    // teal fill, not the note amber or issue red
    expect(group).toContain("#26A69A");
    expect(group).not.toContain("#F4C430");
    expect(group).not.toContain("#E53935");
    // carries a footnote number
    expect(group).toContain(">1</text>");
    // no anchor — nothing to link to; a tooltip carries the text instead
    expect(group).not.toContain("<a");
    expect(group).toContain("<title>1. tracking token covers idempotency</title>");
  });

  it("emits nothing for an element without a divergence", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed
}
`);
    const id = model.byName.get("order placed")![0].id;
    const group = buildDivergenceMarkers(model, new Map([[id, box(100, 100)]]));
    expect(group).not.toContain("<path");
  });

  it("xml-escapes the tooltip text", () => {
    const model = modelFrom(`
slice "S" {
  event E divergence "a & b?"
}
`);
    const id = model.byName.get("e")![0].id;
    const group = buildDivergenceMarkers(model, new Map([[id, box(0, 0)]]));
    expect(group).toContain("a &amp; b?");
  });

  it("an element with a note, an issue, and a divergence gets all three markers, on non-overlapping corners", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md" issue "does this fire before payment?" divergence "known idiom"
}
`);
    const id = model.byName.get("order placed")![0].id;
    const rects = new Map([[id, box(100, 100)]]);
    const notes = buildNoteMarkers(model, rects);
    const issues = buildIssueMarkers(model, rects);
    const divergences = buildDivergenceMarkers(model, rects);

    expect(notes).toContain("145,85"); // top-right
    expect(issues).toContain("55,85"); // top-left
    expect(divergences).toContain("145,115"); // bottom-right
    expect(notes).toContain("#F4C430");
    expect(issues).toContain("#E53935");
    expect(divergences).toContain("#26A69A");
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

  it("leaves the SVG untouched when there are no notes and no issues", () => {
    const model = modelFrom(`slice "S" {\n  event Order Placed\n}`);
    const svg = fakeSvg(400, 200);
    expect(appendNoteLegend(svg, model)).toBe(svg);
  });

  it("adds an Issues section with the full issue text, distinct from Notes", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md"
  command Place Order issue "who validates the discount code?"
}
`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    expect(out).toContain("Notes");
    expect(out).toContain("Issues");
    expect(out).toContain("Place Order");
    expect(out).toContain("who validates the discount code?");
    // issue heading/number rendered in the red tone, not the note amber
    expect(out).toContain("#8B0000");
  });

  it("grows the canvas for issues-only models (no notes present)", () => {
    const model = modelFrom(`slice "S" {\n  command Do Thing issue "unresolved question"\n}`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    const newH = Number(/height="([\d.]+)pt"/.exec(out)![1]);
    expect(newH).toBeGreaterThan(200);
    expect(out).toContain("Issues");
    expect(out).toContain("unresolved question");
    expect(out).not.toContain(">Notes<");
  });

  it("adds an Accepted Divergences section with the full text, distinct from Notes/Issues", () => {
    const model = modelFrom(`
slice "S" {
  event Order Placed note "notes/order-placed.md"
  command Place Order issue "who validates the discount code?"
  view Retired Things divergence "tracking token covers idempotency"
}
`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    expect(out).toContain("Notes");
    expect(out).toContain("Issues");
    expect(out).toContain("Accepted Divergences");
    expect(out).toContain("Retired Things");
    expect(out).toContain("tracking token covers idempotency");
    // divergence heading/number rendered in the teal tone, not note amber or issue red
    expect(out).toContain("#00695C");
  });

  it("grows the canvas for divergence-only models (no notes/issues present)", () => {
    const model = modelFrom(`slice "S" {\n  view Retired Things divergence "known idiom"\n}`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    const newH = Number(/height="([\d.]+)pt"/.exec(out)![1]);
    expect(newH).toBeGreaterThan(200);
    expect(out).toContain("Accepted Divergences");
    expect(out).toContain("known idiom");
    expect(out).not.toContain(">Notes<");
    expect(out).not.toContain(">Issues<");
  });

  it("MIL-153: leaves the SVG untouched when the only note is a slice's own doc-binding self-reference", () => {
    const model = modelFrom(`
slice "Request Payment" {
  command Request Payment note "slices/request-payment.md"
}
`);
    const svg = fakeSvg(400, 200);
    expect(appendNoteLegend(svg, model)).toBe(svg);
  });

  it("MIL-153: omits a doc-binding self-reference from the Notes list while keeping a genuine note alongside it", () => {
    const model = modelFrom(`
slice "Request Payment" {
  command Request Payment note "slices/request-payment.md"
  event Payment Requested note "notes/payment-requested.md"
}
`);
    const out = appendNoteLegend(fakeSvg(400, 200), model);
    expect(out).toContain("Notes");
    expect(out).toContain("Payment Requested");
    expect(out).toContain("notes/payment-requested.md");
    expect(out).not.toContain("slices/request-payment.md");
    // only one note row rendered, not two
    expect(out).toContain(">1.</tspan>");
    expect(out).not.toContain(">2.</tspan>");
  });
});