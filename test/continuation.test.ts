// SPDX-License-Identifier: MIT
// Coverage for MIL-208 ("an `again` view instance is a continuation of its originating slice"):
// the shared model-layer predicate/resolution (src/model/continuation.ts), docJoin's automatic
// fallback, `em export`'s `continuationOf`/`alsoReads` fields, the `continuation-has-own-doc`
// migration warning, and every consumer the recon identified — status counts, coverage
// exclusion, the slice-index row, the ratify-family refusals, `em slice new --wire`'s refusal,
// the catalog banner, and the render pipeline's Slice Status legend fallback. Neutral domain
// throughout (orders/catalog), per the engagement's non-negotiables.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { continuationOf } from "../src/model/continuation.js";
import { resolveSliceDocJoin } from "../src/catalog/docJoin.js";
import { buildExport } from "../src/emit/json.js";
import { resolveSliceStatusFacts, buildStatusReport } from "../src/cli/status.js";
import { resolveScopedSlices } from "../src/cli/coverage.js";
import { buildSliceIndexTable } from "../src/cli/sliceIndex.js";
import { runRatify } from "../src/cli/ratify.js";
import { runReview } from "../src/cli/review.js";
import { runReratify } from "../src/cli/reratify.js";
import { runMarkImplemented } from "../src/cli/markImplemented.js";
import { resolvePrimaryElement } from "../src/cli/sliceLink.js";
import { validateNoteBindings } from "../src/catalog/noteBindingValidate.js";
import { validateOrphanedSliceDocs } from "../src/catalog/orphanedSliceDocValidate.js";
import { readSliceDocs } from "../src/render/sliceStatus.js";
import { buildCatalog } from "../src/catalog/build.js";

// Origin at "Browse Catalog" (index 1); two later `again` instances at index 3 ("Catalog Shows
// Removal", fed by "Item Removed") and index 5 ("Catalog Shows Restock", fed by "Item
// Restocked") — three total feed positions for the view (its own `from` plus two continuations),
// exercising both "several later positions" and multi-instance ordering.
const MODEL = `model "Continuation Fixture"

persona Customer
context Order

slice "Add Item" {
  command Add Item
  event Item Added
}
slice "Browse Catalog" {
  view Catalog from "Item Added" note "slices/browse-catalog.md"
  ui Catalog Screen @Customer
}
slice "Remove Item" {
  command Remove Item
  event Item Removed
}
slice "Catalog Shows Removal" {
  view Catalog again from "Item Removed"
}
slice "Restock Item" {
  command Restock Item
  event Item Restocked
}
slice "Catalog Shows Restock" {
  view Catalog again from "Item Restocked"
}
`;

const BROWSE_CATALOG_DOC =
  "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n" +
  "## Invariants / Business Rules\n- **INV-CAT-1:** catalog reflects live inventory\n";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-continuation-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "slices", "browse-catalog.md"), BROWSE_CATALOG_DOC);
  writeFileSync(join(dir, "model.em"), MODEL);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("continuationOf (src/model/continuation.ts)", () => {
  it("returns null for an ordinary slice (command+event)", () => {
    const { model, refs } = compile(MODEL);
    expect(continuationOf(model, refs, 0)).toBeNull(); // "Add Item"
  });

  it("returns null for the originating view's own slice", () => {
    const { model, refs } = compile(MODEL);
    expect(continuationOf(model, refs, 1)).toBeNull(); // "Browse Catalog" itself
  });

  it("resolves a later `again`-only slice to the originating slice's key/index", () => {
    const { model, refs } = compile(MODEL);
    const first = continuationOf(model, refs, 3); // "Catalog Shows Removal"
    expect(first).not.toBeNull();
    expect(first!.sliceKey).toBe("browse-catalog");
    expect(first!.sliceIndex).toBe(1);

    const second = continuationOf(model, refs, 5); // "Catalog Shows Restock"
    expect(second).not.toBeNull();
    expect(second!.sliceKey).toBe("browse-catalog");
    expect(second!.sliceIndex).toBe(1);
  });

  it("returns null for a slice mixing an `again` view with a non-view element", () => {
    const { model, refs } = compile(`
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Mixed" {
  view Widget List again from "Widget Retired"
  command Do Something Else
}
`);
    expect(continuationOf(model, refs, 1)).toBeNull();
  });

  it("returns null for a plain (non-again) repeat of a view name", () => {
    // Not valid per validate.ts's own rules in a real model, but the predicate itself must not
    // misclassify a non-again view as a continuation just because it shares a logical id.
    const { model, refs } = compile(`
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Repeat" {
  view Widget List from "Widget Retired"
}
`);
    expect(continuationOf(model, refs, 1)).toBeNull();
  });

  it("ignores a `ui` element alongside the lone `again` view", () => {
    const { model, refs } = compile(`
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Continuation With UI" {
  view Widget List again from "Widget Retired"
  ui Widget List Screen @Customer
}
`);
    const result = continuationOf(model, refs, 1);
    expect(result).not.toBeNull();
    expect(result!.sliceKey).toBe("origin");
  });

  it("with several `again` views in one slice, the FIRST in declaration order decides", () => {
    const { model, refs } = compile(`
slice "Origin A" {
  view List A from "A Made"
}
slice "Origin B" {
  view List B from "B Made"
}
slice "Double Continuation" {
  view List A again from "A Changed"
  view List B again from "B Changed"
}
`);
    const result = continuationOf(model, refs, 2);
    expect(result).not.toBeNull();
    expect(result!.sliceKey).toBe("origin-a");
  });
});

