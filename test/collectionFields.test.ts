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

  it("slice sync writes the Collection note and a stub per named event", () => {
    const { model: m } = compile(ok);
    const view = buildSliceRegions(m, [2]).find((r) => r.kind === "view")!;
    const text = view.body.join("\n");
    expect(text).toContain("Collection of `AttributeValue`, fed by `Attribute Value Created`, `Attribute Value Deleted`");
    expect(text).toContain("### Scenario: values after Attribute Value Created\n- **Given:** `Attribute Value Created` {{ }}\n- **When:** {{ the view is queried }}\n- **Then:** `values` contains {{ }}");
    expect(text).toContain("### Scenario: values after Attribute Value Deleted\n- **Given:** `Attribute Value Deleted` {{ }}\n- **When:** {{ the view is queried }}\n- **Then:** `values` omits {{ }}");
    expect(text).toContain("copy into `## Scenarios` and complete them there");
  });

  it("three events: Renamed pre-fills updates, an unknown suffix keeps the placeholder", () => {
    const { model: m } = compile(manyEvents(false));
    const text = buildSliceRegions(m, [4]).find((r) => r.kind === "view")!.body.join("\n");
    expect(text).toContain("### Scenario: values after Attribute Value Renamed\n- **Given:** `Attribute Value Renamed` {{ }}\n- **When:** {{ the view is queried }}\n- **Then:** `values` updates {{ }}");
    expect(text).toContain("### Scenario: values after Attribute Value Deleted\n- **Given:** `Attribute Value Deleted` {{ }}\n- **When:** {{ the view is queried }}\n- **Then:** `values` omits {{ }}");
    expect(text).toContain("### Scenario: values after Attribute Value Archived\n- **Given:** `Attribute Value Archived` {{ }}\n- **When:** {{ the view is queried }}\n- **Then:** `values` {{ contains / omits / updates }} {{ }}");
  });

  it("accepts an event supplied only by an `again` instance", () => {
    const src = manyEvents(true);
    expect(sourceWarnings(src)).toEqual([]);
    expect(compile(src).diagnostics.some((d) => d.code === "derived-from-unresolved")).toBe(false);
  });

  it("skips the element check when a named event declares no fields", () => {
    const src = ok
      .replace("Attribute Value Deleted @Catalog { attributeId: string, valueId: string }", "Attribute Value Deleted @Catalog")
      .replace("value: string }", "value: string, label: string }");
    expect(sourceWarnings(src)).toEqual([]);
  });

  it("checks only the element type's own fields, not a nested declared type's", () => {
    const src = ok.replace(
      "type AttributeValue { valueId: string, value: string }",
      "type Meta { x: string }\ntype AttributeValue { valueId: string, value: string, meta: Meta }",
    );
    const w = sourceWarnings(src);
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('"meta"');
  });
});

function manyEvents(again: boolean): string {
  const all = ["Created", "Renamed", "Deleted", "Archived"].map((s) => `"Attribute Value ${s}"`);
  const fromList = again ? all[0] : all.join(", ");
  return `
model "Attrs"
context Catalog
persona Admin

type AttributeValue { valueId: string, value: string }

slice "Add Value" {
  ui Value Form @Admin
  command Add Value
  event Attribute Value Created @Catalog { attributeId: string, valueId: string, value: string }
}

slice "Rename Value" {
  ui Rename Form @Admin
  command Rename Value
  event Attribute Value Renamed @Catalog { attributeId: string, valueId: string, value: string }
}

slice "Remove Value" {
  ui Value List @Admin
  command Remove Value
  event Attribute Value Deleted @Catalog { attributeId: string, valueId: string }
}

slice "Archive Value" {
  ui Archive Form @Admin
  command Archive Value
  event Attribute Value Archived @Catalog { attributeId: string, valueId: string }
}

slice "Attributes" {
  view Attributes from ${fromList} {
    attributeId: string
    values: AttributeValue[] derived from ${all.join(", ")}
  }
  ui Attribute Screen @Admin
}
${again ? `
slice "More Attributes" {
  view Attributes again from ${all.slice(1).join(", ")}
  ui Attribute Screen Again @Admin
}
` : ""}`;
}

