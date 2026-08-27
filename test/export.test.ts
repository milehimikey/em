// SPDX-License-Identifier: MIT
// Coverage for `em export`'s JSON builder (src/emit/json.ts): schema shape, the
// slice-key/element-ref stable-identity scheme, determinism, and the field-level
// round-trip of note/issue/fields/from. The refuse-on-error gate itself lives in
// cli.ts (mirrors render's `hasErrors` check); tested here at the same level the
// rest of the repo tests that logic — asserting `hasErrors()` on the diagnostics
// `em export` would gate on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const { model, refs, diagnostics } = compile(src);
  return buildExport(model, refs, diagnostics, src, path);
};
const docOf = (src: string, path = "model.em") => JSON.parse(exportOf(src, path).text);

describe("schema shape", () => {
  it("emits the top-level fields exactly", () => {
    const doc = docOf(STARTER_EM);
    expect(Object.keys(doc)).toEqual(["schemaVersion", "generator", "source", "model", "diagnostics"]);
    expect(doc.schemaVersion).toBe("1.7");
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
    expect(slice).toMatchObject({
      key: "submit-order",
      name: "Submit Order",
      index: 0,
      source: null,
      pattern: "state-change",
    });
    expect(typeof slice.line).toBe("number");
    // No note binding anywhere in this model, and no fixture doc on disk — MIL-91's
    // doc join reports the normal, unremarkable "nobody's declared a doc yet" state.
    expect(slice.doc).toEqual({
      found: false,
      path: "slices/submit-order.md",
      reason: "no-doc-bound",
      status: null,
      version: null,
      implementedIn: null,
      splitFrom: null,
      mergedFrom: [],
      supersededBy: [],
      driftSignal: null,
    });
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
    expect(el.public).toBe(false);
    expect(el.tags).toBeNull();
    expect(el.renamedFrom).toBeNull();
    expect("fields" in el).toBe(true); // key present with null, not sniffed via absence
    expect("divergence" in el).toBe(true);
    expect("tags" in el).toBe(true);
    expect("renamedFrom" in el).toBe(true);
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

describe("`public` round-trip", () => {
  it("exports `public: true` for an event marked public, `false` otherwise", () => {
    const doc = docOf(`
slice "S" {
  event Order Placed @Order public
  event Internal Retry @Order
}
`);
    const [pub, internal] = doc.model.slices[0].elements;
    expect(pub.public).toBe(true);
    expect(internal.public).toBe(false);
  });
});

describe("`tag` round-trip (MIL-66)", () => {
  it("exports `tag: true` for a field carrying an inline identity tag, `false` otherwise", () => {
    const doc = docOf(`
slice "S" {
  event Price Designated {
    priceId: UUID tag
    productId: UUID
  }
}
`);
    const fields = doc.model.slices[0].elements[0].fields;
    expect(fields).toEqual([
      { name: "priceId", type: "UUID", typeRef: null, tag: true, renamedFrom: null, assigned: false },
      { name: "productId", type: "UUID", typeRef: null, tag: false, renamedFrom: null, assigned: false },
    ]);
  });

  it("exports `tag: false` on every field of a declared type (types carry no tag clause)", () => {
    const doc = docOf(`type Money { amount: int, currency: String }`);
    expect(doc.model.types[0].fields).toEqual([
      { name: "amount", type: "int", typeRef: null, tag: false, renamedFrom: null, assigned: false },
      { name: "currency", type: "String", typeRef: null, tag: false, renamedFrom: null, assigned: false },
    ]);
  });

  it("materializes an inline identity tag as a `tags` entry keyed by the field's own name", () => {
    const doc = docOf(`
slice "S" {
  event Price Designated {
    priceId: UUID tag
    productId: UUID
  }
}
`);
    const evt = doc.model.slices[0].elements[0];
    expect(evt.tags).toEqual([{ key: "priceId", kind: "identity", fields: ["priceId"], description: null }]);
  });

  it("exports a composite tag with its field list and null description", () => {
    const doc = docOf(`
slice "S" {
  event Price Designated {
    productId: UUID
    currency: string
  }
  tag productCurrency from productId, currency
}
`);
    const evt = doc.model.slices[0].elements[0];
    expect(evt.tags).toEqual([
      { key: "productCurrency", kind: "composite", fields: ["productId", "currency"], description: null },
    ]);
  });

  it("exports an external tag with its description and null fields", () => {
    const doc = docOf(`slice "S" {\n  event Rule Triple Recorded tag productRuleTriple external "dedup hash"\n}`);
    const evt = doc.model.slices[0].elements[0];
    expect(evt.tags).toEqual([
      { key: "productRuleTriple", kind: "external", fields: null, description: "dedup hash" },
    ]);
  });

  it("orders `tags`: inline identity tags in field order, then element-level clauses in declaration order", () => {
    const doc = docOf(`
slice "S" {
  event Price Designated {
    priceId: UUID tag
    productId: UUID
    currency: string
  }
  tag productCurrency from productId, currency
  tag productRuleTriple external "dedup hash"
}
`);
    const evt = doc.model.slices[0].elements[0];
    expect(evt.tags).toEqual([
      { key: "priceId", kind: "identity", fields: ["priceId"], description: null },
      { key: "productCurrency", kind: "composite", fields: ["productId", "currency"], description: null },
      { key: "productRuleTriple", kind: "external", fields: null, description: "dedup hash" },
    ]);
  });

  it("exports `tags: null` on an event with no tag clauses, and on non-event elements", () => {
    const doc = docOf(`
slice "S" {
  command Do Thing
  event Order Placed
  view Open Orders from "Order Placed"
}
`);
    for (const el of doc.model.slices[0].elements) {
      expect(el.tags).toBeNull();
    }
  });
});

describe("`renamed from` round-trip (MIL-68)", () => {
  it("exports an element-level renamed-from list on an event", () => {
    const doc = docOf(`
slice "S" {
  event PaymentRecorded renamed from "PaymentRegistered" {
    paymentId: UUID
  }
}
`);
    const evt = doc.model.slices[0].elements[0];
    expect(evt.renamedFrom).toEqual(["PaymentRegistered"]);
  });

  it("exports a multi-item element-level renamed-from list, in declaration order", () => {
    const doc = docOf(
      `slice "S" {\n  event PaymentRecorded renamed from "PaymentRegistered", "PaymentCreated"\n}`,
    );
    expect(doc.model.slices[0].elements[0].renamedFrom).toEqual([
      "PaymentRegistered",
      "PaymentCreated",
    ]);
  });

  it("exports an element-level renamed-from list on a command", () => {
    const doc = docOf(`slice "S" {\n  command PlaceOrder renamed from "SubmitOrder"\n}`);
    expect(doc.model.slices[0].elements[0].renamedFrom).toEqual(["SubmitOrder"]);
  });

  it("exports `renamedFrom: null` on an element with no renamed-from clause", () => {
    const doc = docOf(`slice "S" {\n  event Order Placed\n  command Place Order\n}`);
    for (const el of doc.model.slices[0].elements) {
      expect(el.renamedFrom).toBeNull();
    }
  });

  it("exports a field-level renamed-from list, single and multi-item", () => {
    const doc = docOf(`
slice "S" {
  event PaymentRecorded {
    paymentId: UUID
    amountCents: long renamed from "amount", "amt"
  }
}
`);
    expect(doc.model.slices[0].elements[0].fields).toEqual([
      { name: "paymentId", type: "UUID", typeRef: null, tag: false, renamedFrom: null, assigned: false },
      {
        name: "amountCents",
        type: "long",
        typeRef: null,
        tag: false,
        renamedFrom: ["amount", "amt"],
        assigned: false,
      },
    ]);
  });

  it("exports `renamedFrom: null` on every field of a declared type (the clause can't parse there)", () => {
    const doc = docOf(`type Money { amount: int, currency: String }`);
    for (const f of doc.model.types[0].fields) {
      expect(f.renamedFrom).toBeNull();
    }
  });

  it("exports `renamedFrom: null` on a field with no renamed-from clause", () => {
    const doc = docOf(`slice "S" {\n  event E {\n    productId: UUID\n  }\n}`);
    expect(doc.model.slices[0].elements[0].fields[0].renamedFrom).toBeNull();
  });

  it("BLOCKER: a multi-item `renamed from` list followed by trailing `tag` text exports ONE field with ONE identity tag, no phantom field", () => {
    const doc = docOf(
      `slice "S" {\n  event PaymentRecorded { paymentId: UUID renamed from "id", "pid" tag }\n}`,
    );
    const evt = doc.model.slices[0].elements[0];
    expect(evt.fields).toEqual([
      { name: "paymentId", type: "UUID", typeRef: null, tag: true, renamedFrom: ["id", "pid"], assigned: false },
    ]);
    expect(evt.tags).toEqual([
      { key: "paymentId", kind: "identity", fields: ["paymentId"], description: null },
    ]);
  });
});

describe("`assigned` round-trip (MIL-148)", () => {
  it("exports `assigned: true` for a field carrying a trailing `assigned` clause, `false` otherwise", () => {
    const doc = docOf(`
slice "S" {
  command Place Order {
    customerId
  }
  event Order Placed {
    orderId assigned
    customerId
    placedAt: Instant assigned
  }
}
`);
    const fields = doc.model.slices[0].elements[1].fields;
    expect(fields).toEqual([
      { name: "orderId", type: null, typeRef: null, tag: false, renamedFrom: null, assigned: true },
      { name: "customerId", type: null, typeRef: null, tag: false, renamedFrom: null, assigned: false },
      { name: "placedAt", type: "Instant", typeRef: null, tag: false, renamedFrom: null, assigned: true },
    ]);
  });

  it("exports `assigned: false` on every field of a declared type (the clause can't parse there)", () => {
    const doc = docOf(`type Money { amount: int, currency: String }`);
    for (const f of doc.model.types[0].fields) {
      expect(f.assigned).toBe(false);
    }
  });

  it("an `assigned` event field still traces to a view — the marker narrows event←command completeness only, not view←event", () => {
    const doc = docOf(`
slice "S" {
  event Order Placed {
    orderId assigned
  }
}
slice "T" {
  view Open Orders from "Order Placed" {
    orderId
  }
}
`);
    expect(doc.diagnostics.filter((d: any) => d.code.startsWith("fields-completeness"))).toEqual([]);
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
      { name: "sku", type: null, typeRef: null, tag: false, renamedFrom: null, assigned: false },
      { name: "qty", type: "Int", typeRef: null, tag: false, renamedFrom: null, assigned: false },
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
    const found = doc.diagnostics.find((d: any) => /duplicate slice name "S"/.test(d.message));
    expect(found).toMatchObject({ severity: "warning", code: "duplicate-slice-name", refs: ["s~2", "s"] });
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

  it("suffixes a duplicate type name and warns", () => {
    const doc = docOf(`
type Money { amount: int }
type Money { cents: long }
`);
    expect(doc.model.types.map((t: any) => t.ref)).toEqual(["types/money", "types/money~2"]);
    expect(
      doc.diagnostics.some(
        (d: any) => d.severity === "warning" && /duplicate type "Money"/.test(d.message),
      ),
    ).toBe(true);
  });
});

describe("declared `type` export (MIL-64)", () => {
  const SRC = `
type QuoteAcceptedLine {
  lineId: UUID
  unitPrice: Money
  discountIds: UUID[]
}
slice "Accept" {
  command Accept Quote
  event Quote Accepted {
    quoteId: UUID
    lines: QuoteAcceptedLine[]
    winner: QuoteAcceptedLine
  }
}
`;

  it("lists every declared type under model.types with a stable ref, name, line, and fields", () => {
    const doc = docOf(SRC);
    expect(doc.model.types).toHaveLength(1);
    const t = doc.model.types[0];
    expect(t.ref).toBe("types/quoteacceptedline");
    expect(t.name).toBe("QuoteAcceptedLine");
    expect(typeof t.line).toBe("number");
    expect(t.fields).toEqual([
      { name: "lineId", type: "UUID", typeRef: null, tag: false, renamedFrom: null, assigned: false },
      { name: "unitPrice", type: "Money", typeRef: null, tag: false, renamedFrom: null, assigned: false },
      { name: "discountIds", type: "UUID[]", typeRef: null, tag: false, renamedFrom: null, assigned: false },
    ]);
  });

  it("resolves typeRef on an ordinary element field referencing a declared type, bare and array", () => {
    const doc = docOf(SRC);
    const eventFields = doc.model.slices[0].elements[1].fields;
    expect(eventFields).toEqual([
      { name: "quoteId", type: "UUID", typeRef: null, tag: false, renamedFrom: null, assigned: false },
      {
        name: "lines",
        type: "QuoteAcceptedLine[]",
        typeRef: { name: "QuoteAcceptedLine", ref: "types/quoteacceptedline", array: true },
        tag: false,
        renamedFrom: null,
        assigned: false,
      },
      {
        name: "winner",
        type: "QuoteAcceptedLine",
        typeRef: { name: "QuoteAcceptedLine", ref: "types/quoteacceptedline", array: false },
        tag: false,
        renamedFrom: null,
        assigned: false,
      },
    ]);
  });

  it("resolves typeRef on a declared type's own field referencing another declared type (nesting)", () => {
    const doc = docOf(`
type Address { line1: String }
type Order { billing: Address }
`);
    const order = doc.model.types.find((t: any) => t.name === "Order");
    expect(order.fields).toEqual([
      {
        name: "billing",
        type: "Address",
        typeRef: { name: "Address", ref: "types/address", array: false },
        tag: false,
        renamedFrom: null,
        assigned: false,
      },
    ]);
  });

  it("emits types: [] and every field's typeRef: null for a model with no `type` declarations", () => {
    const doc = docOf(`slice "S" {\n  event E { a: Money }\n}`);
    expect(doc.model.types).toEqual([]);
    expect(doc.model.slices[0].elements[0].fields).toEqual([
      { name: "a", type: "Money", typeRef: null, tag: false, renamedFrom: null, assigned: false },
    ]);
  });

  it("bumps schemaVersion to 1.6, additive over 1.5", () => {
    expect(docOf(SRC).schemaVersion).toBe("1.7");
  });
});

describe("slice pattern (MIL-91, model-derived)", () => {
  it("classifies each slice by its element kinds, matching em catalog's classifySlicePattern", () => {
    const doc = docOf(`
slice "Change" {
  command Do Thing
  event Thing Done
}
slice "View" {
  view Summary from "Thing Done"
}
slice "React" {
  processor Notify from "Summary"
}
slice "Cross Boundary" {
  translation Sync from "Summary"
}
slice "Lonely UI" {
  ui Screen @Customer
}
`);
    const [change, view, react, translation, lonely] = doc.model.slices;
    expect(change.pattern).toBe("state-change");
    expect(view.pattern).toBe("state-view");
    expect(react.pattern).toBe("automation");
    expect(translation.pattern).toBe("translation");
    expect(lonely.pattern).toBe("unclassified");
  });
});

describe("slice-doc join (MIL-91)", () => {
  // Real fs fixtures, same convention test/catalog.e2e.test.ts already uses — the doc join
  // is fs-based (existsSync + readFileSync), unlike the rest of this file's fake-path tests.
  let dir: string;
  let modelFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-export-doc-join-"));
    modelFile = join(dir, "model.em");
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "checkout.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: state-change",
        "swimlane: Customer -> Order",
        "status: implemented",
        "version: 2",
        "implementedIn: https://github.com/example/pr/41",
        "---",
        "# Slice: Checkout",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "slices", "no-frontmatter.md"),
      "# Slice: No Frontmatter\n\nJust prose, no frontmatter block.\n",
    );
    // MIL-85 driftSignal fixtures — a re-ratified slice (unpropagated-delta), a shipped slice
    // missing its link (implemented-without-link), and a not-yet-shipped slice (never-implemented).
    writeFileSync(
      join(dir, "slices", "re-ratified.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: state-change",
        "swimlane: Customer -> Order",
        "status: ready-to-implement",
        "version: 2",
        "implementedIn: https://github.com/example/pr/41",
        "---",
        "# Slice: Re Ratified",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "slices", "no-link.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: state-change",
        "swimlane: Customer -> Order",
        "status: implemented",
        "version: 1",
        "---",
        "# Slice: No Link",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "slices", "not-shipped.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: state-change",
        "swimlane: Customer -> Order",
        "status: draft",
        "version: 1",
        "---",
        "# Slice: Not Shipped",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const exportOfFile = (src: string) => {
    const { model, refs, diagnostics } = compile(src);
    return buildExport(model, refs, diagnostics, src, modelFile);
  };
  const docOfFile = (src: string) => JSON.parse(exportOfFile(src).text);

  // The fixture's own validate warnings (e.g. command-untriggered) are irrelevant to the doc
  // join and deliberately not silenced — these tests filter to doc-related codes only.
  const docCodes = (diags: any[]) =>
    diags.filter((d) => ["binding-missing-file", "frontmatter-invalid"].includes(d.code));

  it("reason no-doc-bound: no note clause names the conventional path — no warning, the normal state", () => {
    const doc = docOfFile(`slice "Untouched" {\n  command Do Thing\n}`);
    const slice = doc.model.slices[0];
    expect(slice.doc.found).toBe(false);
    expect(slice.doc.reason).toBe("no-doc-bound");
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });

  it("reason binding-missing-file: note names the conventional path but no file exists there — warns", () => {
    const doc = docOfFile(`slice "Missing Doc" {\n  command Do Thing note "slices/missing-doc.md"\n}`);
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({ found: false, reason: "binding-missing-file", path: "slices/missing-doc.md" });
    const found = doc.diagnostics.find((d: any) => d.code === "binding-missing-file");
    expect(found).toMatchObject({
      severity: "warning",
      refs: ["missing-doc", "missing-doc/command.do-thing"],
    });
  });

  it("reason frontmatter-invalid: doc exists but has no frontmatter block — warns", () => {
    const doc = docOfFile(`slice "No Frontmatter" {\n  command Do Thing note "slices/no-frontmatter.md"\n}`);
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({ found: true, reason: "frontmatter-invalid" });
    const found = doc.diagnostics.find((d: any) => d.code === "frontmatter-invalid");
    expect(found).toMatchObject({ severity: "warning", refs: ["no-frontmatter"] });
  });

  it("happy path: a well-formed, note-bound doc joins every canonical field — no warning", () => {
    const doc = docOfFile(`slice "Checkout" {\n  command Do Thing note "slices/checkout.md"\n}`);
    const slice = doc.model.slices[0];
    expect(slice.doc).toEqual({
      found: true,
      path: "slices/checkout.md",
      reason: null,
      status: "implemented",
      version: 2,
      implementedIn: "https://github.com/example/pr/41",
      splitFrom: null,
      mergedFrom: [],
      supersededBy: [],
      driftSignal: "in-sync",
    });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });
});

describe("slice-doc join: cross-binding (MIL-121)", () => {
  // Same real-fs convention as the describe block above (mkdtempSync + real slice-doc
  // fixtures), but with its own tmp dir/modelFile and its own beforeAll/afterAll — the
  // cross-binding fixtures (a `covering-doc.md`/`covering-invalid.md` and a `checkout.md`
  // shaped for the precedence test) are specific to this block's scenarios, not shared with
  // the block above.
  let dir: string;
  let modelFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-export-doc-join-cross-"));
    modelFile = join(dir, "model.em");
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "covering-doc.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: automation",
        "swimlane: Customer -> Order",
        "status: ready-to-implement",
        "version: 1",
        "covers: covered-slice, checkout",
        "---",
        "# Slice: Covering Doc",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "slices", "covering-invalid.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: automation",
        "swimlane: Customer -> Order",
        "status: ready-to-implement",
        "covers: covered-invalid-slice",
        "---",
        "# Slice: Covering Invalid (missing version:, so frontmatter-invalid)",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "slices", "checkout.md"),
      [
        "---",
        "schemaVersion: 1",
        "pattern: state-change",
        "swimlane: Customer -> Order",
        "status: implemented",
        "version: 2",
        "implementedIn: https://github.com/example/pr/41",
        "---",
        "# Slice: Checkout",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const exportOfFile = (src: string) => {
    const { model, refs, diagnostics } = compile(src);
    return buildExport(model, refs, diagnostics, src, modelFile);
  };
  const docOfFile = (src: string) => JSON.parse(exportOfFile(src).text);
  const docCodes = (diags: any[]) =>
    diags.filter((d: any) => ["binding-missing-file", "frontmatter-invalid"].includes(d.code));

  it("resolves a ratified cross-binding: found, with the covering doc's own path/status", () => {
    const doc = docOfFile(
      `slice "Covered Slice" {\n  command Do Thing note "slices/covering-doc.md"\n}`,
    );
    const slice = doc.model.slices[0];
    expect(slice.doc).toEqual({
      found: true,
      path: "slices/covering-doc.md",
      reason: null,
      status: "ready-to-implement",
      version: 1,
      implementedIn: null,
      splitFrom: null,
      mergedFrom: [],
      supersededBy: [],
      driftSignal: "never-implemented",
    });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });

  it("a mixed-case cross-note still ratifies, and `doc.path` comes back lowercased (not the note's casing)", () => {
    // NOTE_SLICE_PATH is case-insensitive, but readSliceDoc() always reads the lowercased key —
    // doc.path must match what was actually read, or a consumer re-deriving the key from
    // doc.path (sliceReadyValidate.ts) would try to re-read the mixed-case path and fail.
    const doc = docOfFile(
      `slice "Covered Slice" {\n  command Do Thing note "slices/Covering-Doc.md"\n}`,
    );
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({
      found: true,
      path: "slices/covering-doc.md",
      status: "ready-to-implement",
    });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });

  it("a cross-note NOT ratified back by the target doc's `covers` stays no-doc-bound, silently", () => {
    // "checkout.md" exists and has usable frontmatter, but doesn't list "unratified-slice" in
    // `covers` — a one-sided note, not a binding. No mismatch diagnostic (that's MIL-126).
    const doc = docOfFile(
      `slice "Unratified Slice" {\n  command Do Thing note "slices/checkout.md"\n}`,
    );
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({ found: false, reason: "no-doc-bound", path: "slices/unratified-slice.md" });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });

  it("`covers` in an otherwise frontmatter-invalid doc doesn't ratify — stays no-doc-bound", () => {
    const doc = docOfFile(
      `slice "Covered Invalid Slice" {\n  command Do Thing note "slices/covering-invalid.md"\n}`,
    );
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({ found: false, reason: "no-doc-bound" });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });

  it("canonical binding (note naming this slice's own path) wins over a cross-binding in the same slice", () => {
    // "checkout" IS listed in covering-doc.md's `covers` above, so if cross-binding search ran
    // first it would (wrongly) also resolve here — canonical must be checked first and win.
    const doc = docOfFile(
      `slice "Checkout" {\n  command Do Thing note "slices/checkout.md"\n  event Something note "slices/covering-doc.md"\n}`,
    );
    const slice = doc.model.slices[0];
    expect(slice.doc).toMatchObject({
      found: true,
      path: "slices/checkout.md",
      status: "implemented",
      version: 2,
    });
    expect(docCodes(doc.diagnostics)).toEqual([]);
  });
});

describe("driftSignal (MIL-85, status/implementedIn coherence)", () => {
  let dir: string;
  let modelFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-export-drift-signal-"));
    modelFile = join(dir, "model.em");
    mkdirSync(join(dir, "slices"), { recursive: true });
    const writeDoc = (sliceKey: string, status: string, implementedIn: string | null) =>
      writeFileSync(
        join(dir, "slices", `${sliceKey}.md`),
        [
          "---",
          "schemaVersion: 1",
          "pattern: state-change",
          "swimlane: Customer -> Order",
          `status: ${status}`,
          "version: 2",
          ...(implementedIn ? [`implementedIn: ${implementedIn}`] : []),
          "---",
          "body",
          "",
        ].join("\n"),
      );
    writeDoc("in-sync", "implemented", "https://github.com/example/pr/1");
    writeDoc("no-link", "implemented", null);
    writeDoc("re-ratified", "ready-to-implement", "https://github.com/example/pr/1");
    writeDoc("not-shipped", "draft", null);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Slice titles are chosen so classifySlicePattern's kebab key matches each fixture's filename
  // (e.g. "In Sync" -> "in-sync") — the doc join resolves `slices/<sliceKey>.md` off the slice's
  // own key, and requires a `note` binding pointing at that same conventional path.
  const driftSignalOf = (title: string, sliceKey: string) => {
    const { model, refs, diagnostics } = compile(
      `slice "${title}" {\n  command Do Thing note "slices/${sliceKey}.md"\n}`,
    );
    const doc = JSON.parse(buildExport(model, refs, diagnostics, "src", modelFile).text);
    return doc.model.slices[0].doc.driftSignal;
  };

  it("in-sync: implemented with a link", () => {
    expect(driftSignalOf("In Sync", "in-sync")).toBe("in-sync");
  });

  it("implemented-without-link: implemented with no link — the bonus validate warning's trigger", () => {
    expect(driftSignalOf("No Link", "no-link")).toBe("implemented-without-link");
  });

  it("unpropagated-delta: re-ratified past a shipped version — expected, never flagged", () => {
    expect(driftSignalOf("Re Ratified", "re-ratified")).toBe("unpropagated-delta");
  });

  it("never-implemented: not yet shipped, no link", () => {
    expect(driftSignalOf("Not Shipped", "not-shipped")).toBe("never-implemented");
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
