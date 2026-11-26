// SPDX-License-Identifier: MIT
// GH #527: from a model's directory, find the system manifest that governs it and read the repo
// ids it declares. A model command (`em validate`, and every command that resolves a place) is
// run on a `.em` file, not on a manifest, so this is how it learns which repo ids exist.
//
// Lookup: the nearest `system.yaml` at or above the start directory, stopping at the root of the
// git repository the model lives in (the first ancestor holding a `.git` entry, inclusive). A
// manifest never governs models outside its own repository. Outside any git repository the walk
// goes to the filesystem root. Pure filesystem: no git process, so `em validate` stays as cheap
// as it was.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ManifestRepo, parseManifest } from "./manifest.js";

const SYSTEM_MANIFEST_FILE = "system.yaml";

/** The nearest `system.yaml` at or above `startDir` within the same git repository, or `null`. */
export function findSystemManifest(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, SYSTEM_MANIFEST_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type DeclaredRepos =
  /** No manifest governs this model: only `self` exists. */
  | { kind: "none" }
  /** A manifest was found and read; `repos` is what it declares (`[]` for a 2.0 manifest). */
  | { kind: "ok"; manifestPath: string; repos: ManifestRepo[] }
  /** A manifest was found but cannot be read or is invalid; its repo ids are unknown. */
  | { kind: "invalid"; manifestPath: string; message: string };

/** The repos declared by the manifest governing `startDir` (see `findSystemManifest`). */
export function loadDeclaredRepos(startDir: string): DeclaredRepos {
  const manifestPath = findSystemManifest(startDir);
  if (manifestPath === null) return { kind: "none" };
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (e) {
    return { kind: "invalid", manifestPath, message: "it cannot be read" };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    return { kind: "invalid", manifestPath, message: first ? first.message : "invalid manifest" };
  }
  return { kind: "ok", manifestPath, repos: parsed.manifest.repos };
}