describe("collection fields trace through nested event element types (GH #345)", () => {
  const nested = `
model "Variants"
context Catalog
persona Admin

type VariantOptionValue { attributeValueId: string }
type ValueView { attributeValueId: string, key?: string, value?: string }

slice "Create Thing" {
  ui Thing Form @Admin
  command Create Thing
  event Thing Created @Catalog { thingId: string, optionValues: VariantOptionValue[] }
}

slice "Update Thing" {
  ui Thing Edit @Admin
  command Update Thing
  event Thing Updated @Catalog { thingId: string, optionValues: VariantOptionValue[] }
}

slice "Things" {
  view Things from "Thing Created", "Thing Updated" {
    thingId: string
    values: ValueView[] derived from "Thing Created", "Thing Updated"
  }
  ui Thing Screen @Admin
}
`;
  const names = (src: string) =>
    sourceWarnings(src)
      .map((d) => /element field "(\w+)"/.exec(d.message)![1])
      .sort();

  it("owner repro: attributeValueId stops warning; key and value keep warning", () => {
    expect(names(nested)).toEqual(["key", "value"]);
  });

  it("an array event field is resolved through its element type; a non-array field of that type is not", () => {
    const flat = nested.replaceAll("optionValues: VariantOptionValue[]", "optionValues: VariantOptionValue");
    expect(names(flat)).toEqual(["attributeValueId", "key", "value"]);
  });

  it("strictly one level: a field of a type nested inside the element type still warns", () => {
    const deep = nested
      .replace(
        "type VariantOptionValue { attributeValueId: string }",
        "type Inner { deepId: string }\ntype VariantOptionValue { attributeValueId: string, inners: Inner[] }",
      )
      .replace("type ValueView { attributeValueId: string,", "type ValueView { attributeValueId: string, deepId: string,");
    expect(names(deep)).toEqual(["deepId", "key", "value"]);
  });
});

// GH #382: `derived` / `derived from "..."` on a field of a type used as a collection element.
describe("derived collection element fields (GH #382)", () => {
  const library = (loanFields: string, viewFrom = `"Loan Opened", "Loan Renewed"`) => `
model "Library"
context Lending
persona Librarian

type Loan { ${loanFields} }

slice "Open Loan" {
  ui Loan Form @Librarian
  command Open Loan
  event Loan Opened @Lending { bookId: string, loanId: string }
}

slice "Renew Loan" {
  ui Loan Screen @Librarian
  command Renew Loan
  event Loan Renewed @Lending { bookId: string, loanId: string }
}

slice "Books" {
  view Books from ${viewFrom} {
    bookId: string
    loans: Loan[] derived from "Loan Opened", "Loan Renewed"
  }
  ui Book Screen @Librarian
}
`;
  const warnings = (src: string) =>
    compile(src).diagnostics.filter((d) => d.code === "fields-completeness/view-field-no-source");
  const unresolved = (src: string) =>
    compile(src).diagnostics.filter((d) => d.code === "derived-from-unresolved");

  it("warns on audit-stamp element fields that no event carries", () => {
    const w = warnings(library("loanId: string, created: string, updated: string"));
    expect(w.map((d) => d.message).join("\n")).toContain('"created"');
    expect(w).toHaveLength(2);
  });

  it("does not warn when those element fields are marked derived (bare or traced)", () => {
    const src = library(`loanId: string, created: string derived, updated: string derived from "Loan Renewed"`);
    expect(warnings(src)).toEqual([]);
    expect(unresolved(src)).toEqual([]);
  });

  it("still warns on a non-derived element field no event carries", () => {
    const w = warnings(library(`loanId: string, created: string derived, notes: string`));
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain('"notes"');
  });

  it("reports derived-from-unresolved for an element field naming a non-source event", () => {
    const d = unresolved(library(`loanId: string, created: string derived from "Loan Lost"`));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('element field "created"');
    expect(d[0].message).toContain('"Loan Lost"');
  });

  it("exports the marker on the type's fields", () => {
    const src = library(`loanId: string, created: string derived from "Loan Opened"`);
    const { model: m, refs, diagnostics } = compile(src);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = JSON.parse(buildExport(m, refs, diagnostics, src, "library.em").text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loan = doc.model.types.find((t: any) => t.name === "Loan");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = loan.fields.find((f: any) => f.name === "created");
    expect(created).toMatchObject({ derived: true, derivedFrom: ["Loan Opened"] });
  });
});
