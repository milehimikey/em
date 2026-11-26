// SPDX-License-Identifier: MIT
// GH #533: the conformance record of a model whose code is in more than one repository — what
// changed, and how far behind HEAD each repository is, since the revision recorded for it.
//
// `em conform-scope`, `em freshness` and `em status` each compared ONE repository with ONE
// recorded revision. Here they do it once per repository in play, each at its own revision
// (cli/repoRevisions.ts), and the results are joined: a changed path is written `<repo>:<path>`,
// so one list still carries them all and a slice's bound files match within their own repo.
//
// Which repositories are in play, and where each is checked out, is cli/bindingRepos.ts's
// answer — the same one `em conform bindings check` uses. A model with no code map, a plain
// recorded revision and no `repo:` in its bindings is not handled here at all: its commands run
// exactly as they did.

import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { loadModelPlaces } from "../codemap/modelPlaces.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { BindingRepos, boundSitesForSlice } from "./bindings.js";
import { buildBindingRepos } from "./bindingRepos.js";
import { buildConformScope, changedPathsSince, ConformScopeJson, LastConformance, SliceDocFacts } from "./conformScope.js";
import { parseRevision, revisionFor } from "./repoRevisions.js";

/** One repository's part of a conformance record. */
export interface RepoConformance {
  repo: string;
  /** The revision recorded for this repo; `null` when a per-repo revision does not cover it. */
  revision: string | null;
  /** Repo-root-relative paths changed since `revision`; `[]` when `error` is set. */
  changedPaths: string[];
  /** `git rev-list --count <revision>..HEAD`; `null` when `error` is set. */
  commitsBehindHead: number | null;
  /** Why this repo could not be compared: no checkout here, no recorded revision, a git failure. */
  error: string | null;
}

export type RepoConformancePlan =
  /** One repository, one revision: the caller runs its existing single-repository path. `dir`
   *  is the bare `--repo` path, when one was given. */
  | { mode: "single"; dir: string | null }
  | { mode: "multi"; repos: BindingRepos; inPlay: string[] }
  | { mode: "error"; message: string };

/** Decide how a model's conformance record is compared: against one repository, or several. */
export function planRepoConformance(input: {
  modelFile: string;
  model: NormalizedModel;
  refs: RefsResult;
  /** Every `--repo` value, as given. */
  repoValues: readonly string[];
  /** The revision `Last conformance:` records; `null` when there is none (first run). */
  recordedRevision: string | null;
}): RepoConformancePlan {
  const places = loadModelPlaces(input.modelFile, input.model, input.refs);
  const recorded = input.recordedRevision === null ? null : parseRevision(input.recordedRevision);
  const alsoInPlay = [
    ...(places.kind === "ok" ? places.all.map((p) => p.repo) : []),
    ...(recorded?.kind === "per-repo" ? recorded.revisions.map((r) => r.repo) : []),
  ];
  const built = buildBindingRepos({
    modelFile: input.modelFile,
    model: input.model,
    refs: input.refs,
    repoValues: input.repoValues,
    alsoInPlay,
    forceMulti: recorded?.kind === "per-repo",
  });
  if (!built.ok) return { mode: "error", message: built.message };
  if (typeof built.repos === "string") return { mode: "single", dir: built.bare };
  return { mode: "multi", repos: built.repos, inPlay: built.inPlay };
}

/** Compare every repository in play with the revision recorded for it. Never throws and never
 *  stops at the first failure: a repo that cannot be compared says why and the rest are still
 *  compared, since "the frontend is not checked out here" is a normal state. */
