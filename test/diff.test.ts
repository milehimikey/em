// SPDX-License-Identifier: MIT
// Coverage for `em diff`'s structural diff (src/model/diff.ts): identical models,
// slice/element add/remove, move detection, field/from/note/issue changes, arrow
// add/remove, ordering determinism, and the --exit-code semantics (hasChanges()),
// tested at the diff-module level per the repo convention of not subprocess-
// testing cli.ts (see test/export.test.ts's header comment for the same call).
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { diffModels, formatModelDiff, hasChanges, ChangeEntry } from "../src/model/diff.js";

const modelOf = (src: string) => compile(src).model;
const diffOf = (oldSrc: string, newSrc: string) => diffModels(modelOf(oldSrc), modelOf(newSrc));
const reportOf = (oldSrc: string, newSrc: string) => formatModelDiff(diffOf(oldSrc, newSrc));

describe("identical models", () => {
  it("produce an empty diff and the 'no structural changes' report", () => {
    const src = `
slice "Submit" {
  command Submit Order
  event Order Submitted
}
`;
    const diff = diffOf(src, src);
    expect(diff.changes).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(hasChanges(diff)).toBe(false);
    expect(reportOf(src, src)).toBe("no structural changes");
  });
});

describe("slice add/remove", () => {
  const OLD = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
`;
  const NEW = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
slice "Fulfillment" {
  command Ship Order
  event Order Shipped
}
`;

  it("reports an added slice, without enumerating its elements separately", () => {
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([{ type: "slice-added", name: "Fulfillment", sliceKey: "fulfillment" }]);
    expect(diff.counts.slicesAdded).toBe(1);
    expect(diff.counts.elementsAdded).toBe(0);
  });

  it("reports a removed slice symmetrically", () => {
    const diff = diffOf(NEW, OLD);
    expect(diff.removals).toEqual([{ type: "slice-removed", name: "Fulfillment", sliceKey: "fulfillment" }]);
    expect(diff.counts.slicesRemoved).toBe(1);
    expect(diff.counts.elementsRemoved).toBe(0);
  });
});

describe("element add/remove within a surviving slice", () => {
  const OLD = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
`;
  const NEW = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
  event Discount Applied
}
`;

  it("reports the added element", () => {
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "element-added",
        kind: "event",
        name: "Discount Applied",
        ref: "checkout/event.discount-applied",
        sliceName: "Checkout",
        sliceKey: "checkout",
      },
    ]);
    expect(diff.counts.elementsAdded).toBe(1);
  });

  it("reports the removed element symmetrically", () => {
    const diff = diffOf(NEW, OLD);
    expect(diff.removals).toEqual([
      {
        type: "element-removed",
        kind: "event",
        name: "Discount Applied",
        ref: "checkout/event.discount-applied",
        sliceName: "Checkout",
        sliceKey: "checkout",
        acceptedDivergence: null,
      },
    ]);
    expect(diff.counts.elementsRemoved).toBe(1);
  });
});

