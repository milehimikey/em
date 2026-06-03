import { describe, it, expect } from "vitest";
import { parse, ParseError } from "../src/parser/parser.js";

describe("parser", () => {
  it("parses model, personas, contexts, slices and elements", () => {
    const ast = parse(`
model "Demo"
persona Customer
context Order

slice "Place Order" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}
`);
    expect(ast.name).toBe("Demo");
    expect(ast.personas).toEqual(["Customer"]);
    expect(ast.contexts).toEqual(["Order"]);
    expect(ast.slices).toHaveLength(1);
    const els = ast.slices[0].elements;
    expect(els.map((e) => e.kind)).toEqual(["ui", "command", "event"]);
    expect(els[0]).toMatchObject({ name: "Product Catalog", persona: "Customer" });
    expect(els[2]).toMatchObject({ name: "Order Placed", context: "Order" });
  });

  it("parses a view `from` clause with multiple quoted events", () => {
    const ast = parse(`
slice "S" {
  view Open Orders from "Order Placed", "Order Updated"
}
`);
    expect(ast.slices[0].elements[0].from).toEqual([
      "Order Placed",
      "Order Updated",
    ]);
    expect(ast.slices[0].elements[0].name).toBe("Open Orders");
  });

  it("ignores comments and blank lines", () => {
    const ast = parse(`
# a comment
model "C"   # trailing comment

slice "X" { # open
  command Do Thing
}
`);
    expect(ast.name).toBe("C");
    expect(ast.slices[0].elements[0].name).toBe("Do Thing");
  });

  it("parses explicit arrows", () => {
    const ast = parse(`arrow Open Orders -> Product Catalog`);
    expect(ast.arrows[0]).toMatchObject({
      from: "Open Orders",
      to: "Product Catalog",
    });
  });

  it("rejects an unclosed slice", () => {
    expect(() => parse(`slice "X" {\n  command A`)).toThrow(ParseError);
  });

  it("rejects an @tag on a command", () => {
    expect(() => parse(`slice "X" {\n  command Do @Nope\n}`)).toThrow(ParseError);
  });
});
