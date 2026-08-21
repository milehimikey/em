// SPDX-License-Identifier: MIT
// `em migrate` (MIL-125): rewrites the OLD, pre-1.7.1 two-slice Automation/Translation shape —
// reaction + its read model in one slice, that reaction's command + event in the next, linked
// only by file-position adjacency — into the MIL-120 merged shape (reaction, command, and event
// sharing one slice). MIL-120 changed what `em validate` accepts; it deliberately didn't touch
// existing `.em` source text, since the restructuring has to happen in the source itself (see
// that commit's own message, which filed this ticket as the follow-up). This is `em`'s first
// command that mutates a `.em` file — see cli.ts's `migrate` registration for the CLI-shape
// rationale (dedicated command, dry-run by default).
//
// Text-level and line-based throughout, guided by (not derived from) the parse: every edit is a
// literal line range lifted from the original source and spliced elsewhere, so comments, blank
// lines, and indentation everywhere else in the file survive byte-for-byte. Nothing here ever
// regenerates a slice from the AST.
//
// Detection is deliberately narrow. A pair of adjacent slices only enters the refusal/migration
// path at all once BOTH of these hold — the signature of an attempted old-shape pairing:
//   - the leading slice has no `command` but has at least one reaction-kind element
//     (automation/processor/saga/translation)
//   - the following slice has at least one `command`
// Every other adjacent pair (the overwhelming majority in a normal model) is silently skipped —
// refusing on every unrelated slice boundary would bury the real refusals in noise. Once a pair
// clears that bar, every deviation from the clean shape becomes a *refusal*, never a guess.

import { AUTOMATION_KINDS, ElementNode, ModelNode, SliceNode } from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import { indexOfUnquoted, stripComment } from "../parser/lexer.js";
import { normalizeName } from "../model/model.js";
import { compile } from "../pipeline.js";
import type { Diagnostic } from "../model/validate.js";

export interface MigrationChange {
  leadingSlice: string;
  followingSlice: string;
  reactionKind: string;
  reactionName: string;
  /** True when the leading slice held nothing but the reaction and was deleted outright. */
  leadingSliceDeleted: boolean;
  /** The view name added to the reaction's `from`, or null if none was needed/possible. */
  addedFrom: string | null;
  /** `element kind "name": note "slices/…"` lines for any note binding in either slice —
   *  surfaced so the report can point at docs that may need re-checking (see module header). */
  noteHints: string[];
  /** Human-readable one-line (plus note-hint lines) report of this change, ready to print —
   *  same convention as LedgerFinding.message in ledgerCheck.ts. */
  message: string;
}

export interface MigrationRefusal {
  leadingSlice: string;
  leadingSliceLine: number;
  followingSlice: string;
  followingSliceLine: number;
  reasons: string[];
  /** Human-readable, ready-to-print report of this refusal — same convention as `message` above. */
  message: string;
}

export interface MigrationPlan {
  changes: MigrationChange[];
  refusals: MigrationRefusal[];
  /** The rewritten source, or null when there is nothing to change (changes.length === 0) —
   *  including the fully-idempotent "already migrated" case. */
  rewritten: string | null;
}

export interface MigrationVerifyResult {
  ok: boolean;
  /** Error-severity diagnostics present after the rewrite that weren't present before it
   *  (matched by code+message, multiset-aware — see verifyMigration). Empty when ok. */
  newErrors: Diagnostic[];
}

const isReaction = (e: ElementNode): boolean => AUTOMATION_KINDS.has(e.kind);
const isCommand = (e: ElementNode): boolean => e.kind === "command";
const isEvent = (e: ElementNode): boolean => e.kind === "event";
const isView = (e: ElementNode): boolean => e.kind === "view";

/** A `slices/<key>.md`-shaped note (docs/slice-doc-schema.md's canonical binding path). */
const NOTE_BINDING = /^slices\/.*\.md$/;

/**
 * A single-line element's own source line — the only shape this module ever moves. Elements
 * carrying a `{ fields }` block are refused rather than relocated (see planMigration): the
 * canonical old-shape examples (docs/patterns.md, pre-MIL-120) never show a reaction with
 * fields, and a multi-line block's `from` clause can legally sit on either its header or its
 * closing line — correctly locating it isn't worth the risk on a shape that doesn't occur in
 * practice. Kept exported for use by both planMigration and its tests.
 */
export function isSingleLineReaction(el: ElementNode): boolean {
  return el.fields === undefined;
}

/** Escape `\` and `"` the same way the DSL's own quoted strings require (mirrors decodeQuoted's
 *  inverse in src/parser/lexer.ts) — so a view name containing either round-trips correctly. */
function escapeForQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Append (or extend) a `from "…"` clause on `line`, inserted before any trailing `# comment`
 *  so the comment survives untouched. `from`'s own grammar captures to end-of-line once it
 *  starts (src/parser/parser.ts's extractClauses), so for the single-line elements this module
 *  ever touches, appending at the end of the code portion is always correct — whether starting
 *  a fresh clause or adding one more name to an existing list. */
function appendFromClause(line: string, viewName: string, hasExistingFrom: boolean): string {
  const codePart = stripComment(line);
  const commentPart = line.slice(codePart.length);
  const trimmedCode = codePart.replace(/\s+$/, "");
  const addition = hasExistingFrom ? `, "${escapeForQuotes(viewName)}"` : ` from "${escapeForQuotes(viewName)}"`;
  const rebuilt = trimmedCode + addition;
  return commentPart ? `${rebuilt} ${commentPart}` : rebuilt;
}

/** An element's own line range, 1-based inclusive. Every reaction this module moves is single-
 *  line (see isSingleLineReaction); this stays general (used for the leading slice's other
 *  elements too, via sliceExtent) so a fields-bearing view/command elsewhere in the pair doesn't
 *  throw off the slice's own closing-brace search. */
function elementExtent(lines: string[], el: ElementNode): [number, number] {
  const startIdx = el.line - 1;
  if (!el.fields) return [el.line, el.line];
  const headerStripped = stripComment(lines[startIdx]);
  const braceAt = indexOfUnquoted(headerStripped, "{");
  if (braceAt < 0) return [el.line, el.line];
  const after = headerStripped.slice(braceAt + 1);
  if (indexOfUnquoted(after, "}") >= 0) return [el.line, el.line]; // closes on its own line
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (stripComment(lines[i]).trim().startsWith("}")) return [el.line, i + 1];
  }
  return [el.line, el.line]; // unreachable for source that already parsed successfully
}

/** A slice block's own line range, 1-based inclusive — from its `slice "Name" {` line to the
 *  line whose stripped, trimmed content is exactly `}` (a slice's closing brace supports no
 *  trailing clauses, unlike an element's — see src/parser/parser.ts's block-closing logic).
 *  When `swallowTrailingBlank` is set (used only when the slice is about to be deleted whole),
 *  one immediately-following blank line is folded into the range too — the same collapse
 *  MIL-120's own doc rewrite made by hand (docs/patterns.md's "Carrier Webhook" removal),
 *  so deleting a slice doesn't leave a doubled blank-line gap where it used to sit. Never
 *  reaches past a second blank line, and never touches whatever precedes the slice. */
function sliceExtent(lines: string[], slice: SliceNode, swallowTrailingBlank = false): [number, number] {
  let lastElementEnd = slice.line;
  for (const el of slice.elements) {
    const [, end] = elementExtent(lines, el);
    if (end > lastElementEnd) lastElementEnd = end;
  }
  for (let i = lastElementEnd; i < lines.length; i++) {
    const t = stripComment(lines[i]).trim();
    if (t.length === 0) continue;
    if (t === "}") {
      const closeLine = i + 1; // 1-based
      const nextIdx = closeLine; // 0-based index of the line right after the close
      if (swallowTrailingBlank && lines[nextIdx] !== undefined && lines[nextIdx].trim() === "") {
        return [slice.line, closeLine + 1];
      }
      return [slice.line, closeLine];
    }
  }
  return [slice.line, lastElementEnd]; // unreachable for source that already parsed successfully
}

/** Rebuild `lines` with every 1-based inclusive range in `removals` dropped, and each entry of
 *  `insertions` (keyed by "insert before this 1-based line number") spliced in ahead of it — a
 *  single forward pass, so multiple independent sites in one file compose without needing to
 *  process edits in any particular order. */
function applyEdits(lines: string[], removals: [number, number][], insertions: Map<number, string[]>): string[] {
  const out: string[] = [];
  for (let ln = 1; ln <= lines.length; ln++) {
    const toInsert = insertions.get(ln);
    if (toInsert) out.push(...toInsert);
    const removed = removals.some(([s, e]) => ln >= s && ln <= e);
    if (!removed) out.push(lines[ln - 1]);
  }
  return out;
}

/**
 * Detect and plan the rewrite for every old-shape site in `source`. Throws ParseError (from
 * src/parser/parser.ts) if `source` itself doesn't parse — same contract as compile().
 */
