// SPDX-License-Identifier: MIT
// The em Claude Code plugin's pin check (MIL-231, R14). Pure: reads a repo's `.claude/settings.json`
// (then `.claude/settings.local.json`) and the machine-level marketplace registry, and reports
// findings. No process.exit, no console, and nothing reads the real `~/.claude/plugins` unless the
// caller passes it - the CLI resolves the directory (EM_CLAUDE_PLUGINS_DIR, default
// ~/.claude/plugins), tests pass a fixture.
//
// Why two parts. A marketplace registration is per user and keyed by marketplace NAME: two repos
// pinning different refs under one name silently collide (MIL-229 spike). The marketplace name
// therefore carries the exact version (`em-1-14-0`), and the check compares the repo's declaration
// (settings) AND the machine's registration (known_marketplaces.json) against the installed em.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillCheckFinding } from "./skillCheck.js";

export const PLUGIN_NAME = "em";
export const PLUGIN_REPO = "milehimikey/em";
/** A marketplace key that makes a repo "declare the plugin": `em-<major>-<minor>-<patch>`. */
export const PLUGIN_MARKETPLACE_RE = /^em-\d+-\d+-\d+$/;

/** `1.14.0` -> `em-1-14-0` (the marketplace name the release stamps into .claude-plugin/marketplace.json). */
export function pluginMarketplaceName(version: string): string {
  return `em-${version.replace(/\./g, "-")}`;
}

/** The two commands that register and enable the plugin pinned to `version` (both are required, in
 *  this order: `plugin install` alone fails with "Plugin not found in marketplace"). */
export function pluginInstallCommands(version: string): string[] {
  return [
    `claude plugin marketplace add ${PLUGIN_REPO}@v${version} --scope project`,
    `claude plugin install ${PLUGIN_NAME}@${pluginMarketplaceName(version)} --scope project`,
  ];
}

/** The `.claude/settings.json` entries that pin the plugin to `version` (MIL-232, R14). Pure. */
export function pluginSettingsEntries(version: string): {
  name: string;
  marketplace: { source: { source: "github"; repo: string; ref: string } };
  enabledKey: string;
} {
  const name = pluginMarketplaceName(version);
  return {
    name,
    marketplace: { source: { source: "github", repo: PLUGIN_REPO, ref: `v${version}` } },
    enabledKey: `${PLUGIN_NAME}@${name}`,
  };
}

/**
 * Merge the plugin pin for `version` into the text of a `.claude/settings.json` (`null` = file
 * absent). Unknown keys and key order are preserved; output is 2-space JSON with a trailing newline.
 * Returns `null` when the existing text is not a JSON object (the caller must not clobber it).
 */
export function mergePluginSettings(existing: string | null, version: string): string | null {
  let settings: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      const v: unknown = JSON.parse(existing);
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      settings = v as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const e = pluginSettingsEntries(version);
  const markets = { ...(obj(settings.extraKnownMarketplaces) ?? {}), [e.name]: e.marketplace };
  const enabled = { ...(obj(settings.enabledPlugins) ?? {}), [e.enabledKey]: true };
  const out: Record<string, unknown> = { ...settings, extraKnownMarketplaces: markets, enabledPlugins: enabled };
  return JSON.stringify(out, null, 2) + "\n";
}

export interface PluginDeclaration {
  declared: true;
  /** The marketplace key, e.g. `em-1-14-0`. */
  name: string;
  /** The declared `source.ref` (e.g. `v1.14.0`), or null when absent. */
  ref: string | null;
  /** `enabledPlugins["em@<name>"] === true` (settings.local.json overrides settings.json). */
  enabled: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A repo "declares the plugin" iff `.claude/settings.json` (then `.claude/settings.local.json`) has
 * an `extraKnownMarketplaces` key matching `^em-\d+-\d+-\d+$` whose `source` is the github repo
 * `milehimikey/em`. When several keys match (a stale pin left beside the current one), the one named
 * `preferName` wins, else the first in key order.
 */
export function detectPlugin(repoRoot: string, preferName?: string): PluginDeclaration | null {
  const files = [join(repoRoot, ".claude", "settings.json"), join(repoRoot, ".claude", "settings.local.json")]
    .map(readJson)
    .filter((j): j is Record<string, unknown> => j !== null);
  for (const settings of files) {
    const markets = obj(settings.extraKnownMarketplaces);
    if (!markets) continue;
    const names = Object.keys(markets)
      .filter((k) => {
        const src = obj(obj(markets[k])?.source);
        return PLUGIN_MARKETPLACE_RE.test(k) && src?.source === "github" && src.repo === PLUGIN_REPO;
      })
      .sort();
    if (names.length === 0) continue;
    const name = preferName && names.includes(preferName) ? preferName : names[0];
    const ref = obj(obj(markets[name])?.source)?.ref;
    let enabled = false;
    for (const f of files) {
      const v = obj(f.enabledPlugins)?.[`${PLUGIN_NAME}@${name}`];
      if (v !== undefined) enabled = v === true;
    }
    return { declared: true, name, ref: typeof ref === "string" ? ref : null, enabled };
  }
  return null;
}

/** The machine-level plugins directory: EM_CLAUDE_PLUGINS_DIR, else ~/.claude/plugins. */
export function claudePluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EM_CLAUDE_PLUGINS_DIR ? env.EM_CLAUDE_PLUGINS_DIR : join(homedir(), ".claude", "plugins");
}

