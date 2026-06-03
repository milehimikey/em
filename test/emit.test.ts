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
    // semantic overlay must not perturb the grid
    expect(dot).toContain("constraint=false");
    expect(dot).toMatch(/digraph EventModel/);
  });

  it("draws the event->view data-flow arrow from a `from` clause", () => {
    const { dot, model } = compile(`
context Order
slice "A" {
  command Place Order
  event Order Placed @Order
}
slice "B" {
  view Open Orders from "Order Placed"
}
`);
    const placed = model.byName.get("order placed")![0].id;
    const view = model.byName.get("open orders")![0].id;
    expect(dot).toContain(`${placed} -> ${view}`);
  });

  it("wires automation: read model -> processor (own slice), processor -> command (next slice)", () => {
    const { dot, model } = compile(`
context P
slice "Trigger" {
  command Make It
  event Thing Happened @P
}
slice "Auto" {
  view Todo List from "Thing Happened"
  processor Worker
}
slice "Do" {
  command Do Work
  event Work Done @P
}
`);
    const todo = model.byName.get("todo list")![0].id;
    const worker = model.byName.get("worker")![0].id;
    const cmd = model.byName.get("do work")![0].id;
    expect(dot).toContain(`${todo} -> ${worker}`); // reads read model in its slice
    expect(dot).toContain(`${worker} -> ${cmd}`); // triggers command in the next slice
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
