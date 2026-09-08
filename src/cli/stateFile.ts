// SPDX-License-Identifier: MIT
// Reads and writes the MECHANICAL fields of a model's resumable state file
// (`.event-modeling.md`, see .claude/skills/event-modeling/templates/state.md): `Model file:`,
// `Current phase:`, `Current step:`, `Last updated:`, `Last conformance:`, `Model version:`,
// `Certified:`, `Last stakeholder review:`. This is the ONE parser for those bullets — `em
// changelog` (src/emit/changelog.ts, parseDecisionsLog) parses a disjoint section of the same
// file (the `## Decisions log`) and stays a separate function for that reason, but shares
// STATE_FILE_NAME with this module rather than hard-coding the filename a second time.
//
// Deliberately narrow: judgment content (Session inputs, Participants, Decisions log, Usage
// log, Open questions, Slice inventory) is agent-authored prose and out of scope here — this
// module only ever touches the mechanical bullets above, byte-for-byte leaving every other
// line alone.
//
// MIL-218: `Model version:`/`Certified:` are a POINTER into the `model-versions/*.json`
// manifests (modelVersion.ts) — history lives there, not here. Both are MIGRATION-TOLERANT,
// unlike the other six bullets: a state file predating this feature parses as `modelVersion:
// null`/`certified: null` (the `none`/`never` markers) rather than failing outright — the
// existing "missing bullet is an error" behavior stays exactly as strict as before for every
// OTHER bullet. `setModelVersion`/`setCertified` insert the bullet (right after `Last
// conformance:`, the ruling's own placement) the first time a migrated file is touched, and
// update it in place afterward — the only two writers in this module that ever ADD a line
// rather than only ever replacing one that's already there.
//
// Pure text in, text/data out (parseState, setPhase, setConformance, setModelVersion,
// setCertified, setReview); `loadStateFile` is the one bit of fs I/O, kept here so both `em
// state` (src/cli.ts) and any future caller share the same file-location convention instead of
// re-deriving it.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Filename the skill scaffolds/reads at `<model-dir>/.event-modeling.md`. */
export const STATE_FILE_NAME = ".event-modeling.md";

/** Canonical phase enum — the ONE list `em state set-phase` enforces. Mirrors
 *  templates/state.md's `Current phase:` placeholder list exactly (not SKILL.md's superset,
 *  which also lists `watch` — a live-viewing activity you pass through, never a phase you
 *  leave the model parked at, so it's deliberately not a valid `Current phase:` value). */
export const PHASES = ["discover", "extract", "model", "slice", "implement", "conform", "review", "validate"] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

const LABELS = {
  modelFile: "Model file",
  currentPhase: "Current phase",
  currentStep: "Current step",
  lastUpdated: "Last updated",
  lastConformance: "Last conformance",
  lastStakeholderReview: "Last stakeholder review",
} as const;

/** MIL-218: the two migration-tolerant bullets — see module header. Kept in a separate map
 *  from `LABELS` (rather than folded in) so `parseState`'s missing-bullet loop can treat them
 *  differently: absent is `none`/`never`, never a parse error. */
const OPTIONAL_LABELS = {
  modelVersion: "Model version",
  certified: "Certified",
} as const;

/** The state file's mechanical fields, decoded to plain data. `lastConformance`/`lastReview`
 *  are `null` for the template's `never` marker (never run yet). `modelVersion`/`certified`
 *  (MIL-218) are `null` for their own `none`/`never` markers, INCLUDING when the bullet is
 *  missing entirely from an older state file — see module header. */
export interface ParsedState {
  modelPath: string;
  phase: string;
  step: string;
  lastUpdated: string;
  lastConformance: { date: string; revision: string; report: string; partial: boolean } | null;
  modelVersion: number | null;
  certified: { version: number; revision: string; date: string } | null;
  lastReview: string | null;
}

export type ParseStateResult = { ok: true; state: ParsedState } | { ok: false; message: string };

export type PatchResult = { ok: true; text: string } | { ok: false; message: string };

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bulletLineRegex(label: string): RegExp {
  // `m` (multiline) so `^`/`$` bound one line; `.` already excludes line terminators, so this
  // never reaches across lines regardless of LF/CRLF.
  return new RegExp(`^-\\s+\\*\\*${escapeForRegex(label)}:\\*\\*.*$`, "m");
}

