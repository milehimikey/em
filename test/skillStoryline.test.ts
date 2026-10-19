// SPDX-License-Identifier: MIT
// GH #276: the storyline-first / intent-first methodology rules. Skill behaviour is prose an agent
// follows, so the gate is that each rule's key phrase is present in the files that must carry it:
// the shared methodology reference (the rules and the reshaping checklist), the discover skill
// (storyboard from walkthroughs first; the extract path names the process before ordering events),
// the design skill (storyline review before completeness), docs/storyline.md, and docs/patterns.md
// (links the storyline doc from State Change and State View). The before/after pair in
// docs/storyline.md is also checked here (docs/ is outside skillExamples.test.ts): both must
// validate with no diagnostics, so the "CRUD" example stays a model that validates today.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";

const SKILLS = ".claude/skills";
const METHODOLOGY = join(SKILLS, "event-modeling-shared", "reference", "methodology.md");
const DISCOVER = join(SKILLS, "event-modeling-discover", "SKILL.md");
const EXTRACT = join(SKILLS, "event-modeling-discover", "reference", "extract.md");
const DESIGN = join(SKILLS, "event-modeling-design", "SKILL.md");
const STORYLINE_DOC = "docs/storyline.md";
const PATTERNS_DOC = "docs/patterns.md";

/** Collapse line wrapping and list indentation so a phrase matches however the prose is wrapped. */
function flat(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ");
}

describe("GH #276: methodology reference carries the storyline rules", () => {
  const text = flat(METHODOLOGY);
  const phrases = [
    "The story, not the schema",
    "main storyline",
    "secondary storyline",
    "CRUD laid on a timeline",
    "Build from walkthroughs first",
    "Commands name intent, not endpoints",
    "Intent test",
    "Question test",
    "A read model is one information need",
    "if `<field>` is set",
    "children belong in the parent's context",
    "Repeat the view after every command that changes it",
    "Outcomes are events of one slice",
    "Reshaping an existing model",
    "(em ruling)",
    "timeline-entity-clustered",
    "command-second-intent",
    "automation-split-by-outcome",
    "em validate --shape",
  ];
  for (const phrase of phrases) {
    it(`contains "${phrase}"`, () => {
      expect(text.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  it("cites the canon inline", () => {
    for (const quote of [
      "on a time line and with no branching",
      "as opposed to simply saving form data to a table",
      "Every Read Model answers a question. No question, no Read Model.",
      "Name by intent",
      "Linearize it!",
      "One decision. One event. One state change.",
    ]) {
      expect(text).toContain(quote);
    }
  });
});

describe("GH #276: discover skill starts from the story", () => {
  const skill = flat(DISCOVER);
  it("storyboards from walkthroughs / journeys first", () => {
    expect(skill).toContain("Start from the story, not the schema");
    expect(skill).toMatch(/walkthroughs/);
    expect(skill).toContain("main storyline");
    expect(skill).toContain("secondary storyline");
  });
  it("moves the OpenAPI/migrations reference after the storyboard", () => {
    expect(skill).toMatch(/comes \*\*after\*\* the storyboard/);
    expect(skill).toContain("only after the storyboard exists");
  });
  it("extract names the as-is process before ordering events", () => {
    const extract = flat(EXTRACT);
    expect(extract).toContain("name the as-is process(es)");
    expect(extract).toMatch(/comes \*\*after\*\*/);
  });
});

describe("GH #276: design skill reviews the storyline before completeness", () => {
  const skill = flat(DESIGN);
  it("has a storyline review ahead of the completeness step", () => {
    const review = skill.indexOf("Storyline review");
    const completeness = skill.indexOf("Evaluate completeness (step 7)");
    expect(review).toBeGreaterThan(-1);
    expect(completeness).toBeGreaterThan(review);
  });
  it("names the main and secondary storylines and the three tests", () => {
    expect(skill).toContain("main storyline");
    expect(skill).toContain("secondary storyline");
    expect(skill).toContain("intent test");
    expect(skill).toContain("question test");
    expect(skill).toContain("conditional-invariant signal");
    expect(skill).toContain("Reshaping an existing model");
  });
});

describe("GH #276: docs/storyline.md and docs/patterns.md", () => {
  it("storyline.md has the canon, the rules and the reshaping checklist", () => {
    const text = flat(STORYLINE_DOC);
    for (const phrase of ["## The canon", "## Reshaping an existing model", "(em ruling)", "CRUD shape", "[patterns.md](patterns.md#automation)"]) {
      expect(text).toContain(phrase);
    }
  });

  it("patterns.md links storyline.md from both State Change and State View", () => {
    const text = readFileSync(PATTERNS_DOC, "utf8");
    const change = text.slice(text.indexOf("## State Change"), text.indexOf("## State View"));
    const view = text.slice(text.indexOf("## State View"), text.indexOf("## Automation"));
    expect(change).toContain("(storyline.md");
    expect(view).toContain("(storyline.md");
  });

  it("the before/after pair both validate with no diagnostics", () => {
    const blocks = [...readFileSync(STORYLINE_DOC, "utf8").matchAll(/```em\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("CRUD shape");
    expect(blocks[1]).toContain("storyline shape");
    for (const block of blocks) {
      const model = normalize(parse(block));
      expect(validate(model, layout(model), computeRefs(model)).map((d) => d.code)).toEqual([]);
    }
  });
});
