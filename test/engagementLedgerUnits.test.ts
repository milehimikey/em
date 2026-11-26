// SPDX-License-Identifier: MIT
// GH #537: the Ledger per work unit — `em engagement set --unit`, the slice's state derived from
// its units, and a one-unit slice's entry left exactly as it was.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { createMultiRepoProject, MultiRepoProject } from "./helpers/multiRepoProject.js";
import { deriveSliceState, EngagementUnitEntry, formatSliceEntryLine, parseEngagementFile } from "../src/cli/engagementFile.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web, root: src/checkout}\n`;

describe("deriveSliceState", () => {
  const u = (...states: string[]): EngagementUnitEntry[] => states.map((state, i) => ({ repo: `r${i}`, state: state as EngagementUnitEntry["state"], branch: null, base: null, pr: null }));
  it("is merged only when every unit is, held or gap when any is, else the least advanced", () => {
    expect(deriveSliceState(u("merged", "merged"))).toBe("merged");
    expect(deriveSliceState(u("merged", "review"))).toBe("review");
    expect(deriveSliceState(u("awaiting-merge", "building"))).toBe("building");
    expect(deriveSliceState(u("merged", "planned"))).toBe("planned");
    expect(deriveSliceState(u("merged", "held"))).toBe("held");
    expect(deriveSliceState(u("review", "gap"))).toBe("gap");
    expect(deriveSliceState(u("held", "gap"))).toBe("held");
  });
});

