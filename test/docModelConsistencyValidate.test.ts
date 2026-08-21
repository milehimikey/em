// SPDX-License-Identifier: MIT
// Coverage for `em validate`'s doc↔model consistency check (src/catalog/docModelConsistencyValidate.ts,
// MIL-124): a bound slice doc's structured claims (frontmatter `pattern:`, body Command/Event/View
// markers, field tables) disagreeing with the `.em` model no longer needs an agent's judgment to
// catch. Real fs fixtures via mkdtempSync, same convention as test/lineageValidate.test.ts and
// test/noteBindingValidate.test.ts — this check reads slices/*.md off disk too.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateDocModelConsistency } from "../src/catalog/docModelConsistencyValidate.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-doc-model-consistency-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes a slice doc at `slices/<key>.md` with usable frontmatter (schemaVersion/pattern/
 *  swimlane/status/version, the five keys `hasUsableFrontmatter()` requires) plus whatever extra
 *  frontmatter/body text the test needs. */
function writeDoc(key: string, opts: { pattern?: string; extraFrontmatter?: string; body?: string } = {}): void {
  const pattern = opts.pattern ?? "state-change";
  writeFileSync(
    join(dir, "slices", `${key}.md`),
    `---\nschemaVersion: 1\npattern: ${pattern}\nswimlane: order\nstatus: draft\nversion: 1\n${opts.extraFrontmatter ?? ""}---\n${opts.body ?? "# Slice\n"}`,
  );
}

function diagsOf(src: string) {
  const { model, refs } = compile(src);
  return validateDocModelConsistency(model, refs, dir);
}

describe("doc-model-pattern-mismatch", () => {
  it("warns when frontmatter pattern disagrees with the deterministic classification", () => {
    writeDoc("checkout", { pattern: "state-view" }); // model below is state-change (command+event)
    const diags = diagsOf(
      [
        'slice "Checkout" {',
        '  command Checkout note "slices/checkout.md"',
        "  event Checked Out @Order",
        "}",
      ].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "doc-model-pattern-mismatch", refs: ["checkout"] }),
    );
  });

  it("is silent when frontmatter pattern agrees", () => {
    writeDoc("checkout-ok", { pattern: "state-change" });
    const diags = diagsOf(
      [
        'slice "Checkout Ok" {',
        '  command Checkout Ok note "slices/checkout-ok.md"',
        "  event Checked Out Ok @Order",
        "}",
      ].join("\n"),
    );
    expect(diags.filter((d) => d.code === "doc-model-pattern-mismatch")).toEqual([]);
  });
});

describe("doc-model-element-not-in-model", () => {
  it("warns when the doc's Command marker names a command the model doesn't have", () => {
    writeDoc("place-order", {
      body: ["# Slice", "## Command / Input", "**Command:** `Place The Order`", ""].join("\n"),
    });
    const diags = diagsOf(
      ['slice "Place Order" {', '  command Submit Order note "slices/place-order.md"', "}"].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "doc-model-element-not-in-model",
        refs: ["place-order"],
        message: expect.stringContaining("Place The Order"),
      }),
    );
  });

  it("warns when the doc's Event marker names an event the model doesn't have", () => {
    writeDoc("pay", {
      body: ["# Slice", "## Event(s) Emitted", "**Event:** `Payment Captured` → context `Billing`", ""].join("\n"),
    });
    const diags = diagsOf(
      ['slice "Pay" {', '  command Pay note "slices/pay.md"', "  event Payment Made @Billing", "}"].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "doc-model-element-not-in-model", refs: ["pay"] }),
    );
  });

  it("warns when the doc's View marker names a view the model doesn't have", () => {
    writeDoc("dashboard", {
      body: ["# Slice", "## Read Model / View", '- **View:** `Order Summary` built from events: "Ordered"', ""].join(
        "\n",
      ),
    });
    const diags = diagsOf(
      ['slice "Dashboard" {', '  view Order Detail from "Ordered" note "slices/dashboard.md"', "}"].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({ code: "doc-model-element-not-in-model", refs: ["dashboard"] }),
    );
  });
});

