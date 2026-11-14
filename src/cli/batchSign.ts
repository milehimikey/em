// SPDX-License-Identifier: MIT
// GH #491: batch `em slice review` / `em slice ratify` — several slice keys, or `--storyline <name>`.
//
// A storyline is walked and signed as a unit, but each slice used to take its own command. The
// batch is all-or-nothing: every slice is PLANNED first through the very same `runReview` /
// `runRatify` a single key uses (their `dryRun` mode runs every check and writes nothing), and the
// docs are written only when every slice was accepted. Otherwise nothing is written, every refusal
// is listed on stderr, and the exit code is 1. A slice that would be a no-op (already reviewed /
// ratified by the same name and date) counts as accepted.
//
// A single key without `--storyline` never reaches this module: it keeps today's code path, byte
// for byte (src/cli.ts).
//
// There is no `--json` on either command, so none is added here.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { resolveSliceKey } from "../model/resolveSlice.js";
import { findStoryline, storylineOfSlice } from "../model/storylines.js";
import { continuationOf } from "../model/continuation.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { locateDoc } from "../catalog/docLocate.js";
import { ratifiedHashScope } from "../catalog/sliceDoc.js";
import { checkRosterForWrite, loadRoster } from "../roster/roster.js";
import { rosterContextFor } from "../roster/context.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { isPublicTouchingSlice } from "../catalog/apiFirst.js";
import { runReview } from "./review.js";
import { runRatify } from "./ratify.js";
import { reviewRecordedNotices } from "./policyGlue.js";

export type BatchKind = "review" | "ratify";

export interface BatchInput {
  kind: BatchKind;
  file: string;
  model: NormalizedModel;
  refs: RefsResult;
  diagnostics: Diagnostic[];
  /** Raw `<slice-key>` arguments (never empty when `storyline` is undefined). */
  keys: string[];
  storyline?: string;
  by: string;
  on: string;
  roster?: string;
  again?: boolean;
  allowOpen?: boolean;
  skipReview?: boolean;
  noRef?: boolean;
  /** GH #494: the policy file when `review: pull-request` is in effect (ratify only). */
  reviewByPullRequest?: string | null;
}

/** `ok: false`: `errors` are complete stderr lines (already prefixed); nothing was written. */
export type BatchResult = { ok: true; stdout: string[]; stderr: string[] } | { ok: false; errors: string[] };

type Planned = { key: string; path: string; changed: boolean };

export function runBatch(input: BatchInput): BatchResult {
  const { kind, file, model, refs } = input;
  const cmd = `em slice ${kind}`;
  const baseDir = dirname(file);

  // 1. Which slices.
  const keys: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  if (input.storyline !== undefined) {
    // The storyline's OWN slices. Two kinds are left out with a line saying so, because neither
    // is something this run can sign and refusing the whole storyline for them would make the
    // option useless on a second pass:
    //  - a view shown again here whose doc belongs to a slice of another storyline;
    //  - a slice that has shipped with no next version open (nothing to review or ratify), or,
    //    for a review, one that is already ratified.
    const found = findStoryline(model, input.storyline);
    if (!found) {
      const declared = [...new Set((model.storylines ?? []).map((s) => s.name))];
      return {
        ok: false,
        errors: [
          declared.length === 0
            ? `${cmd}: --storyline "${input.storyline}": no storylines are declared in this model`
            : `${cmd}: --storyline: no storyline "${input.storyline}" (declared: ${declared.map((n) => `"${n}"`).join(", ")})`,
        ],
      };
    }
    const foreign = new Map<string, string>();
    model.slices.forEach((_slice, i) => {
      if (storylineOfSlice(model, i) !== found) return;
      const cont = continuationOf(model, refs, i);
      if (cont === null) {
        if (!keys.includes(refs.sliceKeys[i])) keys.push(refs.sliceKeys[i]);
        return;
      }
      const origin = storylineOfSlice(model, cont.sliceIndex);
      if (origin !== found) foreign.set(cont.sliceKey, origin?.name ?? "no storyline");
    });
    if (foreign.size > 0) {
      skipped.push(
        `not included: ${[...foreign].map(([key, origin]) => `${key} (${origin})`).join(", ")} — this storyline only shows their views again; each doc belongs to the storyline named (sign one by key if its doc changed)`,
      );
    }
    for (const key of [...keys]) {
      const doc = readSliceDoc(baseDir, key);
      const status = doc?.status;
      // A ratified doc whose body moved since sign-off is NOT skipped on ratify: it has to refuse.
      const located = locateDoc(baseDir, `slices/${key}.md`);
      const intact = doc?.ratifiedHash != null && located !== null && ratifiedHashScope(readFileSync(located, "utf8"), doc.ratifiedHash) !== "mismatch";
      const why =
        status === "implemented"
          ? "shipped, no next version open"
          : status === "ready-to-implement" && (kind === "review" || intact)
            ? "already ratified"
            : null;
      if (why === null) continue;
      keys.splice(keys.indexOf(key), 1);
      skipped.push(`not included: ${key} — ${why}`);
    }
    if (keys.length === 0) {
      return { ok: false, errors: [...skipped.map((l) => `${cmd}: ${l}`), `${cmd}: --storyline "${input.storyline}" has no slice to ${kind}`] };
    }
  } else {
    for (const raw of input.keys) {
      const r = resolveSliceKey(model, refs, raw);
      if (!r.ok) errors.push(`${cmd}: ${r.message}`);
      else if (!keys.includes(r.key)) keys.push(r.key);
    }
  }

  // 2. Plan every slice (no writes).
  const roster = loadRoster(baseDir, input.roster, rosterContextFor(model, file));
  const modelKey = computeModelKey(model, file);
  const planned: Planned[] = [];
  for (const key of keys) {
    const refuse = (message: string) => errors.push(`${cmd}: ${key}: ${message}`);
    const scoped = input.diagnostics.filter((d) => d.severity === "error" && d.refs?.some((r) => r === key || r.startsWith(`${key}/`)));
    if (scoped.length > 0) {
      refuse(`slice "${key}" has errors — fix them first`);
      continue;
    }
    const rosterRefused = checkRosterForWrite(roster, kind === "review" ? "reviewers" : "ratifiers", input.by, model, refs.sliceKeys.indexOf(key), modelKey);
    if (rosterRefused !== null) {
      refuse(rosterRefused);
      continue;
    }
    if (kind === "ratify" && isPublicTouchingSlice(model, refs, key)) {
      refuse(
        `slice "${key}" touches a public element — a public-touching slice is not ratified in a batch; ratify it singly ` +
          `(\`em slice ratify <file> ${key} --by <name> --meaning-unchanged\` or \`--contract-change "<why>"\`)`,
      );
      continue;
    }
    const r = runOne(input, key, true);
    if (!r.ok) refuse(r.message);
    else planned.push({ key, path: r.path, changed: r.changed });
  }
  if (errors.length > 0) {
    errors.push(`${cmd}: batch refused — ${errors.length} refusal(s); nothing was written`);
    return { ok: false, errors };
  }

  // 3. Write — once per distinct doc (a `covers:` cross-binding can put two keys on one doc).
  const stdout: string[] = [];
  const stderr: string[] = skipped.map((l) => `${cmd}: ${l}`);
  const writtenBy = new Map<string, string>();
  for (const p of planned) {
    const first = writtenBy.get(p.path);
    if (first !== undefined) {
      stdout.push(`same doc as "${first}" (written once): ${p.path}`);
      continue;
    }
    writtenBy.set(p.path, p.key);
    const r = runOne(input, p.key, false);
    if (!r.ok) return { ok: false, errors: [`${cmd}: ${p.key}: ${r.message}`] };
    stdout.push(...r.stdout);
    stderr.push(...r.stderr);
  }
  return { ok: true, stdout, stderr };
}

