// SPDX-License-Identifier: MIT
// Coverage for src/catalog/sliceDoc.ts: status extraction against the real
// slice.md template (frontmatter, canonical per MIL-86), the legacy
// body-label bullet line (accepted input), a no-status freeform doc, and a
// minimal doc of each dialect.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSliceDoc } from "../src/catalog/sliceDoc.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseSliceDoc", () => {
  it("extracts the frontmatter status from the real slice.md template, lowercased", () => {
    const template = readFileSync(join(ROOT, ".claude/skills/event-modeling/templates/slice.md"), "utf8");
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
});
