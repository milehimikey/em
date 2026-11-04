// SPDX-License-Identifier: MIT
// GH #420: storyline-reads-without-after — a storyline that reads another declares `after` it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { RULES } from "../src/model/rules.js";

const CODE = "storyline-reads-without-after";
const codes = (src: string) => compile(src).diagnostics.filter((d) => d.code === CODE);

const SHED = (afterClause: string) => `
model "Shed"
persona Neighbor
context Loans
context Neighbors
storyline "Join the shed" {
  slice "Change Email" {
    ui Account @Neighbor
    command Change Email { neighborId: NeighborId, email: Text }
    event Neighbor Email Changed @Neighbors { neighborId: NeighborId, email: Text }
  }
  slice "My Account" {
    view My Account from "Neighbor Email Changed" { neighborId: NeighborId, email: Text }
    ui Account Screen @Neighbor
  }
}
storyline "Borrow and return a tool" {
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
  slice "My Loans" {
    view My Loans from "Tool Checked Out", "Tool Returned" { loanId: LoanId }
    ui Loans @Neighbor
  }
}
storyline "Chase an overdue loan" ${afterClause} {
  slice "Overdue Loans To Notify" {
    view Overdue Loans To Notify from "Tool Checked Out", "Tool Returned", "Neighbor Email Changed" { loanId: LoanId, email: Text }
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

describe(CODE, () => {
  it("fires once per (source, reader) storyline pair with no `after` chain, naming the crossing events, source refs first", () => {
    const found = codes(SHED(""));
    // one per (source, reader) pair, sorted by source then reader storyline name
    expect(found.map((d) => d.message.split(" but ")[0])).toEqual([
      'storyline "Chase an overdue loan" reads "Tool Checked Out", "Tool Returned" from storyline "Borrow and return a tool"',
      'storyline "Chase an overdue loan" reads "Neighbor Email Changed" from storyline "Join the shed"',
    ]);
    expect(found[0].severity).toBe("warning");
    expect(found[1].message).toContain('add `after "Join the shed"` to storyline "Chase an overdue loan"');
    expect(found[0].refs).toEqual([
      "check-out-tool/event.tool-checked-out",
      "return-tool/event.tool-returned",
      "overdue-loans-to-notify/view.overdue-loans-to-notify",
    ]);
  });

  it("is satisfied by a direct `after`, and by an `after` chain through a storyline in between", () => {
    const direct = codes(SHED('after "Borrow and return a tool"'));
    expect(direct.map((d) => d.message.split(" but ")[0])).toEqual([
      'storyline "Chase an overdue loan" reads "Neighbor Email Changed" from storyline "Join the shed"',
    ]);
    const chained = SHED('after "Borrow and return a tool"').replace('storyline "Borrow and return a tool" {', 'storyline "Borrow and return a tool" after "Join the shed" {');
    expect(codes(chained)).toEqual([]);
  });

  it("stays quiet for parallel storylines that read nothing from each other, and for a model without storylines", () => {
    const parallel = SHED("").replace(', "Neighbor Email Changed" { loanId: LoanId, email: Text }', ' { loanId: LoanId }');
    expect(codes(parallel).map((d) => d.message.split(" but ")[0])).toEqual([
      'storyline "Chase an overdue loan" reads "Tool Checked Out", "Tool Returned" from storyline "Borrow and return a tool"',
    ]);
    // the same slices with the storyline wrappers removed (storyline closers are the unindented `}`)
    const flat = SHED("").split("\n").filter((l) => !/^storyline /.test(l) && l !== "}").join("\n");
    expect(codes(flat)).toHaveLength(0);
  });

  it("is a shape-family warning registered like the other shape lints", () => {
    expect(RULES[CODE]).toMatchObject({ severity: "warning", family: "shape", docAnchor: "shape" });
  });

  it("raises nothing on the shipped examples", () => {
    const files = readdirSync("examples").filter((f) => f.endsWith(".em")).map((f) => join("examples", f));
    for (const f of files) expect(codes(readFileSync(f, "utf8")), f).toEqual([]);
  });
});