function bulletValue(text: string, label: string): string | null {
  const re = new RegExp(`^-\\s+\\*\\*${escapeForRegex(label)}:\\*\\*\\s*(.*)$`, "m");
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** Resolve what `<dir>` means for every `em state` subcommand: a direct path to the state file
 *  itself (its basename is exactly `.event-modeling.md`) is used as-is; anything else is treated
 *  as the model directory containing it. Lets `em state read .` and
 *  `em state read path/to/.event-modeling.md` both work without a separate flag. */
export function resolveStateFilePath(dirOrFile: string): string {
  return basename(dirOrFile) === STATE_FILE_NAME ? dirOrFile : join(dirOrFile, STATE_FILE_NAME);
}

export type LoadResult = { ok: true; path: string; text: string } | { ok: false; message: string };

/** The one fs read every `em state` subcommand goes through. */
export function loadStateFile(dirOrFile: string): LoadResult {
  const path = resolveStateFilePath(dirOrFile);
  if (!existsSync(path)) {
    return { ok: false, message: `em state: no state file at ${path}` };
  }
  return { ok: true, path, text: readFileSync(path, "utf8") };
}

// MIL-214: the `( (partial)`)?` tail is `--partial`'s marker — see `setConformance` below. The
// report capture stays non-greedy (`.+?`) so the optional suffix, not the report path, absorbs
// a trailing "(partial)" when present.
const LAST_CONFORMANCE_RE = /^(\d{4}-\d{2}-\d{2}) @ (.+?) — report: (.+?)( \(partial\))?$/;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;

// MIL-218: `Model version:` holds a bare positive integer or the literal `none`.
const MODEL_VERSION_RE = /^(\d+)$/;
// MIL-218: `Certified:` holds `v<N> @ <revision> (YYYY-MM-DD)` or the literal `never` — same
// `v<N>` prefix convention lineage refs use elsewhere in em (docs/dsl.md).
const CERTIFIED_RE = /^v(\d+) @ (.+) \((\d{4}-\d{2}-\d{2})\)$/;

/** Parse the mechanical bullets out of a state file's raw text. `ok: false` when the file is
 *  missing one of the six REQUIRED bullet lines entirely, or when `Last conformance:`/`Last
 *  stakeholder review:` holds neither `never` nor its documented format — both are the file
 *  failing to be the thing resume/conform scoping needs, so both are reported the same way.
 *  MIL-218: `Model version:`/`Certified:` are migration-tolerant — see module header — so a
 *  missing bullet there is never added to `missing`; it parses as the `none`/`never` default
 *  instead, same as if the bullet were present and held that literal value. */
export function parseState(text: string): ParseStateResult {
  const missing: string[] = [];
  const raw: Record<string, string> = {};
  for (const label of Object.values(LABELS)) {
    const v = bulletValue(text, label);
    if (v === null) missing.push(label);
    else raw[label] = v;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `missing bullet line(s): ${missing.map((l) => `"- **${l}:**"`).join(", ")}`,
    };
  }
  const optionalRaw: Record<string, string> = {};
  for (const label of Object.values(OPTIONAL_LABELS)) {
    optionalRaw[label] = bulletValue(text, label) ?? (label === OPTIONAL_LABELS.modelVersion ? "none" : "never");
  }

  const modelPath = raw[LABELS.modelFile].replace(/^`|`$/g, "");

  const lastConformanceRaw = raw[LABELS.lastConformance];
  let lastConformance: ParsedState["lastConformance"] = null;
  if (lastConformanceRaw !== "never") {
    const m = LAST_CONFORMANCE_RE.exec(lastConformanceRaw);
    if (!m) {
      return {
        ok: false,
        message: `"- **Last conformance:**" doesn't match "YYYY-MM-DD @ <revision> — report: <path>" or "never": ${lastConformanceRaw}`,
      };
    }
    lastConformance = { date: m[1], revision: m[2], report: m[3], partial: m[4] !== undefined };
  }

  const lastReviewRaw = raw[LABELS.lastStakeholderReview];
  let lastReview: string | null = null;
  if (lastReviewRaw !== "never") {
    const m = LEADING_DATE_RE.exec(lastReviewRaw);
    if (!m) {
      return {
        ok: false,
        message: `"- **Last stakeholder review:**" doesn't start with "YYYY-MM-DD" or "never": ${lastReviewRaw}`,
      };
    }
    lastReview = m[1];
  }

  const modelVersionRaw = optionalRaw[OPTIONAL_LABELS.modelVersion];
  let modelVersion: number | null = null;
  if (modelVersionRaw !== "none") {
    const m = MODEL_VERSION_RE.exec(modelVersionRaw);
    if (!m) {
      return {
        ok: false,
        message: `"- **Model version:**" doesn't match a bare integer or "none": ${modelVersionRaw}`,
      };
    }
    modelVersion = Number(m[1]);
  }

  const certifiedRaw = optionalRaw[OPTIONAL_LABELS.certified];
  let certified: ParsedState["certified"] = null;
  if (certifiedRaw !== "never") {
    const m = CERTIFIED_RE.exec(certifiedRaw);
    if (!m) {
      return {
        ok: false,
        message: `"- **Certified:**" doesn't match "v<N> @ <revision> (YYYY-MM-DD)" or "never": ${certifiedRaw}`,
      };
    }
    certified = { version: Number(m[1]), revision: m[2], date: m[3] };
  }

  return {
    ok: true,
    state: {
      modelPath,
      phase: raw[LABELS.currentPhase],
      step: raw[LABELS.currentStep],
      lastUpdated: raw[LABELS.lastUpdated],
      lastConformance,
      modelVersion,
      certified,
      lastReview,
    },
  };
}