describe("docJoin resolution (src/catalog/docJoin.ts)", () => {
  it("a continuation slice with no note resolves to the originating slice's doc, marked continuationOf", () => {
    const { model, refs } = compile(MODEL);
    const sliceIndex = refs.sliceKeys.indexOf("catalog-shows-removal");
    const slice = model.slices[sliceIndex];
    const result = resolveSliceDocJoin(model, refs, slice, "catalog-shows-removal", dir, (id) => refs.refById.get(id)!);
    expect(result.continuationOf).toBe("browse-catalog");
    expect(result.doc).toMatchObject({ found: true, path: "slices/browse-catalog.md", status: "ready-to-implement" });
    expect(result.diagnostics).toEqual([]);
  });

  it("the continuation's doc object is IDENTICAL to the originating slice's own join", () => {
    const { model, refs } = compile(MODEL);
    const originIndex = refs.sliceKeys.indexOf("browse-catalog");
    const originJoin = resolveSliceDocJoin(model, refs, model.slices[originIndex], "browse-catalog", dir, (id) => refs.refById.get(id)!);
    const contIndex = refs.sliceKeys.indexOf("catalog-shows-removal");
    const contJoin = resolveSliceDocJoin(model, refs, model.slices[contIndex], "catalog-shows-removal", dir, (id) => refs.refById.get(id)!);
    expect(contJoin.doc).toEqual(originJoin.doc);
    expect(originJoin.continuationOf).toBeNull();
  });

  it("legacy own doc wins: a continuation slice with its own note-bound doc keeps today's behavior, continuationOf null", () => {
    mkdirSync(join(dir, "legacy-model", "slices"), { recursive: true });
    const legacyModel = `
slice "Origin" {
  view Widget List from "Widget Made" note "slices/origin.md"
}
slice "Legacy Continuation" {
  view Widget List again from "Widget Retired" note "slices/legacy-continuation.md"
}
`;
    writeFileSync(
      join(dir, "legacy-model", "slices", "origin.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: reviewed\nversion: 1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "legacy-model", "slices", "legacy-continuation.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    const { model, refs } = compile(legacyModel);
    const sliceIndex = refs.sliceKeys.indexOf("legacy-continuation");
    const result = resolveSliceDocJoin(
      model,
      refs,
      model.slices[sliceIndex],
      "legacy-continuation",
      join(dir, "legacy-model"),
      (id) => refs.refById.get(id)!,
    );
    expect(result.continuationOf).toBeNull();
    expect(result.doc).toMatchObject({ found: true, path: "slices/legacy-continuation.md", status: "draft" });
  });
});

describe("em export: continuationOf / alsoReads (src/emit/json.ts)", () => {
  it("bumps schemaVersion to 1.12", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const { text } = buildExport(model, refs, diagnostics, MODEL, join(dir, "model.em"));
    expect(JSON.parse(text).schemaVersion).toBe("1.14");
  });

  it("originating slice's alsoReads lists both later events in timeline order, continuationOf null", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const { text } = buildExport(model, refs, diagnostics, MODEL, join(dir, "model.em"));
    const doc = JSON.parse(text);
    const origin = doc.model.slices.find((s: any) => s.key === "browse-catalog");
    expect(origin.continuationOf).toBeNull();
    expect(origin.alsoReads).toEqual([
      { event: "remove-item/event.item-removed", atSlice: "catalog-shows-removal" },
      { event: "restock-item/event.item-restocked", atSlice: "catalog-shows-restock" },
    ]);
  });

  it("a continuation slice's own alsoReads is empty, and continuationOf names the origin", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const { text } = buildExport(model, refs, diagnostics, MODEL, join(dir, "model.em"));
    const doc = JSON.parse(text);
    const cont = doc.model.slices.find((s: any) => s.key === "catalog-shows-removal");
    expect(cont.continuationOf).toBe("browse-catalog");
    expect(cont.alsoReads).toEqual([]);
    expect(cont.doc).toEqual(origin_doc(doc));
  });

  it("an ordinary slice's alsoReads is empty and continuationOf is null", () => {
    const { model, refs, diagnostics } = compile(MODEL);
    const { text } = buildExport(model, refs, diagnostics, MODEL, join(dir, "model.em"));
    const doc = JSON.parse(text);
    const addItem = doc.model.slices.find((s: any) => s.key === "add-item");
    expect(addItem.continuationOf).toBeNull();
    expect(addItem.alsoReads).toEqual([]);
  });

  function origin_doc(doc: any) {
    return doc.model.slices.find((s: any) => s.key === "browse-catalog").doc;
  }

  it("dedupes alsoReads by (event, atSlice) — a repeated `from` on the same later instance counts once", () => {
    const model = `
slice "Make Widget" {
  command Make Widget
  event Widget Made
}
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Retire Widget" {
  command Retire Widget
  event Widget Retired
}
slice "Repeat Feed" {
  view Widget List again from "Widget Retired", "Widget Retired"
}
`;
    const { model: m, refs, diagnostics } = compile(model);
    const { text } = buildExport(m, refs, diagnostics, model, join(dir, "dedupe.em"));
    const doc = JSON.parse(text);
    const origin = doc.model.slices.find((s: any) => s.key === "origin");
    expect(origin.alsoReads).toEqual([{ event: "retire-widget/event.widget-retired", atSlice: "repeat-feed" }]);
  });
});

