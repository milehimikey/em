// SPDX-License-Identifier: MIT
// `em conform-scope` (MIL-100): mechanizes the mechanical half of reference/conform.md step 1
// ("Scope") — everything that was previously prose telling the agent to shell out to git and
// eyeball `implementedIn:` links by hand.
//
// Three pieces, each reusing an existing module rather than re-deriving it:
//  - `Last conformance:` comes from `stateFile.ts`'s `parseState` (MIL-99) — this module never
//    parses the state file's bullets itself.
//  - Changed paths come from `git diff --name-only <revision>..HEAD` in the target repo, via
//    the same injectable `GitRunner`/`realGit` convention diff-inputs.ts/changelog-git.ts use
//    (so every failure branch — no repo, unknown revision — is unit-testable without a real
//    repository).
//  - A changed path maps to a slice only when its doc's `implementedIn` (from
//    catalog/docJoin.ts's join — the same one `em export`/`em slice index` use, never a second
//    parse) is textually, deterministically a repo-relative path that's a prefix of (or equal
//    to) that changed path. A URL (PR/commit link) carries no path information we can trust, so
//    it deterministically matches nothing. Anything left over is `unmappedPaths` — the agent's
//    judgment queue (grep fallback, evidence walks); this module never guesses.
//
// `--seed-asis` mechanizes the OTHER mechanical convention step 1 describes: seeding
// `<model>-asis.em` as a byte copy of the canonical model, and making sure `*-asis.em` is
// gitignored (idempotent).

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { ParsedState } from "./stateFile.js";

/** The `Last conformance:` shape this module consumes — `stateFile.ts`'s own type, narrowed to
 *  non-null (a `null`/never marker is handled by the caller before this module gets involved). */
export type LastConformance = NonNullable<ParsedState["lastConformance"]>;

/** One slice's doc-derived facts, the narrow slice of `SliceDocExport` (catalog/docJoin.ts)
 *  the scoping logic below actually needs — kept separate from the full export shape so
 *  `buildConformScope` is testable with plain fixtures, no compiled model required. */
export interface SliceDocFacts {
  key: string;
  status: string | null;
  implementedIn: string | null;
}

export interface CandidateSlice {
  key: string;
  matchedBy: "implementedIn" | "full";
  paths: string[];
}

/** The `em conform-scope` JSON document (ticket MIL-100). `lastConformance` echoes what was
 *  parsed from the state file even under `--full` — the caller always knows what was on record,
 *  even when scoping ignored it for this run. */
