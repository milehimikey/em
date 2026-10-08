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
// Resolution (findVersionPin, resolveDispatch) is pure and unit-tested directly; the actual spawn
// (dispatchToPinnedVersion) is a thin wrapper around `npx`, exercised by an opt-in integration test
// since it needs real process spawning and (on a cache miss) network access.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

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
 * malformed pin file).
 */
export function findVersionPin(startDir: string): VersionPin | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, VERSION_PIN_FILENAME);
    if (existsSync(candidate)) {
      const version = readFileSync(candidate, "utf8").trim();
      if (version.length > 0) return { version, source: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Decide whether a `.em-version` pin requires dispatching away from the currently-running
 * `installedVersion`. `null` means no dispatch: either no pin exists anywhere up the tree, the pin
 * matches what's already running (this is what guarantees the dispatched child doesn't recurse into
 * dispatching itself again), or `SKIP_ENV_VAR` is set.
 */
export function resolveDispatch(startDir: string, installedVersion: string, env: NodeJS.ProcessEnv = process.env): VersionPin | null {
  if (env[SKIP_ENV_VAR]) return null;
  const pin = findVersionPin(startDir);
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
