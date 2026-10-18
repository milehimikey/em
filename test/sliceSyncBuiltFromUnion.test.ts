// SPDX-License-Identifier: MIT
// GH #280: the generated view region's "built from events" line and per-field "from event"
// notes list the UNION of `from` across a read model's originating and `again` instances.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { buildSliceRegions } from "../src/catalog/sliceSections.js";

const SRC = `
model "Orders"
context Sales
persona Clerk

slice "Place Order" {
  ui Order Form @Clerk
  command Place Order
  event Order Placed @Sales { orderId: string, total: number }
}

slice "Place Order Manually" {
  ui Manual Form @Clerk
  command Place Order Manually
  event Order Placed Manually @Sales { orderId: string, approvedBy: string }
}

slice "Orders" {
  view Orders from "Order Placed" { orderId: string, total: number, approvedBy: string }
  ui Order List @Clerk
}

slice "Orders manual" {
  view Orders again from "Order Placed Manually"
  ui Order List @Clerk
}
`;

const viewRegion = (model: ReturnType<typeof normalize>, idx: number) =>
  buildSliceRegions(model, [idx]).find((r) => r.kind === "view")!.body;

describe("view region unions `from` across again instances (GH #280)", () => {
  const model = normalize(parse(SRC));
  const origin = model.slices.findIndex((s) => s.name === "Orders");
  const again = model.slices.findIndex((s) => s.name === "Orders manual");

  it("the originating slice's built-from line lists every instance's events", () => {
    const body = viewRegion(model, origin);
    expect(body[0]).toBe('- **View:** `Orders` built from events: "Order Placed", "Order Placed Manually"');
  });

  it("a field fed only by a later instance's event is attributed to it, not left blank", () => {
    const body = viewRegion(model, origin).join("\n");
    expect(body).toContain("| approvedBy | string | from event `Order Placed Manually` |");
    expect(body).toContain("| total | number | from event `Order Placed` |");
  });

  it("a legacy own-doc again slice lists the same union", () => {
    expect(viewRegion(model, again)[0]).toBe(
      '- **View:** `Orders` built from events: "Order Placed", "Order Placed Manually"',
    );
  });

  it("control: a view with no again instance lists only its own from", () => {
    const m = normalize(
      parse(`model "M"
context C
persona P
slice "S" {
  ui U @P
  command Do
  event Done @C { id: string }
  view V from "Done" { id: string }
}
`),
    );
    expect(viewRegion(m, 0)[0]).toBe('- **View:** `V` built from events: "Done"');
  });
});
