// SPDX-License-Identifier: MIT
// Coverage for `em validate`'s orphaned-slice-doc check (src/catalog/orphanedSliceDocValidate.ts,
// MIL-183 — the fragility half of GH #128): a `slices/*.md` file left behind by a slice rename or
// removal, matching no current slice's key or `covers:` declaration, no longer goes unmentioned.
// Real fs fixtures via mkdtempSync, same convention as test/noteBindingValidate.test.ts and
// test/docModelConsistencyValidate.test.ts — this check reads `slices/*.md` off disk too.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateOrphanedSliceDocs } from "../src/catalog/orphanedSliceDocValidate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-orphaned-slice-doc-validate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a usable slice doc (every REQUIRED_FRONTMATTER_KEYS entry present) at
 *  `slices/<key>.md`, plus any extra frontmatter lines (each ending in its own `\n`). */
function writeUsableDoc(key: string, extraFrontmatter = "", body = "body\n"): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(
    join(dir, "slices", `${key}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n${extraFrontmatter}---\n${body}`,
  );
}

function writeRawFile(name: string, content: string): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "slices", name), content);
}

function diagsOf(src: string) {
  const { model, refs } = compile(src);
  return validateOrphanedSliceDocs(model, refs, dir);
}

describe("orphan after rename", () => {
  it("warns when the doc's key matches no current slice after a rename", () => {
    writeUsableDoc("old-checkout");
    const diags = diagsOf('slice "New Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "orphaned-slice-doc",
        message: expect.stringContaining('slices/old-checkout.md'),
        refs: ["old-checkout"],
      }),
    ]);
  });
});

describe("orphan after removal", () => {
  it("warns when the doc's slice no longer exists in the model at all", () => {
    writeUsableDoc("removed-slice");
    const diags = diagsOf('slice "Still Here" {\n  command Do Thing\n}');
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "orphaned-slice-doc",
        refs: ["removed-slice"],
      }),
    ]);
  });

  it("warns even when the model has no slices left at all", () => {
    writeUsableDoc("removed-slice");
    const diags = diagsOf("");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: "orphaned-slice-doc", refs: ["removed-slice"] });
  });
});

describe("non-warning cases", () => {
  it("does not warn when the doc's key matches a current slice, even with no note binding it", () => {
    writeUsableDoc("checkout");
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("does not warn on a case-mismatched but otherwise matching key", () => {
    writeUsableDoc("Checkout");
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("does not warn on a README with no frontmatter at all", () => {
    writeRawFile("README.md", "# Slice docs\n\nSee the event model for context.\n");
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("does not warn on a draft file with frontmatter missing required keys", () => {
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "future-idea.md"), "---\nstatus: draft\n---\nsome notes\n");
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("does not warn on a MIL-121 covered doc whose own canonical slice is gone but whose covers: names a live slice", () => {
    // "shared-doc" used to be its own slice's canonical doc; that slice is gone, but the doc
    // still ratifies coverage of "cancel-order", which is very much still in the model.
    writeUsableDoc("shared-doc", "covers: cancel-order\n");
    const diags = diagsOf('slice "Cancel Order" {\n  command Cancel Order\n}');
    expect(diags).toEqual([]);
  });

  it("does not warn when a non-.md file sits in slices/", () => {
    writeRawFile("diagram.svg", "<svg></svg>");
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("returns no diagnostics when slices/ doesn't exist at all", () => {
    const diags = diagsOf('slice "Checkout" {\n  command Do Thing\n}');
    expect(diags).toEqual([]);
  });

  it("still warns on a second orphan when a covers: doc also legitimately covers a live slice", () => {
    writeUsableDoc("shared-doc", "covers: cancel-order\n");
    writeUsableDoc("truly-orphaned");
    const diags = diagsOf('slice "Cancel Order" {\n  command Cancel Order\n}');
    expect(diags).toEqual([
      expect.objectContaining({ code: "orphaned-slice-doc", refs: ["truly-orphaned"] }),
    ]);
  });
});
