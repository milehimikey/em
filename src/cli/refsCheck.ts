// SPDX-License-Identifier: MIT
// `em refs` (GH #258): are the commits a model's slice docs point at still real, and still on the
// branch the docs live on? `ratifiedRef:` (MIL-284) is `HEAD` of whatever branch `em slice ratify`
// ran on, `shippedRef:` is its copy taken at `mark-implemented`, and a bare `conformedAt:` is the
// target-repo revision a conform sweep diffed against. Under squash or rebase merges every one of
// them can name a commit that exists only on a deleted PR branch — unreachable from the target
// branch, then garbage-collected — while `em validate`, `--slice-ready` and `em ledger` all keep
// passing, because none of them resolves a ref. This command does, once, per field, per doc.
//
// Three outcomes per (doc, field) plus one for "I can't tell":
//   ancestor      — resolves and is reachable from `--reachable-from` (the healthy case)
//   not-ancestor  — resolves (still in the object store) but is NOT reachable: the squash-merge
//                   signature before the orphaned commit is pruned
//   unresolved    — does not resolve at all: pruned, never fetched, or a typo
//   undecidable   — a shallow clone, or git failed in a way that is neither yes nor no; never
//                   reported as a pass (the issue's third acceptance line)
// Opt-in, CI-recipe tier like `em ledger`: it reads git, so it is deliberately not part of
// `em validate` (docs/ci.md). Local object store only — no network. Pure aside from the
// injectable GitRunner and fs reads via readSliceDoc; no process.exit, no console.
//
// Kinded `conformedAt:` values (`build:1234`, GH #261) are not git revisions and are skipped —
// `parseConformedAt` decides. Docs with no ref fields are not reported.
import { existsSync, readFileSync } from "node:fs";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { hasUsableFrontmatter, parseConformedAt } from "../catalog/sliceDoc.js";
import { GitRunner, realGit } from "./diff-inputs.js";

export type RefField = "ratifiedRef" | "shippedRef" | "conformedAt";
export type RefStatus = "ancestor" | "not-ancestor" | "unresolved" | "undecidable";

export interface RefResult {
  sliceKey: string;
  /** The doc the ref was read from, relative to the model directory (`slices/<key>.md`). */
  path: string;
  field: RefField;
  ref: string;
  status: RefStatus;
  /** Why, when `status` is not `ancestor`: git's own words, or the shallow-clone note. */
  detail: string | null;
}

/** Where a waiver came from: the repeatable `--waive <slice-key>` flag, or a line of the
 *  `--waive-file` baseline. A waived result is still fully reported, just not counted toward
 *  the exit code — the `em ledger` convention (MIL-185). */
export type RefWaiveSource = { source: "flag" } | { source: "file"; path: string };

export interface WaivedRefResult extends RefResult {
  waivedBy: RefWaiveSource;
}

/** A waiver naming a slice key with nothing to excuse — surfaced, never swallowed (a typo'd
 *  baseline line would otherwise silently stop meaning anything). */
export interface UnknownRefWaiver {
  sliceKey: string;
  source: RefWaiveSource;
}

export interface RefsCheckResult {
  reachableFrom: string;
  /** The full sha `--reachable-from` resolved to. */
  target: string;
  /** True when the repository is a shallow clone — every result is then `undecidable`. */
  shallow: boolean;
  /** Docs that carried at least one ref field. */
  checkedDocs: number;
  /** Every (doc, field) that was examined, waived or not. */
  checkedRefs: number;
  /** Active results: everything that is not `ancestor` and was not waived. `ancestor` results
   *  are listed too (a CI log should show what WAS verified), so filter on `status` to count. */
  results: RefResult[];
  waived: WaivedRefResult[];
  /** False when any active result is not `ancestor` — `undecidable` included. */
  ok: boolean;
}

export type CheckRefsOutcome = { ok: true; result: RefsCheckResult } | { ok: false; message: string };

function git(run: GitRunner, baseDir: string, args: string[]) {
  return run(["-C", baseDir, ...args]);
}