export function planMigration(source: string): MigrationPlan {
  const model: ModelNode = parse(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  const changes: MigrationChange[] = [];
  const refusals: MigrationRefusal[] = [];
  const removals: [number, number][] = [];
  const insertions = new Map<number, string[]>();

  for (let i = 0; i < model.slices.length - 1; i++) {
    const leading = model.slices[i];
    const following = model.slices[i + 1];

    const leadingReactions = leading.elements.filter(isReaction);
    const leadingHasCommand = leading.elements.some(isCommand);
    const followingCommands = following.elements.filter(isCommand);

    // Candidacy trigger (see module header) — anything short of this is an unrelated adjacent
    // pair, skipped without comment.
    if (leadingReactions.length === 0) continue;
    if (leadingHasCommand) continue;
    if (followingCommands.length === 0) continue;

    const reasons: string[] = [];
    const leadingViews = leading.elements.filter(isView);
    const leadingOther = leading.elements.filter((e) => !isView(e) && !isReaction(e));

    if (leadingReactions.length > 1) {
      reasons.push(
        `more than one reaction in leading slice "${leading.name}" (${leadingReactions
          .map((r) => `${r.kind} "${r.name}"`)
          .join(", ")})`,
      );
    }
    if (leadingViews.length > 1 || leadingOther.length > 0) {
      reasons.push(`leading slice "${leading.name}" has elements beyond one view and one reaction`);
    }
    if (following.elements.some(isReaction)) {
      reasons.push(`following slice "${following.name}" already has a reaction`);
    }
    if (followingCommands.length > 1) {
      reasons.push(`following slice "${following.name}" has more than one command`);
    }
    if (!following.elements.some(isEvent)) {
      reasons.push(`following slice "${following.name}" has a command but no event`);
    }
    if (leadingReactions.length === 1 && !isSingleLineReaction(leadingReactions[0])) {
      reasons.push(
        `reaction "${leadingReactions[0].name}" declares a \`{ fields }\` block — migrate this one by hand`,
      );
    }

    if (reasons.length > 0) {
      refusals.push({
        leadingSlice: leading.name,
        leadingSliceLine: leading.line,
        followingSlice: following.name,
        followingSliceLine: following.line,
        reasons,
        message: `refused slice "${leading.name}" / "${following.name}": ${reasons.join("; ")}`,
      });
      continue;
    }

    // Clean site.
    const reaction = leadingReactions[0];
    const command = followingCommands[0];
    const view = leadingViews[0]; // undefined when the leading slice held only the reaction

    const hasExistingFrom = (reaction.from ?? []).length > 0;
    const alreadyNamesView = view
      ? (reaction.from ?? []).some((n) => normalizeName(n) === normalizeName(view.name))
      : false;

    let reactionLine = lines[reaction.line - 1];
    let addedFrom: string | null = null;
    if (view && !alreadyNamesView) {
      reactionLine = appendFromClause(reactionLine, view.name, hasExistingFrom);
      addedFrom = view.name;
    }

    removals.push([reaction.line, reaction.line]);
    insertions.set(command.line, [...(insertions.get(command.line) ?? []), reactionLine]);

    const leadingSliceDeleted = !view;
    if (leadingSliceDeleted) {
      removals.push(sliceExtent(lines, leading, true));
    }

    const noteHints: string[] = [];
    for (const el of [...leading.elements, ...following.elements]) {
      if (el.note && NOTE_BINDING.test(el.note)) {
        noteHints.push(`${el.kind} "${el.name}": note "${el.note}"`);
      }
    }

    const leadingFate = leadingSliceDeleted
      ? `leading slice "${leading.name}" deleted (now empty)`
      : `leading slice "${leading.name}" kept (bare view)`;
    const fromNote = addedFrom ? ` (added \`from "${addedFrom}"\`)` : "";
    let message =
      `migrated slice "${leading.name}" / "${following.name}": moved ${reaction.kind} ` +
      `"${reaction.name}" into "${following.name}"${fromNote}; ${leadingFate}`;
    if (noteHints.length > 0) {
      message += `\n  doc bindings may need re-checking: ${noteHints.join("; ")}`;
    }

    changes.push({
      leadingSlice: leading.name,
      followingSlice: following.name,
      reactionKind: reaction.kind,
      reactionName: reaction.name,
      leadingSliceDeleted,
      addedFrom,
      noteHints,
      message,
    });
  }

  if (changes.length === 0) {
    return { changes, refusals, rewritten: null };
  }

  return { changes, refusals, rewritten: applyEdits(lines, removals, insertions).join(eol) };
}

/**
 * Re-parse + re-validate both `before` and `after`, and confirm the rewrite introduced no new
 * error-severity diagnostic. Compared as a code+message multiset (not by count alone) so a
 * genuinely new error can't hide behind an unrelated one the rewrite happened to fix. Never
 * throws on `after` failing to parse/compile cleanly — that counts as new errors too, reported
 * as a single synthetic entry, so a rewrite bug aborts loudly instead of crashing the CLI.
 */
export function verifyMigration(before: string, after: string): MigrationVerifyResult {
  const beforeErrors = compile(before).diagnostics.filter((d) => d.severity === "error");

  let afterErrors: Diagnostic[];
  try {
    afterErrors = compile(after).diagnostics.filter((d) => d.severity === "error");
  } catch (e) {
    return {
      ok: false,
      newErrors: [
        {
          severity: "error",
          code: "migrate-rewrite-unparseable",
          message: `rewritten source failed to parse: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }

  const remaining = new Map<string, number>();
  for (const d of beforeErrors) {
    const key = `${d.code}|${d.message}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const newErrors: Diagnostic[] = [];
  for (const d of afterErrors) {
    const key = `${d.code}|${d.message}`;
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else newErrors.push(d);
  }

  return { ok: newErrors.length === 0, newErrors };
}
