// SPDX-License-Identifier: MIT
// GH #278: `event A | B @Ctx` — alternative events of one command on one context, in one slice.
import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { semanticEdges } from "../src/model/edges.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { compile } from "../src/pipeline.js";
import { buildExportDoc } from "../src/emit/json.js";
import { composeSvg, layoutDot } from "../src/render/render.js";
import { emitDot } from "../src/emit/dot.js";
import { buildSliceRegions } from "../src/catalog/sliceSections.js";
import { buildSliceDocContent } from "../src/cli/sliceNew.js";
import { buildShapeReport, shapeRuleCodes } from "../src/cli/shape.js";

const PIM = `model "PIM"
context Product
slice "Create External ID" {
  ui Create External ID
  command CreateExternalId { externalId: String }
  event ProductExternalIdCreated | VariantExternalIdCreated @Product public { externalId: String }
}
slice "List External IDs" {
  view External IDs from "ProductExternalIdCreated", "VariantExternalIdCreated"
  ui External IDs Screen
}
`;
const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model), computeRefs(model));
};
const codes = (src: string) => diagsFor(src).map((d) => d.code);

describe("alternative events (GH #278)", () => {
  it("parses one line into one full event per alternative, sharing context/clauses/fields", () => {
    const m = modelFrom(PIM);
    const evs = m.slices[0].elements.filter((e) => e.kind === "event");
    expect(evs.map((e) => e.name)).toEqual(["ProductExternalIdCreated", "VariantExternalIdCreated"]);
    expect(evs.every((e) => e.context === "Product" && e.public === true)).toBe(true);
    expect(evs.map((e) => e.fields?.map((f) => f.name))).toEqual([["externalId"], ["externalId"]]);
    expect(evs[0].alternativeGroup).toBe(evs[0].id);
    expect(evs[1].alternativeGroup).toBe(evs[0].id);
    expect(evs[1].fields).not.toBe(evs[0].fields);
  });

  it("PIM-shaped fixture validates clean, one slice per command (no grid-collision)", () => {
    expect(diagsFor(PIM)).toEqual([]);
    expect(layout(modelFrom(PIM)).collisions).toEqual([]);
  });

  it("model.edges: command -> each alternative", () => {
    const m = modelFrom(PIM);
    const cmd = m.elements.find((e) => e.kind === "command")!;
    const targets = semanticEdges(m).filter((e) => e.from === cmd.id).map((e) => m.byId.get(e.to)!.name);
    expect(targets).toEqual(["ProductExternalIdCreated", "VariantExternalIdCreated"]);
  });

  it("two events on one context WITHOUT the alternative form is still a grid-collision", () => {
    const src = `model "M"\ncontext C\nslice "S" {\n command Do\n event A @C\n event B @C\n}\n`;
    expect(codes(src)).toContain("grid-collision");
  });

  it("a quoted name keeps a literal '|'", () => {
    const m = modelFrom(`model "M"\nslice "S" {\n command Do\n event "A | B"\n}\n`);
    expect(m.slices[0].elements.find((e) => e.kind === "event")!.name).toBe("A | B");
  });

  it("rejects an empty alternative", () => {
    expect(() => parse(`model "M"\nslice "S" {\n command Do\n event A | @C\n}\n`)).toThrow(ParseError);
  });

  it("standalone tag lines reach every alternative", () => {
    const m = modelFrom(`model "M"\nslice "S" {\n command Do\n event A | B @C { k: String, j: String }\n tag grp from k, j\n}\n`);
    const evs = m.slices[0].elements.filter((e) => e.kind === "event");
    expect(evs.map((e) => e.tags?.length)).toEqual([1, 1]);
  });

  it("errors when the alternatives have no shared command", () => {
    const src = `model "M"\nslice "S" {\n event A | B @C\n}\n`;
    const d = diagsFor(src).find((x) => x.code === "alternative-events-no-command")!;
    expect(d.severity).toBe("error");
  });

  it("command-repeated-across-slices fires on the old shape, not on the single-slice form", () => {
    const old = `model "M"\ncontext C\nslice "A" {\n ui U\n command Do\n event A @C\n}\nslice "B" {\n ui U2\n command Do\n event B @C\n}\n`;
    const d = diagsFor(old).find((x) => x.code === "command-repeated-across-slices")!;
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("event A | B @Context");
    expect(codes(PIM)).not.toContain("command-repeated-across-slices");
  });

  it("export carries alternativeGroup (schema 1.19), null elsewhere", () => {
    const { model, refs, diagnostics } = compile(PIM);
    const { doc } = buildExportDoc(model, refs, diagnostics, PIM, "pim.em");
    const els = (doc as any).model.slices[0].elements;
    const cmd = els.find((e: any) => e.kind === "command");
    const [a, b] = els.filter((e: any) => e.kind === "event");
    expect((doc as any).schemaVersion).toBe("1.19");
    expect(a.alternativeGroup).toBe(a.ref);
    expect(b.alternativeGroup).toBe(a.ref);
    expect(cmd.alternativeGroup).toBeNull();
  });

  it("renders the alternatives in one box with an 'or' marker", async () => {
    const { model, grid } = compile(PIM);
    const dot = emitDot(model, grid);
    expect(dot).not.toMatch(/^\s*variantexternalidcreated \[/im);
    const svg = composeSvg(await layoutDot(dot), model, grid, ".", ".");
    expect(svg).toContain("VariantExternalIdCreated");
    expect(svg).toContain(">or<");
  });

  it("slice sync writes one event region listing every alternative with its own table", () => {
    const { model } = compile(PIM);
    const regions = buildSliceRegions(model, [0]).filter((r) => r.kind === "event");
    expect(regions).toHaveLength(1);
    expect(regions[0].name).toBe("em-slice-event");
    const body = regions[0].body.join("\n");
    expect(body).toContain("**Records one of:**");
    expect(body).toContain("**Event:** `ProductExternalIdCreated` → context `Product`");
    expect(body).toContain("**Event:** `VariantExternalIdCreated` → context `Product`");
    expect(body.match(/\| externalId /g)).toHaveLength(2);
  });

  it("the scenario template gains one Then per alternative", () => {
    const doc = buildSliceDocContent("S", "s", "State Change" as any, "Product", undefined, [
      "ProductExternalIdCreated",
      "VariantExternalIdCreated",
    ]);
    expect(doc).toContain("### Scenario: Records ProductExternalIdCreated");
    expect(doc).toContain("### Scenario: Records VariantExternalIdCreated");
    expect(doc).not.toContain("### Scenario: Happy path");
  });
});

describe("alternative events — block form and rulings (GH #278)", () => {
  const BLOCK = `model "PIM"
context Product
slice "Create External ID" {
  ui Create External ID
  command CreateExternalId { productId: String, variantId: String }
  oneof {
    event ProductExternalIdCreated @Product public note "a.md" { productId: String }
    event VariantExternalIdCreated @Product { variantId: String }
  }
  invariant INV-PIM-1 "unique per system"
}
`;
  it("block form: each alternative keeps its own fields and clauses, one group, one cell", () => {
    const m = modelFrom(BLOCK);
    const [a, b] = m.slices[0].elements.filter((e) => e.kind === "event");
    expect(a.fields?.map((f) => f.name)).toEqual(["productId"]);
    expect(b.fields?.map((f) => f.name)).toEqual(["variantId"]);
    expect(a.public).toBe(true);
    expect(b.public).toBeUndefined();
    expect(a.note).toBe("a.md");
    expect(b.alternativeGroup).toBe(a.id);
    expect(layout(m).collisions).toEqual([]);
    expect(diagsFor(BLOCK).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("block form supports multi-line field blocks", () => {
    const m = modelFrom(
      `model "M"\ncontext C\nslice "S" {\n command Do\n oneof {\n  event A @C {\n   x: String\n  }\n  event B @C {\n   y: String\n  }\n }\n}\n`,
    );
    const evs = m.slices[0].elements.filter((e) => e.kind === "event");
    expect(evs.map((e) => e.fields?.[0].name)).toEqual(["x", "y"]);
  });

  it("alternatives on different contexts are a parse error (both forms)", () => {
    expect(() => parse(`model "M"\nslice "S" {\n command Do\n oneof {\n  event A @X\n  event B @Y\n }\n}\n`)).toThrow(/share one context/);
    expect(() => parse(`model "M"\nslice "S" {\n command Do\n event A @Alpha | B @Beta\n}\n`)).toThrow(/share one context/);
    expect(() => parse(`model "M"\nslice "S" {\n command Do\n event A @Alpha | B\n}\n`)).toThrow(/share one context/);
  });

  it("oneof needs two events, holds only events, and must close", () => {
    expect(() => parse(`model "M"\nslice "S" {\n oneof {\n  event A\n }\n}\n`)).toThrow(/at least two/);
    expect(() => parse(`model "M"\nslice "S" {\n oneof {\n  command A\n }\n}\n`)).toThrow(/not valid inside a oneof/);
    expect(() => parse(`model "M"\nslice "S" {\n oneof {\n  event A\n  event B\n`)).toThrow(/missing a closing/);
  });

  it("a standalone invariant binds to ALL alternatives (both forms) and is declared once", () => {
    const inline = `model "M"\ncontext C\nslice "S" {\n command Do\n event A | B @C\n invariant INV-ABC-1 "r"\n}\n`;
    for (const src of [inline, BLOCK.replace("INV-PIM-1", "INV-ABC-1")]) {
      const m = modelFrom(src);
      const evs = m.slices[0].elements.filter((e) => e.kind === "event");
      expect(evs.map((e) => e.invariants?.map((i) => i.id))).toEqual([["INV-ABC-1"], ["INV-ABC-1"]]);
      expect(diagsFor(src).map((d) => d.code)).not.toContain("invariants/duplicate-id");
    }
  });

  it("an invariant inside a oneof binds to the alternative above it only", () => {
    const m = modelFrom(
      `model "M"\ncontext C\nslice "S" {\n command Do\n oneof {\n  event A @C\n  invariant INV-ABC-1 "r"\n  event B @C\n }\n}\n`,
    );
    const evs = m.slices[0].elements.filter((e) => e.kind === "event");
    expect(evs.map((e) => e.invariants?.length ?? 0)).toEqual([1, 0]);
  });

  it("the grid-collision alternatives hint appears only when both colliders are events", () => {
    const ev = `model "M"\ncontext C\nslice "S" {\n command Do\n event A @C\n event B @C\n}\n`;
    const cmd = `model "M"\nslice "S" {\n command Do\n command Do2\n}\n`;
    expect(diagsFor(ev).find((d) => d.code === "grid-collision")!.message).toContain("event A | B @Context");
    expect(diagsFor(cmd).find((d) => d.code === "grid-collision")!.message).not.toContain("event A | B");
  });
});

describe("alternative events — invariants region (GH #278)", () => {
  it("lists invariants in source order and annotates ones bound to a single alternative", () => {
    const src = `model "M"
context C
slice "S" {
  command Do
  oneof {
    event Job Done @C
    invariant INV-JOB-1 "only on success"
    event Job Failed @C
    invariant INV-JOB-2 "only on failure"
  }
  invariant INV-JOB-3 "always"
}
`;
    const { model } = compile(src);
    const inv = buildSliceRegions(model, [0]).find((r) => r.kind === "invariants")!;
    expect(inv.body).toEqual([
      "- **INV-JOB-1** — only on success — binds to `Job Done` only",
      "- **INV-JOB-2** — only on failure — binds to `Job Failed` only",
      "- **INV-JOB-3** — always",
    ]);
  });
});

describe("alternative events compose with shared events (GH #278 + #279)", () => {
  it("an alternative that is also recorded elsewhere resolves to the one logical event", () => {
    const src = `model "M"
context C
slice "First" {
  command Do1
  event Job Done @C { id: String }
}
slice "Second" {
  command Do2
  oneof {
    event Job Done @C
    event Job Failed @C { reason: String }
  }
}
`;
    const m = modelFrom(src);
    const [first] = m.slices[0].elements.filter((e) => e.kind === "event");
    const [again, other] = m.slices[1].elements.filter((e) => e.kind === "event");
    expect(again.logicalId).toBe(first.id);
    expect(again.fields?.map((f) => f.name)).toEqual(["id"]);
    expect(other.logicalId).toBe(other.id);
    expect(again.alternativeGroup).toBe(again.id);
    expect(other.alternativeGroup).toBe(again.id);
    expect(layout(m).collisions).toEqual([]);
    expect(diagsFor(src).filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("command-repeated-across-slices in `em validate --shape` (GH #278 + #282)", () => {
  it("is selected by family: shape and reported on the old one-column-per-event shape", () => {
    const old = `model "M"\ncontext C\nslice "A" {\n ui U\n command Do\n event A @C\n}\nslice "B" {\n ui U2\n command Do\n event B @C\n}\n`;
    expect(shapeRuleCodes()).toContain("command-repeated-across-slices");
    const { diagnostics } = compile(old);
    const rule = buildShapeReport(diagnostics, []).rules.find((r) => r.code === "command-repeated-across-slices")!;
    expect(rule.findings.length).toBe(1);
    expect(rule.docAnchor).toBe("shape");
  });
});