describe("StatusReport: continuations count (src/cli/status.ts)", () => {
  it("a continuation slice with no doc leaves every byStatus/driftSignal bucket, tallied in continuations instead", () => {
    const { model, refs } = compile(MODEL);
    const { facts } = resolveSliceStatusFacts(join(dir, "model.em"), model, refs, dir);
    const report = buildStatusReport([join(dir, "model.em")], facts, 0, null, [], []);
    // 6 slices total; 2 are continuations (catalog-shows-removal, catalog-shows-restock).
    expect(report.slices.total).toBe(6);
    expect(report.continuations).toBe(2);
    // byStatus sums to total - continuations: 2 no-doc (add-item, remove-item, restock-item —
    // wait, three ordinary undocumented command/event slices) + 1 ready-to-implement (browse-catalog).
    const sum = Object.values(report.slices.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.slices.total - report.continuations);
    expect(report.slices.byStatus.readyToImplement).toBe(1);
  });
});

describe("em coverage: continuation exclusion (src/cli/coverage.ts)", () => {
  it("resolveScopedSlices omits both continuation slices entirely", () => {
    const { model, refs } = compile(MODEL);
    const scoped = resolveScopedSlices(model, refs, dir, false);
    const keys = scoped.map((s) => s.key);
    expect(keys).toContain("browse-catalog");
    expect(keys).not.toContain("catalog-shows-removal");
    expect(keys).not.toContain("catalog-shows-restock");
  });
});

