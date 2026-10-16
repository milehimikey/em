// SPDX-License-Identifier: MIT
// GH #240: `em engagement foundation` — per event the engagement's slices emit or consume, is the
// foundation (implement.md §8) in the code: the event's identifier, its fields, its tag fields?
// Three distinguishable answers — present / incomplete (which field, which tag) / missing-event —
// over a fake target tree, through the builder and through the CLI.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildNewEngagement, buildUnitIndex } from "../src/cli/engagement.js";
import { engagementPath } from "../src/cli/engagementFile.js";
import { checkFoundation, formatFoundationText, identifierVariants } from "../src/cli/engagementFoundation.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const READY = "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n---\n# Slice\n\n## Intent\n\nbody\n";
const MODEL = [
  'slice "Place Order" {',
  "  ui Checkout Screen @Customer",
  '  command Place Order note "slices/place-order.md"',
  "  event Order Placed @Orders { orderId tag, customerId, total }",
  "}",
  'slice "Cancel Order" {',
  "  ui Cancel Screen @Customer",
  '  command Cancel Order note "slices/cancel-order.md"',
  "  event Order Cancelled @Orders { orderId tag, reason }",
  "}",
  'slice "Ship Order" {',
  "  ui Warehouse Screen @Clerk",
  '  command Ship Order note "slices/ship-order.md"',
  "  event Order Shipped @Orders { orderId, carrier }", // no tag in the model
  "}",
  'slice "Order List" {',
  '  view Orders from "Order Placed", "Order Cancelled", "Order Shipped" note "slices/order-list.md"',
  "  ui Orders Screen @Customer",
  "}",
  "",
].join("\n");

