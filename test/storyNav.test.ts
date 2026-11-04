// SPDX-License-Identifier: MIT
// Owner ruling 2026-11-03 ("slices easy to find"): every slice header cell in a rendered SVG links
// to its design doc and carries a readable tooltip.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { layoutDot, composeSvg } from "../src/render/render.js";
import { buildStorylineDiagram } from "../src/render/storylineDiagram.js";

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

describe("slice header links in the SVG", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-story-nav-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "check-out-tool.md"), "---\nstatus: implemented\n---\n# Slice: Check Out Tool\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("wraps a documented slice's header cell in a link to its doc and gives every header a readable tooltip", async () => {
    const { dot, model, grid } = compile(SRC);
    const svg = composeSvg(await layoutDot(dot), model, grid, dir, dir);
    expect(svg).toContain('<a xlink:href="slices/check-out-tool.md" href="slices/check-out-tool.md" class="em-slice-link">');
    expect(svg).toContain("<title>Check Out Tool — State Change · implemented</title>");
    expect(svg).toContain("<title>My Loans — State View · no doc yet</title>");
    expect(svg).not.toContain("<title>__hdr_");
    expect((svg.match(/class="em-slice-link"/g) ?? []).length).toBe(1);
  });

  it("relative to the output directory: a storyline render one directory deeper links up to slices/", async () => {
    const { model } = compile(SRC);
    const sub = buildStorylineDiagram(model, model.storylines![0]);
    const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, dir, join(dir, "storylines"));
    expect(svg).toContain('href="../slices/check-out-tool.md"');
  });
});
