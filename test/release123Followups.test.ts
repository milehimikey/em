// SPDX-License-Identifier: MIT
// GH #516, second round: the gaps the 1.23.0 full test left open -- `em validate` reports an invalid
// policy file, `em changelog --from` diffs its oldest commit, the `plugin-pin` and opt-in
// `ratified-hash-baseline` upgrade steps, the CI path filter watching `em-policy.yaml`, and the
// model export carrying `amendedBy` / `amendedOn` / `sections`.
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { validatePolicyFile } from "../src/policy/policy.js";
import { CI_PR_PATHS, missingCiPullRequestPaths, refreshCiPullRequestPaths } from "../src/cli/ciInit.js";
import { movePluginSettings } from "../src/cli/pluginPin.js";
import { ratifiedHashScope } from "../src/catalog/sliceDoc.js";
import { SCHEMA_VERSION } from "../src/emit/json.js";

vi.setConfig({ testTimeout: 120_000 });

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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

const MODEL = 'slice "Ship" {\n  ui Screen @Customer\n  command Ship It note "slices/ship.md"\n  event Shipped\n}\nslice "Shipments" {\n  view Shipped List from "Shipped"\n  ui List Screen @Customer\n}\n';
const BODY = "# Slice: Ship\n\n## Intent\n\nShip the order.\n\n## Scenarios\n\nnone\n\n## Open Questions\n";
const doc = (frontmatter: string[]) => `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\n${frontmatter.join("\n")}\n---\n${BODY}`;

