// SPDX-License-Identifier: MIT
// Coverage for `em validate`'s frontmatter-coherence check (src/catalog/frontmatterCoherenceValidate.ts,
// MIL-85): warns on genuine status/implementedIn incoherence (`status: implemented`, no link) —
// and, just as important, the no-diagnostic case the ticket's own "don't cry wolf" requirement
// demands: a re-ratified slice (status off `implemented`, `implementedIn` still naming prior
// work) is the EXPECTED unpropagated-delta signal, not incoherence, and must never warn. Real fs
// fixtures via mkdtempSync, same convention as test/lineageValidate.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateFrontmatterCoherence } from "../src/catalog/frontmatterCoherenceValidate.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-frontmatter-coherence-validate-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a slice doc with the given status/version/implementedIn. */
function writeDoc(sliceKey: string, status: string, version: number, implementedIn: string | null): void {
  const implementedInLine = implementedIn ? `implementedIn: ${implementedIn}\n` : "";
  writeFileSync(
    join(dir, "slices", `${sliceKey}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: ${version}\n${implementedInLine}---\nbody\n`,
  );
}

function coherenceOf(src: string) {
  const { model, refs } = compile(src);
  return validateFrontmatterCoherence(model, refs, dir);
}

describe("frontmatter-coherence-implemented-without-link", () => {
  it("warns when status: implemented has no implementedIn link", () => {
    writeDoc("shipped-no-link", "implemented", 1, null);
    const diags = coherenceOf(`slice "Shipped No Link" {\n  command Do Thing\n}`);
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "frontmatter-coherence-implemented-without-link",
        refs: ["shipped-no-link"],
      }),
    );
  });
});

describe("no diagnostic: unpropagated delta is expected, not incoherence", () => {
  it("stays silent when a re-ratified slice's implementedIn still names prior work", () => {
    writeDoc("re-ratified", "ready-to-implement", 2, "https://github.com/example/pr/41");
    const diags = coherenceOf(`slice "Re Ratified" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no diagnostic: never implemented", () => {
  it("stays silent for a draft slice with no implementedIn link", () => {
    writeDoc("draft-slice", "draft", 1, null);
    const diags = coherenceOf(`slice "Draft Slice" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no diagnostic: in-sync", () => {
  it("stays silent when status: implemented has a link", () => {
    writeDoc("in-sync", "implemented", 1, "https://github.com/example/pr/1");
    const diags = coherenceOf(`slice "In Sync" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no diagnostic: legacy body-label dialect doc (no frontmatter)", () => {
  it("stays silent for a legacy status: implemented doc — implementedIn is frontmatter-only, so absence isn't checkable here", () => {
    // MIL-86's accepted-input legacy dialect: `- **Status:** ...` with no `---` frontmatter
    // fence at all. `implementedIn` has no legacy form, so it always reads null on such a doc —
    // flagging that as incoherence would be a false positive against every doc that simply
    // predates the canonical dialect, not one that's actually incoherent. em export's docJoin.ts
    // treats the same doc as frontmatter-invalid (driftSignal: null); this check matches that.
    writeFileSync(
      join(dir, "slices", "legacy.md"),
      "# Slice: Legacy\n\n- **Status:** implemented\n\nbody\n",
    );
    const diags = coherenceOf(`slice "Legacy" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});

describe("no diagnostic: well-formed fence missing a different required key", () => {
  it("stays silent when the fence is present but `version` is absent — hasUsableFrontmatter() gates on missingRequiredFields too, not just the fence", () => {
    // Repro from PR review: a doc with a closed `---`/`---` fence but missing `version` (a
    // REQUIRED_FRONTMATTER_KEYS entry) previously slipped past a `!frontmatterPresent`-only
    // guard and still triggered the warning, disagreeing with em export's docJoin.ts, which
    // already classifies this exact doc as frontmatter-invalid (driftSignal: null).
    writeFileSync(
      join(dir, "slices", "missing-version.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\n---\nbody\n",
    );
    const diags = coherenceOf(`slice "Missing Version" {\n  command Do Thing\n}`);
    expect(diags).toEqual([]);
  });
});
