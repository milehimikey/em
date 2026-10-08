// SPDX-License-Identifier: MIT
// Coverage for `em skill check`'s core logic (src/cli/skillCheck.ts): the two independent
// findings (em-version: stamp mismatch, content drift against the packaged skill) and their
// interaction. Real tmpdir fixtures — no git, same rationale as skillSync.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillSync, checkSkillSyncBundle } from "../src/cli/skillCheck.js";
import { planSkillSync, applySkillSync } from "../src/cli/skillSync.js";
import { UPGRADE_STEPS, type UpgradeContext } from "../src/cli/upgrade.js";
import { buildSkillCheckJson } from "../src/emit/skillCheckJson.js";

// MIL-231: the CLI-level tests below spawn the real CLI (~5-6 s per spawn on a cold CI runner),
// past vitest's 5 s default. File-level timeout, as test/cli.test.ts.
vi.setConfig({ testTimeout: 20_000 });

function makePackagedDir(version = "1.7.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "em-skillcheck-packaged-"));
  writeFileSync(join(dir, "SKILL.md"), `---\nem-version: ${version}\n---\nbody\n`);
  mkdirSync(join(dir, "reference"));
  writeFileSync(join(dir, "reference", "em-dsl.md"), "dsl reference");
  return dir;
}

function syncedVendoredDir(packaged: string): string {
  const vendored = mkdtempSync(join(tmpdir(), "em-skillcheck-vendored-"));
  applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
  return vendored;
}

describe("checkSkillSync", () => {
  it("reports skill-check-not-installed when nothing is vendored", () => {
    const packaged = makePackagedDir();
    const vendored = join(tmpdir(), "em-skillcheck-missing-" + Math.random().toString(36).slice(2));
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: "skill-check-not-installed",
          message: `no vendored skill found at ${vendored} — run \`em skill sync\` first`,
        },
      ]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
    }
  });

  it("is clean when a freshly synced copy matches the installed version", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result).toEqual({ ok: true, findings: [] });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-stamp-missing when SKILL.md has no em-version: frontmatter", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      writeFileSync(join(vendored, "SKILL.md"), "---\nname: event-modeling\n---\nbody\n");
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain("skill-check-stamp-missing");
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-stamp-mismatch when the vendored stamp is stale", () => {
    const packaged = makePackagedDir("1.8.0");
    // vendored copy was synced against an older packaged skill (1.7.0), installed em is 1.8.0
    const stalePackaged = makePackagedDir("1.7.0");
    const staleVendored = syncedVendoredDir(stalePackaged);
    try {
      const result = checkSkillSync(packaged, staleVendored, "1.8.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toContainEqual({
        code: "skill-check-stamp-mismatch",
        message: "vendored skill's em-version: stamp (1.7.0) doesn't match installed em (1.8.0) — run `em skill sync` (or `em upgrade`)",
        vendoredStamp: "1.7.0",
        installedVersion: "1.8.0",
      });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(stalePackaged, { recursive: true, force: true });
      rmSync(staleVendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-content-drift when a file was hand-edited even though the stamp still matches", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      writeFileSync(join(vendored, "reference", "em-dsl.md"), "a hand edit, stamp untouched");
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: "skill-check-content-drift",
          message: "vendored skill differs from the packaged skill in 1 file(s) — run `em skill sync` (or `em upgrade`)",
          driftedFiles: ["reference/em-dsl.md"],
        },
      ]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports both stamp mismatch and content drift together, not short-circuited", () => {
    const packaged = makePackagedDir("1.8.0");
    const stalePackaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(stalePackaged);
    try {
      writeFileSync(join(vendored, "reference", "em-dsl.md"), "hand-edited on top of a stale sync");
      const result = checkSkillSync(packaged, vendored, "1.8.0");
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code).sort()).toEqual(["skill-check-content-drift", "skill-check-stamp-mismatch"]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(stalePackaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("--json shape: buildSkillCheckJson wraps the result in the documented envelope", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      const json = JSON.parse(buildSkillCheckJson(result, vendored, "1.7.0"));
      expect(json).toMatchObject({
        skillCheckSchemaVersion: "1.1",
        generator: { name: "@milehimikey/em" },
        installedVersion: "1.7.0",
        vendoredDir: vendored,
        findings: [],
        ok: true,
      });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });
});

