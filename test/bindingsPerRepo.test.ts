// SPDX-License-Identifier: MIT
// GH #532: `em conform bindings check` across repositories — each binding looked for in the
// checkout of its own repo — and the single-repository case, which must not move.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const MODEL = `model "Shop"
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Orders
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Staff
}
`;
const SYSTEM = `systemSchemaVersion: "2.1"\nrepos:\n  web: {remote: "git@github.com:acme/web.git"}\n  orders: {remote: "git@github.com:acme/orders.git"}\nmodels:\n  shop: {source: shop/shop.em}\n`;
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web}\n`;
const SPLIT = `bindingsSchemaVersion: "1.1"\nslice: place-order\nelements:\n  - {ref: ui.checkout, repo: web, file: src/Checkout.tsx, identifier: CheckoutPage}\n  - {ref: command.place-order, repo: orders, file: src/Handler.kt, identifier: placeOrder}\n`;
const ONE_REPO = `bindingsSchemaVersion: "1.0"\nslice: open-orders\nelements:\n  - {ref: view.open-orders, file: src/OpenOrders.kt, identifier: OpenOrders}\n`;

describe("em conform bindings check across repositories (GH #532)", () => {
  // <base>/model (system.yaml, shop/shop.em), <base>/web, <base>/orders — siblings.
  let base: string;
  let modelRepo: string;
  let dir: string;
  const bind = (name: string, text: string | null) =>
    text === null ? rmSync(join(dir, "conformance", "bindings", name), { force: true }) : writeFileSync(join(dir, "conformance", "bindings", name), text);

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "em-bind-repos-")));
    modelRepo = join(base, "model");
    dir = join(modelRepo, "shop");
    for (const r of ["model", "web", "orders"]) {
      mkdirSync(join(base, r), { recursive: true });
      gitInitQuiet(join(base, r), "-b", "main");
    }
    mkdirSync(join(dir, "conformance", "bindings"), { recursive: true });
    writeFileSync(join(dir, "shop.em"), MODEL);
    writeFileSync(join(modelRepo, "system.yaml"), SYSTEM);
    mkdirSync(join(base, "web", "src"));
    writeFileSync(join(base, "web", "src", "Checkout.tsx"), "export function CheckoutPage() {}\n");
    mkdirSync(join(base, "orders", "src"));
    writeFileSync(join(base, "orders", "src", "Handler.kt"), "fun placeOrder() {}\n");
    writeFileSync(join(base, "orders", "src", "OpenOrders.kt"), "class OpenOrders\n");
  });
  afterAll(() => rmTemp(base));

  it("layout 3: a slice bound in two repos passes with no flags, each binding found in its own sibling checkout", () => {
    writeFileSync(join(dir, "code-map.yaml"), MAP);
    bind("place-order.yaml", SPLIT);
    bind("open-orders.yaml", ONE_REPO);
    const r = em(["conform", "bindings", "check", "shop.em", "--exit-code"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[ok] ui.checkout -> web:src/Checkout.tsx ("CheckoutPage")');
    expect(r.stdout).toContain('[ok] command.place-order -> orders:src/Handler.kt ("placeOrder")');
    // No `repo:` on the binding: the slice's one repository, from the code map.
    expect(r.stdout).toContain('[ok] view.open-orders -> orders:src/OpenOrders.kt ("OpenOrders")');
    const doc = JSON.parse(em(["conform", "bindings", "check", "shop.em", "--json"], dir).stdout);
    expect(doc.bindingsCheckSchemaVersion).toBe("1.1");
    expect(doc.files.map((f: any) => f.elements.map((e: any) => [e.ref, e.repo, e.repoResolved, e.ok]))).toEqual([
      [["view.open-orders", "orders", true, true]],
      [["ui.checkout", "web", true, true], ["command.place-order", "orders", true, true]],
    ]);
  });

  it("a binding looked for in the wrong repo fails as file not found there", () => {
    bind("place-order.yaml", SPLIT.replace("repo: orders, file: src/Handler.kt", "repo: web, file: src/Handler.kt"));
    const r = em(["conform", "bindings", "check", "shop.em", "--slice", "place-order", "--exit-code"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[FAIL] command.place-order -> web:src/Handler.kt ("placeOrder") — file not found');
  });

  it("a binding with no repo in a slice whose code is in two repos says so", () => {
    bind("place-order.yaml", `bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - {ref: command.place-order, file: src/Handler.kt, identifier: placeOrder}\n`);
    const doc = JSON.parse(em(["conform", "bindings", "check", "shop.em", "--slice", "place-order", "--json"], dir).stdout);
    expect(doc.files[0].elements[0]).toMatchObject({ repo: null, repoResolved: false, ok: false });
    const text = em(["conform", "bindings", "check", "shop.em", "--slice", "place-order"], dir).stdout;
    expect(text).toContain("names no repo, and the slice's code is in several (web, orders) — add `repo:` to the binding");
    bind("place-order.yaml", SPLIT);
  });

  it("a repo with no checkout is a failed binding with that reason, never a clone; --repo <id>=<path> supplies it", () => {
    const elsewhere = join(base, "elsewhere-web");
    mkdirSync(join(elsewhere, "src"), { recursive: true });
    writeFileSync(join(elsewhere, "src", "Checkout.tsx"), "export function CheckoutPage() {}\n");
    const moved = join(base, "web-moved");
    spawnSync("mv", [join(base, "web"), moved]);
    try {
      const r = em(["conform", "bindings", "check", "shop.em", "--slice", "place-order", "--exit-code"], dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`[FAIL] ui.checkout -> web:src/Checkout.tsx ("CheckoutPage") — repo "web" has no checkout here at ${join(base, "web")}`);
      expect(r.stdout).toContain("em does not clone");
      expect(r.stdout).toContain("[ok] command.place-order -> orders:src/Handler.kt");
      // A plain directory is enough: this check never runs git.
      const ok = em(["conform", "bindings", "check", "shop.em", "--slice", "place-order", "--exit-code", "--repo", `web=${elsewhere}`], dir);
      expect(ok.status).toBe(0);
    } finally {
      spawnSync("mv", [moved, join(base, "web")]);
    }
  });

  it("an undeclared repo id on a binding is reported as undeclared", () => {
    bind("place-order.yaml", SPLIT.replace("repo: web", "repo: mobile"));
    const r = em(["conform", "bindings", "check", "shop.em", "--slice", "place-order"], dir);
    expect(r.stdout).toContain('repo "mobile" is not declared under `repos:` in system.yaml');
    bind("place-order.yaml", SPLIT);
  });

  it("a bare --repo names the one repo in play, and is refused when there are two", () => {
    const one = em(["conform", "bindings", "check", "shop.em", "--slice", "open-orders", "--exit-code", "--repo", join(base, "orders")], dir);
    expect(one.status).toBe(0);
    const two = em(["conform", "bindings", "check", "shop.em", "--repo", join(base, "orders")], dir);
    expect(two.status).toBe(1);
    expect(two.stderr).toContain("this model's code is in 2 repositories (web, orders), so a bare path is ambiguous");
  });

  it("layout 2: no bindings repo: at all, a code map with one default repo, and the check finds the code repo by itself", () => {
    writeFileSync(join(dir, "code-map.yaml"), `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\n`);
    bind("place-order.yaml", null);
    const r = em(["conform", "bindings", "check", "shop.em", "--exit-code"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[ok] view.open-orders -> orders:src/OpenOrders.kt");
  });

  it("layout 1: no code map and no repo: — the document is 1.0's apart from the version, with or without --repo", () => {
    rmSync(join(dir, "code-map.yaml"), { force: true });
    bind("place-order.yaml", null);
    bind("open-orders.yaml", ONE_REPO);
    const withFlag = em(["conform", "bindings", "check", "shop.em", "--repo", join(base, "orders"), "--json"], dir);
    const doc = JSON.parse(withFlag.stdout);
    expect(doc).toEqual({
      bindingsCheckSchemaVersion: "1.1",
      slice: null,
      ok: true,
      files: [
        {
          path: "conformance/bindings/open-orders.yaml",
          slice: "open-orders",
          kind: "checked",
          ok: true,
          errors: [],
          elements: [{ ref: "view.open-orders", file: "src/OpenOrders.kt", identifier: "OpenOrders", note: null, knownRef: true, fileExists: true, identifierFound: true, ok: true }],
          invariants: [],
        },
      ],
      summary: { filesChecked: 1, filesOk: 1, filesFailed: 0, elementsChecked: 1, elementsOk: 1, elementsFailed: 0, invariantsChecked: 0, invariantsOk: 0, invariantsFailed: 0 },
    });
    expect(em(["conform", "bindings", "check", "shop.em", "--repo", join(base, "orders")], dir).stdout).toContain('[ok] view.open-orders -> src/OpenOrders.kt ("OpenOrders")');
    // No --repo: the model's own repository (it used to be a required option).
    mkdirSync(join(modelRepo, "src"), { recursive: true });
    writeFileSync(join(modelRepo, "src", "OpenOrders.kt"), "class OpenOrders\n");
    expect(em(["conform", "bindings", "check", "shop.em", "--exit-code"], dir).status).toBe(0);
  });
});
