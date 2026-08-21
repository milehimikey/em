// SPDX-License-Identifier: MIT
// Coverage for `em validate --slice-ready <key>`'s underlying check
// (src/catalog/sliceReadyValidate.ts, MIL-87): the handoff gate without the bridge. Real fs
// fixtures via mkdtempSync, same convention as test/lineageValidate.test.ts and
// test/frontmatterCoherenceValidate.test.ts. Doc resolution is note-bound (docJoin.ts, MIL-91),
// unlike lineage/frontmatter-coherence's filename-only readSliceDoc — every `.em` fixture below
// that expects a doc to be found declares `note "slices/<key>.md"` on an element.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateSliceReady } from "../src/catalog/sliceReadyValidate.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-slice-ready-validate-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeDoc(sliceKey: string, extraFrontmatter: string, body = "body\n"): void {
  writeFileSync(
    join(dir, "slices", `${sliceKey}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\n${extraFrontmatter}---\n${body}`,
  );
}

function readyDiagsOf(src: string, sliceKey: string) {
  const { model, refs } = compile(src);
  return validateSliceReady(model, refs, dir, sliceKey);
}

describe("slice-ready-unknown-slice", () => {
  it("errors when the given key names no slice in the model", () => {
    const diags = readyDiagsOf(`slice "Place" {\n  command Do Thing\n}`, "no-such-slice");
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "slice-ready-unknown-slice",
        refs: ["no-such-slice"],
      }),
    ]);
  });
});

describe("slice-ready-no-doc-bound", () => {
  it("warns when no element declares a note binding to the conventional doc path", () => {
    const diags = readyDiagsOf(`slice "Unbound" {\n  command Do Thing\n}`, "unbound");
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-no-doc-bound",
        refs: ["unbound"],
      }),
    ]);
  });
});

describe("binding-missing-file (reused from docJoin, not re-coded)", () => {
  it("warns when the note names a path but no file exists there", () => {
    const diags = readyDiagsOf(
      `slice "Ghost" {\n  command Do Thing note "slices/ghost.md"\n}`,
      "ghost",
    );
    expect(diags).toEqual([expect.objectContaining({ severity: "warning", code: "binding-missing-file" })]);
  });
});

describe("frontmatter-invalid (reused from docJoin, not re-coded)", () => {
  it("warns when the doc exists but has no frontmatter block", () => {
    writeFileSync(join(dir, "slices", "no-frontmatter.md"), "# Slice: No Frontmatter\n\nbody\n");
    const diags = readyDiagsOf(
      `slice "No Frontmatter" {\n  command Do Thing note "slices/no-frontmatter.md"\n}`,
      "no-frontmatter",
    );
    expect(diags).toEqual([expect.objectContaining({ severity: "warning", code: "frontmatter-invalid" })]);
  });
});

describe("slice-ready-status-not-ready", () => {
  it("warns when the doc is bound and usable but status isn't ready-to-implement", () => {
    writeDoc("draft-slice", "status: draft\nversion: 1\n");
    const diags = readyDiagsOf(
      `slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n}`,
      "draft-slice",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-status-not-ready",
        refs: ["draft-slice"],
      }),
    ]);
  });
});

describe("slice-ready-open-questions-unchecked", () => {
  it("warns with the unchecked/total count when Open Questions remain", () => {
    writeDoc(
      "unresolved",
      "status: ready-to-implement\nversion: 1\n",
      "## Open Questions\n- [ ] who validates this?\n- [x] already answered\n",
    );
    const diags = readyDiagsOf(
      `slice "Unresolved" {\n  command Do Thing note "slices/unresolved.md"\n}`,
      "unresolved",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-open-questions-unchecked",
        message: expect.stringContaining("1 of 2"),
        refs: ["unresolved"],
      }),
    ]);
  });

  it("combines with slice-ready-status-not-ready when both are true", () => {
    writeDoc("both-wrong", "status: draft\nversion: 1\n", "## Open Questions\n- [ ] unresolved\n");
    const diags = readyDiagsOf(
      `slice "Both Wrong" {\n  command Do Thing note "slices/both-wrong.md"\n}`,
      "both-wrong",
    );
    expect(diags.map((d) => d.code).sort()).toEqual([
      "slice-ready-open-questions-unchecked",
      "slice-ready-status-not-ready",
    ]);
  });
});

describe("cross-slice binding (MIL-121)", () => {
  // The ticket's own repro shape: a view-only slice ("Detect Unpaid Orders") with no doc of its
  // own, covered instead by the reaction slice's doc ("Request Payment") via a ratifying
  // `covers:` entry naming the view slice's key back.
  it("passes the view-only slice through to a ready, no-open-questions covering doc", () => {
    writeDoc(
      "request-payment",
      "status: ready-to-implement\nversion: 1\ncovers: detect-unpaid-orders\n",
      "## Open Questions\n- [x] resolved before ratification\n",
    );
    const diags = readyDiagsOf(
      [
        'slice "Detect Unpaid Orders" {',
        '  view Unpaid Orders from "Order Placed" note "slices/request-payment.md"',
        "}",
        'slice "Request Payment" {',
        "  processor Payment Request Policy from \"Unpaid Orders\" note \"slices/request-payment.md\"",
        "  command Request Payment",
        "  event Payment Requested",
        "}",
      ].join("\n"),
      "detect-unpaid-orders",
    );
    expect(diags).toEqual([]);
  });

  it("reports status-not-ready from the covering doc when it isn't ready-to-implement", () => {
    writeDoc("draft-covering-doc", "status: draft\nversion: 1\ncovers: covered-by-draft\n");
    const diags = readyDiagsOf(
      `slice "Covered By Draft" {\n  view Covered By Draft from "Something" note "slices/draft-covering-doc.md"\n}`,
      "covered-by-draft",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-status-not-ready",
        refs: ["covered-by-draft"],
      }),
    ]);
  });

  it("a cross-note not ratified by the target doc's `covers` is still no-doc-bound", () => {
    writeDoc("uncovering-doc", "status: ready-to-implement\nversion: 1\n"); // no `covers:` at all
    const diags = readyDiagsOf(
      `slice "Not Covered" {\n  view Not Covered from "Something" note "slices/uncovering-doc.md"\n}`,
      "not-covered",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-no-doc-bound",
        refs: ["not-covered"],
      }),
    ]);
  });
});

describe("ready: the all-clear case", () => {
  it("produces zero diagnostics for a bound, usable, ready-to-implement doc with no open questions", () => {
    writeDoc(
      "ready-slice",
      "status: ready-to-implement\nversion: 1\n",
      "## Open Questions\n- [x] resolved before ratification\n",
    );
    const diags = readyDiagsOf(
      `slice "Ready Slice" {\n  command Do Thing note "slices/ready-slice.md"\n}`,
      "ready-slice",
    );
    expect(diags).toEqual([]);
  });

  it("produces zero diagnostics for a ready doc with no Open Questions section at all", () => {
    writeDoc("ready-no-questions", "status: ready-to-implement\nversion: 1\n");
    const diags = readyDiagsOf(
      `slice "Ready No Questions" {\n  command Do Thing note "slices/ready-no-questions.md"\n}`,
      "ready-no-questions",
    );
    expect(diags).toEqual([]);
  });
});