/** A state file is shared by every `.em` file in its directory (`.event-modeling.md` has no
 *  per-model namespacing), but its `Model file:` bullet names exactly ONE of them — so a
 *  sibling file it does NOT describe (the common case: a `conform-scope --seed-asis` scratch
 *  copy like `checkout-asis.em` sitting next to `checkout.em`) must not inherit `checkout.em`'s
 *  conformance record just because it lives in the same directory. Returns the exact non-fatal
 *  message to report when `modelPath` (a parsed state's `modelPath`, already stripped of
 *  backticks) names a different file than `file`'s basename; `null` when they agree. THE one
 *  check both `em status` (`resolveConformanceEntry`, PR #116/MIL-163) and `em conform-scope`
 *  (MIL-179) run before attributing a state file's `Last conformance:` to a given model file. */
export function modelPathMismatch(modelPath: string, file: string): string | null {
  if (!modelPath || modelPath === basename(file)) return null;
  return `state file describes "${modelPath}", not "${basename(file)}" — not attributing its conformance record`;
}

/** Replace one or more bullet lines in place, in the order given, failing (without writing
 *  anything) if any targeted bullet is missing. Every other byte of `text` — including every
 *  other bullet, and whatever line ending style the file already used — passes through the
 *  regex untouched. */
function applyBulletUpdates(text: string, updates: Array<{ label: string; value: string }>): PatchResult {
  let result = text;
  const missing: string[] = [];
  for (const { label, value } of updates) {
    const re = bulletLineRegex(label);
    if (!re.test(result)) {
      missing.push(label);
      continue;
    }
    // Replacer function, not a string pattern — a string replacement would let `$&`/`$'`/`$$`
    // etc. in a user-supplied value (revision, report path, step) expand against the matched
    // line and corrupt the file. A function's return value is inserted literally.
    result = result.replace(re, () => `- **${label}:** ${value}`);
  }
  if (missing.length > 0) {
    return { ok: false, message: `missing bullet line(s): ${missing.map((l) => `"- **${l}:**"`).join(", ")}` };
  }
  return { ok: true, text: result };
}

/** MIL-218: update `label`'s bullet if present, else INSERT it right after `afterLabel`'s own
 *  bullet line — the one-time migration act for a state file predating `Model version:`/
 *  `Certified:` (module header). Matches the line-ending style already in use right after
 *  `afterLabel`'s line (CRLF if that's what follows, else LF) so a migrated file doesn't end up
 *  with mixed endings. `afterLabel` is trusted to already exist (`setModelVersion`/
 *  `setCertified` only ever anchor on `Last conformance:`, one of the six REQUIRED bullets
 *  `loadStateFile`'s caller has already confirmed is present via a successful `parseState`). */
function insertOrUpdateBullet(text: string, label: string, value: string, afterLabel: string): string {
  const re = bulletLineRegex(label);
  if (re.test(text)) {
    return text.replace(re, () => `- **${label}:** ${value}`);
  }
  const afterRe = bulletLineRegex(afterLabel);
  const m = afterRe.exec(text);
  if (!m) return text; // afterLabel missing — shouldn't happen on a real caller's already-parsed text
  const insertPos = m.index + m[0].length;
  const eol = text.slice(insertPos, insertPos + 2) === "\r\n" ? "\r\n" : "\n";
  return `${text.slice(0, insertPos)}${eol}- **${label}:** ${value}${text.slice(insertPos)}`;
}

