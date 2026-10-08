// SPDX-License-Identifier: MIT
// `em slice defer` (MIL-275): the missing verb behind docs/process.md's "resolved or explicitly
// deferred". Rewrites ONE unchecked `## Open Questions` item as a checked, dated "deferred to
// v<n>" item, and mirrors it into the model's `.event-modeling.md` (the `## Open questions /
// parking lot` bullet and a dated `## Decisions log` bullet), idempotently. `em slice reratify`
// reads the `deferred to v<n>` marker back and re-opens the item (`reopenDeferred`, below).
//
// Write strategy: surgical line edits (the same discipline as ratify.ts/reratify.ts) — every
// byte outside the edited line / appended bullet, including the file's own EOL style, is copied
// through verbatim. Pure `apply*` functions here; the fs orchestration (`runDefer`) is thin.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { STATE_FILE_NAME } from "./stateFile.js";

const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/i;
const TASK_ITEM = /^([ \t]*[-*]\s*)\[([ xX])\](.*)$/;
const PARKING_LOT_HEADING = /^##\s+Open questions \/ parking lot\s*$/i;
const DECISIONS_HEADING = /^##\s+Decisions log\s*$/;
const ANY_H1_H2 = /^#{1,2}\s/;
const ANY_H2 = /^##\s/;

/** Splits keeping each line's own terminator, so a rewrite never normalizes EOLs. */
function splitKeepEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function stripEol(line: string): { body: string; eol: string } {
  const m = /\r?\n$/.exec(line);
  return m ? { body: line.slice(0, m.index), eol: m[0] } : { body: line, eol: "" };
}

/** `v<int>` → int, else null. */
export function parseUntil(s: string): number | null {
  const m = /^v(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export interface DeferInput {
  question: string;
  until: string;
  decision: string;
  by?: string;
  on: string;
  currentVersion: number;
}

export type ApplyDeferResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; message: string };

function validateInput(i: DeferInput): { ok: false; message: string } | { ok: true; until: number } {
  if (i.question.trim() === "") return { ok: false, message: "a question is required" };
  if (/[\x00-\x1f\x7f]/.test(i.question)) return { ok: false, message: "question must not contain control characters" };
  if (i.decision.trim() === "") return { ok: false, message: 'a decision is required (--decision "<what this version does>")' };
  if (/[\x00-\x1f\x7f]/.test(i.decision)) return { ok: false, message: "decision must not contain control characters" };
  if (i.by !== undefined && (i.by.trim() === "" || /[\x00-\x1f\x7f]/.test(i.by))) {
    return { ok: false, message: "deferrer name must not be empty or contain control characters" };
  }
  const until = parseUntil(i.until);
  if (until === null) return { ok: false, message: `invalid --until "${i.until}" — expected v<n> (for example v2)` };
  if (until <= i.currentVersion) {
    return { ok: false, message: `--until ${i.until} must be greater than the doc's current version v${i.currentVersion}` };
  }
  return { ok: true, until };
}

/**
 * Pure: rewrites the single `- [ ]` item of `## Open Questions` whose text contains
 * `question` (case-sensitive substring) as
 * `- [x] <original> — v<current>: <decision>; deferred to v<n> (<on>[, <by>])`.
 * Already deferred to the same version → `{ok: true, changed: false}` (idempotent no-op).
 */
export function applyDefer(raw: string, input: DeferInput): ApplyDeferResult {
  const v = validateInput(input);
  if (!v.ok) return v;
  const lines = splitKeepEol(raw);
  let start = -1;
  let i = 0;
  // Skip the frontmatter fence so a heading-looking line in it can never match.
  if (/^---[ \t]*\r?\n/.test(raw)) {
    for (i = 1; i < lines.length; i++) if (/^---[ \t]*\r?\n?$/.test(lines[i])) break;
  }
  for (; i < lines.length; i++) {
    if (OPEN_QUESTIONS_HEADING.test(stripEol(lines[i]).body)) {
      start = i;
      break;
    }
  }
  if (start === -1) return { ok: false, message: `no unchecked Open Question matching "${input.question}"` };

  const unchecked: number[] = [];
  const checked: number[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    const body = stripEol(lines[j]).body;
    if (ANY_H1_H2.test(body)) break;
    const m = TASK_ITEM.exec(body);
    if (!m || !m[3].includes(input.question)) continue;
    (m[2] === " " ? unchecked : checked).push(j);
  }
  const itemText = (j: number): string => TASK_ITEM.exec(stripEol(lines[j]).body)![3].trim();

  if (unchecked.length === 0) {
    const sameMarker = new RegExp(`deferred to v${v.until}\\b`);
    if (checked.some((j) => sameMarker.test(itemText(j)))) return { ok: true, content: raw, changed: false };
    if (checked.length > 0) return { ok: false, message: `already checked: ${itemText(checked[0])}` };
    return { ok: false, message: `no unchecked Open Question matching "${input.question}"` };
  }
  if (unchecked.length > 1) {
    return { ok: false, message: `ambiguous — matches: ${unchecked.map(itemText).join(" | ")}` };
  }
  const j = unchecked[0];
  const { body, eol } = stripEol(lines[j]);
  const m = TASK_ITEM.exec(body)!;
  const suffix =
    ` — v${input.currentVersion}: ${input.decision.trim()}; deferred to v${v.until} ` +
    `(${input.on}${input.by !== undefined ? `, ${input.by.trim()}` : ""})`;
  lines[j] = `${m[1]}[x]${m[3].trimEnd()}${suffix}${eol}`;
  return { ok: true, content: lines.join(""), changed: true };
}

/** Appends `bullet` at the end of the section under `heading` (before the next `## ` heading or
 *  EOF, after the section's last non-blank line) unless an identical bullet line exists. */
function appendBullet(
  lines: string[],
  heading: RegExp,
  bullet: string,
  eol: string,
): { lines: string[]; changed: boolean } | null {
  const start = lines.findIndex((l) => heading.test(stripEol(l).body));
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (ANY_H2.test(stripEol(lines[j]).body)) {
      end = j;
      break;
    }
  }
  for (let j = start + 1; j < end; j++) if (stripEol(lines[j]).body.trimEnd() === bullet) return { lines, changed: false };
  let last = end - 1;
  while (last > start && stripEol(lines[last]).body.trim() === "") last--;
  const out = lines.slice();
  if (out[last] !== undefined && !/\n$/.test(out[last])) out[last] = out[last] + eol;
  out.splice(last + 1, 0, bullet + eol);
  return { lines: out, changed: true };
}

