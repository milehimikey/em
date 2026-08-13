// SPDX-License-Identifier: MIT
// Coverage for `em validate`'s lineage-ref resolution (src/catalog/lineageValidate.ts,
// MIL-84): malformed grammar, self-reference/cycles, dangling forward refs, impossible version
// arithmetic — and, just as important, the no-diagnostic cases the ratified ruling requires
// (Linear MIL-84, 2026-08-13): a backward ref naming a key absent from the current model is
// steady state, not a defect, and must never warn. Real fs fixtures via mkdtempSync, same
// convention as test/export.test.ts's "slice-doc join (MIL-91)" section — validateLineage()
// reads slices/*.md off disk, like docJoin.ts does for `em export`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateLineage } from "../src/catalog/lineageValidate.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-lineage-validate-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a slice doc with the given lineage-relevant frontmatter lines, at a given version. */
function writeDoc(sliceKey: string, version: number, extraFrontmatter: string): void {
  writeFileSync(
    join(dir, "slices", `${sliceKey}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: ${version}\n${extraFrontmatter}\n---\nbody\n`,
  );
}

function lineageOf(src: string) {
  const { model, refs } = compile(src);
  return validateLineage(model, refs, dir);
}

describe("lineage-ref-malformed", () => {
  it("errors when a lineage value doesn't match <slice-key>@v<N>", () => {
    writeDoc("malformed", 1, "split-from: not-a-ref");
    const diags = lineageOf(`slice "Malformed" {\n  command Do Thing\n}`);
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "lineage-ref-malformed",
        refs: ["malformed"],
      }),
    );
  });
});

describe("lineage-ref-cycle", () => {
  it("errors on a self-reference", () => {
    writeDoc("self-ref", 1, "merged-from: self-ref@v1");
    const diags = lineageOf(`slice "Self Ref" {\n  command Do Thing\n}`);
    expect(diags).toContainEqual(
      expect.objectContaining({ severity: "error", code: "lineage-ref-cycle", refs: ["self-ref"] }),
    );
  });

  it("errors on a genuine 2-node cycle between slices both present in-model", () => {
    writeDoc("cycle-a", 1, "split-from: cycle-b@v1");
    writeDoc("cycle-b", 1, "split-from: cycle-a@v1");
    const diags = lineageOf(`slice "Cycle A" {\n  command Do A\n}\nslice "Cycle B" {\n  command Do B\n}`);
    const cycles = diags.filter((d) => d.code === "lineage-ref-cycle");
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].refs).toEqual(expect.arrayContaining(["cycle-a", "cycle-b"]));
  });
});

describe("lineage-forward-dangling", () => {
  it("errors when superseded-by names a key absent from the current model", () => {
    writeDoc("ghosted", 1, "superseded-by: ghost@v1");
    const diags = lineageOf(`slice "Ghosted" {\n  command Do Thing\n}`);
    expect(diags).toContainEqual(
      expect.objectContaining({ severity: "error", code: "lineage-forward-dangling", refs: ["ghosted"] }),
    );
  });

  it("no diagnostic when superseded-by names a key present in the current model", () => {
    writeDoc("old-checkout", 1, "superseded-by: new-checkout@v1");
    writeDoc("new-checkout", 1, "");
    const diags = lineageOf(`slice "Old Checkout" {\n  command Do Old\n}\nslice "New Checkout" {\n  command Do New\n}`);
    expect(diags.filter((d) => d.code === "lineage-forward-dangling")).toEqual([]);
  });
});

describe("lineage-version-impossible", () => {
  it("errors when a ref names a version higher than the target's current version", () => {
    writeDoc("checkout", 5, "");
    writeDoc("discount-rules", 1, "split-from: checkout@v9");
    const diags = lineageOf(`slice "Checkout" {\n  command Do Checkout\n}\nslice "Discount Rules" {\n  command Apply Discount\n}`);
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "lineage-version-impossible",
        refs: ["discount-rules", "checkout"],
      }),
    );
  });

  it("no diagnostic when the referenced version is legal (<= target's current version)", () => {
    writeDoc("legal-checkout", 5, "");
    writeDoc("legal-split", 1, "split-from: legal-checkout@v3");
    const diags = lineageOf(`slice "Legal Checkout" {\n  command Do Checkout\n}\nslice "Legal Split" {\n  command Apply Discount\n}`);
    expect(diags.filter((d) => d.code === "lineage-version-impossible")).toEqual([]);
  });

  it("skips the arithmetic check silently when the target has no doc / no numeric version", () => {
    // "no-doc-target" has no slices/*.md at all — the ref resolves in-model but its version
    // can't be checked against anything, so this must produce no diagnostic at all.
    writeDoc("no-doc-split", 1, "split-from: no-doc-target@v99");
    const diags = lineageOf(`slice "No Doc Target" {\n  command Do Thing\n}\nslice "No Doc Split" {\n  command Do Split\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no diagnostic: backward ref naming a legitimately absent predecessor", () => {
  it("split-from naming an absent key produces zero diagnostics", () => {
    writeDoc("renamed", 1, "split-from: never-existed@v3");
    const diags = lineageOf(`slice "Renamed" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });

  it("merged-from naming an absent key produces zero diagnostics — the steady state after a real merge", () => {
    writeDoc("unified-cart", 1, "merged-from: retired-cart@v3, retired-wishlist@v1");
    const diags = lineageOf(`slice "Unified Cart" {\n  command Update Cart\n}`);
    expect(diags).toEqual([]);
  });
});

describe("diagnostics carry refs/line for both sides", () => {
  it("lineage-version-impossible's refs include both the owner and the resolved target", () => {
    writeDoc("target-v", 2, "");
    writeDoc("owner-v", 1, "merged-from: target-v@v7");
    const diags = lineageOf(`slice "Target V" {\n  command Do Target\n}\nslice "Owner V" {\n  command Do Owner\n}`);
    const found = diags.find((d) => d.code === "lineage-version-impossible");
    expect(found).toBeDefined();
    expect(found!.refs).toEqual(["owner-v", "target-v"]);
    expect(typeof found!.line).toBe("number");
  });
});