// MIL-157: the em skill ships as several sibling directories (stamp-checked skill directories
// plus shared, non-skill directories with no SKILL.md/stamp) rather than one.
describe("checkSkillSyncBundle", () => {
  function makeBundleRoot(version: string): { root: string; skillDirs: string[]; sharedDirs: string[] } {
    const root = mkdtempSync(join(tmpdir(), "em-skillcheckbundle-packaged-"));
    for (const name of ["skill-a", "skill-b"]) {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), `---\nem-version: ${version}\n---\nbody\n`);
    }
    const shared = join(root, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "reference.md"), "shared reference content");
    return { root, skillDirs: ["skill-a", "skill-b"], sharedDirs: ["shared"] };
  }

  it("is clean when a freshly synced bundle matches the installed version", () => {
    const { root: packagedRoot, skillDirs, sharedDirs } = makeBundleRoot("1.7.0");
    const vendoredRoot = mkdtempSync(join(tmpdir(), "em-skillcheckbundle-vendored-"));
    try {
      for (const name of [...skillDirs, ...sharedDirs]) {
        applySkillSync(planSkillSync(join(packagedRoot, name), join(vendoredRoot, name)), join(packagedRoot, name), join(vendoredRoot, name));
      }
      const result = checkSkillSyncBundle(packagedRoot, vendoredRoot, "1.7.0", skillDirs, sharedDirs);
      expect(result).toEqual({ ok: true, findings: [] });
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true });
      rmSync(vendoredRoot, { recursive: true, force: true });
    }
  });

  it("prefixes findings with the directory name and reports drift in only the affected directory", () => {
    const { root: packagedRoot, skillDirs, sharedDirs } = makeBundleRoot("1.7.0");
    const vendoredRoot = mkdtempSync(join(tmpdir(), "em-skillcheckbundle-vendored-"));
    try {
      for (const name of [...skillDirs, ...sharedDirs]) {
        applySkillSync(planSkillSync(join(packagedRoot, name), join(vendoredRoot, name)), join(packagedRoot, name), join(vendoredRoot, name));
      }
      writeFileSync(join(vendoredRoot, "skill-a", "SKILL.md"), "hand-edited, no frontmatter");

      const result = checkSkillSyncBundle(packagedRoot, vendoredRoot, "1.7.0", skillDirs, sharedDirs);
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code).sort()).toEqual(["skill-check-content-drift", "skill-check-stamp-missing"]);
      for (const f of result.findings) {
        expect(f.message).toContain("[skill-a] ");
        expect(f.driftedFiles ?? ["skill-a/SKILL.md"]).toEqual(["skill-a/SKILL.md"]);
      }
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true });
      rmSync(vendoredRoot, { recursive: true, force: true });
    }
  });

  it("reports a not-installed finding for a missing shared directory without touching skill directories' findings", () => {
    const { root: packagedRoot, skillDirs, sharedDirs } = makeBundleRoot("1.7.0");
    const vendoredRoot = mkdtempSync(join(tmpdir(), "em-skillcheckbundle-vendored-"));
    try {
      for (const name of skillDirs) {
        applySkillSync(planSkillSync(join(packagedRoot, name), join(vendoredRoot, name)), join(packagedRoot, name), join(vendoredRoot, name));
      }
      // shared/ deliberately never synced.
      const result = checkSkillSyncBundle(packagedRoot, vendoredRoot, "1.7.0", skillDirs, sharedDirs);
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: "skill-check-not-installed",
          message: `[shared] no vendored skill found at ${join(vendoredRoot, "shared")} — run \`em skill sync\` first`,
        },
      ]);
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true });
      rmSync(vendoredRoot, { recursive: true, force: true });
    }
  });
});

