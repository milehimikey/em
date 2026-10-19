// SPDX-License-Identifier: MIT
// GH #259: the optional ratifier roster (`ratifiers.yaml`) — loader/schema validation, the
// ratify/review --by refusal, the `--slice-ready` ratified-by-not-in-roster gate, `em status`
// presence, `em roster init`, and "file absent = today's behaviour".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoster, rosterRefusal, loadRoster } from "../src/roster/roster.js";
import { renderRoster } from "../src/roster/init.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const ROSTER = `rosterSchemaVersion: "1.0"
ratifiers:
  - name: Aaron McKay
    contexts: [Product, Attribute]
  - name: Mike Key
reviewers:
  - name: Mike Key
`;

const ROSTER_CLI = ROSTER.replace("[Product, Attribute]", "[Product]");

describe("parseRoster (schema validation)", () => {
  it("parses the documented shape; contexts are optional and a leading @ is tolerated", () => {
    const r = parseRoster(ROSTER.replace("[Product, Attribute]", "[\"@Product\", Attribute]"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roster.ratifiers).toEqual([
      { name: "Aaron McKay", contexts: ["Product", "Attribute"], models: null },
      { name: "Mike Key", contexts: null, models: null },
    ]);
    expect(r.roster.reviewers).toEqual([{ name: "Mike Key", contexts: null, models: null }]);
  });

  it.each([
    ["not a mapping", "- a\n- b\n"],
    ["missing version", "ratifiers:\n  - name: A\n"],
    ["wrong version", 'rosterSchemaVersion: "9.0"\nratifiers:\n  - name: A\n'],
    ["unknown top key", 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\nowners: []\n'],
    ["neither list", 'rosterSchemaVersion: "1.0"\n'],
    ["empty list", 'rosterSchemaVersion: "1.0"\nratifiers: []\n'],
    ["entry without name", 'rosterSchemaVersion: "1.0"\nratifiers:\n  - contexts: [A]\n'],
    ["unknown entry key", 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\n    role: x\n'],
    ["empty contexts", 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\n    contexts: []\n'],
    ["YAML syntax error", 'rosterSchemaVersion: "1.0"\nratifiers: [\n'],
  ])("rejects %s with a roster-invalid error", (_label, text) => {
    const r = parseRoster(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.code).toBe("roster-invalid");
      expect(d.severity).toBe("error");
    }
  });

  it("rosterRefusal: a context-limited name is permitted only in its contexts; the message lists permitted names", () => {
    const r = parseRoster(ROSTER);
    if (!r.ok) throw new Error("fixture invalid");
    expect(rosterRefusal(r.roster, "ratifiers", "Aaron McKay", ["Product"])).toBeNull();
    expect(rosterRefusal(r.roster, "ratifiers", "Mike Key", ["Billing"])).toBeNull();
    const refused = rosterRefusal(r.roster, "ratifiers", "Aaron McKay", ["Billing"]);
    expect(refused).toContain("not on the ratifiers roster for context Billing");
    expect(refused).toContain("permitted: Mike Key");
    expect(rosterRefusal(r.roster, "ratifiers", "Nobody", ["Product"])).toContain("permitted: Aaron McKay, Mike Key");
  });

  it("a missing reviewers key leaves review unrestricted", () => {
    const r = parseRoster('rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\n');
    if (!r.ok) throw new Error("fixture invalid");
    expect(rosterRefusal(r.roster, "reviewers", "Anyone", [])).toBeNull();
  });

  it("renderRoster output round-trips through parseRoster", () => {
    const text = renderRoster({ ratifiers: ["Alex", 'Quote "Q"'], reviewers: ["Sam"], grandfathered: 0 });
    const r = parseRoster(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.roster.ratifiers?.map((e) => e.name)).toEqual(["Alex", 'Quote "Q"']);
  });
});

const MODEL = `context Product
context Billing
slice "Pay" {
  ui Pay Screen @Customer
  command Pay Now note "slices/pay.md"
  event Paid @Billing
}
slice "Paid View" {
  view Paid List from "Paid" note "slices/paid-view.md"
  ui Paid Screen @Customer
}
slice "Paid Again" {
  view Paid List again
  ui Paid Again Screen @Customer
}
slice "List" {
  ui List Screen @Customer
  command List Item note "slices/list.md"
  event Listed @Product
}
slice "Listed View" {
  view Listed List from "Listed"
  ui Listed Screen @Customer
}
`;
const body = (title: string) => `# Slice: ${title}\n\n## Intent\n\nx.\n\n## Open Questions\n\n## Notes\n\nnone\n`;
const draft = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n";
const hand = (by: string) =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\nratifiedBy: ${by}\nratifiedOn: 2026-10-02\n---\n`;

describe("roster through the CLI (GH #259)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh259-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "model.em"), MODEL);
    writeFileSync(join(dir, "slices", "pay.md"), draft + body("Pay"));
    writeFileSync(join(dir, "slices", "list.md"), draft + body("List"));
    writeFileSync(join(dir, "slices", "paid-view.md"), draft + body("Paid View"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("roster ABSENT: ratify/review accept any name, slice-ready passes, status says absent (unchanged behaviour)", () => {
    expect(em(["slice", "review", "model.em", "pay", "--by", "Whoever"], dir).status).toBe(0);
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Anyone At All"], dir).status).toBe(0);
    expect(em(["validate", "model.em", "--slice-ready", "pay"], dir).status).toBe(0);
    const status = JSON.parse(em(["status", "model.em", "--json"], dir).stdout);
    expect(status.statusSchemaVersion).toBe("1.12");
    expect(status.roster).toBe("absent");
  });

  it("ratify refuses a name not permitted for the slice's context (message lists permitted names); a permitted name passes", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    em(["slice", "review", "model.em", "pay", "--by", "Mike Key"], dir);
    // pay is in context Billing: Aaron is limited to Product/Attribute.
    const refused = em(["slice", "ratify", "model.em", "pay", "--by", "Aaron McKay"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('"Aaron McKay" is not on the ratifiers roster for context Billing (permitted: Mike Key)');
    expect(readFileSync(join(dir, "slices", "pay.md"), "utf8")).not.toContain("ratifiedBy");
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Mike Key"], dir).status).toBe(0);
    // list is in context Product: Aaron may sign there.
    em(["slice", "review", "model.em", "list", "--by", "Mike Key"], dir);
    expect(em(["slice", "ratify", "model.em", "list", "--by", "Aaron McKay"], dir).status).toBe(0);
  });

  it("review --by is checked against reviewers[] when present, and unrestricted when the key is absent", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    const refused = em(["slice", "review", "model.em", "pay", "--by", "Aaron McKay"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not on the reviewers roster");
    expect(refused.stderr).toContain("permitted: Mike Key");
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Mike Key\n');
    expect(em(["slice", "review", "model.em", "pay", "--by", "Aaron McKay"], dir).status).toBe(0);
  });

  it("an invalid roster fails closed on ratify/review with the schema message", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), "ratifiers: nope\n");
    const r = em(["slice", "review", "model.em", "pay", "--by", "Mike Key"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is invalid");
    expect(JSON.parse(em(["status", "model.em", "--json"], dir).stdout).roster).toBe("invalid");
  });

  it("--roster <path> overrides discovery (one roster for several models); a missing path is an error, not 'no roster'", () => {
    mkdirSync(join(dir, "shared"));
    writeFileSync(join(dir, "shared", "team.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Sam\nreviewers:\n  - name: Mike Key\n');
    em(["slice", "review", "model.em", "pay", "--by", "Mike Key", "--roster", "shared/team.yaml"], dir);
    const refused = em(["slice", "ratify", "model.em", "pay", "--by", "Mike Key", "--roster", "shared/team.yaml"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("permitted: Sam");
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Sam", "--roster", "shared/team.yaml"], dir).status).toBe(0);
    const missing = em(["slice", "ratify", "model.em", "list", "--by", "Sam", "--roster", "nope.yaml"], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("does not exist");
  });

  it("a roster in a parent directory (up to the repo root) governs a model in a subdirectory", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    const loaded = loadRoster(join(dir, "sub"));
    expect(loaded.state).toBe("present");
  });

  it("--slice-ready: a hand-edited ratifiedBy not on the roster is ratified-by-not-in-roster (error, in --json, refs the slice); a permitted name passes", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    writeFileSync(join(dir, "slices", "pay.md"), hand("Aaron McKay") + body("Pay"));
    const r = em(["validate", "model.em", "--slice-ready", "pay"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not on the ratifiers roster for context Billing");
    const json = JSON.parse(em(["validate", "model.em", "--slice-ready", "pay", "--json"], dir).stdout);
    expect(json.ready).toBe(false);
    const d = json.diagnostics.find((x: { code: string }) => x.code === "ratified-by-not-in-roster");
    expect(d.severity).toBe("error");
    expect(d.refs).toEqual(["pay"]);
    writeFileSync(join(dir, "slices", "pay.md"), hand("Mike Key") + body("Pay"));
    expect(em(["validate", "model.em", "--slice-ready", "pay"], dir).status).toBe(0);
    // And a roster-limited name inside its own context passes.
    writeFileSync(join(dir, "slices", "list.md"), hand("Aaron McKay") + body("List"));
    expect(em(["validate", "model.em", "--slice-ready", "list"], dir).status).toBe(0);
  });

  it("--slice-ready: an invalid roster is a roster-invalid error; no roster means no new diagnostic", () => {
    writeFileSync(join(dir, "slices", "pay.md"), hand("Anyone") + body("Pay"));
    expect(em(["validate", "model.em", "--slice-ready", "pay"], dir).status).toBe(0);
    writeFileSync(join(dir, "ratifiers.yaml"), "- bad\n");
    const json = JSON.parse(em(["validate", "model.em", "--slice-ready", "pay", "--json"], dir).stdout);
    expect(json.diagnostics.map((x: { code: string }) => x.code)).toContain("roster-invalid");
  });

  it("--roster on validate requires --slice-ready", () => {
    const r = em(["validate", "model.em", "--roster", "x.yaml"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--roster applies only with --slice-ready");
  });

  it("em status reports roster: present (JSON and text)", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    expect(JSON.parse(em(["status", "model.em", "--json"], dir).stdout).roster).toBe("present");
    expect(em(["status", "model.em"], dir).stdout).toContain("roster: present");
  });

  it("em roster init seeds ratifiers/reviewers from the names in the slice docs, skips the grandfathered placeholder, refuses to overwrite without --force", () => {
    writeFileSync(join(dir, "slices", "pay.md"), hand("Alex") + body("Pay"));
    writeFileSync(join(dir, "slices", "list.md"), hand("grandfathered (unsigned before em 1.14)") + body("List"));
    const r = em(["roster", "init", "model.em"], dir);
    expect(r.status).toBe(0);
    const parsed = parseRoster(readFileSync(join(dir, "ratifiers.yaml"), "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.roster.ratifiers).toEqual([{ name: "Alex", contexts: null, models: null }]);
      expect(parsed.roster.reviewers).toBeNull();
    }
    const again = em(["roster", "init", "model.em"], dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect(em(["roster", "init", "model.em", "--force"], dir).status).toBe(0);
  });

  it("em roster init with no signed docs writes nothing", () => {
    const r = em(["roster", "init", "model.em"], dir);
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, "ratifiers.yaml"))).toBe(false);
  });
});

// ---- review round: cross-context, views/continuations, models, grandfathered, check, discovery, CI ----

const implementedDoc = (by: string, extra = "") =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nratifiedBy: ${by}\nratifiedOn: 2026-10-02\n${extra}---\n`;

