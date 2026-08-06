// SPDX-License-Identifier: MIT
// Coverage for src/catalog/sliceDoc.ts: Status-line extraction against the
// real slice.md template, a no-Status freeform doc, and a minimal doc.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSliceDoc } from "../src/catalog/sliceDoc.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseSliceDoc", () => {
  it("extracts the Status line from the real slice.md template, lowercased", () => {
    const template = readFileSync(join(ROOT, ".claude/skills/event-modeling/templates/slice.md"), "utf8");
    const filled = template.replace("{{draft | reviewed | ready-to-implement | implemented}}", "Draft");
    const doc = parseSliceDoc(filled);
    expect(doc.status).toBe("draft");
    expect(doc.html).toContain("<h1"); // "# Slice: {{Slice Name}}" renders to an <h1>
  });

  it("returns null status when there's no recognizable Status line (freeform doc), but still renders", () => {
    const doc = parseSliceDoc("# Some Slice\n\nJust some notes, no structured header.\n");
    expect(doc.status).toBeNull();
    expect(doc.html).toContain("Some Slice");
  });

  it("extracts and lowercases an explicit status value from a minimal templated doc", () => {
    const doc = parseSliceDoc("- **Status:** Ready-To-Implement\n");
    expect(doc.status).toBe("ready-to-implement");
  });
});