describe("doc-model-element-not-in-doc", () => {
  it("warns when the model has a command the doc's Command markers don't mention", () => {
    writeDoc("refund", {
      body: ["# Slice", "## Command / Input", "**Command:** `Issue Refund`", ""].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "Refund" {',
        '  command Issue Refund note "slices/refund.md"',
        "  command Cancel Refund",
        "}",
      ].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "doc-model-element-not-in-doc",
        message: expect.stringContaining("Cancel Refund"),
      }),
    );
  });
});

describe("kind-not-declared silence", () => {
  it("a doc with zero View markers is silent about the model's views (partial/draft docs are normal)", () => {
    writeDoc("cart", {
      body: ["# Slice", "## Command / Input", "**Command:** `Update Cart`", ""].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "Cart" {',
        '  command Update Cart note "slices/cart.md"',
        "  event Cart Updated @Cart",
        "}",
      ].join("\n"),
    );
    // The doc has a Command marker (matches, so command is silent too) but zero View markers —
    // the view kind must stay entirely silent even though nothing in the doc mentions views at
    // all. (This slice has no view anyway; the point is that a *missing kind of marker* never
    // produces a finding by itself.)
    expect(diags).toEqual([]);
  });
});

describe("doc-model-field-mismatch", () => {
  const table = (rows: string) =>
    ["| Field | Type | Required | Rules / Validation |", "|-------|------|----------|--------------------|", rows].join(
      "\n",
    );

  it("warns on a field the doc declares that the model command doesn't have", () => {
    writeDoc("order", {
      body: [
        "# Slice",
        "## Command / Input",
        "**Command:** `Place Order`",
        "",
        table("| total | Money | yes | positive |\n| coupon | Text | no | |"),
        "",
      ].join("\n"),
    });
    const diags = diagsOf(
      ['slice "Order" {', '  command Place Order { total: Money } note "slices/order.md"', "}"].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "doc-model-field-mismatch",
        message: expect.stringContaining("coupon"),
      }),
    );
  });

  it("warns on a field the model command has that the doc's table doesn't list", () => {
    writeDoc("order2", {
      body: ["# Slice", "## Command / Input", "**Command:** `Place Order`", "", table("| total | Money | yes | |"), ""].join(
        "\n",
      ),
    });
    const diags = diagsOf(
      [
        'slice "Order2" {',
        '  command Place Order { total: Money, memo: Text } note "slices/order2.md"',
        "}",
      ].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "doc-model-field-mismatch",
        message: expect.stringContaining("memo"),
      }),
    );
  });

  it("warns on a type mismatch for a field both sides declare", () => {
    writeDoc("order3", {
      body: ["# Slice", "## Command / Input", "**Command:** `Place Order`", "", table("| total | Int | yes | |"), ""].join(
        "\n",
      ),
    });
    const diags = diagsOf(
      ['slice "Order3" {', '  command Place Order { total: Money } note "slices/order3.md"', "}"].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "doc-model-field-mismatch",
        message: expect.stringMatching(/Money.*Int|Int.*Money/),
      }),
    );
  });

  it("is silent when both sides declare exactly the same fields and types (case-insensitive)", () => {
    writeDoc("order4", {
      body: ["# Slice", "## Command / Input", "**Command:** `Place Order`", "", table("| total | money | yes | |"), ""].join(
        "\n",
      ),
    });
    const diags = diagsOf(
      ['slice "Order4" {', '  command Place Order { total: Money } note "slices/order4.md"', "}"].join("\n"),
    );
    expect(diags.filter((d) => d.code === "doc-model-field-mismatch")).toEqual([]);
  });
});

