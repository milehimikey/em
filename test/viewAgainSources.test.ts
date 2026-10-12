// SPDX-License-Identifier: MIT
// MIL-286 (GH #235): a view's field sources are the UNION of `from` events across the
// originating instance and every `view X again` instance — one logical view (MIL-208). Shared
// resolver with `em export`'s `alsoReads` (src/model/continuation.ts).
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { againInstancesOf, viewSourceNames } from "../src/model/continuation.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model), computeRefs(model));
};

const orders = (originFieldLine: string, againBlock = "") => `
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
  event Order Placed Manually @Sales { orderId: string, total: number, approvedBy: string }
}

slice "Orders" {
  view Orders from "Order Placed" { orderId: string, total: number${originFieldLine} }
  ui Order List @Clerk
}

slice "Orders manual" {
  view Orders again from "Order Placed Manually"${againBlock}
  ui Order List @Clerk
}
`;

const fieldDiags = (src: string) =>
  diagsFor(src).filter(
    (d) => d.code === "fields-completeness/view-field-no-source" || d.code === "derived-from-unresolved",
  );

describe("view-field sources across `again` instances (MIL-286)", () => {
  it("a plain field passes when a later instance's event carries it", () => {
    expect(fieldDiags(orders(", approvedBy: string"))).toEqual([]);
  });

  it("a traced `derived from` may name an event from an again instance", () => {
    expect(fieldDiags(orders(', approvedBy: string derived from "Order Placed Manually"'))).toEqual([]);
  });

  it("a field declared on the again instance passes under the same union rule", () => {
    const src = orders("", " { approvedBy: string }");
    expect(fieldDiags(src)).toEqual([]);
  });

  it("a field no instance's event carries still warns, listing the union of events", () => {
    const d = fieldDiags(orders(", ghost: string"));
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('field "ghost" has no source in "Order Placed", "Order Placed Manually"');
  });

  it("a traced `derived from` naming an unrelated event still errors, listing the union", () => {
    const d = fieldDiags(orders(', approvedBy: string derived from "Nope"'));
    expect(d).toHaveLength(1);
    expect(d[0].code).toBe("derived-from-unresolved");
    expect(d[0].message).toContain('"Order Placed", "Order Placed Manually"');
  });

  it("control: a view with no `again` instance keeps the strict check", () => {
    const src = `
model "Orders"
context Sales
persona Clerk

slice "Place Order" {
  ui Order Form @Clerk
  command Place Order
  event Order Placed @Sales { orderId: string, total: number }
}

slice "Orders" {
  view Orders from "Order Placed" { orderId: string, total: number, approvedBy: string }
  ui Order List @Clerk
}
`;
    const d = fieldDiags(src);
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain('field "approvedBy" has no source in "Order Placed"');
    expect(d[0].message).not.toContain("Manually");
  });

  it("validate's source union agrees with the again instances `alsoReads` is built from", () => {
    const model = modelFrom(orders(", approvedBy: string"));
    const origin = model.elements.find((e) => e.kind === "view" && !e.again)!;
    const followers = againInstancesOf(model, origin);
    expect(followers).toHaveLength(1);
    expect(viewSourceNames(model, origin)).toEqual(["Order Placed", "Order Placed Manually"]);
    expect(viewSourceNames(model, followers[0])).toEqual(viewSourceNames(model, origin));
  });
});
