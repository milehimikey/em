// SPDX-License-Identifier: MIT
// Parses a slice design doc (slices/<slice-name>.md, see
// .claude/skills/event-modeling/templates/slice.md) for `em catalog`. `em`
// has never parsed this markdown structurally before — it only checked the
// file exists (cli.ts's warnMissingNotes). This is deliberately shallow: pull
// the status/version/lineage values the index page and downstream consumers
// need, and render the doc body as HTML for the per-slice detail page. Pure —
// no fs access; the caller reads the file and hands us its text.
//
// Two status dialects: a leading YAML frontmatter block (`status: ...`) is
// canonical (MIL-86); a `- **Status:** ...` bullet line is legacy/accepted
// input for docs written before the frontmatter dialect existed. Frontmatter
// wins when both are somehow present. No `yaml` dependency — the 1.1.1 revert
// (6de0a05) dropped it on purpose; frontmatter is a plain top-level-scalar
// line-scan, same spirit as the bullet-line regex it now sits alongside.
//
// `version` and the three lineage keys (`split-from`/`merged-from`/
// `superseded-by`) are canonical, frontmatter-only fields (MIL-90) — no
// legacy bullet-line form exists for them. Full schema: docs/slice-doc-schema.md.
// `#`-prefixed lines (the template's commented-out optional lineage guidance)
// are inert: they don't match the key regex below, so they're skipped exactly
// like any other non-`key: value` line — safe to leave in an unfinished doc.
//
// `implementedIn`, `frontmatterPresent`, and `missingRequiredFields` (MIL-91)
// exist so `em export`'s doc join (src/catalog/docJoin.ts) can mechanically
// classify a doc as `frontmatter-invalid` — no frontmatter fence at all, or
// missing one of the keys docs/slice-doc-schema.md says are required at every
// status — without export re-deriving frontmatter-shape rules of its own.
//
// `covers` (MIL-121) is a fourth optional frontmatter-only field, alongside
// `implementedIn`/lineage: a plain list of slice keys (not `<key>@v<N>` refs) this doc also
// ratifies coverage for, so a different slice can bind to THIS doc via a cross-slice
// `note "slices/<this-key>.md"` instead of authoring its own. Parsed the same
// comma-separated-list shape as `merged-from`/`superseded-by`; see docJoin.ts for the
// two-ended handshake that actually uses it.
//
// `ratifiedBy`/`ratifiedOn` (MIL-165) are a fifth and sixth optional frontmatter-only field:
// who ratified this doc's current `status`/`version`, and when, written by `em slice ratify`
// (cli/ratify.ts) alone — same "one write path" discipline `implementedIn` has with `em slice
// mark-implemented`. Additive, tolerate-unknown-fields: a doc that predates this feature (or was
// hand-ratified) simply has neither key, same as any other optional field's absence.

import { marked } from "marked";

/** A parsed `<slice-key>@v<N>` lineage reference. */
export interface SliceRef {
  /** The exact frontmatter value this ref was read from, e.g. "checkout@v4".
   *  Always present, even when the grammar didn't match — nothing is silently
   *  dropped the way an unrecognized top-level key is. */
  raw: string;
  /** The referenced slice's doc key (its kebab-case filename stem), lowercased,
   *  or null if `raw` doesn't match the `<slice-key>@v<N>` grammar. Whether
   *  this actually names a real slice/version is NOT checked here — that's
   *  MIL-84 (lineage-aware `em diff`/`em validate`). */
  sliceKey: string | null;
  /** The referenced version number, or null if `raw` didn't match the grammar. */
  version: number | null;
}

