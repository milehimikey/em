// SPDX-License-Identifier: MIT
// The signing and bookkeeping commands on a STORYLINE model (GH #421): slice docs live in
// `<storyline folder>/slices/`, and the doc join still reports `slices/<key>.md`. Each case here
// was silently wrong on such a model before 1.23.0 shipped, found by running the release against a
// real storyline repo:
//  - `em upgrade` did not find the docs, so `ratified-sections` stamped nothing;
//  - `em slice ratify`/`amend` asked git about a path that does not exist, so an uncommitted doc
//    was signed and HEAD recorded as its ref;
//  - `em ledger` skipped every storyline doc as "no prior revision" and printed ok;
//  - `em slice review|ratify --storyline` refused the whole storyline for a view shown again from
//    another storyline, or for a slice with nothing left to sign;
//  - `em inline-check` counted storyline docs as implementation code, and missed a doc withdrawn
//    and signed again over the same text;
//  - `em changelog` did not see a commit that changed only a storyline file.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { isModelMaterial } from "../src/cli/inlineCheck.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

const ROOT_EM = `model "Shed"
persona Neighbor
context Loans
storyline "Join the shed"
storyline "Borrow a tool" after "Join the shed"
`;
const JOIN_EM = `storyline "Join the shed"

slice "Register" {
  ui Sign Up @Neighbor
  command Register Neighbor { neighborId: Text } note "slices/register.md"
  event Neighbor Registered @Loans { neighborId: Text }
}
slice "My Account" {
  view My Account from "Neighbor Registered" { neighborId: Text } note "slices/my-account.md"
  ui Account @Neighbor
}
`;
const BORROW_EM = `storyline "Borrow a tool"

slice "Check Out Tool" {
  ui Checkout @Neighbor
  command Check Out Tool { loanId: Text } note "slices/check-out-tool.md"
  event Tool Checked Out @Loans { loanId: Text }
}
slice "My Account — after checkout" {
  view My Account again from "Tool Checked Out"
  ui Account @Neighbor
}
slice "Return Tool" {
  ui Return @Neighbor
  command Return Tool { loanId: Text } note "slices/return-tool.md"
  event Tool Returned @Loans { loanId: Text }
}
`;
const doc = (name: string, status: string, extra = "") =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: Neighbor → Loans\nstatus: ${status}\nversion: 1\n${extra}---\n# Slice: ${name}\n\n## Intent\nOriginal wording.\n\n## Scenarios (Given / When / Then)\n- one\n`;

