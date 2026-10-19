// SPDX-License-Identifier: MIT
// GH #290 stage 2: collapse-alternative-events, fold-continuations, the roster / shared-event human
// items, and the `em upgrade` shape section.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { sliceDocBodyHash } from "../src/catalog/sliceDoc.js";
import { UpgradeContext, UPGRADE_STEPS, applyUpgrade, detectUpgrade, resolveRepoRoot } from "../src/cli/upgrade.js";
import { planCollapseAlternativeEvents, planFoldContinuations } from "../src/cli/upgradeReshape.js";
import { MODEL_117_STAGE2, writeModel117 } from "./helpers/model117.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "em-gh290-s2-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
  writeModel117(dir, { stage2: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "1.17 model");
  return dir;
}
function ctxOf(dir: string): UpgradeContext {
  const { model, refs } = compile(readFileSync(join(dir, "orders.em"), "utf8"));
  const root = resolveRepoRoot(dir);
  if (!root.ok) throw new Error(root.message);
  return { modelFile: join(dir, "orders.em"), baseDir: dir, repoRoot: root.repoRoot, installedVersion: "1.18.0", packagedSkillsRoot: join(dir, "no-skills"), model, refs };
}
const step = (dir: string, id: string) => detectUpgrade(ctxOf(dir)).steps.find((s) => s.id === id)!;
const commits = (dir: string, id: string) => git(dir, "log", "--format=%s").split("\n").filter((l) => l.startsWith(`em upgrade: ${id}`));

describe("registration", () => {
  it("both rewriting steps run before the doc/index steps, since 1.18.0", () => {
    const ids = UPGRADE_STEPS.map((s) => s.id);
    for (const id of ["collapse-alternative-events", "fold-continuations"] as const) {
      expect(UPGRADE_STEPS.find((s) => s.id === id)!.sinceVersion).toBe("1.18.0");
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("view-doc-sources-stale"));
    }
  });
});

