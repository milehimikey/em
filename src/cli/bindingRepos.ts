// SPDX-License-Identifier: MIT
// GH #532: decide, for one `em conform bindings check` run, where bound files are looked for.
//
// Two modes, chosen from what the project says, never from a flag:
//  - **Single repository** (the result is a plain directory): no code map beside the model, no
//    bindings file naming a `repo:`, no `--repo <id>=<path>`. Every bound file is looked for under
//    one directory — the bare `--repo <path>`, or the model's own repository when none is given.
//    This is exactly what the command did before, so its output does not change.
//  - **Several repositories** (the result is a `BindingRepos`): each binding is looked for in the
//    checkout of the repo it names, or of the slice's one repository when it names none. Repo ids
//    resolve through the shared resolver (`--repo <id>=<path>`, `.em/repos.local.yaml`, a sibling
//    directory). A bare `--repo <path>` still works when exactly one repo is in play, and names it.
//
// A repo with no checkout here is not an error of the command: it becomes a failed binding with
// that reason, so the report says which bindings could not be verified. em never clones.

import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { loadModelPlaces } from "../codemap/modelPlaces.js";
import { SELF_REPO_ID } from "../system/manifest.js";
import { loadDeclaredRepos } from "../system/systemRepos.js";
import { findRepoRoot, parseRepoArgs, REPOS_LOCAL_FILE, resolveRepos } from "../system/repoResolver.js";
import { BindingRepos, explicitBindingRepos, listBindingsSliceKeys } from "./bindings.js";

/** `inPlay` (several-repositories mode only): every repo id a binding or a place names, in
 *  first-seen order — what `em conform-scope` and `em status` diff, one by one (GH #533). */
export type BindingReposResult = { ok: true; repos: string | BindingRepos; inPlay: string[]; bare: string | null } | { ok: false; message: string };

export function buildBindingRepos(input: {
  modelFile: string;
  model: NormalizedModel;
  refs: RefsResult;
  /** Every `--repo` value, as given. */
  repoValues: readonly string[];
  /** `--slice`, when one was given. */
  sliceKey?: string;
  cwd?: string;
  /** GH #533: repo ids in play beyond those the bindings name — every repo the model's code map
   *  places something in, and every repo a recorded per-repo revision covers. */
  alsoInPlay?: readonly string[];
  /** GH #533: several-repositories mode even when nothing above asks for it (the recorded
   *  revision is per-repo). */
  forceMulti?: boolean;
}): BindingReposResult {
  const modelDir = dirname(input.modelFile);
  const args = parseRepoArgs(input.repoValues);
  if (!args.ok) return { ok: false, message: args.message };

  const sliceKeys = input.sliceKey !== undefined ? [input.sliceKey] : listBindingsSliceKeys(modelDir);
  const places = loadModelPlaces(input.modelFile, input.model, input.refs);
  const explicit = explicitBindingRepos(modelDir, sliceKeys);
  const selfDir = findRepoRoot(modelDir) ?? modelDir;

  if (places.kind !== "ok" && explicit.size === 0 && args.byId.size === 0 && input.forceMulti !== true) {
    return { ok: true, repos: args.bare ?? selfDir, inPlay: [], bare: args.bare };
  }

  /** The repo of a binding that names none: the slice's one repository, or its candidates. */
  const defaultRepo = (sliceKey: string): string | string[] => {
    if (places.kind !== "ok") return SELF_REPO_ID;
    const i = input.refs.sliceKeys.indexOf(sliceKey);
    const repos = i < 0 ? [] : [...new Set(places.bySlice[i].map((p) => p.repo))];
    return repos.length === 1 ? repos[0] : repos.length === 0 ? SELF_REPO_ID : repos;
  };

  const inPlay = new Set<string>(explicit);
  for (const key of sliceKeys) {
    const d = defaultRepo(key);
    if (typeof d === "string") inPlay.add(d);
  }
  for (const id of input.alsoInPlay ?? []) inPlay.add(id);

  let bareFor: string | null = null;
  if (args.bare !== null) {
    if (inPlay.size !== 1) {
      return {
        ok: false,
        message: `--repo ${args.bare}: this model's code is in ${inPlay.size} repositories (${[...inPlay].join(", ")}), so a bare path is ambiguous — write --repo <id>=<path>`,
      };
    }
    bareFor = [...inPlay][0];
  }

  const declared = loadDeclaredRepos(modelDir);
  const remoteOf = new Map(declared.kind === "ok" ? declared.repos.map((r) => [r.id, r.remote] as const) : []);
  const wanted = [...new Set([...inPlay, ...args.byId.keys()])].filter((id) => id !== SELF_REPO_ID);
  const resolved = resolveRepos({
    startDir: modelDir,
    repos: wanted.map((id) => ({ id, remote: remoteOf.get(id) ?? null })),
    flagPaths: args.byId,
    cwd: input.cwd,
  });
  const byId = new Map(resolved.resolutions.map((r) => [r.id, r]));

  return {
    ok: true,
    inPlay: [...inPlay],
    bare: args.bare,
    repos: {
      defaultRepo,
      dirOf(repo: string) {
        if (repo === bareFor) return { dir: args.bare! };
        if (repo === SELF_REPO_ID) return { dir: selfDir };
        const r = byId.get(repo);
        // A directory is enough: this check reads files and never runs git.
        if (r && r.status !== "missing" && r.path !== null) return { dir: r.path };
        const known = remoteOf.has(repo) || args.byId.has(repo);
        const where = r?.path ? ` at ${r.path}` : "";
        return {
          problem: known
            ? `repo "${repo}" has no checkout here${where} — map it with --repo ${repo}=<path> or in ${REPOS_LOCAL_FILE} (\`em repos check\`); em does not clone`
            : `repo "${repo}" is not declared under \`repos:\` in system.yaml`,
        };
      },
    },
  };
}
