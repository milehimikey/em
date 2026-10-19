// SPDX-License-Identifier: MIT
// `em slice defer` (MIL-275): the missing verb behind docs/process.md's "resolved or explicitly
// deferred". Rewrites ONE unchecked `## Open Questions` item as a checked, dated "deferred to
// v<n>" item, and mirrors it into the model's `.event-modeling.md` (the `## Open questions /
// parking lot` bullet and a dated `## Decisions log` bullet), idempotently. `em slice revise`
// (and `mark-implemented`'s auto-open, MIL-283) reads the `deferred to v<n>` marker back and re-opens the item (`reopenDeferred`, below).
//
// Write strategy: surgical line edits (the same discipline as ratify.ts/revise.ts) — every
// byte outside the edited line / appended bullet, including the file's own EOL style, is copied
// through verbatim. Pure `apply*` functions here; the fs orchestration (`runDefer`) is thin.
//
// MIL-281 — `--from-issue`: the question a review session actually produces is an `issue "..."`
// clause in the `.em` (what the walkthrough captures live, what `em validate --list-issues`
// lists), not an item under the doc's `## Open Questions`; defer could only see the latter, so a
// room-raised question took a hand edit of the doc before it could be deferred. `--from-issue
// <text>` promotes the single matching open issue on the slice's own elements into the doc as an
// already-deferred `[x]` item, mirrors it into the state file exactly like the positional path,
// and REMOVES the `issue` clause from the `.em` — the deferral record replaces the red note, so
// the diagram stops flagging a question the doc now tracks with a return path. Three files, all
// computed before any is written; the `.em` edit is a single clause span (or the whole line when
// the clause was alone on it), re-parsed before it is accepted. Not a generic "move issue to doc"
// verb: the only thing a promoted issue can become is a deferred question.
//
// GH #253 — a RATIFIED or SHIPPED doc (`status: ready-to-implement` + `ratifiedBy:`, or
// `status: implemented`) takes the deferral in its body too. Its body is the signed spec, but
// `ratifiedHash` is computed over `ratifiedBody()` (catalog/sliceDoc.ts), which leaves out the
// `## Open Questions` heading and every `deferred to v<n>` item — a deferral describes a later
// version, not the one that was signed. So on a signed doc both paths APPEND the already-deferred
// `- [x]` item (the shape `--from-issue` always wrote) and the hash does not move; `--slice-ready`
// and `ratify`'s re-run keep passing. Before writing, `finishSignedDocEdit` re-stamps a hash still
// in the pre-1.17 whole-body scope (the body is intact, only the stamp is old) and refuses, with
// nothing written, if the edit would somehow leave the hash unmatched.
//
// GH #236's state-file QUEUE (1.16.x) is write-retired by this: `revise`/`mark-implemented` still
// inject any leftover queued bullets into the v<N+1> draft they open (`injectQueuedQuestions`)
// and `drainQueueInState` turns them back into ordinary deferral mirrors; `em upgrade`'s
// `ratified-hash-scope` step moves leftovers into their docs. `draft`/`reviewed` docs behave
// exactly as before: the positional form rewrites an existing `- [ ]` item, never appends.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { decodeQuoted, matchQuote } from "../parser/lexer.js";
import { compile } from "../pipeline.js";
import { STATE_FILE_NAME } from "./stateFile.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue, replaceFieldValue } from "./frontmatterSurgery.js";
import { QueuedItem, parseQueuedBullet, queuedItems } from "../catalog/deferQueue.js";
import { ratifiedHashScope, sliceDocBodyHash } from "../catalog/sliceDoc.js";

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
  | { ok: true; content: string; changed: boolean; matched?: string }
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
    const done = checked.find((j) => sameMarker.test(itemText(j)));
    if (done !== undefined) return { ok: true, content: raw, changed: false, matched: questionLabel(itemText(done)) || undefined };
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
  const matched = questionLabel(m[3]) || undefined;
  lines[j] = `${m[1]}[x]${m[3].trimEnd()}${suffix}${eol}`;
  return { ok: true, content: lines.join(""), changed: true, matched };
}

