// SPDX-License-Identifier: MIT
// The storyline map (owner rulings 2026-11-03; an `updates from` source, once that clause lands, crosses like any other): storylines as nodes, `after` and cross-storyline
// reads as edges, and the draggable canvas page `em render --map` writes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "../src/pipeline.js";
import { storylineMap } from "../src/model/storylineMap.js";
import { buildStorylineMapHtml } from "../src/render/storylineMap.js";
import { buildStorylineDiagram } from "../src/render/storylineDiagram.js";
import { layoutDot, composeSvg } from "../src/render/render.js";
import { buildExport } from "../src/emit/json.js";

const SRC = `
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
storyline "Chase" after "Borrow" {
  slice "Overdue Loans To Notify" {
    view Overdue Loans To Notify from "Tool Checked Out", "Tool Returned" { loanId: LoanId }
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
storyline "Audit" {
  slice "Audit Log" {
    view Audit Log from "Tool Returned", "Overdue Notice Sent" { loanId: LoanId }
    ui Audit @Neighbor
  }
}
`;

describe("storylineMap()", () => {
  it("nodes are the storylines in document order; edges are `after` first, then reads grouped per story pair with the crossing source elements", () => {
    const { model, diagnostics } = compile(SRC);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const map = storylineMap(model);
    expect(map.nodes.map((n) => [n.name, n.slug, n.after])).toEqual([
      ["Borrow", "borrow", null],
      ["Chase", "chase", "Borrow"],
      ["Audit", "audit", null],
    ]);
    const name = (id: string) => model.byId.get(id)!.name;
    expect(map.edges.map((e) => [e.from, e.to, e.kind, e.elementIds.map(name)])).toEqual([
      ["Borrow", "Chase", "after", []],
      ["Borrow", "Audit", "reads", ["Tool Returned"]],
      ["Borrow", "Chase", "reads", ["Tool Checked Out", "Tool Returned"]],
      ["Chase", "Audit", "reads", ["Overdue Notice Sent"]],
    ]);
  });

  it("is empty for a model without storylines", () => {
    const { model } = compile(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\n`);
    expect(storylineMap(model)).toEqual({ nodes: [], edges: [] });
  });

  it("em export carries the edges as `model.storylineEdges` with element refs (schema 1.20)", () => {
    const { model, refs, diagnostics } = compile(SRC);
    const doc = JSON.parse(buildExport(model, refs, diagnostics, SRC, "model.em").text);
    expect(doc.model.storylineEdges[0]).toEqual({ from: "Borrow", to: "Chase", kind: "after", elements: [] });
    expect(doc.model.storylineEdges[1]).toEqual({
      from: "Borrow",
      to: "Audit",
      kind: "reads",
      elements: [{ name: "Tool Returned", ref: "return-tool/event.tool-returned" }],
    });
  });

  it("the example storylines model maps to its one `after` edge", () => {
    const { model } = compile(readFileSync("examples/storylines.em", "utf8"));
    const map = storylineMap(model);
    expect(map.nodes.map((n) => n.name)).toEqual(["Bring a product to market", "Extend an attribute", "Retire a product"]);
    expect(map.edges).toEqual([{ from: "Bring a product to market", to: "Retire a product", kind: "after", elementIds: [] }]);
  });
});

describe("buildStorylineMapHtml()", () => {
  it("is one self-contained page: a frame per storyline holding its own diagram, the map as JSON, no external assets", async () => {
    const { model } = compile(SRC);
    const frames = [];
    for (const st of model.storylines!) {
      const sub = buildStorylineDiagram(model, st);
      const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, ".", ".");
      frames.push({ name: st.name, slug: st.name.toLowerCase(), sliceCount: st.sliceIndexes.length, svg });
    }
    const html = buildStorylineMapHtml(model, frames, storylineMap(model));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Shed — storylines</title>");
    expect((html.match(/class="frame"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-name="Chase"');
    expect(html).toContain('href="./chase.svg"');
    expect((html.match(/<svg\b/g) ?? []).length).toBeGreaterThanOrEqual(4); // 3 diagrams + the links overlay
    const data = JSON.parse(/<script id="map-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(data.model).toBe("Shed");
    expect(data.edges).toContainEqual({ from: "Borrow", to: "Chase", kind: "after", labels: [] });
    expect(data.edges).toContainEqual({ from: "Chase", to: "Audit", kind: "reads", labels: ["Overdue Notice Sent"] });
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });
});
