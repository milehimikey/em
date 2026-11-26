// SPDX-License-Identifier: MIT
// Corepack-style transparent per-project version pinning (milehimikey/em#223). A repo may drop a
// `.em-version` file (plain text, trimmed, e.g. "1.14.0") anywhere from cwd up to the filesystem
// root; when the installed `em` binary's own version differs from the pin, it re-execs the pinned
// version via `npx` with the original argv, inheriting stdio and exit code - completely transparent
// to the caller. This is the same pattern Node's Corepack uses for npm/yarn/pnpm's `packageManager`
// field: one global install, silently redirected per-project by a plain-text pin file.
//
// Why this over the plugin pin check (src/cli/pluginPin.ts): that one is reactive (a `.claude/
// settings.json` declaration is checked against what's installed and reported as a finding -
// useful for the plugin because "installed" there means a machine-level Claude Code registration
// the CLI cannot change for you). The CLI binary itself has no such constraint - it can re-exec
// itself - so pinning it can be fully transparent instead of just detected.
//
// Beside the mise pin (src/cli/misePin.ts): `.em-version` is the pin em itself reads, so it holds on
// any machine that has `em` and `npx`, whether or not mise is installed there. A repo may carry
// either or both. Both get the same two hooks: `em skill check` compares each against the plugin pin
// (or the installed em), so two pin files that disagree cannot both pass, and `em upgrade` moves
// each to the installed em. `em upgrade` itself is never dispatched (dispatchExempt): it is the
// command that moves the pin, so it has to run as the em that was just installed.
//
// Resolution (findVersionPin, resolveDispatch) is pure and unit-tested directly; the actual spawn
// (dispatchToPinnedVersion) is a thin wrapper around `npx`, exercised by an opt-in integration test
// since it needs real process spawning and (on a cache miss) network access.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { pluginPinVersion } from "./misePin.js";
import type { PluginDeclaration } from "./pluginPin.js";
import type { SkillCheckFinding } from "./skillCheck.js";

export const VERSION_PIN_FILENAME = ".em-version";
/** Set (to any non-empty value) to skip pin resolution entirely - the recursion-safety and local-dev
 *  escape hatch: the dispatched child process never re-dispatches itself (it runs the exact pinned
 *  version, so `resolveDispatch` already short-circuits on a version match), but this additionally
 *  lets anyone bypass pinning outright, e.g. while developing em itself from a worktree. */
export const SKIP_ENV_VAR = "EM_SKIP_VERSION_PIN";
/** The npm package re-exec dispatches into. */
export const PACKAGE_NAME = "@milehimikey/em";

export interface VersionPin {
  /** The pinned version string, trimmed (e.g. "1.14.0"). */
  version: string;
  /** Absolute path to the `.em-version` file that declared it. */
  source: string;
}

/**
 * Walk up from `startDir` to the filesystem root looking for `.em-version`. Returns the first
 * (closest) one found, trimmed; `null` if none exists anywhere up the tree, or the closest one is
 * present but empty/whitespace-only (treated as absent, not an error - never block the CLI on a
 * malformed pin file). When `stopAt` is given, the walk does not leave that directory.
 */
