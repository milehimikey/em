// SPDX-License-Identifier: MIT
// GH #401: coverage for the structured slice-doc export (`em export --doc-json`,
// src/emit/docJson.ts). Each test names the acceptance line it covers (issue #401 body +
// slate #403 entry + rulings R3/R6). Real fs fixtures via mkdtempSync — the builder reads
// slices/*.md off disk, same convention as test/docModelConsistencyValidate.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildDocJsonExport, DOC_EXPORT_SCHEMA_VERSION } from "../src/emit/docJson.js";
import { buildExport, SCHEMA_VERSION } from "../src/emit/json.js";
import { errorFlows, openQuestions } from "../src/catalog/sliceDoc.js";
import { extractDeclaredInvariantRules } from "../src/cli/coverage.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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
- **INV-CHK-1:** stated in the doc with the declaring label too — the model's rule must win

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
  it("emits DOC_EXPORT_SCHEMA_VERSION \"1.2\", not the export SCHEMA_VERSION", () => {
    expect(DOC_EXPORT_SCHEMA_VERSION).toBe("1.2");
    expect(docJson().schemaVersion).toBe("1.2");
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

describe("per slice: invariants with ids `[{id, text, source}]`", () => {
  it("emits the model-declared invariant's id and rule text, source \"model\"", () => {
    expect(sliceByKey(docJson(), "checkout").invariants).toEqual([
      { id: "INV-CHK-1", text: "the order total must be positive", source: "model" },
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

describe("per slice: sections (GH #487, schema 1.1)", () => {
  it("lists the authored sections with class; changed is null for a doc with no section hashes", () => {
    const sections: Array<{ heading: string; class: string; changed: boolean | null }> = sliceByKey(docJson(), "checkout").sections;
    expect(sections.map((s) => s.heading)).toContain("Scenarios (Given / When / Then)");
    expect(sections.find((s) => s.heading === "Scenarios (Given / When / Then)")).toEqual({
      heading: "Scenarios (Given / When / Then)",
      class: "behaviour",
      changed: null,
    });
    expect(sections.every((s) => s.changed === null)).toBe(true);
  });

  it("is null when no doc is bound", () => {
    expect(sliceByKey(docJson(), "ship").sections).toBeNull();
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
      { id: "INV-CHK-1", owningSlice: "checkout", source: "model", referencingSlices: ["cancel"] },
      { id: "INV-CXL-1", owningSlice: "cancel", source: "model", referencingSlices: [] },
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

// ---------------------------------------------------------------------------------------------
// Round 2 (reviewer/critic findings).

describe("doc-declared invariant fallback (round 2 item 2): a 1.13-style estate still exports", () => {
  // A doc that declares its invariant ONLY with the `**INV-X:**` label — no model `invariant`
  // line — the `em coverage`/`em query invariant` precedence: model first, doc as fallback.
  const DOC_ONLY_MODEL = `model "Legacy"
persona User
context Order
slice "Refund" {
  ui Refund Screen @User
  command Refund Order note "slices/refund.md"
  event Order Refunded @Order
  view Refund Result from "Order Refunded"
  ui Refund Done @User
}
`;
  const REFUND_DOC = `---
schemaVersion: 1
pattern: state-change
swimlane: User → Order
status: draft
version: 1
---
# Slice: Refund

## Invariants / Business Rules
- **INV-REF-1:** a refund never exceeds the captured amount
- INV-CHK-1 — cited here as context only, never a declaration (no label)

## Scenarios
`;
  let legacyDir: string;
  let legacyPath: string;
  beforeAll(() => {
    legacyDir = mkdtempSync(join(tmpdir(), "em-doc-json-legacy-"));
    mkdirSync(join(legacyDir, "slices"), { recursive: true });
    legacyPath = join(legacyDir, "model.em");
    writeFileSync(legacyPath, DOC_ONLY_MODEL);
    writeFileSync(join(legacyDir, "slices", "refund.md"), REFUND_DOC);
  });
  afterAll(() => rmSync(legacyDir, { recursive: true, force: true }));

  function legacyDocJson() {
    const { model, refs, diagnostics } = compile(DOC_ONLY_MODEL);
    return JSON.parse(buildDocJsonExport(model, refs, diagnostics, DOC_ONLY_MODEL, legacyPath).text);
  }

  it("exports the doc-label-declared invariant with source \"doc\" (plain citations never count)", () => {
    expect(sliceByKey(legacyDocJson(), "refund").invariants).toEqual([
      { id: "INV-REF-1", text: "a refund never exceeds the captured amount", source: "doc" },
    ]);
  });

  it("the catalog attributes the doc-declared id to its slice, marked source \"doc\"", () => {
    expect(legacyDocJson().model.invariants).toEqual([
      { id: "INV-REF-1", owningSlice: "refund", source: "doc", referencingSlices: [] },
    ]);
  });

  it("a model-declared id wins over the doc's label for the same id (declared-in-both restates, never duplicates)", () => {
    // The main fixture's checkout doc declares INV-CHK-1 with a TRUE `**INV-CHK-1:**` declaring
    // label (which extractDeclaredInvariantRules does return) — without the dedupe guard this
    // would be a second, "doc"-sourced entry with the doc's own wording. Exactly one entry, the
    // model's, must survive.
    const invs = sliceByKey(docJson(), "checkout").invariants.filter((i: any) => i.id === "INV-CHK-1");
    expect(invs).toEqual([{ id: "INV-CHK-1", text: "the order total must be positive", source: "model" }]);
  });

  it("examples/order-fulfillment (a real doc-only estate) exports a NON-EMPTY catalog", () => {
    const doc = orderFulfillmentDocJson();
    expect(doc.model.invariants.length).toBeGreaterThan(0);
    expect(doc.model.invariants).toContainEqual(
      expect.objectContaining({ id: "INV-CHK-1", owningSlice: "checkout", source: "doc" }),
    );
  });
});

function orderFulfillmentDocJson() {
  const emPath = join(TEST_DIR, "..", "examples", "order-fulfillment", "order-fulfillment.em");
  const src = readFileSync(emPath, "utf8");
  const { model, refs, diagnostics } = compile(src);
  return JSON.parse(buildDocJsonExport(model, refs, diagnostics, src, emPath).text);
}

describe("doc-fallback invariant text joins soft-wrapped declaring labels (round 3 item 1)", () => {
  it("extractDeclaredInvariantRules joins a wrapped label's continuation lines — INV-CAP-1's two-liner, verbatim", () => {
    // Copied verbatim from examples/order-fulfillment/slices/capture-payment.md: the rule
    // sentence wraps onto a second physical line; the nested elaboration bullet below it is NOT
    // part of the rule text and ends the wrap.
    const body = `## Invariants / Business Rules

- **INV-CAP-1 (idempotency):** capturing twice for the same \`authorizationId\` is a defect, not a
  legitimate retry.
  - The command handler must dedupe on it. The gateway is known to retry.
- **INV-CAP-2:** a declined capture must not silently disappear.
  - See Open Questions; this model doesn't yet have a failure event for it.
`;
    expect(extractDeclaredInvariantRules(body)).toEqual([
      { id: "INV-CAP-1", text: "capturing twice for the same `authorizationId` is a defect, not a legitimate retry." },
      { id: "INV-CAP-2", text: "a declined capture must not silently disappear." },
    ]);
  });

  it("the 4 flagship order-fulfillment entries export their full sentence, never ending mid-line", () => {
    const doc = orderFulfillmentDocJson();
    const invOf = (sliceKey: string, id: string) =>
      doc.model.slices.find((s: any) => s.key === sliceKey).invariants.find((i: any) => i.id === id);
    expect(invOf("capture-payment", "INV-CAP-1").text).toBe(
      "capturing twice for the same `authorizationId` is a defect, not a legitimate retry.",
    );
    expect(invOf("browse-catalog", "INV-BC-1").text).toBe(
      "An order's `total` must equal the sum of its line items' `unitPrice * quantity` at order time.",
    );
    expect(invOf("browse-catalog", "INV-BC-2").text).toBe(
      "Every line item's product must be in stock at the moment `Place Order` is handled (checked then, not reserved earlier).",
    );
    expect(invOf("view-open-orders", "INV-VOO-1").text).toBe(
      "An order appears in this view exactly once per `Order Placed` it's projected from.",
    );
    // The class, not just the instances: no catalog-owned invariant anywhere in the estate ends
    // mid-sentence on a dangling article/conjunction the way the truncation did ("…, not a").
    for (const s of doc.model.slices) {
      for (const inv of s.invariants) {
        expect(inv.text, `${inv.id} in ${s.key}`).not.toMatch(/\b(?:a|an|the|is|not|and|or|of|to)$/);
      }
    }
  });
});

describe("alternatives-aware field groups (round 2 item 3)", () => {
  const ALT_MODEL = `model "Alt"
persona User
context Billing
slice "Pay" {
  ui Pay Screen @User
  command Take Payment { txnId: uuid }
  event Payment Succeeded | Payment Failed @Billing { txnId: uuid }
}
slice "Payment Status" {
  view Payment Status from "Payment Succeeded", "Payment Failed"
  ui Status @User
}
`;

  it("an `event A | B` slice exports one group per alternative, each under its own element name", () => {
    const { model, refs, diagnostics } = compile(ALT_MODEL);
    const doc = JSON.parse(buildDocJsonExport(model, refs, diagnostics, ALT_MODEL, path).text);
    const eventGroups = sliceByKey(doc, "pay").fields.filter((g: any) => g.kind === "event");
    expect(eventGroups.map((g: any) => g.element)).toEqual(["Payment Succeeded", "Payment Failed"]);
    // Each alternative carries only its OWN rows — never both alternatives' rows concatenated
    // under the first alternative's name.
    for (const g of eventGroups) {
      expect(g.fields).toEqual([{ name: "txnId", type: "uuid", notes: "yes · from command `Take Payment`" }]);
    }
  });
});

describe("soft-wrapped bullets (round 2 item 4): continuation lines join the item", () => {
  // Wrapped bullets copied from the real examples the critic demonstrated on:
  // examples/order-fulfillment/slices/capture-payment.md (Open Questions) and checkout.md
  // (Alternate & Error Flows).
  const WRAPPED_BODY = `# Slice: Wrapped

## Alternate & Error Flows

- Idempotency: covered by INV-CHK-1 — a resubmit while a request is outstanding is rejected
  outright rather than silently deduplicated, so the customer sees the state clearly instead
  of wondering if their second click did anything.

## Open Questions

- [ ] What resolves \`authorizationId\` → \`orderId\` for the \`Payment Captured\` event's
  \`orderId\` field? Not modeled yet — the field-completeness warning on this event is real.
- [ ] Partial captures (e.g. after a line-item cancellation reduces the authorized amount) —
  supported, or does \`Capture Payment\` always capture in full?
`;

  it("errorFlows joins a wrapped bullet's continuation lines with single spaces", () => {
    expect(errorFlows(WRAPPED_BODY)).toEqual([
      "Idempotency: covered by INV-CHK-1 — a resubmit while a request is outstanding is rejected " +
        "outright rather than silently deduplicated, so the customer sees the state clearly instead " +
        "of wondering if their second click did anything.",
    ]);
  });

  it("openQuestions joins a wrapped item's continuation lines with single spaces", () => {
    expect(openQuestions(WRAPPED_BODY)).toEqual([
      {
        text:
          "What resolves `authorizationId` → `orderId` for the `Payment Captured` event's " +
          "`orderId` field? Not modeled yet — the field-completeness warning on this event is real.",
        checked: false,
        deferredToVersion: null,
      },
      {
        text:
          "Partial captures (e.g. after a line-item cancellation reduces the authorized amount) — " +
          "supported, or does `Capture Payment` always capture in full?",
        checked: false,
        deferredToVersion: null,
      },
    ]);
  });

  it("a nested detail bullet is not a continuation and ends the wrap", () => {
    const body = `## Alternate & Error Flows
- external call fails → retry
  with backoff
  - detail: three attempts max
  stray indented prose after a nested bullet
`;
    expect(errorFlows(body)).toEqual(["external call fails → retry with backoff"]);
  });
});