/** The git-facing half, exposed for tests: classify one ref against an already-resolved target. */
export function classifyRef(run: GitRunner, baseDir: string, ref: string, target: string, shallow: boolean): { status: RefStatus; detail: string | null } {
  if (shallow) {
    return { status: "undecidable", detail: "shallow clone — history is truncated, reachability cannot be decided (checkout with fetch-depth: 0)" };
  }
  const exists = git(run, baseDir, ["cat-file", "-e", `${ref}^{commit}`]);
  if (exists.status !== 0) {
    return { status: "unresolved", detail: "does not resolve to a commit in this repository (pruned after its branch was deleted, never fetched, or mistyped)" };
  }
  const anc = git(run, baseDir, ["merge-base", "--is-ancestor", ref, target]);
  if (anc.status === 0) return { status: "ancestor", detail: null };
  if (anc.status === 1) return { status: "not-ancestor", detail: `resolves but is not an ancestor of ${target.slice(0, 7)} — reachable only from a branch that was squash/rebase-merged and deleted` };
  return { status: "undecidable", detail: `git merge-base failed: ${anc.stderr.trim() || `exit ${anc.status}`}` };
}

// GH #399 (inline ratification): the ratify-then-implement split used to buy "spec frozen before
// code exists" for free, because the two lived in different PRs. Inline mode (one branch, PR
// approval IS the ratification act — docs/process.md's "Inline ratification" section) drops that
// for free property, so the one thing worth checking mechanically is the *retrofit* risk the
// issue names: an agent builds first, then writes the doc to describe what already exists. This
// is that check, in `em refs`' own idiom — three outcomes, real git, nothing enforced.
//
// Deliberately advisory only (R5 of the 1.20.0 slate): commit history is rewritable (a rebase or
// reorder can make any ordering look clean after the fact), so this can at best be a smoke
// signal for the human in the PR review, never a fact `em validate`/`ratify`/`mark-implemented`
// could safely gate on. It never touches `RefsCheckResult.ok` or the CLI exit code — see
// `checkRatificationOrder` below and its lone call site in cli.ts.
export type OrderStatus = "ratified-first" | "code-before-ratification" | "undecidable";

export interface OrderResult {
  sliceKey: string;
  /** Same convention as `RefResult.path`: the doc the ratification was read from. */
  path: string;
  ratifiedRef: string;
  /** The earliest commit found to touch something other than the slice's own doc before
   *  `ratifiedRef`, when `status` is `code-before-ratification`; otherwise `null`. */
  commit: string | null;
  status: OrderStatus;
  detail: string | null;
}

/**
 * Walk from `target`'s merge-base with `ratifiedRef` up to `ratifiedRef` itself, looking for a
 * commit that already touched a path other than `docPath` (the slice's own doc) — evidence that
 * implementation work predates the sign-off it should follow. Commits strictly between the fork
 * point and `ratifiedRef` are "before ratification" by construction (`ratifiedRef` is excluded
 * from that scan and checked separately, below, since a single commit that bundles the doc edit
 * with code has no decidable order *within itself*).
 */
