// SPDX-License-Identifier: MIT
// GH #290 (stage 1): the 1.18.0 upgrade path for constructs already on main —
// `view-doc-sources-stale`, `slice-index-stale`, `parking-lot-fragments`, and the advisory
// `em storyline suggest` patch.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { UpgradeContext, UPGRADE_STEPS, applyUpgrade, detectUpgrade, resolveRepoRoot } from "../src/cli/upgrade.js";
import { rewriteParkingLotFragments } from "../src/cli/defer.js";
import { buildStorylineSuggestion } from "../src/cli/storylineSuggest.js";
import { MODEL_117, sliceDocText, writeModel117 } from "./helpers/model117.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function repo(opts: { signedOrders?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "em-gh290-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
  writeModel117(dir, opts);
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

describe("registration", () => {
  it("the three stage-1 steps are registered since 1.18.0, before system-manifest", () => {
    const ids = UPGRADE_STEPS.map((s) => s.id);
    for (const id of ["view-doc-sources-stale", "slice-index-stale", "parking-lot-fragments"] as const) {
      expect(UPGRADE_STEPS.find((s) => s.id === id)!.sinceVersion).toBe("1.18.0");
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf("system-manifest"));
    }
  });
});

describe("view-doc-sources-stale (GH #280)", () => {
  it("detects a doc whose view region lists only the origin instance's events; --apply syncs it in one commit; second run is a no-op", () => {
    const dir = repo();
    const d = step(dir, "view-doc-sources-stale");
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain("slices/orders.md");
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    const text = readFileSync(join(dir, "slices", "orders.md"), "utf8");
    expect(text).toContain('built from events: "Order Placed", "Order Placed Manually" (via "Orders manual")');
    expect(git(dir, "log", "--format=%s").split("\n").filter((l) => l.startsWith("em upgrade: view-doc-sources-stale"))).toHaveLength(1);
    expect(step(dir, "view-doc-sources-stale").applicable).toBe(false);
  });

  it("a signed (shipped) doc is reported and left alone, and is a human item", () => {
    const dir = repo({ signedOrders: true });
    const d = step(dir, "view-doc-sources-stale");
    expect(d.applicable).toBe(false);
    expect(d.reason).toContain("left alone");
    expect(d.reason).toContain("slices/orders.md");
    const item = detectUpgrade(ctxOf(dir)).human.find((h) => h.id === "view-doc-sources-stale-signed")!;
    expect(item.reason).toContain("em slice revise orders");
    expect(item.reason).toContain("em slice sync");
  });

  it("shared-event-now-legal is an information-only human item for an event recorded by two commands", () => {
    const dir = repo();
    expect(detectUpgrade(ctxOf(dir)).human.find((h) => h.id === "shared-event-now-legal")).toBeUndefined();
    const shared = MODEL_117.replace("event Order Placed Manually @Sales { orderId: string, approvedBy: string }", "event Order Placed @Sales").replace('from "Order Placed Manually"', 'from "Order Placed"');
    writeFileSync(join(dir, "orders.em"), shared);
    const item = detectUpgrade(ctxOf(dir)).human.find((h) => h.id === "shared-event-now-legal")!;
    expect(item.reason).toContain("Order Placed");
    expect(item.reason).toContain("information only");
  });
});

describe("slice-index-stale (GH #275)", () => {
  it("detects a stale README table; --apply regenerates it in one commit", () => {
    const dir = repo();
    expect(step(dir, "slice-index-stale").applicable).toBe(true);
    const result = applyUpgrade(ctxOf(dir));
    expect(result.ok).toBe(true);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Orders manual");
    expect(git(dir, "log", "--format=%s").split("\n").filter((l) => l.startsWith("em upgrade: slice-index-stale"))).toHaveLength(1);
    expect(step(dir, "slice-index-stale").applicable).toBe(false);
  });

  it("is not applicable without a README or without the markers", () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "# no markers\n");
    expect(step(dir, "slice-index-stale")).toMatchObject({ applicable: false });
    expect(step(dir, "slice-index-stale").reason).toContain("no GENERATED:slices markers");
  });
});

