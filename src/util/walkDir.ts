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

/** Every regular file under `dir`, recursively, as paths relative to `dir` — sorted, POSIX
 *  forward slashes regardless of platform (so hashes/change-reports are stable and testable
 *  across OSes). Symlinks and other non-file/non-directory entries are skipped. */
export function walkDir(dir: string): string[] {
  const out: string[] = [];

  function recurse(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) recurse(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  }

  recurse(dir);
  return out.sort();
}