/**
 * Pure (GH #283): the state-file label of an Open Question item's text - the bold title when it
 * opens with `**Title**`, else the whole item line, with any `- v<n>: ...; deferred to v<m> (...)`
 * suffix of an already-deferred item dropped. `applyDefer` returns it for the item it matched.
 */
export function stripDeferral(itemText: string): string {
  return /^(.*?) — v\d+: .*; deferred to v\d+ \(.*\)$/.exec(itemText.trim())?.[1] ?? itemText.trim();
}

export function questionLabel(itemText: string): string {
  const original = stripDeferral(itemText);
  const bold = /^\*\*(.+?)\*\*/.exec(original);
  return (bold ? bold[1] : original).trim();
}

/** Appends `bullet` at the end of the section under `heading` (before the next `## ` heading or
 *  EOF, after the section's last non-blank line) unless an identical bullet line exists. */
export function appendBullet(
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
  // An empty section (nothing but the heading) keeps a blank line between heading and first
  // item — the shape the slice-doc template and every hand-written section use.
  out.splice(last + 1, 0, ...(last === start ? [eol, bullet + eol] : [bullet + eol]));
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

/** The `## Open Questions` items of a doc: each `- [ ]`/`- [x]` line's text. Pure. */
export function openQuestionItems(raw: string): string[] {
  const lines = splitKeepEol(raw);
  const out: string[] = [];
  let inSection = false;
  for (const l of lines) {
    const body = stripEol(l).body;
    if (OPEN_QUESTIONS_HEADING.test(body)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_H1_H2.test(body)) break;
    if (!inSection) continue;
    const m = TASK_ITEM.exec(body);
    if (m) out.push(m[3].trim());
  }
  return out;
}

const PARKING_BULLET = /^- (.+) \(from slice ([^\s,]+), deferred to v(\d+)\)\s*$/;

export interface ParkingLotRewrite {
  sliceKey: string;
  from: string;
  to: string;
}

/**
 * Pure (GH #290): the pre-#305 parking-lot shape wrote the user's SUBSTRING (`retry`) into
 * `.event-modeling.md`; `applyDeferStateFile` now writes the matched item's label
 * (`questionLabel`). Rewrites each `- <fragment> (from slice <key>, deferred to v<n>)` bullet
 * whose `<fragment>` is a strict substring of exactly one of the slice's Open Questions items
 * (matched with the same case-sensitive substring rule `applyDefer` uses) to that item's label.
 * A bullet already equal to an item or its label, with no matching item, or matching more than one
 * item, is left alone. `docs` maps slice key -> doc text.
 */
export function rewriteParkingLotFragments(
  stateRaw: string,
  docs: Map<string, string>,
): { content: string; rewrites: ParkingLotRewrite[] } {
  const lines = splitKeepEol(stateRaw);
  const rewrites: ParkingLotRewrite[] = [];
  let inSection = false;
  for (let j = 0; j < lines.length; j++) {
    const { body, eol } = stripEol(lines[j]);
    if (PARKING_LOT_HEADING.test(body)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_H2.test(body)) inSection = false;
    if (!inSection) continue;
    const m = PARKING_BULLET.exec(body);
    if (!m) continue;
    const [, text, sliceKey, until] = m;
    const doc = docs.get(sliceKey);
    if (doc === undefined) continue;
    const items = openQuestionItems(doc);
    if (items.some((it) => it === text || questionLabel(it) === text)) continue;
    // The fragment is matched against the item text WITHOUT its deferral annotation (an answer or
    // a ratifier name must not match), and must hit exactly ONE item.
    const hits = items.filter((it) => stripDeferral(it).includes(text));
    if (hits.length !== 1) continue;
    const to = questionLabel(hits[0]);
    if (to === "" || to === text) continue;
    lines[j] = `- ${to} (from slice ${sliceKey}, deferred to v${until})${eol}`;
    rewrites.push({ sliceKey, from: text, to });
  }
  return { content: lines.join(""), rewrites };
}

/** Pure (revise): re-opens every `- [x] … — v<old>: …; deferred to v<newVersion> (…)` item under
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

// ---- GH #253: a signed (ratified / shipped) doc -------------------------------------------

/** True when the doc's body is a signed spec: `status: implemented`, or `status:
 *  ready-to-implement` with a `ratifiedBy:`. On such a doc the positional form appends the
 *  deferred item instead of requiring an existing `- [ ]` (a ratified doc has none — readiness
 *  required that), and the write goes through `finishSignedDocEdit`. A `draft`/`reviewed` doc —
 *  including the next version of a shipped slice — is still being written, so defer edits it as
 *  ever. */
export function isSignedDoc(raw: string): boolean {
  const range = locateFrontmatterInner(raw);
  if (!range) return false;
  const inner = raw.slice(range.innerStart, range.innerEnd);
  const statusMatch = fieldLineRegex("status").exec(inner);
  const status = statusMatch ? normalizeFieldValue(statusMatch[2])?.toLowerCase() : null;
  if (status === "implemented") return true;
  if (status !== "ready-to-implement") return false;
  const by = fieldLineRegex("ratifiedBy").exec(inner);
  return by !== null && normalizeFieldValue(by[2]) !== null;
}

/** The `ratifiedHash:` a doc records, or null when it has none (ratified before 1.15, or never). */
function recordedHash(raw: string): string | null {
  const range = locateFrontmatterInner(raw);
  if (!range) return null;
  const m = fieldLineRegex("ratifiedHash").exec(raw.slice(range.innerStart, range.innerEnd));
  return m ? normalizeFieldValue(m[2]) : null;
}

export type SignedEditResult = { ok: true; content: string; restamped: boolean } | { ok: false; message: string };

/**
 * Pure (GH #253): the last step of any defer that edits a signed doc. `before` is the doc as
 * read, `after` the doc with the deferral written. Refuses when `before` already fails its own
 * `ratifiedHash` (the body moved after sign-off — defer is not the command that papers over
 * that), re-stamps a hash still in the pre-1.17 whole-body scope to the current scope (same
 * body, new normalisation — not a re-signing), and finally checks that `after` matches the
 * recorded hash in the current scope, refusing with nothing written if it does not: the one
 * invariant this whole design rests on is that a deferral never moves the hash.
 */
export function finishSignedDocEdit(before: string, after: string): SignedEditResult {
  const recorded = recordedHash(before);
  if (recorded === null) return { ok: true, content: after, restamped: false };
  const scope = ratifiedHashScope(before, recorded);
  if (scope === "mismatch") {
    return {
      ok: false,
      message: "body no longer matches ratifiedHash (edited after ratification) — revert that edit, or `em slice revise` and re-ratify, before deferring",
    };
  }
  let content = after;
  let restamped = false;
  if (scope === "legacy") {
    const next = replaceFieldValue(after, "ratifiedHash", sliceDocBodyHash(before));
    if (next === null) return { ok: false, message: "could not locate ratifiedHash: in the frontmatter" };
    content = next;
    restamped = true;
  }
  const check = recordedHash(content);
  if (check === null || ratifiedHashScope(content, check) !== "current") {
    return { ok: false, message: "the deferral would leave the body unmatched by ratifiedHash — nothing written (this is a bug in em; please report it)" };
  }
  return { ok: true, content, restamped };
}

// ---- GH #236's 1.16 queue: the read side, kept so leftover state-file bullets still drain -----

/** Pure: the Open Questions line a queued item becomes in the v<target> draft. Aimed at the
 *  draft's own version it is an unchecked `- [ ]` carrying its decision; aimed further out
 *  (`--until` beyond it) it is the ordinary checked deferral, so the draft is not asked to
 *  answer what the room already pushed past it. */
function injectedLine(item: QueuedItem): string {
  const prior = item.targetVersion - 1;
  const who = `${item.on}${item.by !== undefined ? `, ${item.by}` : ""}`;
  return item.until > item.targetVersion
    ? `- [x] ${item.question} — v${prior}: ${item.decision}; deferred to v${item.until} (${who})`
    : `- [ ] ${item.question} — v${prior}: ${item.decision} (queued ${who})`;
}

/** Pure (revise / mark-implemented): appends every queued item to `## Open Questions` of the
 *  freshly opened draft (creating the section at EOF when the doc has none), skipping a line
 *  already present. Returns how many items were written. */
export function injectQueuedQuestions(raw: string, items: QueuedItem[]): { content: string; count: number } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let content = raw;
  let count = 0;
  for (const item of items) {
    const bullet = injectedLine(item);
    const appended = appendBullet(splitKeepEol(content), OPEN_QUESTIONS_HEADING, bullet, eol);
    if (appended) {
      if (appended.changed) count++;
      content = appended.lines.join("");
      continue;
    }
    if (content.length > 0 && !/\r?\n$/.test(content)) content += eol;
    if (content.length > 0 && !/(\r?\n){2}$/.test(content)) content += eol;
    content += `## Open Questions${eol}${eol}${bullet}${eol}`;
    count++;
  }
  return { content, count };
}