// ---- MIL-231: the plugin signal, end to end through the CLI (fixture settings + fake registry) ----

describe("em skill check - the em plugin (CLI, MIL-231)", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const CLI = join(ROOT, "src", "cli.ts");
  const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
  const NAME = `em-${VERSION.replace(/\./g, "-")}`;
  const SNIPPET = [
    `claude plugin marketplace add milehimikey/em@v${VERSION} --scope project`,
    `claude plugin install em@${NAME} --scope project`,
  ];
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  /** CI is stripped from the environment so a CI runner's CI=true never changes the exit-code cases. */
  function em(args: string[], cwd: string, plugins: string, extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, EM_CLAUDE_PLUGINS_DIR: plugins, ...extraEnv };
    if (!("CI" in extraEnv)) delete env.CI;
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function pluginRepo(name = NAME, ref = `v${VERSION}`, enabled = true): string {
    const d = tmp("em-skillcheck-plugin-repo-");
    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(
      join(d, ".claude", "settings.json"),
      JSON.stringify({
        extraKnownMarketplaces: { [name]: { source: { source: "github", repo: "milehimikey/em", ref } } },
        enabledPlugins: { [`em@${name}`]: enabled },
      }),
    );
    return d;
  }

  function registry(name: string | null, ref = `v${VERSION}`): string {
    const d = tmp("em-skillcheck-plugin-reg-");
    if (name) {
      writeFileSync(join(d, "known_marketplaces.json"), JSON.stringify({ [name]: { source: { source: "github", repo: "milehimikey/em", ref } } }));
    }
    return d;
  }

  it("is green on a plugin repo that is pinned, enabled and registered (no vendored bundle needed)", () => {
    const r = em(["skill", "check"], pluginRepo(), registry(NAME));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`ok — em plugin ${NAME} (v${VERSION}) matches em ${VERSION}\n`);
    expect(r.stderr).toBe("");
  });

  it("is red on a wrong pin, with the exact message", () => {
    const repo = pluginRepo("em-0-0-1", "v0.0.1");
    const r = em(["skill", "check"], repo, registry("em-0-0-1", "v0.0.1"));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      `em plugin pin mismatch: .claude/settings.json pins em-0-0-1 at ref v0.0.1, but installed em is ${VERSION} (expected marketplace ${NAME} at ref v${VERSION}) - update extraKnownMarketplaces and enabledPlugins to the installed version, then run the install commands\n1 mismatch(es)\n`,
    );
  });

  it("is red when the plugin is not enabled", () => {
    const r = em(["skill", "check"], pluginRepo(NAME, `v${VERSION}`, false), registry(NAME));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`em plugin is not enabled: enabledPlugins["em@${NAME}"] is not true in .claude/settings.json`);
  });

  it("not registered locally: prints the two-command snippet on stderr and exits 0; --ci and CI=true exit 1", () => {
    const repo = pluginRepo();
    const plain = em(["skill", "check"], repo, registry(null));
    expect(plain.status).toBe(0);
    expect(plain.stderr).toContain(`is not registered on this machine`);
    expect(plain.stderr).toContain(SNIPPET.join("\n  "));
    const ci = em(["skill", "check", "--ci"], repo, registry(null));
    expect(ci.status).toBe(1);
    expect(ci.stdout).toContain(SNIPPET.join("\n  "));
    expect(ci.stdout).toContain("1 mismatch(es)");
    expect(em(["skill", "check"], repo, registry(null), { CI: "true" }).status).toBe(1);
  });

  it("registered at a different ref exits 1 even outside CI", () => {
    const r = em(["skill", "check"], pluginRepo(), registry(NAME, "v0.0.1"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`is registered on this machine at v0.0.1, not v${VERSION}`);
  });

  it("--json carries the plugin object, the findings and ok", () => {
    const repo = pluginRepo();
    const bad = JSON.parse(em(["skill", "check", "--json", "--ci"], repo, registry(null)).stdout);
    expect(bad.skillCheckSchemaVersion).toBe("1.1");
    expect(bad.plugin).toEqual({ declared: true, name: NAME, ref: `v${VERSION}`, enabled: true });
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f: { code: string }) => f.code)).toEqual(["plugin-not-installed-locally"]);
    expect(bad.findings[0].installCommands).toEqual(SNIPPET);
    const soft = em(["skill", "check", "--json"], repo, registry(null));
    expect(soft.status).toBe(0);
    expect(JSON.parse(soft.stdout).ok).toBe(true);
  });

  it("a repo with neither signal is unchanged: skill-check-not-installed, exit 1, plugin null", () => {
    const repo = tmp("em-skillcheck-neither-");
    const r = em(["skill", "check", "--json"], repo, registry(null));
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.plugin).toBeNull();
    expect(doc.findings.some((f: { code: string }) => f.code === "skill-check-not-installed")).toBe(true);
  });

  it("a vendored repo is unchanged (green), and a repo with BOTH is checked on both", () => {
    const repo = pluginRepo();
    const reg = registry(NAME);
    expect(em(["skill", "sync", repo, "--no-agents-md"], ROOT, reg).status).toBe(0);
    const both = em(["skill", "check"], repo, reg);
    expect(both.status).toBe(0);
    expect(both.stdout).toBe(`ok — vendored skill matches em ${VERSION}\nok — em plugin ${NAME} (v${VERSION}) matches em ${VERSION}\n`);
    // break the plugin side: the vendored side is still checked and green
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { "em-0-0-1": { source: { source: "github", repo: "milehimikey/em", ref: "v0.0.1" } } } }));
    expect(em(["skill", "check"], repo, reg).status).toBe(1);
    // break the vendored side too: both are reported
    writeFileSync(join(repo, ".claude", "skills", "event-modeling", "SKILL.md"), "hand-edited");
    const worse = em(["skill", "check"], repo, reg);
    expect(worse.stdout).toContain("[event-modeling]");
    expect(worse.stdout).toContain("em plugin pin mismatch");
    // vendored-only repo (no settings): same green as before
    const vendoredOnly = tmp("em-skillcheck-vendored-only-");
    em(["skill", "sync", vendoredOnly, "--no-agents-md"], ROOT, reg);
    const v = em(["skill", "check"], vendoredOnly, reg);
    expect(v.status).toBe(0);
    expect(v.stdout).toBe(`ok — vendored skill matches em ${VERSION}\n`);
  });

  it("skill install / sync print the deprecation notice naming the plugin and still work", () => {
    const notice = `warn: the vendored skill bundle is deprecated since em 1.14 — install the em plugin instead: ${SNIPPET.join(" && ")}\n`;
    const reg = registry(null);
    const dir = tmp("em-skillcheck-deprecated-");
    const install = em(["skill", "install", "--no-agents-md"], dir, reg);
    expect(install.status).toBe(0);
    expect(install.stderr).toBe(notice);
    expect(existsSync(join(dir, ".claude", "skills", "event-modeling", "SKILL.md"))).toBe(true);
    const sync = em(["skill", "sync", dir, "--no-agents-md"], ROOT, reg);
    expect(sync.status).toBe(0);
    expect(sync.stderr).toBe(notice);
  });
});

describe("em upgrade skill-bundle step on a plugin repo (MIL-231)", () => {
  it("says there is nothing to sync, instead of pointing at `em skill install`", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "em-skillcheck-upgrade-"));
    try {
      mkdirSync(join(repoRoot, ".claude"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".claude", "settings.json"),
        JSON.stringify({ extraKnownMarketplaces: { "em-1-14-0": { source: { source: "github", repo: "milehimikey/em", ref: "v1.14.0" } } } }),
      );
      const step = UPGRADE_STEPS.find((x) => x.id === "skill-bundle")!;
      expect(step.detect({ repoRoot, packagedSkillsRoot: repoRoot } as UpgradeContext)).toEqual({
        applicable: false,
        reason: "plugin repo — the vendored bundle is gone; nothing to sync",
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
