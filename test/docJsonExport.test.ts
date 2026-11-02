// SPDX-License-Identifier: MIT
// GH #401: coverage for the structured slice-doc export (`em export --doc-json`,
// src/emit/docJson.ts). Each test names the acceptance line it covers (issue #401 body +
// slate #403 entry + rulings R3/R6). Real fs fixtures via mkdtempSync — the builder reads
// slices/*.md off disk, same convention as test/docModelConsistencyValidate.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { buildDocJsonExport, DOC_EXPORT_SCHEMA_VERSION } from "../src/emit/docJson.js";
import { buildExport, SCHEMA_VERSION } from "../src/emit/json.js";

const MODEL = `model "Shop"

persona Customer
context Order

slice "Checkout" {
  ui Cart @Customer
  command Submit Order note "slices/checkout.md" {
    total: decimal
  }
  invariant INV-CHK-1 "the order total must be positive"
  event Order Submitted @Order {
    orderId: uuid assigned
    total: decimal
  }
  view Order Confirmation from "Order Submitted"
  ui Confirmation @Customer
}

slice "Cancel" {
  ui Orders @Customer
  command Cancel Order note "slices/cancel.md"
  invariant INV-CXL-1 "only an unshipped order can be cancelled"
  event Order Cancelled @Order
  view Cancel Result from "Order Cancelled"
  ui Done @Customer
}

slice "Ship" {
  ui Shipping @Customer
  command Ship Order
  event Order Shipped @Order
  view Shipment from "Order Shipped"
  ui Shipped @Customer
}
`;

// checkout.md: a ratified/conformed doc with every parsed section populated, plus a deferred
// Open Question so deferral state has something to carry.
const CHECKOUT_DOC = `---
schemaVersion: 1
pattern: state-change
swimlane: Customer → Order
status: ready-to-implement
version: 2
implementedIn: https://example/pr/1
ratifiedBy: alice
ratifiedOn: 2026-10-01
conformedVersion: 2
conformedAt: deadbeef
conformedOn: 2026-10-02
---
# Slice: Checkout

## Invariants / Business Rules
- **INV-CHK-1** — the order total must be positive

## Scenarios (Given / When / Then)
### Scenario: Happy path
- **Given:**
  - a basket with a positive total
- **When:**
  - the customer issues \`Submit Order\`
- **Then:**
  - \`Order Submitted\` is recorded

## Alternate & Error Flows
- Submitting the same basket twice records one order (idempotent on basket id).
- External payment call fails → compensating \`Order Cancelled\`.

## Open Questions
- [ ] Should tax be included in the total?
- [x] Use cents for Money? — v2: yes; deferred to v3 (2026-10-01, alice)
`;

// cancel.md: a draft doc whose prose MENTIONS checkout's INV-CHK-1 (so it becomes a referencing
// slice in the model-level catalog) but declares only its own INV-CXL-1 in the model.
const CANCEL_DOC = `---
schemaVersion: 1
pattern: state-change
swimlane: Customer → Order
status: draft
version: 1
---
# Slice: Cancel

## Dependencies & Read Models Affected
- Upstream: relies on checkout's INV-CHK-1 holding before a cancel is accepted.
`;

let dir: string;
let path: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-doc-json-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
  path = join(dir, "model.em");
  writeFileSync(path, MODEL);
  writeFileSync(join(dir, "slices", "checkout.md"), CHECKOUT_DOC);
  writeFileSync(join(dir, "slices", "cancel.md"), CANCEL_DOC);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function docJson(opts: { includeHtml?: boolean } = {}) {
  const { model, refs, diagnostics } = compile(MODEL);
  const { text } = buildDocJsonExport(model, refs, diagnostics, MODEL, path, opts);
  return JSON.parse(text);
}
const sliceByKey = (doc: any, key: string) => doc.model.slices.find((s: any) => s.key === key);

