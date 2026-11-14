// SPDX-License-Identifier: MIT
// GH #493: `em-policy.yaml` — the reader and its effective-policy defaults/sources, the roster
// read from it (and the deprecated `ratifiers.yaml` path), `merge:` driving `em slice ratify`,
// `em status`, the prose list, `em roster init`, and the `policy-file` upgrade step.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { effectivePolicy, parsePolicy, rosterOfPolicyText } from "../src/policy/policy.js";
import { loadRoster, findRosterAbove } from "../src/roster/roster.js";
import { DEFAULT_PROSE_HEADINGS, proseHeadingsFor } from "../src/catalog/sectionSignature.js";
import { UPGRADE_STEPS } from "../src/cli/upgrade.js";

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
};

const V = 'policySchemaVersion: "1.0"\n';

describe("parsePolicy", () => {
  it("accepts a file with only the version, and every documented key", () => {
    expect(parsePolicy(V).ok).toBe(true);
    const r = parsePolicy(
      `${V}merge: squash\nreview: pull-request\nratification:\n  inline: never\n  inline-violation: error\namendment:\n  prose-sections:\n    - Intent\n    - Notes\nratifiers:\n  - name: Alex\nreviewers:\n  - name: Sam\n`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy).toMatchObject({ merge: "squash", review: "pull-request", inline: "never", inlineViolation: "error", proseSections: ["Intent", "Notes"] });
    expect(r.policy.ratifiers?.map((e) => e.name)).toEqual(["Alex"]);
    expect(r.policy.reviewers?.map((e) => e.name)).toEqual(["Sam"]);
  });

  it.each([
    ["a missing version", "merge: squash\n", "policySchemaVersion"],
    ["a wrong version", 'policySchemaVersion: "9.9"\n', "unsupported policySchemaVersion"],
    ["an unknown top-level key", `${V}mrge: squash\n`, 'unknown key "mrge"'],
    ["a bad merge value", `${V}merge: fast-forward\n`, "squash | rebase | merge-commit"],
    ["a bad review value", `${V}review: telepathy\n`, "session | pull-request"],
    ["a bad inline tier", `${V}ratification:\n  inline: sometimes\n`, "internal | never | always"],
    ["a bad inline-violation", `${V}ratification:\n  inline-violation: loud\n`, "advisory | error"],
    ["an unknown ratification key", `${V}ratification:\n  inlin: never\n`, 'ratification: unknown key "inlin"'],
    ["an empty prose list", `${V}amendment:\n  prose-sections: []\n`, "non-empty list of section headings"],
    ["a non-mapping file", "- a\n", "YAML mapping"],
    ["a malformed roster list", `${V}ratifiers: nope\n`, "ratifiers"],
  ])("rejects %s as policy-invalid", (_label, text, fragment) => {
    const r = parsePolicy(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const d of r.diagnostics) expect(d.code).toBe("policy-invalid");
    expect(r.diagnostics.map((d) => d.message).join("\n")).toContain(fragment);
  });

  it("rosterOfPolicyText leaves a missing list null (unrestricted)", () => {
    const r = rosterOfPolicyText(`${V}ratifiers:\n  - name: Alex\n`);
    expect(r.ok && r.roster.reviewers).toBeNull();
  });
});

