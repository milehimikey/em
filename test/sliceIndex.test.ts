// SPDX-License-Identifier: MIT
// Coverage for `em slice index`'s core logic (src/cli/sliceIndex.ts): the table built from
// `em export`'s own slice facts (classifySlicePattern/resolveSliceDocJoin — no new parsing),
// and the marker-delimited README rewrite/--check behavior. CLI-level exit-code/process
// coverage lives in test/cli.test.ts, same split as `em export`/`em ledger`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { buildSliceIndexTable, runSliceIndex, SLICE_INDEX_MARKER } from "../src/cli/sliceIndex.js";

// "Place Order" has a real, well-formed slices/place-order.md doc bound via `note`
// (implemented, with a PR link); "Open Orders" deliberately has no doc at all — the two
// no-doc-bound / found-with-content cases the Slices table must render distinctly.
const MODEL = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order note "slices/place-order.md"
  event Order Placed
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

const PLACE_ORDER_DOC = `---
schemaVersion: 1
pattern: state-change
swimlane: order
status: implemented
version: 2
implementedIn: https://github.com/example/repo/pull/42
ratifiedBy: Alex Rivera
ratifiedOn: 2026-08-01
---
## Intent
Let customers place orders.
`;

const README_WITH_MARKERS = `# Demo

## Slices
<!-- GENERATED:${SLICE_INDEX_MARKER}:start -->
| # | Slice | Pattern | Status | Ratified by | Implemented in | Design doc |
|---|-------|---------|--------|-------------|----------------|------------|
<!-- GENERATED:${SLICE_INDEX_MARKER}:end -->

## Status
placeholder
`;

