// SPDX-License-Identifier: MIT
// GH #491: batch `em slice review` / `em slice ratify` — several keys or --storyline.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const doc = (status: string, extra = "", body = "body\n") =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: 1\n${extra}---\n${body}`;

const MODEL =
  'model "Shop"\n\n' +
  'storyline "Orders" {\n' +
  '  slice "Alpha" {\n    command Do Alpha note "slices/alpha.md"\n    event Alpha Done\n  }\n' +
  '  slice "Beta" {\n    command Do Beta note "slices/beta.md"\n    event Beta Done\n  }\n' +
  "}\n" +
  'slice "Gamma" {\n  command Do Gamma note "slices/gamma.md"\n  event Gamma Done\n}\n' +
  'slice "Pub" {\n  command Do Pub public { id: uuid } note "slices/pub.md"\n  event Pub Done\n}\n';

describe("batch em slice review / ratify (GH #491)", { timeout: 30_000 }, () => {
  let dir: string;
  const read = (k: string) => readFileSync(join(dir, "slices", `${k}.md`), "utf8");
  const write = (k: string, c: string) => writeFileSync(join(dir, "slices", `${k}.md`), c);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-batch-sign-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "m.em"), MODEL);
    for (const k of ["alpha", "beta", "gamma", "pub"]) write(k, doc("draft"));
  });
  afterEach(() => rmTemp(dir));

  it("reviews several keys at once", () => {
    const r = em(["slice", "review", "m.em", "alpha", "beta", "--by", "Sam", "--on", "2026-11-01"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      "reviewed: slices/alpha.md (reviewedBy: Sam, reviewedOn: 2026-11-01)\nreviewed: slices/beta.md (reviewedBy: Sam, reviewedOn: 2026-11-01)\n",
    );
    expect(read("alpha")).toContain("status: reviewed");
    expect(read("gamma")).toContain("status: draft");
  });

  it("reviews a storyline", () => {
    const r = em(["slice", "review", "m.em", "--storyline", "Orders", "--by", "Sam", "--on", "2026-11-01"], dir);
    expect(r.status).toBe(0);
    expect(read("alpha")).toContain("reviewedBy: Sam");
    expect(read("beta")).toContain("reviewedBy: Sam");
    expect(read("gamma")).toContain("status: draft");
  });

  it("is all-or-nothing: one refusal writes nothing and lists every refusal", () => {
    write("beta", doc("draft", "", "body\n## Open Questions\n- [ ] undecided?\n"));
    write("gamma", doc("implemented"));
    const before = read("alpha");
    const r = em(["slice", "review", "m.em", "alpha", "beta", "gamma", "--by", "Sam", "--on", "2026-11-01"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("em slice review: beta:");
    expect(r.stderr).toContain("em slice review: gamma:");
    expect(r.stderr).toContain("nothing was written");
    expect(read("alpha")).toBe(before);
  });

  it("treats an already-reviewed slice (same name and date) as accepted", () => {
    em(["slice", "review", "m.em", "alpha", "--by", "Sam", "--on", "2026-11-01"], dir);
    const r = em(["slice", "review", "m.em", "alpha", "beta", "--by", "Sam", "--on", "2026-11-01"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already reviewed (no-op): slices/alpha.md");
    expect(r.stdout).toContain("reviewed: slices/beta.md");
  });

  it("rejects keys together with --storyline, and a missing selector", () => {
    const a = em(["slice", "review", "m.em", "alpha", "--storyline", "Orders", "--by", "Sam"], dir);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain("--storyline cannot be combined with slice keys");
    const b = em(["slice", "review", "m.em", "--by", "Sam"], dir);
    expect(b.status).toBe(1);
    expect(b.stderr).toContain("slice-key");
  });

  it("reports an unknown storyline", () => {
    const r = em(["slice", "review", "m.em", "--storyline", "Nope", "--by", "Sam"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no storyline "Nope"');
  });

  it("ratifies a storyline after review", () => {
    em(["slice", "review", "m.em", "--storyline", "Orders", "--by", "Sam", "--on", "2026-11-01"], dir);
    const r = em(["slice", "ratify", "m.em", "--storyline", "Orders", "--by", "Sam", "--on", "2026-11-02", "--no-ref"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ratified: slices/alpha.md (ratifiedBy: Sam, ratifiedOn: 2026-11-02) — ratifiedHash only");
    expect(read("beta")).toContain("status: ready-to-implement");
  });

  it("ratify: all-or-nothing when one slice has not been reviewed", () => {
    em(["slice", "review", "m.em", "alpha", "--by", "Sam", "--on", "2026-11-01"], dir);
    const r = em(["slice", "ratify", "m.em", "alpha", "beta", "--by", "Sam", "--on", "2026-11-02", "--no-ref"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("em slice ratify: beta:");
    expect(read("alpha")).toContain("status: reviewed");
  });

  it("ratify: refuses a public-touching slice from a batch, naming it", () => {
    em(["slice", "review", "m.em", "alpha", "pub", "--by", "Sam", "--on", "2026-11-01"], dir);
    const r = em(["slice", "ratify", "m.em", "alpha", "pub", "--by", "Sam", "--on", "2026-11-02", "--no-ref"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "pub" touches a public element');
    expect(r.stderr).toContain("--meaning-unchanged");
    expect(read("alpha")).toContain("status: reviewed");
    // ...and it is ratified singly as before.
    const one = em(["slice", "ratify", "m.em", "pub", "--by", "Sam", "--on", "2026-11-02", "--no-ref", "--meaning-unchanged"], dir);
    expect(one.status).toBe(0);
  });

  it("ratify: --meaning-unchanged / --contract-change with a batch is an error", () => {
    const r = em(["slice", "ratify", "m.em", "alpha", "beta", "--by", "Sam", "--meaning-unchanged"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot be used with a batch");
    const s = em(["slice", "ratify", "m.em", "--storyline", "Orders", "--by", "Sam", "--contract-change", "x"], dir);
    expect(s.status).toBe(1);
  });

  it("a single key behaves as before", () => {
    const r = em(["slice", "review", "m.em", "alpha", "--by", "Sam", "--on", "2026-11-01"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("reviewed: slices/alpha.md (reviewedBy: Sam, reviewedOn: 2026-11-01)\n");
  });
});