describe("effectivePolicy and roster discovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh493-"));
  });
  afterEach(() => rmTemp(dir));

  it("no file: explicit defaults, every source 'default'", () => {
    const r = effectivePolicy(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.file).toBeNull();
    expect(r.policy.merge).toEqual({ value: "merge-commit", source: "default" });
    expect(r.policy.review).toEqual({ value: "session", source: "default" });
    expect(r.policy.ratification.inline).toEqual({ value: "internal", source: "default" });
    expect(r.policy.ratification.inlineViolation).toEqual({ value: "advisory", source: "default" });
    expect(r.policy.amendment.proseSections).toEqual({ value: [...DEFAULT_PROSE_HEADINGS], source: "default" });
    expect(r.policy.ratifiers).toEqual({ value: null, source: "default" });
  });

  it("file values carry the file path as their source; unset keys stay 'default'", () => {
    const file = join(dir, "em-policy.yaml");
    writeFileSync(file, `${V}merge: rebase\nratifiers:\n  - name: Alex\n`);
    const r = effectivePolicy(dir);
    if (!r.ok) throw new Error("invalid");
    expect(r.policy.merge.value).toBe("rebase");
    expect(r.policy.merge.source).toBe(r.policy.file);
    expect(r.policy.review.source).toBe("default");
    expect(r.policy.ratifiers.value?.map((e) => e.name)).toEqual(["Alex"]);
    expect(r.policy.ratifiers.source).toBe(r.policy.file);
  });

  it("an invalid policy is not ok (callers refuse)", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: nope\n`);
    const r = effectivePolicy(dir);
    expect(r.ok).toBe(false);
  });

  it("is discovered in a parent directory up to the repo root", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "em-policy.yaml"), `${V}review: pull-request\n`);
    const r = effectivePolicy(join(dir, "sub"));
    if (!r.ok) throw new Error("invalid");
    expect(r.policy.review.value).toBe("pull-request");
  });

  it("the roster is read from em-policy.yaml; a policy file without lists does not govern the roster", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: squash\n`);
    expect(loadRoster(dir).state).toBe("absent");
    expect(findRosterAbove(dir)).toBeNull();
    writeFileSync(join(dir, "em-policy.yaml"), `${V}ratifiers:\n  - name: Alex\n`);
    const loaded = loadRoster(dir);
    expect(loaded.state).toBe("present");
    if (loaded.state === "present") expect(loaded.roster.ratifiers?.map((e) => e.name)).toEqual(["Alex"]);
  });

  it("a legacy ratifiers.yaml is still read, with a deprecation notice naming em upgrade", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Legacy\n');
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loaded = loadRoster(dir);
      expect(loaded.state).toBe("present");
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("em upgrade");
    } finally {
      spy.mockRestore();
    }
  });

  it("both files in one directory: em-policy.yaml wins and a notice says the other is ignored", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Legacy\n');
    writeFileSync(join(dir, "em-policy.yaml"), `${V}ratifiers:\n  - name: Policy\n`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loaded = loadRoster(dir);
      if (loaded.state !== "present") throw new Error("expected present");
      expect(loaded.roster.ratifiers?.map((e) => e.name)).toEqual(["Policy"]);
      expect(loaded.path).toContain("em-policy.yaml");
      // The legacy-only notice must not fire when the policy file governs.
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("deprecated");
    } finally {
      spy.mockRestore();
    }
  });

  it("--roster-style explicit paths accept either file", () => {
    writeFileSync(join(dir, "team.yaml"), `${V}ratifiers:\n  - name: P\n`);
    writeFileSync(join(dir, "old.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: O\n');
    const a = loadRoster(dir, join(dir, "team.yaml"));
    const b = loadRoster(dir, join(dir, "old.yaml"));
    expect(a.state === "present" && a.roster.ratifiers?.[0].name).toBe("P");
    expect(b.state === "present" && b.roster.ratifiers?.[0].name).toBe("O");
  });

  it("proseHeadingsFor: the policy's list when declared, else the default", () => {
    expect(proseHeadingsFor(dir)).toEqual(DEFAULT_PROSE_HEADINGS);
    writeFileSync(join(dir, "em-policy.yaml"), `${V}amendment:\n  prose-sections: [Intent, Notes]\n`);
    expect(proseHeadingsFor(dir)).toEqual(["Intent", "Notes"]);
  });
});

const MODEL = 'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid\n}\nslice "Read Model" {\n  view Paid List from "Paid"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Pay\n\n## Intent\n\nCharge the customer.\n\n## Notes\n\nplain\n\n## Open Questions\n\n";
const REVIEWED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n";

