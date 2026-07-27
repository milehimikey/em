// SPDX-License-Identifier: MIT
// Git interaction for `em changelog`, isolated like diff-inputs.ts: listing
// the commits that touched a model file and reading a revision's content
// (`readFileAtCommit`) are the only impure operations here — everything
// formattable/parseable (markdown assembly, decisions parsing) lives in
// ../emit/changelog.ts, unit-tested without git.

import { dirname, resolve } from "node:path";
import { GitRunner, realGit } from "./diff-inputs.js";

export interface CommitInfo {
  /** Full commit hash — what `readFileAtCommit`/`git show` reads content at. */
  hash: string;
  shortHash: string;
  /** YYYY-MM-DD author date (`--date=short`). */
  date: string;
  subject: string;
  /**
   * Repo-relative path of the file AS OF this commit, taken from the same
   * `git log --follow --name-only` walk — pre-rename commits carry the old
   * path, the one `git show <hash>:<path>` can actually read.
   */
  path: string;
}

export type CommitsResult =
  | { ok: true; repoRoot: string; commits: CommitInfo[] }
  | { ok: false; message: string };

// A control character, not a valid character in a commit subject — safe as a
// field separator in `git log --format`.
const FS = "\x01";

/**
 * List every commit that touched `file` (rename-following via `--follow`),
 * oldest -> newest, each carrying the file's path as of that commit.
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
    const verifyTo = runGit(["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", opts.to]);
    if (verifyTo.status !== 0) {
      return { ok: false, message: `em changelog: unknown revision "${opts.to}" for --to` };
    }
  }

  let range = upRev;
  if (opts.from) {
    const verifyFrom = runGit(["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", opts.from]);
    if (verifyFrom.status !== 0) {
      return { ok: false, message: `em changelog: unknown revision "${opts.from}" for --from` };
    }
    const verifyParent = runGit(["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", `${opts.from}^`]);
    range = verifyParent.status === 0 ? `${opts.from}^..${upRev}` : upRev;
  }

  // --name-only prints, after each commit's format line, the file's path as
  // of that commit (--follow makes that the historical, pre-rename path when
  // applicable). core.quotepath=false keeps non-ASCII paths literal instead
  // of octal-escaped, so the printed path is usable in `git show`.
  const log = runGit([
    "-C",
    repoRoot,
    "-c",
    "core.quotepath=false",
    "log",
    "--follow",
    "--name-only",
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

  // Output alternates: a format line (contains FS), a blank line, then the
  // path line for that commit. A commit with no path line (e.g. a merge,
  // whose file list git omits by default) falls back to the current path.
  const commits: CommitInfo[] = [];
  for (const line of log.stdout.split("\n")) {
    if (line.length === 0) continue;
    if (line.includes(FS)) {
      const [hash, shortHash, date, ...subjectParts] = line.split(FS);
      commits.push({ hash, shortHash, date, subject: subjectParts.join(FS), path: relPath });
    } else if (commits.length > 0) {
      commits[commits.length - 1].path = line;
    }
  }
  commits.reverse(); // git log is newest-first; changelog building wants oldest->newest

  if (commits.length === 0) {
    return { ok: false, message: `em changelog: no commits found for ${relPath} in the given range` };
  }

  return { ok: true, repoRoot, commits };
}

/** File content at a commit, or a note-ready `message` (no command prefix — it lands inside a changelog section). */
export type FileAtCommitResult = { ok: true; content: string } | { ok: false; message: string };

/**
 * Read the model's content at `commit`, using `commit.path` — the path the
 * file had AT that commit — so reads keep working across renames, where the
 * current path doesn't exist in older revisions.
 */
export function readFileAtCommit(
  repoRoot: string,
  commit: CommitInfo,
  runGit: GitRunner = realGit,
): FileAtCommitResult {
  const show = runGit(["-C", repoRoot, "show", `${commit.hash}:${commit.path}`]);
  if (show.status !== 0) {
    return {
      ok: false,
      message: `cannot read ${commit.path} at ${commit.shortHash}: ${(show.stderr || "").trim() || "unknown git error"}`,
    };
  }
  return { ok: true, content: show.stdout };
}
