// SPDX-License-Identifier: MIT
// Coverage for the `issue "text"` red-note warning. (No dedicated validate.test.ts
// existed before this feature — other validate.ts rules are covered inline where
// they were introduced, e.g. test/forwardOnly.test.ts for the timeline laws.)
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { layout } from "../src/layout/grid.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model));
};

describe("open `issue` warning", () => {
  it("emits a warning per element with an issue, at the element's line", () => {
    const diags = diagsFor(`
slice "S" {
  command Place Order issue "who validates the discount code?"
}
`);
    const issueDiags = diags.filter((d) => d.message.startsWith("open issue on"));
    expect(issueDiags).toHaveLength(1);
    expect(issueDiags[0]).toMatchObject({
      severity: "warning",
      message: 'open issue on "Place Order": who validates the discount code?',
      line: 3,
    });
  });

  it("emits one warning per issue when multiple elements carry one", () => {
    const diags = diagsFor(`
slice "S" {
  command Place Order issue "q1"
  event Order Placed @Order issue "q2"
}
`);
    const issueDiags = diags.filter((d) => d.message.startsWith("open issue on"));
    expect(issueDiags).toHaveLength(2);
    expect(issueDiags.map((d) => d.message)).toEqual([
      'open issue on "Place Order": q1',
      'open issue on "Order Placed": q2',
    ]);
  });

  it("emits no issue warning when no element has one", () => {
    const diags = diagsFor(`
slice "S" {
  command Place Order
  event Order Placed @Order
}
`);
    expect(diags.some((d) => d.message.startsWith("open issue on"))).toBe(false);
  });

  it("never blocks — issue diagnostics are warnings, not errors", () => {
    const diags = diagsFor(`slice "S" {\n  command Do Thing issue "unresolved"\n}`);
    expect(diags.every((d) => d.severity !== "error")).toBe(true);
  });

  it("normalize() copies `issue` from the AST onto the model element", () => {
    const model = modelFrom(`slice "S" {\n  event E issue "what triggers this?"\n}`);
    const el = model.byName.get("e")![0];
    expect(el.issue).toBe("what triggers this?");
  });

  it("leaves `issue` undefined on elements without one", () => {
    const model = modelFrom(`slice "S" {\n  event E\n}`);
    const el = model.byName.get("e")![0];
    expect(el.issue).toBeUndefined();
  });
});

describe("fields-completeness warnings", () => {
  const gapDiags = (src: string) =>
    diagsFor(src).filter(
      (d) => d.message.includes("has no source in") || d.message.includes("not provided by command"),
    );

  it("view field with a matching source event field: no warning", () => {
    const src = `
slice "S" {
  command Place Order { orderId, total: Money }
  event Order Placed { orderId, total: Money }
}
slice "T" {
  view Open Orders from "Order Placed" {
    orderId
  }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("view field with no matching source event field: warning", () => {
    const src = `
slice "S" {
  command Place Order { orderId }
  event Order Placed { orderId }
}
slice "T" {
  view Open Orders from "Order Placed" {
    orderId
    status
  }
}
`;
    const diags = gapDiags(src);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "warning",
      message: 'view "Open Orders" field "status" has no source in "Order Placed"',
    });
  });

  it("event field not provided by the slice's command: warning", () => {
    const src = `
slice "S" {
  command Place Order { customerId }
  event Order Placed { customerId, total: Money }
}
`;
    const diags = gapDiags(src);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "warning",
      message: 'event "Order Placed" field "total" not provided by command "Place Order"',
    });
  });

  it("event field covered by the slice's command: no warning", () => {
    const src = `
slice "S" {
  command Place Order { customerId, total: Money }
  event Order Placed { customerId, total: Money }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("neither side declares fields: no warnings (both-sides-undeclared skip)", () => {
    const src = `
slice "S" {
  command Place Order
  event Order Placed
}
slice "T" {
  view Open Orders from "Order Placed"
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("only one side declares fields: skipped, not treated as a full gap", () => {
    const viewOnly = `
slice "S" {
  command Place Order
  event Order Placed
}
slice "T" {
  view Open Orders from "Order Placed" {
    orderId
    status
  }
}
`;
    expect(gapDiags(viewOnly)).toHaveLength(0);

    const eventOnly = `
slice "S" {
  command Place Order
  event Order Placed { orderId, total: Money }
}
`;
    expect(gapDiags(eventOnly)).toHaveLength(0);
  });

  it("unions fields across every instance of a same-named source event", () => {
    // "Order Placed" appears twice (once per slice, both feeding the same view via
    // separate `from` sources); the view field is only covered by the SECOND
    // instance's fields, so the union across both instances must still find it.
    const src = `
slice "S1" {
  command Place Order { orderId }
  event Order Placed { orderId }
}
slice "S2" {
  command Place Order { orderId, total: Money }
  event Order Placed { orderId, total: Money }
}
slice "T" {
  view Order Summary from "Order Placed" {
    orderId
    total
  }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("`view X again` instances are checked independently — no spurious warnings when the later instance simply doesn't redeclare fields", () => {
    const src = `
context Inventory
slice "Receive" {
  command Receive Stock { sku, qty: Int }
  event Stock Received @Inventory { sku, qty: Int }
}
slice "Catalog" {
  view Availability from "Stock Received" {
    sku
    qty
  }
}
slice "Reserve" {
  command Reserve Stock { sku }
  event Stock Reserved @Inventory { sku }
}
slice "Catalog Updated" {
  view Availability again from "Stock Reserved"
}
`;
    // The first instance declares fields and is fully covered by "Stock Received".
    // The `again` instance declares no fields block of its own, so — per the
    // both-sides-declare gate applied per element instance — it is skipped
    // entirely rather than re-checked against "Stock Reserved" (which doesn't
    // carry `qty`).
    expect(gapDiags(src)).toHaveLength(0);
  });
});
