// SPDX-License-Identifier: MIT
// Gate 2 (MIL-92): the skill's mechanical reference sections (CLI/flag tables, validate-rules
// code appendix) are generated from the real commander program and the rule registry
// (scripts/generate-skill-docs.ts) — this test is the CI enforcement that the committed skill
// docs actually match what generation produces right now, so `npm test` alone catches drift
// the same way it already catches a stale ```em example (test/skillExamples.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { program } from "../src/cli.js";
import { RULES } from "../src/model/rules.js";
import {
  buildCliReferenceFull,
  buildCliReferenceQuick,
  buildRuleReferenceAppendix,
  applyMarker,
  EM_DSL_MD,
  SKILL_MD,
} from "../scripts/generate-skill-docs.js";

describe("skill docs match generation (gate 2 — MIL-92)", () => {
  it("reference/em-dsl.md's CLI + validate-rules sections are up to date", () => {
    const original = readFileSync(EM_DSL_MD, "utf8");
    let regenerated = applyMarker(original, "cli", buildCliReferenceFull(program));
    regenerated = applyMarker(regenerated, "validate-rules", buildRuleReferenceAppendix(RULES));
    expect(regenerated).toBe(original);
  });

  it("SKILL.md's quick CLI reference is up to date", () => {
    const original = readFileSync(SKILL_MD, "utf8");
    const regenerated = applyMarker(original, "cli-quick", buildCliReferenceQuick(program));
    expect(regenerated).toBe(original);
  });

  it("finds the markers it expects (guards against a silently empty check)", () => {
    // If a marker is renamed/removed, applyMarker() throws rather than silently no-op'ing —
    // exercised implicitly above, but assert the files actually contain them too, so a broken
    // check here reads as "marker missing" rather than a confusing generic diff failure.
    const emDsl = readFileSync(join(".claude/skills/event-modeling/reference/em-dsl.md"), "utf8");
    const skillMd = readFileSync(join(".claude/skills/event-modeling/SKILL.md"), "utf8");
    expect(emDsl).toContain("<!-- GENERATED:cli:start");
    expect(emDsl).toContain("<!-- GENERATED:validate-rules:start");
    expect(skillMd).toContain("<!-- GENERATED:cli-quick:start");
  });
});
