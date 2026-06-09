import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { STARTER_EM } from "../src/templates.js";

describe("dot emitter", () => {
  it("emits the strict-grid scaffolding", () => {
    const { dot } = compile(STARTER_EM);
    // rigid grid uses heavily weighted invisible column chains
    expect(dot).toContain("weight=1000");
    expect(dot).toContain("style=invis");
    // each row is locked to one rank
    expect(dot).toContain("rank=same");
    expect(dot).toMatch(/digraph EventModel/);
  });

  it("emits no semantic arrows (the renderer draws them over the grid)", () => {
    const { dot } = compile(`
context Order
slice "A" {
  ui Catalog @Customer
  command Place Order
  event Order Placed @Order
}
`);
    // structural chains use `->` but are invisible/uncoloured; a semantic arrow
    // would be a coloured edge (`a -> b [color=…]`), which must not appear.
    expect(dot).not.toMatch(/->[^\n;]*\[color=/);
  });

  it("warns when an automation slice also contains the triggered command", () => {
    const { diagnostics } = compile(`
slice "Auto" {
  processor Worker
  command Do Work
}
`);
    expect(
      diagnostics.some((d) => /put the triggered command in the next slice/.test(d.message)),
    ).toBe(true);
  });
});

describe("validation", () => {
  it("warns on a command with no event", () => {
    const { diagnostics } = compile(`slice "S" {\n  command Lonely Command\n}`);
    expect(diagnostics.some((d) => /produces no event/.test(d.message))).toBe(
      true,
    );
  });

  it("errors on a view referencing an unknown event", () => {
    const { diagnostics } = compile(
      `slice "S" {\n  view V from "Nope Never Happened"\n}`,
    );
    expect(
      diagnostics.some(
        (d) => d.severity === "error" && /unknown event/.test(d.message),
      ),
    ).toBe(true);
  });

  it("errors on an arrow to a missing element", () => {
    const { diagnostics } = compile(
      `slice "S" {\n  command A\n  event B\n}\narrow A -> Ghost`,
    );
    expect(
      diagnostics.some((d) => d.severity === "error" && /arrow target/.test(d.message)),
    ).toBe(true);
  });

  it("passes the starter model with no errors", () => {
    const { diagnostics } = compile(STARTER_EM);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
  });
});
