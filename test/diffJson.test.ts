// SPDX-License-Identifier: MIT
// Coverage for `em diff --json`'s serializer (src/emit/diffJson.ts): envelope
// shape, the explicit-null convention on ChangeEntry, one correctly-serialized
// entry per ChangeType, determinism, and `identical` for equal models. The
// diff computation itself (src/model/diff.ts) is covered by test/diff.test.ts;
// this file tests the serialization layer, so most fixtures build a ModelDiff
// directly rather than round-tripping through compile()+diffModels() — except
// where the model-pair form adds value (envelope shape, `identical`,
// realistic move/field-change entries), adapted from test/diff.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compile } from "../src/pipeline.js";
import { diffModels, ChangeEntry, ChangeType, DiffCounts, ModelDiff } from "../src/model/diff.js";
import { buildDiffJson, DiffSide, DIFF_SCHEMA_VERSION } from "../src/emit/diffJson.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const modelOf = (src: string) => compile(src).model;
const diffOf = (oldSrc: string, newSrc: string) => diffModels(modelOf(oldSrc), modelOf(newSrc));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function emptyCounts(): DiffCounts {
  return {
    slicesAdded: 0,
    slicesRemoved: 0,
    sourceChanges: 0,
    elementsAdded: 0,
    elementsRemoved: 0,
    elementsMoved: 0,
    fieldChanges: 0,
    fromChanges: 0,
    noteChanges: 0,
    issuesOpened: 0,
    issuesResolved: 0,
    issuesChanged: 0,
    eventsMarkedPublic: 0,
    eventsUnmarkedPublic: 0,
    arrowsAdded: 0,
    arrowsRemoved: 0,
    acceptedDivergences: 0,
  };
}

/** Every optional ChangeEntry field, in the order the serializer emits them. */
const OPTIONAL_FIELDS = [
  "kind",
  "name",
  "sliceName",
  "fromSlice",
  "toSlice",
  "field",
  "fieldType",
  "oldType",
  "newType",
  "source",
  "oldSource",
  "newSource",
  "oldNote",
  "newNote",
  "oldText",
  "newText",
  "from",
  "to",
  "acceptedDivergence",
] as const;

/** Expand a partial entry into the full explicit-null shape the serializer should produce. */
function expectedEntry(partial: { type: ChangeType } & Partial<Record<(typeof OPTIONAL_FIELDS)[number], unknown>>) {
  const full: Record<string, unknown> = { type: partial.type };
  for (const f of OPTIONAL_FIELDS) full[f] = f in partial ? partial[f] : null;
  return full;
}

const side = (label: string, source = "", diagnostics: DiffSide["diagnostics"] = []): DiffSide => ({
  label,
  source,
  diagnostics,
});

function docFor(diff: ModelDiff, oldLabel = "old.em", newLabel = "new.em") {
  return JSON.parse(buildDiffJson(diff, side(oldLabel), side(newLabel)));
}

