// SPDX-License-Identifier: MIT
// GH #529: derived places in `em export` (schema 1.23) and `em query slices` (schema 1.4) — and
// the rule that a model with no code map publishes none of it, byte for byte.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const MODEL = `model "Shop"
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Orders
}
slice "Orders To Charge" {
  view Orders To Charge from "Order Placed"
  ui Charge Queue @Staff
}
slice "Take Payment" {
  processor Charge Card from "Orders To Charge"
  command Take Payment
  event Payment Taken @Payments
}
slice "Charged Orders" {
  view Orders To Charge again from "Payment Taken"
  ui Payments Board @Staff
}
`;
const SYSTEM = `systemSchemaVersion: "2.1"\nrepos:\n  storefront-web: {remote: "git@github.com:acme/storefront-web.git"}\n  payments-svc: {remote: "git@github.com:acme/payments-svc.git"}\nmodels:\n  shop: {source: models/shop/shop.em}\n`;
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {root: services/orders}\npersonas:\n  Customer: {repo: storefront-web, root: src/checkout}\ncontexts:\n  Payments: {repo: payments-svc}\n`;

const ORDERS = { repo: "self", root: "services/orders" };
const WEB = { repo: "storefront-web", root: "src/checkout" };
const PAY = { repo: "payments-svc", root: "" };

describe("derived places (GH #529)", () => {
  let root: string;
  let dir: string;
  const mapPath = () => join(dir, "code-map.yaml");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "em-places-"));
    mkdirSync(join(root, ".git"));
    dir = join(root, "models", "shop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shop.em"), MODEL);
    writeFileSync(join(root, "system.yaml"), SYSTEM);
  });
  afterAll(() => rmTemp(root));

  it("no code map: export and query carry no places key at all", () => {
    rmSync(mapPath(), { force: true });
    const text = em(["export", "shop.em"], dir).stdout;
    expect(JSON.parse(text).schemaVersion).toBe("1.23");
    expect(text).not.toContain('"places"');
    expect(text).not.toContain('"placedBy"');
    const q = em(["query", "slices", "shop.em", "--json"], dir).stdout;
    expect(JSON.parse(q).querySchemaVersion).toBe("1.4");
    expect(q).not.toContain('"places"');
    expect(Object.keys(JSON.parse(q).args)).toEqual(["pattern", "status", "context", "persona", "tag", "storyline"]);
    expect(em(["query", "slices", "shop.em", "--repo", "self"], dir).stdout.trim()).toBe("(none)");
  });

  it("with a code map: adding it changes nothing in the export but the four new keys", () => {
    rmSync(mapPath(), { force: true });
    const before = JSON.parse(em(["export", "shop.em"], dir).stdout);
    writeFileSync(mapPath(), MAP);
    const after = JSON.parse(em(["export", "shop.em"], dir).stdout);
    const strip = (doc: any) => {
      delete doc.model.places;
      for (const s of doc.model.slices) {
        delete s.places;
        for (const e of s.elements) {
          delete e.places;
          delete e.placedBy;
        }
      }
      return doc;
    };
    expect(after.model.places).toEqual([WEB, ORDERS, PAY]);
    expect(strip(after)).toEqual(before);
  });

  it("export: element, slice and model places, and the rule that placed each element", () => {
    writeFileSync(mapPath(), MAP);
    const doc = JSON.parse(em(["export", "shop.em"], dir).stdout);
    const slice = (key: string) => doc.model.slices.find((s: { key: string }) => s.key === key);
    expect(slice("place-order").places).toEqual([WEB, ORDERS]);
    expect(slice("place-order").elements.map((e: any) => [e.ref, e.places, e.placedBy])).toEqual([
      ["place-order/ui.checkout", [WEB], "persona"],
      ["place-order/command.place-order", [ORDERS], "default"],
      ["place-order/event.order-placed", [ORDERS], "default"],
    ]);
    // The Automation slice: the processor lives with its trigger, the command with its event.
    expect(slice("take-payment").places).toEqual([ORDERS, PAY]);
    expect(slice("take-payment").elements.map((e: any) => e.placedBy)).toEqual(["reads", "context", "context"]);
    expect(slice("charged-orders").places).toEqual([ORDERS]);
    // New keys come last on each object.
    expect(Object.keys(slice("place-order")).slice(-2)).toEqual(["elements", "places"]);
    expect(Object.keys(slice("place-order").elements[0]).slice(-2)).toEqual(["places", "placedBy"]);
    expect(Object.keys(doc.model).slice(-1)).toEqual(["places"]);
    // --slice carries the same slice object.
    const one = JSON.parse(em(["export", "shop.em", "--slice", "take-payment"], dir).stdout);
    expect(JSON.stringify(one)).toContain(JSON.stringify(slice("take-payment").places));
  });

  it("export: an unplaced element exports [] and null; the model still exports", () => {
    writeFileSync(mapPath(), `codeMapSchemaVersion: "1.0"\ncontexts:\n  Payments: {repo: payments-svc}\n`);
    const r = em(["export", "shop.em"], dir);
    expect(r.status).toBe(0);
    const el = JSON.parse(r.stdout).model.slices[0].elements[0];
    expect([el.places, el.placedBy]).toEqual([[], null]);
  });

  it("export: a code map that does not parse publishes no places and says why in diagnostics", () => {
    writeFileSync(mapPath(), `codeMapSchemaVersion: "1.0"\ndefault: {repo: payments-svc, path: x}\n`);
    const r = em(["export", "shop.em"], dir);
    // Like a doc-join problem, it does not block the export: `em validate` is the gate.
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('"places"');
    expect(JSON.parse(r.stdout).diagnostics).toEqual([
      { severity: "error", code: "code-map-invalid", message: 'code-map.yaml: `default`: unknown key "path" — expected repo, root', line: 2, refs: [] },
    ]);
    expect(em(["validate", "shop.em"], dir).status).toBe(1);
  });

  it("query slices --repo with a code map that does not parse is an error, not (none)", () => {
    writeFileSync(mapPath(), `codeMapSchemaVersion: "1.0"\ndefault: {repo: payments-svc, path: x}\n`);
    const r = em(["query", "slices", "shop.em", "--repo", "payments-svc"], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("code-map.yaml: `default`: unknown key \"path\"");
    // Without --repo the query does not depend on the map and still answers.
    expect(em(["query", "slices", "shop.em"], dir).status).toBe(0);
  });

  it("query slices: places on each result, in text and --json, and --repo filters", () => {
    writeFileSync(mapPath(), MAP);
    const doc = JSON.parse(em(["query", "slices", "shop.em", "--json"], dir).stdout);
    expect(doc.results.map((r: any) => [r.ref, r.places])).toEqual([
      ["place-order", [WEB, ORDERS]],
      ["orders-to-charge", [ORDERS]],
      ["take-payment", [ORDERS, PAY]],
      ["charged-orders", [ORDERS]],
    ]);
    const pay = JSON.parse(em(["query", "slices", "shop.em", "--repo", "payments-svc", "--json"], dir).stdout);
    expect(pay.args.repo).toBe("payments-svc");
    expect(pay.results.map((r: any) => r.ref)).toEqual(["take-payment"]);
    expect(em(["query", "slices", "shop.em", "--repo", "storefront-web"], dir).stdout.trim()).toBe(
      'place-order  "Place Order"  pattern=state-change status=no-doc personas=[Customer] contexts=[Orders] places=[storefront-web:src/checkout, self:services/orders]',
    );
    expect(em(["query", "slices", "shop.em", "--repo", "nowhere"], dir).stdout.trim()).toBe("(none)");
  });
});
