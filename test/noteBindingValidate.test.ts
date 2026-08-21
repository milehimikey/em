// SPDX-License-Identifier: MIT
// Coverage for `em validate`'s note-binding mismatch check (src/catalog/noteBindingValidate.ts,
// MIL-126): a slice-doc-shaped `note` that doesn't actually participate in its slice's resolved
// doc binding (docJoin.ts, MIL-91/MIL-121) no longer vanishes silently. Real fs fixtures via
// mkdtempSync, same convention as test/lineageValidate.test.ts and
// test/frontmatterCoherenceValidate.test.ts — this check reads slices/*.md off disk too.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateNoteBindings } from "../src/catalog/noteBindingValidate.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-note-binding-validate-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a slice doc with the given extra frontmatter lines (each ending in its own `\n`). */
function writeDoc(sliceKey: string, extraFrontmatter: string, body = "body\n"): void {
  writeFileSync(
    join(dir, "slices", `${sliceKey}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\n${extraFrontmatter}---\n${body}`,
  );
}

function diagsOf(src: string) {
  const { model, refs } = compile(src);
  return validateNoteBindings(model, refs, dir);
}

describe("the ticket's literal repro", () => {
  it("warns on an extra note in a slice already canonically bound by a different element", () => {
    writeDoc("request-payment", "status: draft\nversion: 1\n");
    const diags = diagsOf(
      [
        'slice "Request Payment" {',
        '  command Request Payment note "slices/request-payment.md"',
        '  event Payment Requested @Payment note "slices/some-other-doc.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "note-binding-extra",
        refs: ["request-payment", "request-payment/event.payment-requested"],
      }),
    ]);
  });
});

describe("note-binding-extra", () => {
  it("warns when a second note in an already ratified-cross-bound slice names a different doc", () => {
    writeDoc("covering-doc", "status: ready-to-implement\nversion: 1\ncovers: covered-slice\n");
    writeDoc("unrelated-doc", "status: draft\nversion: 1\n");
    const diags = diagsOf(
      [
        'slice "Covered Slice" {',
        '  command A note "slices/covering-doc.md"',
        '  event B note "slices/unrelated-doc.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "note-binding-extra",
        message: expect.stringContaining("cross-binding"),
        refs: ["covered-slice", "covered-slice/event.b"],
      }),
    ]);
  });

  it("case 5: two distinct ratifiable cross-notes — first wins, the later one warns as extra", () => {
    writeDoc("winner-doc", "status: ready-to-implement\nversion: 1\ncovers: two-candidates\n");
    writeDoc("loser-doc", "status: ready-to-implement\nversion: 1\ncovers: two-candidates\n");
    const diags = diagsOf(
      [
        'slice "Two Candidates" {',
        '  command A note "slices/winner-doc.md"',
        '  event B note "slices/loser-doc.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([
      expect.objectContaining({
        code: "note-binding-extra",
        refs: ["two-candidates", "two-candidates/event.b"],
      }),
    ]);
  });
});

describe("note-binding-dangling", () => {
  it("warns when an unbound slice's cross-note names a file that doesn't exist", () => {
    const diags = diagsOf(`slice "Ghost Ref" {\n  command Do Thing note "slices/no-such-doc.md"\n}`);
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "note-binding-dangling",
        refs: ["ghost-ref", "ghost-ref/command.do-thing"],
      }),
    ]);
  });
});

describe("note-binding-unusable", () => {
  it("warns when an unbound slice's cross-note names a doc with no frontmatter block", () => {
    writeFileSync(join(dir, "slices", "no-frontmatter-doc.md"), "# No Frontmatter\n\nbody\n");
    const diags = diagsOf(`slice "Unusable Ref" {\n  command Do Thing note "slices/no-frontmatter-doc.md"\n}`);
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "note-binding-unusable",
        refs: ["unusable-ref", "unusable-ref/command.do-thing"],
      }),
    ]);
  });
});