describe("envelope shape", () => {
  it("emits the top-level fields with the documented values", () => {
    const diff = diffOf(
      `slice "Checkout" {\n  command Submit Order\n}`,
      `slice "Checkout" {\n  command Submit Order\n}\nslice "Fulfillment" {\n  command Ship Order\n}`,
    );
    const doc = docFor(diff, "model.em@main", "model.em");
    expect(Object.keys(doc)).toEqual([
      "diffSchemaVersion",
      "generator",
      "oldModel",
      "newModel",
      "identical",
      "counts",
      "changes",
      "removals",
      "diagnostics",
    ]);
    expect(doc.diffSchemaVersion).toBe(DIFF_SCHEMA_VERSION);
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: PKG_VERSION });
    expect(doc.oldModel.label).toBe("model.em@main");
    expect(doc.newModel.label).toBe("model.em");
    expect(doc.identical).toBe(false);
    expect(doc.counts).toEqual(diff.counts);
  });

  // No key is a reserved word: the explicit-null convention exists so consumers
  // can destructure, and `const { old, new } = doc` is a SyntaxError.
  it("uses only destructurable top-level keys", () => {
    const doc = docFor(diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n}`));
    const RESERVED = new Set(["new", "class", "function", "const", "let", "var", "delete", "in", "for"]);
    for (const key of Object.keys(doc)) expect(RESERVED.has(key)).toBe(false);
    // Compiling the destructuring pattern proves it: a reserved-word key makes
    // `const { ... } = {}` a SyntaxError, which the Function constructor raises.
    expect(() => new Function(`const { ${Object.keys(doc).join(", ")} } = {};`)).not.toThrow();
  });

  it("hashes each side's source text so a consumer can pin what was diffed", () => {
    const OLD = `slice "S" {\n  command A\n}`;
    const NEW = `slice "S" {\n  command A\n  event B\n}`;
    const doc = JSON.parse(
      buildDiffJson(diffOf(OLD, NEW), side("old.em", OLD), side("new.em", NEW)),
    );
    expect(doc.oldModel).toEqual({ label: "old.em", sha256: sha256(OLD) });
    expect(doc.newModel).toEqual({ label: "new.em", sha256: sha256(NEW) });
    expect(doc.oldModel.sha256).not.toBe(doc.newModel.sha256);
  });

  it("carries both sides' warnings, side-tagged, in document order", () => {
    const diff = diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n}`);
    const doc = JSON.parse(
      buildDiffJson(
        diff,
        side("old.em", "", [{ severity: "warning", message: "old side warned", line: 2 }]),
        side("new.em", "", [{ severity: "warning", message: "new side warned" }]),
      ),
    );
    expect(doc.diagnostics).toEqual([
      { side: "old", severity: "warning", message: "old side warned", line: 2 },
      { side: "new", severity: "warning", message: "new side warned", line: null },
    ]);
  });

  it("emits an empty diagnostics array when neither side warned", () => {
    expect(docFor(diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n}`)).diagnostics).toEqual([]);
  });

  it("passes DiffCounts through as-is, all 17 counters", () => {
    const diff = diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n  event B\n}`);
    const doc = docFor(diff);
    expect(Object.keys(doc.counts).sort()).toEqual(Object.keys(emptyCounts()).sort());
    expect(Object.keys(doc.counts)).toHaveLength(17);
  });
});

describe("identical models", () => {
  it("reports identical: true and empty changes/removals", () => {
    const src = `slice "Checkout" {\n  command Submit Order\n  event Order Submitted\n}`;
    const doc = docFor(diffOf(src, src));
    expect(doc.identical).toBe(true);
    expect(doc.changes).toEqual([]);
    expect(doc.removals).toEqual([]);
  });
});

describe("explicit nulls", () => {
  it("a minimal entry (slice-added) carries every optional field as explicit null", () => {
    const diff: ModelDiff = {
      changes: [{ type: "slice-added", name: "Fulfillment" }],
      removals: [],
      counts: emptyCounts(),
    };
    const doc = docFor(diff);
    expect(doc.changes).toEqual([expectedEntry({ type: "slice-added", name: "Fulfillment" })]);
    // Every optional key is present (not omitted) even though most are null.
    expect(Object.keys(doc.changes[0])).toEqual(["type", ...OPTIONAL_FIELDS]);
  });
});