describe("signing on a storyline model", { timeout: 120_000 }, () => {
  let dir: string;
  const em = (...args: string[]) => {
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  const path = (story: string, key: string) => join(dir, story, "slices", `${key}.md`);
  const read = (story: string, key: string) => readFileSync(path(story, key), "utf8");
  const edit = (story: string, key: string, from: string, to: string) => writeFileSync(path(story, key), read(story, key).replace(from, to));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-storyline-signing-"));
    writeFileSync(join(dir, "shed.em"), ROOT_EM);
    mkdirSync(join(dir, "join-the-shed", "slices"), { recursive: true });
    mkdirSync(join(dir, "borrow-a-tool", "slices"), { recursive: true });
    writeFileSync(join(dir, "join-the-shed", "join-the-shed.em"), JOIN_EM);
    writeFileSync(join(dir, "borrow-a-tool", "borrow-a-tool.em"), BORROW_EM);
    writeFileSync(path("join-the-shed", "register"), doc("Register", "implemented", "implementedIn: https://example.test/pr/1\nshippedVersion: 1\n"));
    writeFileSync(path("join-the-shed", "my-account"), doc("My Account", "implemented", "implementedIn: https://example.test/pr/2\nshippedVersion: 1\n"));
    writeFileSync(path("borrow-a-tool", "check-out-tool"), doc("Check Out Tool", "draft"));
    writeFileSync(path("borrow-a-tool", "return-tool"), doc("Return Tool", "draft"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    commit("model");
    git("tag", "base");
  });
  afterEach(() => rmTemp(dir));

  /** Review and ratify the two Borrow slices, each step committed. */
  const signBorrow = () => {
    expect(em("slice", "review", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam").status).toBe(0);
    commit("review");
    expect(em("slice", "ratify", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam").status).toBe(0);
    commit("ratify");
  };

  it("--storyline signs the storyline's own unsigned slices and says what it left out", () => {
    const r = em("slice", "review", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam", "--on", "2026-11-01");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      "reviewed: slices/check-out-tool.md (reviewedBy: Sam, reviewedOn: 2026-11-01)\nreviewed: slices/return-tool.md (reviewedBy: Sam, reviewedOn: 2026-11-01)\n",
    );
    // My Account is only shown again here; its doc belongs to the other storyline and is untouched.
    expect(r.stderr).toContain('not included: my-account (Join the shed)');
    expect(read("join-the-shed", "my-account")).toContain("status: implemented");

    commit("review");
    expect(em("slice", "ratify", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam").status).toBe(0);
    commit("ratify");
    // A second pass has nothing to sign: no write, and it says why per slice.
    const again = em("slice", "ratify", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("not included: check-out-tool — already ratified");
    expect(again.stderr).toContain("has no slice to ratify");
  });

  it("--storyline leaves out shipped slices with no version open; explicit keys still refuse them", () => {
    const r = em("slice", "review", "shed.em", "--storyline", "Join the shed", "--by", "Sam");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not included: register — shipped, no next version open");
    expect(r.stderr).toContain("has no slice to review");
    const keyed = em("slice", "review", "shed.em", "register", "check-out-tool", "--by", "Sam");
    expect(keyed.status).toBe(1);
    expect(keyed.stderr).toContain("batch refused");
    expect(read("borrow-a-tool", "check-out-tool")).toContain("status: draft");
  });

  it("a ratified doc that was edited is not skipped: the storyline ratify refuses", () => {
    signBorrow();
    edit("borrow-a-tool", "return-tool", "- one", "- one\n- two");
    commit("edit");
    const r = em("slice", "ratify", "shed.em", "--storyline", "Borrow a tool", "--by", "Sam");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("return-tool");
    expect(r.stderr).toContain("batch refused");
  });

  it("ratify and amend refuse an uncommitted doc in a storyline folder", () => {
    em("slice", "review", "shed.em", "check-out-tool", "--by", "Sam");
    const dirty = em("slice", "ratify", "shed.em", "check-out-tool", "--by", "Sam");
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("uncommitted changes");
    commit("review");
    expect(em("slice", "ratify", "shed.em", "check-out-tool", "--by", "Sam").status).toBe(0);
    expect(read("borrow-a-tool", "check-out-tool")).toContain(`ratifiedRef: ${git("rev-parse", "HEAD")}`);
    commit("ratify");

    edit("borrow-a-tool", "check-out-tool", "Original wording.", "Clearer wording.");
    const amendDirty = em("slice", "amend", "shed.em", "check-out-tool", "--by", "Sam");
    expect(amendDirty.status).toBe(1);
    expect(amendDirty.stderr).toContain("uncommitted changes");
    commit("wording");
    const amended = em("slice", "amend", "shed.em", "check-out-tool", "--by", "Sam");
    expect(amended.status).toBe(0);
    expect(amended.stdout).toContain("prose changed: Intent");
  });

  it("em upgrade stamps ratifiedSections on docs in storyline folders", () => {
    signBorrow();
    // A doc ratified before 1.23.0 has the hash and no section hashes.
    for (const k of ["check-out-tool", "return-tool"]) {
      writeFileSync(path("borrow-a-tool", k), read("borrow-a-tool", k).replace(/^ratifiedSections:.*\n/m, ""));
    }
    commit("as ratified before 1.23");
    const dry = em("upgrade", "shed.em");
    expect(dry.stdout).toMatch(/\[x\] ratified-sections.*2 ratified doc\(s\) record no section hashes: check-out-tool, return-tool/);
    expect(em("upgrade", "shed.em", "--apply").status).toBe(0);
    expect(read("borrow-a-tool", "check-out-tool")).toMatch(/^ratifiedSections: /m);
    expect(read("borrow-a-tool", "return-tool")).toMatch(/^ratifiedSections: /m);
  });

  it("em ledger checks storyline docs: a silent edit to a shipped doc is a finding, a pre-ship edit is not", () => {
    const clean = em("ledger", "shed.em", "--from", "base", "--json");
    expect(JSON.parse(clean.stdout).skipped).toEqual([]);
    edit("borrow-a-tool", "check-out-tool", "Original wording.", "Draft still moving.");
    commit("draft edit");
    expect(em("ledger", "shed.em", "--from", "base").status).toBe(0);
    edit("join-the-shed", "register", "Original wording.", "Quietly changed.");
    commit("shipped edit");
    const r = em("ledger", "shed.em", "--from", "base");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('slice "register": doc content changed but version: didn\'t bump');
  });

  it("em inline-check: storyline docs are not code, and a doc signed again over the same text counts", () => {
    signBorrow();
    writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\nratification:\n  inline: never\n');
    commit("policy");
    const docsOnly = JSON.parse(em("inline-check", "shed.em", "--base", "base", "--json").stdout);
    expect(docsOnly.codePaths).toEqual([]);
    expect(docsOnly.ratified).toEqual(["check-out-tool", "return-tool"]);
    expect(docsOnly.findings).toEqual([]);

    git("tag", "signed");
    expect(em("slice", "revise", "shed.em", "return-tool", "--withdraw").status).toBe(0);
    commit("withdraw");
    expect(em("slice", "review", "shed.em", "return-tool", "--by", "Alex").status).toBe(0);
    commit("review again");
    expect(em("slice", "ratify", "shed.em", "return-tool", "--by", "Alex").status).toBe(0);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "Return.kt"), "// code\n");
    commit("ratify again, with code");
    const resigned = JSON.parse(em("inline-check", "shed.em", "--base", "signed", "--json").stdout);
    expect(resigned.codePaths).toEqual(["src/Return.kt"]);
    expect(resigned.findings.map((f: { sliceKey: string }) => f.sliceKey)).toEqual(["return-tool"]);
  });

  it("isModelMaterial: docs, diagrams, generated workflows and storyline folders are not code", () => {
    const stories = new Set(["borrow-a-tool"]);
    expect(isModelMaterial("borrow-a-tool/slices/return-tool.md", "", stories)).toBe(true);
    expect(isModelMaterial("borrow-a-tool/slices/return-tool.svg", "", stories)).toBe(true);
    expect(isModelMaterial("borrow-a-tool/slices/notes.txt", "", stories)).toBe(true);
    expect(isModelMaterial("borrow-a-tool/borrow-a-tool.em", "", stories)).toBe(true);
    expect(isModelMaterial("storylines/map.html", "", stories)).toBe(true);
    expect(isModelMaterial("README.md", "", stories)).toBe(true);
    expect(isModelMaterial(".github/workflows/em-ci.yml", "", stories)).toBe(true);
    expect(isModelMaterial(".github/workflows/build.yml", "", stories)).toBe(false);
    // A code folder that happens to be called slices/ is still code.
    expect(isModelMaterial("src/slices/Return.kt", "", stories)).toBe(false);
    expect(isModelMaterial("src/Return.kt", "", stories)).toBe(false);
  });

  it("em changelog sees a commit that changed only a storyline file", () => {
    writeFileSync(join(dir, "borrow-a-tool", "borrow-a-tool.em"), BORROW_EM.replace("command Return Tool { loanId: Text }", "command Return Tool { loanId: Text, condition: Text }"));
    commit("return tool takes a condition");
    const r = em("changelog", "shed.em");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("return tool takes a condition");
    expect(r.stdout).toContain("condition");
  });
});