export interface ConformScopeJson {
  lastConformance: { date: string; revision: string } | null;
  changedPaths: string[];
  candidateSlices: CandidateSlice[];
  unmappedPaths: string[];
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i; // scheme://... (http, https, git, ssh, ...)
const SCP_LIKE = /^[\w.-]+@[\w.-]+:/; // git@host:owner/repo.git style — also carries no path

/** `implementedIn` -> the repo-relative path text worth prefix-matching against changed paths,
 *  or null when it's a URL/SCP-style link (a PR/commit/host reference) that carries no path
 *  information we can trust. Deliberately conservative — see this module's header comment. */
function pathCandidate(implementedIn: string): string | null {
  const trimmed = implementedIn.trim();
  if (!trimmed || URL_LIKE.test(trimmed) || SCP_LIKE.test(trimmed)) return null;
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The changed paths one slice's `implementedIn` textually, deterministically names: equal to
 *  the candidate path, or nested under it (the candidate names a directory). No fuzzy matching,
 *  no grep — that judgment call stays with the agent (reference/conform.md step 1). */
export function matchImplementedInToPaths(implementedIn: string | null, changedPaths: string[]): string[] {
  if (!implementedIn) return [];
  const candidate = pathCandidate(implementedIn);
  if (!candidate) return [];
  return changedPaths.filter((p) => p === candidate || p.startsWith(`${candidate}/`));
}

/**
 * Build the `em conform-scope` JSON body — pure, no fs/git. `full` covers `--full`; a `null`
 * `lastConformance` (the state file's `never` marker, first run) forces the same behavior
 * regardless of `full`, matching reference/conform.md step 1 ("If it's `null` (first run) or
 * the user passes `--full`, scope is every `implemented` slice"). In that mode `changedPaths`
 * is `[]` (documented choice, not omitted — keeps the JSON shape stable across modes) and every
 * `implemented`-status slice is a candidate with `matchedBy: "full"` and empty `paths`.
 */
export function buildConformScope(
  slices: SliceDocFacts[],
  lastConformance: LastConformance | null,
  changedPaths: string[],
  full: boolean,
): ConformScopeJson {
  const lastConformanceOut = lastConformance ? { date: lastConformance.date, revision: lastConformance.revision } : null;

  if (full || lastConformance === null) {
    const candidateSlices: CandidateSlice[] = slices
      .filter((s) => s.status === "implemented")
      .map((s) => ({ key: s.key, matchedBy: "full" as const, paths: [] as string[] }));
    return { lastConformance: lastConformanceOut, changedPaths: [], candidateSlices, unmappedPaths: [] };
  }

  const matched = new Set<string>();
  const candidateSlices: CandidateSlice[] = [];
  for (const s of slices) {
    const paths = matchImplementedInToPaths(s.implementedIn, changedPaths);
    if (paths.length === 0) continue;
    candidateSlices.push({ key: s.key, matchedBy: "implementedIn", paths });
    for (const p of paths) matched.add(p);
  }
  const unmappedPaths = changedPaths.filter((p) => !matched.has(p));
  return { lastConformance: lastConformanceOut, changedPaths, candidateSlices, unmappedPaths };
}

export interface SliceDocFactsResult {
  facts: SliceDocFacts[];
  diagnostics: Diagnostic[];
}

/** Resolve every slice's doc-join facts in declaration order — exactly the two inputs
 *  `buildConformScope` needs (`status`, `implementedIn`), via the same `resolveSliceDocJoin`
 *  call `em export`/`em slice index` make, never a second doc parse. `diagnostics` carries any
 *  `binding-missing-file`/`frontmatter-invalid` warnings, for the caller to print the same way
 *  `em slice index` does. */
export function resolveSliceDocFacts(model: NormalizedModel, refs: RefsResult, baseDir: string): SliceDocFactsResult {
  const diagnostics: Diagnostic[] = [];
  const facts: SliceDocFacts[] = model.slices.map((slice, i) => {
    const key = refs.sliceKeys[i];
    const { doc, diagnostics: docDiags } = resolveSliceDocJoin(slice, key, baseDir, (id) => refs.refById.get(id)!);
    diagnostics.push(...docDiags);
    return { key, status: doc.status, implementedIn: doc.implementedIn };
  });
  return { facts, diagnostics };
}

export type ChangedPathsResult = { ok: true; paths: string[] } | { ok: false; message: string };

/**
 * `git diff --name-only <revision>..HEAD`, run from `repo` (any directory inside the target
 * repo, not necessarily its root — same "anchor dir, resolve toplevel" convention
 * diff-inputs.ts/changelog-git.ts use). Paths come back repo-root-relative — git's own default
 * for `--name-only` without `--relative`.
 */
export function changedPathsSince(repo: string, revision: string, runGit: GitRunner = realGit): ChangedPathsResult {
  const toplevel = runGit(["-C", repo, "rev-parse", "--show-toplevel"]);
  if (toplevel.status !== 0) {
    return { ok: false, message: `em conform-scope: ${repo} is not a git repository` };
  }
  const repoRoot = toplevel.stdout.trim();
  const diff = runGit(["-C", repoRoot, "diff", "--name-only", `${revision}..HEAD`]);
  if (diff.status !== 0) {
    return {
      ok: false,
      message: `em conform-scope: git diff failed: ${(diff.stderr || "").trim() || `unknown revision "${revision}"`}`,
    };
  }
  return {
    ok: true,
    paths: diff.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export interface SeedAsisResult {
  asisPath: string;
  gitignoreUpdated: boolean;
}

const ASIS_GITIGNORE_PATTERN = "*-asis.em";

/**
 * `--seed-asis`: byte-copy `modelFile` to `<dirname(modelFile)>/<stem>-asis.em`, and make sure
 * `*-asis.em` is gitignored. reference/conform.md's Conventions section says to add the pattern
 * to "the repository's `.gitignore`" — read here as the git repo the model itself lives in
 * (resolved the same "anchor dir, `rev-parse --show-toplevel`" way as `changedPathsSince`
 * above, from the model's own directory — a different repo entirely from the `--repo` target
 * codebase conform is checking), so the entry lands once, at that repo's root, covering every
 * model the repo holds. Falls back to a `.gitignore` right next to the model when the model
 * isn't inside a git repo at all. Idempotent: never appends a second `*-asis.em` line if one
 * (exactly, on its own line) is already present anywhere in the file.
 */
export function seedAsisModel(modelFile: string, runGit: GitRunner = realGit): SeedAsisResult {
  const dir = dirname(modelFile);
  const stem = basename(modelFile, extname(modelFile));
  const asisPath = join(dir, `${stem}-asis.em`);
  copyFileSync(modelFile, asisPath);

  const toplevel = runGit(["-C", resolve(dir), "rev-parse", "--show-toplevel"]);
  const gitignoreDir = toplevel.status === 0 ? toplevel.stdout.trim() : dir;
  const gitignorePath = join(gitignoreDir, ".gitignore");

  let gitignoreUpdated = false;
  if (existsSync(gitignorePath)) {
    const text = readFileSync(gitignorePath, "utf8");
    const hasLine = text.split(/\r?\n/).some((l) => l.trim() === ASIS_GITIGNORE_PATTERN);
    if (!hasLine) {
      const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
      writeFileSync(gitignorePath, `${text}${sep}${ASIS_GITIGNORE_PATTERN}\n`);
      gitignoreUpdated = true;
    }
  } else {
    writeFileSync(gitignorePath, `${ASIS_GITIGNORE_PATTERN}\n`);
    gitignoreUpdated = true;
  }

  return { asisPath, gitignoreUpdated };
}