/** Pure: "clears" the queue for `<sliceKey>@v<targetVersion>` in the state file — each queued
 *  parking-lot bullet becomes the ordinary `- <q> (from slice <key>, deferred to v<until>)`
 *  mirror a draft-doc defer writes. Other slices' and other versions' bullets are untouched. */
export function drainQueueInState(raw: string, sliceKey: string, targetVersion: number): { content: string; count: number } {
  const lines = splitKeepEol(raw);
  let count = 0;
  for (let j = 0; j < lines.length; j++) {
    const { body, eol } = stripEol(lines[j]);
    const item = parseQueuedBullet(body);
    if (!item || item.sliceKey !== sliceKey || item.targetVersion !== targetVersion) continue;
    lines[j] = `- ${item.question} (from slice ${item.sliceKey}, deferred to v${item.until})${eol}`;
    count++;
  }
  return { content: lines.join(""), count };
}

/** Reads the queue for `<sliceKey>@v<targetVersion>` from `<baseDir>/.event-modeling.md`; empty
 *  when the file is absent. */
export function readQueue(baseDir: string, sliceKey: string, targetVersion: number): { items: QueuedItem[]; statePath: string; stateRaw: string | null } {
  const statePath = join(baseDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) return { items: [], statePath, stateRaw: null };
  const stateRaw = readFileSync(statePath, "utf8");
  return { items: queuedItems(stateRaw, sliceKey, targetVersion), statePath, stateRaw };
}

