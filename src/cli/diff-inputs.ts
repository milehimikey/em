// SPDX-License-Identifier: MIT
// Testable input handling for `em diff`: argument-form validation and
// git-revision resolution, factored out of cli.ts so the branching logic can be
// unit-tested without spawning a subprocess or a real git repo (cli.ts keeps the
// process.exit/console wiring; see test/diff-inputs.test.ts).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { parseSliceDoc, SliceDoc } from "../catalog/sliceDoc.js";

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

/** One of the three ways reading a file at a revision can fail — see `showAtRevision`. */
type ShowFailure =
  | { ok: false; reason: "no-repo" }
  | { ok: false; reason: "not-tracked"; repoRoot: string }
  | { ok: false; reason: "show-failed"; relPath: string; detail: string };

/**
 * Read `targetAbs`'s content at git revision `rev`, resolving the repo root from
 * `anchorFile`'s directory (a file known to be somewhere inside the repo — doesn't itself have
 * to be `targetAbs`, e.g. a slice doc resolved relative to its `.em` file's location). The git
 * runner is injectable so every failure branch is unit-testable without a real repository.
 *
 * Existence/path lookup uses `git ls-tree -r --name-only <rev>` — scoped to `rev` itself, not
 * `git ls-files` (which reflects the *current* index/working tree). A doc that existed at
 * `rev` but has since been deleted — the routine case for a `superseded-by`-carrying doc, which
 * gets removed in the very commit that performs the split/merge/removal it records — would
 * otherwise resolve to "not tracked" even though `git show <rev>:<path>` can read it just fine.
 */
function showAtRevision(runGit: GitRunner, anchorFile: string, targetAbs: string, rev: string): { ok: true; content: string } | ShowFailure {
  const toplevel = runGit(["-C", dirname(resolve(anchorFile)), "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) return { ok: false, reason: "no-repo" };
  const repoRoot = toplevel.stdout.trim();
  const lsTree = runGit(["-C", repoRoot, "ls-tree", "-r", "--name-only", rev, "--", targetAbs]);
  const relPath = lsTree.stdout.trim().split("\n")[0];
  if (!relPath) return { ok: false, reason: "not-tracked", repoRoot };
  const show = runGit(["-C", repoRoot, "show", `${rev}:${relPath}`]);
  if (show.status !== 0) {
    return { ok: false, reason: "show-failed", relPath, detail: (show.stderr || "").trim() || "unknown git error" };
  }
  return { ok: true, content: show.stdout };
}

/**
 * Resolve `file`'s content at git revision `rev` via `git show <rev>:<repo-relative-path>`.
 * The git runner is injectable so the not-a-repo / not-tracked / bad-rev branches are
 * unit-testable without a real repository.
 */
export function resolveRevision(file: string, rev: string, runGit: GitRunner = realGit): RevisionResult {
  const result = showAtRevision(runGit, file, resolve(file), rev);
  if (result.ok) return result;
  switch (result.reason) {
    case "no-repo":
      return { ok: false, message: `em diff: ${file} is not inside a git repository (needed for --from/--to)` };
    case "not-tracked":
      return { ok: false, message: `em diff: ${file} is not tracked by git in ${result.repoRoot}` };
    case "show-failed":
      return { ok: false, message: `em diff: cannot read ${result.relPath} at revision "${rev}": ${result.detail}` };
  }
}

/**
 * Resolve a slice's doc (`slices/<sliceKey>.md`, relative to `anchorFile`'s directory — same
 * convention as every other doc/note path in em) at git revision `rev`. Unlike
 * `resolveRevision`, a missing doc at a revision is routine (not every slice had a doc yet, or
 * the doc simply isn't tracked) rather than a user-facing error — so every failure mode
 * collapses to `null`, for `em diff`'s lineage annotation (MIL-84) to treat as "nothing to
 * annotate with" rather than aborting the diff.
 */
export function resolveDocAtRevision(anchorFile: string, sliceKey: string, rev: string, runGit: GitRunner = realGit): SliceDoc | null {
  const targetAbs = resolve(dirname(resolve(anchorFile)), "slices", `${sliceKey}.md`);
  const result = showAtRevision(runGit, anchorFile, targetAbs, rev);
  return result.ok ? parseSliceDoc(result.content) : null;
}