export interface SliceDoc {
  /** The doc's raw markdown, as read from disk. */
  raw: string;
  /** The doc's body text — everything after the frontmatter fence (or the whole doc, if no
   *  fence) — the same text `html`/`openQuestionsTotal` are already derived from. Exposed so a
   *  two-revision content-agreement check (MIL-89, `em ledger`) can diff body text across git
   *  revisions without frontmatter noise leaking in. */
  body: string;
  /** Lowercased status value from frontmatter `status:` (canonical) or a legacy
   *  `- **Status:** ...` bullet line, or null if neither is found (a freeform
   *  doc that doesn't follow the slice.md template). */
  status: string | null;
  /** Lowercased `pattern:` frontmatter value (`state-change`/`state-view`/`automation`/
   *  `translation`, per the template) — frontmatter-only, no legacy body form. Authored/
   *  informational per docs/slice-doc-schema.md, but MIL-124's doc-model-consistency check
   *  (catalog/docModelConsistencyValidate.ts) is the first `em` consumer that reads it back, to
   *  compare against `classify.ts`'s deterministic `classifySlicePattern()`. Null when absent. */
  pattern: string | null;
  /** This slice's own ratified-content version, from frontmatter `version:`
   *  (e.g. `version: 1`) — a cache of git truth (docset module 06), not
   *  derived or validated against git history. Null when absent or
   *  non-numeric. Distinct from the frontmatter dialect's own `schemaVersion`,
   *  which this parser still doesn't expose. */
  version: number | null;
  /** Lineage: this doc split off exactly one prior slice, from frontmatter
   *  `split-from:`. Null when this doc wasn't produced by a split. */
  splitFrom: SliceRef | null;
  /** Lineage: this doc was produced by merging one or more prior slices, from
   *  frontmatter `merged-from:` (comma-separated). Empty array when absent —
   *  the common case. */
  mergedFrom: SliceRef[];
  /** Lineage: this doc has been superseded by one or more successor slices —
   *  a rename, or the retired side of a split/merge — from frontmatter
   *  `superseded-by:` (comma-separated). Empty array when absent — the
   *  common case; most slices are never superseded. */
  supersededBy: SliceRef[];
  /** Frontmatter `implementedIn:` — free text, typically a PR/commit link — or null
   *  when absent. No legacy bullet-line form, same as `version`/lineage. */
  implementedIn: string | null;
  /** MIL-121: slice keys (comma-separated, lowercased, plain — NOT `<key>@v<N>` refs like the
   *  lineage keys above) this doc ratifies coverage for, from frontmatter `covers:`. This is the
   *  other end of the two-ended cross-binding handshake: a slice with no doc of its own may
   *  `note "slices/<this-doc's-key>.md"` on one of its elements, and docJoin.ts (`em export`'s
   *  doc join) only honors that note as a binding when the noted doc's own `covers` list names
   *  the noting slice back. Empty array when absent — the common case; a doc always covers its
   *  own canonical slice key implicitly and never needs to list it here. */
  covers: string[];
  /** MIL-165: `ratifiedBy:` — free text, typically a person's name — or null when absent.
   *  Written only by `em slice ratify`; no legacy bullet-line form. */
  ratifiedBy: string | null;
  /** MIL-165: `ratifiedOn:` — a `YYYY-MM-DD` date string, or null when absent. Written only by
   *  `em slice ratify`; validated by the CLI layer, not re-validated here (this parser stays as
   *  lenient about value shape as every other frontmatter field). */
  ratifiedOn: string | null;
  /** True when a well-formed leading `---`/`---` frontmatter fence was found and
   *  closed — independent of which keys it contained. False for a legacy
   *  status-bullet-only doc, a doc with no frontmatter at all, or an
   *  unterminated fence (splitFrontmatter() already treats that as "absent"). */
  frontmatterPresent: boolean;
  /** Which of REQUIRED_FRONTMATTER_KEYS were absent (or present-but-empty, which
   *  the parser already treats as absent) from the frontmatter. Empty whenever
   *  frontmatterPresent is false too — check frontmatterPresent separately to
   *  distinguish "no frontmatter at all" from "every required key present".
   *  Presence-only: doesn't validate `pattern`'s/`status`'s enum values, matching
   *  this parser's existing lenient, informational treatment of those keys. */
  missingRequiredFields: string[];
  /** The whole doc rendered to HTML, with any leading frontmatter block stripped
   *  first (otherwise its `---` fences render as stray <hr>s and the raw
   *  `key: value` lines leak into the body). */
  html: string;
  /** Count of GFM task-list items (`- [ ]` / `- [x]`) found under the `## Open Questions`
   *  heading (case-insensitive), up to the next `#`/`##` heading or EOF. Both 0 when the doc
   *  has no such heading — nothing for MIL-87's readiness check to block on. See
   *  `openQuestionsUnchecked` for how many of these are still unresolved. */
  openQuestionsTotal: number;
  /** Of `openQuestionsTotal`, how many are still `- [ ]` (unchecked). 0 when every Open
   *  Question has been checked off, or when there's no Open Questions section at all. */
  openQuestionsUnchecked: number;
}