describe("em slice index: continuation row (src/cli/sliceIndex.ts)", () => {
  it("a continuation row's Status cell names the originating key; Design doc points at its file", () => {
    const { model, refs } = compile(MODEL);
    const table = buildSliceIndexTable(model, refs, dir);
    const row = table.rows.find((r) => r.name === "Catalog Shows Removal")!;
    expect(row.status).toBe("continuation of `browse-catalog`");
    expect(row.docPath).toBe("slices/browse-catalog.md");
    const originRow = table.rows.find((r) => r.name === "Browse Catalog")!;
    expect(originRow.status).toBe("ready-to-implement");
  });
});

describe("ratify/review/reratify/mark-implemented refuse on a continuation key", () => {
  function compiled() {
    return compile(MODEL);
  }

  it("runRatify refuses, verbatim message, file untouched", () => {
    const { model, refs } = compiled();
    const before = readFileSync(join(dir, "slices", "browse-catalog.md"), "utf8");
    const result = runRatify(model, refs, dir, "catalog-shows-removal", "Alex Rivera", "2026-09-07");
    expect(result).toEqual({
      ok: false,
      message:
        '"catalog-shows-removal" is a continuation of "browse-catalog" (view "Catalog" again) — ' +
        'it has no doc of its own; ratify "browse-catalog" instead',
    });
    expect(readFileSync(join(dir, "slices", "browse-catalog.md"), "utf8")).toBe(before);
  });

  it("runReview refuses, verbatim message", () => {
    const { model, refs } = compiled();
    const result = runReview(model, refs, dir, "catalog-shows-removal", "Sam Okafor", "2026-09-07");
    expect(result).toEqual({
      ok: false,
      message:
        '"catalog-shows-removal" is a continuation of "browse-catalog" (view "Catalog" again) — ' +
        'it has no doc of its own; review "browse-catalog" instead',
    });
  });

  it("runReratify refuses, verbatim message", () => {
    const { model, refs } = compiled();
    const result = runReratify(model, refs, dir, "catalog-shows-removal");
    expect(result).toEqual({
      ok: false,
      message:
        '"catalog-shows-removal" is a continuation of "browse-catalog" (view "Catalog" again) — ' +
        'it has no doc of its own; reratify "browse-catalog" instead',
    });
  });

  it("runMarkImplemented refuses, verbatim message", () => {
    const { model, refs } = compiled();
    const result = runMarkImplemented(model, refs, dir, "catalog-shows-removal", "https://github.com/org/repo/pull/1");
    expect(result).toEqual({
      ok: false,
      message:
        '"catalog-shows-removal" is a continuation of "browse-catalog" (view "Catalog" again) — ' +
        'it has no doc of its own; mark-implemented "browse-catalog" instead',
    });
  });

  it("ratifying the ORIGINATING slice itself still works normally", () => {
    const { model, refs } = compiled();
    const result = runRatify(model, refs, dir, "browse-catalog", "Alex Rivera", "2026-09-07");
    expect(result.ok).toBe(true);
  });
});

describe("em slice new --wire refuses on an again-only slice (src/cli/sliceLink.ts)", () => {
  it("resolvePrimaryElement refuses, naming the originating key and doc path", () => {
    const { model, refs } = compile(MODEL);
    const result = resolvePrimaryElement(model, refs, "catalog-shows-removal", "state-view");
    expect(result).toEqual({
      ok: false,
      message:
        'slice "Catalog Shows Removal" is a later instance of "Catalog" (again) — it has no doc of ' +
        'its own; the doc lives at slices/browse-catalog.md (slice "browse-catalog")',
    });
  });

  it("resolvePrimaryElement still resolves normally for the originating slice", () => {
    const { model, refs } = compile(MODEL);
    const result = resolvePrimaryElement(model, refs, "browse-catalog", "state-view");
    expect(result.ok).toBe(true);
  });
});

