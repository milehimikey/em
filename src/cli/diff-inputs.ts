// SPDX-License-Identifier: MIT
// Testable input handling for `em diff`: argument-form validation and
// git-revision resolution, factored out of cli.ts so the branching logic can be
// unit-tested without spawning a subprocess or a real git repo (cli.ts keeps the
// process.exit/console wiring; see test/diff-inputs.test.ts).

import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { parseSliceDoc, SliceDoc } from "../catalog/sliceDoc.js";
import { stripComment } from "../parser/lexer.js";
import { docFolders } from "../catalog/docLocate.js";

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
 * GH #475: a `SourceReader` for a root model's storyline model files as of git revision `rev`:
 * `rel` (posix, relative to the root's directory) is read with `git show <rev>:<path>`, the root
 * sitting at `rootFile`. Throws when the file is not readable at that revision — the loader turns
 * that into a `ModelLoadError` naming the storyline. The git runner is injectable for tests.
 */
export function gitSourceReader(rootFile: string, rev: string, runGit: GitRunner = realGit): (rel: string) => string {
  return (rel) => {
    const r = resolveRevision(join(dirname(resolve(rootFile)), rel), rev, runGit);
    if (!r.ok) throw new Error(r.message);
    return r.content;
  };
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
  const baseDirAbs = dirname(resolve(anchorFile));
  const targetAbs = resolve(baseDirAbs, "slices", `${sliceKey}.md`);
  const result = showAtRevision(runGit, anchorFile, targetAbs, rev);
  if (result.ok) return parseSliceDoc(result.content);
  // GH #421: a storyline model's docs live in `<storyline folder>/slices/`. Root first, like
  // `locateDoc` on disk.
  const rel = storylineDocsAtRevision(runGit, baseDirAbs, rev).get(sliceKey);
  if (rel === undefined) return null;
  const show = runGit(["-C", baseDirAbs, "show", `${rev}:./${rel}`]);
  return show.status === 0 ? parseSliceDoc(show.stdout) : null;
}

/** One listing per (git runner, model directory, revision): `em ledger` asks once per slice key. */
const storylineDocsCache = new WeakMap<GitRunner, Map<string, Map<string, string>>>();

/**
 * Slice docs kept in storyline folders at git revision `rev`: slice key -> path relative to the
 * root model's directory (`<dir>/slices/<key>.md`). A folder counts when, at that revision, it
 * holds a `.em` file whose first significant line is a `storyline "…"` header with no `{` — the
 * same test `docFolders` applies on disk, so a sibling model's `slices/` is never read as this
 * model's. Empty when git cannot list the revision, or when the model has no storyline folder on
 * disk.
 */
function storylineDocsAtRevision(runGit: GitRunner, baseDirAbs: string, rev: string): Map<string, string> {
  let perRunner = storylineDocsCache.get(runGit);
  if (!perRunner) storylineDocsCache.set(runGit, (perRunner = new Map()));
  const cacheKey = `${baseDirAbs}\u0000${rev}`;
  const cached = perRunner.get(cacheKey);
  if (cached) return cached;
  const out = new Map<string, string>();
  perRunner.set(cacheKey, out);
  // Only a model that has storyline folders today is asked about them at a revision: a root-only
  // model makes no extra git call.
  if (docFolders(baseDirAbs).length <= 1) return out;
  const ls = runGit(["-C", baseDirAbs, "ls-tree", "-r", "--name-only", rev]);
  if (ls.status !== 0 || typeof ls.stdout !== "string") return out;
  const names = ls.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const emByDir = new Map<string, string[]>();
  for (const n of names) {
    const m = /^([^/]+)\/[^/]+\.em$/.exec(n);
    if (m) emByDir.set(m[1], [...(emByDir.get(m[1]) ?? []), n]);
  }
  const isStoryline = new Map<string, boolean>();
  const storylineDir = (dir: string): boolean => {
    const known = isStoryline.get(dir);
    if (known !== undefined) return known;
    let yes = false;
    for (const em of emByDir.get(dir) ?? []) {
      const show = runGit(["-C", baseDirAbs, "show", `${rev}:./${em}`]);
      if (show.status !== 0 || typeof show.stdout !== "string") continue;
      const first = show.stdout.split(/\r?\n/).map((l) => stripComment(l).trim()).find((l) => l.length > 0);
      if (first && /^storyline\b/.test(first) && !first.includes("{")) {
        yes = true;
        break;
      }
    }
    isStoryline.set(dir, yes);
    return yes;
  };
  for (const n of names.sort()) {
    const m = /^([^/]+)\/slices\/([^/]+)\.md$/.exec(n);
    if (!m || m[1] === "slices" || m[1].startsWith(".")) continue;
    if (!storylineDir(m[1])) continue;
    if (!out.has(m[2])) out.set(m[2], n);
  }
  return out;
}

/**
 * Slice doc keys (filename stems under `slices/`, relative to `anchorFile`'s directory — same
 * anchor convention as `resolveDocAtRevision`) present at git revision `rev`. Used by `em ledger`
 * (MIL-89) to discover the candidate set of docs to compare across two revisions, reusing the
 * same repo-root resolution `showAtRevision` does rather than a second, divergent way of finding
 * "what slice docs exist here." Returns `[]` (not an error) when the repo can't be resolved or
 * `slices/` didn't exist at `rev` — both routine (a model with no slice docs yet), matching
 * `resolveDocAtRevision`'s "missing is routine" stance.
 */
export function listSliceKeysAtRevision(anchorFile: string, rev: string, runGit: GitRunner = realGit): string[] {
  const toplevel = runGit(["-C", dirname(resolve(anchorFile)), "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) return [];
  const repoRoot = toplevel.stdout.trim();
  const slicesDirAbs = resolve(dirname(resolve(anchorFile)), "slices");
  const lsTree = runGit(["-C", repoRoot, "ls-tree", "-r", "--name-only", rev, "--", slicesDirAbs]);
  const rootKeys =
    lsTree.status !== 0
      ? []
      : lsTree.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.endsWith(".md"))
          .map((line) => basename(line, ".md"));
  // GH #421: plus every doc in a storyline folder at that revision.
  const storylineKeys = [...storylineDocsAtRevision(runGit, dirname(resolve(anchorFile)), rev).keys()];
  return [...new Set([...rootKeys, ...storylineKeys])];
}