export function classifyRatificationOrder(
  run: GitRunner,
  baseDir: string,
  ratifiedRef: string,
  target: string,
  docPath: string,
  shallow: boolean,
): { status: OrderStatus; commit: string | null; detail: string | null } {
  if (shallow) {
    return { status: "undecidable", commit: null, detail: "shallow clone — history is truncated, order cannot be decided (checkout with fetch-depth: 0)" };
  }
  const resolved = git(run, baseDir, ["cat-file", "-e", `${ratifiedRef}^{commit}`]);
  if (resolved.status !== 0) {
    return { status: "undecidable", commit: null, detail: "ratifiedRef does not resolve to a commit — see the ratifiedRef row above" };
  }
  const touchedFiles = (sha: string): { ok: true; files: string[] } | { ok: false; detail: string } => {
    const diff = git(run, baseDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    if (diff.status !== 0) return { ok: false, detail: `git diff-tree failed on ${sha.slice(0, 7)}: ${diff.stderr.trim() || `exit ${diff.status}`}` };
    return { ok: true, files: diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) };
  };
  const base = git(run, baseDir, ["merge-base", ratifiedRef, target]);
  if (base.status !== 0) {
    return { status: "undecidable", commit: null, detail: `git merge-base failed: ${base.stderr.trim() || `exit ${base.status}`}` };
  }
  const forkPoint = base.stdout.trim();
  if (forkPoint !== ratifiedRef) {
    const list = git(run, baseDir, ["rev-list", `${forkPoint}..${ratifiedRef}`]);
    if (list.status !== 0) {
      return { status: "undecidable", commit: null, detail: `git rev-list failed: ${list.stderr.trim() || `exit ${list.status}`}` };
    }
    // rev-list orders newest first; drop the first entry (ratifiedRef itself, checked separately
    // below) and walk the rest oldest-relevant-first so a reported commit is the earliest offender.
    const before = list.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(1).reverse();
    for (const sha of before) {
      const files = touchedFiles(sha);
      if (!files.ok) return { status: "undecidable", commit: null, detail: files.detail };
      if (files.files.some((f) => f !== docPath)) {
        return {
          status: "code-before-ratification",
          commit: sha,
          detail: `commit ${sha.slice(0, 7)} touched code other than ${docPath} before ${ratifiedRef.slice(0, 7)} was ratified — the doc may describe code that already existed rather than the other way round`,
        };
      }
    }
  }
  // No earlier commit touched anything but the doc. Last check: does the ratification commit
  // itself bundle code alongside the doc edit? That commit has no decidable internal order.
  const own = touchedFiles(ratifiedRef);
  if (!own.ok) return { status: "undecidable", commit: null, detail: own.detail };
  if (own.files.some((f) => f !== docPath)) {
    return {
      status: "undecidable",
      commit: null,
      detail: `${ratifiedRef.slice(0, 7)} (the ratification commit) also touches code other than ${docPath} — a single commit has no decidable order within itself`,
    };
  }
  return { status: "ratified-first", commit: null, detail: null };
}

/**
 * The GH #399 advisory ordering check, in `checkRefs`' own shape: one `OrderResult` per slice
 * doc that carries a `ratifiedRef` (the same docs `checkRefs` already reads), run against the
 * same `baseDir`/`reachableFrom`. Deliberately returns no `ok` field — nothing here is ever a
 * pass/fail gate (R5); the CLI never derives an exit code from this list.
 */
export function checkRatificationOrder(model: NormalizedModel, refs: RefsResult, baseDir: string, target: string, shallow: boolean, run: GitRunner = realGit): OrderResult[] {
  const results: OrderResult[] = [];
  const seen = new Set<string>();
  model.slices.forEach((_slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    if (seen.has(sliceKey)) return;
    seen.add(sliceKey);
    const doc = readSliceDoc(baseDir, sliceKey);
    if (!doc || !hasUsableFrontmatter(doc) || doc.ratifiedRef === null) return;
    const path = `slices/${sliceKey}.md`;
    const { status, commit, detail } = classifyRatificationOrder(run, baseDir, doc.ratifiedRef, target, path, shallow);
    results.push({ sliceKey, path, ratifiedRef: doc.ratifiedRef, commit, status, detail });
  });
  return results;
}

/**
 * Check every recorded ref on every slice doc of `model` against `reachableFrom`. `baseDir` is the
 * `.em` file's directory (the docs' repository is located from it with `-C`, never the process
 * cwd). Returns a message instead of a result when the directory is not in a git work tree or
 * `reachableFrom` itself does not resolve — those are the caller's mistakes, not findings.
 */
