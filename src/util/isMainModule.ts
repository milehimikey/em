// SPDX-License-Identifier: MIT
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the calling module is the process's entry point (invoked directly), not merely
 * `import`ed — the ESM analogue of CJS's `require.main === module`. Pass the caller's own
 * `import.meta.url`.
 *
 * Realpath-resolves `process.argv[1]` before comparing: Node's ESM loader resolves symlinks
 * when it loads a module, so `import.meta.url` always reflects the real underlying file — but
 * `process.argv[1]` keeps the literal invoked path, which IS a symlink for every `npm i -g`
 * install (the global bin entry symlinks to the package's real `dist/cli.js`). Comparing the
 * raw, un-realpath'd `argv[1]` against the resolved `import.meta.url` breaks silently for
 * exactly that case: the guarded code never runs and the CLI does nothing, with no error (found
 * in code review, MIL-92 PR #85 — confirmed via `npm i -g`'s actual symlink shape).
 */
export function isMainModule(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(importMetaUrl));
  let invokedPath: string;
  try {
    invokedPath = realpathSync(process.argv[1]);
  } catch {
    // argv[1] not resolvable on disk (unusual, e.g. a REPL/-e invocation) — fall back to the
    // raw path rather than throwing; this only ever makes the check stricter, never wrongly true.
    invokedPath = resolve(process.argv[1]);
  }
  return modulePath === resolve(invokedPath);
}
