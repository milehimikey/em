// SPDX-License-Identifier: MIT
// Reads and writes the MECHANICAL fields of a model's resumable state file
// (`.event-modeling.md`, see .claude/skills/event-modeling/templates/state.md): `Model file:`,
// `Current phase:`, `Current step:`, `Last updated:`, `Last conformance:`, `Last stakeholder
// review:`. This is the ONE parser for those bullets — `em changelog` (src/emit/changelog.ts,
// parseDecisionsLog) parses a disjoint section of the same file (the `## Decisions log`) and
// stays a separate function for that reason, but shares STATE_FILE_NAME with this module rather
// than hard-coding the filename a second time.
//
// Deliberately narrow: judgment content (Session inputs, Participants, Decisions log, Usage
// log, Open questions, Slice inventory) is agent-authored prose and out of scope here — this
// module only ever touches the six mechanical bullets above, byte-for-byte leaving every other
// line alone.
//
// Pure text in, text/data out (parseState, setPhase, setConformance, setReview); `loadStateFile`
// is the one bit of fs I/O, kept here so both `em state` (src/cli.ts) and any future caller
// share the same file-location convention instead of re-deriving it.

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

/** The state file's mechanical fields, decoded to plain data. `lastConformance`/`lastReview`
 *  are `null` for the template's `never` marker (never run yet). */
export interface ParsedState {
  modelPath: string;
  phase: string;
  step: string;
  lastUpdated: string;
  lastConformance: { date: string; revision: string; report: string } | null;
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

const LAST_CONFORMANCE_RE = /^(\d{4}-\d{2}-\d{2}) @ (.+?) — report: (.+)$/;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})\b/;

/** Parse the six mechanical bullets out of a state file's raw text. `ok: false` when the file
 *  is missing one of the bullet lines entirely, or when `Last conformance:`/`Last stakeholder
 *  review:` holds neither `never` nor its documented format — both are the file failing to be
 *  the thing resume/conform scoping needs, so both are reported the same way. */
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
    lastConformance = { date: m[1], revision: m[2], report: m[3] };
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

  return {
    ok: true,
    state: {
      modelPath,
      phase: raw[LABELS.currentPhase],
      step: raw[LABELS.currentStep],
      lastUpdated: raw[LABELS.lastUpdated],
      lastConformance,
      lastReview,
    },
  };
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
    result = result.replace(re, `- **${label}:** ${value}`);
  }
  if (missing.length > 0) {
    return { ok: false, message: `missing bullet line(s): ${missing.map((l) => `"- **${l}:**"`).join(", ")}` };
  }
  return { ok: true, text: result };
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
 *  updated:`. */
export function setConformance(text: string, revision: string, report: string, today: string): PatchResult {
  const value = `${today} @ ${revision} — report: ${report}`;
  return applyBulletUpdates(text, [
    { label: LABELS.lastConformance, value },
    { label: LABELS.lastUpdated, value: today },
  ]);
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