describe("ref collision (dedupe)", () => {
  it("carries the `~2` dedupe suffix onto a same-kind-same-name element's ref", () => {
    // Two "Repeat" commands in one slice get "s/command.repeat" and
    // "s/command.repeat~2" (see test/export.test.ts's identical scenario for
    // `em export`) — the ref/sliceKey carried on ChangeEntry must reflect
    // computeRefs()'s already-deduped output, not a naively-recomputed slug.
    const OLD = `slice "S" {\n  command Repeat\n}`;
    const NEW = `slice "S" {\n  command Repeat\n  command Repeat\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "element-added",
        kind: "command",
        name: "Repeat",
        ref: "s/command.repeat~2",
        sliceName: "S",
        sliceKey: "s",
      },
    ]);
    expect(diff.counts.elementsAdded).toBe(1);
  });
});

describe("move detection", () => {
  it("reports a same-kind-same-name element moved from slice A to slice B as one move, not add+remove", () => {
    const OLD = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
  event Payment Failed
}
`;
    const NEW = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
slice "Payment" {
  event Payment Failed
}
`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      { type: "slice-added", name: "Payment", sliceKey: "payment" },
      {
        type: "element-moved",
        kind: "event",
        name: "Payment Failed",
        ref: "payment/event.payment-failed",
        fromSlice: "Checkout",
        fromSliceKey: "checkout",
        toSlice: "Payment",
        toSliceKey: "payment",
      },
    ]);
    // The move is reported once — no separate add/remove entries for it.
    expect(diff.counts.elementsMoved).toBe(1);
    expect(diff.counts.elementsAdded).toBe(0);
    expect(diff.counts.elementsRemoved).toBe(0);
    expect(diff.removals).toEqual([]);
  });

  it("detects a move even when both endpoints are otherwise-unrelated existing slices", () => {
    const OLD = `
slice "A" {
  command Do A
  event Thing Happened
}
slice "B" {
  command Do B
}
`;
    const NEW = `
slice "A" {
  command Do A
}
slice "B" {
  command Do B
  event Thing Happened
}
`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "element-moved",
        kind: "event",
        name: "Thing Happened",
        ref: "b/event.thing-happened",
        fromSlice: "A",
        fromSliceKey: "a",
        toSlice: "B",
        toSliceKey: "b",
      },
    ]);
    expect(diff.removals).toEqual([]);
  });

  it("detects a move from a removed slice into a surviving slice (not suppressed as a rename)", () => {
    const OLD = `
slice "Legacy" {
  event Thing Happened
}
slice "Keep" {
  command Do Keep
}
`;
    const NEW = `
slice "Keep" {
  command Do Keep
  event Thing Happened
}
`;
    const diff = diffOf(OLD, NEW);
    // Origin slice removed, but the target slice survives — a genuine move, so it
    // must still report a `moved:` line (only removed-origin + new-target pairs,
    // the slice-rename signature, are suppressed).
    expect(diff.changes).toEqual([
      {
        type: "element-moved",
        kind: "event",
        name: "Thing Happened",
        ref: "keep/event.thing-happened",
        fromSlice: "Legacy",
        fromSliceKey: "legacy",
        toSlice: "Keep",
        toSliceKey: "keep",
      },
    ]);
    expect(diff.removals).toEqual([{ type: "slice-removed", name: "Legacy", sliceKey: "legacy" }]);
    expect(diff.counts.elementsMoved).toBe(1);
  });
});

describe("slice rename", () => {
  it("reads as slice removed + added, without a `moved:` line per element", () => {
    const OLD = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
`;
    const NEW = `
slice "Checkout Flow" {
  command Submit Order
  event Order Submitted
}
`;
    const diff = diffOf(OLD, NEW);
    // The slug-based slice key changes, re-keying every element — but the slice
    // add/remove lines already tell the story, so no per-element move noise.
    expect(diff.changes).toEqual([{ type: "slice-added", name: "Checkout Flow", sliceKey: "checkout-flow" }]);
    expect(diff.removals).toEqual([{ type: "slice-removed", name: "Checkout", sliceKey: "checkout" }]);
    expect(diff.counts.elementsMoved).toBe(0);
    expect(diff.counts.elementsAdded).toBe(0);
    expect(diff.counts.elementsRemoved).toBe(0);
  });
});

describe("field add/remove/type-change", () => {
  const OLD = `
slice "S" {
  command Do Thing {
    sku
    qty: Int
    memo: Text
  }
}
`;
  const NEW = `
slice "S" {
  command Do Thing {
    sku
    qty: Float
    total: Money
  }
}
`;

  it("reports field added, removed, and type-changed as 'field changes'", () => {
    const diff = diffOf(OLD, NEW);
    const types = diff.changes.map((c) => c.type);
    expect(types).toEqual(
      expect.arrayContaining(["field-added", "field-removed", "field-changed"]),
    );
    const added = diff.changes.find((c) => c.type === "field-added") as ChangeEntry;
    expect(added).toMatchObject({ field: "total", fieldType: "Money", name: "Do Thing" });
    const removed = diff.changes.find((c) => c.type === "field-removed") as ChangeEntry;
    expect(removed).toMatchObject({ field: "memo", fieldType: "Text" });
    const changed = diff.changes.find((c) => c.type === "field-changed") as ChangeEntry;
    expect(changed).toMatchObject({ field: "qty", oldType: "Int", newType: "Float" });
    expect(diff.counts.fieldChanges).toBe(3);
  });
});

