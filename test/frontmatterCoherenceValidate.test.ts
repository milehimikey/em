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
