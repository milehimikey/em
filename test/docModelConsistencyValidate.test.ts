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
import { buildSliceRegions, splitCells } from "../src/catalog/sliceSections.js";
import { buildSliceDocContent } from "../src/cli/sliceNew.js";

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

// MIL-266: generated regions and the authored `### Scenario:` grammar.
describe("slice-doc/structured-section-malformed (MIL-266)", () => {
  it("warns — with no refs, so it never blocks --slice-ready by itself — on an unbalanced region", () => {
    writeDoc("unbalanced", {
      body: ["# Slice", "## Command / Input", "<!-- GENERATED:em-slice-command:start -->", "**Command:** `Do It`", ""].join("\n"),
    });
    const diags = diagsOf(['slice "Unbalanced" {', '  command Do It note "slices/unbalanced.md"', "}"].join("\n"));
    expect(diags.filter((d) => d.code === "slice-doc/structured-section-malformed")).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: 'slice doc "slices/unbalanced.md" (slice "unbalanced"): region "em-slice-command" has no end marker',
      }),
    ]);
    expect(diags.find((d) => d.code === "slice-doc/structured-section-malformed")!.refs).toBeUndefined();
  });

  it("warns on a `### Scenario:` block missing a beat", () => {
    writeDoc("half-scenario", {
      body: ["# Slice", "## Scenarios (Given / When / Then)", "### Scenario: Pay", "- **Given:** a", "- **When:** b", ""].join("\n"),
    });
    const diags = diagsOf(['slice "Half Scenario" {', '  command Pay note "slices/half-scenario.md"', "}"].join("\n"));
    expect(diags.filter((d) => d.code === "slice-doc/structured-section-malformed").map((d) => d.message)).toEqual([
      'slice doc "slices/half-scenario.md" (slice "half-scenario"): scenario "Pay" has no **Then:** — every `### Scenario:` block needs Given, When and Then bullets',
    ]);
  });

  it("is silent on a 1.13-style free-prose doc (no markers, no `### Scenario:`), with a hand-written view table", () => {
    writeDoc("legacy-prose", {
      pattern: "state-view",
      body: [
        "# Slice",
        "## Read Model / View",
        "- **View:** `Legacy List` built from events: x",
        "",
        "| Field | Type | Source / Notes |",
        "|---|---|---|",
        "| notInTheModel | string | prose |",
        "## Scenarios (Given / When / Then)",
        "- **Happy path**",
        "  - **Given:** a",
      ].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "Legacy Prose" {',
        '  view Legacy List from "Thing Happened" note "slices/legacy-prose.md" {',
        "    total: decimal",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(diags.filter((d) => d.code === "slice-doc/structured-section-malformed" || d.code === "doc-model-field-mismatch")).toEqual([]);
  });

  it("compares a view's field table only inside a generated em-slice-view region", () => {
    writeDoc("view-region", {
      pattern: "state-view",
      body: [
        "# Slice",
        "## Read Model / View",
        "<!-- GENERATED:em-slice-view:start -->",
        "- **View:** `Region List` built from events: x",
        "",
        "| Field | Type | Source / Notes |",
        "|-------|------|----------------|",
        "| stale | string | {{ }} |",
        "<!-- GENERATED:em-slice-view:end -->",
      ].join("\n"),
    });
    const diags = diagsOf(
      [
        'slice "View Region" {',
        '  view Region List from "Thing Happened" note "slices/view-region.md" {',
        "    total: decimal",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(diags.filter((d) => d.code === "doc-model-field-mismatch").map((d) => d.message)).toEqual([
      'slice doc "slices/view-region.md"\'s view `Region List` field table lists "stale", but view "Region List" (slice "View Region") has no such field',
      'view "Region List" (slice "View Region") has field "total", but slice doc "slices/view-region.md"\'s view `Region List` field table doesn\'t list it',
    ]);
  });
});

describe("table cells honour the \\| escape (MIL-285)", () => {
  it("splitCells splits on unescaped pipes only and unescapes \\| in a cell", () => {
    expect(splitCells('| resolution | "refund" \\| "cancel" | yes |')).toEqual(["resolution", '"refund" | "cancel"', "yes"]);
  });

  it("splitCells still reads a plain pipe-free row", () => {
    expect(splitCells("| orderId | string | yes |")).toEqual(["orderId", "string", "yes"]);
  });

  it("a freshly synced doc with inline-union fields on a command, event and view has no doc-model diagnostics", () => {
    const src = [
      'slice "Resolve Order" {',
      '  command ResolveOrder note "slices/resolve-order.md" {',
      "    orderId: string",
      '    resolution: "refund" | "cancel" | "write_off"',
      "  }",
      '  event OrderResolved @Order { resolution: "refund" | "cancel" | "write_off" }',
      '  view ResolvedOrders { resolution: "refund" | "cancel" | "write_off" }',
      "}",
    ].join("\n");
    const { model, refs } = compile(src);
    const regions = buildSliceRegions(model, [0]);
    const doc = buildSliceDocContent("Resolve Order", "resolve-order", "state-change", "Order", regions);
    expect(doc).toContain('"refund" \\| "cancel" \\| "write_off"');
    writeFileSync(join(dir, "slices", "resolve-order.md"), doc);
    const diags = validateDocModelConsistency(model, refs, dir).filter((d) => d.code.startsWith("doc-model"));
    expect(diags).toEqual([]);
  });
});

describe("GH #294 doc-names-unfed-event / doc-omits-fed-event", () => {
  const viewDoc = (rows: string[], scenarioThen = "Owner Tools lists the tool") =>
    [
      "# Slice",
      "## Read Model / View",
      "<!-- GENERATED:em-slice-view:start -->",
      '- **View:** `Owner Tools` built from events: "Tool Listed"',
      "",
      "| Field | Type | Source / Notes |",
      "|-------|------|----------------|",
      ...rows,
      "<!-- GENERATED:em-slice-view:end -->",
      "## Scenarios",
      "### Scenario: Listed",
      "- **Given:** Tool Listed",
      "- **When:** the owner opens the page",
      `- **Then:** ${scenarioThen}`,
      "",
    ].join("\n");
  const toolshed = (from: string) =>
    [
      'slice "Owner Tools" {',
      `  view Owner Tools from ${from} note "slices/owner-tools.md"`,
      "}",
      'slice "Return Tool" {',
      "  command Return Tool",
      "  event Tool Returned @Tool",
      "  event Tool Listed @Tool",
      "}",
    ].join("\n");

  it("toolshed case: Source column anticipates an event the view does not read", () => {
    writeDoc("owner-tools", { pattern: "state-view", body: viewDoc(["| status | string | from event `Tool Returned` |"]) });
    const diags = diagsOf(toolshed('"Tool Listed"')).filter((d) => d.code === "doc-names-unfed-event");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "warning", refs: ["owner-tools", expect.any(String)] });
    expect(diags[0].message).toContain("Tool Returned");
  });

  it("flags an unfed event named in a scenario Then", () => {
    writeDoc("owner-tools", { pattern: "state-view", body: viewDoc(["| status | string | from event `Tool Listed` |"], "Tool Returned is reflected") });
    const diags = diagsOf(toolshed('"Tool Listed"')).filter((d) => d.code === "doc-names-unfed-event");
    expect(diags).toHaveLength(1);
  });

  it("is clean once the model feeds the view that event", () => {
    writeDoc("owner-tools", {
      pattern: "state-view",
      body: viewDoc(["| status | string | from event `Tool Returned` |", "| listed | bool | from event `Tool Listed` |"]),
    });
    const diags = diagsOf(toolshed('"Tool Listed", "Tool Returned"'));
    expect(diags.filter((d) => d.code === "doc-names-unfed-event" || d.code === "doc-omits-fed-event")).toEqual([]);
  });

  it("counts events fed through an again instance", () => {
    writeDoc("owner-tools", { pattern: "state-view", body: viewDoc(["| status | string | from event `Tool Returned` |"]) });
    const src = [
      'slice "Owner Tools" {',
      '  view Owner Tools from "Tool Listed" note "slices/owner-tools.md"',
      "}",
      'slice "Return Tool" {',
      "  command Return Tool",
      "  event Tool Returned @Tool",
      "  event Tool Listed @Tool",
      "}",
      'slice "Owner Tools Again" {',
      '  view Owner Tools again from "Tool Returned"',
      "}",
    ].join("\n");
    expect(diagsOf(src).filter((d) => d.code === "doc-names-unfed-event")).toEqual([]);
  });

  it("hints when the model feeds an event the doc never mentions", () => {
    writeDoc("owner-tools", { pattern: "state-view", body: "# Slice\n- **View:** `Owner Tools`\n" });
    const diags = diagsOf(toolshed('"Tool Listed"')).filter((d) => d.code === "doc-omits-fed-event");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Tool Listed");
    expect(diags[0].refs).toEqual(["owner-tools", expect.any(String)]);
  });

  it("omits hint compares against the bound instance only: a doc bound to an again instance is not flagged for the other instances' events", () => {
    writeDoc("tool-returned-view", {
      pattern: "state-view",
      body: "# Slice\n- **View:** `Owner Tools` built from events: \"Tool Returned\"\n",
    });
    const src = [
      'slice "Owner Tools" {',
      '  view Owner Tools from "Tool Listed"',
      "}",
      'slice "Return Tool" {',
      "  command Return Tool",
      "  event Tool Returned @Tool",
      "  event Tool Listed @Tool",
      "}",
      'slice "Tool Returned View" {',
      '  view Owner Tools again from "Tool Returned" note "slices/tool-returned-view.md"',
      "}",
    ].join("\n");
    expect(diagsOf(src).filter((d) => d.code === "doc-omits-fed-event")).toEqual([]);
  });
});

describe("GH #294 real-estate shapes (toolshed)", () => {
  // Shape of toolshed's slices/see-my-loans.md: hand-written view marker, built-from prose with a
  // "Later instances add" tail, a Source column that never names the event, scenarios in the older
  // bullet format, and a `## Delta` with a `##### Scenario:` block.
  const seeMyLoans = [
    "# Slice: See My Loans",
    "## Read Model / View",
    '- **View:** `My Loans` built from events: "Tool Checked Out" (this instance). Later instances',
    '  add "Loan Marked Overdue", "Tool Returned".',
    "- **Consumed by:** screen `My Loans` @Borrower",
    "",
    "| Field | Type | Source / Notes |",
    "|-------|------|----------------|",
    "| loanId | UUID | `Tool Checked Out.loanId` |",
    "| status | String | `open` after checkout; later instances set `overdue`, then remove the row on return. |",
    "",
    "## Scenarios (Given / When / Then)",
    "- **Happy path**",
    "  - **Given:** `Tool Checked Out` T1",
    "  - **When:** the borrower opens My Loans",
    "  - **Then:** one row.",
    "",
    "## Delta",
    "##### Scenario: Borrower sees the loan leave",
    "- **Given:** `Tool Checked Out` T1; `Tool Returned` T1",
    "- **When:** the borrower opens My Loans",
    "- **Then:** no row for T1.",
    "",
  ].join("\n");
  const model = (extra: string) =>
    [
      'slice "See My Loans" {',
      '  view My Loans from "Tool Checked Out" note "slices/see-my-loans.md"',
      "}",
      'slice "Loan Lifecycle" {',
      "  command Check Out Tool",
      "  event Tool Checked Out @Loan",
      "  event Loan Marked Overdue @Loan",
      "  event Tool Returned @Loan",
      "}",
      extra,
    ].join("\n");

  it("fires on the built-from prose and Delta text of the toolshed doc when the model lacks the edge", () => {
    writeDoc("see-my-loans", { pattern: "state-view", body: seeMyLoans });
    const diags = diagsOf(model("")).filter((d) => d.code === "doc-names-unfed-event");
    const returned = diags.filter((d) => d.message.includes('"Tool Returned"'));
    expect(returned).toHaveLength(1);
    // reports the first mention (the prose, body line 4 + 7 frontmatter lines), not the marker
    expect(returned[0].message).toMatch(/line 11\)/);
  });

  it("is clean once an again instance feeds Tool Returned and Loan Marked Overdue", () => {
    writeDoc("see-my-loans", { pattern: "state-view", body: seeMyLoans });
    const src = model('slice "Loan Leaves" {\n  view My Loans again from "Loan Marked Overdue", "Tool Returned"\n}');
    expect(diagsOf(src).filter((d) => d.code === "doc-names-unfed-event")).toEqual([]);
  });

  it("does not attribute a Delta/Then event to a longer-named event it is a substring of", () => {
    writeDoc("see-my-loans", {
      pattern: "state-view",
      body: seeMyLoans.replace('"Tool Returned".', '"Tool Returned Late".'),
    });
    const src = [
      model(""),
      'slice "Late" {',
      "  event Tool Returned Late @Loan",
      "}",
    ].join("\n");
    const msgs = diagsOf(src)
      .filter((d) => d.code === "doc-names-unfed-event")
      .map((d) => d.message);
    expect(msgs.some((m) => m.includes('names event "Tool Returned Late"'))).toBe(true);
  });

  it("automation doc with a to-do view: its command's Given/Then events are not attributed to the view", () => {
    writeDoc("fulfil-order", {
      pattern: "automation",
      body: [
        "# Slice",
        "## Read Model / View",
        '- **View:** `Orders To Fulfil` built from events: "Order Paid"',
        "## Scenarios",
        "### Scenario: paid order is fulfilled",
        "- **Given:** `Order Placed` O1; `Order Paid` O1",
        "- **When:** the fulfiller runs",
        "- **Then:** `Order Fulfilled` O1",
        "",
      ].join("\n"),
    });
    const src = [
      'slice "Place Order" {\n  command Place Order\n  event Order Placed @Order\n}',
      'slice "Pay" {\n  command Pay\n  event Order Paid @Order\n}',
      'slice "Fulfil Order" {',
      '  view Orders To Fulfil from "Order Paid" note "slices/fulfil-order.md"',
      "  processor Fulfiller",
      "  command Fulfil Order",
      "  event Order Fulfilled @Order",
      "}",
    ].join("\n");
    expect(diagsOf(src).filter((d) => d.code === "doc-names-unfed-event")).toEqual([]);
  });

  it("state-change doc that covers a view slice: its command scenarios are not attributed to the view", () => {
    writeDoc("place-order-covers", {
      pattern: "state-change",
      extraFrontmatter: "covers: order-list\n",
      body: [
        "# Slice",
        "## Command / Input",
        "**Command:** `Place Order`",
        "## Read Model / View",
        '- **View:** `Order List` built from events: "Order Placed"',
        "## Scenarios",
        "### Scenario: registered customer places an order",
        "- **Given:** `Customer Registered` C1",
        "- **When:** `Place Order` by C1",
        "- **Then:** `Order Placed` O1",
        "",
      ].join("\n"),
    });
    const src = [
      'slice "Register Customer" {\n  command Register Customer\n  event Customer Registered @Customer\n}',
      'slice "Place Order Covers" {',
      '  command Place Order note "slices/place-order-covers.md"',
      "  event Order Placed @Order",
      "}",
      'slice "Order List" {',
      '  view Order List from "Order Placed" note "slices/place-order-covers.md"',
      "}",
    ].join("\n");
    expect(diagsOf(src).filter((d) => d.code === "doc-names-unfed-event")).toEqual([]);
  });
});

describe("GH #294 wrapped scenario lines", () => {
  it("reads an event named on a wrapped (indented, non-bullet) Given continuation line", () => {
    writeDoc("wrapped-page", {
      pattern: "state-view",
      body: [
        "# Slice",
        "## Read Model / View",
        '- **View:** `Wrapped Tools` built from events: "Tool Listed"',
        "## Scenarios",
        "- **After a withdrawal**",
        "  - **Given:** `Tool Listed` T1; plenty of",
        "    context, then `Tool Delisted` T1",
        "  - **When:** the owner opens the page",
        "  - **Then:** empty.",
        "",
      ].join("\n"),
    });
    const src = [
      'slice "Wrapped Page" {',
      '  view Wrapped Tools from "Tool Listed" note "slices/wrapped-page.md"',
      "}",
      'slice "Lifecycle" {',
      "  command Delist Tool",
      "  event Tool Listed @Tool",
      "  event Tool Delisted @Tool",
      "}",
    ].join("\n");
    const msgs = diagsOf(src)
      .filter((d) => d.code === "doc-names-unfed-event")
      .map((d) => d.message);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('"Tool Delisted"');
  });
});