describe("`from` list changes", () => {
  it("reports a source added to a view's `from`", () => {
    const OLD = `
slice "Receive" {
  event Stock Received
}
slice "Catalog" {
  view Availability from "Stock Received"
}
`;
    const NEW = `
slice "Receive" {
  event Stock Received
  event Stock Adjusted
}
slice "Catalog" {
  view Availability from "Stock Received", "Stock Adjusted"
}
`;
    const diff = diffOf(OLD, NEW);
    const fromChange = diff.changes.find((c) => c.type === "from-added") as ChangeEntry;
    expect(fromChange).toMatchObject({ source: "Stock Adjusted", name: "Availability" });
    expect(diff.counts.fromChanges).toBe(1);
  });

  it("reports a source removed from a view's `from`", () => {
    const OLD = `
slice "Receive" {
  event Stock Received
  event Stock Adjusted
}
slice "Catalog" {
  view Availability from "Stock Received", "Stock Adjusted"
}
`;
    const NEW = `
slice "Receive" {
  event Stock Received
  event Stock Adjusted
}
slice "Catalog" {
  view Availability from "Stock Received"
}
`;
    const diff = diffOf(OLD, NEW);
    const fromChange = diff.changes.find((c) => c.type === "from-removed") as ChangeEntry;
    expect(fromChange).toMatchObject({ source: "Stock Adjusted", name: "Availability" });
    expect(diff.counts.fromChanges).toBe(1);
  });
});

