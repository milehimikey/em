// SPDX-License-Identifier: MIT
// Resolves "the .em file" for a model directory, per the skill's existing
// one-model-per-directory convention. Shared by every `em slice`/`em migrate`
// command so an explicit --model always wins and the "which .em?" ambiguity
// error is worded the same way everywhere.

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function findModelFile(dir: string, explicitPath?: string): string {
  if (explicitPath) {
    // Relative to cwd, not `dir` — an explicit --model is a path the user typed
    // at the shell, so it must resolve the same way their shell would resolve it.
    // Checked eagerly: callers like `em slice new` only ever store this path in
    // frontmatter, so a wrong one would otherwise sit undetected until validate.
    const path = resolve(explicitPath);
    if (!existsSync(path)) throw new Error(`model file not found: ${path}`);
    return path;
  }

  const candidates = readdirSync(dir).filter((f) => f.endsWith(".em"));
  if (candidates.length === 1) return resolve(dir, candidates[0]);
  if (candidates.length === 0) {
    throw new Error(`no .em file found in ${dir} (pass --model <path.em>)`);
  }
  throw new Error(
    `multiple .em files found in ${dir} (${candidates.join(", ")}); pass --model <path.em>`,
  );
}