/** Writes the drained state file once the draft carrying the queue is on disk. */
export function clearQueue(baseDir: string, sliceKey: string, targetVersion: number): void {
  const { stateRaw, statePath } = readQueue(baseDir, sliceKey, targetVersion);
  if (stateRaw === null) return;
  const drained = drainQueueInState(stateRaw, sliceKey, targetVersion);
  if (drained.count > 0) writeFileSync(statePath, drained.content, "utf8");
}

// ---- MIL-281: --from-issue ----------------------------------------------------------------

/** An open `issue "..."` clause on one of the slice's own elements. */
export interface IssueCandidate {
  kind: string;
  name: string;
  /** The element's declaration line in the `.em` (1-based) — where the clause search starts. */
  line: number;
  issue: string;
}

/** Open issues on the slice's own elements whose text contains `text` (case-sensitive substring,
 *  the same matching the positional path applies to Open Questions). An issue on a sibling
 *  slice's element is never a candidate — the deferral lands on THIS slice's doc. */
export function findIssueCandidates(model: NormalizedModel, sliceIndex: number, text: string): IssueCandidate[] {
  return model.elements
    .filter((el) => el.sliceIndex === sliceIndex && el.issue !== undefined && el.issue.includes(text))
    .map((el) => ({ kind: el.kind, name: el.name, line: el.line, issue: el.issue! }));
}

