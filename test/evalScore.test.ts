// GH #296: the eval protocol's smoke test (eval/README.md). Runs eval/score.mjs over the public
// input set: each reference model, scored against its own reference.json, must give an
// slice ratio of 1.0 (slices per reaction equal to the reference's), full business-event recall and an entity-clustered rate of 0;
// and a deliberately over-decomposed / entity-clustered model must move both numbers.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs script, no type declarations
import { score, entityClustered } from "../eval/score.mjs";
import { compile } from "../src/pipeline.js";
import { buildExport } from "../src/emit/json.js";
import { hasErrors } from "../src/model/validate.js";

const INPUTS = join(__dirname, "..", "eval", "inputs");

function exportOf(path: string, source: string) {
  const { model, refs, diagnostics } = compile(source);
  expect(hasErrors(diagnostics)).toBe(false);
  return JSON.parse(buildExport(model, refs, diagnostics, source, path).text);
}

/** Whether main's own `timeline-entity-clustered` lint fires on this source. */
function lintFires(source: string) {
  return compile(source).diagnostics.some((d) => d.code === "timeline-entity-clustered");
}

const names = readdirSync(INPUTS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe("eval/score.mjs on the public input set", () => {
  it("covers Meridian Goods, two PRDs and one API-spec input", () => {
    expect(names.sort()).toEqual(["inventory-api", "library-lending", "meridian-goods", "support-desk"]);
  });

  for (const name of names) {
    it(`${name}: reference scored against itself gives slice ratio 1.0, 0 entity-clustered`, () => {
      const emPath = join(INPUTS, name, "reference.em");
      const reference = JSON.parse(readFileSync(join(INPUTS, name, "reference.json"), "utf8"));
      const result = score(exportOf(emPath, readFileSync(emPath, "utf8")), reference);
      expect(result.sliceRatio).toBe(1);
      expect(result.slicesPerReaction).toBe(result.referenceSlicesPerReaction);
      expect(result.aliasesUsed).toBe(0);
      expect(result.businessEventRecall).toBe(1);
      expect(result.entityClusteredRate).toBe(0);
      expect(result.extraSlices).toEqual([]);
      expect(result.missingSlices).toEqual([]);
    });
  }

  it("support-desk reference holds a genuine 3-slice same-context run that is not clustered (cross-context read)", () => {
    const emPath = join(INPUTS, "support-desk", "reference.em");
    const exported = exportOf(emPath, readFileSync(emPath, "utf8"));
    const patterns = exported.model.slices.map((s: { pattern: string }) => s.pattern);
    expect(patterns.join(",")).toContain("state-change,state-change,state-change,state-view");
    expect(entityClustered(exported.model.slices).rate).toBe(0);
  });

  it("aliases reconcile a renamed slice and are counted", () => {
    const emPath = join(INPUTS, "support-desk", "reference.em");
    const reference = JSON.parse(readFileSync(join(INPUTS, "support-desk", "reference.json"), "utf8"));
    const source = readFileSync(emPath, "utf8").replace(/Merge Ticket/g, "Combine Ticket");
    const exported = exportOf(emPath, source);
    const plain = score(exported, reference);
    expect(plain.missingSlices).toEqual(["merge-ticket"]);
    expect(plain.extraSlices).toEqual(["combine-ticket"]);
    const aliased = score(exported, reference, { "combine-ticket": "merge-ticket" });
    expect(aliased.missingSlices).toEqual([]);
    expect(aliased.extraSlices).toEqual([]);
    expect(aliased.aliasesUsed).toBe(1);
    expect(aliased.slicesPerReaction).toBe(aliased.referenceSlicesPerReaction);
  });

  it("aliases never lower slices per reaction; many-to-one and onto-existing aliases are rejected", () => {
    const emPath = join(INPUTS, "support-desk", "reference.em");
    const reference = JSON.parse(readFileSync(join(INPUTS, "support-desk", "reference.json"), "utf8"));
    const exported = exportOf(emPath, readFileSync(emPath, "utf8"));
    // reopen -> resolve is onto a key the model already has: rejected, never silently merged
    expect(() => score(exported, reference, { "reopen-ticket": "resolve-ticket" })).toThrow(/already has/);
    const renamed = exportOf(emPath, readFileSync(emPath, "utf8").replace(/Reopen Ticket/g, "Reactivate Ticket"));
    const rename = score(renamed, reference, { "reactivate-ticket": "reopen-ticket" });
    expect(rename.slicesPerReaction).toBe(rename.referenceSlicesPerReaction);
    expect(rename.slicesPerReaction).toBe(10 / 5);
    expect(() =>
      score(renamed, reference, { "reactivate-ticket": "reopen-ticket", "merge-ticket": "reopen-ticket" }),
    ).toThrow(/many-to-one/);
  });

  it("flags an entity-clustered, over-decomposed model", () => {
    const path = join(INPUTS, "library-lending", "reference.em");
    const reference = JSON.parse(readFileSync(join(INPUTS, "library-lending", "reference.json"), "utf8"));
    const clustered = `model "Clustered"
persona Member
context Lending
context Billing

slice "Open Account" {
  ui Account Form @Member
  command Open Account { accountId: UUID }
  event Account Opened @Billing { accountId: UUID }
}
slice "Add Title" {
  ui Title Form @Member
  command Add Title { titleId: UUID }
  event Title Added @Lending { titleId: UUID }
}
slice "Rename Title" {
  ui Title Form @Member
  command Rename Title { titleId: UUID }
  event Title Renamed @Lending { titleId: UUID }
}
slice "Retire Title" {
  ui Title Form @Member
  command Retire Title { titleId: UUID }
  event Title Retired @Lending { titleId: UUID }
}
slice "Titles" {
  view Titles from "Title Added", "Title Renamed", "Title Retired" { titleId: UUID }
  ui Titles Page @Member
}
`;
    const exported = exportOf(path, clustered);
    expect(entityClustered(exported.model.slices).clustered).toBe(3);
    const result = score(exported, reference);
    expect(result.entityClusteredRate).toBe(0.75);
    expect(lintFires(clustered)).toBe(true);
    expect(result.businessEventRecall).toBeLessThan(1);
    expect(result.missingSlices.length).toBeGreaterThan(0);
  });

  it("a single-context model is exempt (score 0), like the lint", () => {
    const single = `model "Single"
persona Member
context Lending

slice "Add Title" {
  ui Title Form @Member
  command Add Title { titleId: UUID }
  event Title Added @Lending { titleId: UUID }
}
slice "Rename Title" {
  ui Title Form @Member
  command Rename Title { titleId: UUID }
  event Title Renamed @Lending { titleId: UUID }
}
slice "Retire Title" {
  ui Title Form @Member
  command Retire Title { titleId: UUID }
  event Title Retired @Lending { titleId: UUID }
}
slice "Titles" {
  view Titles from "Title Added", "Title Renamed", "Title Retired" { titleId: UUID }
  ui Titles Page @Member
}
`;
    const exported = exportOf("single.em", single);
    expect(entityClustered(exported.model.slices).rate).toBe(0);
    expect(lintFires(single)).toBe(false);
  });

  for (const name of names) {
    it(`${name}: score.mjs and the lint agree on whether the reference clusters`, () => {
      const emPath = join(INPUTS, name, "reference.em");
      const source = readFileSync(emPath, "utf8");
      expect(lintFires(source)).toBe(entityClustered(exportOf(emPath, source).model.slices).rate > 0);
    });
  }
});