export interface StateMirrorInput {
  question: string;
  sliceKey: string;
  until: number;
  decision: string;
  by?: string;
  on: string;
  currentVersion: number;
}

/** Pure: mirrors the deferral into the state file's parking lot and Decisions log. */
export function applyDeferStateFile(raw: string, input: StateMirrorInput): ApplyDeferResult {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const parking = `- ${input.question} (from slice ${input.sliceKey}, deferred to v${input.until})`;
  const decision =
    `- ${input.on}: deferred "${input.question}" on ${input.sliceKey} to v${input.until} — ` +
    `v${input.currentVersion}: ${input.decision.trim()}${input.by !== undefined ? ` — by ${input.by.trim()}` : ""}`;
  let lines = splitKeepEol(raw);
  const a = appendBullet(lines, PARKING_LOT_HEADING, parking, eol);
  if (!a) return { ok: false, message: `${STATE_FILE_NAME} has no "## Open questions / parking lot" heading` };
  lines = a.lines;
  const b = appendBullet(lines, DECISIONS_HEADING, decision, eol);
  if (!b) return { ok: false, message: `${STATE_FILE_NAME} has no "## Decisions log" heading` };
  return { ok: true, content: b.lines.join(""), changed: a.changed || b.changed };
}

/** Pure (reratify): re-opens every `- [x] … — v<old>: …; deferred to v<newVersion> (…)` item under
 *  `## Open Questions` as `- [ ] <original text>`. Items deferred to a later version are untouched. */
export function reopenDeferred(raw: string, newVersion: number): { content: string; count: number } {
  const lines = splitKeepEol(raw);
  const marker = new RegExp(`^(.*?) — v\\d+: .*; deferred to v${newVersion} \\(.*\\)\\s*$`);
  let inSection = false;
  let count = 0;
  for (let j = 0; j < lines.length; j++) {
    const { body, eol } = stripEol(lines[j]);
    if (OPEN_QUESTIONS_HEADING.test(body)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_H1_H2.test(body)) break;
    if (!inSection) continue;
    const m = TASK_ITEM.exec(body);
    if (!m || m[2] === " ") continue;
    const d = marker.exec(m[3]);
    if (!d) continue;
    lines[j] = `${m[1]}[ ]${d[1]}${eol}`;
    count++;
  }
  return { content: lines.join(""), count };
}

export type RunDeferResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; message: string };

/** Resolves `sliceKey` to its bound doc (same join as ratify/reratify), computes both edits, and
 *  writes only when every precondition holds (the state file is required and never created). */
export function runDefer(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  input: Omit<DeferInput, "currentVersion">,
): RunDeferResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  const slice = model.slices[sliceIndex];
  const { doc, continuationOf: continuationOfKey } = resolveSliceDocJoin(
    model,
    refs,
    slice,
    sliceKey,
    baseDir,
    (id) => refs.refById.get(id)!,
  );
  if (continuationOfKey) {
    const continuation = continuationOf(model, refs, sliceIndex)!;
    const viewName = model.byId.get(continuation.viewLogicalId)!.name;
    return {
      ok: false,
      message:
        `"${sliceKey}" is a continuation of "${continuationOfKey}" (view "${viewName}" again) — ` +
        `it has no doc of its own; defer on "${continuationOfKey}" instead`,
    };
  }
  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before deferring a question on it`,
    };
  }
  if (doc.reason === "binding-missing-file") {
    return { ok: false, message: `slice "${sliceKey}" notes "${doc.path}" but no such file exists` };
  }
  if (doc.reason === "frontmatter-invalid" || doc.version === null) {
    return {
      ok: false,
      message: `slice doc "${doc.path}" has missing or invalid frontmatter — run \`em validate\` for details`,
    };
  }
  const full: DeferInput = { ...input, currentVersion: doc.version };
  const absDoc = join(baseDir, doc.path);
  const result = applyDefer(readFileSync(absDoc, "utf8"), full);
  if (!result.ok) return { ok: false, message: `${doc.path}: ${result.message}` };

  const statePath = join(baseDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) {
    return { ok: false, message: `no ${STATE_FILE_NAME} beside the model — defer mirrors into it and never creates it` };
  }
  const until = parseUntil(input.until)!;
  const stateResult = applyDeferStateFile(readFileSync(statePath, "utf8"), {
    question: input.question,
    sliceKey,
    until,
    decision: input.decision,
    by: input.by,
    on: input.on,
    currentVersion: doc.version,
  });
  if (!stateResult.ok) return stateResult;

  if (result.changed) writeFileSync(absDoc, result.content, "utf8");
  if (stateResult.changed) writeFileSync(statePath, stateResult.content, "utf8");
  return { ok: true, path: doc.path, changed: result.changed || stateResult.changed };
}