export function findVersionPin(startDir: string, stopAt?: string): VersionPin | null {
  let dir = startDir;
  const stop = stopAt ? resolvePath(stopAt) : null;
  for (;;) {
    const candidate = join(dir, VERSION_PIN_FILENAME);
    if (existsSync(candidate)) {
      const version = readFileSync(candidate, "utf8").trim();
      if (version.length > 0) return { version, source: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir || (stop !== null && resolvePath(dir) === stop)) return null; // filesystem root, or `stopAt`
    dir = parent;
  }
}

/** The root of the git work tree `dir` is in (the nearest ancestor holding a `.git` entry), or
 *  `null` outside git. A pin never governs across a repository boundary. */
function repoRootOf(dir: string): string | null {
  let d = resolvePath(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/**
 * GH #546: the pin of the MODEL's repository, for a command that names a model. There is one em
 * pin for a system, and it lives with the model; a command run from a code repository against a
 * model elsewhere (`em conform bindings check ../model/checkout/checkout.em`, in a code repo's
 * CI) must run at that version, not at whatever its own directory tree happens to say.
 *
 * The model is the first argument that names an existing `.em` file or `system.yaml`. Its pin is
 * the nearest `.em-version` at or above it, inside its own git repository. `null` when no
 * argument names one, or that repository carries no pin — the caller then falls back to the pin
 * above the working directory, as before.
 */
export function findModelRepoPin(args: readonly string[], cwd: string): VersionPin | null {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const base = arg.replace(/\\/g, "/").split("/").pop() ?? "";
    if (!base.endsWith(".em") && base !== "system.yaml") continue;
    const path = resolvePath(cwd, arg);
    if (!existsSync(path)) continue;
    const dir = dirname(path);
    return findVersionPin(dir, repoRootOf(dir) ?? undefined);
  }
  return null;
}

/** Commands that always run as the installed em, whatever `.em-version` says. `upgrade` is the
 *  command that moves the pin: dispatched to the pinned (older) em it could never bring a repo
 *  forward. The command is the first argument that is not an option. */
const DISPATCH_EXEMPT_COMMANDS: ReadonlySet<string> = new Set(["upgrade"]);

export function dispatchExempt(args: readonly string[]): boolean {
  const command = args.find((a) => !a.startsWith("-"));
  return command !== undefined && DISPATCH_EXEMPT_COMMANDS.has(command);
}

/** Replace the pinned version in the text of a `.em-version` file, keeping the whitespace around it
 *  (a trailing newline, LF or CRLF). `null` when the text holds no version. */
export function rewriteVersionPin(text: string, version: string): string | null {
  const current = text.trim();
  if (current.length === 0) return null;
  const at = text.indexOf(current);
  return text.slice(0, at) + version + text.slice(at + current.length);
}

export interface VersionPinCheck {
  pin: VersionPin;
  /** `null` when the pin agrees. */
  finding: SkillCheckFinding | null;
}

/**
 * Compare the `.em-version` pin found from `repoRoot` against the plugin pin's version (when the
 * repo declares the plugin) or the installed em: the same comparison `checkMisePin` makes for a
 * `mise.toml` pin, so a repo carrying both files is only clean when they agree. `null` when no
 * `.em-version` is found.
 */
export function checkVersionPin(repoRoot: string, installedVersion: string, plugin: PluginDeclaration | null): VersionPinCheck | null {
  const pin = findVersionPin(resolvePath(repoRoot));
  if (!pin) return null;
  const expected = plugin ? pluginPinVersion(plugin) : installedVersion;
  if (pin.version === expected) return { pin, finding: null };
  const shown = relative(resolvePath(repoRoot), pin.source) || pin.source;
  const against = plugin ? `the em plugin pin (${plugin.name} at ${plugin.ref ?? "(no ref)"})` : `installed em ${installedVersion}`;
  return {
    pin,
    finding: {
      code: "em-version-pin-mismatch",
      message: `.em-version pin mismatch: ${shown} pins em at ${pin.version}, but ${against} is ${expected} - write ${expected} to ${shown}, or run em upgrade`,
      emVersionPin: pin.version,
      emVersionFile: shown,
      installedVersion,
    },
  };
}

/**
 * Decide whether a `.em-version` pin requires dispatching away from the currently-running
 * `installedVersion`. The pin is the model repository's when `args` name a model (GH #546, see
 * `findModelRepoPin`), else the nearest one above `startDir`. `null` means no dispatch: either no pin exists anywhere up the tree, the pin
 * matches what's already running (this is what guarantees the dispatched child doesn't recurse into
 * dispatching itself again), `SKIP_ENV_VAR` is set, or `args` name a command that never dispatches
 * (`em upgrade`, see `dispatchExempt`).
 */
export function resolveDispatch(
  startDir: string,
  installedVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = [],
): VersionPin | null {
  if (env[SKIP_ENV_VAR]) return null;
  if (dispatchExempt(args)) return null;
  // GH #546: the model's repository holds the pin. It wins over a pin above the working
  // directory, which may be a code repository's own.
  const pin = findModelRepoPin(args, startDir) ?? findVersionPin(startDir);
  if (!pin || pin.version === installedVersion) return null;
  return pin;
}

/**
 * Re-exec `args` against the pinned `version` via `npx -y @milehimikey/em@<version>`, inheriting
 * stdio (so interactive prompts, `--json` output, and exit codes all pass through untouched).
 * Resolves with the child's exit code; rejects only if the spawn itself fails to start (e.g. `npx`
 * missing from PATH) - the caller should fall back to running the installed version in that case,
 * never hang or silently swallow the command.
 */
export function dispatchToPinnedVersion(version: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", `${PACKAGE_NAME}@${version}`, ...args], {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        // Mirror the child's termination signal on ourselves rather than inventing an exit code.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

// ---- GH #546: a code repository that hardcodes an em version of its own ----------------------

/** One place a repository fixes an em version itself. */
export interface OwnEmPin {
  /** Path relative to the repository root, posix. */
  file: string;
  version: string;
}

const EM_AT_VERSION = /@milehimikey\/em@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

/**
 * Every place the repository at `repoRoot` fixes an em version of its own: a root `.em-version`,
 * an `@milehimikey/em` dependency in the root `package.json` (as written, range included), and
 * each `@milehimikey/em@<x.y.z>` in a workflow under `.github/workflows/`. A code repository
 * should have none: it runs em at the version the model's repository pins. Read-only, and only
 * these three places — the same three a person would look in.
 */
export function findOwnEmPins(repoRoot: string): OwnEmPin[] {
  const out: OwnEmPin[] = [];
  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  const pinFile = read(VERSION_PIN_FILENAME);
  if (pinFile !== null && pinFile.trim() !== "") out.push({ file: VERSION_PIN_FILENAME, version: pinFile.trim() });
  const pkg = read("package.json");
  if (pkg !== null) {
    try {
      const json = JSON.parse(pkg) as Record<string, Record<string, unknown> | undefined>;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const v = json[section]?.[PACKAGE_NAME];
        if (typeof v === "string") out.push({ file: "package.json", version: v });
      }
    } catch {
      // not JSON: nothing to report from it
    }
  }
  let workflows: string[] = [];
  try {
    workflows = readdirSync(join(repoRoot, ".github", "workflows")).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    workflows = [];
  }
  for (const name of workflows) {
    const text = read(`.github/workflows/${name}`);
    if (text === null) continue;
    const seen = new Set<string>();
    for (const m of text.matchAll(EM_AT_VERSION)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ file: `.github/workflows/${name}`, version: m[1] });
    }
  }
  return out;
}