/** Frontmatter keys docs/slice-doc-schema.md's required-vs-optional table marks
 *  required at every `status` — the mechanical basis for `frontmatter-invalid`
 *  (MIL-91). `implementedIn` is deliberately excluded: its requirement depends on
 *  whether the slice has *ever* reached `implemented`, which is git history this
 *  parser has no access to and doesn't attempt to check. */
export const REQUIRED_FRONTMATTER_KEYS = ["schemaversion", "pattern", "swimlane", "status", "version"] as const;

/** True when a doc's frontmatter is well-formed enough to trust its canonical fields: a closed
 *  fence was found AND every REQUIRED_FRONTMATTER_KEYS entry is present. The single gate `em
 *  export`'s doc join (MIL-91, `frontmatter-invalid`) and `em validate`'s frontmatter-coherence
 *  check (MIL-85) both call, instead of each re-deriving `!frontmatterPresent ||
 *  missingRequiredFields.length > 0` and risking the two silently drifting apart on what counts
 *  as "usable" as the required-fields list evolves. A doc that fails this — no fence at all
 *  (e.g. MIL-86's legacy body-label dialect), or missing any required key — has nothing reliable
 *  enough to classify; treat it as unreadable rather than guess. */
export function hasUsableFrontmatter(doc: Pick<SliceDoc, "frontmatterPresent" | "missingRequiredFields">): boolean {
  return doc.frontmatterPresent && doc.missingRequiredFields.length === 0;
}

const STATUS_LINE = /^-\s*\*\*Status:\*\*\s*(.+?)\s*$/im;
const SLICE_REF = /^([a-z0-9]+(?:-[a-z0-9]+)*)@v(\d+)$/i;
const OPEN_QUESTIONS_HEADING = /^##\s+Open Questions\s*$/i;
const TASK_ITEM = /^[ \t]*[-*]\s*\[([ xX])\]/;

/**
 * Counts GFM task-list items under a `## Open Questions` heading (MIL-87), scanning `body`
 * (post-frontmatter, pre-HTML-render text — the same text `html` below is built from) rather
 * than the rendered HTML, which would be needlessly fragile to scrape. The section ends at the
 * next `#`/`##` heading or EOF; a doc with no such heading counts as zero/zero, not an error —
 * most slice docs won't have open questions left by the time they're read.
 */
function countOpenQuestions(body: string): { openQuestionsTotal: number; openQuestionsUnchecked: number } {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => OPEN_QUESTIONS_HEADING.test(l));
  if (start === -1) return { openQuestionsTotal: 0, openQuestionsUnchecked: 0 };

  let openQuestionsTotal = 0;
  let openQuestionsUnchecked = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    const m = lines[i].match(TASK_ITEM);
    if (!m) continue;
    openQuestionsTotal++;
    if (m[1] === " ") openQuestionsUnchecked++;
  }
  return { openQuestionsTotal, openQuestionsUnchecked };
}

/**
 * Parses a single `<slice-key>@v<N>` lineage reference (`split-from`, and each
 * comma-separated item of `merged-from`/`superseded-by`). Never throws: a
 * value that doesn't match the grammar still comes back with the original
 * text in `raw` and null `sliceKey`/`version`, so a malformed value stays
 * visible — to a human reading the doc, or to MIL-84's validation — instead
 * of being silently dropped like an unrecognized `status`. Exported so MIL-84
 * (lineage diff/validate) and MIL-91 (export join) share this grammar instead
 * of re-deriving it. `sliceKey` matches `kebabSlug()`'s output
 * (src/util/slug.ts) — lowercase alphanumerics/hyphens, no assumption it
 * starts with a letter.
 */