describe("continuation-has-own-doc warning (migration path)", () => {
  it("fires from validateNoteBindings when a continuation slice has its own note-bound doc", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "em-continuation-legacy-note-"));
    try {
      mkdirSync(join(legacyDir, "slices"), { recursive: true });
      writeFileSync(
        join(legacyDir, "slices", "legacy-continuation.md"),
        "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
      );
      const src = `
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Legacy Continuation" {
  view Widget List again from "Widget Retired" note "slices/legacy-continuation.md"
}
`;
      const { model, refs } = compile(src);
      const diags = validateNoteBindings(model, refs, legacyDir);
      const found = diags.find((d) => d.code === "continuation-has-own-doc");
      expect(found).toBeDefined();
      expect(found!.message).toContain('slice "Legacy Continuation" is a continuation of "origin"');
      expect(found!.message).toContain("fold it into slices/origin.md and delete it");
      expect(found!.refs).toContain("legacy-continuation");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("fires from validateOrphanedSliceDocs when a continuation key's file exists on disk without a note", () => {
    const strayDir = mkdtempSync(join(tmpdir(), "em-continuation-stray-file-"));
    try {
      mkdirSync(join(strayDir, "slices"), { recursive: true });
      // File sits at the continuation slice's OWN conventional path but nothing notes it —
      // docJoin's continuation fallback would otherwise silently ignore this file forever.
      writeFileSync(
        join(strayDir, "slices", "stray-continuation.md"),
        "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n",
      );
      const src = `
slice "Origin" {
  view Widget List from "Widget Made"
}
slice "Stray Continuation" {
  view Widget List again from "Widget Retired"
}
`;
      const { model, refs } = compile(src);
      const diags = validateOrphanedSliceDocs(model, refs, strayDir);
      const found = diags.find((d) => d.code === "continuation-has-own-doc");
      expect(found).toBeDefined();
      expect(found!.message).toContain('"slices/stray-continuation.md" exists but isn\'t bound via `note`');
    } finally {
      rmSync(strayDir, { recursive: true, force: true });
    }
  });

  it("does not fire when the continuation slice has no doc at all (the ordinary, unremarkable case)", () => {
    const { model, refs } = compile(MODEL);
    const diags = validateNoteBindings(model, refs, dir);
    expect(diags.find((d) => d.code === "continuation-has-own-doc")).toBeUndefined();
    const orphanDiags = validateOrphanedSliceDocs(model, refs, dir);
    expect(orphanDiags.find((d) => d.code === "continuation-has-own-doc")).toBeUndefined();
  });
});

describe("render pipeline: Slice Status legend fallback (src/render/sliceStatus.ts)", () => {
  it("readSliceDocs resolves a continuation slice to the originating slice's own file", () => {
    const { model } = compile(MODEL);
    const docs = readSliceDocs(model, dir);
    // model.slices order: Add Item(0), Browse Catalog(1), Remove Item(2), Catalog Shows
    // Removal(3), Restock Item(4), Catalog Shows Restock(5).
    expect(docs[3]?.status).toBe("ready-to-implement");
    expect(docs[5]?.status).toBe("ready-to-implement");
    expect(docs[0]).toBeNull();
  });
});

describe("em catalog: continuation banner (src/catalog/build.ts, src/catalog/pages.ts)", () => {
  it("shows a 'Continuation of' banner on a continuation slice's page, linking to the originating slice", async () => {
    const { model, grid, dot, refs } = compile(MODEL);
    const outDir = join(dir, "catalog-out");
    const result = await buildCatalog([{ file: join(dir, "model.em"), model, grid, dot, refs }], { outDir });
    expect(result.diagnostics).toEqual([]);

    const contPage = readFileSync(join(outDir, "model", "slices", "catalog-shows-removal.html"), "utf8");
    expect(contPage).toContain("Continuation of");
    expect(contPage).toContain('href="browse-catalog.html">Browse Catalog</a>');
    expect(contPage).toContain("slices/browse-catalog.md");
    expect(contPage).toContain("ready-to-implement"); // originating doc's status colors this page too
    expect(contPage).not.toContain("INV-CAT-1"); // the originating doc's BODY is never inlined
    expect(contPage).not.toContain("No slice doc found");

    // the originating slice's own page still renders its doc's body in full
    const originPage = readFileSync(join(outDir, "model", "slices", "browse-catalog.html"), "utf8");
    expect(originPage).toContain("INV-CAT-1");
  });
});
