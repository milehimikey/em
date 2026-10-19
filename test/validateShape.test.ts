// SPDX-License-Identifier: MIT
// GH #282 — `em validate --shape`: the focused view of the shape-family lints, its waive file, and
// the engagement plan pre-flight that lists the same findings. (MCP parity: test/mcp.test.ts.)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { RULES } from "../src/model/rules.js";
import { buildShapeReport, shapeRuleCodes } from "../src/cli/shape.js";
import { buildNewEngagement, engagementPlanFor, formatEngagementPlanText, type EngagementModelInput } from "../src/cli/engagement.js";
import { engagementPath } from "../src/cli/engagementFile.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// The CRUD-on-a-timeline fixture (same shape as test/timelineEntityClustered.test.ts's CLUSTERED).
const CRUD = `
slice "Create Class" {
  ui Class Form
  command Create Class
  event Class Created @Catalog
}
slice "Rename Class" {
  ui Rename Form
  command Rename Class
  event Class Renamed @Catalog
}
slice "Retire Class" {
  ui Retire Form
  command Retire Class
  event Class Retired @Catalog
}
slice "Class List" {
  view Class List from "Class Created", "Class Renamed", "Class Retired"
  ui Class Screen
}
slice "Set Price" {
  ui Price Form
  command Set Price
  event Price Set @Pricing
}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-shape-"));
  writeFileSync(join(dir, "crud.em"), CRUD);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shape family registry", () => {
  it("selects rules by the family field alone, and slice-outside-storyline is in it", () => {
    const codes = shapeRuleCodes();
    expect(codes).toContain("timeline-entity-clustered");
    expect(codes).toContain("slice-outside-storyline");
    for (const c of codes) expect(RULES[c].severity).toBe("warning");
  });
});

describe("em validate --shape", () => {
  it("prints a rule / count / first ref / docs table and exits 0 on the CRUD fixture", () => {
    const r = em(["validate", "crud.em", "--shape"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^rule\s+count\s+first ref\s+docs/);
    expect(r.stdout).toMatch(/timeline-entity-clustered\s+1\s+create-class\s+docs\/validation\.md#shape/);
    expect(r.stdout).toContain("shape-accepted: <rule> <refs> — <reason>");
  }, 30_000);

  it("--json carries shapeSchemaVersion 1.0 with per-rule arrays and refs; every family rule is listed", () => {
    const r = em(["validate", "crud.em", "--shape", "--json"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.shapeSchemaVersion).toBe("1.0");
    expect(doc.clean).toBe(false);
    expect(doc.summary).toMatchObject({ findings: 1, waived: 0 });
    const rule = doc.rules.find((x: { code: string }) => x.code === "timeline-entity-clustered");
    expect(rule.count).toBe(1);
    expect(rule.findings[0].refs).toEqual(["create-class", "rename-class", "retire-class"]);
    expect(rule.waived).toEqual([]);
    expect(doc.rules.map((x: { code: string }) => x.code)).toEqual(shapeRuleCodes());
  }, 30_000);

  it("a clean model reports clean and exits 0", () => {
    writeFileSync(join(dir, "ok.em"), 'slice "A" {\n  command Do A\n  event A Done\n}\n');
    const doc = JSON.parse(em(["validate", "ok.em", "--shape", "--json"], dir).stdout);
    expect(doc.clean).toBe(true);
    expect(em(["validate", "ok.em", "--shape"], dir).stdout).toContain("ok — no shape findings");
  }, 30_000);

  it("--waive-file lists waived findings separately and does not count them", () => {
    writeFileSync(join(dir, "shape.waive"), "# baseline\ncreate-class\nrename-class\nretire-class\n");
    const doc = JSON.parse(em(["validate", "crud.em", "--shape", "--waive-file", "shape.waive", "--json"], dir).stdout);
    expect(doc.clean).toBe(true);
    expect(doc.summary).toMatchObject({ findings: 0, waived: 1 });
    const rule = doc.rules.find((x: { code: string }) => x.code === "timeline-entity-clustered");
    expect(rule.count).toBe(0);
    expect(rule.waived).toHaveLength(1);
    const text = em(["validate", "crud.em", "--shape", "--waive-file", "shape.waive"], dir);
    expect(text.stdout).toContain("waived (1, not counted):");
  }, 30_000);

  it("a partial waive file leaves the finding counted; a stale key is noted; a missing file waives nothing", () => {
    writeFileSync(join(dir, "partial.waive"), "create-class\nno-such-slice\n");
    const r = em(["validate", "crud.em", "--shape", "--waive-file", "partial.waive", "--json"], dir);
    expect(JSON.parse(r.stdout).summary).toMatchObject({ findings: 1, waived: 0 });
    expect(r.stderr).toContain('waiver "no-such-slice"');
    expect(JSON.parse(r.stdout).staleWaivers).toEqual(["create-class", "no-such-slice"]);
    expect(JSON.parse(em(["validate", "crud.em", "--shape", "--waive-file", "absent.waive", "--json"], dir).stdout).summary.findings).toBe(1);
  }, 30_000);

  it("rule-scoped waivers: `<rule> <key>` waives only that rule; a bare key waives every shape rule; unknown rule codes are stale", () => {
    // Class List is inside a storyline; the other slices are outside it, so two shape rules fire.
    const both = CRUD.replace(
      /slice "Class List" \{[\s\S]*?\n\}\n/,
      'storyline "Main" {\n  slice "Class List" {\n    view Class List from "Class Created", "Class Renamed", "Class Retired"\n    ui Class Screen\n  }\n}\n',
    );
    writeFileSync(join(dir, "both.em"), both);
    const run = (waive: string) => {
      writeFileSync(join(dir, "w.waive"), waive);
      const r = em(["validate", "both.em", "--shape", "--waive-file", "w.waive", "--json"], dir);
      expect(r.status).toBe(0);
      return { doc: JSON.parse(r.stdout), stderr: r.stderr };
    };
    const rule = (doc: any, code: string) => doc.rules.find((x: { code: string }) => x.code === code);
    const base = run("");
    expect(rule(base.doc, "timeline-entity-clustered").count).toBe(1);
    expect(rule(base.doc, "slice-outside-storyline").count).toBeGreaterThan(0);
    const scoped = run("timeline-entity-clustered create-class\ntimeline-entity-clustered rename-class\ntimeline-entity-clustered retire-class\n");
    expect(rule(scoped.doc, "timeline-entity-clustered").count).toBe(0);
    expect(rule(scoped.doc, "slice-outside-storyline").count).toBe(rule(base.doc, "slice-outside-storyline").count);
    const bare = run("create-class\nrename-class\nretire-class\nset-price\n");
    expect(rule(bare.doc, "timeline-entity-clustered").count).toBe(0);
    expect(rule(bare.doc, "slice-outside-storyline").count).toBe(0);
    expect(bare.doc.summary.findings).toBe(0);
    const unknown = run("no-such-rule create-class\n");
    expect(unknown.doc.staleWaivers).toEqual(["no-such-rule create-class"]);
    expect(unknown.stderr).toContain("no-such-rule create-class");
    expect(unknown.doc.summary.waived).toBe(0);
  }, 30_000);

  it("refuses --waive-file without --shape and --shape with --slice-ready", () => {
    expect(em(["validate", "crud.em", "--waive-file", "x"], dir).status).toBe(1);
    expect(em(["validate", "crud.em", "--shape", "--slice-ready", "create-class"], dir).status).toBe(1);
  }, 30_000);

  it("refuses --strict together with --shape (shape findings never gate)", () => {
    const r = em(["validate", "crud.em", "--shape", "--strict"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--strict applies only without --shape");
  }, 30_000);

  it("buildShapeReport waives only when every ref is under a waived key", () => {
    const { diagnostics } = compile(CRUD);
    expect(buildShapeReport(diagnostics, ["create-class", "rename-class", "retire-class"]).waived).toBe(1);
    expect(buildShapeReport(diagnostics, ["create-class"]).waived).toBe(0);
  });
});

describe("em engagement plan pre-flight lists shape findings (plan schema 1.3)", () => {
  function input(file: string): EngagementModelInput {
    const source = readFileSync(file, "utf8");
    const { model, refs, diagnostics } = compile(source);
    return { file, model, refs, baseDir: dirname(file), contract: { file, source, diagnostics }, allDiagnostics: diagnostics };
  }
  it("names the shape lint and the engagement slices it spans; a slice off the run sees none", () => {
    const file = join(dir, "crud.em");
    mkdirSync(join(dir, "engagements"), { recursive: true });
    const mk = (slug: string, keys: string[]) => {
      const r = buildNewEngagement(input(file), { slug, selector: { kind: "slices", keys }, parallel: 3, createdBy: null, tracking: null, created: "2026-10-18" });
      if (!r.ok) throw new Error(r.message);
      writeFileSync(engagementPath(file, slug), r.text);
      const p = engagementPlanFor(input(file), slug);
      if (!p.ok) throw new Error(p.message);
      return p.plan;
    };
    const p = mk("crud", ["create-class", "rename-class", "class-list"]);
    expect(p.preflight.filter((f) => f.kind === "shape").map((f) => [f.subject, f.slices])).toEqual([["timeline-entity-clustered", ["create-class", "rename-class"]]]);
    expect(formatEngagementPlanText(p)).toContain("shape: shape lint timeline-entity-clustered fires on 2 of the engagement's slices");
    expect(mk("price", ["set-price"]).preflight.filter((f) => f.kind === "shape")).toEqual([]);
    expect(formatEngagementPlanText(p)).toContain("pre-flight does not read the log");
  });

  it("slice-outside-storyline surfaces as a pre-flight shape finding and in --shape output", () => {
    const file = join(dir, "outside.em");
    writeFileSync(file, 'storyline "Main" {\n  slice "In" {\n    command Do In\n    event In Done\n  }\n}\nslice "Out" {\n  command Do Out\n  event Out Done\n}\n');
    mkdirSync(join(dir, "engagements"), { recursive: true });
    const r = buildNewEngagement(input(file), { slug: "o", selector: { kind: "slices", keys: ["out"] }, parallel: 3, createdBy: null, tracking: null, created: "2026-10-18" });
    if (!r.ok) throw new Error(r.message);
    writeFileSync(engagementPath(file, "o"), r.text);
    const p = engagementPlanFor(input(file), "o");
    if (!p.ok) throw new Error(p.message);
    expect(p.plan.preflight.filter((f) => f.kind === "shape").map((f) => [f.subject, f.slices])).toEqual([["slice-outside-storyline", ["out"]]]);
    const shape = JSON.parse(em(["validate", "outside.em", "--shape", "--json"], dir).stdout);
    expect(shape.rules.find((x: { code: string }) => x.code === "slice-outside-storyline").findings[0].refs).toEqual(["out"]);
  }, 30_000);
});