describe("the Ledger per work unit (GH #537)", () => {
  let p: MultiRepoProject;
  const file = () => join(p.modelDir, "engagements", "all.md");
  const text = () => readFileSync(file(), "utf8");
  const set = (...args: string[]) => em(["engagement", "set", "shop.em", "all", ...args], p.modelDir);

  beforeAll(() => {
    p = createMultiRepoProject(["web", "orders", "payments"], MAP);
    expect(em(["engagement", "new", "shop.em", "all", "--slices", "place-order,open-orders,take-payment,cancel-order"], p.modelDir).status).toBe(0);
  });
  afterAll(() => rmTemp(p.base));

  it("a one-unit slice keeps its one-line entry and the file its version, with or without --unit", () => {
    const before = text();
    expect(before).toContain('engagementSchemaVersion: "1.1"');
    expect(set("open-orders", "--state", "building", "--branch", "impl/open-orders").status).toBe(0);
    expect(text()).toContain('  - {key: open-orders, state: building, branch: "impl/open-orders", base: null, pr: null}');
    // A harness walking plan.units may name the one unit; nothing is recorded differently.
    const r = set("open-orders", "--unit", "orders", "--state", "review", "--pr", "https://github.com/acme/orders/pull/7");
    expect(r.status).toBe(0);
    expect(text()).toContain('  - {key: open-orders, state: review, branch: "impl/open-orders", base: null, pr: "https://github.com/acme/orders/pull/7"}');
    expect(text()).toContain('engagementSchemaVersion: "1.1"');
    expect(text()).not.toContain("units:");
  });

  it("a slice with two units refuses a slice-level set and names its units", () => {
    const r = set("place-order", "--state", "merged");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "place-order" has 2 work units (web, orders) — record each with --unit <repo>');
    const bad = set("place-order", "--unit", "payments", "--state", "building");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('slice "place-order" has no work unit in repo "payments" — its units are in: web, orders');
  });

  it("layout 3: each unit is recorded on the slice's one line, and the slice is merged only when both are", () => {
    const a = set("place-order", "--unit", "web", "--state", "review", "--branch", "impl/place-order", "--base", "main", "--pr", "https://github.com/acme/web/pull/12");
    expect(a.status).toBe(0);
    expect(a.stdout).toContain("set place-order@web: review — slice place-order: planned");
    expect(text()).toContain('engagementSchemaVersion: "1.4"');
    expect(text()).toContain(
      '  - {key: place-order, state: planned, branch: null, base: null, pr: null, units: [{repo: web, state: review, branch: "impl/place-order", base: "main", pr: "https://github.com/acme/web/pull/12"}, {repo: orders, state: planned, branch: null, base: null, pr: null}]}',
    );
    expect(set("place-order", "--unit", "web", "--state", "merged").status).toBe(0);
    let parsed = parseEngagementFile(text());
    expect(parsed.ok && parsed.file.slices.find((s) => s.key === "place-order")!.state).toBe("planned");
    expect(set("place-order", "--unit", "orders", "--state", "awaiting-merge", "--pr", "https://github.com/acme/orders/pull/31").status).toBe(0);
    parsed = parseEngagementFile(text());
    expect(parsed.ok && parsed.file.slices.find((s) => s.key === "place-order")!.state).toBe("awaiting-merge");
    const done = set("place-order", "--unit", "orders", "--state", "merged");
    expect(done.stdout).toContain("set place-order@orders: merged — slice place-order: merged");
    parsed = parseEngagementFile(text());
    const entry = parsed.ok ? parsed.file.slices.find((s) => s.key === "place-order")! : null;
    expect(entry).toMatchObject({ state: "merged", units: [{ repo: "web", state: "merged" }, { repo: "orders", state: "merged" }] });
    // Round trip: the line the parser read is the line the writer would write.
    expect(text()).toContain(formatSliceEntryLine(entry!));
  });

  it("merged is terminal per unit; re-setting the same values is a no-op", () => {
    const again = set("place-order", "--unit", "orders", "--state", "merged");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("no change: place-order@orders is already merged");
    const back = set("place-order", "--unit", "orders", "--state", "review");
    expect(back.status).toBe(1);
    expect(back.stderr).toContain('unit "place-order@orders" is merged — merged is terminal');
  });

  it("a held unit holds the slice", () => {
    expect(set("cancel-order", "--unit", "web", "--state", "held").status).toBe(0);
    const parsed = parseEngagementFile(text());
    expect(parsed.ok && parsed.file.slices.find((s) => s.key === "cancel-order")).toMatchObject({ state: "held", heldBy: "human" });
  });

  it("the Ledger table shows a row per unit under its slice; plan and status carry unit state", () => {
    const t = text();
    expect(t).toContain("| `place-order` | state-change | ready-to-implement | merged | — | — | — |");
    expect(t).toContain("| ↳ `place-order@web` |  |  | merged | impl/place-order | main | https://github.com/acme/web/pull/12 |");
    expect(t).toContain("| `open-orders` | state-view | ready-to-implement | review | impl/open-orders | — | https://github.com/acme/orders/pull/7 |");
    const plan = JSON.parse(em(["engagement", "plan", "shop.em", "all", "--json"], p.modelDir).stdout);
    const node = (id: string) => plan.units.find((u: { id: string }) => u.id === id);
    expect([node("place-order@web").state, node("place-order@web").pr]).toEqual(["merged", "https://github.com/acme/web/pull/12"]);
    expect([node("open-orders@orders").state, node("open-orders@orders").pr]).toEqual(["review", "https://github.com/acme/orders/pull/7"]);
    // Units merged, but the slice doc is not yet recorded as shipped: the closing step is still to do.
    expect(node("close:place-order").state).toBe("planned");
    expect(plan.slices.find((s: { key: string }) => s.key === "place-order").state).toBe("merged");
    const status = JSON.parse(em(["engagement", "status", "shop.em", "all", "--json"], p.modelDir).stdout);
    expect(status.engagementStatusSchemaVersion).toBe("1.2");
    expect(status.slices.find((s: { key: string }) => s.key === "place-order").units.map((u: { repo: string; state: string }) => [u.repo, u.state])).toEqual([["web", "merged"], ["orders", "merged"]]);
    expect(status.slices.find((s: { key: string }) => s.key === "open-orders").units).toBeUndefined();
  });

  it("a PR URL with $& in it is written literally", () => {
    const url = "https://github.com/acme/orders/pull/9?q=$&x=$1";
    expect(set("take-payment", "--state", "review", "--pr", url).status).toBe(0);
    expect(text()).toContain(`  - {key: take-payment, state: review, branch: null, base: null, pr: ${JSON.stringify(url)}}`);
    const parsed = parseEngagementFile(text());
    expect(parsed.ok && parsed.file.slices.find((s) => s.key === "take-payment")!.pr).toBe(url);
  });

  it("the code map moves a slice's code after units were recorded: the old record is kept, settable, and no longer holds the slice", () => {
    // cancel-order has units web (held, above) and orders. Move the Customer screens to payments.
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: payments}\n`);
    expect(set("cancel-order", "--unit", "orders", "--state", "merged").status).toBe(0);
    let entry = (parseEngagementFile(text()) as any).file.slices.find((s: any) => s.key === "cancel-order");
    // payments joined as planned; web is kept as a record but the slice follows orders + payments.
    expect(entry.units.map((u: any) => [u.repo, u.state])).toEqual([["payments", "planned"], ["orders", "merged"], ["web", "held"]]);
    expect(entry.state).toBe("planned");
    expect(set("cancel-order", "--unit", "payments", "--state", "merged").status).toBe(0);
    entry = (parseEngagementFile(text()) as any).file.slices.find((s: any) => s.key === "cancel-order");
    expect(entry.state).toBe("merged");
    // The stale unit can still be settled by name.
    expect(set("cancel-order", "--unit", "web", "--state", "gap").status).toBe(0);
    p.setCodeMap(MAP);
  });

  it("the code map collapses a recorded slice to one repo: its unit records are kept and a merged unit stays merged", () => {
    p.setCodeMap(`codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\n`);
    try {
      // place-order has units web and orders, both merged. It is still recorded per unit.
      const bare = set("place-order", "--state", "building");
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain('slice "place-order" has 2 work units (web, orders) — record each with --unit <repo>');
      const back = set("place-order", "--unit", "orders", "--state", "building");
      expect(back.status).toBe(1);
      expect(back.stderr).toContain('unit "place-order@orders" is merged — merged is terminal');
      const entry = (parseEngagementFile(text()) as any).file.slices.find((s: any) => s.key === "place-order");
      const byRepo = Object.fromEntries(entry.units.map((u: any) => [u.repo, [u.state, u.pr !== null]]));
      expect(byRepo).toEqual({ orders: ["merged", true], web: ["merged", true] });
    } finally {
      p.setCodeMap(MAP);
    }
  });

  it("a repo id YAML would misread is quoted, and round-trips", () => {
    const line = formatSliceEntryLine({ key: "k", state: "planned", branch: null, base: null, pr: null, units: [
      { repo: "null", state: "planned", branch: null, base: null, pr: null },
      { repo: "1e3", state: "merged", branch: null, base: null, pr: null },
      { repo: "Web.App_2", state: "review", branch: null, base: null, pr: null },
    ] });
    expect(line).toContain('{repo: "null", state: planned');
    expect(line).toContain('{repo: "1e3", state: merged');
    expect(line).toContain("{repo: Web.App_2, state: review");
    const parsed = parseEngagementFile(`---\nengagementSchemaVersion: "1.4"\nslug: s\nmodel: "../a.em"\nstatus: open\nparallel: 1\nslices:\n${line}\n---\n`);
    expect(parsed.ok && parsed.file.slices[0].units!.map((u) => u.repo)).toEqual(["null", "1e3", "Web.App_2"]);
  });

  it("no code map: --unit is refused, and nothing about the file changes shape", () => {
    rmSync(join(p.modelDir, "code-map.yaml"));
    const r = set("take-payment", "--unit", "orders", "--state", "building");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the model has no code-map.yaml, so slice "take-payment" is one unit — drop --unit');
    expect(set("take-payment", "--state", "building").status).toBe(0);
    // One line, no units: (the PR URL is the one recorded earlier in this suite).
    expect(text()).toMatch(/^  - \{key: take-payment, state: building, branch: null, base: null, pr: "[^"]+"\}$/m);
  });
});
