// SPDX-License-Identifier: MIT
// GH #424: again-restates-sources — a continuation names only what changed since the previous instance.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { RULES } from "../src/model/rules.js";

const CODE = "again-restates-sources";
const codes = (src: string) => compile(src).diagnostics.filter((d) => d.code === CODE);

const MODEL = (againFrom: string) => `
model "Shed"
persona Neighbor
context Loans
slice "Check Out Tool" {
  ui Checkout @Neighbor
  command Check Out Tool { loanId: LoanId }
  event Tool Checked Out @Loans { loanId: LoanId }
}
slice "My Loans" {
  view My Loans from "Tool Checked Out" { loanId: LoanId }
  ui Loans @Neighbor
}
slice "Return Tool" {
  ui Return @Neighbor
  command Return Tool { loanId: LoanId }
  event Tool Returned @Loans { loanId: LoanId }
}
slice "My Loans — returned" {
  view My Loans again from ${againFrom}
  ui Loans Again @Neighbor
}
`;

describe(CODE, () => {
  it("fires when a continuation restates an event the previous instance read and nothing recorded again in between", () => {
    const found = codes(MODEL('"Tool Checked Out", "Tool Returned"'));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain('view "My Loans" again (slice 4) restates "Tool Checked Out"');
    expect(found[0].message).toContain("already read by its instance in slice 2");
    expect(found[0].refs).toEqual([
      "my-loans-returned/view.my-loans",
      "my-loans/view.my-loans",
      "check-out-tool/event.tool-checked-out",
    ]);
  });

  it("stays quiet when the continuation names only what changed", () => {
    expect(codes(MODEL('"Tool Returned"'))).toEqual([]);
  });

  it("stays quiet when the restated event is genuinely recorded again between the two instances", () => {
    const again = MODEL('"Tool Checked Out", "Tool Returned"').replace(
      'slice "Return Tool" {',
      'slice "Check Out Another Tool" {\n  ui Checkout Again @Neighbor\n  command Check Out Tool { loanId: LoanId }\n  event Tool Checked Out @Loans { loanId: LoanId }\n}\nslice "Return Tool" {',
    );
    expect(codes(again)).toEqual([]);
  });

  it("is a shape-family warning registered like the other shape lints", () => {
    expect(RULES[CODE]).toMatchObject({ severity: "warning", family: "shape", docAnchor: "shape" });
  });

  it("raises nothing on the shipped examples", () => {
    const files = readdirSync("examples").filter((f) => f.endsWith(".em")).map((f) => join("examples", f));
    for (const f of files) expect(codes(readFileSync(f, "utf8")), f).toEqual([]);
  });
});
