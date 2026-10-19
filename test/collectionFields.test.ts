// SPDX-License-Identifier: MIT
// GH #288: a view field typed `T[]` with `derived from "E1", "E2"` traces T's fields to the
// named child events; `em slice sync` writes a Collection note + add/remove scenario stubs.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { buildSliceRegions } from "../src/catalog/sliceSections.js";
import { buildExport } from "../src/emit/json.js";

const model = (valueFields: string) => `
model "Attrs"
context Catalog
persona Admin

type AttributeValue { valueId: string, value: string }

slice "Add Value" {
  ui Value Form @Admin
  command Add Value
  event Attribute Value Created @Catalog { attributeId: string, valueId: string, value: string }
}

slice "Remove Value" {
  ui Value List @Admin
  command Remove Value
  event Attribute Value Deleted @Catalog { attributeId: string, valueId: string }
}

slice "Attributes" {
  view Attributes from "Attribute Value Created", "Attribute Value Deleted" {
    attributeId: string
    values: AttributeValue[]${valueFields}
  }
  ui Attribute Screen @Admin
}
`;

const ok = model(` derived from "Attribute Value Created", "Attribute Value Deleted"`);
const sourceWarnings = (src: string) =>
  compile(src).diagnostics.filter((d) => d.code === "fields-completeness/view-field-no-source");

function exported(src: string) {
  const { model: m, refs, diagnostics } = compile(src);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = JSON.parse(buildExport(m, refs, diagnostics, src, "attrs.em").text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = doc.model.slices.flatMap((s: any) => s.elements).find((e: any) => e.kind === "view");
  return { doc, view };
}

describe("collection fields (GH #288)", () => {
  it("passes fields-completeness when each element field traces to a named child event", () => {
    expect(sourceWarnings(ok)).toEqual([]);
  });

  it("warns on an element field no named event carries", () => {
    const w = sourceWarnings(ok.replace("value: string }", "value: string, label: string }"));
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('collection field "values"');
    expect(w[0].message).toContain('"label"');
  });

  it("still reports a named event outside the view's sources", () => {
    const src = model(` derived from "Attribute Value Created", "Nope"`);
    expect(compile(src).diagnostics.some((d) => d.code === "derived-from-unresolved")).toBe(true);
  });

  it("exports collection: true only on the traced Type[] field", () => {
    const { doc, view } = exported(ok);
    const byName = Object.fromEntries((view.fields as { name: string; collection: boolean }[]).map((f) => [f.name, f.collection]));
    expect(byName).toEqual({ attributeId: false, values: true });
    expect(doc.schemaVersion).toBe("1.19");
  });

  it("does not mark a bare-derived Type[] field as a collection", () => {
    const { view } = exported(model(" derived"));
    expect((view.fields as { name: string; collection: boolean }[]).find((f) => f.name === "values")!.collection).toBe(false);
  });

  it("slice sync writes the Collection note and add/remove scenario stubs", () => {
    const { model: m } = compile(ok);
    const view = buildSliceRegions(m, [2]).find((r) => r.kind === "view")!;
    const text = view.body.join("\n");
    expect(text).toContain("Collection of `AttributeValue`, fed by `Attribute Value Created`, `Attribute Value Deleted`");
    expect(text).toContain("- Given `Attribute Value Created` {{ }} Then `values` contains {{ }}");
    expect(text).toContain("- Given `Attribute Value Deleted` {{ }} Then `values` omits {{ }}");
  });
});