function repo(docText: string): string {
  const dir = mkdtempSync(join(tmpdir(), "em-gh516b-"));
  dirs.push(dir);
  mkdirSync(join(dir, "slices"));
  writeFileSync(join(dir, "model.em"), MODEL);
  writeFileSync(join(dir, "slices", "ship.md"), docText);
  gitInitQuiet(dir, "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "model");
  return dir;
}

describe("em validate reports an invalid em-policy.yaml", () => {
  it("one policy-invalid error per problem, naming the file and line; exit 1", () => {
    const dir = repo(doc(["status: draft", "version: 1"]));
    expect(validatePolicyFile(dir)).toEqual([]);
    writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\nmerge: fast-forward\nbogus: 1\n');
    const diags = validatePolicyFile(dir);
    expect(diags.map((d) => d.code)).toEqual(["policy-invalid", "policy-invalid"]);
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    expect(diags.some((d) => /em-policy\.yaml:2: .*merge/.test(d.message))).toBe(true);
    const res = em(["validate", "model.em"], dir);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("em-policy.yaml:3: unknown key");
    const json = JSON.parse(em(["validate", "model.em", "--json"], dir).stdout);
    expect(JSON.stringify(json)).toContain('"code":"policy-invalid"');
  });

  it("a valid policy file adds nothing", () => {
    const dir = repo(doc(["status: draft", "version: 1"]));
    writeFileSync(join(dir, "em-policy.yaml"), 'policySchemaVersion: "1.0"\nmerge: squash\n');
    expect(validatePolicyFile(dir)).toEqual([]);
    expect(em(["validate", "model.em"], dir).status).toBe(0);
  });
});

describe("CI path filter watches code-map.yaml (1.24.0)", () => {
  const block = (paths: readonly string[]) => `on:\n  pull_request:\n    paths:\n${paths.map((p) => `      - "${p}"`).join("\n")}\n  push:\n    branches: [main]\n`;
  it("is in the generated list, and the list 1.23 generated is refreshed to it", () => {
    expect(CI_PR_PATHS).toContain("**/code-map.yaml");
    const from123 = CI_PR_PATHS.filter((p) => p !== "**/code-map.yaml");
    expect(refreshCiPullRequestPaths(block(from123))).toBe(block(CI_PR_PATHS));
    expect(missingCiPullRequestPaths(block(from123))).toEqual(["**/code-map.yaml"]);
  });
});

describe("CI path filter watches em-policy.yaml", () => {
  const block = (paths: readonly string[]) => `on:\n  pull_request:\n    paths:\n${paths.map((p) => `      - "${p}"`).join("\n")}\n  push:\n    branches: [main]\n`;

  it("the preset lists it, and the 1.19-1.22 generated list is refreshed", () => {
    expect(CI_PR_PATHS).toContain("**/em-policy.yaml");
    // The list 1.19-1.22 generated: no em-policy.yaml, and no code-map.yaml (1.24.0 added it).
    const earlier = CI_PR_PATHS.filter((p) => p !== "**/em-policy.yaml" && p !== "**/code-map.yaml");
    const refreshed = refreshCiPullRequestPaths(block(earlier));
    expect(refreshed).toBe(block(CI_PR_PATHS));
    expect(refreshCiPullRequestPaths(block(CI_PR_PATHS.slice(0, 3)))).toBe(block(CI_PR_PATHS));
    expect(refreshCiPullRequestPaths(block(CI_PR_PATHS))).toBeNull();
  });

  it("a hand-edited list is left alone and reports what it lacks", () => {
    const edited = block(["**/*.em", "docs/**"]);
    expect(refreshCiPullRequestPaths(edited)).toBeNull();
    expect(missingCiPullRequestPaths(edited)).toContain("**/em-policy.yaml");
  });
});

describe("em changelog --from", () => {
  it("diffs the oldest commit in the walk against the model before it", () => {
    const dir = repo(doc(["status: draft", "version: 1"]));
    writeFileSync(join(dir, "README.md"), "unrelated\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "unrelated");
    const from = git(dir, "rev-parse", "HEAD");
    writeFileSync(
      join(dir, "model.em"),
      MODEL + 'slice "Print Label" {\n  ui Label Screen @Customer\n  command Print Label\n  event Label Printed\n}\nslice "Labels" {\n  view Label List from "Label Printed"\n  ui Labels Screen @Customer\n}\n',
    );
    git(dir, "add", "model.em");
    git(dir, "commit", "-q", "-m", "print a label");
    const bounded = em(["changelog", "model.em", "--from", from], dir);
    expect(bounded.status).toBe(0);
    expect(bounded.stdout).toContain("print a label");
    expect(bounded.stdout).toContain("Print Label");
    expect(bounded.stdout).not.toContain("Model introduced");
    const full = em(["changelog", "model.em"], dir);
    expect(full.stdout).toContain("Model introduced: 2 slices");
  });

  it("still shows the introduction when the model did not exist before --from", () => {
    const dir = repo(doc(["status: draft", "version: 1"]));
    const first = git(dir, "rev-list", "--max-parents=0", "HEAD");
    expect(em(["changelog", "model.em", "--from", first], dir).stdout).toContain("Model introduced: 2 slices");
  });
});

describe("plugin-pin upgrade step", () => {
  const settings = (name: string, ref: string) =>
    JSON.stringify(
      {
        permissions: { allow: ["Bash(npm test)"] },
        extraKnownMarketplaces: { other: { source: { source: "github", repo: "x/y" } }, [name]: { source: { source: "github", repo: "milehimikey/em", ref } } },
        enabledPlugins: { "tool@other": true, [`em@${name}`]: true },
      },
      null,
      2,
    ) + "\n";

  it("movePluginSettings replaces the em entry in place and keeps everything else", () => {
    const next = JSON.parse(movePluginSettings(settings("em-1-21-0", "v1.21.0"), "1.23.0")!);
    expect(Object.keys(next.extraKnownMarketplaces)).toEqual(["other", "em-1-23-0"]);
    expect(next.extraKnownMarketplaces["em-1-23-0"].source).toEqual({ source: "github", repo: "milehimikey/em", ref: "v1.23.0" });
    expect(next.enabledPlugins).toEqual({ "tool@other": true, "em@em-1-23-0": true });
    expect(next.permissions).toEqual({ allow: ["Bash(npm test)"] });
  });

  it("returns null when no em marketplace is declared or the text is not an object", () => {
    expect(movePluginSettings('{"extraKnownMarketplaces":{"other":{"source":{"source":"github","repo":"x/y"}}}}', "1.23.0")).toBeNull();
    expect(movePluginSettings("{}", "1.23.0")).toBeNull();
    expect(movePluginSettings("[]", "1.23.0")).toBeNull();
    expect(movePluginSettings("not json", "1.23.0")).toBeNull();
  });

  it("em upgrade lists the step for a stale pin and --apply moves it in one commit", () => {
    const dir = repo(doc(["status: draft", "version: 1"]));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), settings("em-1-0-0", "v1.0.0"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "old pin");
    const dry = em(["upgrade", "model.em", "--json"], dir);
    const step = JSON.parse(dry.stdout).steps.find((s: { id: string }) => s.id === "plugin-pin");
    expect(step.applicable).toBe(true);
    expect(step.reason).toContain("em-1-0-0");
    const applied = em(["upgrade", "model.em", "--apply"], dir);
    expect(applied.status).toBe(0);
    const after = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(Object.keys(after.extraKnownMarketplaces).filter((k) => k.startsWith("em-"))).toHaveLength(1);
    expect(Object.keys(after.extraKnownMarketplaces)).not.toContain("em-1-0-0");
    expect(Object.keys(after.enabledPlugins)).not.toContain("em@em-1-0-0");
    expect(git(dir, "log", "--format=%s")).toContain("em upgrade: plugin-pin");
    const again = JSON.parse(em(["upgrade", "model.em", "--json"], dir).stdout).steps.find((s: { id: string }) => s.id === "plugin-pin");
    expect(again.applicable).toBe(false);
  });
});

describe("ratified-hash-baseline upgrade step (opt-in)", () => {
  const signed = doc(["status: implemented", "version: 1", "implementedIn: src/ship.ts", 'ratifiedBy: "Alex"', "ratifiedOn: 2026-01-05"]);

  it("is listed as opt-in and not applied without the flag", () => {
    const dir = repo(signed);
    const step = JSON.parse(em(["upgrade", "model.em", "--json"], dir).stdout).steps.find((s: { id: string }) => s.id === "ratified-hash-baseline");
    expect(step.applicable).toBe(true);
    expect(step.optIn).toBe(true);
    expect(step.reason).toContain("ship");
    expect(em(["upgrade", "model.em", "--apply"], dir).status).toBe(0);
    expect(readFileSync(join(dir, "slices", "ship.md"), "utf8")).not.toContain("ratifiedHash");
  });

  it("with the flag: records hash, section hashes and the baseline mark; em slice amend then works", () => {
    const dir = repo(signed);
    const applied = em(["upgrade", "model.em", "--apply", "--baseline-ratified-hash"], dir);
    expect(applied.status).toBe(0);
    const file = join(dir, "slices", "ship.md");
    const text = readFileSync(file, "utf8");
    const hash = /^ratifiedHash: (sha256:[0-9a-f]{64})$/m.exec(text);
    expect(hash).not.toBeNull();
    expect(ratifiedHashScope(text, hash![1])).toBe("current");
    expect(text).toMatch(/^ratifiedSections: .*Intent=/m);
    expect(text).toMatch(/^ratifiedHashBaseline: \d{4}-\d{2}-\d{2}$/m);
    expect(text).toContain('ratifiedBy: "Alex"\nratifiedOn: 2026-01-05\nratifiedHash: ');
    expect(git(dir, "log", "--format=%s")).toContain("em upgrade: ratified-hash-baseline");

    writeFileSync(file, text.replace("Ship the order.", "Ship the order to the customer."));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "reword the intent");
    const amend = em(["slice", "amend", "model.em", "ship", "--by", "Sam"], dir);
    expect(amend.stderr).toBe("");
    expect(amend.status).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(/^amendedBy: Sam$/m);
  });

  it("a doc with no ratifiedBy is left alone, and --check refuses the flag", () => {
    const dir = repo(doc(["status: implemented", "version: 1", "implementedIn: src/ship.ts"]));
    const step = JSON.parse(em(["upgrade", "model.em", "--json"], dir).stdout).steps.find((s: { id: string }) => s.id === "ratified-hash-baseline");
    expect(step.applicable).toBe(false);
    expect(step.reason).toContain("left alone: ship");
    expect(em(["upgrade", "model.em", "--check", "--baseline-ratified-hash"], dir).status).toBe(1);
  });

  it("em slice revise clears the baseline mark with the rest of the sign-off", () => {
    const dir = repo(signed);
    expect(em(["upgrade", "model.em", "--apply", "--baseline-ratified-hash"], dir).status).toBe(0);
    const revise = em(["slice", "revise", "model.em", "ship"], dir);
    expect(revise.status).toBe(0);
    const text = readFileSync(join(dir, "slices", "ship.md"), "utf8");
    expect(text).not.toContain("ratifiedHashBaseline");
    expect(text).not.toContain("ratifiedHash:");
  });
});

describe("model export carries the amendment record and the sections", () => {
  it("schema 1.22: slice.doc.amendedBy / amendedOn / sections", () => {
    expect(SCHEMA_VERSION).toBe("1.23"); // GH #529: the fields below are 1.22's; 1.23 added places
    const dir = repo(doc(["status: draft", "version: 1", "amendedBy: Sam", "amendedOn: 2026-02-01"]));
    const res = em(["export", "model.em"], dir);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.schemaVersion).toBe("1.23");
    const ship = out.model.slices.find((s: { key: string }) => s.key === "ship").doc;
    expect(ship.amendedBy).toBe("Sam");
    expect(ship.amendedOn).toBe("2026-02-01");
    expect(ship.sections.map((s: { heading: string; class: string }) => [s.heading, s.class])).toContainEqual(["Intent", "prose"]);
    expect(ship.sections.map((s: { heading: string; class: string }) => [s.heading, s.class])).toContainEqual(["Scenarios", "behaviour"]);
    const unbound = out.model.slices.find((s: { key: string }) => s.key === "shipments").doc;
    expect(unbound.amendedBy).toBeNull();
    expect(unbound.sections).toBeNull();
  });
});
