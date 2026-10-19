// SPDX-License-Identifier: MIT
// GH #292: automation-split-by-outcome and retry-slice-of.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { buildShapeReport } from "../src/cli/shape.js";

const diagsFor = (src: string) => {
  const model = normalize(parse(src));
  return validate(model, layout(model), computeRefs(model));
};
const codes = (src: string, code: string) => diagsFor(src).filter((d) => d.code === code);
const fixture = (name: string) => readFileSync(join("test/fixtures/shape", name), "utf8");
const SPLIT = "automation-split-by-outcome";

describe(SPLIT, () => {
  it("4-way split: one diagnostic with all four slices (success sibling included) and element refs", () => {
    const found = codes(fixture("fulfilment-four-way.em"), SPLIT);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("docs/patterns.md#automation");
    expect(found[0].refs).toEqual([
      "fulfil-order",
      "fail-fulfilment",
      "retry-fulfilment",
      "time-out-fulfilment",
      "fulfil-order/processor.fulfiller",
      "fulfil-order/command.fulfil-order",
      "fail-fulfilment/processor.fulfil-failure",
      "fail-fulfilment/command.fail-order-fulfilment",
      "retry-fulfilment/processor.fulfil-retry",
      "retry-fulfilment/command.retry-fulfil-order",
      "time-out-fulfilment/processor.fulfil-timeout",
      "time-out-fulfilment/command.time-out-order-fulfilment",
    ]);
  });

  it("PIM sync 4-way split fires once with all four slices", () => {
    const found = codes(fixture("pim-sync-four-way.em"), SPLIT);
    expect(found).toHaveLength(1);
    expect(found[0].refs!.slice(0, 4)).toEqual(["sync-ok", "sync-failed", "sync-retry", "sync-timeout"]);
  });

  it("matches verb/noun forms (Placed/Placement, Authorized/Authorization, Shipped/Shipment, Captured/Capture) and translations", () => {
    const found = codes(fixture("suffix-pairs.em"), SPLIT);
    const keys = found.map((d) => d.refs!.slice(0, 2).join("+"));
    expect(keys).toEqual([
      "capture-payment+fail-capture",
      "authorize-payment+fail-authorization",
      "place-order+fail-placement",
      "ship-order+fail-shipment",
      "charge-customer-card+reject-customer-card",
      "one+two",
    ]);
  });

  it("fires on the Capture Payment / Fail Payment Capture pair the docs use", () => {
    const src = `
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}
slice "Capture Payment" {
  processor Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured
}
slice "Fail Payment" {
  processor Gateway Failure from "Payments To Process"
  command Fail Payment Capture
  event Payment Capture Failed
}`;
    expect(codes(src, SPLIT)).toHaveLength(1);
  });

  it("stays quiet for two domain-verb decisions on the same view (Cancel vs Complete Order), translation included", () => {
    expect(codes(fixture("domain-verbs-quiet.em"), SPLIT)).toHaveLength(0);
  });

  it("stays quiet for a translation slice and a slice holding both outcomes", () => {
    expect(codes(fixture("translation-quiet.em"), SPLIT)).toHaveLength(0);
    expect(codes(fixture("one-slice-quiet.em"), SPLIT)).toHaveLength(0);
  });

  it("shows in the --shape report on the split fixture, and not on the alternative-events form", () => {
    const split = buildShapeReport(diagsFor(fixture("fulfilment-four-way.em")), []);
    const row = split.rules.find((r) => r.code === SPLIT)!;
    expect(row.findings).toHaveLength(1);
    expect(row.docAnchor).toBe("shape");
    const one = buildShapeReport(diagsFor(fixture("one-slice-quiet.em")), []);
    expect(one.rules.find((r) => r.code === SPLIT)!.findings).toHaveLength(0);
  });

  it("stays quiet when the reactions read different views", () => {
    const src = `
slice "A" {
  view Payments To Process from "Payment Requested"
}
slice "B" {
  view Refunds To Process from "Refund Requested"
}
slice "Capture Payment" {
  processor Gateway from "Payments To Process"
  command Capture Payment
  event Payment Capture Succeeded
}
slice "Fail Payment" {
  processor Gateway Failure from "Refunds To Process"
  command Fail Payment Capture
  event Payment Capture Failed
}`;
    expect(codes(src, SPLIT)).toHaveLength(0);
  });
});

describe("retry-slice-of", () => {
  const RETRY = `
slice "Capture" {
  ui Checkout @Shopper
  command Capture Payment
  event Payment Captured
}
slice "Retry" {
  ui Retry Screen @Shopper
  command Retry Capture Payment
  event Payment Capture Reattempted
}`;
  it("warns on a State Change slice whose only command is Retry <X>", () => {
    const found = codes(RETRY, "retry-slice-of");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].refs).toEqual(["retry/command.retry-capture-payment", "capture/command.capture-payment"]);
  });

  it("stays quiet when the stem matches no command", () => {
    expect(codes(RETRY.replace("Retry Capture Payment", "Retry Something Else"), "retry-slice-of")).toHaveLength(0);
  });

  it("stays quiet when the slice has a reaction", () => {
    const src = RETRY.replace("ui Retry Screen @Shopper", "processor Retrier from \"Capture\"");
    expect(codes(src, "retry-slice-of")).toHaveLength(0);
  });
});

describe("shape lints over shipped examples", () => {
  it("raise nothing on examples/**/*.em", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".em")) files.push(join(dir, e.name));
      }
    };
    walk("examples");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const hits = diagsFor(readFileSync(f, "utf8")).filter((d) => d.code === SPLIT || d.code === "retry-slice-of");
      expect(hits, f).toEqual([]);
    }
  });
});
