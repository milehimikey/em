// SPDX-License-Identifier: MIT
// Coverage for the `issue "text"` red-note warning. (No dedicated validate.test.ts
// existed before this feature — other validate.ts rules are covered inline where
// they were introduced, e.g. test/forwardOnly.test.ts for the timeline laws.)
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model), computeRefs(model));
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

describe("`divergence` — the accepted, resolved sibling of `issue`", () => {
  // The entire point of the annotation is that it stops re-firing on every run — a
  // warning here would defeat that, so this locks in the intentional asymmetry with
  // `issue` (which always warns). See src/model/validate.ts's comment next to the
  // `issue` warning block for why.
  it("emits NO diagnostic at all for an element with a divergence annotation", () => {
    const diags = diagsFor(`
slice "Emit" {
  event Thing Done
}
slice "S" {
  view Retired Things from "Thing Done" divergence "tracking token covers idempotency"
  ui Retired List @Customer
}
`);
    expect(diags).toEqual([]);
  });

  it("still emits no divergence-related diagnostic even alongside an open `issue` on the same element", () => {
    const diags = diagsFor(`
slice "Emit" {
  event Thing Done
}
slice "S" {
  view Retired Things from "Thing Done" issue "still true post-migration?" divergence "known idiom"
}
`);
    // Only the `issue` warning fires; nothing about `divergence` is ever reported.
    expect(diags.filter((d) => d.message.includes("divergence"))).toEqual([]);
    expect(diags.some((d) => d.message.startsWith("open issue on"))).toBe(true);
  });

  it("normalize() copies `divergence` from the AST onto the model element", () => {
    const model = modelFrom(`slice "S" {\n  event E divergence "known idiom"\n}`);
    const el = model.byName.get("e")![0];
    expect(el.divergence).toBe("known idiom");
  });

  it("leaves `divergence` undefined on elements without one", () => {
    const model = modelFrom(`slice "S" {\n  event E\n}`);
    const el = model.byName.get("e")![0];
    expect(el.divergence).toBeUndefined();
  });
});