describe("policy through the CLI", () => {
  let dir: string;
  const doc = () => readFileSync(join(dir, "slices", "pay.md"), "utf8");
  const ratify = (...extra: string[]) => em(["slice", "ratify", "model.em", "pay", "--by", "Alex", "--on", "2026-10-02", ...extra], dir);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh493cli-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), REVIEWED + BODY);
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reviewed");
  });
  afterEach(() => rmTemp(dir));

  it.each(["squash", "rebase"])("merge: %s makes ratify hash-only and says policy set it", (strategy) => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: ${strategy}\n`);
    const r = ratify();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`merge: ${strategy}`);
    expect(r.stderr).toContain("--no-ref");
    expect(doc()).toContain("ratifiedHash:");
    expect(doc()).not.toContain("ratifiedRef:");
  });

  it("merge: merge-commit, or no policy file, records a ref as today", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: merge-commit\n`);
    const r = ratify();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("policy");
    expect(doc()).toContain("ratifiedRef:");
  });

  it("an explicit --no-ref under merge-commit policy still works", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: merge-commit\n`);
    expect(ratify("--no-ref").status).toBe(0);
    expect(doc()).not.toContain("ratifiedRef:");
  });

  it("an invalid policy refuses the write with policy-invalid", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: fast-forward\n`);
    const r = ratify();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("policy-invalid");
    expect(r.stderr).toContain("squash | rebase | merge-commit");
    expect(doc()).not.toContain("ratifiedBy");
  });

  it("the roster in em-policy.yaml restricts ratify --by", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: squash\nratifiers:\n  - name: Someone Else\n`);
    const r = ratify();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("permitted: Someone Else");
  });

  it("em status prints the effective policy with sources (text and --json, schema 1.13)", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: squash\nreview: pull-request\n`);
    const json = JSON.parse(em(["status", "model.em", "--json"], dir).stdout);
    expect(json.statusSchemaVersion).toBe("1.13");
    expect(json.policy).toHaveLength(1);
    const p = json.policy[0];
    expect(p.file).toBe("model.em");
    expect(p.merge.value).toBe("squash");
    expect(p.merge.source).toContain("em-policy.yaml");
    expect(p.review.value).toBe("pull-request");
    expect(p.ratificationInline).toEqual({ value: "internal", source: "default" });
    expect(p.ratifiers).toEqual({ value: null, source: "default" });
    expect(p.invalid).toBeNull();
    const text = em(["status", "model.em"], dir).stdout;
    expect(text).toContain("merge: squash");
    expect(text).toContain("review: pull-request");
    expect(text).toContain("ratification.inline: internal  [default]");
  });

  it("em status reports an invalid policy without failing", () => {
    writeFileSync(join(dir, "em-policy.yaml"), `${V}merge: nope\n`);
    const json = JSON.parse(em(["status", "model.em", "--json"], dir).stdout);
    expect(json.policy[0].invalid[0]).toContain("squash | rebase | merge-commit");
  });

  it("em roster init writes em-policy.yaml, which then governs ratify", () => {
    writeFileSync(join(dir, "slices", "pay.md"), REVIEWED.replace("reviewedBy: Sam", "reviewedBy: Sam") + BODY);
    const init = em(["roster", "init", "model.em"], dir);
    expect(init.status).toBe(0);
    const text = readFileSync(join(dir, "em-policy.yaml"), "utf8");
    expect(text).toContain('policySchemaVersion: "1.0"');
    expect(text).toContain("reviewers:");
    expect(existsSync(join(dir, "ratifiers.yaml"))).toBe(false);
    expect(em(["roster", "check", "model.em"], dir).status).toBe(0);
  });
});

describe("policy-file upgrade step", () => {
  const step = UPGRADE_STEPS.find((s) => s.id === "policy-file")!;
  let dir: string;
  const ctx = () => ({ baseDir: dir, repoRoot: dir }) as never;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh493up-"));
  });
  afterEach(() => rmTemp(dir));

  it("is registered, since 1.23.0", () => {
    expect(step.sinceVersion).toBe("1.23.0");
  });

  it("nothing to do without a ratifiers.yaml", () => {
    expect(step.detect(ctx())).toMatchObject({ applicable: false });
  });

  it("moves ratifiers.yaml into em-policy.yaml, keeping comments and entries", () => {
    const legacy = '# who may sign\nrosterSchemaVersion: "1.0"\nratifiers:\n  # the owner\n  - name: Alex\n    contexts: [Billing]\nreviewers:\n  - name: Sam\n';
    writeFileSync(join(dir, "ratifiers.yaml"), legacy);
    expect(step.detect(ctx())).toMatchObject({ applicable: true });
    const out = step.apply(ctx());
    expect(out.ok).toBe(true);
    expect(existsSync(join(dir, "ratifiers.yaml"))).toBe(false);
    const moved = readFileSync(join(dir, "em-policy.yaml"), "utf8");
    expect(moved).toContain("# who may sign");
    expect(moved).toContain("# the owner");
    expect(moved).toContain('policySchemaVersion: "1.0"');
    expect(moved).not.toContain("rosterSchemaVersion");
    const loaded = loadRoster(dir);
    expect(loaded.state).toBe("present");
    if (loaded.state === "present") {
      expect(loaded.roster.ratifiers?.[0]).toEqual({ name: "Alex", contexts: ["Billing"], models: null });
      expect(loaded.roster.reviewers?.[0].name).toBe("Sam");
    }
    expect(step.detect(ctx())).toMatchObject({ applicable: false });
  });

  it("refuses rather than guess when an em-policy.yaml already exists beside it", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), 'rosterSchemaVersion: "1.0"\nratifiers:\n  - name: Alex\n');
    writeFileSync(join(dir, "em-policy.yaml"), V);
    const d = step.detect(ctx());
    expect(d).toMatchObject({ applicable: false, human: true });
    expect(step.apply(ctx()).ok).toBe(false);
    expect(existsSync(join(dir, "ratifiers.yaml"))).toBe(true);
  });

  it("an invalid roster is left alone and listed for a human", () => {
    writeFileSync(join(dir, "ratifiers.yaml"), "ratifiers: nope\n");
    expect(step.detect(ctx())).toMatchObject({ applicable: false, human: true });
  });
});