describe("issue lifecycle", () => {
  it("reports an issue opened", () => {
    const OLD = `slice "S" {\n  command Do Thing\n}`;
    const NEW = `slice "S" {\n  command Do Thing issue "who approves?"\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "issue-opened",
        kind: "command",
        name: "Do Thing",
        ref: "s/command.do-thing",
        sliceName: "S",
        sliceKey: "s",
        newText: "who approves?",
        acceptedDivergence: null,
      },
    ]);
    expect(diff.counts.issuesOpened).toBe(1);
  });

  it("reports an issue resolved — positive framing, not a generic removal", () => {
    const OLD = `slice "S" {\n  command Do Thing issue "who approves?"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "issue-resolved",
        kind: "command",
        name: "Do Thing",
        ref: "s/command.do-thing",
        sliceName: "S",
        sliceKey: "s",
        oldText: "who approves?",
        acceptedDivergence: null,
      },
    ]);
    expect(diff.counts.issuesResolved).toBe(1);
    expect(formatModelDiff(diff)).toContain("issue resolved:");
  });

  it("reports the issue text changing", () => {
    const OLD = `slice "S" {\n  command Do Thing issue "v1 question"\n}`;
    const NEW = `slice "S" {\n  command Do Thing issue "v2 question"\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "issue-changed",
        kind: "command",
        name: "Do Thing",
        ref: "s/command.do-thing",
        sliceName: "S",
        sliceKey: "s",
        oldText: "v1 question",
        newText: "v2 question",
        acceptedDivergence: null,
      },
    ]);
    expect(diff.counts.issuesChanged).toBe(1);
  });
});

describe("integration-surface promotion/demotion", () => {
  it("reports an event promoted to public", () => {
    const OLD = `slice "S" {\n  event Order Placed @Order\n}`;
    const NEW = `slice "S" {\n  event Order Placed @Order public\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "event-marked-public",
        kind: "event",
        name: "Order Placed",
        ref: "s/event.order-placed",
        sliceName: "S",
        sliceKey: "s",
      },
    ]);
    expect(diff.counts.eventsMarkedPublic).toBe(1);
    expect(formatModelDiff(diff)).toContain("event marked public:");
  });

  it("reports an event demoted from public", () => {
    const OLD = `slice "S" {\n  event Order Placed @Order public\n}`;
    const NEW = `slice "S" {\n  event Order Placed @Order\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "event-unmarked-public",
        kind: "event",
        name: "Order Placed",
        ref: "s/event.order-placed",
        sliceName: "S",
        sliceKey: "s",
      },
    ]);
    expect(diff.counts.eventsUnmarkedPublic).toBe(1);
    expect(formatModelDiff(diff)).toContain("event unmarked public:");
  });

  it("reports nothing when the public marker is unchanged", () => {
    const src = `slice "S" {\n  event Order Placed @Order public\n}`;
    expect(diffOf(src, src).changes).toEqual([]);
  });
});

describe("note change", () => {
  it("reports a note added/removed/changed", () => {
    const added = diffOf(
      `slice "S" {\n  event Thing Happened\n}`,
      `slice "S" {\n  event Thing Happened note "docs/thing.md"\n}`,
    );
    expect(added.changes).toEqual([
      {
        type: "note-added",
        kind: "event",
        name: "Thing Happened",
        ref: "s/event.thing-happened",
        sliceName: "S",
        sliceKey: "s",
        newNote: "docs/thing.md",
        acceptedDivergence: null,
      },
    ]);

    const changed = diffOf(
      `slice "S" {\n  event Thing Happened note "docs/thing.md"\n}`,
      `slice "S" {\n  event Thing Happened note "docs/thing-v2.md"\n}`,
    );
    expect(changed.changes).toEqual([
      {
        type: "note-changed",
        kind: "event",
        name: "Thing Happened",
        ref: "s/event.thing-happened",
        sliceName: "S",
        sliceKey: "s",
        oldNote: "docs/thing.md",
        newNote: "docs/thing-v2.md",
        acceptedDivergence: null,
      },
    ]);
    expect(changed.counts.noteChanges).toBe(1);
  });
});

describe("accepted divergence", () => {
  it("attaches the canonical element's divergence annotation to its element-removed entry", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "tracking token covers idempotency"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.removals).toEqual([
      {
        type: "element-removed",
        kind: "view",
        name: "Retired Things",
        ref: "s/view.retired-things",
        sliceName: "S",
        sliceKey: "s",
        acceptedDivergence: "tracking token covers idempotency",
      },
    ]);
    expect(diff.counts.acceptedDivergences).toBe(1);
    expect(diff.counts.elementsRemoved).toBe(1);
    expect(formatModelDiff(diff)).toContain('[accepted divergence: "tracking token covers idempotency"]');
  });

  it("is null on an element-removed entry when the element carries no divergence annotation", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.removals[0]).toMatchObject({ type: "element-removed", acceptedDivergence: null });
    expect(diff.counts.acceptedDivergences).toBe(0);
  });

  it("also annotates a matched-pair change (e.g. field-added) on a diverged element", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "known idiom"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "known idiom" {\n    productId: UUID\n  }\n}`;
    const diff = diffOf(OLD, NEW);
    const fieldAdded = diff.changes.find((c) => c.type === "field-added") as ChangeEntry;
    expect(fieldAdded).toMatchObject({ field: "productId", acceptedDivergence: "known idiom" });
    expect(diff.counts.acceptedDivergences).toBe(1);
  });

  it("never suppresses the finding or changes hasChanges()/--exit-code semantics", () => {
    const OLD = `slice "S" {\n  command Do Thing\n  event Thing Done\n  view Retired Things from "Thing Done" divergence "known idiom"\n}`;
    const NEW = `slice "S" {\n  command Do Thing\n  event Thing Done\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.removals).toHaveLength(1);
    expect(hasChanges(diff)).toBe(true);
  });
});

describe("slice source change (MIL-69)", () => {
  it("reports a source added/removed/changed on a surviving slice", () => {
    const added = diffOf(
      `slice "Checkout" {\n  command Submit Order\n}`,
      `slice "Checkout" source "https://linear.app/team/issue/MIL-60" {\n  command Submit Order\n}`,
    );
    expect(added.changes).toEqual([
      {
        type: "source-added",
        sliceName: "Checkout",
        sliceKey: "checkout",
        newSource: "https://linear.app/team/issue/MIL-60",
      },
    ]);
    expect(added.counts.sourceChanges).toBe(1);

    const changed = diffOf(
      `slice "Checkout" source "https://linear.app/team/issue/MIL-60" {\n  command Submit Order\n}`,
      `slice "Checkout" source "https://linear.app/team/issue/MIL-61" {\n  command Submit Order\n}`,
    );
    expect(changed.changes).toEqual([
      {
        type: "source-changed",
        sliceName: "Checkout",
        sliceKey: "checkout",
        oldSource: "https://linear.app/team/issue/MIL-60",
        newSource: "https://linear.app/team/issue/MIL-61",
      },
    ]);
    expect(changed.counts.sourceChanges).toBe(1);

    const removed = diffOf(
      `slice "Checkout" source "https://linear.app/team/issue/MIL-60" {\n  command Submit Order\n}`,
      `slice "Checkout" {\n  command Submit Order\n}`,
    );
    expect(removed.changes).toEqual([
      {
        type: "source-removed",
        sliceName: "Checkout",
        sliceKey: "checkout",
        oldSource: "https://linear.app/team/issue/MIL-60",
      },
    ]);
    expect(removed.counts.sourceChanges).toBe(1);
  });

  it("does not report a source change for a brand-new slice (it's implied by slice-added)", () => {
    const diff = diffOf(
      `slice "Checkout" {\n  command Submit Order\n}`,
      `slice "Checkout" {\n  command Submit Order\n}\nslice "Fulfillment" source "https://linear.app/team/issue/MIL-61" {\n  command Ship Order\n}`,
    );
    expect(diff.changes).toEqual([{ type: "slice-added", name: "Fulfillment", sliceKey: "fulfillment" }]);
    expect(diff.counts.sourceChanges).toBe(0);
  });
});

describe("arrow add/remove", () => {
  const base = `
slice "Submit" {
  ui Screen @Customer
  command Submit Order
}
slice "React" {
  view Orders from "Submit Order"
}
`;
  it("reports an added arrow", () => {
    const diff = diffOf(base, base + `arrow "Orders" -> "Screen"\n`);
    expect(diff.changes).toEqual([{ type: "arrow-added", from: "Orders", to: "Screen" }]);
    expect(diff.counts.arrowsAdded).toBe(1);
  });

  it("reports a removed arrow", () => {
    const diff = diffOf(base + `arrow "Orders" -> "Screen"\n`, base);
    expect(diff.removals).toEqual([{ type: "arrow-removed", from: "Orders", to: "Screen" }]);
    expect(diff.counts.arrowsRemoved).toBe(1);
  });
});

describe("ordering determinism", () => {
  it("orders additions/changes in new-file document order, then removals in old-file document order", () => {
    const OLD = `
slice "Alpha" {
  command Do Alpha
  event Alpha Done issue "still true?"
}
slice "Beta" {
  command Do Beta
  event Beta Done
}
slice "Gamma" {
  command Do Gamma
}
`;
    const NEW = `
slice "Zero" {
  command Do Zero
}
slice "Alpha" {
  command Do Alpha
  event Alpha Done
}
slice "Beta" {
  command Do Beta
}
`;
    const diff = diffOf(OLD, NEW);
    // changes: "Zero" slice added first (new doc order), then the issue-resolved
    // change on Alpha's event (Alpha comes before Beta in the new file).
    expect(diff.changes.map((c) => c.type)).toEqual(["slice-added", "issue-resolved"]);
    // removals: Gamma slice removed, appearing in OLD document order after Beta's
    // element removal (Beta Done removed from a surviving slice).
    expect(diff.removals.map((c) => c.type)).toEqual(["element-removed", "slice-removed"]);
  });

  it("produces the same report for the same inputs (deterministic)", () => {
    const OLD = `slice "S" {\n  command A\n  event B\n}`;
    const NEW = `slice "S" {\n  command A\n  event B issue "q"\n}\nslice "T" {\n  command C\n}`;
    expect(reportOf(OLD, NEW)).toBe(reportOf(OLD, NEW));
  });
});

describe("--exit-code semantics (hasChanges)", () => {
  it("is false for identical models", () => {
    const src = `slice "S" {\n  command A\n}`;
    expect(hasChanges(diffOf(src, src))).toBe(false);
  });

  it("is true when any structural change exists", () => {
    const diff = diffOf(`slice "S" {\n  command A\n}`, `slice "S" {\n  command A\n  event B\n}`);
    expect(hasChanges(diff)).toBe(true);
  });
});

describe("rollup summary line", () => {
  it("lists only non-zero categories, pluralized correctly", () => {
    const OLD = `
slice "Checkout" {
  command Submit Order
  event Order Submitted issue "who approves refunds?"
}
`;
    const NEW = `
slice "Checkout" {
  command Submit Order
  event Order Submitted
}
slice "Fulfillment" {
  command Ship Order
}
`;
    const report = reportOf(OLD, NEW);
    const summaryLine = report.split("\n")[0];
    expect(summaryLine).toBe("1 slice added, 1 issue resolved");
  });
});

describe("renames are out of scope (deliberate)", () => {
  it("a plain rename within the same slice reads as remove+add, not a move", () => {
    const OLD = `slice "S" {\n  command Submit Order\n}`;
    const NEW = `slice "S" {\n  command Place Order\n}`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([
      {
        type: "element-added",
        kind: "command",
        name: "Place Order",
        ref: "s/command.place-order",
        sliceName: "S",
        sliceKey: "s",
      },
    ]);
    expect(diff.removals).toEqual([
      {
        type: "element-removed",
        kind: "command",
        name: "Submit Order",
        ref: "s/command.submit-order",
        sliceName: "S",
        sliceKey: "s",
        acceptedDivergence: null,
      },
    ]);
  });
});

describe("declared `type` add/remove/field changes (MIL-64)", () => {
  it("reports a type added", () => {
    const diff = diffOf(``, `type Money { amount: int }`);
    expect(diff.changes).toEqual([{ type: "type-added", name: "Money", ref: "types/money" }]);
    expect(diff.counts.typesAdded).toBe(1);
  });

  it("reports a type removed symmetrically", () => {
    const diff = diffOf(`type Money { amount: int }`, ``);
    expect(diff.removals).toEqual([{ type: "type-removed", name: "Money", ref: "types/money" }]);
    expect(diff.counts.typesRemoved).toBe(1);
  });

  it("reports field added/removed/type-changed on a surviving type", () => {
    const OLD = `type QuoteAcceptedLine {\n  lineId: UUID\n  quantity: int\n  memo: Text\n}`;
    const NEW = `type QuoteAcceptedLine {\n  lineId: UUID\n  quantity: Decimal\n  netUnitPrice: Money\n}`;
    const diff = diffOf(OLD, NEW);
    const types = diff.changes.map((c) => c.type);
    expect(types).toEqual(
      expect.arrayContaining(["type-field-added", "type-field-removed", "type-field-changed"]),
    );
    const added = diff.changes.find((c) => c.type === "type-field-added") as ChangeEntry;
    expect(added).toMatchObject({ name: "QuoteAcceptedLine", field: "netUnitPrice", fieldType: "Money" });
    const removed = diff.changes.find((c) => c.type === "type-field-removed") as ChangeEntry;
    expect(removed).toMatchObject({ name: "QuoteAcceptedLine", field: "memo", fieldType: "Text" });
    const changed = diff.changes.find((c) => c.type === "type-field-changed") as ChangeEntry;
    expect(changed).toMatchObject({
      name: "QuoteAcceptedLine",
      field: "quantity",
      oldType: "int",
      newType: "Decimal",
    });
    expect(diff.counts.typeFieldChanges).toBe(3);
  });

  it("reports no change for an untouched type nested inside another declared type", () => {
    const src = `type Address { line1: String }\ntype Order { billing: Address }`;
    const diff = diffOf(src, src);
    expect(diff.changes).toEqual([]);
    expect(diff.removals).toEqual([]);
  });

  it("a type rename reads as remove+add, same convention as elements", () => {
    const OLD = `type Money { amount: int }`;
    const NEW = `type Currency { amount: int }`;
    const diff = diffOf(OLD, NEW);
    expect(diff.changes).toEqual([{ type: "type-added", name: "Currency", ref: "types/currency" }]);
    expect(diff.removals).toEqual([{ type: "type-removed", name: "Money", ref: "types/money" }]);
  });

  it("includes type counters in the summary rollup line", () => {
    const report = reportOf(``, `type Money { amount: int }`);
    expect(report.split("\n")[0]).toBe("1 type added");
  });

  it("formats type-added/removed/field-* lines", () => {
    const added = formatModelDiff(diffOf(``, `type Money { amount: int }`));
    expect(added).toContain('+ type "Money"');

    const removed = formatModelDiff(diffOf(`type Money { amount: int }`, ``));
    expect(removed).toContain('- type "Money"');

    const fieldChanged = formatModelDiff(
      diffOf(`type Money { amount: int }`, `type Money { amount: Decimal }`),
    );
    expect(fieldChanged).toContain('~ field "amount" type changed on type "Money": int -> Decimal');
  });
});
