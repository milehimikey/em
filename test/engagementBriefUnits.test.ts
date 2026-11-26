// SPDX-License-Identifier: MIT
// GH #538: `em engagement brief` per work unit — its own elements and place, sibling units as
// read-only context, binding entries to hand back — and the slice brief of a model with no code
// map, which must not move.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { createMultiRepoProject, MultiRepoProject } from "./helpers/multiRepoProject.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web, root: src/checkout}\n`;

describe("em engagement brief per work unit (GH #538)", () => {
  let p: MultiRepoProject;
  let before: { text: string; json: string };
  const brief = (...args: string[]) => em(["engagement", "brief", "shop.em", "all", ...args], p.modelDir);

  beforeAll(() => {
    p = createMultiRepoProject(["web", "orders", "payments"]);
    expect(em(["engagement", "new", "shop.em", "all", "--slices", "place-order,open-orders,take-payment,cancel-order"], p.modelDir).status).toBe(0);
    // Layout 1 baseline, taken before any code map exists.
    before = { text: brief().stdout, json: brief("--json").stdout };
    p.setCodeMap(MAP);
  });
  afterAll(() => rmTemp(p.base));

  it("one brief per work unit: a two-repo slice has two, a one-repo slice has one", () => {
    const doc = JSON.parse(brief("--json").stdout);
    expect(doc.engagementBriefSchemaVersion).toBe("1.1");
    expect(doc.slices.map((s: any) => s.unit.id)).toEqual([
      "place-order@web",
      "place-order@orders",
      "open-orders@orders",
      "take-payment@orders",
      "cancel-order@web",
      "cancel-order@orders",
    ]);
  });

  it("layout 3: the frontend unit's brief — its element, its place, the sibling as context, entries to hand back", () => {
    const doc = JSON.parse(brief("--slice", "place-order", "--unit", "web", "--json").stdout);
    expect(doc.slices).toHaveLength(1);
    const u = doc.slices[0].unit;
    expect(u).toMatchObject({ id: "place-order@web", repo: "web", roots: ["src/checkout"], marker: "Em-Unit: shop:place-order@web", dependsOn: [], closingStep: "close:place-order" });
    expect(u.elements.map((e: any) => e.ref)).toEqual(["ui.checkout"]);
    expect(u.siblings).toEqual([
      { id: "place-order@orders", repo: "orders", roots: [""], elements: [expect.objectContaining({ ref: "command.place-order" }), expect.objectContaining({ ref: "event.order-placed", public: true })] },
    ]);
    expect(u.bindingsHandBack).toBe("elements:\n  - ref: ui.checkout\n    repo: web\n    file: TODO\n    identifier: TODO");

    const text = brief("--slice", "place-order", "--unit", "web").stdout;
    expect(text).toContain('# Work brief: all / place-order@web — "Place Order"');
    expect(text).toContain("- Work unit: `place-order@web` — the part of slice `place-order` that lives in repository `web`, under `src/checkout`");
    expect(text).toContain("- PR body must carry this line, exactly: `Em-Unit: shop:place-order@web`");
    expect(text).toContain("- Branch: `impl/place-order` on `main`, in repository `web`");
    expect(text).toContain("## Your unit");
    expect(text).toContain("- ui `Checkout` (ui.checkout)");
    expect(text).toContain("- `place-order@orders` in `orders`: command `Place Order`, event `Order Placed`");
    expect(text).toContain("Build in parallel with them, against the slice's contract");
    expect(text).toContain("**Hand back your binding entries; do not commit a bindings file.**");
    expect(text).toContain("written once, by the closing step `close:place-order`");
    expect(text).toContain("- Unit isolation: Touch nothing outside this unit's place: repository `web`, under `src/checkout`.");
    // The whole slice's spec is still there, and the slice-level bindings recipe is not.
    expect(text).toContain("<!-- BEGIN SPEC -->");
    expect(text).not.toContain("Then verify: `em conform bindings check");
  });

  it("no public surface: the caller's brief says what it waits for", () => {
    const text = brief("--slice", "cancel-order", "--unit", "web").stdout;
    expect(text).toContain("This unit waits for `cancel-order@orders`: the slice has no `public` element");
    expect(JSON.parse(brief("--slice", "cancel-order", "--unit", "web", "--json").stdout).slices[0].unit.dependsOn).toEqual(["cancel-order@orders"]);
  });

  it("layout 2: a slice in one code repo is one unit, told it is the only one", () => {
    const text = brief("--slice", "open-orders").stdout;
    expect(text).toContain('# Work brief: all / open-orders@orders — "Open Orders"');
    expect(text).toContain("This is the slice's only work unit.");
    expect(text).toContain("under the repository root");
  });

  it("a recorded unit shows its own Ledger record", () => {
    expect(em(["engagement", "set", "shop.em", "all", "place-order", "--unit", "web", "--state", "review", "--pr", "https://github.com/acme/web/pull/12"], p.modelDir).status).toBe(0);
    const doc = JSON.parse(brief("--slice", "place-order", "--json").stdout);
    expect(doc.slices.map((s: any) => [s.unit.id, s.ledgerState, s.ledgerPr])).toEqual([
      ["place-order@web", "review", "https://github.com/acme/web/pull/12"],
      ["place-order@orders", "planned", null],
    ]);
  });

  it("a slice none of whose elements is placed has no brief, and the command says why instead of printing nothing", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\npersonas:\n  Customer: {repo: web}\n`);
    try {
      const r = brief("--slice", "take-payment");
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain('slice "take-payment" has no work unit — code-map.yaml places none of its elements');
    } finally {
      p.setCodeMap(MAP);
    }
  });

  it("--unit: no such unit is refused; with no code map it is refused too", () => {
    const none = brief("--slice", "open-orders", "--unit", "web");
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('--unit web: no work unit in repo "web" for slice "open-orders"');
  });

  it("layout 1: with no code map the brief is byte-identical apart from the version", () => {
    rmSync(join(p.modelDir, "code-map.yaml"));
    // The Ledger changed above (place-order has unit records); compare the slices it did not touch.
    const pick = (text: string, key: string) => text.split(`\n\n${"=".repeat(72)}\n\n`).find((b) => b.startsWith(`# Work brief: all / ${key} `))!;
    for (const key of ["open-orders", "take-payment", "cancel-order"]) expect(pick(brief().stdout, key)).toBe(pick(before.text, key));
    const now = JSON.parse(brief("--json").stdout);
    const was = JSON.parse(before.json);
    expect(now.engagementBriefSchemaVersion).toBe("1.1");
    expect(was.engagementBriefSchemaVersion).toBe("1.1");
    expect(now.slices.filter((s: any) => s.key !== "place-order")).toEqual(was.slices.filter((s: any) => s.key !== "place-order"));
    expect(now.slices.every((s: any) => s.unit === undefined)).toBe(true);
    const r = brief("--unit", "web");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the model has no code-map.yaml, so every slice is one unit — drop --unit");
  });
});
