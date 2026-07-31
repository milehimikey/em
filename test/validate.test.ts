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
