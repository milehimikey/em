// SPDX-License-Identifier: MIT
// Recursive file-tree listing shared by `em skill sync`/`em skill check` (src/cli/skillSync.ts,
// src/cli/skillCheck.ts) to enumerate every file in the bundled skill directory — not just the
// `.md` subset test/skillExamples.test.ts's skillFiles() walks for doctesting, which deliberately
// skips non-`.md` files like templates/live.html. Sync/check must cover the whole tree.
//
// Manual walk rather than `readdirSync(dir, { recursive: true })` — that overload is Node
// 20.1+ only; package.json declares `"engines": { "node": ">=18" }`.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface WalkDirOptions {
  /** When given, called with each directory entry's bare name before descending into it; a
   *  `true` return prunes the whole subtree (never read via `readdirSync`, never descended) —
   *  cheaper and safer than walking everything and filtering the flat result list afterward
   *  (skips permission errors / huge trees under a pruned dir too, e.g. `node_modules`). Omitted
   *  entirely by every existing caller (skillSync.ts/skillCheck.ts), which still walk the whole
   *  tree with no behavior change. */
  skipDir?: (name: string) => boolean;
}

/** Every regular file under `dir`, recursively, as paths relative to `dir` — sorted, POSIX
 *  forward slashes regardless of platform (so hashes/change-reports are stable and testable
 *  across OSes). Symlinks and other non-file/non-directory entries are skipped. */
export function walkDir(dir: string, opts?: WalkDirOptions): string[] {
  const out: string[] = [];
  const skipDir = opts?.skipDir;

  function recurse(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDir?.(entry.name)) continue;
        recurse(join(current, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(dir, join(current, entry.name)).split(sep).join("/"));
      }
    }
  }

  recurse(dir);
  return out.sort();
}
