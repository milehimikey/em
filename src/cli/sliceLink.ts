// SPDX-License-Identifier: MIT
// `em slice new --wire` (MIL-161 finding #3): `em slice new` already computes the exact
// `note "slices/<key>.md"` line and knows which element is the slice's "primary" one for its
// pattern (SKILL.md's slice phase, step 4) — this module does the mechanical part that used to
// stop at printing that line: inserting it into the `.em` source directly, onto the right
// element's declaration line.
//
// Deliberately narrow, matching every other .em-source-editing decision in this codebase (there
// is no general .em serializer — see docModelConsistencyValidate.ts's header for why a
// parse+re-serialize is never on the table here either): this ONLY ever edits the ONE physical
// source line an element's declaration STARTS on (`Element.line`, 1-indexed, straight from the
// parser — parser.ts's `parseElement`/`lineNo`), and only ever INSERTS a `note "..."` clause
// into it. Every other line — including the rest of a multi-line field block and its closing
// `}` — is copied through byte-for-byte; multi-line field text on the SAME line as a note
// insertion (a block's opening line, e.g. `command Place Order { customerId`) is preserved
// verbatim too, since the insertion point is always relative to the unquoted `{`, never to
// anything after it.
//
// Placement follows the grammar exactly (parser.ts's `extractClauses`): `note`/`issue`/
// `divergence`/`tag`/`renamed from` are all extracted from an element's header line BEFORE
// `from`, and by locating the keyword anywhere in the line rather than requiring it in a fixed
// position — so a `note "..."` clause parses identically whether it comes before or after a
// `from "..."` clause, before or after a `@Tag`, immediately before an opening `{`, or right
// after a `}` that already closed inline. That's what makes one placement rule safe for every
// element shape:
//
//   - the header line opens a field block on this SAME line (an unquoted `{`, MIL-122's
//     quote-aware scan — a literal `{` inside a quoted clause like `issue "PUT /widgets/{id}"`
//     is not a block opener): insert immediately BEFORE that `{`, matching every existing
//     note-before-fields example in the DSL (`event X @Ctx note "..." { ... }`).
//   - otherwise (no field block at all on this line, OR a fully inline `{ ... }` block that
//     already closed on the same line): append at the very end of the code, before any trailing
//     `# comment` — matching the grammar's "clauses may trail a closing `}` on the same line"
//     rule, which already covers both shapes identically.
//
// Refuses (never overwrites/duplicates) when the header line already carries a `note` clause —
// the caller falls back to printing the line for a hand edit, same as when `--wire` isn't passed
// at all.

import { NormalizedModel, Element } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { indexOfUnquoted, stripComment } from "../parser/lexer.js";
import { SlicePattern } from "./sliceNew.js";

/** Which element kind(s) count as a slice's "primary" element per pattern — the one `note
 *  "slices/<key>.md"` binds to (SKILL.md's slice phase, step 4): the command for State Change,
 *  the view for State View, the reactor (processor/automation/saga) for Automation, the
 *  translation for Translation. Distinct from classify.ts's classifySlicePattern, which groups
 *  every kind a pattern's slice may contain (e.g. an Automation slice's command too) — this
 *  narrows to the single element the note actually binds to. */
const PRIMARY_KINDS: Record<SlicePattern, readonly string[]> = {
  "state-change": ["command"],
  "state-view": ["view"],
  automation: ["processor", "automation", "saga"],
  translation: ["translation"],
};

export type ResolvePrimaryElementResult =
  | { ok: true; sliceIndex: number; element: Element }
  | { ok: false; message: string };

/** Resolve `sliceKey`'s primary element for `pattern` — the export key must match a slice
 *  already declared in `model` (the ordinary case: the model phase already created the slice;
 *  `slice` phase authoring adds its doc afterward), and that slice must have EXACTLY one element
 *  of the pattern's primary kind(s) — zero or more than one is refused rather than guessed. */
export function resolvePrimaryElement(
  model: NormalizedModel,
  refs: RefsResult,
  sliceKey: string,
  pattern: SlicePattern,
): ResolvePrimaryElementResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const kinds = PRIMARY_KINDS[pattern];
  const candidates = slice.elements.filter((el) => kinds.includes(el.kind));
  if (candidates.length === 0) {
    return {
      ok: false,
      message: `slice "${slice.name}" has no ${kinds.join("/")} element to wire the note onto`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      message: `slice "${slice.name}" has ${candidates.length} ${kinds.join("/")} elements — ambiguous, wire the note by hand`,
    };
  }
  return { ok: true, sliceIndex, element: candidates[0] };
}

