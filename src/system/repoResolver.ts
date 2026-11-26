// SPDX-License-Identifier: MIT
// GH #528: turn a repo id into a checkout on this machine. The committed files (`system.yaml`'s
// `repos:`, a model's `code-map.yaml`) name logical repo ids only; where each is checked out is a
// fact about one machine and is never in git. This module is the one place that fact is worked
// out, shared by every command that reads code in a repository other than the model's own.
//
// For each id, the first source that names a path wins:
//   1. `--repo <id>=<path>` (repeatable). A bare `--repo <path>` is the checkout of the only repo
//      in play, which is what `--repo` has always meant.
//   2. `.em/repos.local.yaml` at the root of the model's repository: an uncommitted, per-machine
//      `repos: {<id>: <path>}` map.
//   3. A sibling directory named after the id, next to the model's repository.
// `self` is always the model's own repository and is never looked up.
//
// em never clones, pulls or pushes. A repo that no source places, or whose path is not there, is
// reported `missing`; a directory that is not the root of a git work tree is `not-a-git-repo`.
// Nothing is fetched to make either go away.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LineCounter, parseDocument, isMap, isScalar, Node } from "yaml";
import { isRepoId, SELF_REPO_ID } from "./manifest.js";
import { GitRunner, realGit } from "../cli/diff-inputs.js";

/** The per-machine mapping file, relative to the root of the model's repository. */
export const REPOS_LOCAL_FILE = ".em/repos.local.yaml";
/** The `reposLocalSchemaVersion` this em reads. The key is optional in the file. */
export const REPOS_LOCAL_SCHEMA_VERSION = "1.0";

export type RepoSource = "self" | "flag" | "local-file" | "sibling";
export type RepoStatus = "resolved" | "missing" | "not-a-git-repo";

export interface RepoResolution {
  id: string;
  /** The remote `system.yaml` records; `null` for `self` and for an id the manifest does not declare. */
  remote: string | null;
  status: RepoStatus;
  /** Absolute path of the checkout, or of the place it was looked for; `null` only when no
   *  source named one and there is no model repository to look beside. */
  path: string | null;
  /** Which source named `path`. For a `missing` repo this is where it was last looked for. */
  source: RepoSource | null;
  /** `resolved` only: whether the checkout's `origin` remote is the recorded one. `null` when
   *  there is nothing to compare (no recorded remote, or no `origin`). */
  remoteMatches: boolean | null;
  /** The checkout's `origin` URL, when `remoteMatches` is `false`. */
  actualRemote: string | null;
}

// ---- `--repo` values ----------------------------------------------------------------------

export type RepoArgs = { ok: true; byId: Map<string, string>; bare: string | null } | { ok: false; message: string };

/**
 * Split repeated `--repo` values into `<id>=<path>` pairs and at most one bare `<path>`. A value
 * is a pair when the text before its first `=` is a repo id; a value that is itself an existing
 * path is always a bare path, so a directory with `=` in its name keeps working.
 */
export function parseRepoArgs(values: readonly string[], exists: (path: string) => boolean = existsSync): RepoArgs {
  const byId = new Map<string, string>();
  let bare: string | null = null;
  for (const value of values) {
    const eq = value.indexOf("=");
    const id = eq > 0 ? value.slice(0, eq) : "";
    if (eq > 0 && isRepoId(id) && !exists(value)) {
      const path = value.slice(eq + 1);
      if (path === "") return { ok: false, message: `--repo ${value}: give a path after \`${id}=\`` };
      if (id === SELF_REPO_ID) {
        return { ok: false, message: `--repo ${value}: \`${SELF_REPO_ID}\` is the model's own repository and is not mapped` };
      }
      if (byId.has(id)) return { ok: false, message: `--repo: repo "${id}" is given twice` };
      byId.set(id, path);
    } else {
      if (bare !== null) return { ok: false, message: "--repo: only one bare path is allowed — write the others as <id>=<path>" };
      bare = value;
    }
  }
  return { ok: true, byId, bare };
}

// ---- `.em/repos.local.yaml` ---------------------------------------------------------------

export type ReposLocal = { ok: true; paths: Map<string, string> } | { ok: false; problems: string[] };

/** Shape-check the per-machine file: optional `reposLocalSchemaVersion: "1.0"`, and `repos:`, a
 *  map of repo id -> path. Unknown keys are problems, never ignored. */