export function compareRepos(plan: Extract<RepoConformancePlan, { mode: "multi" }>, recordedRevision: string, runGit: GitRunner = realGit): RepoConformance[] {
  return plan.inPlay.map((repo) => {
    const revision = revisionFor(recordedRevision, repo);
    const where = plan.repos.dirOf(repo);
    const failed = (error: string): RepoConformance => ({ repo, revision, changedPaths: [], commitsBehindHead: null, error });
    if ("problem" in where) return failed(where.problem);
    if (revision === null) return failed(`no revision is recorded for repo "${repo}" — it joined the model's code after the last conformance run; a full run records one`);
    const changed = changedPathsSince(where.dir, revision, runGit);
    if (!changed.ok) return failed(changed.message.replace(/^em conform-scope: /, ""));
    // A place's root, and a bound file, are relative to the repo id's directory. That is normally
    // a work tree's root. When it is a directory INSIDE a larger work tree (a monorepo mapped as
    // several repo ids), git reports paths from that tree's root: keep only what is under this
    // directory, relative to it, and count only the commits that touched it.
    const prefix = changed.boundPrefix;
    const paths = prefix === "" ? changed.paths : changed.paths.filter((p) => p.startsWith(`${prefix}/`)).map((p) => p.slice(prefix.length + 1));
    const count = runGit(["-C", where.dir, "rev-list", "--count", `${revision}..HEAD`, ...(prefix === "" ? [] : ["--", "."])]);
    const n = count.status === 0 ? parseInt(count.stdout.trim(), 10) : NaN;
    if (Number.isNaN(n)) return failed(`git rev-list failed: ${(count.stderr || "").trim() || `unknown revision "${revision}"`}`);
    return { repo, revision, changedPaths: paths, commitsBehindHead: n, error: null };
  });
}

/** `<repo>:<path>` — how a path is written when several repositories share one list. */
export function qualifyPath(repo: string, path: string): string {
  return `${repo}:${path}`;
}

/** Every changed path of every compared repo, qualified, in repo order. */
export function qualifiedChangedPaths(repos: readonly RepoConformance[]): string[] {
  return repos.flatMap((r) => r.changedPaths.map((p) => qualifyPath(r.repo, p)));
}

/** `facts` with each slice's bound files rewritten as `<repo>:<file>`: the binding's own `repo:`,
 *  else the slice's one repository. A binding that names no repo in a slice whose code is in
 *  several cannot be placed and is left out (`em conform bindings check` reports it). */
export function qualifyBoundFiles(facts: readonly SliceDocFacts[], modelFile: string, repos: BindingRepos): SliceDocFacts[] {
  const modelDir = dirname(modelFile);
  return facts.map((f) => {
    const fallback = repos.defaultRepo(f.key);
    const boundFiles: string[] = [];
    for (const site of boundSitesForSlice(modelDir, f.key)) {
      const repo = site.repo ?? (typeof fallback === "string" ? fallback : null);
      if (repo !== null) boundFiles.push(qualifyPath(repo, site.file));
    }
    return { ...f, boundFiles };
  });
}

/** One repository's entry in `em conform-scope`'s `repos` array. */
export interface RepoScopeJson {
  repo: string;
  revision: string | null;
  /** Plain repo-root-relative paths; `[]` in full mode and when `error` is set. */
  changedPaths: string[];
  unmappedPaths: string[];
  error: string | null;
}


/**
 * `em conform-scope` for code in several repositories: the same document as
 * `buildConformScope`, with every path written `<repo>:<path>`, plus `repos` — one entry per
 * repository in play with its recorded revision, its own changed and unmapped paths, and why it
 * could not be compared when it could not. A repo that cannot be compared never fails the
 * command; its slices are simply not candidates on its account, and `repos` says so.
 */
export function buildConformScopeAcrossRepos(
  facts: readonly SliceDocFacts[],
  lastConformance: LastConformance | null,
  full: boolean,
  plan: Extract<RepoConformancePlan, { mode: "multi" }>,
  modelFile: string,
  runGit: GitRunner = realGit,
): ConformScopeJson & { repos: RepoScopeJson[] } {
  if (full || lastConformance === null) {
    const scope = buildConformScope([...facts], lastConformance, [], true);
    const repos = plan.inPlay.map((repo) => {
      const where = plan.repos.dirOf(repo);
      return {
        repo,
        revision: lastConformance === null ? null : revisionFor(lastConformance.revision, repo),
        changedPaths: [],
        unmappedPaths: [],
        error: "problem" in where ? where.problem : null,
      };
    });
    return { ...scope, repos };
  }
  const compared = compareRepos(plan, lastConformance.revision, runGit);
  const scope = buildConformScope(qualifyBoundFiles(facts, modelFile, plan.repos), lastConformance, qualifiedChangedPaths(compared), false, "", true);
  const unmapped = new Set(scope.unmappedPaths);
  const repos = compared.map((r) => ({
    repo: r.repo,
    revision: r.revision,
    changedPaths: r.changedPaths,
    unmappedPaths: r.changedPaths.filter((p) => unmapped.has(qualifyPath(r.repo, p))),
    error: r.error,
  }));
  return { ...scope, repos };
}
