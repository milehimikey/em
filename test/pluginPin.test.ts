// SPDX-License-Identifier: MIT
// MIL-231: the em plugin's pin check (src/cli/pluginPin.ts) - pure, over fixture settings and a fake
// machine registry directory. Nothing here reads the real ~/.claude/plugins.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlugin, claudePluginsDir, detectPlugin, pluginInstallCommands, pluginMarketplaceName } from "../src/cli/pluginPin.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function settings(name: string, ref: string, enabled: boolean | "absent" = true) {
  return {
    extraKnownMarketplaces: { [name]: { source: { source: "github", repo: "milehimikey/em", ref } } },
    ...(enabled === "absent" ? {} : { enabledPlugins: { [`em@${name}`]: enabled } }),
  };
}

function repo(s: unknown, file = "settings.json"): string {
  const d = tmp("em-pluginpin-repo-");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, ".claude", file), JSON.stringify(s));
  return d;
}

function registry(entries: Record<string, { ref?: string }> | null): string {
  const d = tmp("em-pluginpin-reg-");
  if (entries) {
    const doc = Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, { source: { source: "github", repo: "milehimikey/em", ...(v.ref ? { ref: v.ref } : {}) }, installLocation: "x" }]),
    );
    writeFileSync(join(d, "known_marketplaces.json"), JSON.stringify(doc));
  }
  return d;
}

const V = "1.14.0";
const NAME = "em-1-14-0";
const SNIPPET = [
  "claude plugin marketplace add milehimikey/em@v1.14.0 --scope project",
  "claude plugin install em@em-1-14-0 --scope project",
];

describe("detectPlugin", () => {
  it("is null without settings, without a marketplace key, or for a foreign repo / non-matching name", () => {
    expect(detectPlugin(tmp("em-pluginpin-empty-"))).toBeNull();
    expect(detectPlugin(repo({ enabledPlugins: {} }))).toBeNull();
    expect(detectPlugin(repo({ extraKnownMarketplaces: { "em-1-14": { source: { source: "github", repo: "milehimikey/em", ref: "v1" } } } }))).toBeNull();
    expect(detectPlugin(repo({ extraKnownMarketplaces: { "em-1-14-0": { source: { source: "github", repo: "someone/else", ref: "v1.14.0" } } } }))).toBeNull();
  });

  it("reads name, ref and enabled from settings.json", () => {
    expect(detectPlugin(repo(settings(NAME, "v1.14.0")))).toEqual({ declared: true, name: NAME, ref: "v1.14.0", enabled: true });
    expect(detectPlugin(repo(settings(NAME, "v1.14.0", false)))?.enabled).toBe(false);
    expect(detectPlugin(repo(settings(NAME, "v1.14.0", "absent")))?.enabled).toBe(false);
  });

  it("falls back to settings.local.json", () => {
    expect(detectPlugin(repo(settings(NAME, "v1.14.0"), "settings.local.json"))).toEqual({ declared: true, name: NAME, ref: "v1.14.0", enabled: true });
  });

  it("prefers the marketplace named for the installed version when a stale pin sits beside it", () => {
    const s = { extraKnownMarketplaces: { ...settings("em-1-13-1", "v1.13.1").extraKnownMarketplaces, ...settings(NAME, "v1.14.0").extraKnownMarketplaces } };
    expect(detectPlugin(repo(s))?.name).toBe("em-1-13-1");
    expect(detectPlugin(repo(s), NAME)?.name).toBe(NAME);
  });
});

describe("names and commands", () => {
  it("derives the marketplace name and the two-command install snippet", () => {
    expect(pluginMarketplaceName(V)).toBe(NAME);
    expect(pluginInstallCommands(V)).toEqual(SNIPPET);
  });

  it("EM_CLAUDE_PLUGINS_DIR overrides the default plugins directory", () => {
    expect(claudePluginsDir({ EM_CLAUDE_PLUGINS_DIR: "/x/plugins" })).toBe("/x/plugins");
    expect(claudePluginsDir({})).toMatch(/\.claude[\\/]plugins$/);
  });
});

