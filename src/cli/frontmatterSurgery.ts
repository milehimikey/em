// SPDX-License-Identifier: MIT
// Shared primitives for surgical in-place slice-doc frontmatter edits — extracted from
// `markImplemented.ts` (MIL-103) when `ratify.ts` (MIL-165) needed the exact same "find one
// field line's byte span, replace only that span, copy everything else through verbatim"
// discipline. Both commands share the same non-negotiable contract: a parse+re-serialize
// through sliceDoc.ts's own (deliberately read-only) parser would silently drop comments, key
// order, spacing, and every field the command isn't allowed to touch — see markImplemented.ts's
// module header for the full rationale, which applies unchanged here.
//
// Pure, fs-free — callers own reading/writing the file, same split as everywhere else in `em`.

/** A field line's matched span within a frontmatter `inner` string: `key[:]<ws>` prefix
 *  (preserved verbatim on write) plus the value text that follows, lowercase-key-matched the
 *  same way sliceDoc.ts's own parser folds keys for lookup. Column-0 only — same grammar as
 *  sliceDoc.ts's `^([A-Za-z][\w-]*):\s*(.*)$`, so this never matches an indented/list-style line
 *  the parser wouldn't treat as a field either. */
export function fieldLineRegex(key: string): RegExp {
  // `[^\r\n]*` (not a lazy `.*?` + `\r?$`) deliberately -- JS regex `$`/multiline line-terminator
  // semantics treat a lone `\r` as its own line boundary, which makes a trailing-`\r?$` anchor
  // ambiguous on CRLF input. Excluding \r/\n from the value class sidesteps that entirely: the
  // match always stops at the first \r or \n, full stop, no boundary-matching subtlety involved.
  return new RegExp(`^(${key}[ \\t]*:[ \\t]*)([^\\r\\n]*)`, "im");
}

/** Strip a value the same way sliceDoc.ts's splitFrontmatter does when reading (surrounding
 *  quotes, then blank-after-trim collapses to "absent") — used here only to classify a *current*
 *  field value for an idempotent/refusal guard, matching what the parser would have reported for
 *  the same text. */
export function normalizeFieldValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().replace(/^["']|["']$/g, "");
  return v === "" ? null : v;
}

/** Byte offsets of the frontmatter block's inner lines (between the two `---` fences), located
 *  by walking lines with `indexOf` rather than `split(/\r?\n/)` — a rewrite can't afford the
 *  line-ending normalization a split/join would silently perform across the WHOLE file the
 *  moment it's written back (fine for a read-only parse, not for a surgical rewrite that must
 *  preserve the body byte-for-byte). `null` when there's no well-formed leading `---`/`---`
 *  fence, mirroring sliceDoc.ts's own "unterminated fence = no frontmatter" treatment. */
export function locateFrontmatterInner(markdown: string): { innerStart: number; innerEnd: number } | null {
  if (!/^---[ \t]*\r?\n/.test(markdown)) return null;
  const innerStart = markdown.indexOf("\n") + 1;
  let pos = innerStart;
  while (pos <= markdown.length) {
    const nl = markdown.indexOf("\n", pos);
    const lineEnd = nl === -1 ? markdown.length : nl;
    const line = markdown.slice(pos, lineEnd);
    if (/^---[ \t]*\r?$/.test(line)) {
      return { innerStart, innerEnd: pos };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}
