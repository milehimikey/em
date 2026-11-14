// SPDX-License-Identifier: MIT
// GH #496: `em inline-check` -- a slice ratified in the same change set as implementation code,
// judged against `em-policy.yaml`'s `ratification.inline` / `inline-violation`. Real temporary git
// repositories: one base commit on main with two reviewed docs (`pay` public-touching, `ship`
// internal), then one branch per scenario.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { isModelMaterial } from "../src/cli/inlineCheck.js";

vi.setConfig({ testTimeout: 60_000 });

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

const MODEL =
  [
    'slice "Pay" {\n  ui Screen @Customer\n  command Pay Now note "slices/pay.md"\n  event Paid @Billing public\n}',
    'slice "Ship" {\n  command Ship It note "slices/ship.md"\n  event Shipped\n}',
    'slice "Read Model" {\n  view Paid List from "Paid"\n  view Shipped List from "Shipped"\n  ui List Screen @Customer\n}',
  ].join("\n") + "\n";
const BODY = "# Slice\n\n## Intent\n\nDo the thing.\n\n## Open Questions\n\n## Notes\n\nnone\n";
const reviewed = (title: string) =>
  `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nreviewedBy: Sam\nreviewedOn: 2026-10-01\n---\n${BODY.replace("# Slice", `# Slice: ${title}`)}`;
const policy = (inline: string | null, violation: string | null) =>
  'policySchemaVersion: "1.0"\n' +
  (inline || violation ? "ratification:\n" + (inline ? `  inline: ${inline}\n` : "") + (violation ? `  inline-violation: ${violation}\n` : "") : "");

describe("isModelMaterial", () => {
  it("model-dir slices/contracts/model-versions/conformance, .em files and the state file are model material; everything else is code", () => {
    expect(isModelMaterial("slices/pay.md", "")).toBe(true);
    expect(isModelMaterial("contracts/x.tsp", "")).toBe(true);
    expect(isModelMaterial("model-versions/v1.json", "")).toBe(true);
    expect(isModelMaterial("model.em", "")).toBe(true);
    expect(isModelMaterial(".event-modeling.md", "")).toBe(true);
    expect(isModelMaterial("em-policy.yaml", "")).toBe(true);
    expect(isModelMaterial("src/pay.ts", "")).toBe(false);
    expect(isModelMaterial("models/shop/slices/pay.md", "models/shop")).toBe(true);
    expect(isModelMaterial("src/pay.ts", "models/shop")).toBe(false);
    expect(isModelMaterial("models/shop/src/pay.ts", "models/shop")).toBe(false);
  });
});

