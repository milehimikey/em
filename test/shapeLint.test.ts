// SPDX-License-Identifier: MIT
// GH #292: automation-split-by-outcome and retry-slice-of. GH #398: view-lookup-source.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { buildShapeReport } from "../src/cli/shape.js";
import { RULES } from "../src/model/rules.js";

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

  it("every quiet fixture validates with zero errors, so quiet is the lint's doing", () => {
    for (const f of ["domain-verbs-quiet.em", "translation-quiet.em", "one-slice-quiet.em"]) {
      const errors = diagsFor(fixture(f)).filter((d) => d.severity === "error");
      expect(errors.map((e) => e.message), f).toEqual([]);
    }
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

// GH #398: a view's other (non-row-creating) source is flagged when it's read from a different
// @Context than the view's first source AND that other source is itself the first (row-creating)
// source of some different view — i.e. it genuinely creates rows, just not here.
describe("view-lookup-source", () => {
  const LOOKUP = "view-lookup-source";

  it("is registered as an advisory warning in the shape family (never changes em validate's default exit)", () => {
    expect(RULES[LOOKUP].severity).toBe("warning");
    expect(RULES[LOOKUP].family).toBe("shape");
    // Not the --strict-promoted `advisory` family (GH #293) — a plain "warning" already never
    // flips the exit code, which is all GH #398 requires.
    expect((RULES[LOOKUP] as { advisory?: true }).advisory).toBeUndefined();
  });

  it("flags a cross-context source that is itself another view's row-creating source (toolshed-shaped repro)", () => {
    const found = codes(fixture("view-lookup-source-fires.em"), LOOKUP);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain('view "My Loans" reads "Neighbor Registered"');
    expect(found[0].message).toContain("docs/patterns.md#state-view");
    expect(found[0].refs).toEqual(["my-loans/view.my-loans", "register-neighbor/event.neighbor-registered", "neighbors/view.neighbors"]);
  });

  it("does not flag the view's own same-context sources (Tool Checked Out, same @Tool as the first source)", () => {
    const found = codes(fixture("view-lookup-source-fires.em"), LOOKUP);
    expect(found.some((d) => d.message.includes("Tool Checked Out"))).toBe(false);
  });

  it("stays quiet for a same-context multi-source view and a cross-context source that is nobody's row-creating source", () => {
    expect(codes(fixture("view-lookup-source-quiet.em"), LOOKUP)).toHaveLength(0);
  });

  it("both fixtures validate with zero errors, so the result is the lint's doing", () => {
    for (const f of ["view-lookup-source-fires.em", "view-lookup-source-quiet.em"]) {
      const errors = diagsFor(fixture(f)).filter((d) => d.severity === "error");
      expect(errors.map((e) => e.message), f).toEqual([]);
    }
  });

  it("stays quiet for a single-source view (nothing to compare against)", () => {
    const src = `
slice "Add Tool" {
  ui Add Tool Form @Neighbor
  command Add Tool
  event Tool Added @Tool
}
slice "Tool Catalog" {
  view Tool Catalog from "Tool Added"
  ui Browse Catalog @Neighbor
}`;
    expect(codes(src, LOOKUP)).toHaveLength(0);
  });

  it("shows in the --shape report, grouped under its own rule code with docAnchor shape", () => {
    const report = buildShapeReport(diagsFor(fixture("view-lookup-source-fires.em")), []);
    const row = report.rules.find((r) => r.code === LOOKUP)!;
    expect(row.findings).toHaveLength(1);
    expect(row.docAnchor).toBe("shape");
  });

  it("is silenceable per the existing shape-family waive-file + Decisions-log mechanism — no new DSL clause (R4)", () => {
    // Same existing waive-file rule every shape lint already uses (src/cli/shape.ts `under`):
    // every ref on the finding needs a covering waiver line, one per distinct slice key.
    const diags = diagsFor(fixture("view-lookup-source-fires.em"));
    const waived = buildShapeReport(diags, [`${LOOKUP} my-loans`, `${LOOKUP} register-neighbor`, `${LOOKUP} neighbors`]);
    const row = waived.rules.find((r) => r.code === LOOKUP)!;
    expect(row.findings).toHaveLength(0);
    expect(row.waived).toHaveLength(1);
  });
});

describe("shape lints over shipped examples", () => {
  const exampleFiles = () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".em")) files.push(join(dir, e.name));
      }
    };
    walk("examples");
    return files;
  };

  it("raise nothing on examples/**/*.em for the pre-existing lints (automation-split-by-outcome, retry-slice-of)", () => {
    const files = exampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const hits = diagsFor(readFileSync(f, "utf8")).filter((d) => d.code === SPLIT || d.code === "retry-slice-of");
      expect(hits, f).toEqual([]);
    }
  });

  it("view-lookup-source raises exactly one known, accepted false positive across examples (insurance-claim's Claims Dashboard)", () => {
    // GH #398: "Payment Sent" (@Payment) genuinely changes the dashboard's existing row — the
    // approved claim becomes a paid claim — the exact cross-context-row-change false-positive
    // class the issue names (Tool Checked Out → My Holds). Advisory: never an error, so
    // `em validate`'s default exit is unchanged on every shipped example.
    const hits: string[] = [];
    for (const f of exampleFiles()) {
      for (const d of diagsFor(readFileSync(f, "utf8")).filter((x) => x.code === "view-lookup-source")) {
        expect(d.severity, f).toBe("warning");
        hits.push(`${f}: ${d.refs?.[0]}`);
      }
    }
    expect(hits).toEqual([expect.stringContaining("insurance-claim.em: manager-dashboard/view.claims-dashboard")]);
  });
});