export function formatIssueCandidate(c: IssueCandidate): string {
  return `${c.kind} "${c.name}" :${c.line} issue "${c.issue}"`;
}

export type RemoveIssueResult =
  | { ok: true; content: string; removedLine: number }
  | { ok: false; message: string };

/**
 * Pure: removes the one `issue "<issueText>"` clause that belongs to the element declared at
 * `startLine` (1-based). The clause may sit on the declaration line or trail the element's
 * `{ … }` field block (parser.ts's `extractClauses` accepts both), so the scan runs forward from
 * `startLine` and stops at the first line carrying an `issue` clause that decodes to
 * `issueText`. The clause span (plus the one whitespace run before it) is cut out of that line;
 * when nothing but whitespace is left, the whole line goes, EOL included. Everything else —
 * other clauses on the line, every other line, the file's EOL style — is copied through
 * verbatim. The caller re-parses the result before accepting it (`runDeferFromIssue`).
 */
export function removeIssueClause(raw: string, startLine: number, issueText: string): RemoveIssueResult {
  const lines = splitKeepEol(raw);
  const keyword = /(?:^|\s)issue\s+(?=")/gi;
  for (let j = Math.max(0, startLine - 1); j < lines.length; j++) {
    const { body, eol } = stripEol(lines[j]);
    keyword.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = keyword.exec(body)) !== null) {
      const openIdx = m.index + m[0].length;
      const closeIdx = matchQuote(body, openIdx);
      if (closeIdx < 0) break; // unterminated — the parser already refused this file
      if (decodeQuoted(body.slice(openIdx + 1, closeIdx)) !== issueText) continue;
      const before = body.slice(0, m.index);
      const after = body.slice(closeIdx + 1);
      const rest = (before + after).replace(/[ \t]+$/, "");
      const out = lines.slice();
      if (rest.trim() === "") out.splice(j, 1);
      else out[j] = rest + eol;
      return { ok: true, content: out.join(""), removedLine: j + 1 };
    }
  }
  return { ok: false, message: `no \`issue "${issueText}"\` clause found at or after line ${startLine}` };
}

/**
 * Pure: records `issueText` on the doc as an already-deferred Open Question. If an unchecked
 * item containing the text already exists (someone wrote it down by hand), that item is deferred
 * in place via `applyDefer` — never a duplicate. Otherwise the `[x]` item is appended to
 * `## Open Questions`, creating the section at EOF when the doc has none (a pre-template doc).
 * An identical item already present → `changed: false`. Used by `--from-issue` in every status
 * and by the positional form on a signed doc (GH #253), where there is no `- [ ]` to rewrite.
 */
export function applyDeferOrAppend(raw: string, issueText: string, input: Omit<DeferInput, "question">): ApplyDeferResult {
  const full: DeferInput = { ...input, question: issueText };
  const v = validateInput(full);
  if (!v.ok) return v;
  const existing = applyDefer(raw, full);
  if (existing.ok) return existing;
  if (!existing.message.startsWith("no unchecked Open Question matching")) return existing; // ambiguous / already checked
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const bullet =
    `- [x] ${issueText} — v${input.currentVersion}: ${input.decision.trim()}; deferred to v${v.until} ` +
    `(${input.on}${input.by !== undefined ? `, ${input.by.trim()}` : ""})`;
  const lines = splitKeepEol(raw);
  const appended = appendBullet(lines, OPEN_QUESTIONS_HEADING, bullet, eol);
  if (appended) return { ok: true, content: appended.lines.join(""), changed: appended.changed };
  // No `## Open Questions` section at all: open one at the end of the doc.
  let content = raw;
  if (content.length > 0 && !/\r?\n$/.test(content)) content += eol;
  if (content.length > 0 && !/(\r?\n){2}$/.test(content)) content += eol;
  content += `## Open Questions${eol}${eol}${bullet}${eol}`;
  return { ok: true, content, changed: true };
}