describe("fields-completeness warnings", () => {
  const gapDiags = (src: string) =>
    diagsFor(src).filter(
      (d) => d.message.includes("has no source in") || d.message.includes("not provided by"),
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

  it("unions fields across multiple commands in a slice", () => {
    // `total` is only provided by the SECOND command; the union across both
    // commands must still cover it.
    const src = `
slice "S" {
  command Place Order { orderId }
  command Price Order { orderId, total: Money }
  event Order Priced { orderId, total: Money }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("multi-command warning quotes each command name individually", () => {
    const src = `
slice "S" {
  command Place Order { orderId }
  command Price Order { orderId }
  event Order Priced { orderId, total: Money }
}
`;
    const diags = gapDiags(src);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe(
      'event "Order Priced" field "total" not provided by any of commands "Place Order", "Price Order"',
    );
  });

  it("matching is name-only — a type mismatch is not a gap", () => {
    // `total: Money` on the event vs `total: Int` on the command: types are
    // intentionally not compared, so this stays silent.
    const src = `
slice "S" {
  command Place Order { orderId, total: Int }
  event Order Placed { orderId, total: Money }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("mixed source events (one declares fields, one doesn't): view check is skipped", () => {
    // "Order Shipped" never opted in to fields, so it may well provide
    // `shippedAt` — warning here would flag a legitimate field.
    const src = `
slice "S" {
  command Place Order { orderId }
  event Order Placed { orderId }
}
slice "T" {
  command Ship Order
  event Order Shipped
}
slice "U" {
  view Order History from "Order Placed", "Order Shipped" {
    orderId
    shippedAt
  }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });

  it("mixed commands (one declares fields, one doesn't): event check is skipped", () => {
    // The fieldless "Import Order" may be the provider of `importedAt`.
    const src = `
slice "S" {
  command Place Order { orderId }
  command Import Order
  event Order Recorded { orderId, importedAt }
}
`;
    expect(gapDiags(src)).toHaveLength(0);
  });
});

describe("connection legality (the four patterns)", () => {
  // em infers only legal connections from slice shape, so a hand-written `arrow` is the
  // one way an illegal one can enter a model. See examples/timeline-rules-invalid.em.
  const BASE = `
persona Agent
context Ticket
slice "Open Ticket" {
  ui Ticket Form @Agent
  command Open Ticket
  event Ticket Opened @Ticket
}
slice "Ticket Queue" {
  view Ticket Queue from "Ticket Opened"
  ui Queue Board @Agent
}
slice "Assign Ticket" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue After Assignment" {
  view Ticket Queue again from "Ticket Assigned"
}
`;
  const flowErrors = (arrow: string) =>
    diagsFor(BASE + arrow).filter(
      (d) => d.severity === "error" && d.message.includes("connects a"),
    );

  it("rejects a command wired straight to a read model — the CQRS violation", () => {
    const [err] = flowErrors('arrow "Open Ticket" -> "Ticket Queue"');
    expect(err.message).toContain("connects a command directly to a read model");
    expect(err.message).toContain("command -> event -> read model");
  });

  it("rejects a read model wired straight to a command", () => {
    const [err] = flowErrors('arrow "Ticket Queue" -> "Assign Ticket"');
    expect(err.message).toContain("connects a read model directly to a command");
    expect(err.message).toContain("read model -> processor -> command");
  });

  it("rejects an event wired straight to a command", () => {
    const [err] = flowErrors('arrow "Ticket Opened" -> "Assign Ticket"');
    expect(err.message).toContain("connects an event directly to a command");
  });

  it("rejects event -> event (Law 1) and read model -> read model", () => {
    expect(flowErrors('arrow "Ticket Opened" -> "Ticket Assigned"')[0].message).toContain(
      "events never connect to events",
    );
    expect(flowErrors('arrow "Ticket Queue" -> "Ticket Queue"')[0].message).toContain(
      "instances of one read model are never connected",
    );
  });

  it("allows every pair the four patterns do produce", () => {
    const legal = [
      'arrow "Ticket Form" -> "Open Ticket"', // ui -> command
      'arrow "Open Ticket" -> "Ticket Opened"', // command -> event
      'arrow "Ticket Opened" -> "Ticket Queue"', // event -> view
      'arrow "Ticket Queue" -> "Queue Board"', // view -> ui
    ];
    for (const a of legal) expect(flowErrors(a)).toHaveLength(0);
  });

  it("allows read model -> reaction -> command across two slices", () => {
    const src = `
context Billing
slice "Refund Requested" {
  command Request Refund
  event Refund Requested @Billing
}
slice "Refund Backlog" {
  view Refund Backlog from "Refund Requested"
  processor Refund Gateway
}
slice "Issue Refund" {
  command Issue Refund
  event Refund Issued @Billing
}
arrow "Refund Backlog" -> "Refund Gateway"
arrow "Refund Gateway" -> "Issue Refund"
`;
    expect(
      diagsFor(src).filter((d) => d.severity === "error" && d.message.includes("connects a")),
    ).toHaveLength(0);
  });
});

describe("unread event warning", () => {
  // The mirror of "command produces no event": recording an event nothing projects is a
  // write with no reader. A warning, not an error — a model in progress legitimately has a
  // write slice whose read slice hasn't been added yet, and errors block rendering.
  const unread = (src: string) =>
    diagsFor(src).filter((d) => d.message.includes("not read by any read model"));

  it("warns on an event no read model consumes, at the event's line", () => {
    const diags = unread(`
context Ticket
slice "Open Ticket" {
  command Open Ticket
  event Ticket Opened @Ticket
}
`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning", line: 5 });
    expect(diags[0].message).toContain('event "Ticket Opened"');
  });

  it("stays quiet when a view names the event in `from`, from any later slice", () => {
    expect(
      unread(`
context Ticket
slice "Open Ticket" {
  command Open Ticket
  event Ticket Opened @Ticket
}
slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
`),
    ).toHaveLength(0);
  });

  it("counts a `view X again` instance as the reader", () => {
    expect(
      unread(`
context Ticket
slice "Open" {
  command Open Ticket
  event Ticket Opened @Ticket
}
slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue Again" {
  view Ticket Queue again from "Ticket Assigned"
}
`),
    ).toHaveLength(0);
  });

  it("counts a same-slice view with no `from` as the reader", () => {
    expect(
      unread(`
context Ticket
slice "Open And Read" {
  command Open Ticket
  event Ticket Opened @Ticket
  view Ticket Queue
}
`),
    ).toHaveLength(0);
  });

  it("counts an explicit event -> view arrow as the reader", () => {
    expect(
      unread(`
context Ticket
slice "Open" {
  command Open Ticket
  event Ticket Opened @Ticket
}
slice "Board" {
  view Ops Board from "Ticket Opened"
}
slice "Later" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Other Board" {
  view Second Board from "Ticket Opened"
}
arrow "Ticket Assigned" -> "Second Board"
`),
    ).toHaveLength(0);
  });

  it("flags each unread event separately and leaves the read ones alone", () => {
    const diags = unread(`
context Ticket
slice "Open" {
  command Open Ticket
  event Ticket Opened @Ticket
}
slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
slice "Reply" {
  command Reply
  event Reply Sent @Ticket
}
slice "Resolve" {
  command Resolve
  event Ticket Resolved @Ticket
}
`);
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('"Reply Sent"'),
      expect.stringContaining('"Ticket Resolved"'),
    ]);
  });
});

describe("untriggered command warning", () => {
  // The input-side mirror of the unread-event rule. Information enters the system through a
  // command, and a command enters through a person on a screen or a reaction acting for them.
  const untriggered = (src: string) =>
    diagsFor(src).filter((d) => d.message.includes("nothing that triggers it"));

  it("warns on a command with no ui and no preceding reaction", () => {
    const diags = untriggered(`
context Ticket
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning", line: 4 });
    expect(diags[0].message).toContain('command "Assign Ticket"');
  });

  it("stays quiet when a ui sits in the same slice, in any order", () => {
    expect(
      untriggered(`
context Ticket
slice "Assign" {
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`),
    ).toHaveLength(0);
    expect(
      untriggered(`
context Ticket
slice "Assign" {
  command Assign Ticket
  ui Queue Board @Agent
  event Ticket Assigned @Ticket
}
`),
    ).toHaveLength(0);
  });

  it("counts a reaction in the previous slice — the Automation/Translation split", () => {
    expect(
      untriggered(`
context Billing
slice "Backlog" {
  view Refund Backlog from "Refund Requested"
  processor Refund Gateway
}
slice "Issue Refund" {
  command Issue Refund
  event Refund Issued @Billing
}
`),
    ).toHaveLength(0);
  });

  it("does not count a reaction two slices back", () => {
    expect(
      untriggered(`
context Billing
slice "Backlog" {
  view Refund Backlog from "Refund Requested"
  processor Refund Gateway
}
slice "Gap" {
  view Something from "Refund Requested"
}
slice "Issue Refund" {
  command Issue Refund
  event Refund Issued @Billing
}
`),
    ).toHaveLength(1);
  });

  it("counts an explicit ui -> command arrow", () => {
    expect(
      untriggered(`
context Ticket
slice "Board" {
  view Queue from "Ticket Assigned"
  ui Queue Board @Agent
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
arrow "Queue Board" -> "Assign Ticket"
`),
    ).toHaveLength(0);
  });

  it("flags each untriggered command separately", () => {
    const diags = untriggered(`
context Ticket
slice "A" {
  command One
  event One Done @Ticket
}
slice "B" {
  ui Screen @Agent
  command Two
  event Two Done @Ticket
}
slice "C" {
  command Three
  event Three Done @Ticket
}
`);
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('"One"'),
      expect.stringContaining('"Three"'),
    ]);
  });
});

