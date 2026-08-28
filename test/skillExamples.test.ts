// SPDX-License-Identifier: MIT
// The event-modeling skill bundle teaches by example: an agent reads its ```em blocks and
// copies the shape. So every runnable snippet in the bundle must actually parse and validate —
// otherwise the skill teaches models that em rejects. This caught two real bugs: pattern
// examples whose event no read model read, and a one-line `slice "X" { … }` form the parser
// doesn't support.
//
// The bundle is several directories since the skill split (MIL-157, see src/cli/skillDirs.ts):
// each event-modeling-* skill's own SKILL.md/reference/, plus the shared, non-skill
// event-modeling-shared directory (reference/templates every skill points back to). This walks
// all of them, not just one.
//
// Only the skill bundle is covered. docs/ deliberately contains counter-examples (timeline.md
// shows a backward-arrow error; tutorial.md shows a dangling event one page before fixing it).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { EM_ALL_SKILL_BUNDLE_DIRS } from "../src/cli/skillDirs.js";

const SKILLS_ROOT = ".claude/skills";

function skillFiles(): string[] {
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

/** Fenced ```em blocks that declare at least one slice — i.e. something em could actually run. */
function runnableBlocks(md: string): string[] {
  return [...md.matchAll(/```em\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b) => /^\s*slice\b/m.test(b));
}

describe("event-modeling skill examples", () => {
  const files = skillFiles();

  it("finds the skill's em snippets (guards against a silently empty sweep)", () => {
    const total = files.reduce((n, f) => n + runnableBlocks(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    const blocks = runnableBlocks(readFileSync(file, "utf8"));
    blocks.forEach((src, i) => {
      it(`${file} block ${i + 1} parses and validates`, () => {
        const model = normalize(parse(src)); // throws ParseError on bad syntax
        const diags = validate(model, layout(model), computeRefs(model))
          // A shape fragment may use a literal `from "..."` placeholder for the source event.
          .filter((d) => !d.message.includes('"..."'));
        expect(diags.map((d) => `${d.severity}: ${d.message}`)).toEqual([]);
      });
    });
  }
});