export type RunDeferResult =
  | { ok: true; path: string; changed: boolean; signed: boolean; restamped: boolean }
  | { ok: false; message: string };

type ResolvedDeferDoc = { ok: true; sliceIndex: number; path: string; version: number } | { ok: false; message: string };

/** The doc resolution both paths share (same join as ratify/revise): continuation and
 *  binding refusals, frontmatter validity, the doc's current version. */
function resolveDeferDoc(model: NormalizedModel, refs: RefsResult, baseDir: string, sliceKey: string): ResolvedDeferDoc {
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
  return { ok: true, sliceIndex, path: doc.path, version: doc.version };
}

/** The state-file mirror both paths share; refuses (never creates) when the file is absent. */
function mirrorIntoStateFile(
  baseDir: string,
  sliceKey: string,
  question: string,
  input: Omit<DeferInput, "question" | "currentVersion">,
  currentVersion: number,
): { ok: true; path: string; content: string; changed: boolean } | { ok: false; message: string } {
  const statePath = join(baseDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) {
    return { ok: false, message: `no ${STATE_FILE_NAME} beside the model — defer mirrors into it and never creates it` };
  }
  const r = applyDeferStateFile(readFileSync(statePath, "utf8"), {
    question,
    sliceKey,
    until: parseUntil(input.until)!,
    decision: input.decision,
    by: input.by,
    on: input.on,
    currentVersion,
  });
  if (!r.ok) return r;
  return { ok: true, path: statePath, content: r.content, changed: r.changed };
}

/** Resolves `sliceKey` to its bound doc (same join as ratify/revise), computes both edits, and
 *  writes only when every precondition holds (the state file is required and never created). */
export function runDefer(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  input: Omit<DeferInput, "currentVersion">,
): RunDeferResult {
  const doc = resolveDeferDoc(model, refs, baseDir, sliceKey);
  if (!doc.ok) return doc;
  const absDoc = join(baseDir, doc.path);
  const docRaw = readFileSync(absDoc, "utf8");

  // GH #253: a signed doc has no `- [ ]` to rewrite (readiness required none) — the deferral is
  // appended as an already-deferred item, outside the hash. A draft is edited as ever.
  const signed = isSignedDoc(docRaw);
  const edited = signed
    ? applyDeferOrAppend(docRaw, input.question, { ...input, currentVersion: doc.version })
    : applyDefer(docRaw, { ...input, currentVersion: doc.version });
  if (!edited.ok) return { ok: false, message: `${doc.path}: ${edited.message}` };
  // The hash check and any legacy re-stamp ride on a real write only — a no-op re-run stays a no-op.
  const finished =
    signed && edited.changed ? finishSignedDocEdit(docRaw, edited.content) : { ok: true as const, content: edited.content, restamped: false };
  if (!finished.ok) return { ok: false, message: `${doc.path}: ${finished.message}` };

  const state = mirrorIntoStateFile(baseDir, sliceKey, edited.matched ?? input.question, input, doc.version);
  if (!state.ok) return state;
  if (edited.changed) writeFileSync(absDoc, finished.content, "utf8");
  if (state.changed) writeFileSync(state.path, state.content, "utf8");
  return { ok: true, path: doc.path, changed: edited.changed || state.changed, signed, restamped: finished.restamped };
}

export type RunDeferFromIssueResult =
  | { ok: true; path: string; changed: boolean; issue: string; modelLine: number | null; signed: boolean; restamped: boolean }
  | { ok: false; message: string };

/**
 * `--from-issue <text>` (MIL-281): the single open `issue "..."` on one of the slice's own
 * elements whose text contains `text` becomes a deferred Open Question on the doc, is mirrored
 * into the state file, and its clause is removed from `modelFile`. All three edits are computed
 * first; nothing is written unless every one succeeds. Zero candidates with the question already
 * deferred on the doc → the idempotent no-op; zero otherwise → refuse; two or more → refuse
 * naming each with its `.em` line.
 */
