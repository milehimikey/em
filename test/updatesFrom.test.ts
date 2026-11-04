// SPDX-License-Identifier: MIT
// `updates from` on views (POC, 2026-11-03): the sources that keep rows current or remove
// them. Folded into `from` for every consumer; distinguished only by the edge source
// "updates-from", which the renderer lists in the legend and never draws.
import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";
import { compile } from "../src/pipeline.js";
import { semanticEdges } from "../src/model/edges.js";
import { layoutDot, composeSvg } from "../src/render/render.js";
import { buildExport } from "../src/emit/json.js";

const SRC = `
model "Shed"
persona Neighbor
context Loans
slice "Check Out Tool" {
  ui Checkout @Neighbor
  command Check Out Tool { loanId: LoanId, dueDate: Date }
  event Tool Checked Out @Loans { loanId: LoanId, dueDate: Date }
}
slice "Extend Loan" {
  ui Extend @Neighbor
  command Extend Loan { loanId: LoanId, dueDate: Date }
  event Loan Extended @Loans { loanId: LoanId, dueDate: Date }
}
slice "Return Tool" {
  ui Return @Neighbor
  command Return Tool { loanId: LoanId }
  event Tool Returned @Loans { loanId: LoanId }
}
slice "Overdue Loans To Notify" {
  view Overdue Loans To Notify from "Tool Checked Out" updates from "Loan Extended", "Tool Returned" { loanId: LoanId, dueDate: Date }
}
slice "Send Overdue Notice" {
  processor Overdue Notifier from "Overdue Loans To Notify"
  command Send Overdue Notice { loanId: LoanId }
  event Overdue Notice Sent @Loans { loanId: LoanId }
}
slice "Overdue Loans To Notify — sent" {
  view Overdue Loans To Notify again from "Overdue Notice Sent"
  ui Notices @Neighbor
}
`;

describe("`updates from` (view only)", () => {
  it("parses into `updatesFrom` and folds the names into `from` after the `from` names, once each", () => {
    const ast = parse(SRC);
    const view = ast.slices.flatMap((s) => s.elements).find((e) => e.name === "Overdue Loans To Notify" && !e.again)!;
    expect(view.updatesFrom).toEqual(["Loan Extended", "Tool Returned"]);
    expect(view.from).toEqual(["Tool Checked Out", "Loan Extended", "Tool Returned"]);
  });

  it("accepts the clause before `from`, and trailing an inline fields block, without repeating a name", () => {
    const ast = parse(`
context Loans
slice "A" {
  command Do { x: Int }
  event Done @Loans { x: Int }
}
slice "B" {
  command Redo { x: Int }
  event Redone @Loans { x: Int }
}
slice "V" {
  view Work updates from "Redone" from "Done" { x: Int } updates from "Redone", "Done"
}
`);
    const view = ast.slices[2].elements[0];
    expect(view.from).toEqual(["Done", "Redone"]);
    expect(view.updatesFrom).toEqual(["Redone", "Done"]);
  });

  it("is a parse error on anything but a view", () => {
    expect(() =>
      parse(`
context Loans
slice "S" {
  processor P updates from "X"
}
`),
    ).toThrow(ParseError);
    expect(() =>
      parse(`
context Loans
slice "S" {
  processor P updates from "X"
}
`),
    ).toThrow(/`updates from` is only valid on view/);
  });

  it("keeps every source for validation: the model is clean and `Loan Extended`/`Tool Returned` are read", () => {
    const { diagnostics } = compile(SRC);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(diagnostics.filter((d) => /unread|no reader/i.test(d.message))).toEqual([]);
  });

  it("emits the resolved edges with source \"updates-from\", keeping the trigger's edge as \"from\"", () => {
    const { model } = compile(SRC);
    const es = semanticEdges(model);
    const view = model.byName.get("overdue loans to notify")![0].id;
    const id = (name: string) => model.byName.get(name)![0].id;
    expect(es.find((e) => e.from === id("tool checked out") && e.to === view)?.source).toBe("from");
    expect(es.find((e) => e.from === id("loan extended") && e.to === view)?.source).toBe("updates-from");
    expect(es.find((e) => e.from === id("tool returned") && e.to === view)?.source).toBe("updates-from");
  });

  it("never draws an `updates-from` edge; the legend lists the view under \"Kept current by\"", async () => {
    const { dot, model, grid } = compile(SRC);
    const svg = composeSvg(await layoutDot(dot), model, grid, ".", ".");
    expect(svg).toContain("Kept current by");
    expect(svg).toContain("Overdue Loans To Notify");
    expect(svg).toContain("— Loan Extended, Tool Returned");
    const all = semanticEdges(model);
    const hidden = all.filter((e) => e.source === "updates-from");
    expect(hidden).toHaveLength(2);
    const edgesGroup = /<g class="em-edges">([\s\S]*?)<\/g>/.exec(svg)![1];
    const drawn = (edgesGroup.match(/<path\b/g) ?? []).length;
    expect(drawn).toBe(all.length - hidden.length);
  });

  it("exports `updatesFrom` beside the full `from` list, and the edge source, at schema 1.20", () => {
    const { model, refs, diagnostics } = compile(SRC);
    const doc = JSON.parse(buildExport(model, refs, diagnostics, SRC, "model.em").text);
    expect(doc.schemaVersion).toBe("1.20");
    const view = doc.model.slices.flatMap((s: { elements: { name: string; again: boolean; from: { name: string }[]; updatesFrom: { name: string; ref: string | null }[] | null }[] }) => s.elements)
      .find((e: { name: string; again: boolean }) => e.name === "Overdue Loans To Notify" && !e.again);
    expect(view.from.map((f: { name: string }) => f.name)).toEqual(["Tool Checked Out", "Loan Extended", "Tool Returned"]);
    expect(view.updatesFrom.map((f: { name: string; ref: string | null }) => [f.name, f.ref])).toEqual([
      ["Loan Extended", "extend-loan/event.loan-extended"],
      ["Tool Returned", "return-tool/event.tool-returned"],
    ]);
    expect(doc.model.edges.filter((e: { source: string }) => e.source === "updates-from")).toHaveLength(2);
  });
});
