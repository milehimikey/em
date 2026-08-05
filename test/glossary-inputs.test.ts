// SPDX-License-Identifier: MIT
// Coverage for `em glossary`'s input handling (src/cli/glossary-inputs.ts):
// the -o-requires-json validation, matching the repo's convention of testing
// this logic at the module level (see test/diff-inputs.test.ts).
import { describe, it, expect } from "vitest";
import { planGlossaryArgs } from "../src/cli/glossary-inputs.js";

describe("planGlossaryArgs", () => {
  it("allows no flags at all", () => {
    expect(planGlossaryArgs({})).toEqual({ ok: true });
  });

  it("allows --json alone", () => {
    expect(planGlossaryArgs({ json: true })).toEqual({ ok: true });
  });

  it("allows --json with -o", () => {
    expect(planGlossaryArgs({ json: true, out: "glossary.json" })).toEqual({ ok: true });
  });

  it("rejects -o without --json", () => {
    const plan = planGlossaryArgs({ out: "glossary.json" });
    expect(plan).toEqual({
      error: "em glossary: -o requires --json (there's no file to write from the text report)",
    });
  });
});