type One = { ok: true; path: string; changed: boolean; stdout: string[]; stderr: string[] } | { ok: false; message: string };

/** One slice through the single-key function; the lines mirror `em slice review|ratify <key>`. */
function runOne(input: BatchInput, key: string, dryRun: boolean): One {
  const { model, refs, file, by, on } = input;
  const baseDir = dirname(file);
  if (input.kind === "review") {
    const r = runReview(model, refs, baseDir, key, by, on, { again: input.again === true, allowOpen: input.allowOpen === true, dryRun });
    if (!r.ok) return r;
    const stderr = r.allowedOpen !== undefined ? [`notice: --allow-open — reviewing "${key}" with ${r.allowedOpen} unchecked Open Questions item(s)`] : [];
    const line = r.changed
      ? r.previous
        ? `re-reviewed: ${r.path} (reviewedBy: ${r.previous.by} -> ${by}, reviewedOn: ${r.previous.on} -> ${on})`
        : `reviewed: ${r.path} (reviewedBy: ${by}, reviewedOn: ${on})`
      : `already reviewed (no-op): ${r.path}`;
    return { ok: true, path: r.path, changed: r.changed, stdout: [line], stderr };
  }
  const prSource = input.reviewByPullRequest ?? null;
  const reviewByPr = prSource === null ? null : { checkReviewer: () => checkRosterForWrite(loadRoster(baseDir, input.roster, rosterContextFor(model, file)), "reviewers", by, model, refs.sliceKeys.indexOf(key), computeModelKey(model, file)) };
  const r = runRatify(model, refs, baseDir, key, by, on, input.skipReview === true, null, undefined, input.noRef === true, dryRun, reviewByPr);
  if (!r.ok) return r;
  const stderr: string[] = [];
  if (r.reviewRecorded && prSource !== null) stderr.push(...reviewRecordedNotices(prSource, key, input.skipReview === true));
  if (r.skippedReviewFrom !== null) {
    stderr.push(`notice: --skip-review — ratifying "${key}" without a recorded review (status was ${r.skippedReviewFrom})`);
  }
  for (const up of r.upstreamWarnings) {
    stderr.push(`warn: ratifying "${key}" ahead of upstream slice "${up.sliceKey}" (status: ${up.status})`);
  }
  const line = r.changed
    ? `ratified: ${r.path} (ratifiedBy: ${by}, ratifiedOn: ${on})` + (input.noRef === true ? " — ratifiedHash only, no ratifiedRef (--no-ref)" : "")
    : `already ratified (no-op): ${r.path}`;
  return { ok: true, path: r.path, changed: r.changed, stdout: [line], stderr };
}
