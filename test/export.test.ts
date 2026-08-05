// SPDX-License-Identifier: MIT
// Coverage for `em export`'s JSON builder (src/emit/json.ts): schema shape, the
// slice-key/element-ref stable-identity scheme, determinism, and the field-level
// round-trip of note/issue/fields/from. The refuse-on-error gate itself lives in
// cli.ts (mirrors render's `hasErrors` check); tested here at the same level the
// rest of the repo tests that logic — asserting `hasErrors()` on the diagnostics
// `em export` would gate on.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { hasErrors } from "../src/model/validate.js";
import { buildExport } from "../src/emit/json.js";
import { STARTER_EM } from "../src/templates.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const exportOf = (src: string, path = "model.em") => {
  const { model, diagnostics } = compile(src);
  return buildExport(model, diagnostics, src, path);
};
const docOf = (src: string, path = "model.em") => JSON.parse(exportOf(src, path).text);

describe("schema shape", () => {
  it("emits the top-level fields exactly", () => {
    const doc = docOf(STARTER_EM);
    expect(Object.keys(doc)).toEqual(["schemaVersion", "generator", "source", "model", "diagnostics"]);
    expect(doc.schemaVersion).toBe("1.1");
    // generator.version is read from package.json at runtime — comparing against
    // the same file here means a release bump can never leave it stale.
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: PKG_VERSION });
  });

  it("records source.path exactly as given and a sha256 of the source text", () => {
    const doc = docOf(STARTER_EM, "some/relative/path.em");
    expect(doc.source.path).toBe("some/relative/path.em");
    expect(doc.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("nests elements only inside slices, not flattened at model.elements", () => {
    const doc = docOf(STARTER_EM);
    expect(doc.model.elements).toBeUndefined();
    expect(doc.model.slices[0].elements.length).toBeGreaterThan(0);
  });

  it("gives every slice a key/name/index/line/source and every element a ref/kind/name/line", () => {
    const doc = docOf(`
slice "Submit Order" {
  command Submit Order
  event Order Submitted
}
`);
    const slice = doc.model.slices[0];
    expect(slice).toMatchObject({ key: "submit-order", name: "Submit Order", index: 0, source: null });
    expect(typeof slice.line).toBe("number");
    expect(slice.elements[0]).toMatchObject({
      ref: "submit-order/command.submit-order",
      kind: "command",
      name: "Submit Order",
    });
    expect(slice.elements[1].ref).toBe("submit-order/event.order-submitted");
  });

  it("resolves arrows to fromRef/toRef alongside the original names", () => {
    const doc = docOf(`
slice "Submit" {
  ui Screen @Customer
  command Submit Order
}
slice "React" {
  view Orders from "Submit Order"
}
arrow "Orders" -> "Screen"
`);
    const arrow = doc.model.arrows[0];
    expect(arrow).toMatchObject({ from: "Orders", to: "Screen" });
    expect(arrow.fromRef).toBe("react/view.orders");
    expect(arrow.toRef).toBe("submit/ui.screen");
  });
});

describe("nullable fields are explicit null, not omitted", () => {
  it("emits null for fields/note/issue/divergence/from/persona/context/logicalRef when absent", () => {
    const doc = docOf(`slice "S" {\n  command Do Thing\n}`);
    const el = doc.model.slices[0].elements[0];
    expect(el.fields).toBeNull();
    expect(el.note).toBeNull();
    expect(el.issue).toBeNull();
    expect(el.divergence).toBeNull();
    expect(el.from).toBeNull();
    expect(el.persona).toBeNull();
    expect(el.context).toBeNull();
    expect(el.logicalRef).toBeNull();
    expect(el.again).toBe(false);
    expect("fields" in el).toBe(true); // key present with null, not sniffed via absence
    expect("divergence" in el).toBe(true);
  });

  it("emits null for a slice's source when absent", () => {
    const doc = docOf(`slice "S" {\n  command Do Thing\n}`);
    const slice = doc.model.slices[0];
    expect(slice.source).toBeNull();
    expect("source" in slice).toBe(true); // key present with null, not sniffed via absence
  });
});

describe("slice `source` round-trip (MIL-69)", () => {
  it("round-trips a populated slice source", () => {
    const doc = docOf(`
slice "Checkout" source "https://linear.app/team/issue/MIL-60" {
  command Submit Order
}
`);
    expect(doc.model.slices[0].source).toBe("https://linear.app/team/issue/MIL-60");
  });

  it("is independent of the top-level document `source` (file provenance, different shape/scope)", () => {
    const doc = docOf(`
slice "Checkout" source "https://linear.app/team/issue/MIL-60" {
  command Submit Order
}
`);
    expect(doc.source).toMatchObject({ path: "model.em" });
    expect(doc.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.model.slices[0].source).toBe("https://linear.app/team/issue/MIL-60");
  });
});

describe("note / issue / fields / from round-trip", () => {
  const SRC = `
slice "Receive" {
  event Stock Received @Inventory note "notes/stock.md" issue "still open?" {
    sku
    qty: Int
  }
}
slice "Catalog" {
  view Availability from "Stock Received" {
    sku
    onHand: Int
  }
}
`;

  it("round-trips note, issue, and typed/untyped fields", () => {
    const doc = docOf(SRC);
    const event = doc.model.slices[0].elements[0];
    expect(event.note).toBe("notes/stock.md");
    expect(event.issue).toBe("still open?");
    expect(event.fields).toEqual([
      { name: "sku", type: null },
      { name: "qty", type: "Int" },
    ]);
  });

  it("round-trips a divergence annotation", () => {
    const doc = docOf(`slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "tracking token covers idempotency"\n}`);
    const view = doc.model.slices[0].elements[2];
    expect(view.divergence).toBe("tracking token covers idempotency");
  });

  it("resolves a view's `from` to both the name and its ref", () => {
    const doc = docOf(SRC);
    const view = doc.model.slices[1].elements[0];
    expect(view.from).toEqual([{ name: "Stock Received", ref: "receive/event.stock-received" }]);
  });

  it("sets logicalRef to the first instance's ref on a `view … again`, null otherwise", () => {
    const doc = docOf(`
slice "First" {
  command Receive Stock
  event Stock Received
}
slice "Catalog" {
  view Availability from "Stock Received"
}
slice "Second" {
  command Reserve Stock
  event Stock Reserved
}
slice "Catalog Updated" {
  view Availability again from "Stock Reserved"
}
`);
    const [first] = doc.model.slices[1].elements;
    const [again] = doc.model.slices[3].elements;
    expect(first.logicalRef).toBeNull();
    expect(again.again).toBe(true);
    expect(again.logicalRef).toBe(first.ref);
  });
});

describe("stable identity under slice insertion / reordering", () => {
  const A = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
slice "Fulfillment" {
  command Ship Order
  event Order Shipped
}
`;
  const A_WITH_LEADING_SLICE = `
slice "Intake" {
  command Receive Inquiry
  event Inquiry Received
}
` + A;

  it("inserting a new slice BEFORE existing ones leaves their key and element refs unchanged", () => {
    const before = docOf(A).model.slices;
    const after = docOf(A_WITH_LEADING_SLICE).model.slices;
    const checkoutBefore = before.find((s: any) => s.key === "checkout");
    const checkoutAfter = after.find((s: any) => s.key === "checkout");
    expect(checkoutAfter.key).toBe(checkoutBefore.key);
    expect(checkoutAfter.elements.map((e: any) => e.ref)).toEqual(
      checkoutBefore.elements.map((e: any) => e.ref),
    );
    // only positional metadata moves
    expect(checkoutBefore.index).toBe(0);
    expect(checkoutAfter.index).toBe(1);
  });

  it("reordering slices leaves every key/ref the same, only index changes", () => {
    const B = `
slice "Fulfillment" {
  command Ship Order
  event Order Shipped
}
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
`;
    const refsOf = (doc: any) =>
      new Map(
        doc.model.slices.flatMap((s: any) => s.elements.map((e: any) => [e.ref, s.key])),
      );
    expect(refsOf(docOf(A))).toEqual(refsOf(docOf(B)));
  });
});

describe("duplicate names get a `~n` suffix and a warning", () => {
  it("suffixes a duplicate slice name and warns", () => {
    const doc = docOf(`
slice "S" {
  command First
}
slice "S" {
  command Second
}
`);
    expect(doc.model.slices.map((s: any) => s.key)).toEqual(["s", "s~2"]);
    expect(
      doc.diagnostics.some(
        (d: any) => d.severity === "warning" && /duplicate slice name "S"/.test(d.message),
      ),
    ).toBe(true);
  });

  it("suffixes a same-kind-same-name duplicate within one slice and warns", () => {
    const doc = docOf(`
slice "S" {
  command Repeat
  event Something Happened
  command Repeat
}
`);
    const refs = doc.model.slices[0].elements.map((e: any) => e.ref);
    expect(refs).toEqual([
      "s/command.repeat",
      "s/event.something-happened",
      "s/command.repeat~2",
    ]);
    expect(
      doc.diagnostics.some(
        (d: any) => d.severity === "warning" && /duplicate command "Repeat"/.test(d.message),
      ),
    ).toBe(true);
  });
});

describe("determinism", () => {
  it("exports the same source text to byte-identical JSON twice", () => {
    const a = exportOf(STARTER_EM).text;
    const b = exportOf(STARTER_EM).text;
    expect(a).toBe(b);
  });

  it("contains no obvious environment-derived data (timestamps, absolute paths)", () => {
    const text = exportOf(STARTER_EM, "relative/model.em").text;
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp shape
    expect(text).not.toContain(process.cwd());
  });
});

describe("refuses to export when the model has errors (the gate `em export` checks)", () => {
  it("hasErrors() is true for a model with an unresolved view source", () => {
    const { diagnostics } = compile(`slice "S" {\n  view Ghost from "Nope"\n}`);
    expect(hasErrors(diagnostics)).toBe(true);
  });

  it("hasErrors() is false for a clean model, so export proceeds", () => {
    const { diagnostics } = compile(STARTER_EM);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it("warnings (e.g. an open issue) never trip hasErrors — they surface in diagnostics only", () => {
    const src = `slice "S" {\n  command Do Thing issue "unresolved"\n}`;
    const { diagnostics } = compile(src);
    expect(hasErrors(diagnostics)).toBe(false);
    const doc = docOf(src);
    expect(doc.diagnostics.some((d: any) => d.severity === "warning")).toBe(true);
  });
});
