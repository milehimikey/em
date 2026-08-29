// SPDX-License-Identifier: MIT
// Coverage for src/catalog/sliceDoc.ts: status extraction against the real
// slice.md template (frontmatter, canonical per MIL-86), the legacy
// body-label bullet line (accepted input), a no-status freeform doc, and a
// minimal doc of each dialect. Plus (MIL-90) version and lineage
// (split-from/merged-from/superseded-by) extraction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSliceDoc, parseSliceRef } from "../src/catalog/sliceDoc.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseSliceDoc", () => {
  it("extracts the frontmatter status from the real slice.md template, lowercased", () => {
    const template = readFileSync(join(ROOT, ".claude/skills/event-modeling-shared/templates/slice.md"), "utf8");
    // Simulate a finished doc: the template instructs authors to delete the
    // leading guidance comment before finishing, which is what puts the
    // frontmatter fence at the very start of the file.
    const withoutComment = template.replace(/^<!--[\s\S]*?-->\n\n/, "");
    const filled = withoutComment.replace(
      "status: {{draft | reviewed | ready-to-implement | implemented}}",
      "status: Draft"
    );
    const doc = parseSliceDoc(filled);
    expect(doc.status).toBe("draft");
    expect(doc.html).toContain("<h1"); // "# Slice: {{Slice Name}}" renders to an <h1>
    expect(doc.html).not.toContain("<hr"); // frontmatter fences must not leak into the body render
    expect(doc.html).not.toContain("schemaVersion"); // nor the raw key: value lines
    // The template ships version: 1 and the lineage keys commented out (most slices never
    // split/merge), so a freshly-filled doc has a version but no lineage.
    expect(doc.version).toBe(1);
    expect(doc.splitFrom).toBeNull();
    expect(doc.mergedFrom).toEqual([]);
    expect(doc.supersededBy).toEqual([]);
  });

  // MIL-156: the Scenarios/Invariants sections were flat single-line bullets that rendered as a
  // dense run-on line/paragraph (soft line breaks collapse under marked's default, non-`breaks`
  // options). The template now nests Given/When/Then (and an Invariant's optional elaboration)
  // as their own list items — real markdown structure, not a wrapped sentence — which renders
  // visibly separated without needing `breaks: true` (a doc-wide option change this test would
  // also catch, since it isn't set — see sliceDoc.ts's `marked.parse` call).
  it("renders the real template's Scenarios section as a nested list, not a run-on paragraph", () => {
    const template = readFileSync(join(ROOT, ".claude/skills/event-modeling-shared/templates/slice.md"), "utf8");
    const withoutComment = template.replace(/^<!--[\s\S]*?-->\n\n/, "");
    const doc = parseSliceDoc(withoutComment);
    // The outer "Happy path" bullet's own <li> contains a nested <ul> — visible structure,
    // not one collapsed sentence — with Given/When/Then each as their own <li>.
    expect(doc.html).toMatch(/<li><strong>Happy path<\/strong><ul>/);
    expect(doc.html).toContain("<strong>Given:</strong>");
    expect(doc.html).toContain("<strong>When:</strong>");
    expect(doc.html).toContain("<strong>Then:</strong>");
  });

  it("returns null status when there's no recognizable status (freeform doc), but still renders", () => {
    const doc = parseSliceDoc("# Some Slice\n\nJust some notes, no structured header.\n");
    expect(doc.status).toBeNull();
    expect(doc.html).toContain("Some Slice");
  });

  it("extracts a frontmatter status from a minimal doc, lowercased", () => {
    const doc = parseSliceDoc("---\nstatus: Ready-To-Implement\n---\n# Some Slice\n");
    expect(doc.status).toBe("ready-to-implement");
    expect(doc.html).not.toContain("<hr");
    expect(doc.html).not.toContain("status:");
  });

  it("falls back to the legacy `- **Status:** ...` bullet line when there's no frontmatter", () => {
    const doc = parseSliceDoc("- **Status:** Ready-To-Implement\n");
    expect(doc.status).toBe("ready-to-implement");
  });

  it("falls back to the legacy bullet line when frontmatter exists but omits status", () => {
    const doc = parseSliceDoc(
      "---\npattern: state-change\n---\n# Some Slice\n\n- **Status:** Reviewed\n"
    );
    expect(doc.status).toBe("reviewed");
  });

  it("prefers frontmatter status over a legacy bullet line when both are present", () => {
    const doc = parseSliceDoc(
      "---\nstatus: implemented\n---\n# Some Slice\n\n- **Status:** Draft\n"
    );
    expect(doc.status).toBe("implemented");
  });

  it("treats an unterminated frontmatter fence as no frontmatter at all", () => {
    const doc = parseSliceDoc("---\nstatus: draft\n\n# Some Slice\nNo closing fence above.\n");
    expect(doc.status).toBeNull();
    expect(doc.html).toContain("Some Slice");
  });

  it("extracts a numeric version from frontmatter", () => {
    const doc = parseSliceDoc("---\nversion: 3\n---\n# Some Slice\n");
    expect(doc.version).toBe(3);
  });

  it("returns null version when the frontmatter has no version", () => {
    const doc = parseSliceDoc("---\nstatus: draft\n---\n# Some Slice\n");
    expect(doc.version).toBeNull();
  });

  it("returns null version for a non-numeric version value", () => {
    const doc = parseSliceDoc("---\nversion: abc\n---\n# Some Slice\n");
    expect(doc.version).toBeNull();
  });

  it("parses a split-from lineage ref into slice key and version", () => {
    const doc = parseSliceDoc("---\nsplit-from: checkout@v4\n---\n# Some Slice\n");
    expect(doc.splitFrom).toEqual({ raw: "checkout@v4", sliceKey: "checkout", version: 4 });
  });

  it("parses a comma-separated merged-from list into multiple refs", () => {
    const doc = parseSliceDoc(
      "---\nmerged-from: checkout@v4, apply-discount@v1\n---\n# Some Slice\n"
    );
    expect(doc.mergedFrom).toEqual([
      { raw: "checkout@v4", sliceKey: "checkout", version: 4 },
      { raw: "apply-discount@v1", sliceKey: "apply-discount", version: 1 },
    ]);
  });

  it("parses a comma-separated superseded-by list into multiple refs", () => {
    const doc = parseSliceDoc(
      "---\nsuperseded-by: checkout-v5@v1, apply-discount@v1\n---\n# Some Slice\n"
    );
    expect(doc.supersededBy).toEqual([
      { raw: "checkout-v5@v1", sliceKey: "checkout-v5", version: 1 },
      { raw: "apply-discount@v1", sliceKey: "apply-discount", version: 1 },
    ]);
  });

  it("parses a comma-separated `covers` list as plain slice keys, not @v refs (MIL-121)", () => {
    const doc = parseSliceDoc("---\ncovers: detect-unpaid-orders, some-other-slice\n---\n# Some Slice\n");
    expect(doc.covers).toEqual(["detect-unpaid-orders", "some-other-slice"]);
  });

  it("lowercases `covers` entries and trims whitespace, same as other list keys", () => {
    const doc = parseSliceDoc("---\ncovers:   Detect-Unpaid-Orders ,  OTHER-Slice\n---\n# Some Slice\n");
    expect(doc.covers).toEqual(["detect-unpaid-orders", "other-slice"]);
  });

  it("returns an empty array when `covers` is absent — the common case", () => {
    const doc = parseSliceDoc("---\nstatus: draft\n---\n# Some Slice\n");
    expect(doc.covers).toEqual([]);
  });

  it("parses `ratifiedBy`/`ratifiedOn` (MIL-165), free text and unlowercased", () => {
    const doc = parseSliceDoc(
      "---\nstatus: ready-to-implement\nratifiedBy: Alex Rivera\nratifiedOn: 2026-08-28\n---\n# Some Slice\n",
    );
    expect(doc.ratifiedBy).toBe("Alex Rivera");
    expect(doc.ratifiedOn).toBe("2026-08-28");
  });

  it("returns null for `ratifiedBy`/`ratifiedOn` when absent — a doc predating MIL-165", () => {
    const doc = parseSliceDoc("---\nstatus: draft\n---\n# Some Slice\n");
    expect(doc.ratifiedBy).toBeNull();
    expect(doc.ratifiedOn).toBeNull();
  });

  it("parses `owner`/`tracking` (MIL-171), free text and unlowercased", () => {
    const doc = parseSliceDoc(
      "---\nstatus: draft\nowner: Team Checkout\ntracking: https://tracker.example/issue/42\n---\n# Some Slice\n",
    );
    expect(doc.owner).toBe("Team Checkout");
    expect(doc.tracking).toBe("https://tracker.example/issue/42");
  });

  it("returns null for `owner`/`tracking` when absent — a doc predating MIL-171", () => {
    const doc = parseSliceDoc("---\nstatus: draft\n---\n# Some Slice\n");
    expect(doc.owner).toBeNull();
    expect(doc.tracking).toBeNull();
  });

  it("parses a comma-separated list with a mix of well-formed and malformed refs", () => {
    const doc = parseSliceDoc("---\nmerged-from: checkout, apply-discount@v1\n---\n# Some Slice\n");
    expect(doc.mergedFrom).toEqual([
      { raw: "checkout", sliceKey: null, version: null },
      { raw: "apply-discount@v1", sliceKey: "apply-discount", version: 1 },
    ]);
  });

  it("drops empty entries from a trailing-comma or double-comma lineage list", () => {
    const doc = parseSliceDoc("---\nmerged-from: checkout@v4,, apply-discount@v1,\n---\n# Some Slice\n");
    expect(doc.mergedFrom).toEqual([
      { raw: "checkout@v4", sliceKey: "checkout", version: 4 },
      { raw: "apply-discount@v1", sliceKey: "apply-discount", version: 1 },
    ]);
  });

  it("keeps the raw text and nulls sliceKey/version for a malformed lineage ref, without throwing", () => {
    const doc = parseSliceDoc("---\nsplit-from: checkout\n---\n# Some Slice\n");
    expect(doc.splitFrom).toEqual({ raw: "checkout", sliceKey: null, version: null });
    expect(parseSliceRef("not-a-ref-at-all")).toEqual({
      raw: "not-a-ref-at-all",
      sliceKey: null,
      version: null,
    });
  });

  it("ignores commented-out lineage guidance lines in frontmatter", () => {
    const doc = parseSliceDoc(
      "---\nversion: 1\n# split-from: <slice-key>@v<N>\n---\n# Some Slice\n"
    );
    expect(doc.splitFrom).toBeNull();
    expect(doc.version).toBe(1);
  });

  it("continues to parse unknown extra keys harmlessly, including a YAML-list-valued one", () => {
    const doc = parseSliceDoc(
      [
        "---",
        "id: checkout",
        "title: Checkout",
        "status: implemented",
        "version: 2",
        "upstreamEvents:",
        "  - Cart Sourced",
        "  - Stock Reserved",
        "---",
        "# Checkout",
        "",
        "Body text.",
      ].join("\n")
    );
    expect(doc.status).toBe("implemented");
    expect(doc.version).toBe(2);
    expect(doc.html).toContain("Body text.");
  });
});

