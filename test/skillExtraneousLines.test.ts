// SPDX-License-Identifier: MIT
// GH #423: the skills stop generating extraneous lines. Skill behaviour is prose an agent follows,
// so the gate is that each rule's key phrase is present where it must be (the GH #276 shape):
// the methodology reference, the design skill's step 2, the extract rules, the slice template and
// the skills' DSL reference. The eval scorer's two new metrics are checked on a small model.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { buildExport } from "../src/emit/json.js";
// @ts-expect-error plain .mjs script, no type declarations
import { todoInboundLines, storylineReadsWithoutAfter } from "../eval/score.mjs";

const SKILLS = ".claude/skills";
const flat = (p: string) => readFileSync(p, "utf8").replace(/\s+/g, " ").toLowerCase();
const METHODOLOGY = flat(join(SKILLS, "event-modeling-shared", "reference", "methodology.md"));
const DESIGN = flat(join(SKILLS, "event-modeling-design", "SKILL.md"));
const EXTRACT = flat(join(SKILLS, "event-modeling-discover", "reference", "extract.md"));
const TEMPLATE = flat(join(SKILLS, "event-modeling-shared", "templates", "slice.md"));
const DSL = flat(join(SKILLS, "event-modeling-shared", "reference", "em-dsl.md"));
const DISCOVER = flat(join(SKILLS, "event-modeling-discover", "SKILL.md"));

describe("methodology: trigger / housekeeping, continuations, storylines as stories", () => {
  for (const phrase of [
    "split what is left into trigger and housekeeping",
    "updates from",
    "put work on the list",
    "which of these events is the reason this row appears",
    "kept current by",
    "a continuation names only what changed",
    "again-restates-sources",
    "storylines read as stories",
    "a storyline that reads another declares `after` it",
    "storyline-reads-without-after",
    "em render <root>.em --map",
    "never on the full timeline",
    "a storyline is the unit a reader consumes",
    "em storyline split",
  ]) {
    it(`contains "${phrase}"`, () => expect(METHODOLOGY).toContain(phrase.toLowerCase()));
  }
});

describe("design skill: step 1 splits, step 2 checks, the shape gate names both lints", () => {
  for (const phrase of [
    "em storyline split <root>.em",
    "declares `after` it",
    "trigger / housekeeping split",
    "updates from",
    "continuation check",
    "em render <root>.em --map",
    "again-restates-sources",
    "storyline-reads-without-after",
    "into the slice's own storyline folder",
  ]) {
    it(`contains "${phrase}"`, () => expect(DESIGN).toContain(phrase.toLowerCase()));
  }
  it("discover keeps the draft in one file and defers the split to design", () => {
    expect(DISCOVER).toContain("design phase splits it into one file per story");
  });
});

describe("extract rules, slice template and DSL reference", () => {
  it("extract writes housekeeping handlers as `updates from`, as-is", () => {
    expect(EXTRACT).toContain("housekeeping handlers are `updates from`");
  });
  it("the slice template says the built-from list holds trigger and housekeeping alike", () => {
    expect(TEMPLATE).toContain("trigger and housekeeping alike");
  });
  for (const phrase of ["updates from \"event\"", "storyline models (gh #421)", "em storyline split <root>.em", "--map", "its own slices only, nothing from outside it"]) {
    it(`DSL reference contains "${phrase}"`, () => expect(DSL).toContain(phrase.toLowerCase()));
  }
});

describe("eval scorer: the two extraneous-lines metrics", () => {
  const SRC = (todo: string, chaseAfter: string) => `
model "Shed"
persona Neighbor
context Loans
storyline "Borrow" {
  slice "Check Out Tool" {
    ui Checkout @Neighbor
    command Check Out Tool { loanId: LoanId }
    event Tool Checked Out @Loans { loanId: LoanId }
  }
  slice "Return Tool" {
    ui Return @Neighbor
    command Return Tool { loanId: LoanId }
    event Tool Returned @Loans { loanId: LoanId }
  }
}
storyline "Chase" ${chaseAfter} {
  slice "Overdue Loans To Notify" {
    ${todo}
  }
  slice "Send Overdue Notice" {
    processor Overdue Notifier from "Overdue Loans To Notify"
    command Send Overdue Notice { loanId: LoanId }
    event Overdue Notice Sent @Loans { loanId: LoanId }
  }
  slice "Notices" {
    view Sent Notices from "Overdue Notice Sent" { loanId: LoanId }
    ui Notices @Neighbor
  }
}
`;
  const exported = (src: string) => {
    const c = compile(src);
    return JSON.parse(buildExport(c.model, c.refs, c.diagnostics, src, "m.em").text);
  };
  it("counts drawn lines into to-do views (updates from not drawn) and cross-story reads without after", () => {
    const before = exported(SRC('view Overdue Loans To Notify from "Tool Checked Out", "Tool Returned" { loanId: LoanId }', ""));
    expect(todoInboundLines(before)).toMatchObject({ total: 2, todoViews: 1 });
    expect(storylineReadsWithoutAfter(before)).toMatchObject({ count: 1, pairs: ["Borrow -> Chase"] });
    const after = exported(SRC('view Overdue Loans To Notify from "Tool Checked Out" updates from "Tool Returned" { loanId: LoanId }', 'after "Borrow"'));
    expect(todoInboundLines(after)).toMatchObject({ total: 1, todoViews: 1 });
    expect(storylineReadsWithoutAfter(after)).toMatchObject({ count: 0 });
  });
});