describe("ui sharing a reaction's slice", () => {
  // A `ui` only ever triggers a `command` (State Change) — no pattern has a `ui` triggering a
  // reaction. Placed in a reaction's slice instead, it renders with no outgoing edge at all.
  const disconnected = (src: string) =>
    diagsFor(src).filter((d) => d.message.includes("renders disconnected here"));

  it("warns when a ui shares a slice with a translation and no command", () => {
    const diags = disconnected(`
context Shipping
slice "Weird" {
  ui Something @Ops
  translation Carrier Adapter
}
slice "Confirm Delivery" {
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning", line: 4 });
    expect(diags[0].message).toBe(
      'ui "Something" shares slice "Weird" with translation "Carrier Adapter"; a `ui` only ' +
        "wires to a `command` and renders disconnected here — move it to the slice that " +
        "consumes the read model, or to the slice with the command this triggers",
    );
  });

  it("warns for any automation alias (processor), not just translation", () => {
    expect(
      disconnected(`
context Ticket
slice "Backlog" {
  ui Queue Board @Agent
  processor Auto Assign
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`),
    ).toHaveLength(1);
  });

  it("stays quiet on the ordinary State Change pairing (ui + command)", () => {
    expect(
      disconnected(`
context Ticket
slice "Assign" {
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`),
    ).toHaveLength(0);
  });

  it("stays quiet when the reaction shares its slice with a command instead (the other warning covers that)", () => {
    const diags = diagsFor(`
context Ticket
slice "Backlog" {
  processor Auto Assign
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`);
    expect(diags.filter((d) => d.message.includes("renders disconnected here"))).toHaveLength(0);
    expect(diags.some((d) => d.message.includes("shares slice"))).toBe(true);
  });

  it("stays quiet when a view sits alongside — view -> ui connects it regardless of the automation", () => {
    // edges.ts draws `view -> ui` whenever a view and ui share a slice, whether or not an
    // automation also reads that same view. The ui is genuinely connected here, not dangling.
    expect(
      disconnected(`
context Ticket
slice "Backlog" {
  view Backlog Items
  ui Queue Board @Agent
  processor Auto Assign
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
`),
    ).toHaveLength(0);
  });
});

describe("unconsumed read model warning", () => {
  // A complete State View is event -> read model -> ui (or -> reaction). A view nothing
  // displays or watches is the output-side half-slice.
  const unconsumed = (src: string) =>
    diagsFor(src).filter((d) => d.message.includes("has no consumer"));

  const WRITE = `
context Ticket
slice "Open" {
  ui Ticket Form @Agent
  command Open Ticket
  event Ticket Opened @Ticket
}
`;

  it("warns on a read model with no ui and no reaction", () => {
    const diags = unconsumed(`${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning" });
    expect(diags[0].message).toContain('read model "Ticket Queue"');
  });

  it("stays quiet when a ui sits in the same slice", () => {
    expect(
      unconsumed(`${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
  ui Queue Board @Agent
}
`),
    ).toHaveLength(0);
  });

  it("stays quiet when a reaction sits in the same slice — the Automation pattern", () => {
    expect(
      unconsumed(`${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
  processor Auto Assign
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue Again" {
  view Ticket Queue again from "Ticket Assigned"
  ui Queue Board @Agent
}
`),
    ).toHaveLength(0);
  });

  it("counts a reaction reading it from a later slice, binding to the nearest instance", () => {
    // The processor reads "Ticket Queue" from slice 4; that consumes the instance in slice 2,
    // not some other one — same nearest-at-or-before rule the renderer uses.
    const src = `${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
slice "React" {
  processor Auto Assign from "Ticket Queue"
}
slice "Assign" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue Again" {
  view Ticket Queue again from "Ticket Assigned"
  ui Queue Board @Agent
}
`;
    expect(unconsumed(src)).toHaveLength(0);
  });

  it("counts an explicit view -> ui arrow", () => {
    expect(
      unconsumed(`${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
slice "Board" {
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue Again" {
  view Ticket Queue again from "Ticket Assigned"
  ui Board Two @Agent
}
arrow "Ticket Queue" -> "Queue Board"
`),
    ).toHaveLength(0);
  });

  it("flags each unconsumed instance of a repeated read model separately", () => {
    const diags = unconsumed(`${WRITE}slice "Queue" {
  view Ticket Queue from "Ticket Opened"
}
slice "Assign" {
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}
slice "Queue Again" {
  view Ticket Queue again from "Ticket Assigned"
}
`);
    expect(diags).toHaveLength(2);
  });
});

describe("`public` marker raises no diagnostic", () => {
  it("produces no diagnostics for an event marked public", () => {
    const diags = diagsFor(`
slice "Place" {
  ui New Order @Customer
  command Place Order
  event Order Placed @Order public
}
slice "Catalog" {
  view Orders from "Order Placed"
  ui Order List @Customer
}
`);
    expect(diags).toHaveLength(0);
  });
});

describe("declared `type` validation (MIL-64)", () => {
  it("rejects a direct bare self-cycle", () => {
    const diags = diagsFor(`type A { child: A }`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "error" });
    expect(diags[0].message).toBe('type "A" has a cyclic reference: A -> A');
  });

  it("allows the same self-referential shape through an array field (recursion terminates at runtime)", () => {
    const diags = diagsFor(`type TreeNode { children: TreeNode[] }`);
    expect(diags).toHaveLength(0);
  });

  it("rejects a 2-hop cycle", () => {
    const diags = diagsFor(`
type A { b: B }
type B { a: A }
`);
    const cycleErrors = diags.filter((d) => d.message.includes("cyclic reference"));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].severity).toBe("error");
    expect(cycleErrors[0].message).toBe('type "A" has a cyclic reference: A -> B -> A');
  });

  it("rejects a 3-hop cycle", () => {
    const diags = diagsFor(`
type A { b: B }
type B { c: C }
type C { a: A }
`);
    const cycleErrors = diags.filter((d) => d.message.includes("cyclic reference"));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].message).toBe('type "A" has a cyclic reference: A -> B -> C -> A');
  });

  it("allows a legitimate DAG diamond — a type referenced twice by another type is not a cycle", () => {
    const diags = diagsFor(`
type Order { billing: Address, shipping: Address }
type Address { line1: String }
`);
    expect(diags).toHaveLength(0);
  });

  it("cites the cycle's line at the first type in the reported path", () => {
    const diags = diagsFor(`
type A { b: B }
type B { a: A }
`);
    const cycleError = diags.find((d) => d.message.includes("cyclic reference"))!;
    expect(cycleError.line).toBe(2); // `type A { b: B }` is on line 2 (leading blank line)
  });

  it("warns on a duplicate type name unconditionally, even when never referenced by any field", () => {
    const diags = diagsFor(`
type Money { amount: int }
type Money { cents: long }
`);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning" });
    expect(diags[0].message).toBe(
      'type "Money" is defined 2 times; references resolve to the first occurrence',
    );
  });

  it("raises no type-related diagnostic for a model whose fields reference a declared type, bare or as an array", () => {
    const diags = diagsFor(`
type QuoteAcceptedLine { lineId: UUID }
slice "S" {
  ui Quote Screen @Sales
  command Accept Quote
  event Quote Accepted {
    lines: QuoteAcceptedLine[]
  }
}
slice "Confirm" {
  view Accepted Quotes from "Quote Accepted"
  ui Confirmation @Sales
}
`);
    expect(diags.filter((d) => d.message.includes("type "))).toHaveLength(0);
  });
});

describe("`from` resolution with clause keywords in names (MIL-82)", () => {
  it("resolves a view's `from` to an event whose name contains the word From", () => {
    const diags = diagsFor(`
model "Test"
persona User
context Thing
slice "A" {
  ui Screen @User
  command Take Widget Out
  event Widget Removed From Cabinet @Thing
}
slice "Read" {
  view List from "Widget Removed From Cabinet"
  ui Cabinet Screen @User
}
`);
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(
      diags.some((d) => d.message.includes("unknown event")),
    ).toBe(false);
  });
});

describe("`from` kind-mismatch error messages (MIL-83)", () => {
  it("says an event is not a read model when a reaction's `from` names an event", () => {
    const diags = diagsFor(`
slice "S" {
  ui Screen @User
  command Do Thing
  event Thing Happened @Ctx
}
slice "React" {
  processor Reactor from "Thing Happened"
}
`);
    const err = diags.find(
      (d) => d.severity === "error" && d.message.includes('"Reactor"'),
    );
    expect(err?.message).toContain("which is an event, not a read model");
    expect(err?.message).toContain('view <Pending Work> from "Thing Happened"');
  });

  it("still reports a truly unknown read model as unknown", () => {
    const diags = diagsFor(`
slice "React" {
  processor Reactor from "No Such Thing"
}
`);
    expect(
      diags.some((d) => d.message.includes('references unknown read model "No Such Thing"')),
    ).toBe(true);
  });

  it("says a view is not an event when a view's `from` names another view", () => {
    const diags = diagsFor(`
slice "A" {
  ui Screen @User
  command Do Thing
  event Thing Happened @Ctx
}
slice "B" {
  view Things from "Thing Happened"
  ui Board @User
}
slice "C" {
  view Copy of Things from "Things"
  ui Other Board @User
}
`);
    const err = diags.find(
      (d) => d.severity === "error" && d.message.includes('"Copy of Things"'),
    );
    expect(err?.message).toContain("which is a view, not an event");
  });

  it("still reports a truly unknown event as unknown", () => {
    const diags = diagsFor(`
slice "B" {
  view Things from "Never Happened"
  ui Board @User
}
`);
    expect(
      diags.some((d) => d.message.includes('references unknown event "Never Happened"')),
    ).toBe(true);
  });
});
