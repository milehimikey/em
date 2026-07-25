// SPDX-License-Identifier: MIT
// Testable input handling for `em diff`: argument-form validation and
// git-revision resolution, factored out of cli.ts so the branching logic can be
// unit-tested without spawning a subprocess or a real git repo (cli.ts keeps the
// process.exit/console wiring; see test/diff-inputs.test.ts).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/** Resolved `em diff` invocation, or a user-facing `error` for an invalid form. */
export type DiffPlan =
  | { error: string }
  | { form: "files"; oldFile: string; newFile: string }
  | { form: "git"; file: string; from: string; to?: string };

/**
 * Validate the `em diff` argument/flag combination. Pure — no I/O. The two forms
 * (two files, or one file across git revisions) are mutually exclusive.
 */
export function planDiffArgs(
  oldFile: string,
  newFile: string | undefined,
  opts: { from?: string; to?: string },
): DiffPlan {
  if (opts.from) {
    if (newFile) {
      return {
        error: "em diff: cannot combine two file arguments with --from/--to — use one form or the other",
      };
    }
    return { form: "git", file: oldFile, from: opts.from, to: opts.to };
  }
  if (opts.to) {
    return { error: "em diff: --to requires --from" };
  }
  if (!newFile) {
    return {
      error: "em diff: provide two files (`em diff old.em new.em`) or one file with --from <rev>",
    };
  }
  return { form: "files", oldFile, newFile };
}

/** The slice of a `spawnSync` result `resolveRevision` reads; lets tests inject a fake git. */
export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[]) => GitResult;

/** Default runner: really invokes `git` (array args — no shell, no injection). */
export const realGit: GitRunner = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** File content at a git revision, or a user-facing `message` for each failure mode. */
export type RevisionResult = { ok: true; content: string } | { ok: false; message: string };

/**
 * Resolve `file`'s content at git revision `rev` via `git show <rev>:<repo-relative-path>`.
 * The git runner is injectable so the not-a-repo / not-tracked / bad-rev branches are
 * unit-testable without a real repository.
 */
export function resolveRevision(file: string, rev: string, runGit: GitRunner = realGit): RevisionResult {
  const abs = resolve(file);
  const toplevel = runGit(["-C", dirname(abs), "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) {
    return { ok: false, message: `em diff: ${file} is not inside a git repository (needed for --from/--to)` };
  }
  const repoRoot = toplevel.stdout.trim();
  const lsFiles = runGit(["-C", repoRoot, "ls-files", "--full-name", "--", abs]);
  const relPath = lsFiles.stdout.trim().split("\n")[0];
  if (!relPath) {
    return { ok: false, message: `em diff: ${file} is not tracked by git in ${repoRoot}` };
  }
  const show = runGit(["-C", repoRoot, "show", `${rev}:${relPath}`]);
  if (show.status !== 0) {
    return {
      ok: false,
      message: `em diff: cannot read ${relPath} at revision "${rev}": ${(show.stderr || "").trim() || "unknown git error"}`,
    };
  }
  return { ok: true, content: show.stdout };
}
