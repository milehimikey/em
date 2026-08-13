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
  /** Lowercased status value from frontmatter `status:` (canonical) or a legacy
   *  `- **Status:** ...` bullet line, or null if neither is found (a freeform
   *  doc that doesn't follow the slice.md template). */
  status: string | null;
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
  /** The whole doc rendered to HTML, with any leading frontmatter block stripped
   *  first (otherwise its `---` fences render as stray <hr>s and the raw
   *  `key: value` lines leak into the body). */
  html: string;
}

const STATUS_LINE = /^-\s*\*\*Status:\*\*\s*(.+?)\s*$/im;
const SLICE_REF = /^([a-z0-9]+(?:-[a-z0-9]+)*)@v(\d+)$/i;

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
function splitFrontmatter(markdown: string): { fields: Map<string, string>; body: string } {
  if (!/^---\s*\r?\n/.test(markdown)) return { fields: new Map(), body: markdown };

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
  if (closeIndex === -1) return { fields: new Map(), body: markdown };
  return { fields, body: lines.slice(closeIndex + 1).join("\n") };
}

export function parseSliceDoc(markdown: string): SliceDoc {
  const { fields, body } = splitFrontmatter(markdown);
  const legacyMatch = body.match(STATUS_LINE);
  const frontmatterStatus = fields.get("status");
  const status = frontmatterStatus
    ? frontmatterStatus.toLowerCase()
    : legacyMatch
      ? legacyMatch[1].trim().toLowerCase()
      : null;
  const splitFromRaw = fields.get("split-from");
  return {
    raw: markdown,
    status,
    version: parseVersion(fields.get("version")),
    splitFrom: splitFromRaw ? parseSliceRef(splitFromRaw) : null,
    mergedFrom: parseSliceRefList(fields.get("merged-from")),
    supersededBy: parseSliceRefList(fields.get("superseded-by")),
    html: marked.parse(body, { async: false }) as string,
  };
}