describe("roster, review round (GH #259)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh259b-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "model.em"), MODEL);
    for (const k of ["pay", "list", "paid-view"]) writeFileSync(join(dir, "slices", `${k}.md`), draft + body(k));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sliceContexts: events, then the events a view reads; a continuation takes its originating view's", async () => {
    const { compile } = await import("../src/pipeline.js");
    const { sliceContexts } = await import("../src/roster/roster.js");
    const { model, refs } = compile(MODEL);
    const ctx = (key: string) => sliceContexts(model, refs.sliceKeys.indexOf(key));
    expect(ctx("pay")).toEqual(["Billing"]);
    expect(ctx("paid-view")).toEqual(["Billing"]); // no event of its own: the view reads Paid
    expect(ctx("paid-again")).toEqual(["Billing"]); // continuation: originating view's events
  });

  it("a ratifier must be permitted for EVERY context of a cross-context slice", () => {
    const r = parseRoster('rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\n    contexts: [Product]\n  - name: B\n    contexts: [Product, Billing]\n  - name: C\n');
    if (!r.ok) throw new Error("fixture");
    expect(rosterRefusal(r.roster, "ratifiers", "A", ["Product", "Billing"])).toContain("context Product + Billing");
    expect(rosterRefusal(r.roster, "ratifiers", "B", ["Product", "Billing"])).toBeNull();
    expect(rosterRefusal(r.roster, "ratifiers", "C", ["Product", "Billing"])).toBeNull();
    // A slice with no context at all: only whole-model entries.
    expect(rosterRefusal(r.roster, "ratifiers", "A", [])).not.toBeNull();
    expect(rosterRefusal(r.roster, "ratifiers", "C", [])).toBeNull();
  });

  it("a view slice and a continuation slice are ratifiable by a context-scoped entry (and refused for another context)", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Bill\n    contexts: [Billing]\n  - name: Prod\n    contexts: [Product]\n');
    em(["slice", "review", "model.em", "paid-view", "--by", "X"], dir);
    expect(em(["slice", "ratify", "model.em", "paid-view", "--by", "Prod"], dir).status).toBe(1);
    expect(em(["slice", "ratify", "model.em", "paid-view", "--by", "Bill"], dir).status).toBe(0);
    // Continuation key resolves to the originating doc; slice-ready judges it by the continuation's own contexts.
    expect(em(["validate", "model.em", "--slice-ready", "paid-again"], dir).stderr).not.toContain("roster");
    writeFileSync(join(dir, "slices", "paid-view.md"), hand("Prod") + body("Paid View"));
    expect(em(["validate", "model.em", "--slice-ready", "paid-again"], dir).stderr).toContain("not on the ratifiers roster for context Billing");
  });

  it("contexts the model does not declare are roster-invalid, naming the context (case-sensitive)", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: A\n    contexts: [billing]\n');
    const r = em(["slice", "review", "model.em", "pay", "--by", "A"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown context "billing"');
    const c = JSON.parse(em(["roster", "check", "model.em", "--json"], dir).stdout);
    expect(c.ok).toBe(false);
    expect(c.diagnostics[0].code).toBe("roster-invalid");
  });

  it("models: scopes an entry to named models; an entry for another model does not apply; unknown system model keys are roster-invalid", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Here\n    models: [model]\n  - name: Elsewhere\n    models: [other-model]\n');
    em(["slice", "review", "model.em", "pay", "--by", "X"], dir);
    const refused = em(["slice", "ratify", "model.em", "pay", "--by", "Elsewhere"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("permitted: Here");
    expect(em(["slice", "ratify", "model.em", "pay", "--by", "Here"], dir).status).toBe(0);
    writeFileSync(join(dir, "system.yaml"), 'systemSchemaVersion: "2.0"\nmodels:\n  model:\n    source: model.em\n');
    const bad = em(["roster", "check", "model.em"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('names "other-model", which is not a model of the system');
  });

  it("the grandfathered placeholder is exempt from --slice-ready and roster check, and counted", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    writeFileSync(join(dir, "slices", "pay.md"), hand("grandfathered (unsigned before em 1.14)") + body("Pay"));
    expect(em(["validate", "model.em", "--slice-ready", "pay"], dir).status).toBe(0);
    const c = em(["roster", "check", "model.em"], dir);
    expect(c.status).toBe(0);
    expect(c.stdout).toContain("1 doc carries the grandfathered placeholder and is exempt until re-ratified");
    expect(JSON.parse(em(["roster", "check", "model.em", "--json"], dir).stdout).grandfathered).toBe(1);
    const init = em(["roster", "init", "model.em", "--force"], dir);
    expect(init.stdout).toContain("grandfathered placeholder");
    expect(init.status).toBe(1); // nothing but the placeholder: no names to seed
  });

  it("roster check covers implemented docs and reviewedBy; --json lists per-doc results with refs; exit 1 on a violation", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    writeFileSync(join(dir, "slices", "pay.md"), implementedDoc("Aaron McKay", "reviewedBy: Aaron McKay\nreviewedOn: 2026-10-01\n") + body("Pay"));
    writeFileSync(join(dir, "slices", "list.md"), implementedDoc("Aaron McKay") + body("List"));
    const c = em(["roster", "check", "model.em", "--json"], dir);
    expect(c.status).toBe(1);
    const doc = JSON.parse(c.stdout);
    expect(doc.ok).toBe(false);
    const bad = doc.results.filter((r: { ok: boolean }) => !r.ok).map((r: { sliceKey: string; role: string }) => `${r.sliceKey}:${r.role}`);
    expect(bad).toEqual(["pay:ratifiers", "pay:reviewers"]); // list is in Product, where Aaron may sign
    expect(doc.diagnostics.map((d: { code: string; refs: string[] }) => [d.code, d.refs[0]])).toEqual([
      ["ratified-by-not-in-roster", "pay"],
      ["reviewed-by-not-in-roster", "pay"],
    ]);
  });

  it("roster check: no roster = nothing to check (exit 0); --roster override; invalid roster exits 1", () => {
    const none = em(["roster", "check", "model.em"], dir);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("nothing to check");
    writeFileSync(join(dir, "slices", "pay.md"), implementedDoc("Zed") + body("Pay"));
    writeFileSync(join(dir, "other.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Zed\n');
    expect(em(["roster", "check", "model.em", "--roster", "other.yaml"], dir).status).toBe(0);
    writeFileSync(join(dir, "ratifiers.yaml"), "nope: 1\n");
    expect(em(["roster", "check", "model.em"], dir).status).toBe(1);
  });

  it("discovery stops at the nearest repo root; with none above, only the model's own directory is searched", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    expect(loadRoster(join(dir, "sub")).state).toBe("absent"); // no repo root above: the parent roster must not govern
    mkdirSync(join(dir, ".git"));
    expect(loadRoster(join(dir, "sub")).state).toBe("present");
    mkdirSync(join(dir, "sub", "inner"));
    mkdirSync(join(dir, "sub", "inner", ".git")); // a nearer repo root hides the outer roster
    expect(loadRoster(join(dir, "sub", "inner")).state).toBe("absent");
  });

  it("roster init refuses to write a nearer roster that would shadow one discovered higher up, unless --force", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    writeFileSync(join(dir, "sub", "model.em"), MODEL);
    mkdirSync(join(dir, "sub", "slices"));
    writeFileSync(join(dir, "sub", "slices", "pay.md"), hand("Alex") + body("Pay"));
    const r = em(["roster", "init", "sub/model.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would shadow it");
    expect(em(["roster", "init", "sub/model.em", "--force"], dir).status).toBe(0);
  });

  it("em ci init emits a roster job only when a ratifiers.yaml governs the model; the multi-model form does it per model", async () => {
    const { ciManagedBody, ciManagedBodyMulti } = await import("../src/cli/ciInit.js");
    expect(ciManagedBody("model.em", "tests", "1.0.0")).not.toContain("roster check");
    expect(ciManagedBody("model.em", "tests", "1.0.0", true)).toContain('roster check "model.em"');
    const multi = ciManagedBodyMulti([{ key: "a", path: "a/a.em", roster: true }, { key: "b", path: "b/b.em" }], "tests", "1.0.0");
    expect(multi).toContain("roster-a:");
    expect(multi).not.toContain("roster-b:");
    // End to end: the CLI picks the flag up from discovery.
    expect(em(["ci", "init", "model.em", "--tests", "tests"], dir).status).toBe(0);
    expect(readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8")).not.toContain("roster check");
    rmSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    expect(em(["ci", "init", "model.em", "--tests", "tests"], dir).status).toBe(0);
    expect(readFileSync(join(dir, ".github", "workflows", "em-ci.yml"), "utf8")).toContain('roster check "model.em"');
  });
});

describe("roster, critic round 2 (GH #259)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh259c-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "model.em"), MODEL);
    for (const k of ["pay", "list", "paid-view"]) writeFileSync(join(dir, "slices", `${k}.md`), draft + body(k));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a forged 'grandfathered by X' prefix, or the marker on a hash-bearing doc, is checked by --slice-ready and roster check", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER_CLI);
    writeFileSync(join(dir, "slices", "pay.md"), hand("grandfathered by Mallory") + body("Pay"));
    const ready = em(["validate", "model.em", "--slice-ready", "pay"], dir);
    expect(ready.status).toBe(1);
    expect(ready.stderr).toContain("grandfathered by Mallory");
    const check = em(["roster", "check", "model.em", "--json"], dir);
    expect(check.status).toBe(1);
    expect(JSON.parse(check.stdout).grandfathered).toBe(0);
    // The exact marker, but on a doc that carries a ratifiedHash: not what em upgrade leaves, so it is a signer.
    writeFileSync(
      join(dir, "slices", "pay.md"),
      hand("grandfathered (unsigned before em 1.14)").replace("ratifiedOn:", "ratifiedHash: sha256:abc\nratifiedOn:") + body("Pay"),
    );
    expect(em(["roster", "check", "model.em"], dir).status).toBe(1);
  });

  it("a view slice's contexts are its OWN from; adding a later instance does not change them; a continuation takes its originating instance's from too", async () => {
    const { compile } = await import("../src/pipeline.js");
    const { sliceContexts } = await import("../src/roster/roster.js");
    const src = `context Tool
context Loan
slice "Add Tool" {
  ui Add Screen @Customer
  command Add Tool
  event Tool Added @Tool
}
slice "Lend" {
  ui Lend Screen @Customer
  command Lend Tool
  event Tool Lent @Loan
}
slice "Browse Tools" {
  view Tools from "Tool Added"
  ui Browse @Customer
}
slice "Browse Lent" {
  view Tools again from "Tool Lent"
  ui Lent Browse @Customer
}
`;
    const { model, refs } = compile(src);
    const ctx = (key: string) => sliceContexts(model, refs.sliceKeys.indexOf(key));
    expect(ctx("browse-tools")).toEqual(["Tool"]); // unchanged by the Loan-fed again instance
    // The again instance has its own from (Loan) and, as a continuation, the originating one (Tool).
    expect(ctx("browse-lent")).toEqual(["Loan", "Tool"]);
    const r = parseRoster('rosterSchemaVersion: "1.0"\nratifiers:\n  - name: T\n    contexts: [Tool]\n');
    if (!r.ok) throw new Error("fixture");
    expect(rosterRefusal(r.roster, "ratifiers", "T", ctx("browse-tools"))).toBeNull();
    expect(rosterRefusal(r.roster, "ratifiers", "T", ctx("browse-lent"))).not.toBeNull();
  });
});