describe("parking-lot-fragments (GH #283)", () => {
  const DOC = sliceDocText("place-order");
  it("rewrites a fragment bullet to the item's label (pure)", () => {
    const state = "## Open questions / parking lot\n\n- how many (from slice place-order, deferred to v2)\n- other (from slice place-order, deferred to v2)\n\n## Decisions log\n";
    const { content, rewrites } = rewriteParkingLotFragments(state, new Map([["place-order", DOC]]));
    expect(rewrites).toEqual([{ sliceKey: "place-order", from: "how many", to: "Retry policy" }]);
    expect(content).toContain("- Retry policy (from slice place-order, deferred to v2)");
    expect(content).toContain("- other (from slice place-order, deferred to v2)");
  });

  it("leaves a bullet that already equals the label or the full item, an unknown slice, and an ambiguous fragment", () => {
    const two = DOC.replace("## Open Questions\n\n", "## Open Questions\n\n- [ ] **Retire** how many sunsets?\n");
    const state = [
      "## Open questions / parking lot",
      "",
      "- Retry policy (from slice place-order, deferred to v2)",
      "- how many (from slice nowhere, deferred to v2)",
      "- how many (from slice place-order, deferred to v2)",
      "",
    ].join("\n");
    expect(rewriteParkingLotFragments(state, new Map([["place-order", DOC]])).rewrites).toHaveLength(1);
    expect(rewriteParkingLotFragments(state, new Map([["place-order", two]])).rewrites).toHaveLength(0);
  });

  it("matches against the item without its deferral annotation, and needs exactly ONE matching item", () => {
    const state = "## Open questions / parking lot\n\n- fail fast (from slice place-order, deferred to v2)\n- retr (from slice place-order, deferred to v2)\n";
    // "fail fast" only occurs in the item's deferral annotation; "retr" hits the item once
    const r = rewriteParkingLotFragments(state, new Map([["place-order", DOC]]));
    expect(r.rewrites.map((x) => x.from)).toEqual(["retr"]);
    const dup = DOC.replace("## Open Questions\n\n", "## Open Questions\n\n- [ ] **Retry budget** retr count?\n");
    expect(rewriteParkingLotFragments(state, new Map([["place-order", dup]])).rewrites).toHaveLength(0);
  });

  it("step: detects the pre-#305 bullet, --apply rewrites it in one commit, idempotent", () => {
    const dir = repo();
    const d = step(dir, "parking-lot-fragments");
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain('"how many" → "Retry policy"');
    expect(applyUpgrade(ctxOf(dir)).ok).toBe(true);
    expect(readFileSync(join(dir, ".event-modeling.md"), "utf8")).toContain("- Retry policy (from slice place-order, deferred to v2)");
    expect(git(dir, "log", "--format=%s").split("\n").filter((l) => l.startsWith("em upgrade: parking-lot-fragments"))).toHaveLength(1);
    expect(step(dir, "parking-lot-fragments").applicable).toBe(false);
  });
});