export function parseReposLocal(text: string): ReposLocal {
  const problems: string[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (node: unknown): string => {
    const range = node && typeof node === "object" && "range" in node ? (node as Node).range : undefined;
    return range ? `line ${lineCounter.linePos(range[0]).line}: ` : "";
  };
  if (doc.errors.length > 0) {
    return { ok: false, problems: doc.errors.map((e) => `${e.linePos?.[0] ? `line ${e.linePos[0].line}: ` : ""}YAML parse error: ${e.message.trim()}`) };
  }
  const root = doc.contents;
  if (!isMap(root)) return { ok: false, problems: ["must be a YAML mapping with `repos:` (repo id -> path)"] };
  for (const pair of root.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : "";
    if (key !== "reposLocalSchemaVersion" && key !== "repos") problems.push(`${at(pair.key)}unknown key "${key}" — expected reposLocalSchemaVersion, repos`);
  }
  const versionNode = root.get("reposLocalSchemaVersion", true) as Node | undefined;
  if (versionNode !== undefined && !(isScalar(versionNode) && versionNode.value === REPOS_LOCAL_SCHEMA_VERSION)) {
    problems.push(`${at(versionNode)}unsupported reposLocalSchemaVersion — this em reads "${REPOS_LOCAL_SCHEMA_VERSION}" (quote it)`);
  }
  const paths = new Map<string, string>();
  const reposNode = root.get("repos", true) as Node | undefined;
  if (reposNode === undefined || (isScalar(reposNode) && reposNode.value === null)) {
    // An empty file is legal: it maps nothing.
  } else if (!isMap(reposNode)) {
    problems.push(`${at(reposNode)}\`repos\` must be a mapping of repo id -> path`);
  } else {
    for (const pair of reposNode.items) {
      const id = isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : "";
      const value = isScalar(pair.value) && typeof pair.value.value === "string" ? pair.value.value.trim() : "";
      if (!isRepoId(id)) problems.push(`${at(pair.key)}"${isScalar(pair.key) ? String(pair.key.value) : ""}" is not a repo id`);
      else if (id === SELF_REPO_ID) problems.push(`${at(pair.key)}\`${SELF_REPO_ID}\` is the model's own repository and is not mapped`);
      else if (value === "") problems.push(`${at(pair.key)}repo "${id}": the path must be a non-empty string`);
      else paths.set(id, value);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, paths };
}

// ---- resolution ---------------------------------------------------------------------------

/** The root of the git work tree `startDir` is in: the nearest ancestor (inclusive) holding a
 *  `.git` entry — a directory, or the file a linked work tree or submodule has. `null` outside git. */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** `git@host:owner/repo.git`, `ssh://git@host/owner/repo`, `https://host/owner/repo.git/` all
 *  name one repository: compare them as lowercase `host/owner/repo`. */
export function normalizeRemote(remote: string): string {
  let r = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r);
  if (scp) r = `${scp[1]}/${scp[2]}`;
  else r = r.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):\d+\//, "$1/");
  return r.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

export interface ResolveReposInput {
  /** Any directory inside the model's repository — normally the model file's own directory. */
  startDir: string;
  /** The ids to resolve, with the remote the manifest records for each (`null` when it records none). */
  repos: ReadonlyArray<{ id: string; remote: string | null }>;
  /** `--repo <id>=<path>` pairs (see `parseRepoArgs`); paths relative to `cwd`. */
  flagPaths?: ReadonlyMap<string, string>;
  /** The directory `--repo` paths are relative to. Default: the process's. */
  cwd?: string;
  runGit?: GitRunner;
}

export interface ResolveReposResult {
  /** The model's repository root, or `null` when the model is not in a git work tree. */
  modelRepoRoot: string | null;
  /** Absolute path of the per-machine file, when it exists. */
  localFile: string | null;
  /** Why the per-machine file was not used, when it exists but is unreadable or malformed. */
  localFileProblems: string[];
  /** `self` first, then `repos` in the order given. */
  resolutions: RepoResolution[];
}

/** Resolve `self` and every id in `input.repos` to a checkout. Reads the filesystem and, for a
 *  resolved repo with a recorded remote, the checkout's own `origin` URL. Never the network. */
export function resolveRepos(input: ResolveReposInput): ResolveReposResult {
  const runGit = input.runGit ?? realGit;
  const cwd = input.cwd ?? process.cwd();
  const startDir = resolve(input.startDir);
  const modelRepoRoot = findRepoRoot(startDir);
  const anchor = modelRepoRoot ?? startDir;

  const localPath = join(anchor, REPOS_LOCAL_FILE);
  let localFile: string | null = null;
  let localPaths = new Map<string, string>();
  const localFileProblems: string[] = [];
  if (existsSync(localPath)) {
    localFile = localPath;
    try {
      const parsed = parseReposLocal(readFileSync(localPath, "utf8"));
      if (parsed.ok) localPaths = parsed.paths;
      else localFileProblems.push(...parsed.problems);
    } catch (e) {
      localFileProblems.push(`cannot read it: ${(e as Error).message}`);
    }
  }

  const check = (id: string, remote: string | null, path: string, source: RepoSource): RepoResolution => {
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { id, remote, status: "missing", path, source, remoteMatches: null, actualRemote: null };
    if (!existsSync(join(path, ".git"))) return { id, remote, status: "not-a-git-repo", path, source, remoteMatches: null, actualRemote: null };
    let remoteMatches: boolean | null = null;
    let actualRemote: string | null = null;
    if (remote !== null) {
      const origin = runGit(["-C", path, "remote", "get-url", "origin"]);
      const url = origin.status === 0 ? origin.stdout.trim() : "";
      if (url !== "") {
        remoteMatches = normalizeRemote(url) === normalizeRemote(remote);
        if (!remoteMatches) actualRemote = url;
      }
    }
    return { id, remote, status: "resolved", path, source, remoteMatches, actualRemote };
  };

  const resolutions: RepoResolution[] = [
    modelRepoRoot !== null
      ? { id: SELF_REPO_ID, remote: null, status: "resolved", path: modelRepoRoot, source: "self", remoteMatches: null, actualRemote: null }
      : { id: SELF_REPO_ID, remote: null, status: "not-a-git-repo", path: startDir, source: "self", remoteMatches: null, actualRemote: null },
  ];
  for (const { id, remote } of input.repos) {
    if (id === SELF_REPO_ID) continue;
    const flag = input.flagPaths?.get(id);
    const local = localPaths.get(id);
    if (flag !== undefined) resolutions.push(check(id, remote, resolve(cwd, expandHome(flag)), "flag"));
    else if (local !== undefined) {
      const p = expandHome(local);
      resolutions.push(check(id, remote, isAbsolute(p) ? p : resolve(anchor, p), "local-file"));
    } else if (modelRepoRoot !== null) resolutions.push(check(id, remote, join(dirname(modelRepoRoot), id), "sibling"));
    else resolutions.push({ id, remote, status: "missing", path: null, source: null, remoteMatches: null, actualRemote: null });
  }
  return { modelRepoRoot, localFile, localFileProblems, resolutions };
}
