// SPDX-License-Identifier: MIT
// MIL-186 regression guard: the vendored skill bundle used to reference docs/*.md files that
// `em skill install`/the npm package never ship, sending an agent hunting reference/ for a
// frontmatter doc that doesn't exist. The fix has two parts, and this test enforces both stay
// true as the bundle keeps changing:
//
//   1. docs/slice-doc-schema.md is load-bearing (the frontmatter contract an authoring agent
//      needs mid-session) and is now vendored as reference/slice-doc-schema.md (see
//      skillDocsGenerated.test.ts for the sync check) — so no bare `docs/slice-doc-schema.md`
//      reference may ever reappear anywhere in the bundle; every mention must repoint there.
//   2. Every *other* docs/*.md file is deliberately left un-vendored ("further reading", not
//      something a session needs to open) and is marked as such by the single convention note
//      in operating-principles.md ("References to docs/*.md ... are not vendored") instead of
//      annotating every individual occurrence — every skill phase reads that file before doing
//      real work (see each SKILL.md's preconditions), so the note only needs to exist once. This
//      test's real job is the allowlist below: a bare `docs/whatever.md` mention naming a doc
//      not already triaged into that convention fails loudly, forcing a deliberate choice (vendor
//      it like slice-doc-schema.md, or add it to the allowlist here) instead of silently
//      reintroducing an unmarked dangling reference.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EM_ALL_SKILL_BUNDLE_DIRS } from "../src/cli/skillDirs.js";

const SKILLS_ROOT = ".claude/skills";
const OPERATING_PRINCIPLES_MD = join(SKILLS_ROOT, "event-modeling-shared/reference/operating-principles.md");

// docs/*.md files the bundle deliberately never vendors — each is "further reading" a session
// can live without mid-task, covered by operating-principles.md's one convention note rather
// than a per-occurrence marker. Adding a name here is itself the deliberate triage decision the
// header comment above describes.
const EM_REPO_ONLY_DOCS = new Set(["cli", "ci", "process", "mcp", "usage-data", "validation", "dsl"]);

function skillMarkdownFiles(): string[] {
  const out: string[] = [];
  for (const dirName of EM_ALL_SKILL_BUNDLE_DIRS) {
    const dir = join(SKILLS_ROOT, dirName);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) out.push(skillMd); // event-modeling-shared has none — not a skill
    for (const sub of ["reference", "templates"]) {
      const subDir = join(dir, sub);
      if (!existsSync(subDir)) continue;
      for (const f of readdirSync(subDir)) {
        if (f.endsWith(".md")) out.push(join(subDir, f));
      }
    }
  }
  return out;
}

describe("skill bundle docs/*.md references (MIL-186)", () => {
  const files = skillMarkdownFiles();

  it("finds skill markdown files (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("operating-principles.md still states the em-repo-only convention", () => {
    const content = readFileSync(OPERATING_PRINCIPLES_MD, "utf8");
    expect(content).toContain("References to `docs/*.md`");
    expect(content).toMatch(/not\s+vendored alongside these skills/);
  });

  // Two files legitimately name "docs/slice-doc-schema.md" as prose, not as a dangling
  // cross-reference an agent would follow: the vendored copy's own generated-file banner
  // (naming its source) and operating-principles.md's note explaining the sync relationship.
  const SELF_REFERENTIAL_MENTIONS = new Set([
    join(SKILLS_ROOT, "event-modeling-shared/reference/slice-doc-schema.md"),
    OPERATING_PRINCIPLES_MD,
  ]);

  for (const file of files) {
    if (!SELF_REFERENTIAL_MENTIONS.has(file)) {
      it(`${file} never bare-references docs/slice-doc-schema.md (must point at the vendored copy)`, () => {
        const content = readFileSync(file, "utf8");
        expect(content).not.toMatch(/\bdocs\/slice-doc-schema\.md\b/);
      });
    }

    it(`${file}'s docs/*.md mentions are all pre-triaged em-repo-only docs`, () => {
      const content = readFileSync(file, "utf8");
      const names = [...content.matchAll(/\bdocs\/([a-zA-Z0-9_-]+)\.md\b/g)].map((m) => m[1]);
      const untriaged = names.filter((name) => name !== "slice-doc-schema" && !EM_REPO_ONLY_DOCS.has(name));
      expect(untriaged).toEqual([]);
    });
  }
});