describe("em storyline suggest (GH #290)", () => {
  const suggest = (src: string) => {
    const { model } = compile(src);
    return buildStorylineSuggestion(model, src, "orders.em");
  };

  it("one storyline per distinct source URL; a view chain touching one URL joins it", () => {
    const s = suggest(MODEL_117);
    expect(s.storylines.map((g) => [g.name, g.sliceIndexes])).toEqual([["Place", [0, 1, 2, 3]]]);
    expect(s.storylines[0].source).toBe("docs/orders.md#place");
    expect(s.ungrouped).toEqual([]);
  });

  it("two source URLs stay apart; a chain touching neither becomes its own storyline named after its first slice", () => {
    const noSource = MODEL_117.replaceAll(' source "docs/orders.md#place"', "");
    const s = suggest(noSource);
    expect(s.storylines.map((g) => [g.name, g.sliceIndexes, g.basis])).toEqual([["Place Order journey", [0, 1, 2, 3], "view-chain"]]);
    const two = MODEL_117.replace('slice "Place Order Manually" source "docs/orders.md#place"', 'slice "Place Order Manually" source "docs/other.md#manual"');
    const t = suggest(two);
    expect(t.storylines.map((g) => g.name).sort()).toEqual(["Manual", "Orders journey", "Place"]); // the chain spans two sources, so its unsourced slices stand alone
    expect(t.storylines.reduce((n, g) => n + g.sliceIndexes.length, 0) + t.ungrouped.length).toBe(4);
  });

  it("the patch applies with `git apply` and the result compiles with the proposed storylines and no errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-gh290-suggest-"));
    dirs.push(dir);
    writeFileSync(join(dir, "orders.em"), MODEL_117);
    const patch = suggest(MODEL_117).patch;
    expect(patch).toContain("--- a/orders.em");
    expect(patch).toContain('+storyline "Place" source "docs/orders.md#place" {');
    writeFileSync(join(dir, "p.patch"), patch);
    git(dir, "init", "-q");
    const applied = spawnSync("git", ["-C", dir, "apply", "--check", "p.patch"], { encoding: "utf8" });
    expect(applied.status, applied.stderr).toBe(0);
    spawnSync("git", ["-C", dir, "apply", "p.patch"], { encoding: "utf8" });
    const next = readFileSync(join(dir, "orders.em"), "utf8");
    const { model, diagnostics } = compile(next);
    expect((model.storylines ?? []).map((g) => g.name)).toEqual(["Place"]);
    expect(model.slices.map((sl) => sl.name)).toEqual(compile(MODEL_117).model.slices.map((sl) => sl.name));
    expect(diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("a declaration between two slices of one story splits the run into two same-name blocks, and the patch still applies and validates", () => {
    const src =
      'model "M"\ncontext C\npersona P\n' +
      'slice "A" source "x.md#a" {\n  ui U @P\n  command Do A\n  event A Done @C\n}\n\npersona Q\n\n# note\n' +
      'slice "B" source "x.md#a" {\n  ui V @Q\n  command Do B\n  event B Done @C\n}\n';
    const s = buildStorylineSuggestion(compile(src).model, src, "./mg.em");
    expect(s.storylines[0].sliceIndexes).toEqual([0, 1]);
    expect(s.patch.match(/^\+storyline "A"/gm)).toHaveLength(2);
    expect(s.patch.match(/^\+storyline "A" source/gm)).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), "em-gh290-gap-"));
    dirs.push(dir);
    writeFileSync(join(dir, "mg.em"), src);
    writeFileSync(join(dir, "p.patch"), s.patch);
    git(dir, "init", "-q");
    git(dir, "apply", "--check", "p.patch");
    git(dir, "apply", "p.patch");
    const { model, diagnostics } = compile(readFileSync(join(dir, "mg.em"), "utf8"));
    expect(model.slices.map((sl) => sl.storyline)).toEqual(["A", "A"]);
    expect(diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("diff headers are cwd-relative with no ./ prefix and never absolute", () => {
    const { model } = compile(MODEL_117);
    const hdr = (f: string) => buildStorylineSuggestion(model, MODEL_117, f).patch.split("\n")[0];
    expect(hdr("./x.em")).toBe("--- a/x.em");
    expect(hdr("x.em")).toBe("--- a/x.em");
    expect(hdr(join(process.cwd(), "x.em"))).toBe("--- a/x.em");
    expect(hdr(join(tmpdir(), "elsewhere", "x.em"))).toBe("--- a/x.em");
  });

  it("proposes nothing for a model with no source and no again chain, and never writes the model", () => {
    const plain = 'model "M"\ncontext C\npersona P\nslice "S" {\n  ui U @P\n  command Do\n  event Done @C\n}\n';
    expect(suggest(plain)).toMatchObject({ patch: "", storylines: [], ungrouped: [0] });
  });

  it("non-adjacent slices of one source become a continued block (source only on the first)", () => {
    const src =
      'model "M"\ncontext C\npersona P\n' +
      'slice "A" source "x.md#a" {\n  ui U @P\n  command Do A\n  event A Done @C\n}\n' +
      'slice "B" {\n  ui V @P\n  command Do B\n  event B Done @C\n}\n' +
      'slice "C" source "x.md#a" {\n  ui W @P\n  command Do C\n  event C Done @C\n}\n';
    const s = suggest(src);
    expect(s.storylines).toHaveLength(1);
    expect(s.storylines[0].sliceIndexes).toEqual([0, 2]);
    expect(s.ungrouped).toEqual([1]);
    expect(s.patch.match(/\+storyline "A"/g)).toHaveLength(2);
    expect(s.patch.match(/\+storyline "A" source "x.md#a" \{/g)).toHaveLength(1);
  });
});
