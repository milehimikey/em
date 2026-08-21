// SPDX-License-Identifier: MIT
// Coverage for `em migrate`'s core logic (src/cli/migrateReactionShape.ts): detecting the old
// pre-1.7.1 two-slice Automation/Translation shape and rewriting it into MIL-120's merged
// single-slice shape. Byte-exact expected output on every rewrite test — this module's whole
// job is a faithful text-level splice, so an exact-string assertion is the only one that would
// actually catch a stray whitespace/comment-placement regression.
import { describe, it, expect } from "vitest";
import { planMigration, verifyMigration } from "../src/cli/migrateReactionShape.js";

// The exact old-shape example docs/patterns.md carried before MIL-120 (git history, commit
// f1428f5) — the canonical "add from" case: the leading slice keeps its bare view.
const PAYMENTS_OLD = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;

const PAYMENTS_NEW = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}

slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}
`;

// The pre-MIL-120 "no view" case — the leading slice holds only the reaction and is deleted
// once it moves.
const WEBHOOK_OLD = `slice "Carrier Webhook" {
  translation Carrier Adapter
}

slice "Confirm Delivery" {
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
`;

// The deleted leading slice also swallows the one blank line immediately after it (the same
// collapse MIL-120's own doc rewrite made by hand) — WEBHOOK_OLD's blank separator before
// "Confirm Delivery" goes with it, so the migrated output starts straight at "slice".
const WEBHOOK_NEW = `slice "Confirm Delivery" {
  translation Carrier Adapter
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
`;

describe("planMigration: the ticket's canonical old-shape examples", () => {
  it("migrates the view+reaction/command+event pair, adding `from`, keeping the bare view slice", () => {
    const plan = planMigration(PAYMENTS_OLD);
    expect(plan.refusals).toEqual([]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      leadingSlice: "Payments To Process",
      followingSlice: "Capture Payment",
      reactionKind: "processor",
      reactionName: "Payment Gateway",
      leadingSliceDeleted: false,
      addedFrom: "Payments To Process",
    });
    expect(plan.rewritten).toBe(PAYMENTS_NEW);
  });

  it("migrates a reaction-only leading slice (no view) and deletes it once empty", () => {
    const plan = planMigration(WEBHOOK_OLD);
    expect(plan.refusals).toEqual([]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      leadingSlice: "Carrier Webhook",
      followingSlice: "Confirm Delivery",
      reactionKind: "translation",
      reactionName: "Carrier Adapter",
      leadingSliceDeleted: true,
      addedFrom: null,
    });
    expect(plan.rewritten).toBe(WEBHOOK_NEW);
  });

  it("preserves comments and blank lines exactly, moving only the reaction's own line", () => {
    const source = `model "Payments"   # title comment

# the to-do list
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"   # projected read model
  processor Payment Gateway   # watches the to-do list
}

# where the money actually moves
slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment   # @Payment lane
}
`;
    const plan = planMigration(source);
    expect(plan.rewritten).toBe(
      `model "Payments"   # title comment

# the to-do list
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"   # projected read model
}

# where the money actually moves
slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process" # watches the to-do list
  command Capture Payment
  event Payment Captured @Payment   # @Payment lane
}
`,
    );
  });

  it("is idempotent: running the migrated output through again reports nothing to migrate", () => {
    const once = planMigration(PAYMENTS_OLD);
    const twice = planMigration(once.rewritten!);
    expect(twice.changes).toEqual([]);
    expect(twice.refusals).toEqual([]);
    expect(twice.rewritten).toBeNull();
  });

  it("does nothing on a file with no Automation/Translation slices at all", () => {
    const plan = planMigration(`slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n`);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.rewritten).toBeNull();
  });

  it("migrates multiple independent sites in one file", () => {
    const combined = PAYMENTS_OLD + "\n" + WEBHOOK_OLD;
    const plan = planMigration(combined);
    expect(plan.refusals).toEqual([]);
    expect(plan.changes).toHaveLength(2);
    expect(plan.rewritten).toBe(PAYMENTS_NEW + "\n" + WEBHOOK_NEW);
  });
});

describe("planMigration: `from` clause handling", () => {
  it("does not duplicate `from` when the reaction already names the view", () => {
    const source = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway from "Payments To Process"
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;
    const plan = planMigration(source);
    expect(plan.changes[0].addedFrom).toBeNull();
    expect(plan.rewritten).toContain('processor Payment Gateway from "Payments To Process"\n  command');
  });

  it("matches an existing `from` by normalized name (case/whitespace-insensitive), so no duplicate is added", () => {
    const source = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway from "payments   to process"
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;
    const plan = planMigration(source);
    expect(plan.changes[0].addedFrom).toBeNull();
  });

  it("extends an existing `from` list with the view name rather than starting a new clause", () => {
    const source = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway from "Some Other View"
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;
    const plan = planMigration(source);
    expect(plan.changes[0].addedFrom).toBe("Payments To Process");
    expect(plan.rewritten).toContain(
      'processor Payment Gateway from "Some Other View", "Payments To Process"\n  command',
    );
  });
});

describe("planMigration: refusals", () => {
  it("refuses when the leading slice has more than one reaction", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor First Reaction
  automation Second Reaction
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/more than one reaction/);
    expect(plan.rewritten).toBeNull();
  });

  it("refuses when the leading slice has elements beyond one view and one reaction", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor The Reaction
  ui Stray Screen @Ops
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/elements beyond one view and one reaction/);
  });

  it("refuses when the leading slice has more than one view", () => {
    const source = `slice "Leading" {
  view Read Model A from "Some Event"
  view Read Model B from "Some Event"
  processor The Reaction
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/elements beyond one view and one reaction/);
  });

  it("refuses when the following slice already has a reaction", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor The Reaction
}

