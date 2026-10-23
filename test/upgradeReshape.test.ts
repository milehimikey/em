// SPDX-License-Identifier: MIT
// GH #290 stage 2: collapse-alternative-events, fold-continuations, the roster / shared-event human
// items, and the `em upgrade` shape section.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { ratifiedHashScope, sliceDocBodyHash } from "../src/catalog/sliceDoc.js";
import { UpgradeContext, UPGRADE_STEPS, applyUpgrade, detectUpgrade, resolveRepoRoot } from "../src/cli/upgrade.js";
import { planCollapseAlternativeEvents, planFoldContinuations, planStackContinuations } from "../src/cli/upgradeReshape.js";
import { continuationOf } from "../src/model/continuation.js";
import { MODEL_117_STAGE2, sliceDocText, writeModel117 } from "./helpers/model117.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});
const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "em-gh290-s2-"));
  dirs.push(dir);
  gitInitQuiet(dir, "-b", "main");
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
/** `model` without the slice named `name` (its block and the blank line after it). */
const without = (model: string, name: string): string => model.replace(new RegExp(`slice "${name}" \\{[\\s\\S]*?\\n\\}\\n\\n?`), "");
function repoWith(model: string): string {
  const dir = repo();
  writeFileSync(join(dir, "orders.em"), model);
  git(dir, "add", "orders.em");
  git(dir, "commit", "-q", "-m", "variant model");
  return dir;
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
    expect(readFileSync(join(dir, "archive", "slices", "cancel-order-timeout.md"), "utf8")).toContain("superseded-by: cancel-order-customer@v1");
    expect(readFileSync(join(dir, "slices", "cancel-order-customer.md"), "utf8")).toMatch(/^merged-from: cancel-order-timeout@v1$/m);
    expect(readFileSync(join(dir, "slices", "cancel-order-customer.md"), "utf8")).toContain("Records one of");
    expect(commits(dir, "collapse-alternative-events")).toHaveLength(1);
    expect(step(dir, "collapse-alternative-events").applicable).toBe(false);
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    expect(commits(dir, "collapse-alternative-events")).toHaveLength(1);
  });

  it("lists authored content in a retired doc (fold these into the kept doc) and bannerises the archived copy", () => {
    const dir = repo();
    const d = step(dir, "collapse-alternative-events");
    expect(d.reason).toContain("archive/slices/cancel-order-timeout.md holds Open Questions — fold these into slices/cancel-order-customer.md");
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.applied.find((a) => a.id === "collapse-alternative-events")!.notes!;
    expect(notes.join("\n")).toContain("fold these into slices/cancel-order-customer.md");
    const archived = readFileSync(join(dir, "archive", "slices", "cancel-order-timeout.md"), "utf8");
    expect(archived).toMatch(/superseded-by: cancel-order-customer@v1\n---\n\n> \*\*SUPERSEDED\*\* by `cancel-order-customer`/);
  });

  it("GH #347: a signed kept doc has its event region re-synced under the signature (ratifiedHash kept, no slice-doc-stale-signed item)", () => {
    const dir = repo();
    const doc = join(dir, "slices", "cancel-order-customer.md");
    const plain = readFileSync(doc, "utf8");
    writeFileSync(doc, plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(plain)}`));
    git(dir, "add", "slices/cancel-order-customer.md");
    git(dir, "commit", "-q", "-m", "ratify");
    const signedBytes = readFileSync(doc, "utf8");
    const hash = /ratifiedHash: (\S+)/.exec(signedBytes)![1];
    expect(step(dir, "collapse-alternative-events").reason).toContain(
      "signed doc(s) whose generated regions go stale: slices/cancel-order-customer.md (em-slice-event) — em upgrade syncs the kept slice's doc",
    );
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = readFileSync(doc, "utf8");
    expect(after).not.toBe(signedBytes); // the event region was regenerated ...
    expect(after).toContain(`ratifiedHash: ${hash}\n`); // ... under the same signature
    expect(ratifiedHashScope(after, hash)).toBe("current");
    expect(result.report.human.find((h) => h.id === "slice-doc-stale-signed")).toBeUndefined();
    // the signed kept doc cannot take the back-link: a human item says what to add
    expect(after).not.toMatch(/merged-from/);
    expect(result.report.human.find((h) => h.id === "lineage-backlink-missing")!.reason).toContain("merged-from: cancel-order-timeout@v1");
  });

  it("takes the kept doc and its version from the slice's actual (covers) binding, not slices/<key>.md", () => {
    const dir = repo();
    const model = readFileSync(join(dir, "orders.em"), "utf8").replace('note "slices/cancel-order-customer.md"', 'note "slices/place-order.md"');
    writeFileSync(join(dir, "orders.em"), model);
    rmSync(join(dir, "slices", "cancel-order-customer.md"));
    const host = join(dir, "slices", "place-order.md");
    writeFileSync(host, readFileSync(host, "utf8").replace("version: 1", "version: 3\ncovers: cancel-order-customer"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "cancel is covered by the place-order doc");
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    expect(readFileSync(join(dir, "archive", "slices", "cancel-order-timeout.md"), "utf8")).toContain("superseded-by: place-order@v3");
    expect(readFileSync(host, "utf8")).toMatch(/^merged-from: cancel-order-timeout@v1$/m);
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

describe("fold-continuations (GH #287) — opt-in", () => {
  const readsOf = (src: string) => {
    const { model } = compile(src);
    const out: Record<string, string[]> = {};
    for (const origin of model.elements.filter((e) => e.kind === "view" && !e.again)) {
      out[origin.name] = [origin.from, ...model.elements.filter((e) => e.again && e.logicalId === origin.id).map((e) => e.from)].flat().sort() as string[];
    }
    return out;
  };

  it("is listed by a dry run and as a human item, but a plain --apply does not apply it", () => {
    const dir = repo();
    const d = step(dir, "fold-continuations");
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain("OPT-IN");
    expect(d.reason).toContain("em upgrade --apply --fold-continuations");
    expect(d.reason).toContain('"Shipments after ship" + "Shipments after ship, again"');
    expect(d.reason).toContain("dropped keys: shipments-after-ship-again");
    expect(d.reason).toContain("orders-after-ship (continues a different view)");
    expect(detectUpgrade(ctxOf(dir)).human.some((h) => h.id === "fold-continuations-opt-in")).toBe(true);
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    expect(readFileSync(join(dir, "orders.em"), "utf8")).toContain('slice "Shipments after ship, again"');
    expect(commits(dir, "fold-continuations")).toHaveLength(0);
  });

  it("--fold-continuations stacks consecutive continuations of ONE view into the first; continuationOf, doc join and the kept index row are unchanged", () => {
    const dir = repo();
    const before = readFileSync(join(dir, "orders.em"), "utf8");
    const cBefore = compile(before);
    const idx = (c: typeof cBefore, key: string) => c.refs.sliceKeys.indexOf(key);
    expect(applyUpgrade({ ...ctxOf(dir), foldContinuations: true }).ok).toBe(true);
    const text = readFileSync(join(dir, "orders.em"), "utf8");
    expect(text).not.toContain('slice "Shipments after ship, again"');
    expect(text).toMatch(/slice "Shipments after ship" \{[\s\S]*view Shipments again[\s\S]*view Shipments again[\s\S]*\n\}/);
    expect(text).toContain('slice "Orders after ship"'); // the different-view continuation is left alone
    const c = compile(text);
    expect(c.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect(c.refs.sliceKeys).toContain("shipments-after-ship");
    expect(c.refs.sliceKeys).not.toContain("shipments-after-ship-again");
    for (const key of ["shipments-after-ship", "orders-after-ship", "orders-manual"]) {
      const was = continuationOf(cBefore.model, cBefore.refs, idx(cBefore, key));
      const now = continuationOf(c.model, c.refs, idx(c, key));
      expect(now?.sliceKey).toBe(was?.sliceKey);
    }
    expect(readsOf(text)).toEqual(readsOf(before));
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Shipments after ship");
    expect(readme).not.toContain("Shipments after ship, again");
    expect(commits(dir, "fold-continuations")).toHaveLength(1);
    expect(step(dir, "fold-continuations").applicable).toBe(false);
  });

  it("--to-sugar moves them into the host and says plainly that continuationOf and the doc join change", () => {
    const dir = repoWith(without(MODEL_117_STAGE2, "Orders after ship"));
    const d = detectUpgrade({ ...ctxOf(dir), toSugar: true }).steps.find((x) => x.id === "fold-continuations")!;
    expect(d.reason).toContain("CHANGES continuationOf and the doc join to the host (ship-order--again)");
    expect(d.reason).toContain("removes the index rows of shipments-after-ship, shipments-after-ship-again");
    expect(applyUpgrade({ ...ctxOf(dir), toSugar: true }).ok).toBe(true);
    const text = readFileSync(join(dir, "orders.em"), "utf8");
    expect(text).toMatch(/slice "Ship Order" \{[\s\S]*view Shipments again from "Order Shipped" shown on "Shipment List"[\s\S]*\n\}/);
    expect(compile(text).refs.sliceKeys).toContain("ship-order--again");
  });

  it("--to-sugar REFUSES a host whose continuations span several views: no fold, no new diagnostic, a ratified origin doc untouched", () => {
    const withDoc = MODEL_117_STAGE2.replace("view Shipments from \"Order Placed\" { orderId: string }", 'view Shipments from "Order Placed" { orderId: string } note "slices/shipments.md"');
    const dir = repoWith(withDoc);
    const doc = join(dir, "slices", "shipments.md");
    const plain = sliceDocText("shipments", { stage2: true }).replace("pattern: state-change", "pattern: state-view");
    writeFileSync(doc, plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(plain)}`));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ratify shipments");
    const signedBytes = readFileSync(doc, "utf8");
    const diagsBefore = compile(withDoc).diagnostics.map((x) => x.code).sort();
    const d = detectUpgrade({ ...ctxOf(dir), toSugar: true }).steps.find((x) => x.id === "fold-continuations")!;
    expect(d.applicable).toBe(false);
    expect(d.reason).toContain("continuations of several views — fold by hand or keep the stacked slice");
    expect(applyUpgrade({ ...ctxOf(dir), toSugar: true }).ok).toBe(true);
    const after = readFileSync(join(dir, "orders.em"), "utf8"); // (the default collapse step still ran)
    for (const name of ["Shipments after ship", "Shipments after ship, again", "Orders after ship"]) expect(after).toContain(`slice "${name}"`);
    expect(after).not.toContain("shown on");
    expect(compile(after).refs.sliceKeys).not.toContain("ship-order--again");
    expect(readFileSync(doc, "utf8")).toBe(signedBytes);
    for (const code of compile(after).diagnostics.map((x) => x.code)) expect(diagsBefore).toContain(code); // no new diagnostic (the collapse only removes one)
  });

  it("names a signed doc whose generated regions the fold would make stale", () => {
    const dir = repoWith(without(without(MODEL_117_STAGE2, "Shipments after ship, again"), "Shipments after ship"));
    const doc = join(dir, "slices", "orders.md");
    const plain = sliceDocText("orders", { stage2: true }); // current against the model, so only the fold can make it stale
    writeFileSync(doc, plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${sliceDocBodyHash(plain)}`));
    const sugar = detectUpgrade({ ...ctxOf(dir), toSugar: true }).steps.find((x) => x.id === "fold-continuations")!;
    expect(sugar.reason).toMatch(/signed doc\(s\)[^;]*slices\/orders\.md/);
  });

  it("stacks the realistic post-collapse case: a host recording `event A | B`, one continuation of ONE view per event", () => {
    const post = `model "M"
context Sales
persona Clerk

slice "Place" {
  ui Place Form @Clerk
  command Place
  event Placed @Sales { id: string }
}

slice "List" {
  view Orders from "Placed" { id: string }
  ui Order List @Clerk
}

slice "Cancel" {
  ui Cancel Form @Clerk
  command Cancel
  event Cancelled By Customer | Cancelled By Timeout @Sales { id: string }
}

slice "Orders after customer cancel" {
  view Orders again from "Cancelled By Customer" { id: string }
  ui Order List @Clerk
}

slice "Orders after timeout cancel" {
  view Orders again from "Cancelled By Timeout" { id: string }
  ui Order List @Clerk
}
`;
    const { model, refs } = compile(post);
    const plan = planStackContinuations(model, refs, post)!;
    expect(plan.groups).toEqual([{ kept: "Orders after customer cancel", keptKey: "orders-after-customer-cancel", dropped: ["Orders after timeout cancel"], droppedKeys: ["orders-after-timeout-cancel"] }]);
    const lines = plan.next.split("\n").filter((l) => l.includes("view Orders again"));
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.trim())).size).toBe(2); // two distinct again lines, not duplicates
    expect(compile(plan.next).diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("does not stack across different ui, nor fold a continuation whose host records none of its events", () => {
    const ui = MODEL_117_STAGE2.replace('slice "Shipments after ship, again" {\n  view Shipments again from "Order Shipped" { orderId: string }\n  ui Shipment List @Clerk', 'slice "Shipments after ship, again" {\n  view Shipments again from "Order Shipped" { orderId: string }\n  ui Ship Form @Clerk');
    const a = compile(ui);
    expect(planStackContinuations(a.model, a.refs, ui)).toBeNull();
    const unrelated = without(MODEL_117_STAGE2, "Orders after ship").replace('view Shipments again from "Order Shipped"', 'view Shipments again from "Order Placed Manually"');
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

describe("rewrites keep the comment above a moved line (GH #374)", () => {
  const TODO = `model "Todo"
context Ops
persona Admin

slice "Do A" {
  ui A Form @Admin
  command Do A
  event A1 @Ops { id: string }
  event A2 @Ops { id: string }
}

slice "Do B" {
  ui B Form @Admin
  command Do B
  event B1 @Ops { id: string }
  event B2 @Ops { id: string }
}

slice "Things To Do" {
  view ThingsToDo from "A1" { id: string }
  ui Todo Screen @Admin
}

slice "Things To Do: a" {
  view ThingsToDo again from "A1", "A2"
  ui Todo Screen @Admin
}

slice "Things To Do: b" {
  # why these sources: explains the B events
  view ThingsToDo again from "B1", "B2"
  ui Todo Screen @Admin
}
`;
  const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "error").length;

  it("stack form: the issue's repro — the comment moves into the kept slice directly above its `view … again` line", () => {
    const { model, refs } = compile(TODO);
    const plan = planStackContinuations(model, refs, TODO)!;
    expect(plan.groups.map((g) => g.droppedKeys)).toEqual([["things-to-do-b"]]);
    expect(plan.droppedComments).toEqual([]);
    expect(plan.next).toContain('  # why these sources: explains the B events\n  view ThingsToDo again from "B1", "B2"\n}');
    expect(plan.next.split("# why these sources")).toHaveLength(2); // once, not duplicated or left behind
    expect(plan.next).not.toContain('slice "Things To Do: b"');
    expect(errors(plan.next)).toBe(errors(TODO));
  });

  it("stack form: a comment that belongs to the dropped `ui` line is reported, not silently lost; the dry run names it", () => {
    const src = TODO.replace('  view ThingsToDo again from "B1", "B2"\n  ui Todo Screen @Admin', '  view ThingsToDo again from "B1", "B2"\n  # screen note: belongs to the ui line\n  ui Todo Screen @Admin');
    const { model, refs } = compile(src);
    const plan = planStackContinuations(model, refs, src)!;
    expect(plan.droppedComments).toEqual([{ key: "things-to-do-b", lines: ["# screen note: belongs to the ui line"] }]);
    expect(plan.next).toContain("# why these sources: explains the B events\n");
    expect(plan.next).not.toContain("# screen note");
    const dir = repoWith(src);
    const reason = step(dir, "fold-continuations").reason;
    expect(reason).toContain("DROPPED by the rewrite: 1 in things-to-do-b (`# screen note: belongs to the ui line`) — move them by hand first");
    expect(reason).toContain("not directly above a moved `view … again` line");
  });

  it("stack form through em upgrade --apply --fold-continuations writes the comment with its line", () => {
    const dir = repoWith(TODO);
    expect(applyUpgrade({ ...ctxOf(dir), foldContinuations: true }).ok).toBe(true);
    const text = readFileSync(join(dir, "orders.em"), "utf8");
    expect(text).toContain('  # why these sources: explains the B events\n  view ThingsToDo again from "B1", "B2"\n}');
    expect(text).not.toContain('slice "Things To Do: b"');
  });

  it("--to-sugar: the comment lands in the host directly above the moved line, `shown on` and all", () => {
    const sugar = `model "Todo"
context Ops
persona Admin

slice "Do A" {
  ui A Form @Admin
  command Do A
  event A1 @Ops { id: string }
}

slice "Things To Do" {
  view ThingsToDo from "A1" { id: string }
  ui Todo Screen @Admin
}

slice "Do B" {
  ui B Form @Admin
  command Do B
  event B1 @Ops { id: string }
}

slice "Things To Do: b" {
  # why these sources: explains the B events
  view ThingsToDo again from "B1"
  # screen note: belongs to the ui line
  ui Todo Screen @Admin
}
`;
    const { model, refs } = compile(sugar);
    const plan = planFoldContinuations(model, refs, sugar)!;
    expect(plan.groups.map((g) => g.foldedKeys)).toEqual([["things-to-do-b"]]);
    expect(plan.next).toContain('  event B1 @Ops { id: string }\n  # why these sources: explains the B events\n  view ThingsToDo again from "B1" shown on "Todo Screen"\n}');
    expect(plan.droppedComments).toEqual([{ key: "things-to-do-b", lines: ["# screen note: belongs to the ui line"] }]);
    expect(plan.next).not.toContain("# screen note");
    const dir = repoWith(sugar);
    const reason = detectUpgrade({ ...ctxOf(dir), toSugar: true }).steps.find((x) => x.id === "fold-continuations")!.reason;
    expect(reason).toContain("DROPPED by the rewrite: 1 in things-to-do-b (`# screen note: belongs to the ui line`)");
  });

  const CANCEL = (timeoutFields: string) => `model "M"
context Sales
persona Clerk

slice "Cancel by customer" {
  ui Cancel Form @Clerk
  command Cancel Order
  event Cancelled By Customer @Sales { id: string }
}

slice "Cancel by timeout" {
  # the screen is shared
  ui Cancel Form @Clerk
  command Cancel Order
  # timeouts come from the scheduler
  event Cancelled By Timeout @Sales { ${timeoutFields} }
}

slice "List" {
  view Orders from "Cancelled By Customer", "Cancelled By Timeout" { id: string }
  ui Order List @Clerk
}
`;

  it("collapse, inline form: the later event's comment sits above the merged `event A | B` line; the ui comment is reported", () => {
    const src = CANCEL("id: string");
    const { model, refs } = compile(src);
    const plan = planCollapseAlternativeEvents(model, refs, src)!;
    expect(plan.groups[0].form).toBe("inline");
    expect(plan.next).toContain("  command Cancel Order\n  # timeouts come from the scheduler\n  event Cancelled By Customer | Cancelled By Timeout @Sales { id: string }\n}");
    expect(plan.droppedComments).toEqual([{ key: "cancel-by-timeout", lines: ["# the screen is shared"] }]);
    expect(plan.next).not.toContain("# the screen is shared");
    const reason = step(repoWith(src), "collapse-alternative-events").reason;
    expect(reason).toContain("not directly above a merged slice's event are DROPPED by the rewrite: 1 in cancel-by-timeout (`# the screen is shared`)");
  });

  it("collapse, oneof form: the comment rides inside the block above its event", () => {
    const src = CANCEL("id: string, reason: string");
    const { model, refs } = compile(src);
    const plan = planCollapseAlternativeEvents(model, refs, src)!;
    expect(plan.groups[0].form).toBe("oneof");
    expect(plan.next).toContain("  oneof {\n    event Cancelled By Customer @Sales { id: string }\n    # timeouts come from the scheduler\n    event Cancelled By Timeout @Sales { id: string, reason: string }\n  }\n}");
    expect(plan.droppedComments).toEqual([{ key: "cancel-by-timeout", lines: ["# the screen is shared"] }]);
  });
});
