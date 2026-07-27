// SPDX-License-Identifier: MIT
// Git interaction for `em changelog`, isolated like diff-inputs.ts: listing
// the commits that touched a model file is the only impure operation here —
// reading a revision's content reuses `resolveRevision` (diff-inputs.ts), and
// everything formattable/parseable (markdown assembly, decisions parsing)
// lives in ../emit/changelog.ts, unit-tested without git.

import { dirname, resolve } from "node:path";
import { GitRunner, realGit } from "./diff-inputs.js";

export interface CommitInfo {
  /** Full commit hash — what `resolveRevision`/`git show` reads content at. */
  hash: string;
  shortHash: string;
  /** YYYY-MM-DD author date (`--date=short`). */
  date: string;
  subject: string;
}

export type CommitsResult =
  | { ok: true; commits: CommitInfo[] }
  | { ok: false; message: string };

// A control character, not a valid character in a commit subject — safe as a
// field separator in `git log --format`.
const FS = "";

/**
 * List every commit that touched `file` (rename-following via `--follow`),
 * oldest -> newest.
 *
 * `--from`/`--to` bound the walk **inclusive of both boundary commits**: the
 * range compiles to `<from>^..<to>` (git's standard idiom for an
 * inclusive-from range), so `--from` itself is the oldest commit in the
 * output and `--to` the newest. `--to` defaults to `HEAD`. `--from` on a
 * root commit (no parent to exclude) falls back to an unbounded walk up to
 * `<to>`, which is equivalent — there's nothing before a root commit to
 * exclude anyway.
 */
export function listModelCommits(
  file: string,
  opts: { from?: string; to?: string } = {},
  runGit: GitRunner = realGit,
): CommitsResult {
  const abs = resolve(file);
  const toplevel = runGit(["-C", dirname(abs), "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) {
    return { ok: false, message: `em changelog: ${file} is not inside a git repository` };
  }
  const repoRoot = toplevel.stdout.trim();

  const lsFiles = runGit(["-C", repoRoot, "ls-files", "--full-name", "--", abs]);
  const relPath = lsFiles.stdout.trim().split("\n")[0];
  if (!relPath) {
    return { ok: false, message: `em changelog: ${file} is not tracked by git in ${repoRoot}` };
  }

  const upRev = opts.to ?? "HEAD";
  if (opts.to) {
    const verifyTo = runGit(["-C", repoRoot, "rev-parse", "--verify", opts.to]);
    if (verifyTo.status !== 0) {
      return { ok: false, message: `em changelog: unknown revision "${opts.to}" for --to` };
    }
  }

  let range = upRev;
  if (opts.from) {
    const verifyFrom = runGit(["-C", repoRoot, "rev-parse", "--verify", opts.from]);
    if (verifyFrom.status !== 0) {
      return { ok: false, message: `em changelog: unknown revision "${opts.from}" for --from` };
    }
    const verifyParent = runGit(["-C", repoRoot, "rev-parse", "--verify", `${opts.from}^`]);
    range = verifyParent.status === 0 ? `${opts.from}^..${upRev}` : upRev;
  }

  const log = runGit([
    "-C",
    repoRoot,
    "log",
    "--follow",
    `--format=%H${FS}%h${FS}%ad${FS}%s`,
    "--date=short",
    range,
    "--",
    relPath,
  ]);
  if (log.status !== 0) {
    return {
      ok: false,
      message: `em changelog: git log failed: ${(log.stderr || "").trim() || "unknown git error"}`,
    };
  }

  const commits: CommitInfo[] = log.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, shortHash, date, ...subjectParts] = line.split(FS);
      return { hash, shortHash, date, subject: subjectParts.join(FS) };
    })
    .reverse(); // git log is newest-first; changelog building wants oldest->newest

  if (commits.length === 0) {
    return { ok: false, message: `em changelog: no commits found for ${relPath} in the given range` };
  }

  return { ok: true, commits };
}
