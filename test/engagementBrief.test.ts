// SPDX-License-Identifier: MIT
// GH #454: `em engagement brief` — a deterministic, self-contained per-slice work brief for
// implementers em does not control. Covers the pure builder (src/cli/engagementBrief.ts) against
// a bespoke fixture exercising every section (bound doc verbatim, no-doc fallback, cross-unit
// model context, a repeated view instance, the public-contract surface, the bindings-manifest
// skeleton, context documents pointer/inline/missing), then the CLI wiring (--slice selection and
// its refusal, --json, --inline-context, determinism).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildNewEngagement } from "../src/cli/engagement.js";
import { engagementPath } from "../src/cli/engagementFile.js";
import { EngagementBriefModelInput, buildBindingsExample, engagementBriefFor, formatEngagementBriefText } from "../src/cli/engagementBrief.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const PLACE_ORDER_DOC = [
  "---",
  "schemaVersion: 1",
  "pattern: state-change",
  "swimlane: Orders",
  "status: ready-to-implement",
  "version: 1",
  "ratifiedBy: Alex Rivera",
  "---",
  "# Slice: Place Order",
  "",
  "## Invariants / Business Rules",
  "- INV-PO-1: an order must have at least one line item",
  "",
  "## Scenarios",
  "",
  "### Scenario: happy path",
  "- **Given:**",
  "  - a cart with one item",
  "- **When:**",
  "  - the shopper places the order",
  "- **Then:**",
  "  - Order Placed is emitted",
  "",
].join("\n");

const MODEL = [
  'model "Checkout"',
  "",
  "persona Shopper",
  "context Orders",
  "",
  'slice "Place Order" {',
  "  ui Checkout Screen @Shopper",
  '  command Place Order note "slices/place-order.md"',
  "  event Order Placed @Orders public",
  "}",
  "",
  'slice "Order List" {',
  '  view Order List from "Order Placed"',
  "  ui Orders Screen @Shopper",
  "}",
  "",
  // A second, later instance of the Order List view, read again from a different event, in its
  // own textual slice — folds into the `order-list` unit (MIL-208): the "repeated view instance"
  // the model-context section names.
  'slice "Order List Again" {',
  '  view Order List again from "Order Shipped"',
  "  ui Orders Screen Again @Shopper",
  "}",
  "",
  'slice "Ship Order" {',
  "  ui Warehouse Screen @Shopper",
  '  command Ship Order note "slices/ship-order.md"',
  "  event Order Shipped @Orders",
  "}",
  "",
].join("\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-brief-"));
  mkdirSync(join(dir, "slices"));
  writeFileSync(join(dir, "slices", "place-order.md"), PLACE_ORDER_DOC);
  writeFileSync(join(dir, "checkout.em"), MODEL);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function input(): EngagementBriefModelInput {
  const file = join(dir, "checkout.em");
  const { model, refs } = compile(readFileSync(file, "utf8"));
  return { file, model, refs, baseDir: dir };
}

/** Writes `engagements/<slug>.md` selecting `keys`, with the given `context` (absolute paths —
 *  `buildContextDoc`'s fs check runs in-process against whatever the test runner's cwd happens to
 *  be, so a relative path here would be flaky; the CLI-level tests below use relative paths under
 *  a fixed `cwd`, the realistic case). */
function create(slug: string, keys: string[], opts: { tracking?: string; context?: string[] } = {}) {
  const inp = input();
  const r = buildNewEngagement(inp, { slug, selector: { kind: "slices", keys }, parallel: 3, createdBy: "Alex Rivera", tracking: opts.tracking ?? null, context: opts.context ?? null, created: "2026-11-06" });
  if (!r.ok) throw new Error(r.message);
  mkdirSync(join(dir, "engagements"), { recursive: true });
  writeFileSync(engagementPath(inp.file, slug), r.text);
}

