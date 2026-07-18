// SPDX-License-Identifier: MIT
// Project config (em.config.json), per docs/1.0.0-spec.md §4. One field for
// now: a body-only custom slice template. Resolution: --config flag > model
// directory > walk up parents > shipped default (no em.config.json needed).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EmConfig {
  /** Path to a body-only custom slice template, resolved relative to the config file's directory. */
  sliceTemplate?: string;
}

export interface ResolvedConfig {
  config: EmConfig;
  /** Absolute path to the em.config.json that was loaded, or null if none was found. */
  configPath: string | null;
}

/** Resolve project config starting from `modelDir`, walking up to the filesystem root. */
export function resolveConfig(modelDir: string, explicitPath?: string): ResolvedConfig {
  if (explicitPath) {
    return { config: readConfig(explicitPath), configPath: resolve(explicitPath) };
  }

  let dir = resolve(modelDir);
  for (;;) {
    const candidate = join(dir, "em.config.json");
    if (existsSync(candidate)) {
      return { config: readConfig(candidate), configPath: candidate };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { config: {}, configPath: null };
}

function readConfig(path: string): EmConfig {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return (parsed ?? {}) as EmConfig;
}

/** The default slice template shipped with the package (the same one `em skill install` copies). */
export function defaultSliceTemplatePath(): string {
  const pkgDir = dirname(fileURLToPath(import.meta.url));
  return join(pkgDir, "..", ".claude", "skills", "event-modeling", "templates", "slice.md");
}

/** The effective slice template path: the resolved config's custom template, or the shipped default. */
export function resolveSliceTemplatePath(resolved: ResolvedConfig): string {
  if (!resolved.config.sliceTemplate) return defaultSliceTemplatePath();
  const base = resolved.configPath ? dirname(resolved.configPath) : process.cwd();
  return resolve(base, resolved.config.sliceTemplate);
}
