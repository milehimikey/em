// SPDX-License-Identifier: MIT
// GH #530: the state file's `Code roots:` bullet read as the default place in `self` — and the
// two things that must not move: a project with no code map, and `em system scope`'s
// `code-spans-seam`, which reads the same bullet.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { codeRootPlaces } from "../src/codemap/codeRoots.js";
import { parseCodeRoots } from "../src/system/scope.js";

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
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Staff
}
`;
const STATE = (roots: string) => `# Event modeling state\n\n- **Model file:** \`shop.em\`\n- **Code roots:** ${roots}\n`;

describe("Code roots as the default place (GH #530)", () => {
  let root: string;
  let dir: string;
  const write = (name: string, text: string | null) => (text === null ? rmSync(join(dir, name), { force: true }) : writeFileSync(join(dir, name), text));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "em-code-roots-"));
    mkdirSync(join(root, ".git"));
    dir = join(root, "models", "shop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shop.em"), MODEL);
    writeFileSync(join(root, "system.yaml"), `systemSchemaVersion: "2.1"\nrepos:\n  storefront-web: {remote: "git@github.com:acme/storefront-web.git"}\nmodels:\n  shop: {source: models/shop/shop.em}\n`);
  });
  afterAll(() => rmTemp(root));

  it("codeRootPlaces: one place in self per root, as parseCodeRoots reads the bullet", () => {
    write(".event-modeling.md", STATE("`services/orders/`, ./services/billing, services/orders, ../outside"));
    expect(parseCodeRoots(STATE("`services/orders/`, ./services/billing"))).toEqual(["services/orders", "services/billing"]);
    expect(codeRootPlaces(join(dir, "shop.em"))).toEqual([
      { repo: "self", root: "services/orders" },
      { repo: "self", root: "services/billing" },
    ]);
    write(".event-modeling.md", STATE("none"));
    expect(codeRootPlaces(join(dir, "shop.em"))).toEqual([]);
    write(".event-modeling.md", null);
    expect(codeRootPlaces(join(dir, "shop.em"))).toEqual([]);
  });

  it("no code map: Code roots change nothing in the export or in em validate", () => {
    write("code-map.yaml", null);
    write(".event-modeling.md", null);
    const without = em(["export", "shop.em"], dir).stdout;
    write(".event-modeling.md", STATE("services/orders"));
    const withRoots = em(["export", "shop.em"], dir).stdout;
    expect(withRoots).toBe(without);
    expect(withRoots).not.toContain('"places"');
    expect(em(["validate", "shop.em"], dir).stdout).toContain("ok");
  });

  it("a code map with no default: Code roots place what no rule does, in self", () => {
    write(".event-modeling.md", STATE("services/orders, services/billing"));
    write("code-map.yaml", `codeMapSchemaVersion: "1.0"\npersonas:\n  Customer: {repo: storefront-web}\n`);
    expect(em(["validate", "shop.em"], dir).status).toBe(0);
    const doc = JSON.parse(em(["export", "shop.em"], dir).stdout);
    const roots = [{ repo: "self", root: "services/orders" }, { repo: "self", root: "services/billing" }];
    expect(doc.model.slices[0].elements.map((e: any) => [e.ref, e.places, e.placedBy])).toEqual([
      ["place-order/ui.checkout", [{ repo: "storefront-web", root: "" }], "persona"],
      ["place-order/command.place-order", roots, "code-roots"],
      ["place-order/event.order-placed", roots, "code-roots"],
    ]);
    // Two roots in one repository are two places in one repository.
    expect(doc.model.slices[1].places).toEqual(roots);
    expect(doc.model.places).toEqual([{ repo: "storefront-web", root: "" }, ...roots]);
  });

  it("the map's own default wins over Code roots", () => {
    write(".event-modeling.md", STATE("services/orders"));
    write("code-map.yaml", `codeMapSchemaVersion: "1.0"\ndefault: {root: apps/shop}\n`);
    const doc = JSON.parse(em(["export", "shop.em"], dir).stdout);
    expect(doc.model.places).toEqual([{ repo: "self", root: "apps/shop" }]);
    expect(doc.model.slices[0].elements[1].placedBy).toBe("default");
  });

  it("no default and no Code roots: the element is unplaced, and the message names both fixes", () => {
    write(".event-modeling.md", STATE("none"));
    write("code-map.yaml", `codeMapSchemaVersion: "1.0"\npersonas:\n  Customer: {repo: storefront-web}\n`);
    const r = em(["validate", "shop.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("give the map a `default:` (or the state file a `Code roots:` bullet)");
  });
});