describe("em inline-check (CLI, real git)", () => {
  let dir: string;
  let n = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh496-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), reviewed("Pay"));
    writeFileSync(join(dir, "slices", "ship.md"), reviewed("Ship"));
    writeFileSync(join(dir, "model.em"), MODEL);
    gitInitQuiet(dir, "-b", "main");
    git(dir, "add", "model.em", "slices/pay.md", "slices/ship.md");
    git(dir, "commit", "-q", "-m", "reviewed docs");
  });
  afterAll(() => rmTemp(dir));

  /** A fresh branch off main: optional policy, ratify `keys`, optionally add a code file, commit. */
  const scenario = (opts: { policy?: string; keys: string[]; code: boolean; noRef?: boolean }) => {
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", `s${++n}`);
    const add: string[] = [];
    if (opts.policy) {
      writeFileSync(join(dir, "em-policy.yaml"), opts.policy);
      add.push("em-policy.yaml");
    }
    for (const k of opts.keys) {
      const r = em(["slice", "ratify", "model.em", k, "--by", "Alex", "--on", "2026-10-02", "--contract-change", "first ratification", ...(opts.noRef ? ["--no-ref"] : [])], dir);
      if (r.status !== 0) throw new Error(`ratify ${k}: ${r.stderr}`);
      add.push(`slices/${k}.md`);
    }
    if (opts.code) {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "code.ts"), "export const x = 1;\n");
      add.push("src/code.ts");
    }
    if (add.length > 0) git(dir, "add", ...add);
    git(dir, "commit", "-q", "-m", "scenario", "--allow-empty");
    const res = em(["inline-check", "model.em", "--base", "main", "--json"], dir);
    let json: any = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new Error(`no JSON: ${res.stdout} / ${res.stderr}`);
    }
    return { status: res.status, json, text: em(["inline-check", "model.em", "--base", "main"], dir) };
  };

  it("public-touching slice ratified with code: reported, exit 0 by default, JSON carries slice/reason/source", () => {
    const { status, json, text } = scenario({ keys: ["pay"], code: true });
    expect(status).toBe(0);
    expect(json.inlineSchemaVersion).toBe("1.0");
    expect(json.ok).toBe(true);
    expect(json.policy.inline).toEqual({ value: "internal", source: "default" });
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0]).toMatchObject({ code: "slice-ratified-inline", sliceKey: "pay", reason: "public-touching", policySource: "default" });
    expect(json.codePaths).toEqual(["src/code.ts"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/^warn: slice-ratified-inline pay .*public-touching.*default/m);
  });

  it("inline-violation: error makes the same finding exit non-zero", () => {
    const { status, json, text } = scenario({ policy: policy(null, "error"), keys: ["pay"], code: true });
    expect(status).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.policy.inlineViolation.source).toContain("em-policy.yaml");
    expect(json.findings[0].policySource).toBe("default"); // `inline` itself is undeclared
    expect(text.status).toBe(1);
    expect(text.stdout).toMatch(/^error: slice-ratified-inline pay /m);
  });

  it("an internal slice ratified inline is silent under the default policy", () => {
    const { status, json, text } = scenario({ keys: ["ship"], code: true });
    expect(status).toBe(0);
    expect(json.ratified).toEqual(["ship"]);
    expect(json.findings).toEqual([]);
    expect(text.stdout).toMatch(/^ok --/);
  });

  it("inline: never reports ANY slice ratified inline, naming policy never", () => {
    const { status, json } = scenario({ policy: policy("never", "error"), keys: ["ship", "pay"], code: true });
    expect(status).toBe(1);
    expect(json.findings.map((f: any) => [f.sliceKey, f.reason])).toEqual([
      ["pay", "policy-never"],
      ["ship", "policy-never"],
    ]);
  });

  it("inline: always is never reported, even public-touching with code and violation: error", () => {
    const { status, json } = scenario({ policy: policy("always", "error"), keys: ["pay", "ship"], code: true });
    expect(status).toBe(0);
    expect(json.findings).toEqual([]);
    expect(json.ratified).toEqual(["pay", "ship"]);
  });

  it("ratified in a doc-only change set: silent, even under never + error", () => {
    const { status, json } = scenario({ policy: policy("never", "error"), keys: ["pay", "ship"], code: false });
    expect(status).toBe(0);
    expect(json.codePaths).toEqual([]);
    expect(json.findings).toEqual([]);
  });

  it("nothing ratified in the change set: silent (code alone is not a finding)", () => {
    const { status, json } = scenario({ keys: [], code: true });
    expect(status).toBe(0);
    expect(json.ratified).toEqual([]);
    expect(json.findings).toEqual([]);
  });

  it("a --no-ref doc (no ratifiedRef) is still decided from git", () => {
    const { status, json } = scenario({ keys: ["pay"], code: true, noRef: true });
    expect(status).toBe(0);
    expect(json.findings.map((f: any) => f.sliceKey)).toEqual(["pay"]);
  });

  it("a prose amendment in the same change set as code is not a ratification (slate R3)", () => {
    // Base: ship ratified in a doc-only commit, policy `never` (so ANY inline ratification would
    // be reported). Branch: prose edit + `em slice amend` + code.
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "amend-base");
    writeFileSync(join(dir, "em-policy.yaml"), policy("never", null));
    const r = em(["slice", "ratify", "model.em", "ship", "--by", "Alex", "--on", "2026-10-02", "--no-ref"], dir);
    expect(r.status).toBe(0);
    git(dir, "add", "slices/ship.md", "em-policy.yaml");
    git(dir, "commit", "-q", "-m", "ratify ship");
    git(dir, "checkout", "-q", "-b", "amend-impl");
    const docPath = join(dir, "slices", "ship.md");
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace("Do the thing.", "Do the thing, said better."));
    const a = em(["slice", "amend", "model.em", "ship", "--by", "Alex", "--on", "2026-10-03", "--no-ref"], dir);
    expect(a.status).toBe(0);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "impl.ts"), "export const y = 2;\n");
    git(dir, "add", "slices/ship.md", "src/impl.ts");
    git(dir, "commit", "-q", "-m", "implement + amend");
    const res = em(["inline-check", "model.em", "--base", "amend-base", "--json"], dir);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).findings).toEqual([]);
  });

  it("an invalid policy file refuses, naming policy-invalid", () => {
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "bad");
    writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\nratification:\n  inline: sometimes\n');
    const res = em(["inline-check", "model.em", "--base", "main"], dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("policy-invalid");
    rmTemp(join(dir, "em-policy.yaml"));
  });
});
