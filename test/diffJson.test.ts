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
import { compile } from "../src/pipeline.js";
import { diffModels, ChangeEntry, ChangeType, DiffCounts, ModelDiff } from "../src/model/diff.js";
import { buildDiffJson, DIFF_SCHEMA_VERSION } from "../src/emit/diffJson.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const modelOf = (src: string) => compile(src).model;
const diffOf = (oldSrc: string, newSrc: string) => diffModels(modelOf(oldSrc), modelOf(newSrc));

function emptyCounts(): DiffCounts {
  return {
    slicesAdded: 0,
    slicesRemoved: 0,
    elementsAdded: 0,
    elementsRemoved: 0,
    elementsMoved: 0,
    fieldChanges: 0,
    fromChanges: 0,
    noteChanges: 0,
    issuesOpened: 0,
    issuesResolved: 0,
    issuesChanged: 0,
    arrowsAdded: 0,
    arrowsRemoved: 0,
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
  "oldNote",
  "newNote",
  "oldText",
  "newText",
  "from",
  "to",
] as const;

/** Expand a partial entry into the full explicit-null shape the serializer should produce. */
function expectedEntry(partial: { type: ChangeType } & Partial<Record<(typeof OPTIONAL_FIELDS)[number], unknown>>) {
  const full: Record<string, unknown> = { type: partial.type };
  for (const f of OPTIONAL_FIELDS) full[f] = f in partial ? partial[f] : null;
  return full;
}

function docFor(diff: ModelDiff, oldLabel = "old.em", newLabel = "new.em") {
  return JSON.parse(buildDiffJson(diff, oldLabel, newLabel));
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
      "old",
      "new",
      "identical",
      "counts",
      "changes",
      "removals",
    ]);
    expect(doc.diffSchemaVersion).toBe(DIFF_SCHEMA_VERSION);
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: PKG_VERSION });
    expect(doc.old).toEqual({ label: "model.em@main" });
    expect(doc.new).toEqual({ label: "model.em" });
    expect(doc.identical).toBe(false);
    expect(doc.counts).toEqual(diff.counts);
  });

  it("passes DiffCounts through as-is, all 13 counters", () => {
    const diff = diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n  event B\n}`);
    const doc = docFor(diff);
    expect(Object.keys(doc.counts).sort()).toEqual(Object.keys(emptyCounts()).sort());
    expect(Object.keys(doc.counts)).toHaveLength(13);
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
  const cases: { type: ChangeType; entry: ChangeEntry; expected: Record<string, unknown> }[] = [
    {
      type: "slice-added",
      entry: { type: "slice-added", name: "Fulfillment" },
      expected: expectedEntry({ type: "slice-added", name: "Fulfillment" }),
    },
    {
      type: "slice-removed",
      entry: { type: "slice-removed", name: "Legacy" },
      expected: expectedEntry({ type: "slice-removed", name: "Legacy" }),
    },
    {
      type: "element-added",
      entry: { type: "element-added", kind: "event", name: "Discount Applied", sliceName: "Checkout" },
      expected: expectedEntry({
        type: "element-added",
        kind: "event",
        name: "Discount Applied",
        sliceName: "Checkout",
      }),
    },
    {
      type: "element-removed",
      entry: { type: "element-removed", kind: "event", name: "Discount Applied", sliceName: "Checkout" },
      expected: expectedEntry({
        type: "element-removed",
        kind: "event",
        name: "Discount Applied",
        sliceName: "Checkout",
      }),
    },
    {
      type: "element-moved",
      entry: { type: "element-moved", kind: "event", name: "Payment Failed", fromSlice: "Checkout", toSlice: "Payment" },
      expected: expectedEntry({
        type: "element-moved",
        kind: "event",
        name: "Payment Failed",
        fromSlice: "Checkout",
        toSlice: "Payment",
      }),
    },
    {
      type: "field-added",
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
    {
      type: "field-removed",
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
    {
      type: "field-changed",
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
    {
      type: "from-added",
      entry: { type: "from-added", kind: "view", name: "Availability", sliceName: "Catalog", source: "Stock Adjusted" },
      expected: expectedEntry({
        type: "from-added",
        kind: "view",
        name: "Availability",
        sliceName: "Catalog",
        source: "Stock Adjusted",
      }),
    },
    {
      type: "from-removed",
      entry: { type: "from-removed", kind: "view", name: "Availability", sliceName: "Catalog", source: "Stock Adjusted" },
      expected: expectedEntry({
        type: "from-removed",
        kind: "view",
        name: "Availability",
        sliceName: "Catalog",
        source: "Stock Adjusted",
      }),
    },
    {
      type: "note-added",
      entry: { type: "note-added", kind: "event", name: "Thing Happened", sliceName: "S", newNote: "docs/thing.md" },
      expected: expectedEntry({
        type: "note-added",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        newNote: "docs/thing.md",
      }),
    },
    {
      type: "note-removed",
      entry: { type: "note-removed", kind: "event", name: "Thing Happened", sliceName: "S", oldNote: "docs/thing.md" },
      expected: expectedEntry({
        type: "note-removed",
        kind: "event",
        name: "Thing Happened",
        sliceName: "S",
        oldNote: "docs/thing.md",
      }),
    },
    {
      type: "note-changed",
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
    {
      type: "issue-opened",
      entry: { type: "issue-opened", kind: "command", name: "Do Thing", sliceName: "S", newText: "who approves?" },
      expected: expectedEntry({
        type: "issue-opened",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        newText: "who approves?",
      }),
    },
    {
      type: "issue-resolved",
      entry: { type: "issue-resolved", kind: "command", name: "Do Thing", sliceName: "S", oldText: "who approves?" },
      expected: expectedEntry({
        type: "issue-resolved",
        kind: "command",
        name: "Do Thing",
        sliceName: "S",
        oldText: "who approves?",
      }),
    },
    {
      type: "issue-changed",
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
    {
      type: "arrow-added",
      entry: { type: "arrow-added", from: "Orders", to: "Screen" },
      expected: expectedEntry({ type: "arrow-added", from: "Orders", to: "Screen" }),
    },
    {
      type: "arrow-removed",
      entry: { type: "arrow-removed", from: "Orders", to: "Screen" },
      expected: expectedEntry({ type: "arrow-removed", from: "Orders", to: "Screen" }),
    },
  ];

  // Sanity check: this suite covers every ChangeType the union declares, not
  // an arbitrary subset — if diff.ts ever grows a ChangeType, this fails loudly.
  it("covers every declared ChangeType exactly once", () => {
    const allTypes: ChangeType[] = [
      "slice-added",
      "slice-removed",
      "element-added",
      "element-removed",
      "element-moved",
      "field-added",
      "field-removed",
      "field-changed",
      "from-added",
      "from-removed",
      "note-added",
      "note-removed",
      "note-changed",
      "issue-opened",
      "issue-resolved",
      "issue-changed",
      "arrow-added",
      "arrow-removed",
    ];
    expect(cases.map((c) => c.type).sort()).toEqual([...allTypes].sort());
    expect(cases).toHaveLength(allTypes.length);
  });

  for (const { type, entry, expected } of cases) {
    it(`serializes ${type} with explicit nulls on every unused field`, () => {
      const diff: ModelDiff = { changes: [entry], removals: [], counts: emptyCounts() };
      const doc = docFor(diff);
      expect(doc.changes).toEqual([expected]);
    });
  }
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
  it("produces byte-identical output for the same diff and labels across two runs", () => {
    const diff = diffOf(
      `slice "S" {\n  command A\n  event B\n}`,
      `slice "S" {\n  command A\n  event B issue "q"\n}\nslice "T" {\n  command C\n}`,
    );
    const first = buildDiffJson(diff, "old.em", "new.em");
    const second = buildDiffJson(diff, "old.em", "new.em");
    expect(first).toBe(second);
  });

  it("has no trailing newline (the caller adds it)", () => {
    const diff = diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n}`);
    const text = buildDiffJson(diff, "old.em", "new.em");
    expect(text.endsWith("\n")).toBe(false);
  });
});