describe("one correctly-serialized entry per ChangeType", () => {
  const cases: Record<ChangeType, { entry: ChangeEntry; expected: Record<string, unknown> }> = {
    "slice-added": {
      entry: { type: "slice-added", name: "Fulfillment" },
      expected: expectedEntry({ type: "slice-added", name: "Fulfillment" }),
    },
    "slice-removed": {
      entry: { type: "slice-removed", name: "Legacy" },
      expected: expectedEntry({ type: "slice-removed", name: "Legacy" }),
    },
    "source-added": {
      entry: { type: "source-added", sliceName: "Checkout", newSource: "https://linear.app/team/issue/MIL-60" },
      expected: expectedEntry({
        type: "source-added",
        sliceName: "Checkout",
        newSource: "https://linear.app/team/issue/MIL-60",
      }),
    },
    "source-removed": {
      entry: { type: "source-removed", sliceName: "Checkout", oldSource: "https://linear.app/team/issue/MIL-60" },
      expected: expectedEntry({
        type: "source-removed",
        sliceName: "Checkout",
        oldSource: "https://linear.app/team/issue/MIL-60",
      }),
    },
    "source-changed": {
      entry: {
        type: "source-changed",
        sliceName: "Checkout",
        oldSource: "https://linear.app/team/issue/MIL-60",
        newSource: "https://linear.app/team/issue/MIL-61",
      },
      expected: expectedEntry({
        type: "source-changed",
        sliceName: "Checkout",
        oldSource: "https://linear.app/team/issue/MIL-60",
        newSource: "https://linear.app/team/issue/MIL-61",
      }),
    },
    "element-added": {
      entry: { type: "element-added", kind: "event", name: "Discount Applied", sliceName: "Checkout" },
      expected: expectedEntry({
        type: "element-added",
        kind: "event",
        name: "Discount Applied",
        sliceName: "Checkout",
      }),
    },
    "element-removed": {
      entry: { type: "element-removed", kind: "event", name: "Discount Applied", sliceName: "Checkout" },
      expected: expectedEntry({
        type: "element-removed",
        kind: "event",
        name: "Discount Applied",
        sliceName: "Checkout",
      }),
    },
    "element-moved": {
      entry: { type: "element-moved", kind: "event", name: "Payment Failed", fromSlice: "Checkout", toSlice: "Payment" },
      expected: expectedEntry({
        type: "element-moved",
        kind: "event",
        name: "Payment Failed",
        fromSlice: "Checkout",
        toSlice: "Payment",
      }),
    },
    "field-added": {
      entry: { type: "field-added", kind: "command", name: "Do Thing", sliceName: "S", field: "total", fieldType: "Money" },
      expected: expectedEntry({
        type: "field-added",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        field: "total",
        fieldType: "Money",
      }),
    },
    "field-removed": {
      entry: { type: "field-removed", kind: "command", name: "Do Thing", sliceName: "S", field: "memo", fieldType: "Text" },
      expected: expectedEntry({
        type: "field-removed",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        field: "memo",
        fieldType: "Text",
      }),
    },
    "field-changed": {
      entry: {
        type: "field-changed",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        field: "qty",
        oldType: "Int",
        newType: "Float",
      },
      expected: expectedEntry({
        type: "field-changed",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        field: "qty",
        oldType: "Int",
        newType: "Float",
      }),
    },
    "from-added": {
      entry: { type: "from-added", kind: "view", name: "Availability", sliceName: "Catalog", source: "Stock Adjusted" },
      expected: expectedEntry({
        type: "from-added",
        kind: "view",
        name: "Availability",
        sliceName: "Catalog",
        source: "Stock Adjusted",
      }),
    },
    "from-removed": {
      entry: { type: "from-removed", kind: "view", name: "Availability", sliceName: "Catalog", source: "Stock Adjusted" },
      expected: expectedEntry({
        type: "from-removed",
        kind: "view",
        name: "Availability",
        sliceName: "Catalog",
        source: "Stock Adjusted",
      }),
    },
    "note-added": {
      entry: { type: "note-added", kind: "event", name: "Thing Happened", sliceName: "S", newNote: "docs/thing.md" },
      expected: expectedEntry({
        type: "note-added",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        newNote: "docs/thing.md",
      }),
    },
    "note-removed": {
      entry: { type: "note-removed", kind: "event", name: "Thing Happened", sliceName: "S", oldNote: "docs/thing.md" },
      expected: expectedEntry({
        type: "note-removed",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        oldNote: "docs/thing.md",
      }),
    },
    "note-changed": {
      entry: {
        type: "note-changed",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        oldNote: "docs/thing.md",
        newNote: "docs/thing-v2.md",
      },
      expected: expectedEntry({
        type: "note-changed",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        oldNote: "docs/thing.md",
        newNote: "docs/thing-v2.md",
      }),
    },
    "issue-opened": {
      entry: { type: "issue-opened", kind: "command", name: "Do Thing", sliceName: "S", newText: "who approves?" },
      expected: expectedEntry({
        type: "issue-opened",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        newText: "who approves?",
      }),
    },
    "issue-resolved": {
      entry: { type: "issue-resolved", kind: "command", name: "Do Thing", sliceName: "S", oldText: "who approves?" },
      expected: expectedEntry({
        type: "issue-resolved",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        oldText: "who approves?",
      }),
    },
    "issue-changed": {
      entry: {
        type: "issue-changed",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        oldText: "v1 question",
        newText: "v2 question",
      },
      expected: expectedEntry({
        type: "issue-changed",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        oldText: "v1 question",
        newText: "v2 question",
      }),
    },
    "event-marked-public": {
      entry: { type: "event-marked-public", kind: "event", name: "Order Placed", sliceName: "Place Order" },
      expected: expectedEntry({
        type: "event-marked-public",
        kind: "event",
        name: "Order Placed",
        sliceName: "Place Order",
      }),
    },
    "event-unmarked-public": {
      entry: { type: "event-unmarked-public", kind: "event", name: "Order Placed", sliceName: "Place Order" },
      expected: expectedEntry({
        type: "event-unmarked-public",
        kind: "event",
        name: "Order Placed",
        sliceName: "Place Order",
      }),
    },
    "arrow-added": {
      entry: { type: "arrow-added", from: "Orders", to: "Screen" },
      expected: expectedEntry({ type: "arrow-added", from: "Orders", to: "Screen" }),
    },
    "arrow-removed": {
      entry: { type: "arrow-removed", from: "Orders", to: "Screen" },
      expected: expectedEntry({ type: "arrow-removed", from: "Orders", to: "Screen" }),
    },
  };

  // `cases` is keyed by ChangeType, so coverage is enforced by the compiler
  // (`npm run typecheck`): adding a ChangeType to diff.ts makes this Record
  // missing a key, and a stale one makes it an excess key. Both are errors.
  // This runtime assertion just pins the count for anyone reading the suite.
  it("covers every declared ChangeType exactly once", () => {
    expect(Object.keys(cases)).toHaveLength(23);
    expect(new Set(Object.keys(cases)).size).toBe(Object.keys(cases).length);
  });

  for (const [type, { entry, expected }] of Object.entries(cases)) {
    it(`serializes ${type} with explicit nulls on every unused field`, () => {
      const diff: ModelDiff = { changes: [entry], removals: [], counts: emptyCounts() };
      expect(docFor(diff).changes).toEqual([expected]);
    });

    it(`serializes ${type} the same way in removals as in changes`, () => {
      const diff: ModelDiff = { changes: [], removals: [entry], counts: emptyCounts() };
      const doc = docFor(diff);
      expect(doc.removals).toEqual([expected]);
      expect(Object.keys(doc.removals[0])).toEqual(["type", ...OPTIONAL_FIELDS]);
    });
  }
});