const README_NO_MARKERS = `# Demo

## Slices
(hand-maintained table used to live here)

## Status
placeholder
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-slice-index-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "slices", "place-order.md"), PLACE_ORDER_DOC);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildSliceIndexTable", () => {
  it("builds a header + one row per slice, using em export's own key/pattern/doc facts", () => {
    const { model, refs } = compile(MODEL);
    const { markdown, rows, diagnostics } = buildSliceIndexTable(model, refs, dir);

    expect(diagnostics).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      index: 1,
      name: "Place Order",
      pattern: "State Change",
      status: "implemented",
      ratifiedBy: "Alex Rivera",
      implementedIn: "https://github.com/example/repo/pull/42",
      docPath: "slices/place-order.md",
    });
    expect(markdown).toContain(
      "| 1 | Place Order | State Change | implemented | Alex Rivera | https://github.com/example/repo/pull/42 | " +
        "[slices/place-order.md](slices/place-order.md) |",
    );
  });

  it("renders a slice with no bound doc as 'no doc yet', with an em-dash for Ratified by/Implemented in", () => {
    const { model, refs } = compile(MODEL);
    const { rows } = buildSliceIndexTable(model, refs, dir);

    expect(rows[1]).toEqual({
      index: 2,
      name: "Open Orders",
      pattern: "State View",
      status: "no doc yet",
      ratifiedBy: "—",
      implementedIn: "—",
      docPath: "slices/open-orders.md",
    });
  });

  it("renders 'unknown' for a doc that's found but has unusable frontmatter", () => {
    const modelWithBadDoc = `slice "Broken Doc" {
  command Do Thing note "slices/broken-doc.md"
  event Thing Done
}
`;
    writeFileSync(join(dir, "slices", "broken-doc.md"), "no frontmatter here, just prose\n");
    const { model, refs } = compile(modelWithBadDoc);
    const { rows, diagnostics } = buildSliceIndexTable(model, refs, dir);

    expect(rows[0].status).toBe("unknown");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("has no frontmatter block");
  });

  it("still produces a header-only table for a model with zero slices", () => {
    const { model, refs } = compile("persona Customer\n");
    const { markdown, rows } = buildSliceIndexTable(model, refs, dir);
    expect(rows).toEqual([]);
    expect(markdown).toBe(
      "| # | Slice | Pattern | Status | Ratified by | Implemented in | Design doc |\n" +
        "|---|-------|---------|--------|-------------|----------------|------------|",
    );
  });

  it("escapes a literal `|` in a slice name so it can't break the table", () => {
    const { model, refs } = compile('slice "Weird | Name" {\n  command Do Thing\n}\n');
    const { markdown } = buildSliceIndexTable(model, refs, dir);
    expect(markdown).toContain("Weird \\| Name");
  });

  it("escapes a pre-existing backslash before escaping `|`, so the pipe can't be un-escaped", () => {
    // Escaping `|` alone on `Weird \| Name` would leave the single backslash already in the
    // name adjacent to the newly-inserted one, producing `\\|` — which Markdown reads as an
    // escaped backslash followed by a live, table-breaking `|`. Backslashes must escape first.
    const { model, refs } = compile('slice "Weird \\| Name" {\n  command Do Thing\n}\n');
    const { markdown } = buildSliceIndexTable(model, refs, dir);
    expect(markdown).toContain("Weird \\\\\\| Name");
  });
});

describe("runSliceIndex", () => {
  it("writes the regenerated table between the markers, leaving the rest of the README untouched", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-write-"));
    try {
      mkdirSync(join(readmeDir, "slices"), { recursive: true });
      writeFileSync(join(readmeDir, "slices", "place-order.md"), PLACE_ORDER_DOC);
      writeFileSync(join(readmeDir, "README.md"), README_WITH_MARKERS);

      const { model, refs } = compile(MODEL);
      const result = runSliceIndex(model, refs, join(readmeDir, "model.em"), false);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.wrote).toBe(true);
      expect(result.changed).toBe(true);

      const written = readFileSync(join(readmeDir, "README.md"), "utf8");
      expect(written).toContain("# Demo");
      expect(written).toContain("## Status");
      expect(written).toContain("Place Order");
      expect(written).toContain("no doc yet");
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });

  it("is a no-op (wrote: false) on a second run once the table is already current", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-idempotent-"));
    try {
      mkdirSync(join(readmeDir, "slices"), { recursive: true });
      writeFileSync(join(readmeDir, "slices", "place-order.md"), PLACE_ORDER_DOC);
      writeFileSync(join(readmeDir, "README.md"), README_WITH_MARKERS);
      const emFile = join(readmeDir, "model.em");
      const { model, refs } = compile(MODEL);

      runSliceIndex(model, refs, emFile, false);
      const second = runSliceIndex(model, refs, emFile, false);

      expect(second).toMatchObject({ ok: true, wrote: false, changed: false });
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });

  it("--check (write: false) reports clean without touching the file when the table is current", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-check-clean-"));
    try {
      mkdirSync(join(readmeDir, "slices"), { recursive: true });
      writeFileSync(join(readmeDir, "slices", "place-order.md"), PLACE_ORDER_DOC);
      writeFileSync(join(readmeDir, "README.md"), README_WITH_MARKERS);
      const emFile = join(readmeDir, "model.em");
      const { model, refs } = compile(MODEL);

      runSliceIndex(model, refs, emFile, false); // first make it current
      const before = readFileSync(join(readmeDir, "README.md"), "utf8");
      const checked = runSliceIndex(model, refs, emFile, true);
      const after = readFileSync(join(readmeDir, "README.md"), "utf8");

      expect(checked).toMatchObject({ ok: true, wrote: false, changed: false });
      expect(after).toBe(before);
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });

  it("--check reports stale (ok: false) and never writes when the table is out of date", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-check-stale-"));
    try {
      mkdirSync(join(readmeDir, "slices"), { recursive: true });
      writeFileSync(join(readmeDir, "slices", "place-order.md"), PLACE_ORDER_DOC);
      writeFileSync(join(readmeDir, "README.md"), README_WITH_MARKERS);
      const emFile = join(readmeDir, "model.em");
      const { model, refs } = compile(MODEL);

      const before = readFileSync(join(readmeDir, "README.md"), "utf8");
      const result = runSliceIndex(model, refs, emFile, true);
      const after = readFileSync(join(readmeDir, "README.md"), "utf8");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("stale");
      expect(result.message).toContain("--check");
      expect(after).toBe(before); // never written
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });

  it("reports a clear missing-readme error and never creates one", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-no-readme-"));
    try {
      const emFile = join(readmeDir, "model.em");
      const { model, refs } = compile(MODEL);

      const result = runSliceIndex(model, refs, emFile, false);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("missing-readme");
      expect(result.message).toContain(emFile);
      expect(existsSync(join(readmeDir, "README.md"))).toBe(false);
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });

  it("reports a clear missing-markers error, pointing at the template, and never edits the file", () => {
    const readmeDir = mkdtempSync(join(tmpdir(), "em-slice-index-no-markers-"));
    try {
      writeFileSync(join(readmeDir, "README.md"), README_NO_MARKERS);
      const emFile = join(readmeDir, "model.em");
      const { model, refs } = compile(MODEL);

      const before = readFileSync(join(readmeDir, "README.md"), "utf8");
      const result = runSliceIndex(model, refs, emFile, false);
      const after = readFileSync(join(readmeDir, "README.md"), "utf8");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.kind).toBe("missing-markers");
      expect(result.message).toContain("model-readme.md");
      expect(after).toBe(before); // never written
    } finally {
      rmSync(readmeDir, { recursive: true, force: true });
    }
  });
});