describe("checkPlugin", () => {
  it("is null when the repo does not declare the plugin", () => {
    expect(checkPlugin(tmp("em-pluginpin-none-"), V, registry({}))).toBeNull();
  });

  it("is clean for a correct pin, enabled, registered at the same ref", () => {
    const r = checkPlugin(repo(settings(NAME, "v1.14.0")), V, registry({ [NAME]: { ref: "v1.14.0" } }));
    expect(r?.findings).toEqual([]);
    expect(r?.plugin).toEqual({ declared: true, name: NAME, ref: "v1.14.0", enabled: true });
  });

  it("plugin-pin-mismatch when the key version differs from the installed em", () => {
    const f = checkPlugin(repo(settings("em-1-13-1", "v1.13.1")), V, registry({}))!.findings;
    expect(f.map((x) => x.code)).toEqual(["plugin-pin-mismatch"]);
    expect(f[0].message).toBe(
      "em plugin pin mismatch: .claude/settings.json pins em-1-13-1 at ref v1.13.1, but installed em is 1.14.0 (expected marketplace em-1-14-0 at ref v1.14.0) - update extraKnownMarketplaces and enabledPlugins to the installed version, then run the install commands",
    );
    expect(f[0].installCommands).toEqual(SNIPPET);
  });

  it("plugin-pin-mismatch when the key is right but source.ref is not", () => {
    const f = checkPlugin(repo(settings(NAME, "v1.13.1")), V, registry({ [NAME]: { ref: "v1.14.0" } }))!.findings;
    expect(f.map((x) => x.code)).toEqual(["plugin-pin-mismatch"]);
    expect(f[0].message).toContain("pins em-1-14-0 at ref v1.13.1");
  });

  it("plugin-not-enabled when enabledPlugins[em@<name>] is not true", () => {
    const f = checkPlugin(repo(settings(NAME, "v1.14.0", false)), V, registry({ [NAME]: { ref: "v1.14.0" } }))!.findings;
    expect(f.map((x) => x.code)).toEqual(["plugin-not-enabled"]);
    expect(f[0].message).toBe('em plugin is not enabled: enabledPlugins["em@em-1-14-0"] is not true in .claude/settings.json');
  });

  it("plugin-not-installed-locally prints the two-command snippet when the registry has no entry or no file", () => {
    for (const reg of [registry({}), registry(null)]) {
      const f = checkPlugin(repo(settings(NAME, "v1.14.0")), V, reg)!.findings;
      expect(f.map((x) => x.code)).toEqual(["plugin-not-installed-locally"]);
      expect(f[0].message).toContain(`is not registered on this machine (no entry in ${join(reg, "known_marketplaces.json")}) - run:\n  ${SNIPPET.join("\n  ")}`);
    }
  });

  it("plugin-registered-at-different-ref when the machine holds the name at another ref", () => {
    const f = checkPlugin(repo(settings(NAME, "v1.14.0")), V, registry({ [NAME]: { ref: "v1.13.1" } }))!.findings;
    expect(f.map((x) => x.code)).toEqual(["plugin-registered-at-different-ref"]);
    expect(f[0].message).toBe(
      `em plugin em-1-14-0 is registered on this machine at v1.13.1, not v1.14.0 - the agent would run the wrong skills; run: claude plugin marketplace remove em-1-14-0, then:\n  ${SNIPPET.join("\n  ")}`,
    );
    expect(f[0].pluginRef).toBe("v1.13.1");
  });

  it("a wrong pin does not also report the registry (one root cause)", () => {
    const f = checkPlugin(repo(settings("em-1-13-1", "v1.13.1", false)), V, registry({}))!.findings;
    expect(f.map((x) => x.code)).toEqual(["plugin-pin-mismatch", "plugin-not-enabled"]);
  });
});