export type InsertNoteResult = { ok: true; content: string } | { ok: false; message: string };

/** Insert `note "<notePath>"` into one raw source line — see module header for the placement
 *  rule. Pure string transform, no fs, no knowledge of the rest of the file. */
export function insertNoteClause(rawLine: string, notePath: string): InsertNoteResult {
  const code = stripComment(rawLine);
  const comment = rawLine.slice(code.length); // '' or the (whitespace + '#...') tail stripComment dropped
  const trimmedCode = code.replace(/[ \t]+$/, "");

  // Conservative existing-clause check: a bare "note" immediately followed by a quote is
  // EXACTLY how the parser itself recognizes the clause (lexer.ts's QUOTE_OPENER_KEYWORDS
  // anchoring), regardless of where else it appears — a false positive here just means an
  // avoidable refusal (falls back to a hand edit), never a corrupted line.
  if (/\bnote\s*"/.test(trimmedCode)) {
    return { ok: false, message: "this line already has a `note` clause — edit it by hand instead" };
  }

  const clause = `note "${notePath}"`;
  const braceAt = indexOfUnquoted(trimmedCode, "{");
  // A `{` on THIS line only means "insert before it" when the block actually stays open past
  // this line (no matching unquoted `}` here too) — a fully inline `{ ... }` block that already
  // closed on the same line is grammatically just like having no braces at all: the note clause
  // trails it, same as the no-brace case below.
  const closesInline = braceAt >= 0 && indexOfUnquoted(trimmedCode.slice(braceAt + 1), "}") >= 0;
  const newCode =
    braceAt >= 0 && !closesInline
      ? `${trimmedCode.slice(0, braceAt).replace(/[ \t]+$/, "")} ${clause} ${trimmedCode.slice(braceAt)}`
      : `${trimmedCode} ${clause}`;

  return { ok: true, content: comment ? `${newCode} ${comment}` : newCode };
}

/** Byte offsets of physical line `lineNo` (1-indexed) within `source`: `[start, end)` excludes
 *  the line's own terminator (a trailing `\r` before `\n` is excluded too, so a CRLF file's line
 *  content never carries a stray `\r`). Scans once, character by character, rather than
 *  `split(/\r?\n/)` — a split+rejoin would silently normalize every OTHER line's terminator
 *  style the moment the file is written back (the same pitfall markImplemented.ts/ratify.ts's
 *  module headers document for frontmatter surgery — this is the `.em`-source counterpart). */
export function findLineSpan(source: string, lineNo: number): { start: number; end: number } | null {
  let line = 1;
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      let end = i;
      if (end > start && source[end - 1] === "\r") end--;
      if (line === lineNo) return { start, end };
      line++;
      start = i + 1;
    }
  }
  return null;
}

export type WireSliceNoteResult =
  | { ok: true; content: string; sliceName: string; elementName: string }
  | { ok: false; message: string };

/**
 * Full `--wire` operation: resolve `sliceKey`'s primary element for `pattern`, then insert
 * `note "<notePath>"` on its exact header line in `source`. `source` MUST be the same text
 * `model`/`refs` were compiled from — line numbers are meaningless against any other text.
 * Every byte outside that one line's span is returned unchanged.
 */
export function wireSliceNote(
  source: string,
  model: NormalizedModel,
  refs: RefsResult,
  sliceKey: string,
  pattern: SlicePattern,
  notePath: string,
): WireSliceNoteResult {
  const resolved = resolvePrimaryElement(model, refs, sliceKey, pattern);
  if (!resolved.ok) return resolved;

  const span = findLineSpan(source, resolved.element.line);
  if (!span) {
    return {
      ok: false,
      message: `element "${resolved.element.name}"'s line ${resolved.element.line} not found in the given source — source doesn't match the compiled model`,
    };
  }
  const inserted = insertNoteClause(source.slice(span.start, span.end), notePath);
  if (!inserted.ok) return inserted;

  return {
    ok: true,
    content: source.slice(0, span.start) + inserted.content + source.slice(span.end),
    sliceName: model.slices[resolved.sliceIndex].name,
    elementName: resolved.element.name,
  };
}