describe("note-binding-unratified", () => {
  it("warns when an unbound slice's cross-note names a usable doc whose `covers` doesn't list it", () => {
    writeDoc("no-covers-doc", "status: ready-to-implement\nversion: 1\n"); // no covers: at all
    const diags = diagsOf(`slice "Unratified Ref" {\n  command Do Thing note "slices/no-covers-doc.md"\n}`);
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "note-binding-unratified",
        message: expect.stringContaining("covers: unratified-ref"),
        refs: ["unratified-ref", "unratified-ref/command.do-thing"],
      }),
    ]);
  });

  it("warns when the covers list is present but names other slices, not this one", () => {
    writeDoc("wrong-covers-doc", "status: ready-to-implement\nversion: 1\ncovers: some-other-slice\n");
    const diags = diagsOf(`slice "Wrong Ref" {\n  command Do Thing note "slices/wrong-covers-doc.md"\n}`);
    expect(diags).toEqual([expect.objectContaining({ code: "note-binding-unratified", refs: ["wrong-ref", "wrong-ref/command.do-thing"] })]);
  });
});

describe("no warning: notes this rule has no business touching", () => {
  it("never warns on a freeform note that isn't shaped like slices/<key>.md", () => {
    const diags = diagsOf(`slice "Freeform" {\n  command Do Thing note "notes/random-thoughts.md"\n}`);
    expect(diags).toEqual([]);
  });

  it("never warns on a note pointing outside slices/ entirely", () => {
    const diags = diagsOf(`slice "Elsewhere" {\n  command Do Thing note "docs/some-doc.md"\n}`);
    expect(diags).toEqual([]);
  });

  it("never warns when there's no note at all", () => {
    const diags = diagsOf(`slice "No Note" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no warning: canonical binding, broken doc — already covered by docJoin's own diagnostics", () => {
  it("doesn't duplicate binding-missing-file for a canonical note with no file", () => {
    const diags = diagsOf(`slice "Missing Canonical" {\n  command Do Thing note "slices/missing-canonical.md"\n}`);
    expect(diags).toEqual([]);
  });

  it("doesn't duplicate frontmatter-invalid for a canonical note whose doc has no frontmatter", () => {
    writeFileSync(join(dir, "slices", "broken-canonical.md"), "# No Frontmatter\n\nbody\n");
    const diags = diagsOf(`slice "Broken Canonical" {\n  command Do Thing note "slices/broken-canonical.md"\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no warning: multiple elements carrying the same winning path", () => {
  it("is fine when two elements both note the same canonical path", () => {
    writeDoc("shared-canonical", "status: draft\nversion: 1\n");
    const diags = diagsOf(
      [
        'slice "Shared Canonical" {',
        '  command A note "slices/shared-canonical.md"',
        '  event B note "slices/shared-canonical.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([]);
  });

  it("is fine when two elements both note the same winning ratified cross-binding path", () => {
    writeDoc("shared-cover-doc", "status: ready-to-implement\nversion: 1\ncovers: shared-cross\n");
    const diags = diagsOf(
      [
        'slice "Shared Cross" {',
        '  command A note "slices/shared-cover-doc.md"',
        '  event B note "slices/shared-cover-doc.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([]);
  });
});

describe("no warning: the MIL-121 happy path", () => {
  it("a single ratified cross-binding with no other notes produces zero warnings", () => {
    // "request-payment.md" is doubly load-bearing here, exactly like the real MIL-121 shape: it's
    // "Request Payment"'s own CANONICAL doc (note matches its own key, always fine regardless of
    // covers) AND, via `covers: detect-unpaid-orders`, the ratified cross-binding for the
    // view-only "Detect Unpaid Orders" slice next to it.
    writeDoc("request-payment", "status: ready-to-implement\nversion: 1\ncovers: detect-unpaid-orders\n");
    const diags = diagsOf(
      [
        'slice "Detect Unpaid Orders" {',
        '  view Unpaid Orders from "Order Placed" note "slices/request-payment.md"',
        "}",
        'slice "Request Payment" {',
        '  processor Payment Request Policy from "Unpaid Orders" note "slices/request-payment.md"',
        "  command Request Payment",
        "  event Payment Requested",
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([]);
  });
});

describe("case-mismatched self-note: left inert, same as before MIL-126 (deliberately not policed)", () => {
  it("a note naming this slice's own key in the wrong case produces no warning", () => {
    writeDoc("case-mismatch", "status: draft\nversion: 1\n");
    const diags = diagsOf(`slice "Case Mismatch" {\n  command Do Thing note "slices/Case-Mismatch.md"\n}`);
    expect(diags).toEqual([]);
  });
});