export function parseSliceRef(raw: string): SliceRef {
  const trimmed = raw.trim();
  const m = trimmed.match(SLICE_REF);
  return m
    ? { raw: trimmed, sliceKey: m[1].toLowerCase(), version: Number(m[2]) }
    : { raw: trimmed, sliceKey: null, version: null };
}

function parseSliceRefList(raw: string | undefined): SliceRef[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseSliceRef);
}

/** Parses `covers:` (MIL-121) — a comma-separated list of plain slice-key strings, NOT the
 *  `<slice-key>@v<N>` ref grammar `parseSliceRefList` handles: coverage isn't versioned, it's a
 *  standing "this doc also serves that slice" declaration, so there's no version component to
 *  parse or preserve. Lowercased to match `sliceKey` comparisons everywhere else (kebabSlug()
 *  output, and the export keys docJoin.ts compares against). */
function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseVersion(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Splits a leading YAML frontmatter block (`---` ... `---`) off the doc, if
 * present. Deliberately minimal: top-level scalar `key: value` lines only —
 * no lists, no nesting. Returns the scalar fields (lowercased keys) and the
 * remaining body with the frontmatter fences removed. An unterminated `---`
 * fence is treated as "no frontmatter" (the whole doc is the body). Like
 * every other frontmatter convention (Jekyll, Hugo, ...), the fence must be
 * the literal first thing in the file — the template's own guidance comment
 * must be deleted before the frontmatter counts as present.
 */
function splitFrontmatter(
  markdown: string,
): { fields: Map<string, string>; body: string; frontmatterPresent: boolean } {
  if (!/^---\s*\r?\n/.test(markdown)) return { fields: new Map(), body: markdown, frontmatterPresent: false };

  const lines = markdown.split(/\r?\n/);
  const fields = new Map<string, string>();
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      closeIndex = i;
      break;
    }
    const m = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value) fields.set(m[1].toLowerCase(), value);
  }
  if (closeIndex === -1) return { fields: new Map(), body: markdown, frontmatterPresent: false };
  return { fields, body: lines.slice(closeIndex + 1).join("\n"), frontmatterPresent: true };
}

export function parseSliceDoc(markdown: string): SliceDoc {
  const { fields, body, frontmatterPresent } = splitFrontmatter(markdown);
  const legacyMatch = body.match(STATUS_LINE);
  const frontmatterStatus = fields.get("status");
  const status = frontmatterStatus
    ? frontmatterStatus.toLowerCase()
    : legacyMatch
      ? legacyMatch[1].trim().toLowerCase()
      : null;
  const splitFromRaw = fields.get("split-from");
  const { openQuestionsTotal, openQuestionsUnchecked } = countOpenQuestions(body);
  return {
    raw: markdown,
    body,
    status,
    pattern: fields.get("pattern")?.toLowerCase() ?? null,
    version: parseVersion(fields.get("version")),
    splitFrom: splitFromRaw ? parseSliceRef(splitFromRaw) : null,
    mergedFrom: parseSliceRefList(fields.get("merged-from")),
    supersededBy: parseSliceRefList(fields.get("superseded-by")),
    implementedIn: fields.get("implementedin") ?? null,
    covers: parseKeyList(fields.get("covers")),
    ratifiedBy: fields.get("ratifiedby") ?? null,
    ratifiedOn: fields.get("ratifiedon") ?? null,
    frontmatterPresent,
    missingRequiredFields: REQUIRED_FRONTMATTER_KEYS.filter((k) => !fields.has(k)),
    html: marked.parse(body, { async: false }) as string,
    openQuestionsTotal,
    openQuestionsUnchecked,
  };
}