/** `em state set-phase`: rewrite `Current phase:` (and `Current step:` when `step` is given)
 *  plus `Last updated:`. `phase` is trusted to already be a validated `Phase` — the CLI layer
 *  checks against `PHASES` before calling this so the enum has exactly one home. */
export function setPhase(text: string, phase: Phase, today: string, step?: string): PatchResult {
  const updates: Array<{ label: string; value: string }> = [{ label: LABELS.currentPhase, value: phase }];
  if (step !== undefined) updates.push({ label: LABELS.currentStep, value: step });
  updates.push({ label: LABELS.lastUpdated, value: today });
  return applyBulletUpdates(text, updates);
}

/** `em state set-conformance`: rewrite `Last conformance:` in the EXACT format
 *  reference/conform.md's "keep the format exact" instruction specifies — the next conform
 *  run's scoping (reference/conform.md step 1) parses this line back out — plus `Last
 *  updated:`. `partial` (MIL-214, `--partial`) appends a ` (partial)` suffix — the marker for a
 *  conformance sweep whose findings weren't ALL ruled on before the marker was recorded
 *  (`em state set-conformance`'s own refusal, cli.ts, is what `--partial` escapes) — parsed back
 *  out by `LAST_CONFORMANCE_RE`/`ParsedState.lastConformance.partial` above, and surfaced by
 *  every reader of `Last conformance:` (conform-scope.ts, status.ts, freshnessJson.ts). */
export function setConformance(text: string, revision: string, report: string, today: string, partial = false): PatchResult {
  const value = `${today} @ ${revision} — report: ${report}${partial ? " (partial)" : ""}`;
  return applyBulletUpdates(text, [
    { label: LABELS.lastConformance, value },
    { label: LABELS.lastUpdated, value: today },
  ]);
}

/** `em model version bump` (MIL-218): rewrite `Model version:` (inserting it right after `Last
 *  conformance:` the first time a migrated file is touched — see module header) plus `Last
 *  updated:`. `version` is trusted to already be the freshly-bumped design version — the CLI
 *  layer computes it via `modelVersion.ts`'s `runModelVersionBump` before calling this. */
export function setModelVersion(text: string, version: number, today: string): PatchResult {
  const withVersion = insertOrUpdateBullet(text, OPTIONAL_LABELS.modelVersion, String(version), LABELS.lastConformance);
  return applyBulletUpdates(withVersion, [{ label: LABELS.lastUpdated, value: today }]);
}

/** `em state set-conformance` (non-`--partial`, MIL-218 ruling D): rewrite `Certified:` plus
 *  `Last updated:`. Inserting it for the first time anchors on `Model version:` when that
 *  bullet is already present (the ordinary case — a model version must exist before it can be
 *  certified, `runCertifyModelVersion`'s own refusal), so the canonical bullet order (`Last
 *  conformance`, `Model version`, `Certified`, `Last stakeholder review`) holds regardless of
 *  which of the two migration inserts happens first; falls back to `Last conformance:` only
 *  for the edge case of a state file that somehow carries `Certified:` without `Model
 *  version:` yet. `version`/`revision`/`date` are trusted to already be the just-recorded
 *  certification — the CLI layer computes them via `modelVersion.ts`'s
 *  `runCertifyModelVersion` before calling this. */
export function setCertified(text: string, version: number, revision: string, date: string, today: string): PatchResult {
  const value = `v${version} @ ${revision} (${date})`;
  const anchor = bulletLineRegex(OPTIONAL_LABELS.modelVersion).test(text) ? OPTIONAL_LABELS.modelVersion : LABELS.lastConformance;
  const withCertified = insertOrUpdateBullet(text, OPTIONAL_LABELS.certified, value, anchor);
  return applyBulletUpdates(withCertified, [{ label: LABELS.lastUpdated, value: today }]);
}

/** `em state set-review`: rewrite `Last stakeholder review:` (per templates/state.md's format)
 *  plus `Last updated:`. `date` is trusted to already look like `YYYY-MM-DD` — the CLI layer
 *  validates before calling this. */
export function setReview(text: string, date: string, today: string): PatchResult {
  const value = `${date} — attendees: see Participants`;
  return applyBulletUpdates(text, [
    { label: LABELS.lastStakeholderReview, value },
    { label: LABELS.lastUpdated, value: today },
  ]);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Loose but real validation for a `YYYY-MM-DD` CLI argument: right shape, and month/day in
 *  range — not a full calendar (no leap-year/days-in-month check), which is more rigor than a
 *  state-file marker needs. */
export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