let dir: string;
let code: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-foundation-"));
  mkdirSync(join(dir, "slices"));
  for (const k of ["place-order", "cancel-order", "ship-order", "order-list"]) writeFileSync(join(dir, "slices", `${k}.md`), READY);
  writeFileSync(join(dir, "orders.em"), MODEL);
  code = join(dir, "repo");
  mkdirSync(join(code, "src", "orders"), { recursive: true });
  mkdirSync(join(code, "node_modules", "junk"), { recursive: true });
  // Order Placed: complete. Order Cancelled: present but missing `reason` and the tag field is there. Order Shipped: absent
  // (only a mention under node_modules, which must not count).
  writeFileSync(join(code, "src", "orders", "events.kt"), "data class OrderPlaced(val orderId: String, val customerId: String, val total: Money)\n");
  writeFileSync(join(code, "src", "orders", "cancel.ts"), "export interface OrderCancelled { orderId: string }\n");
  writeFileSync(join(code, "node_modules", "junk", "x.js"), "// OrderShipped lives here only by accident\n");
  writeFileSync(join(code, "src", "orders", "blob.bin"), Buffer.from([0, 1, 2, 3]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function input() {
  const file = join(dir, "orders.em");
  const { model, refs } = compile(readFileSync(file, "utf8"));
  return { file, model, refs, baseDir: dir };
}
function create(slug: string, keys: string[]) {
  const inp = input();
  const r = buildNewEngagement({ ...inp }, { slug, selector: { kind: "slices", keys }, parallel: 3, createdBy: "Alex", tracking: null, created: "2026-10-08" });
  if (!r.ok) throw new Error(r.message);
  mkdirSync(join(dir, "engagements"), { recursive: true });
  writeFileSync(engagementPath(inp.file, slug), r.text);
}

describe("identifierVariants", () => {
  it("derives the naming variants an implementer would plausibly write", () => {
    expect(identifierVariants("Order Placed")).toEqual(["OrderPlaced", "orderPlaced", "order_placed", "ORDER_PLACED", "order-placed", "Order Placed"]);
    expect(identifierVariants("orderId")).toEqual(["OrderId", "orderId", "order_id", "ORDER_ID", "order-id"]);
    expect(identifierVariants("  ")).toEqual([]);
  });
});

describe("checkFoundation", () => {
  it("present / incomplete (named field) / missing-event, scoped to the engagement's emitted + consumed events; node_modules and binaries ignored", () => {
    const inp = input();
    const idx = buildUnitIndex(inp.model, inp.refs, inp.baseDir);
    const c = checkFoundation(inp.model, ["place-order", "cancel-order", "ship-order"], idx, code);
    expect(c.scannedFiles).toBe(2); // events.kt + cancel.ts — node_modules skipped, blob.bin binary
    expect(c.events.map((e) => [e.event, e.status, e.emittedBy, e.missingFields, e.missingTagFields, e.untaggedInModel])).toEqual([
      ["Order Placed", "present", "place-order", [], [], false],
      ["Order Cancelled", "incomplete", "cancel-order", ["reason"], [], false],
      ["Order Shipped", "missing-event", "ship-order", [], [], true],
    ]);
    expect(c.events[0].files).toEqual(["src/orders/events.kt"]);
    expect(c.counts).toEqual({ present: 1, incomplete: 1, missingEvent: 1 });
    expect(c.ok).toBe(false);
    const text = formatFoundationText("all", c);
    expect(text).toContain("  present        Order Placed (emitted by place-order) — src/orders/events.kt");
    expect(text).toContain("  incomplete     Order Cancelled (emitted by cancel-order) — src/orders/cancel.ts — missing-field: reason");
    expect(text).toContain("  missing-event  Order Shipped (emitted by ship-order)");
    expect(text).toContain("foundation absent for 1 event(s), incomplete for 1 event(s) (1 present)");
  });

  it("a consuming slice pulls in events emitted outside the engagement; a missing tag field is its own gap; ok when everything is present", () => {
    writeFileSync(join(code, "src", "orders", "cancel.ts"), "export interface OrderCancelled { reason: string }\n"); // field present, tag field gone
    const inp = input();
    const idx = buildUnitIndex(inp.model, inp.refs, inp.baseDir);
    const c = checkFoundation(inp.model, ["order-list"], idx, code);
    expect(c.events.map((e) => [e.event, e.status, e.emittedBy, e.consumedBy])).toEqual([
      ["Order Placed", "present", null, ["order-list"]],
      ["Order Cancelled", "incomplete", null, ["order-list"]],
      ["Order Shipped", "missing-event", null, ["order-list"]],
    ]);
    expect(c.events[1].missingTagFields).toEqual(["orderId"]);
    expect(formatFoundationText("v", c)).toContain("consumed only (order-list)");
    expect(formatFoundationText("v", c)).toContain("missing-tag: orderId");
    const only = checkFoundation(inp.model, ["place-order"], idx, code);
    expect(only.ok).toBe(true);
    expect(formatFoundationText("p", only)).toContain("ok — the foundation holds every event these slices need (1 present)");
  });

  it("matches snake_case and SCREAMING variants too, on word boundaries", () => {
    writeFileSync(join(code, "src", "orders", "events.kt"), "ORDER_PLACED = 'order.placed'; order_id; customer_id; TOTAL\n");
    const inp = input();
    const idx = buildUnitIndex(inp.model, inp.refs, inp.baseDir);
    expect(checkFoundation(inp.model, ["place-order"], idx, code).events[0]).toMatchObject({ status: "present", missingFields: [], missingTagFields: [] });
    writeFileSync(join(code, "src", "orders", "events.kt"), "class PreOrderPlacedX { orderId; customerId; total }\n"); // not a word-boundary match
    expect(checkFoundation(inp.model, ["place-order"], idx, code).events[0].status).toBe("missing-event");
  });
});

describe("em engagement foundation (CLI)", () => {
  it("text + exit 1 on gaps, --json carries the schema, --code must be a directory, unknown engagement refused", () => {
    create("all", ["place-order", "cancel-order", "ship-order"]);
    const r = em(["engagement", "foundation", "orders.em", "all", "--code", "repo"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("missing-event  Order Shipped");
    const j = JSON.parse(em(["engagement", "foundation", "orders.em", "all", "--code", "repo", "--json"], dir).stdout);
    expect(j.engagementFoundationSchemaVersion).toBe("1.0");
    expect(j.counts).toEqual({ present: 1, incomplete: 1, missingEvent: 1 });
    expect(j.ok).toBe(false);
    create("one", ["place-order"]);
    expect(em(["engagement", "foundation", "orders.em", "one", "--code", "repo"], dir).status).toBe(0);
    const bad = em(["engagement", "foundation", "orders.em", "one", "--code", "nope"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--code nope is not a directory");
    const missing = em(["engagement", "foundation", "orders.em", "ghost", "--code", "repo"], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("em engagement foundation:");
  }, 60_000);
});
