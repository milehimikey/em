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

import { dirname } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { resolveSliceKey } from "../model/resolveSlice.js";
import { buildUnitIndex, resolveSelection } from "./engagement.js";
import { checkRosterForWrite, loadRoster } from "../roster/roster.js";
import { rosterContextFor } from "../roster/context.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { isPublicTouchingSlice } from "../catalog/apiFirst.js";
import { runReview } from "./review.js";
import { runRatify } from "./ratify.js";

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
  if (input.storyline !== undefined) {
    const sel = resolveSelection({ file, model, refs, baseDir }, buildUnitIndex(model, refs, baseDir), { kind: "storyline", name: input.storyline });
    if (!sel.ok) return { ok: false, errors: [`${cmd}: ${sel.message}`] };
    if (sel.units.length === 0) return { ok: false, errors: [`${cmd}: --storyline "${input.storyline}" has no slices`] };
    keys.push(...sel.units);
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
  const stderr: string[] = [];
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
  const r = runRatify(model, refs, baseDir, key, by, on, input.skipReview === true, null, undefined, input.noRef === true, dryRun);
  if (!r.ok) return r;
  const stderr: string[] = [];
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