describe("collapse-alternative-events (GH #278)", () => {
  it("detects the repeated-command columns and names before/after", () => {
    const d = step(repo(), "collapse-alternative-events");
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain('"Cancel Order Customer" + "Cancel Order Timeout" → "Cancel Order Customer"');
    expect(d.reason).toContain("Order Cancelled By Customer | Order Cancelled By Timeout");
  });

  it("--apply rewrites to one slice, moves the retired doc with superseded-by, syncs the kept doc; idempotent", () => {
    const dir = repo();
    const before = compile(MODEL_117_STAGE2).model;
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    const text = readFileSync(join(dir, "orders.em"), "utf8");
    expect(text).toContain("event Order Cancelled By Customer | Order Cancelled By Timeout @Sales { orderId: string, reason: string }");
    expect(text).not.toContain('slice "Cancel Order Timeout"');
    const after = compile(text);
    expect(after.model.slices.length).toBe(before.slices.length - 1); // -1 collapsed; the fold swaps a slice for a synthesized column
    expect(after.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect(existsSync(join(dir, "slices", "cancel-order-timeout.md"))).toBe(false);
    expect(readFileSync(join(dir, "slices", "superseded", "cancel-order-timeout.md"), "utf8")).toContain("superseded-by: cancel-order-customer@v1");
    expect(readFileSync(join(dir, "slices", "cancel-order-customer.md"), "utf8")).toContain("Records one of");
    expect(commits(dir, "collapse-alternative-events")).toHaveLength(1);
    expect(step(dir, "collapse-alternative-events").applicable).toBe(false);
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    expect(commits(dir, "collapse-alternative-events")).toHaveLength(1);
  });

  it("lists authored content in a retired doc (fold these into the kept doc) and bannerises the archived copy", () => {
    const dir = repo();
    const d = step(dir, "collapse-alternative-events");
    expect(d.reason).toContain("slices/superseded/cancel-order-timeout.md holds Open Questions — fold these into slices/cancel-order-customer.md");
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.applied.find((a) => a.id === "collapse-alternative-events")!.notes!;
    expect(notes.join("\n")).toContain("fold these into slices/cancel-order-customer.md");
    const archived = readFileSync(join(dir, "slices", "superseded", "cancel-order-timeout.md"), "utf8");
    expect(archived).toMatch(/superseded-by: cancel-order-customer@v1\n---\n\n> \*\*SUPERSEDED\*\* by `cancel-order-customer`/);
  });

  it("a signed kept doc is left byte-identical and becomes the human item event-region-stale-signed", () => {
    const dir = repo();
    const doc = join(dir, "slices", "cancel-order-customer.md");
    const plain = readFileSync(doc, "utf8");
    writeFileSync(doc, plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(plain)}`));
    git(dir, "add", "slices/cancel-order-customer.md");
    git(dir, "commit", "-q", "-m", "ratify");
    const signedBytes = readFileSync(doc, "utf8");
    expect(step(dir, "collapse-alternative-events").reason).toContain("are signed and will not be synced");
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(doc, "utf8")).toBe(signedBytes);
    const item = result.report.human.find((h) => h.id === "event-region-stale-signed")!;
    expect(item.reason).toContain("slices/cancel-order-customer.md");
    expect(item.reason).toContain("em slice revise cancel-order-customer");
    expect(item.reason).toContain("em slice sync");
  });

  it("uses oneof when the alternatives' payloads differ; leaves differing-command and noted runs alone", () => {
    const oneof = MODEL_117_STAGE2.replace("event Order Cancelled By Timeout @Sales { orderId: string, reason: string }", "event Order Cancelled By Timeout @Sales { orderId: string }");
    const { model, refs } = compile(oneof);
    const plan = planCollapseAlternativeEvents(model, refs, oneof)!;
    expect(plan.groups[0].form).toBe("oneof");
    expect(plan.next).toContain("oneof {");
    expect(compile(plan.next).diagnostics.filter((x) => x.severity === "error")).toEqual([]);

    const differing = MODEL_117_STAGE2.replace("command Cancel Order\n  event Order Cancelled By Timeout", "command Cancel Order Quietly\n  event Order Cancelled By Timeout");
    const c1 = compile(differing);
    expect(planCollapseAlternativeEvents(c1.model, c1.refs, differing)).toBeNull();

    const noted = MODEL_117_STAGE2.replace("command Cancel Order\n  event Order Cancelled By Timeout", 'command Cancel Order note "slices/x.md"\n  event Order Cancelled By Timeout');
    const c2 = compile(noted);
    expect(planCollapseAlternativeEvents(c2.model, c2.refs, noted)).toBeNull();
  });
});

describe("fold-continuations (GH #287)", () => {
  it("detects a hand-named continuation directly after its host command slice", () => {
    const d = step(repo(), "fold-continuations");
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain('"Shipments after ship"');
    expect(d.reason).toContain("ship-order--again");
  });

  it("--apply folds it into the host as a `shown on` line, keeps the read model's sources, one commit, idempotent", () => {
    const dir = repo();
    const reads = (src: string) => {
      const { model } = compile(src);
      const origin = model.elements.find((e) => e.kind === "view" && e.name === "Shipments" && !e.again)!;
      return [origin.from, ...model.elements.filter((e) => e.again && e.logicalId === origin.id).map((e) => e.from)].flat().sort();
    };
    const beforeReads = reads(readFileSync(join(dir, "orders.em"), "utf8"));
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    const text = readFileSync(join(dir, "orders.em"), "utf8");
    expect(text).not.toContain('slice "Shipments after ship"');
    expect(text).toMatch(/slice "Ship Order" \{[\s\S]*view Shipments again from "Order Shipped" shown on "Shipment List"[\s\S]*\n\}/);
    const c = compile(text);
    expect(c.refs.sliceKeys).toContain("ship-order--again");
    expect(reads(text)).toEqual(beforeReads);
    expect(c.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect(commits(dir, "fold-continuations")).toHaveLength(1);
    expect(step(dir, "fold-continuations").applicable).toBe(false);
  });

  it("does not fold a continuation whose ui is declared nowhere else, or whose host records none of its events", () => {
    const lonelyUi = MODEL_117_STAGE2.replace('  ui Shipment List @Clerk\n}\n\nslice "Ship Order"', '}\n\nslice "Ship Order"');
    const a = compile(lonelyUi);
    expect(planFoldContinuations(a.model, a.refs, lonelyUi)).toBeNull();
    const unrelated = MODEL_117_STAGE2.replace('view Shipments again from "Order Shipped"', 'view Shipments again from "Order Placed Manually"');
    const b = compile(unrelated);
    expect(planFoldContinuations(b.model, b.refs, unrelated)).toBeNull();
  });
});

describe("human items (GH #259 roster)", () => {
  it("lists roster-not-initialised when docs carry signers and there is no ratifiers.yaml; never writes one", () => {
    const dir = repo();
    const humanOf = () => detectUpgrade(ctxOf(dir)).human.find((h) => h.id === "roster-not-initialised");
    expect(humanOf()).toBeUndefined();
    const doc = join(dir, "slices", "place-order.md");
    writeFileSync(doc, readFileSync(doc, "utf8").replace("status: draft", "status: reviewed\nratifiedBy: Alex\nratifiedOn: 2026-10-02"));
    const item = humanOf()!;
    expect(item.reason).toContain("Alex");
    expect(item.reason).toContain("em roster init");
    expect(existsSync(join(dir, "ratifiers.yaml"))).toBe(false);
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: "Alex"\n');
    expect(humanOf()).toBeUndefined();
  });
});