// MIL-87: Open Questions checkbox counting, the readiness gate's other required signal
// alongside status. Scans the raw body text (not the rendered HTML) for GFM task-list items
// under a `## Open Questions` heading.
describe("parseSliceDoc: openQuestionsTotal / openQuestionsUnchecked (MIL-87)", () => {
  it("counts 0/0 when there's no Open Questions heading at all", () => {
    const doc = parseSliceDoc("# Some Slice\n\nJust prose, no questions section.\n");
    expect(doc.openQuestionsTotal).toBe(0);
    expect(doc.openQuestionsUnchecked).toBe(0);
  });

  it("counts every checkbox item and how many remain unchecked", () => {
    const doc = parseSliceDoc(
      "# Some Slice\n\n## Open Questions\n- [ ] first question\n- [x] second question, resolved\n- [ ] third question\n",
    );
    expect(doc.openQuestionsTotal).toBe(3);
    expect(doc.openQuestionsUnchecked).toBe(2);
  });

  it("counts 0 unchecked once every question is checked off", () => {
    const doc = parseSliceDoc("## Open Questions\n- [x] resolved one\n- [X] resolved two (capital X)\n");
    expect(doc.openQuestionsTotal).toBe(2);
    expect(doc.openQuestionsUnchecked).toBe(0);
  });

  it("matches the heading case-insensitively", () => {
    const doc = parseSliceDoc("## open questions\n- [ ] still open\n");
    expect(doc.openQuestionsTotal).toBe(1);
    expect(doc.openQuestionsUnchecked).toBe(1);
  });

  it("stops counting at the next heading, ignoring task items in later sections", () => {
    const doc = parseSliceDoc(
      "## Open Questions\n- [ ] in scope\n\n## Some Other Section\n- [ ] not an open question\n",
    );
    expect(doc.openQuestionsTotal).toBe(1);
    expect(doc.openQuestionsUnchecked).toBe(1);
  });

  it("ignores task-list-shaped lines outside any Open Questions section", () => {
    const doc = parseSliceDoc("## Scenarios\n- [ ] this looks like a checkbox but isn't a question\n");
    expect(doc.openQuestionsTotal).toBe(0);
    expect(doc.openQuestionsUnchecked).toBe(0);
  });

  it("counts indented sub-items the same as top-level ones", () => {
    const doc = parseSliceDoc("## Open Questions\n- [ ] top-level question\n  - [ ] indented sub-question\n");
    expect(doc.openQuestionsTotal).toBe(2);
    expect(doc.openQuestionsUnchecked).toBe(2);
  });
});