describe("engagementBriefFor (builder)", () => {
  it("the spec section embeds the bound doc verbatim, with the header facts resolved like `plan`", () => {
    create("demo", ["place-order", "order-list", "ship-order"], { tracking: "PROJ-1" });
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.brief.slices.find((x) => x.key === "place-order")!;
    expect(s.sliceName).toBe("Place Order");
    expect(s.tracking).toBe("PROJ-1");
    expect(s.prTitle).toBe("PROJ-1: Place Order");
    expect(s.branch).toBe("impl/place-order");
    expect(s.base).toBe("main");
    expect(s.ledgerState).toBe("planned");
    expect(s.ledgerBranch).toBeNull();
    expect(s.doc.found).toBe(true);
    expect(s.doc.path).toBe(join(dir, "slices", "place-order.md"));
    expect(s.doc.content).toContain("## Invariants / Business Rules");
    expect(s.doc.content).toContain("### Scenario: happy path");
    expect(s.fallbackElements).toBeNull();
  });

  it("surfaces the Ledger's own recorded branch/base/pr once `em engagement set` has written them", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    em(["engagement", "set", "checkout.em", "demo", "place-order", "--state", "review", "--branch", "impl/place-order", "--base", "main", "--pr", "https://example.test/pr/9"], dir);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.brief.slices.find((x) => x.key === "place-order")!;
    expect(s).toMatchObject({ ledgerState: "review", ledgerBranch: "impl/place-order", ledgerBase: "main", ledgerPr: "https://example.test/pr/9" });
  });

  it("no bound doc: loudly flags it and lists the slice's own elements/fields instead", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.brief.slices.find((x) => x.key === "order-list")!;
    expect(s.doc).toEqual({ found: false, path: null, content: null });
    expect(s.fallbackElements).toEqual([
      { ref: "view.order-list", kind: "view", name: "Order List", public: false, fields: [] },
      { ref: "ui.orders-screen", kind: "ui", name: "Orders Screen", public: false, fields: [] },
    ]);
    const text = formatEngagementBriefText(r.brief);
    const section = text.slice(text.indexOf('Work brief: demo / order-list'));
    expect(section).toContain('NO BOUND DOC FOUND for slice "order-list"');
    expect(section).toContain("| view | Order List | no |");
  });

  it("model context: consumes/produces are cross-unit only, folded through the `again` instance, plus the repeated view", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const placeOrder = r.brief.slices.find((x) => x.key === "place-order")!;
    expect(placeOrder.modelContext.consumes).toEqual([]);
    expect(placeOrder.modelContext.produces).toEqual([{ ref: "order-list/view.order-list", kind: "view", name: "Order List", unit: "order-list" }]);
    expect(placeOrder.modelContext.neighborUnits).toEqual(["order-list"]);

    const orderList = r.brief.slices.find((x) => x.key === "order-list")!;
    // Both the original view's source event AND the event the `again` instance reads — the
    // instance folds into this unit (MIL-208), so its own `from` is this unit's consumption too.
    expect(orderList.modelContext.consumes).toEqual([
      { ref: "place-order/event.order-placed", kind: "event", name: "Order Placed", unit: "place-order" },
      { ref: "ship-order/event.order-shipped", kind: "event", name: "Order Shipped", unit: "ship-order" },
    ]);
    expect(orderList.modelContext.repeatedViews).toEqual([{ view: "Order List", instances: ["order-list-again"] }]);

    const shipOrder = r.brief.slices.find((x) => x.key === "ship-order")!;
    // Ship Order's event is read by the `again` instance, which folds into the order-list unit.
    expect(shipOrder.modelContext.produces).toEqual([{ ref: "order-list-again/view.order-list", kind: "view", name: "Order List", unit: "order-list" }]);
  });

  it("contract surface: public-touching names the contract path and public elements; a non-public slice says so", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const placeOrder = r.brief.slices.find((x) => x.key === "place-order")!;
    expect(placeOrder.contract.publicTouching).toBe(true);
    expect(placeOrder.contract.contractPath).toBe(join(dir, "contracts", "checkout.tsp"));
    expect(placeOrder.contract.publicElements).toEqual([{ ref: "event.order-placed", kind: "event", name: "Order Placed", public: true, fields: [] }]);

    const orderList = r.brief.slices.find((x) => x.key === "order-list")!;
    expect(orderList.contract).toEqual({ publicTouching: false, contractPath: null, publicElements: [] });
  });

  it("definition of done: invariant/scenario ids from the doc, a filled bindings skeleton, and the exact conform-check line", () => {
    create("demo", ["place-order", "order-list", "ship-order"], { tracking: "PROJ-1" });
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.brief.slices.find((x) => x.key === "place-order")!;
    expect(s.definitionOfDone.invariantIds).toEqual(["INV-PO-1"]);
    expect(s.definitionOfDone.scenarioTitles).toEqual(["happy path"]);
    expect(s.definitionOfDone.bindingsPath).toBe(join(dir, "conformance", "bindings", "place-order.yaml"));
    expect(s.definitionOfDone.bindingsExample).toBe(
      [
        'bindingsSchemaVersion: "1.0"',
        "slice: place-order",
        "elements:",
        "  - ref: ui.checkout-screen",
        "    file: TODO",
        "    identifier: TODO",
        "  - ref: command.place-order",
        "    file: TODO",
        "    identifier: TODO",
        "  - ref: event.order-placed",
        "    file: TODO",
        "    identifier: TODO",
        "invariants:",
        "  - id: INV-PO-1",
        "    enforcedIn: {file: TODO, identifier: TODO}",
        "    testedIn: {file: TODO, identifier: TODO}",
      ].join("\n"),
    );
    expect(s.definitionOfDone.conformCheckCommand).toBe(`em conform bindings check ${join(dir, "checkout.em")} --repo <path-to-target-repo> --slice place-order --exit-code`);
    expect(s.definitionOfDone.prTitle).toBe("PROJ-1: Place Order");
  });

  it("a slice with no invariants/doc: the bindings skeleton still parses as a valid empty-list shape", () => {
    expect(buildBindingsExample("order-list", [], [])).toBe('bindingsSchemaVersion: "1.0"\nslice: order-list\nelements:\n  []\ninvariants:\n  []');
  });

  it("context documents: pointer by default, absent entirely when the engagement has none", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const s of r.brief.slices) expect(s.context).toEqual([]);
    expect(r.brief.inlineContext).toBe(false);
  });

  it("context documents: --inline-context embeds found text and loudly flags a missing file, never throwing", () => {
    const foundPath = join(dir, "constitution.md");
    writeFileSync(foundPath, "# Constitution\n\nBe kind.\n");
    const missingPath = join(dir, "does-not-exist.md");
    create("demo", ["place-order"], { context: [foundPath, missingPath] });
    const r = engagementBriefFor(input(), "demo", { inlineContext: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.inlineContext).toBe(true);
    const s = r.brief.slices[0];
    expect(s.context).toEqual([
      { path: foundPath, inline: true, content: "# Constitution\n\nBe kind.\n", missing: false },
      { path: missingPath, inline: true, content: null, missing: true },
    ]);
    const text = formatEngagementBriefText(r.brief);
    expect(text).toContain("<!-- BEGIN CONTEXT: " + foundPath + " -->\n# Constitution");
    expect(text).toContain(`MISSING: context document "${missingPath}" was not found on disk`);
  });

  it("--slice narrows to exactly one brief, in any of the resolver's accepted forms", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo", { sliceKey: "order-list" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.brief.slices.map((s) => s.key)).toEqual(["order-list"]);
  });

  it("an unknown --slice is refused the same way `em engagement set` refuses it", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo", { sliceKey: "ghost" });
    expect(r).toEqual({ ok: false, message: 'slice "ghost" is not in engagement "demo"' });
  });

  it("refuses a missing engagement the same way `plan` does, with no partial brief", () => {
    const r = engagementBriefFor(input(), "ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no engagement "ghost"');
  });

  it("refuses when the engagement names a slice the model no longer has", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    writeFileSync(join(dir, "checkout.em"), MODEL.replace('slice "Ship Order"', 'slice "Ship Order Renamed"'));
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("ship-order");
  });

  it("is deterministic: two builds from the same inputs produce the same object and the same text", () => {
    create("demo", ["place-order", "order-list", "ship-order"], { tracking: "PROJ-1" });
    const a = engagementBriefFor(input(), "demo");
    const b = engagementBriefFor(input(), "demo");
    expect(a).toEqual(b);
    if (a.ok && b.ok) expect(formatEngagementBriefText(a.brief)).toBe(formatEngagementBriefText(b.brief));
  });

  it("without --slice, multiple briefs are self-contained and separated by a plain rule, in model order", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const r = engagementBriefFor(input(), "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = formatEngagementBriefText(r.brief);
    const headers = [...text.matchAll(/^# Work brief: demo \/ (\S+) —/gm)].map((m) => m[1]);
    expect(headers).toEqual(["place-order", "order-list", "ship-order"]);
    expect(text).toContain("=".repeat(72));
  });
});

