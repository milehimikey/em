// SPDX-License-Identifier: MIT
// GH #534: a conformance revision for code that lives in more than one repository.
//
// Everywhere em records "the revision the code was checked at" — the state file's
// `Last conformance:` and `Certified:`, a slice doc's `conformedAt:`, a findings file's
// `revision`, a conformance report's `Target repo: … @ <rev>` — the value has been one git
// revision of the one target repository. When a model's code spans repositories it becomes one
// revision PER repository, written in the same slot as a single token:
//
//     checkout-svc=4f2a9c1,storefront-web=b81d0e7
//
// `<repo id>=<revision>` pairs, comma-separated, no spaces, sorted by repo id. A plain revision
// (no `=`) is unchanged and still means "the model's one code repository".
//
// It is one opaque string on purpose. Every place that stores a revision, and every place that
// matches two of them (the findings gate pairs a report with the findings "at the same
// revision"), keeps working without knowing the form: the canonical order makes equal sets
// equal strings. Only a reader that hands the revision to git has to take it apart, and it does
// so here.
//
// A slice doc's `shippedRef:` and `ratifiedRef:` are NOT this: they are commits of the model's
// own repository (what the design looked like when it was signed and shipped), and stay single.

import { isRepoId } from "../system/manifest.js";

export interface RepoRevision {
  repo: string;
  revision: string;
}

export type ParsedRevision =
  /** One revision of the model's one code repository — every value written before 1.24.0. */
  | { kind: "single"; revision: string }
  /** One revision per repository, sorted by repo id. */
  | { kind: "per-repo"; revisions: RepoRevision[] };

/** The canonical spelling of a per-repo revision: pairs sorted by repo id, comma-separated. */
export function formatRepoRevisions(revisions: readonly RepoRevision[]): string {
  return [...revisions]
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((r) => `${r.repo}=${r.revision}`)
    .join(",");
}

/** Read a stored revision. Never fails: a value that is not a well-formed per-repo list is a
 *  single revision, exactly as it always was (so `build:1234` and odd refnames pass through). */
export function parseRevision(value: string): ParsedRevision {
  const trimmed = value.trim();
  if (!trimmed.includes("=") || /^[a-z][a-z0-9-]*:/.test(trimmed)) return { kind: "single", revision: trimmed };
  const revisions: RepoRevision[] = [];
  for (const part of trimmed.split(",")) {
    const eq = part.indexOf("=");
    const repo = eq > 0 ? part.slice(0, eq) : "";
    const revision = eq > 0 ? part.slice(eq + 1) : "";
    if (!isRepoId(repo) || revision === "" || /[\s=,]/.test(revision) || revisions.some((r) => r.repo === repo)) {
      return { kind: "single", revision: trimmed };
    }
    revisions.push({ repo, revision });
  }
  return { kind: "per-repo", revisions };
}

/** The revision recorded for `repo`, or `null` when a per-repo value does not cover it. A single
 *  revision is the revision of whichever repository is asked for: there was only one. */
export function revisionFor(value: string, repo: string): string | null {
  const parsed = parseRevision(value);
  if (parsed.kind === "single") return parsed.revision;
  return parsed.revisions.find((r) => r.repo === repo)?.revision ?? null;
}

/**
 * Check a revision a person or an agent is about to record (`em state set-conformance`,
 * `em slice conform --at`, `em conform-supersede --as-of`). A plain revision passes untouched. A
 * value with `=` must be a well-formed per-repo list in canonical order — otherwise two files
 * written in one conformance run could spell the same revisions differently and stop matching.
 * The message carries the canonical spelling when one can be worked out.
 */
export function checkRevisionArg(value: string, flag: string): { ok: true } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed.includes("=")) return { ok: true };
  // GH #261: `<kind>:<id>` (`build:run=42`, a CI URL with a query string) is an opaque
  // identifier, not a revision list — its id may contain anything, `=` included.
  if (/^[a-z][a-z0-9-]*:/.test(trimmed)) return { ok: true };
  const parsed = parseRevision(trimmed);
  if (parsed.kind === "single") {
    return {
      ok: false,
      message: `${flag} "${trimmed}" is not a per-repo revision — write <repo id>=<revision> pairs, comma-separated, no spaces, each repo once (e.g. checkout-svc=4f2a9c1,storefront-web=b81d0e7)`,
    };
  }
  const canonical = formatRepoRevisions(parsed.revisions);
  if (canonical !== trimmed) {
    return { ok: false, message: `${flag}: write the repos in id order so every file of this run records the same string — ${canonical}` };
  }
  return { ok: true };
}