export function runDeferFromIssue(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  modelFile: string,
  sliceKey: string,
  text: string,
  input: Omit<DeferInput, "question" | "currentVersion">,
): RunDeferFromIssueResult {
  if (text.trim() === "") return { ok: false, message: "--from-issue needs the issue's text (a case-sensitive substring)" };
  const doc = resolveDeferDoc(model, refs, baseDir, sliceKey);
  if (!doc.ok) return doc;
  const absDoc = join(baseDir, doc.path);
  const docRaw = readFileSync(absDoc, "utf8");

  const signed = isSignedDoc(docRaw);
  const candidates = findIssueCandidates(model, doc.sliceIndex, text);
  if (candidates.length === 0) {
    // Already promoted on an earlier run? Then the doc carries it as deferred to this version.
    const probe = applyDefer(docRaw, { ...input, question: text, currentVersion: doc.version });
    if (probe.ok && !probe.changed) return { ok: true, path: doc.path, changed: false, issue: text, modelLine: null, signed, restamped: false };
    if (probe.ok) {
      // The question is on the doc as a hand-written `- [ ]` item, never on the diagram: that is
      // the positional form's job.
      return {
        ok: false,
        message:
          `no open issue matching "${text}" on slice "${sliceKey}" — but ${doc.path} has an unchecked Open Question ` +
          `containing it; defer that with the positional form: em slice defer <model> ${sliceKey} "${text}" --until ${input.until} --decision "..."`,
      };
    }
    return { ok: false, message: `no open issue matching "${text}" on slice "${sliceKey}" (see \`em validate --list-issues\`)` };
  }
  if (candidates.length > 1) {
    return { ok: false, message: `ambiguous — matches: ${candidates.map(formatIssueCandidate).join(" | ")}` };
  }
  const [cand] = candidates;

  const edited = applyDeferOrAppend(docRaw, cand.issue, { ...input, currentVersion: doc.version });
  if (!edited.ok) return { ok: false, message: `${doc.path}: ${edited.message}` };
  // GH #253: on a signed doc the appended item sits outside `ratifiedHash` — verified before write.
  const docResult = signed ? finishSignedDocEdit(docRaw, edited.content) : { ok: true as const, content: edited.content, restamped: false };
  if (!docResult.ok) return { ok: false, message: `${doc.path}: ${docResult.message}` };

  const state = mirrorIntoStateFile(baseDir, sliceKey, cand.issue, input, doc.version);
  if (!state.ok) return state;

  const emRaw = readFileSync(modelFile, "utf8");
  const removed = removeIssueClause(emRaw, cand.line, cand.issue);
  if (!removed.ok) return { ok: false, message: `${modelFile}: ${removed.message}` };
  // Verify before write: the edited model must still compile, and this issue must be gone from
  // the slice — the same discipline `em migrate` holds for its own `.em` rewrite. (The candidate
  // was the slice's only issue containing its own text — a second one would have been ambiguous
  // above — so "gone" is simply "no element of the slice still carries it".)
  let clean: boolean;
  try {
    const after = compile(removed.content);
    clean =
      !after.diagnostics.some((d) => d.severity === "error") &&
      !after.model.elements.some((el) => el.sliceIndex === doc.sliceIndex && el.issue === cand.issue);
  } catch {
    clean = false;
  }
  if (!clean) {
    return { ok: false, message: `${modelFile}: removing the issue clause at line ${removed.removedLine} would not leave a clean model — nothing written` };
  }

  if (edited.changed || docResult.restamped) writeFileSync(absDoc, docResult.content, "utf8");
  if (state.changed) writeFileSync(state.path, state.content, "utf8");
  writeFileSync(modelFile, removed.content, "utf8");
  return { ok: true, path: doc.path, changed: true, issue: cand.issue, modelLine: removed.removedLine, signed, restamped: docResult.restamped };
}