describe("fields-absent silence", () => {
  it("no field finding when the doc's Command marker has no field table at all", () => {
    writeDoc("bare-cmd", {
      body: ["# Slice", "## Command / Input", "**Command:** `Do Thing`", ""].join("\n"),
    });
    const diags = diagsOf(
      ['slice "Bare Cmd" {', '  command Do Thing { total: Money } note "slices/bare-cmd.md"', "}"].join("\n"),
    );
    expect(diags.filter((d) => d.code === "doc-model-field-mismatch")).toEqual([]);
  });

  it("no field finding when the model command declares no fields at all", () => {
    writeDoc("bare-model", {
      body: [
        "# Slice",
        "## Command / Input",
        "**Command:** `Do Thing`",
        "",
        "| Field | Type | Required | Rules / Validation |",
        "|-------|------|----------|--------------------|",
        "| total | Money | yes | |",
        "",
      ].join("\n"),
    });
    const diags = diagsOf(
      ['slice "Bare Model" {', '  command Do Thing note "slices/bare-model.md"', "}"].join("\n"),
    );
    expect(diags.filter((d) => d.code === "doc-model-field-mismatch")).toEqual([]);
  });
});

describe("unbound-slice silence", () => {
  it("produces no diagnostics for a slice with no note binding at all", () => {
    const diags = diagsOf(['slice "Unbound" {', "  command Do Thing", "}"].join("\n"));
    expect(diags).toEqual([]);
  });
});

describe("frontmatter-unusable silence", () => {
  it("produces no diagnostics when the bound doc's frontmatter is missing a required key", () => {
    writeFileSync(
      join(dir, "slices", "half-baked.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: draft\n---\n" +
        "# Slice\n## Command / Input\n**Command:** `Nonexistent`\n",
    );
    const diags = diagsOf(
      ['slice "Half Baked" {', '  command Do Thing note "slices/half-baked.md"', "}"].join("\n"),
    );
    expect(diags).toEqual([]);
  });
});

describe("MIL-121 cross-covered doc, checked against the union", () => {
  it("passes when the covering doc's rosters agree with the union of both slices' elements", () => {
    writeDoc("detect-unpaid-orders", {
      pattern: "automation",
      extraFrontmatter: "covers: detect-unpaid-orders-view\n",
      body: [
        "# Slice",
        "## Command / Input",
        "**Command:** `Send Reminder`",
        "## Read Model / View",
        '- **View:** `Unpaid Orders` built from events: "Order Placed"',
        "",
      ].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "Detect Unpaid Orders View" {',
        '  view Unpaid Orders from "Order Placed" note "slices/detect-unpaid-orders.md"',
        "}",
        'slice "Detect Unpaid Orders" {',
        "  processor Detect Unpaid Orders",
        '  command Send Reminder note "slices/detect-unpaid-orders.md"',
        "  event Reminder Sent @Billing",
        "}",
      ].join("\n"),
    );
    expect(diags).toEqual([]);
  });

  it("flags a genuine mismatch against the union: the covering doc's Command marker misnames the reaction slice's real command", () => {
    writeDoc("cover-mismatch", {
      pattern: "automation",
      extraFrontmatter: "covers: cover-mismatch-view\n",
      body: [
        "# Slice",
        "## Command / Input",
        "**Command:** `Notify Customer`", // doesn't match the model's actual command name below
        "## Read Model / View",
        '- **View:** `Unpaid Orders` built from events: "Order Placed"',
        "",
      ].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "Cover Mismatch View" {',
        '  view Unpaid Orders from "Order Placed" note "slices/cover-mismatch.md"',
        "}",
        'slice "Cover Mismatch" {',
        "  processor Detect Unpaid",
        '  command Send Reminder note "slices/cover-mismatch.md"',
        "  event Reminder Sent @Billing",
        "}",
      ].join("\n"),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "doc-model-element-not-in-doc",
        message: expect.stringContaining("Send Reminder"),
      }),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        code: "doc-model-element-not-in-model",
        message: expect.stringContaining("Notify Customer"),
      }),
    );
  });
});
