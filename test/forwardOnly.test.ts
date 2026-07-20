// SPDX-License-Identifier: MIT
// The Two Laws of the Timeline: no event->event connections (multi-event slices fan from the
// command), and forward-only flow (evolving read models reappear via `view X again`).
import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { semanticEdges } from "../src/model/edges.js";
import { validate } from "../src/model/validate.js";
import { layout } from "../src/layout/grid.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model));
};
const edge = (es: { from: string; to: string }[], a: string, b: string) =>
  es.some((e) => e.from === a && e.to === b);

const MULTI_EVENT = `
context Order
context Inventory
slice "Checkout" {
  command Place Order
  event Order Placed @Order
  event Stock Reserved @Inventory
}
`;

describe("law 1: multi-event slices fan from the command, never event->event", () => {
  it("emits command->event for EVERY event in the slice", () => {
    const model = modelFrom(MULTI_EVENT);
    const es = semanticEdges(model);
    expect(edge(es, "place_order", "order_placed")).toBe(true);
    expect(edge(es, "place_order", "stock_reserved")).toBe(true);
  });

  it("emits no event->event edge", () => {
    const es = semanticEdges(modelFrom(MULTI_EVENT));
    expect(edge(es, "order_placed", "stock_reserved")).toBe(false);
    expect(edge(es, "stock_reserved", "order_placed")).toBe(false);
  });
});

describe("`view X again` instances", () => {
  const WITH_AGAIN = `
context Inventory
slice "Receive" {
  command Receive Stock
  event Stock Received @Inventory
}
slice "Catalog" {
  view Availability from "Stock Received"
}
slice "Reserve" {
  command Reserve Stock
  event Stock Reserved @Inventory
}
slice "Catalog Updated" {
  view Availability again from "Stock Reserved"
}
`;

  it("parses `again` on a view and links instances to one logical view", () => {
    const model = modelFrom(WITH_AGAIN);
    const instances = model.byName.get("availability")!;
    expect(instances).toHaveLength(2);
    expect(instances[0].logicalId).toBe(instances[0].id);
    expect(instances[1].logicalId).toBe(instances[0].id);
    expect(instances[1].again).toBe(true);
  });

  it("draws forward continuity between instances and binds each from-source locally", () => {
    const model = modelFrom(WITH_AGAIN);
    const es = semanticEdges(model);
    const [first, second] = model.byName.get("availability")!;
    expect(edge(es, first.id, second.id)).toBe(true); // instance continuity, forward
    expect(edge(es, "stock_reserved", second.id)).toBe(true); // instance-local from
    expect(edge(es, "stock_reserved", first.id)).toBe(false); // NOT the earlier instance
  });

  it("validates clean — no duplicate-name warning for instances", () => {
    expect(diagsFor(WITH_AGAIN)).toHaveLength(0);
  });

  it("rejects `again` on non-views at parse time", () => {
    expect(() => parse('slice "S" { command Do Thing again }')).toThrow(ParseError);
  });

  it("errors when `again` has no earlier declaration", () => {
    const diags = diagsFor(`
context C
slice "A" {
  command Do
  event Done @C
}
slice "B" {
  view Ledger again from "Done"
}
`);
    expect(diags.some((d) => d.severity === "error" && d.message.includes("no earlier declaration"))).toBe(true);
  });

  it("automation reads the NEAREST at-or-before instance", () => {
    const model = modelFrom(`
context C
slice "A" {
  command Do
  event Done @C
}
slice "V1" {
  view Todo from "Done"
}
slice "B" {
  command Do More
  event More Done @C
}
slice "V2" {
  view Todo again from "More Done"
}
slice "React" {
  processor Reactor from "Todo"
}
slice "Fire" {
  command Fire
  event Fired @C
}
`);
    const es = semanticEdges(model);
    const [v1, v2] = model.byName.get("todo")!;
    expect(edge(es, v2.id, "reactor")).toBe(true);
    expect(edge(es, v1.id, "reactor")).toBe(false);
  });
});

describe("law 2: forward-only validation errors", () => {
  it("errors when an event feeds an EARLIER view (backward from-edge)", () => {
    const diags = diagsFor(`
context C
slice "View First" {
  view Ledger from "Done"
}
slice "Then Event" {
  command Do
  event Done @C
}
`);
    expect(
      diags.some((d) => d.severity === "error" && d.message.includes("time flows left to right")),
    ).toBe(true);
  });

  it("errors when a processor reads a view that only exists later", () => {
    const diags = diagsFor(`
context C
slice "React" {
  processor Reactor from "Todo"
}
slice "Cmd" {
  command Do
  event Done @C
}
slice "V" {
  view Todo from "Done"
}
`);
    expect(
      diags.some(
        (d) => d.severity === "error" && d.message.includes("before any instance of it exists"),
      ),
    ).toBe(true);
  });

  it("errors on an explicit backward arrow", () => {
    const diags = diagsFor(`
context C
slice "A" {
  command First
  event First Done @C
}
slice "B" {
  command Second
  event Second Done @C
}
arrow Second -> First
`);
    expect(diags.some((d) => d.severity === "error" && d.message.includes("points backward"))).toBe(
      true,
    );
  });

  it("accepts a fully forward model", () => {
    expect(
      diagsFor(`
context C
slice "A" {
  command Do
  event Done @C
}
slice "V" {
  view Ledger from "Done"
}
`),
    ).toHaveLength(0);
  });
});