describe("em engagement brief (CLI, GH #454)", () => {
  it("text mode prints one self-contained brief per slice; --slice narrows it; unknown --slice refuses", () => {
    create("demo", ["place-order", "order-list", "ship-order"]);
    const all = em(["engagement", "brief", "checkout.em", "demo"], dir);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("Work brief: demo / place-order");
    expect(all.stdout).toContain("Work brief: demo / order-list");
    expect(all.stdout).toContain("Work brief: demo / ship-order");

    // GH #237: a display name resolves too.
    const one = em(["engagement", "brief", "checkout.em", "demo", "--slice", "Order List"], dir);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("Work brief: demo / order-list");
    expect(one.stdout).not.toContain("Work brief: demo / place-order");

    const bad = em(["engagement", "brief", "checkout.em", "demo", "--slice", "ghost"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('em engagement brief: slice "ghost" is not in engagement "demo"\n');
  });

  it("--json prints the versioned document with slices[] (length 1 when --slice narrows it), byte-deterministic", () => {
    create("demo", ["place-order", "order-list", "ship-order"], { tracking: "PROJ-1" });
    const r1 = em(["engagement", "brief", "checkout.em", "demo", "--json"], dir);
    const r2 = em(["engagement", "brief", "checkout.em", "demo", "--json"], dir);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toBe(r2.stdout);
    const doc = JSON.parse(r1.stdout);
    expect(doc.engagementBriefSchemaVersion).toBe("1.0");
    expect(doc.slices).toHaveLength(3);
    expect(doc.slices.map((s: { key: string }) => s.key)).toEqual(["place-order", "order-list", "ship-order"]);

    const narrowed = em(["engagement", "brief", "checkout.em", "demo", "--slice", "place-order", "--json"], dir);
    const narrowedDoc = JSON.parse(narrowed.stdout);
    expect(narrowedDoc.slices).toHaveLength(1);
    expect(narrowedDoc.slices[0].key).toBe("place-order");
  });

  it("--inline-context embeds a found file's text and marks a missing one, relative to the cwd it runs from", () => {
    writeFileSync(join(dir, "constitution.md"), "# Constitution\n\nBe kind.\n");
    create("demo", ["place-order"], { context: ["constitution.md", "missing.md"] });
    const r = em(["engagement", "brief", "checkout.em", "demo", "--inline-context"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Context documents (inlined: --inline-context)");
    expect(r.stdout).toContain("<!-- BEGIN CONTEXT: constitution.md -->\n# Constitution");
    expect(r.stdout).toContain('MISSING: context document "missing.md" was not found on disk');

    const pointerMode = em(["engagement", "brief", "checkout.em", "demo"], dir);
    expect(pointerMode.stdout).toContain("## Context documents\n\n- constitution.md\n- missing.md");
    expect(pointerMode.stdout).not.toContain("BEGIN CONTEXT");
  });
});
