// SPDX-License-Identifier: MIT
// Testable input handling for `em glossary`: flag-combination validation,
// factored out of cli.ts so it's unit-testable without spawning a subprocess
// (cli.ts keeps the process.exit/console wiring; see test/glossary-inputs.test.ts).
// Mirrors src/cli/diff-inputs.ts's planDiffArgs shape for the same reason.

/** Resolved `em glossary` flag validation, or a user-facing `error`. */
export type GlossaryPlan = { error: string } | { ok: true };

/**
 * Validate the `em glossary` flag combination. Pure — no I/O. `-o` only makes
 * sense alongside `--json`: there's no JSON document to write from the text
 * report, so the combination is a usage error rather than a silent no-op.
 */
export function planGlossaryArgs(opts: { json?: boolean; out?: string }): GlossaryPlan {
  if (opts.out && !opts.json) {
    return { error: "em glossary: -o requires --json (there's no file to write from the text report)" };
  }
  return { ok: true };
}
