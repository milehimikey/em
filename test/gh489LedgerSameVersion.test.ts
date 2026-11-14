// SPDX-License-Identifier: MIT
// GH #489: `em ledger` accepts a same-version content change before the version ships (`em slice
// revise` reopens it at the same `version:`) and when it is a recorded `em slice amend`; a
// shipped version changed with no amendment — or with a hand-typed `amendedOn:` beside a stale
// `ratifiedHash:` — stays `ledger-content-without-version-bump`. Real two-revision temporary git
// repos, driven through the real binary.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { sameVersionChangeAccepted } from "../src/cli/ledgerCheck.js";
import { parseSliceDoc } from "../src/catalog/sliceDoc.js";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const FM = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Command / Input\n\n| total | decimal |\n\n## Open Questions\n\n- [x] answered\n";

describe("em ledger: same-version changes (GH #489, CLI, real git)", () => {
  let dir: string;
  const docPath = () => join(dir, "slices", "pay.md");
  const read = () => readFileSync(docPath(), "utf8");
  const write = (s: string) => writeFileSync(docPath(), s);
  const commit = (msg: string) => {
    git(dir, "add", "slices/pay.md");
    git(dir, "commit", "-q", "-m", msg);
    return git(dir, "rev-parse", "HEAD");
  };
  const ok = (args: string[]) => {
    const r = em(args, dir);
    expect(r.status, r.stderr + r.stdout).toBe(0);
  };
  const ledger = (from: string) => {
    const r = em(["ledger", "model.em", "--from", from, "--to", "HEAD", "--json"], dir);
    return { status: r.status, doc: JSON.parse(r.stdout) as { ok: boolean; findings: { code: string }[] } };
  };
  const codes = (from: string) => ledger(from).doc.findings.map((f) => f.code);
  const ratify = () => ok(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02", "--skip-review"]);
  const ship = () => ok(["slice", "mark-implemented", "model.em", "pay", "https://github.com/org/repo/pull/7", "--on", "2026-10-13"]);
  const addField = () => read().replace("| total | decimal |", "| total | decimal |\n| currency | text |");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh489-"));
    mkdirSync(join(dir, "slices"));
    write(FM + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "model.em", "slices/pay.md");
    git(dir, "commit", "-q", "-m", "reviewed");
  });
  afterEach(() => rmTemp(dir));

  it("pre-ship: a behaviour change on a reviewed doc (no shipped record) at the same version is clean", () => {
    const base = git(dir, "rev-parse", "HEAD");
    write(addField());
    commit("edit while reviewed");
    expect(codes(base)).toEqual([]);
    expect(ledger(base).status).toBe(0);
  });

  it("pre-ship: revise on a ratified, unshipped version, an edit and a re-ratify keep version 1 and stay clean", () => {
    ratify();
    const base = commit("ratified");
    ok(["slice", "revise", "model.em", "pay", "--withdraw"]);
    expect(parseSliceDoc(read())).toMatchObject({ status: "draft", version: 1 });
    write(addField());
    commit("revised at the same version");
    ratify();
    commit("re-ratified");
    expect(parseSliceDoc(read()).version).toBe(1);
    expect(codes(base)).toEqual([]);
  });

  it("post-ship: a body edit with no amendment is still ledger-content-without-version-bump", () => {
    ratify();
    commit("ratified");
    ship();
    const base = commit("shipped");
    write(read().replace("Charge the customer.", "Charge the customer once."));
    commit("silent edit");
    const result = ledger(base);
    expect(result.status).toBe(1);
    expect(result.doc.findings.map((f) => f.code)).toContain("ledger-content-without-version-bump");
  });

  it("post-ship: a prose amendment recorded by the real `em slice amend` is clean", () => {
    ratify();
    commit("ratified");
    ship();
    const base = commit("shipped");
    write(read().replace("Charge the customer.", "Charge the customer once."));
    commit("prose fix");
    ok(["slice", "amend", "model.em", "pay", "--by", "Blair", "--on", "2026-11-13"]);
    commit("amended");
    expect(parseSliceDoc(read())).toMatchObject({ version: 1, amendedBy: "Blair", amendedOn: "2026-11-13" });
    expect(codes(base)).toEqual([]);
    expect(ledger(base).status).toBe(0);
  });

  it("post-ship: a hand-typed amendedOn beside a stale ratifiedHash is still an error", () => {
    ratify();
    commit("ratified");
    ship();
    const base = commit("shipped");
    const edited = read().replace("Charge the customer.", "Charge the customer once.");
    write(edited.replace("\n---\n# Slice", "\namendedBy: Blair\namendedOn: 2026-11-13\n---\n# Slice"));
    expect(read()).toContain("amendedOn: 2026-11-13");
    commit("forged amendment");
    const result = ledger(base);
    expect(result.status).toBe(1);
    expect(result.doc.findings.map((f) => f.code)).toContain("ledger-content-without-version-bump");
  });

  it("post-ship: a behaviour edit with no amend is an error", () => {
    ratify();
    commit("ratified");
    ship();
    const base = commit("shipped");
    write(addField());
    commit("behaviour edit, no amend");
    expect(codes(base)).toContain("ledger-content-without-version-bump");
  });

  it("the other findings are unchanged: a bump with no content change is still reported", () => {
    const base = git(dir, "rev-parse", "HEAD");
    write(read().replace("version: 1", "version: 2"));
    commit("bump only");
    expect(codes(base)).toEqual(["ledger-version-without-content-change"]);
  });

  it("readiness: an unamended edit to a ratified doc is still slice-ready-body-changed-since-ratification", () => {
    ratify();
    commit("ratified");
    write(read().replace("Charge the customer.", "Charge the customer once."));
    commit("edit");
    const r = em(["validate", "model.em", "--slice-ready", "pay"], dir);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("slice-ready-body-changed-since-ratification");
  });
});

describe("sameVersionChangeAccepted (GH #489)", () => {
  const doc = (extra: string, status = "implemented") =>
    parseSliceDoc(`---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: 2\nimplementedIn: PR#1\n${extra}---\nbody\n`);

  it("a draft reopened over an earlier shipped version is pre-ship", () => {
    expect(sameVersionChangeAccepted(doc("shippedVersion: 1\n", "draft"), doc("shippedVersion: 1\n", "draft"), false)).toBe("pre-ship");
  });

  it("a doc whose shipped version is the current one is not pre-ship, and without an amendment is rejected", () => {
    expect(sameVersionChangeAccepted(doc("shippedVersion: 2\n"), doc("shippedVersion: 2\n"), false)).toBeNull();
    expect(sameVersionChangeAccepted(doc(""), doc(""), false)).toBeNull(); // pre-1.15 implemented doc
  });
});