describe("schema version (R3/R6: own constant, separate from the export schema)", () => {
  it("emits DOC_EXPORT_SCHEMA_VERSION \"1.0\", not the export SCHEMA_VERSION", () => {
    expect(DOC_EXPORT_SCHEMA_VERSION).toBe("1.0");
    expect(docJson().schemaVersion).toBe("1.0");
    // The two constants are distinct surfaces — a bump to one never touches the other.
    expect(DOC_EXPORT_SCHEMA_VERSION).not.toBe(SCHEMA_VERSION);
  });

  it("carries the same envelope (generator/source) as the model export", () => {
    const doc = docJson();
    expect(doc.generator.name).toBe("@milehimikey/em");
    expect(doc.source.path).toBe(path);
    expect(doc.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("plain `em export` stays byte-identical (the authored-body boundary holds)", () => {
  it("the model export is untouched — still schema 1.19, and carries none of the doc-json sections", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const plain = buildExport(model, refs, diagnostics, MODEL, path).text;
    expect(JSON.parse(plain).schemaVersion).toBe(SCHEMA_VERSION);
    // The structured sections live ONLY on the doc-json surface — they never leak into plain export.
    expect(plain).not.toContain("errorFlows");
    expect(plain).not.toContain("openQuestions");
    expect(plain).not.toContain("referencingSlices");
  });
});

describe("per slice: the frontmatter join", () => {
  it("carries status, version, driftSignal and the ratification/shipped/conformed keys", () => {
    const fm = sliceByKey(docJson(), "checkout").frontmatter;
    expect(fm.status).toBe("ready-to-implement");
    expect(fm.version).toBe(2);
    expect(fm.driftSignal).not.toBeNull(); // present — the status/implementedIn coherence class
    expect(fm.ratifiedBy).toBe("alice");
    expect(fm.ratifiedOn).toBe("2026-10-01");
    expect(fm.conformedVersion).toBe(2);
    expect(fm.conformedAt).toBe("deadbeef");
    expect(fm.conformedOn).toBe("2026-10-02");
  });

  it("gives the slice its model-derived pattern (classifySlicePattern), like the model export", () => {
    expect(sliceByKey(docJson(), "checkout").pattern).toBe("state-change");
  });
});

describe("per slice: fields as data (reusing the sliceSections generated regions)", () => {
  it("emits the command's field table rows as {name, type, notes}, grouped by element", () => {
    const groups = sliceByKey(docJson(), "checkout").fields;
    const cmd = groups.find((g: any) => g.kind === "command");
    expect(cmd.element).toBe("Submit Order");
    expect(cmd.fields).toContainEqual({ name: "total", type: "decimal", notes: "yes · —" });
  });

  it("carries the event field's generated note (e.g. `assigned`) in the notes column", () => {
    const groups = sliceByKey(docJson(), "checkout").fields;
    const evt = groups.find((g: any) => g.kind === "event");
    expect(evt.element).toBe("Order Submitted");
    const orderId = evt.fields.find((f: any) => f.name === "orderId");
    expect(orderId.notes).toContain("assigned");
  });
});

describe("per slice: invariants with ids `[{id, text}]`", () => {
  it("emits the model-declared invariant's id and rule text", () => {
    expect(sliceByKey(docJson(), "checkout").invariants).toEqual([
      { id: "INV-CHK-1", text: "the order total must be positive" },
    ]);
  });
});

describe("per slice: scenarios as given/when/then arrays", () => {
  it("emits the authored Given/When/Then blocks (parseScenarios)", () => {
    const scenarios = sliceByKey(docJson(), "checkout").scenarios;
    expect(scenarios).toEqual([
      {
        title: "Happy path",
        given: ["a basket with a positive total"],
        when: ["the customer issues `Submit Order`"],
        then: ["`Order Submitted` is recorded"],
      },
    ]);
  });
});

describe("per slice: error flows", () => {
  it("emits the `## Alternate & Error Flows` top-level bullets in document order", () => {
    expect(sliceByKey(docJson(), "checkout").errorFlows).toEqual([
      "Submitting the same basket twice records one order (idempotent on basket id).",
      "External payment call fails → compensating `Order Cancelled`.",
    ]);
  });
});

describe("per slice: open questions with deferral state", () => {
  it("emits each item's text, checked state, and the version a `deferred to v<n>` marker names", () => {
    expect(sliceByKey(docJson(), "checkout").openQuestions).toEqual([
      { text: "Should tax be included in the total?", checked: false, deferredToVersion: null },
      {
        text: "Use cents for Money? — v2: yes; deferred to v3 (2026-10-01, alice)",
        checked: true,
        deferredToVersion: 3,
      },
    ]);
  });
});

describe("model-level invariant catalog (id -> owning slice -> referencing slices)", () => {
  it("names the declaring slice as owner and every OTHER slice whose doc mentions the id", () => {
    const catalog = docJson().model.invariants;
    expect(catalog).toEqual([
      { id: "INV-CHK-1", owningSlice: "checkout", referencingSlices: ["cancel"] },
      { id: "INV-CXL-1", owningSlice: "cancel", referencingSlices: [] },
    ]);
  });
});

describe("authored body/HTML excluded by default; --include-html opts in", () => {
  it("omits the `html` key entirely by default", () => {
    expect("html" in sliceByKey(docJson(), "checkout")).toBe(false);
  });

  it("includes each slice doc's rendered HTML with includeHtml, null when no doc is bound", () => {
    const doc = docJson({ includeHtml: true });
    expect(sliceByKey(doc, "checkout").html).toContain("<h1>Slice: Checkout</h1>");
    // "ship" has no bound doc of its own -> null, not absent.
    expect(sliceByKey(doc, "ship").html).toBeNull();
  });
});

describe("determinism", () => {
  it("the same source exports byte-identical doc-json", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const a = buildDocJsonExport(model, refs, diagnostics, MODEL, path).text;
    const b = buildDocJsonExport(model, refs, diagnostics, MODEL, path).text;
    expect(a).toBe(b);
  });
});