/** The `source.ref` the machine registry holds for `name`, `undefined` when there is no entry (or no
 *  readable registry), `null` when the entry carries no ref. */
function registeredRef(pluginsDir: string, name: string): string | null | undefined {
  const file = join(pluginsDir, "known_marketplaces.json");
  if (!existsSync(file)) return undefined;
  const entry = obj(readJson(file)?.[name]);
  if (!entry) return undefined;
  const ref = obj(entry.source)?.ref;
  return typeof ref === "string" ? ref : null;
}

export interface PluginCheck {
  plugin: PluginDeclaration;
  findings: SkillCheckFinding[];
}

/**
 * Check the plugin declaration in `repoRoot` against `installedVersion` (em --version) and the
 * machine registry in `pluginsDir`. `null` when the repo does not declare the plugin.
 */
export function checkPlugin(repoRoot: string, installedVersion: string, pluginsDir: string): PluginCheck | null {
  const expectedName = pluginMarketplaceName(installedVersion);
  const expectedRef = `v${installedVersion}`;
  const plugin = detectPlugin(repoRoot, expectedName);
  if (!plugin) return null;
  const commands = pluginInstallCommands(installedVersion);
  const findings: SkillCheckFinding[] = [];

  const pinOk = plugin.name === expectedName && plugin.ref === expectedRef;
  if (!pinOk) {
    findings.push({
      code: "plugin-pin-mismatch",
      message:
        `em plugin pin mismatch: .claude/settings.json pins ${plugin.name} at ref ${plugin.ref ?? "(none)"}, ` +
        `but installed em is ${installedVersion} (expected marketplace ${expectedName} at ref ${expectedRef}) - ` +
        `update extraKnownMarketplaces and enabledPlugins to the installed version, then run the install commands`,
      pluginName: plugin.name,
      pluginRef: plugin.ref,
      installedVersion,
      installCommands: commands,
    });
  }

  if (!plugin.enabled) {
    findings.push({
      code: "plugin-not-enabled",
      message: `em plugin is not enabled: enabledPlugins["${PLUGIN_NAME}@${plugin.name}"] is not true in .claude/settings.json`,
      pluginName: plugin.name,
      pluginRef: plugin.ref,
      installedVersion,
    });
  }

  // The machine registration is only meaningful against a correct pin; a wrong pin is the one root
  // cause, reported once.
  if (pinOk) {
    const reg = registeredRef(pluginsDir, plugin.name);
    if (reg === undefined) {
      findings.push({
        code: "plugin-not-installed-locally",
        message: `em plugin ${plugin.name} is not registered on this machine (no entry in ${join(pluginsDir, "known_marketplaces.json")}) - run:\n  ${commands.join("\n  ")}`,
        pluginName: plugin.name,
        pluginRef: null,
        installedVersion,
        installCommands: commands,
      });
    } else if (reg !== expectedRef) {
      findings.push({
        code: "plugin-registered-at-different-ref",
        message:
          `em plugin ${plugin.name} is registered on this machine at ${reg ?? "(no ref)"}, not ${expectedRef} - ` +
          `the agent would run the wrong skills; run: claude plugin marketplace remove ${plugin.name}, then:\n  ${commands.join("\n  ")}`,
        pluginName: plugin.name,
        pluginRef: reg,
        installedVersion,
        installCommands: commands,
      });
    }
  }
  return { plugin, findings };
}