export function checkRefs(model: NormalizedModel, refs: RefsResult, baseDir: string, reachableFrom: string, run: GitRunner = realGit): CheckRefsOutcome {
  const inside = git(run, baseDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, message: `${baseDir} is not inside a git work tree — em refs resolves commits, so it needs one` };
  }
  const target = git(run, baseDir, ["rev-parse", "--verify", "--quiet", `${reachableFrom}^{commit}`]);
  if (target.status !== 0 || !/^[0-9a-f]{40,64}$/.test(target.stdout.trim())) {
    return { ok: false, message: `--reachable-from "${reachableFrom}" does not resolve to a commit (fetch it first? \`git fetch origin main\`)` };
  }
  const targetSha = target.stdout.trim();
  const shallowProbe = git(run, baseDir, ["rev-parse", "--is-shallow-repository"]);
  const shallow = shallowProbe.status === 0 && shallowProbe.stdout.trim() === "true";

  const results: RefResult[] = [];
  const seen = new Set<string>();
  let checkedDocs = 0;
  model.slices.forEach((_slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    if (seen.has(sliceKey)) return;
    seen.add(sliceKey);
    const doc = readSliceDoc(baseDir, sliceKey);
    if (!doc || !hasUsableFrontmatter(doc)) return;
    const path = `slices/${sliceKey}.md`;
    const fields: Array<[RefField, string | null]> = [
      ["ratifiedRef", doc.ratifiedRef],
      ["shippedRef", doc.shippedRef],
      ["conformedAt", doc.conformedAt !== null && parseConformedAt(doc.conformedAt).kind === "git" ? doc.conformedAt : null],
    ];
    const present = fields.filter((f): f is [RefField, string] => f[1] !== null);
    if (present.length === 0) return;
    checkedDocs++;
    for (const [field, ref] of present) {
      const { status, detail } = classifyRef(run, baseDir, ref, targetSha, shallow);
      results.push({ sliceKey, path, field, ref, status, detail });
    }
  });

  return {
    ok: true,
    result: {
      reachableFrom,
      target: targetSha,
      shallow,
      checkedDocs,
      checkedRefs: results.length,
      results,
      waived: [],
      ok: results.every((r) => r.status === "ancestor"),
    },
  };
}

/** One slice key per line; blank lines and `#` comments ignored. Missing file → empty list, so a
 *  recipe can reference a baseline before anyone has needed one. */
export function readWaiveFile(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

/** Excuse every non-`ancestor` result on a waived slice key — the exit code ignores them, the
 *  report still shows them under `waived`. `ancestor` results need no excuse and stay put. */
export function applyRefWaivers(
  result: RefsCheckResult,
  flagKeys: string[],
  fileKeys: string[],
  filePath: string | null,
): { result: RefsCheckResult; unknownWaivers: UnknownRefWaiver[] } {
  const excusable = new Set(result.results.filter((r) => r.status !== "ancestor").map((r) => r.sliceKey));
  const waivedKeys = new Map<string, RefWaiveSource>();
  const unknownWaivers: UnknownRefWaiver[] = [];
  const noted = new Set<string>();
  // First mention of a key wins (flags are considered before the file); a key with nothing to
  // excuse is noted once, whichever sources name it.
  const consider = (keys: string[], source: RefWaiveSource) => {
    for (const key of keys) {
      if (waivedKeys.has(key) || noted.has(key)) continue;
      if (excusable.has(key)) waivedKeys.set(key, source);
      else {
        noted.add(key);
        unknownWaivers.push({ sliceKey: key, source });
      }
    }
  };
  consider(flagKeys, { source: "flag" });
  if (filePath !== null) consider(fileKeys, { source: "file", path: filePath });

  const waived: WaivedRefResult[] = [...result.waived];
  const kept: RefResult[] = [];
  for (const r of result.results) {
    const by = waivedKeys.get(r.sliceKey);
    if (by && r.status !== "ancestor") waived.push({ ...r, waivedBy: by });
    else kept.push(r);
  }
  waived.sort((a, b) => a.sliceKey.localeCompare(b.sliceKey) || a.field.localeCompare(b.field));
  return {
    result: { ...result, results: kept, waived, ok: kept.every((r) => r.status === "ancestor") },
    unknownWaivers,
  };
}
