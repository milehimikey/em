// SPDX-License-Identifier: MIT
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

  it("parses a `note` clause and keeps it out of the name", () => {
    const ast = parse(`
slice "S" {
  command Place Order note "notes/place-order.md"
  event Order Placed @Order note "notes/order-placed.md"
  ui Catalog note "notes/catalog.md" @Customer
}
`);
    const [cmd, evt, ui] = ast.slices[0].elements;
    expect(cmd).toMatchObject({ name: "Place Order", note: "notes/place-order.md" });
    expect(evt).toMatchObject({ name: "Order Placed", context: "Order", note: "notes/order-placed.md" });
    expect(ui).toMatchObject({ name: "Catalog", persona: "Customer", note: "notes/catalog.md" });
  });

  it("parses an `issue` clause and keeps it out of the name", () => {
    const ast = parse(`
slice "S" {
  command Place Order issue "who validates the discount code?"
  event Order Placed @Order issue "does this fire before or after payment?"
  ui Catalog issue "which persona sees pending items?" @Customer
}
`);
    const [cmd, evt, ui] = ast.slices[0].elements;
    expect(cmd).toMatchObject({
      name: "Place Order",
      issue: "who validates the discount code?",
    });
    expect(evt).toMatchObject({
      name: "Order Placed",
      context: "Order",
      issue: "does this fire before or after payment?",
    });
    expect(ui).toMatchObject({
      name: "Catalog",
      persona: "Customer",
      issue: "which persona sees pending items?",
    });
  });

  it("coexists `issue` with `note`, `from`, and a field block on the same element", () => {
    const ast = parse(`
slice "S" {
  view Open Orders note "notes/open.md" issue "should cancelled orders show here?" from "Order Placed" {
    orderId
    status
  }
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Open Orders",
      note: "notes/open.md",
      issue: "should cancelled orders show here?",
      from: ["Order Placed"],
      fields: [{ name: "orderId" }, { name: "status" }],
    });
  });

  it("strips `issue` before the `from` clause without swallowing it", () => {
    const ast = parse(`
slice "S" {
  view Open Orders issue "TBD: refunds?" from "Order Placed", "Order Updated"
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Open Orders",
      issue: "TBD: refunds?",
      from: ["Order Placed", "Order Updated"],
    });
  });

  it("leaves `issue` undefined when absent", () => {
    const ast = parse(`slice "S" {\n  command Do Thing\n}`);
    expect(ast.slices[0].elements[0].issue).toBeUndefined();
  });

  it("parses a `divergence` clause and keeps it out of the name", () => {
    const ast = parse(`
slice "S" {
  view Retired Things from "Thing Done" divergence "tracking token covers idempotency"
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Retired Things",
      divergence: "tracking token covers idempotency",
    });
  });

  it("coexists `divergence` with `note`, `issue`, `from`, and a field block on the same element", () => {
    const ast = parse(`
slice "S" {
  view Retired Things note "notes/retired.md" issue "still true post-migration?" divergence "known idiom" from "Thing Done" {
    productId
  }
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Retired Things",
      note: "notes/retired.md",
      issue: "still true post-migration?",
      divergence: "known idiom",
      from: ["Thing Done"],
      fields: [{ name: "productId" }],
    });
  });

  it("strips `divergence` before the `from` clause without swallowing it", () => {
    const ast = parse(`
slice "S" {
  view Retired Things divergence "known idiom" from "Thing Done", "Other Thing Done"
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Retired Things",
      divergence: "known idiom",
      from: ["Thing Done", "Other Thing Done"],
    });
  });

  it("leaves `divergence` undefined when absent", () => {
    const ast = parse(`slice "S" {\n  command Do Thing\n}`);
    expect(ast.slices[0].elements[0].divergence).toBeUndefined();
  });

  it("parses a `public` clause on an event and keeps it out of the name", () => {
    const ast = parse(`
slice "S" {
  event Order Placed @Order public
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      context: "Order",
      public: true,
    });
  });

  it("rejects `public` on a non-event kind", () => {
    expect(() => parse(`slice "S" {\n  command Do Thing public\n}`)).toThrow(
      /`public` is only valid on event/,
    );
    expect(() => parse(`slice "S" {\n  ui Catalog public @Customer\n}`)).toThrow(
      /`public` is only valid on event/,
    );
    expect(() => parse(`slice "S" {\n  view Open Orders public\n}`)).toThrow(
      /`public` is only valid on event/,
    );
  });

  it("coexists `public` with `note`, `issue`, and `@Context` on the same element", () => {
    const ast = parse(`
slice "S" {
  event Order Placed note "notes/order.md" issue "still open?" @Order public
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      note: "notes/order.md",
      issue: "still open?",
      context: "Order",
      public: true,
    });
  });

  it("also accepts `public` written before `@Context` instead of after", () => {
    const ast = parse(`
slice "S" {
  event Order Placed public @Order
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      context: "Order",
      public: true,
    });
  });

  it("leaves a bare `public` that isn't trailing (or right before `@Tag`) as part of the name", () => {
    const ast = parse(`slice "S" {\n  event Made Public Somehow\n}`);
    expect(ast.slices[0].elements[0].name).toBe("Made Public Somehow");
    expect(ast.slices[0].elements[0].public).toBeUndefined();
  });

  it("parses `public` trailing an inline `{ … }` field block", () => {
    const ast = parse(`slice "S" {\n  event Order Placed { orderId: UUID } public\n}`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      public: true,
      fields: [{ name: "orderId", type: "UUID" }],
    });
  });

  it("parses `public` trailing a multi-line `{ … }` field block's closing line", () => {
    const ast = parse(`
slice "S" {
  event Order Placed {
    orderId
  } public
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      public: true,
      fields: [{ name: "orderId" }],
    });
  });

  it("leaves `public` undefined when absent", () => {
    const ast = parse(`slice "S" {\n  event Order Placed\n}`);
    expect(ast.slices[0].elements[0].public).toBeUndefined();
  });

  describe("clause keywords inside element names (MIL-82)", () => {
    it("keeps a title-cased `From` in an event name and its @Context tag", () => {
      const ast = parse(`
slice "S" {
  event Widget Removed From Cabinet @Thing
}
`);
      const evt = ast.slices[0].elements[0];
      expect(evt.name).toBe("Widget Removed From Cabinet");
      expect(evt.context).toBe("Thing");
      expect(evt.from).toBeUndefined();
    });

    it("keeps a title-cased `From` in command and ui names", () => {
      const ast = parse(`
slice "S" {
  ui Notes From Support @Agent
  command Remove From Cart
}
`);
      const [ui, cmd] = ast.slices[0].elements;
      expect(ui).toMatchObject({ name: "Notes From Support", persona: "Agent" });
      expect(cmd.name).toBe("Remove From Cart");
    });

    it("keeps `From` in a view name while still parsing its real `from` clause", () => {
      const ast = parse(`
slice "S" {
  view Orders From Yesterday from "Order Placed"
}
`);
      expect(ast.slices[0].elements[0]).toMatchObject({
        name: "Orders From Yesterday",
        from: ["Order Placed"],
      });
    });

    it("skips a lowercase unquoted `from` in a name in favor of the quoted clause", () => {
      const ast = parse(`
slice "S" {
  view Requests from partners from "Request Submitted"
}
`);
      expect(ast.slices[0].elements[0]).toMatchObject({
        name: "Requests from partners",
        from: ["Request Submitted"],
      });
    });

    it("rejects a quoted `from` clause on kinds that don't take one", () => {
      expect(() =>
        parse(`
slice "S" {
  event Order Placed from "Somewhere"
}
`),
      ).toThrow(ParseError);
      expect(() =>
        parse(`
slice "S" {
  command Place Order from "Somewhere"
}
`),
      ).toThrow(/only valid on view or a reaction/);
    });

    it("keeps a title-cased `Public` in an event name (marker stays lowercase-only)", () => {
      const ast = parse(`
slice "S" {
  event Account Made Public @Account
}
`);
      const evt = ast.slices[0].elements[0];
      expect(evt.name).toBe("Account Made Public");
      expect(evt.public).toBeUndefined();
      expect(evt.context).toBe("Account");
    });

    it("keeps a title-cased `Again` in a view name (marker stays lowercase-only)", () => {
      const ast = parse(`
slice "S" {
  view Backlog Again
}
`);
      const view = ast.slices[0].elements[0];
      expect(view.name).toBe("Backlog Again");
      expect(view.again).toBeUndefined();
    });
  });

  it("strips `note` before the `from` clause without swallowing it", () => {
    const ast = parse(`
slice "S" {
  view Open Orders note "notes/open.md" from "Order Placed", "Order Updated"
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Open Orders",
      note: "notes/open.md",
      from: ["Order Placed", "Order Updated"],
    });
  });

  it("parses a multi-line `{ … }` field block with optional types", () => {
    const ast = parse(`
slice "S" {
  event Order Placed @Order {
    orderId
    total: Money
    items : List<LineItem>
  }
}
`);
    const el = ast.slices[0].elements[0];
    expect(el).toMatchObject({ name: "Order Placed", context: "Order" });
    expect(el.fields).toEqual([
      { name: "orderId" },
      { name: "total", type: "Money" },
      { name: "items", type: "List<LineItem>" },
    ]);
  });

  it("parses an inline `{ a, b: T }` field list", () => {
    const ast = parse(`slice "S" {\n  command Place Order { customerId, total: Money }\n}`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Place Order",
      fields: [{ name: "customerId" }, { name: "total", type: "Money" }],
    });
  });

  it("allows a field block alongside note/from clauses", () => {
    const ast = parse(`
slice "S" {
  view Open Orders note "notes/o.md" from "Order Placed" {
    orderId
    status
  }
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Open Orders",
      note: "notes/o.md",
      from: ["Order Placed"],
      fields: [{ name: "orderId" }, { name: "status" }],
    });
  });

  it("parses clauses trailing an inline `{ … }` field block (MIL-65, MIL-74)", () => {
    const ast = parse(`
slice "S" {
  event Order Placed { orderId: UUID } issue "tax handling?"
  command Place Order { customerId } note "notes/place-order.md"
  view Open Orders { orderId } from "Order Placed"
  ui Catalog { itemCount } @Customer
}
`);
    const [evt, cmd, view, ui] = ast.slices[0].elements;
    expect(evt).toMatchObject({
      name: "Order Placed",
      issue: "tax handling?",
      fields: [{ name: "orderId", type: "UUID" }],
    });
    expect(cmd).toMatchObject({
      name: "Place Order",
      note: "notes/place-order.md",
      fields: [{ name: "customerId" }],
    });
    expect(view).toMatchObject({
      name: "Open Orders",
      from: ["Order Placed"],
      fields: [{ name: "orderId" }],
    });
    expect(ui).toMatchObject({
      name: "Catalog",
      persona: "Customer",
      fields: [{ name: "itemCount" }],
    });
  });

  it("parses clauses trailing a multi-line `{ … }` field block's closing line", () => {
    const ast = parse(`
slice "S" {
  event Order Placed {
    orderId
  } issue "tax handling?"
}
`);
    expect(ast.slices[0].elements[0]).toMatchObject({
      name: "Order Placed",
      issue: "tax handling?",
      fields: [{ name: "orderId" }],
    });
  });

  it("parses `divergence` trailing a `{ … }` field block, inline or multi-line", () => {
    const inline = parse(`
slice "S" {
  view Retired Things { productId } divergence "known idiom"
}
`);
    expect(inline.slices[0].elements[0]).toMatchObject({
      name: "Retired Things",
      divergence: "known idiom",
      fields: [{ name: "productId" }],
    });

    const multiLine = parse(`
slice "S" {
  view Retired Things {
    productId
  } divergence "known idiom"
}
`);
    expect(multiLine.slices[0].elements[0]).toMatchObject({
      name: "Retired Things",
      divergence: "known idiom",
      fields: [{ name: "productId" }],
    });
  });

  it("rejects unrecognized trailing text after a `{ … }` field block instead of silently dropping it", () => {
    expect(() =>
      parse(`slice "S" {\n  command Place Order { customerId } bogus clause\n}`),
    ).toThrow(/unrecognized trailing text/);
  });

  it("rejects an unclosed field block", () => {
    expect(() => parse(`slice "S" {\n  event E {\n    a`)).toThrow(
      /field block .* missing a closing/,
    );
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

  describe("slice `source` clause (MIL-69)", () => {
    it("parses a `source` clause on the slice header and keeps it out of the name", () => {
      const ast = parse(`
slice "Checkout" source "https://linear.app/team/issue/MIL-60" {
  command Submit Order
}
`);
      expect(ast.slices[0]).toMatchObject({
        name: "Checkout",
        source: "https://linear.app/team/issue/MIL-60",
      });
    });

    it("leaves `source` undefined when absent", () => {
      const ast = parse(`slice "S" {\n  command Do Thing\n}`);
      expect(ast.slices[0].source).toBeUndefined();
    });

    it("does not false-match `source` appearing inside the slice name itself", () => {
      const ast = parse(`slice "Data Source" {\n  command Do Thing\n}`);
      expect(ast.slices[0].name).toBe("Data Source");
      expect(ast.slices[0].source).toBeUndefined();
    });

    it("parses `source` when it precedes the slice name", () => {
      const ast = parse(`slice source "https://linear.app/team/issue/MIL-61" "Checkout" {\n  command Submit Order\n}`);
      expect(ast.slices[0]).toMatchObject({
        name: "Checkout",
        source: "https://linear.app/team/issue/MIL-61",
      });
    });

    it("rejects a slice left with no name after `source` is stripped out", () => {
      expect(() => parse(`slice source "https://x" {\n  command Do Thing\n}`)).toThrow(
        /slice requires a name/,
      );
    });
  });

  describe("`type` declarations (MIL-64)", () => {
    it("parses a multi-line `type Name { … }` block", () => {
      const ast = parse(`
type QuoteAcceptedLine {
  lineId: UUID
  quantity: int
  discountIds: UUID[]
}
`);
      expect(ast.types).toHaveLength(1);
      expect(ast.types[0]).toMatchObject({
        name: "QuoteAcceptedLine",
        fields: [
          { name: "lineId", type: "UUID" },
          { name: "quantity", type: "int" },
          { name: "discountIds", type: "UUID[]" },
        ],
      });
    });

    it("parses an inline `type Name { a: T, b: U }` block", () => {
      const ast = parse(`type Money { amount: int, currency: String }`);
      expect(ast.types[0]).toMatchObject({
        name: "Money",
        fields: [
          { name: "amount", type: "int" },
          { name: "currency", type: "String" },
        ],
      });
    });

    it("parses a `type` block with no fields", () => {
      const ast = parse(`type Empty {}`);
      expect(ast.types[0]).toMatchObject({ name: "Empty", fields: [] });
    });

    it("rejects a `type` with no name", () => {
      expect(() => parse(`type { a: UUID }`)).toThrow(/type requires a name/);
    });

    it("rejects a `type` with no opening brace", () => {
      expect(() => parse(`type QuoteAcceptedLine`)).toThrow(
        /type must open a block with '\{'/,
      );
    });

    it("rejects an unclosed `type` block", () => {
      expect(() => parse(`type QuoteAcceptedLine {\n  lineId: UUID`)).toThrow(
        /type "QuoteAcceptedLine" is missing a closing/,
      );
    });

    it("rejects trailing text after an inline `type` block's closing brace", () => {
      expect(() => parse(`type Money { amount: int } bogus`)).toThrow(
        /unrecognized trailing text.*type declarations support no clauses/,
      );
    });

    it("rejects trailing text after a multi-line `type` block's closing brace", () => {
      expect(() =>
        parse(`type Money {\n  amount: int\n} bogus`),
      ).toThrow(/unrecognized trailing text.*type declarations support no clauses/);
    });

    it("rejects `type` used inside a slice", () => {
      expect(() =>
        parse(`slice "S" {\n  type Money { amount: int }\n}`),
      ).toThrow(/not valid inside a slice/);
    });

    it("preserves document order across multiple `type` declarations", () => {
      const ast = parse(`
type Money { amount: int }
type Address { line1: String }
`);
      expect(ast.types.map((t) => t.name)).toEqual(["Money", "Address"]);
    });

    it("lets a field elsewhere reference a declared type by name, bare or as an array", () => {
      const ast = parse(`
type QuoteAcceptedLine { lineId: UUID }
slice "S" {
  event Quote Accepted {
    lines: QuoteAcceptedLine[]
    winner: QuoteAcceptedLine
  }
}
`);
      expect(ast.slices[0].elements[0].fields).toEqual([
        { name: "lines", type: "QuoteAcceptedLine[]" },
        { name: "winner", type: "QuoteAcceptedLine" },
      ]);
    });
  });
});