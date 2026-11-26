// SPDX-License-Identifier: MIT
// GH #536: the unit graph in `em engagement plan` — work units (slice × repo), closing steps,
// `dependsOn` / `partOf` — one acceptance scenario per layout.
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
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

type Unit = { state: string; pr: string | null; id: string; kind: string; partOf: string; repo: string; roots: string[]; elements: string[]; level: number; branch: string; base: string; prTitle: string; marker: string; dependsOn: string[] };

describe("the unit graph in em engagement plan (GH #536)", () => {
  let p: MultiRepoProject;
  const plan = (): { engagementPlanSchemaVersion: string; units?: Unit[]; slices: { key: string }[]; preflight: { kind: string; message: string }[] } =>
    JSON.parse(em(["engagement", "plan", "shop.em", "all", "--json"], p.modelDir).stdout);
  const unitsOf = (key: string): Unit[] => (plan().units ?? []).filter((u) => u.partOf === key);

  beforeAll(() => {
    p = createMultiRepoProject(["web", "orders", "payments"]);
    const made = em(["engagement", "new", "shop.em", "all", "--slices", "place-order,open-orders,take-payment,cancel-order"], p.modelDir);
    expect(made.status).toBe(0);
  });
  afterAll(() => rmTemp(p.base));

  it("layout 1: no code map — no units key, and the plan is what it was apart from the version", () => {
    rmSync(join(p.modelDir, "code-map.yaml"), { force: true });
    const text = em(["engagement", "plan", "shop.em", "all", "--json"], p.modelDir).stdout;
    expect(JSON.parse(text).engagementPlanSchemaVersion).toBe("1.7");
    expect(text).not.toContain('"units"');
    expect(Object.keys(JSON.parse(text)).slice(-2)).toEqual(["preflight", "ratifyAtHandoff"]);
    expect(em(["engagement", "plan", "shop.em", "all"], p.modelDir).stdout).not.toContain("closing step");
  });

  it("layout 3: a State Change slice with a ui and a command yields two units and a closing step", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web, root: src/checkout}\n`);
    const units = unitsOf("place-order");
    expect(units).toEqual([
      {
        id: "place-order@web",
        kind: "unit",
        partOf: "place-order",
        repo: "web",
        roots: ["src/checkout"],
        elements: ["place-order/ui.checkout"],
        level: 0,
        branch: "impl/place-order",
        base: "main",
        prTitle: "Place Order",
        marker: "Em-Unit: shop:place-order@web",
        // `Order Placed` is public: there is a contract, so the two build in parallel.
        dependsOn: [],
        state: "planned",
        pr: null,
      },
      {
        id: "place-order@orders",
        kind: "unit",
        partOf: "place-order",
        repo: "orders",
        roots: [""],
        elements: ["place-order/command.place-order", "place-order/event.order-placed"],
        level: 0,
        branch: "impl/place-order",
        base: "main",
        prTitle: "Place Order",
        marker: "Em-Unit: shop:place-order@orders",
        dependsOn: [],
        state: "planned",
        pr: null,
      },
      {
        id: "close:place-order",
        kind: "close",
        partOf: "place-order",
        repo: "self",
        roots: [],
        elements: [],
        level: 0,
        branch: "close/place-order",
        base: "main",
        prTitle: "Place Order [close]",
        marker: "Em-Unit: shop:place-order@close",
        dependsOn: ["place-order@web", "place-order@orders"],
        state: "planned",
        pr: null,
      },
    ]);
    // The slices array is untouched: one Ledger row per slice.
    expect(plan().slices.map((s) => s.key).sort()).toEqual(["cancel-order", "open-orders", "place-order", "take-payment"]);
  });

  it("no public surface: the unit that only calls waits for the unit that provides", () => {
    const [web, orders, close] = unitsOf("cancel-order");
    expect([web.id, web.dependsOn]).toEqual(["cancel-order@web", ["cancel-order@orders"]]);
    expect([orders.id, orders.dependsOn]).toEqual(["cancel-order@orders", []]);
    expect(close.dependsOn).toEqual(["cancel-order@web", "cancel-order@orders"]);
  });

  it("layout 4: an Automation slice whose trigger and command sit in different contexts yields a unit per service repo", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\ncontexts:\n  Payments: {repo: payments}\n`);
    const units = unitsOf("take-payment");
    expect(units.map((u) => [u.id, u.elements])).toEqual([
      ["take-payment@orders", ["take-payment/processor.charge-card"]],
      ["take-payment@payments", ["take-payment/command.take-payment", "take-payment/event.payment-taken"]],
      ["close:take-payment", []],
    ]);
    // No public element in the slice: the processor (a caller) waits for the command's unit.
    expect(units[0].dependsOn).toEqual(["take-payment@payments"]);
    // A slice whose code is all in one repo is one unit plus its closing step.
    expect(unitsOf("open-orders").map((u) => u.id)).toEqual(["open-orders@orders", "close:open-orders"]);
  });

  it("layout 6: two places in the same repo with different roots yield one unit", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {root: services/orders}\npersonas:\n  Customer: {root: apps/web}\n`);
    const units = unitsOf("place-order");
    expect(units.map((u) => [u.id, u.roots])).toEqual([
      ["place-order@self", ["apps/web", "services/orders"]],
      ["close:place-order", []],
    ]);
    expect(units[0].elements).toHaveLength(3);
  });

  it("layout 2: one code repo — every slice is one unit there, closed in the model's repository", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\n`);
    const units = plan().units!;
    expect(units.filter((u) => u.kind === "unit").map((u) => u.repo)).toEqual(["orders", "orders", "orders", "orders"]);
    expect(units.filter((u) => u.kind === "close").every((u) => u.repo === "self" && u.dependsOn.length === 1)).toBe(true);
  });

  it("an element the code map does not place is a pre-flight finding and is in no unit", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\npersonas:\n  Customer: {repo: web}\n`);
    const doc = plan();
    const finding = doc.preflight.find((f) => f.kind === "element-unplaced" && f.message.startsWith("slice place-order"))!;
    expect(finding.message).toContain("place-order/command.place-order, place-order/event.order-placed have no place in code-map.yaml");
    expect(doc.units!.filter((u) => u.partOf === "place-order").map((u) => u.id)).toEqual(["place-order@web", "close:place-order"]);
  });

  it("the text plan lists each slice's units and closing step", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web, root: src/checkout}\n`);
    const text = em(["engagement", "plan", "shop.em", "all"], p.modelDir).stdout;
    expect(text).toContain("    place-order@web — web:src/checkout · 1 element");
    expect(text).toContain("    place-order@orders — orders · 2 elements");
    expect(text).toContain("    close:place-order — closing step in the model's repository, close/place-order · after place-order@web, place-order@orders");
    expect(text).toContain("    cancel-order@web — web:src/checkout · 1 element · after cancel-order@orders");
  });
});