describe("accepted divergence", () => {
  it("carries the canonical element's divergence annotation on a real element-removed entry", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "processor tracking token covers idempotency; no view needed"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n}`;
    const diff = diffOf(OLD, NEW);
    const doc = docFor(diff);
    const removed = doc.removals.find((e: ChangeEntry) => e.type === "element-removed");
    expect(removed.acceptedDivergence).toBe(
      "processor tracking token covers idempotency; no view needed",
    );
    expect(doc.counts.acceptedDivergences).toBe(1);
  });

  it("is null when the removed element carries no divergence annotation", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n}`;
    const doc = docFor(diffOf(OLD, NEW));
    const removed = doc.removals.find((e: ChangeEntry) => e.type === "element-removed");
    expect(removed.acceptedDivergence).toBeNull();
    expect(doc.counts.acceptedDivergences).toBe(0);
  });
});

describe("changes/removals ordering", () => {
  it("keeps changes in new-file document order and removals in old-file document order, per the underlying diff", () => {
    const OLD = `
slice "Alpha" {
  command Do Alpha
  event Alpha Done issue "still true?"
}
slice "Beta" {
  command Do Beta
  event Beta Done
}
slice "Gamma" {
  command Do Gamma
}
`;
    const NEW = `
slice "Zero" {
  command Do Zero
}
slice "Alpha" {
  command Do Alpha
  event Alpha Done
}
slice "Beta" {
  command Do Beta
}
`;
    const diff = diffOf(OLD, NEW);
    const doc = docFor(diff);
    expect(doc.changes.map((c: ChangeEntry) => c.type)).toEqual(["slice-added", "issue-resolved"]);
    expect(doc.removals.map((c: ChangeEntry) => c.type)).toEqual(["element-removed", "slice-removed"]);
  });
});

describe("determinism", () => {
  const OLD = `slice "S" {\n  command A\n  event B\n}`;
  const NEW = `slice "S" {\n  command A\n  event B issue "q"\n}\nslice "T" {\n  command C\n}`;

  // Compile and diff both sides twice, independently — stringifying one
  // ModelDiff object twice would be true of any implementation and prove
  // nothing. This exercises the whole compile -> diff -> serialize path,
  // which is where non-determinism (Map/Set iteration, id assignment) would
  // actually creep in.
  it("produces byte-identical output across two independent compile+diff runs", () => {
    const run = () => buildDiffJson(diffOf(OLD, NEW), side("old.em", OLD), side("new.em", NEW));
    expect(run()).toBe(run());
  });

  it("has no trailing newline (the caller adds it)", () => {
    const text = buildDiffJson(diffOf(OLD, OLD), side("old.em", OLD), side("new.em", OLD));
    expect(text.endsWith("\n")).toBe(false);
  });
});
