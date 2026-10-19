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

describe("parseRoster (schema validation)", () => {
  it("parses the documented shape; contexts are optional and a leading @ is tolerated", () => {
    const r = parseRoster(ROSTER.replace("[Product, Attribute]", "[\"@Product\", Attribute]"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.roster.ratifiers).toEqual([
      { name: "Aaron McKay", contexts: ["Product", "Attribute"] },
      { name: "Mike Key", contexts: null },
    ]);
    expect(r.roster.reviewers).toEqual([{ name: "Mike Key", contexts: null }]);
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
    const text = renderRoster({ ratifiers: ["Alex", 'Quote "Q"'], reviewers: ["Sam"] });
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
  view Paid List from "Paid"
  ui Paid Screen @Customer
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
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER);
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
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER);
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
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER);
    const loaded = loadRoster(join(dir, "sub"));
    expect(loaded.state).toBe("present");
  });

  it("--slice-ready: a hand-edited ratifiedBy not on the roster is ratified-by-not-in-roster (error, in --json, refs the slice); a permitted name passes", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER);
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
    writeFileSync(join(dir, "ratifiers.yaml"), ROSTER);
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
      expect(parsed.roster.ratifiers).toEqual([{ name: "Alex", contexts: null }]);
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
