// SPDX-License-Identifier: MIT
// Owner ruling 2026-11-03 ("clear to understand"): the generated `em-slice-story` line in a
// slice doc and its adoption by `em slice sync`.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { buildSliceRegions, placeholderRegions, storyLine } from "../src/catalog/sliceSections.js";
import { adoptStoryRegion, syncDocText } from "../src/cli/sliceSync.js";

const SRC = `
model "Shed"
persona Neighbor
context Loans
storyline "Borrow and return a tool" {
  slice "Check Out Tool" {
    ui Checkout @Neighbor
    command Check Out Tool { loanId: LoanId }
    event Tool Checked Out @Loans { loanId: LoanId } note "slices/check-out-tool.md"
  }
  slice "My Loans" {
    view My Loans from "Tool Checked Out" { loanId: LoanId }
    ui Loans @Neighbor
  }
  slice "Return Tool" {
    ui Return @Neighbor
    command Return Tool { loanId: LoanId }
    event Tool Returned @Loans { loanId: LoanId }
    view My Loans again
  }
}
`;

describe("storyLine()", () => {
  it("places the slice in its storyline with prev/next doc links and its pattern", () => {
    const { model } = compile(SRC);
    expect(storyLine(model, 0)).toBe(
      "Step 1 of 3 in **Borrow and return a tool** · the story starts here · before [My Loans](./my-loans.md) · State Change",
    );
    expect(storyLine(model, 1)).toBe(
      "Step 2 of 3 in **Borrow and return a tool** · after [Check Out Tool](./check-out-tool.md) · before [Return Tool](./return-tool.md) · State View",
    );
    expect(storyLine(model, 2)).toBe(
      "Step 3 of 3 in **Borrow and return a tool** · after [My Loans](./my-loans.md) · the story ends here · State Change",
    );
  });

  it("counts the whole timeline for a model without storylines, and never counts a synthesized continuation column", () => {
    const { model } = compile(`
context Loans
slice "A" {
  command Do { x: Int }
  event Done @Loans { x: Int }
  view Work again
}
slice "Work" {
  view Work from "Done" { x: Int }
  ui W @P
}
`);
    // "A" synthesizes a continuation column for the inline `again`; it is not a step
    expect(storyLine(model, 0)).toMatch(/^Step 1 of 2 · the story starts here · before \[Work\]\(\.\/work\.md\) · /);
  });

  it("is the first region of buildSliceRegions and of the template placeholders", () => {
    const { model } = compile(SRC);
    const regions = buildSliceRegions(model, [1]);
    expect(regions[0]).toEqual({ name: "em-slice-story", kind: "story", body: [storyLine(model, 1)] });
    expect(placeholderRegions()[0].name).toBe("em-slice-story");
  });
});

describe("adoptStoryRegion()", () => {
  const DOC = (fm: string) => `---\nschemaVersion: 1\npattern: state-change\nswimlane: A → B\nstatus: draft\nversion: 1\n${fm}---\n# Slice: Check Out Tool\n\n![Diagram](./check-out-tool.svg)\n\n## Intent\nx\n`;

  it("inserts an empty story region right after the diagram line of an unsigned doc, even one with no regions yet", () => {
    const r = adoptStoryRegion(DOC(""));
    expect(r.inserted).toBe(true);
    expect(r.hadRegions).toBe(false);
    expect(r.text).toContain("![Diagram](./check-out-tool.svg)\n\n<!-- GENERATED:em-slice-story:start");
    expect(r.text).toContain("<!-- GENERATED:em-slice-story:end -->\n\n## Intent");
    // and sync then fills it
    const { model } = compile(SRC);
    const synced = syncDocText(r.text, buildSliceRegions(model, [0]).filter((x) => x.kind === "story"));
    expect(synced.status).toBe("stale");
    expect(synced.next).toContain("\nStep 1 of 3 in **Borrow and return a tool**");
  });

  it("never touches a signed doc (the marker lines are under the signature) or one that already has the region", () => {
    const signed = adoptStoryRegion(DOC("ratifiedHash: sha256:abc\n"));
    expect(signed.inserted).toBe(false);
    const twice = adoptStoryRegion(adoptStoryRegion(DOC("")).text);
    expect(twice.inserted).toBe(false);
  });
});