slice "Following" {
  automation Already Here
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/already has a reaction/);
  });

  it("refuses when the following slice has more than one command", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor The Reaction
}

slice "Following" {
  command First Command
  command Second Command
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/more than one command/);
  });

  it("refuses when the following slice has a command but no event", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor The Reaction
}

slice "Following" {
  command Do Thing
}
`;
    const plan = planMigration(source);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/no event/);
  });

  it("refuses a reaction that declares a `{ fields }` block rather than risk relocating it wrong", () => {
    const source = `slice "Leading" {
  view Read Model from "Some Event"
  processor The Reaction { note: string }
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons[0]).toMatch(/fields.*block/);
  });

  it("reports multiple reasons for one site when more than one applies", () => {
    const source = `slice "Leading" {
  view A from "Some Event"
  view B from "Some Event"
  processor First
  automation Second
}

slice "Following" {
  automation AlreadyHere
  command Do Thing
  event Thing Done
}
`;
    const plan = planMigration(source);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("still migrates other, unambiguous sites in the same file when one site is refused", () => {
    const combined = `slice "Ambiguous Leading" {
  view Read Model from "Some Event"
  processor First
  automation Second
}

slice "Ambiguous Following" {
  command Do Thing
  event Thing Done
}

` + PAYMENTS_OLD;
    const plan = planMigration(combined);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].leadingSlice).toBe("Payments To Process");
    expect(plan.rewritten).not.toBeNull();
    expect(plan.rewritten).toContain('processor Payment Gateway from "Payments To Process"');
    // The refused pair's source is completely untouched.
    expect(plan.rewritten).toContain(`slice "Ambiguous Leading" {
  view Read Model from "Some Event"
  processor First
  automation Second
}`);
  });
});

describe("planMigration: does not misfire on unrelated adjacent slices", () => {
  it("leaves an ordinary State Change / State View pair alone", () => {
    const source = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}

slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;
    const plan = planMigration(source);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it("leaves a leading slice with a reaction and a command already together alone (already merged)", () => {
    const source = `slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}

slice "Refund Requested" {
  command Refund Payment
  event Payment Refunded
}
`;
    const plan = planMigration(source);
    expect(plan.changes).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });
});

describe("planMigration: note bindings", () => {
  it("surfaces a doc-binding pointer when either slice in the pair carries a slices/*.md note", () => {
    const source = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested" note "slices/payments-to-process.md"
  processor Payment Gateway
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;
    const plan = planMigration(source);
    expect(plan.changes[0].noteHints).toEqual([
      'view "Payments To Process": note "slices/payments-to-process.md"',
    ]);
    expect(plan.changes[0].message).toMatch(/doc bindings may need re-checking/);
  });

  it("adds no hint when nothing in the pair carries a note", () => {
    const plan = planMigration(PAYMENTS_OLD);
    expect(plan.changes[0].noteHints).toEqual([]);
    expect(plan.changes[0].message).not.toMatch(/doc bindings/);
  });
});

describe("planMigration: line endings", () => {
  it("preserves CRLF line endings in the rewritten output", () => {
    const crlf = PAYMENTS_OLD.replace(/\n/g, "\r\n");
    const plan = planMigration(crlf);
    expect(plan.rewritten).toBe(PAYMENTS_NEW.replace(/\n/g, "\r\n"));
  });
});

describe("verifyMigration", () => {
  it("passes when the rewrite introduces no new error", () => {
    const plan = planMigration(PAYMENTS_OLD);
    const result = verifyMigration(PAYMENTS_OLD, plan.rewritten!);
    expect(result.ok).toBe(true);
    expect(result.newErrors).toEqual([]);
  });

  it("fails when the 'after' source has an error-severity diagnostic the 'before' source didn't", () => {
    // A constructed abort case, not one the actual reaction-move rewrite can organically produce
    // (see this module's header comment for why: a reaction only ever legally points forward to
    // a command, and moving it one slice later can't desync any of the error-tier checks). This
    // tests the guard mechanism itself with a deliberately injected, unrelated new error — an
    // explicit backward+illegal arrow appended to an otherwise-identical source.
    const before = PAYMENTS_OLD;
    const after = before + `\narrow "Payment Captured" -> "Payment Gateway"\n`;
    const result = verifyMigration(before, after);
    expect(result.ok).toBe(false);
    expect(result.newErrors.length).toBeGreaterThan(0);
    expect(result.newErrors[0].severity).toBe("error");
  });
});
