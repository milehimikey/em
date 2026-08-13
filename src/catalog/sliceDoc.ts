// SPDX-License-Identifier: MIT
// Parses a slice design doc (slices/<slice-name>.md, see
// .claude/skills/event-modeling/templates/slice.md) for `em catalog`. `em`
// has never parsed this markdown structurally before — it only checked the
// file exists (cli.ts's warnMissingNotes). This is deliberately shallow: pull
// the one status value the index page needs, and render the doc body as HTML
// for the per-slice detail page. Pure — no fs access; the caller reads the
// file and hands us its text.
//
// Two status dialects: a leading YAML frontmatter block (`status: ...`) is
// canonical (MIL-86); a `- **Status:** ...` bullet line is legacy/accepted
// input for docs written before the frontmatter dialect existed. Frontmatter
// wins when both are somehow present. No `yaml` dependency — the 1.1.1 revert
// (6de0a05) dropped it on purpose; frontmatter is a plain top-level-scalar
// line-scan, same spirit as the bullet-line regex it now sits alongside.

import { marked } from "marked";

export interface SliceDoc {
  /** The doc's raw markdown, as read from disk. */
  raw: string;
  /** Lowercased status value from frontmatter `status:` (canonical) or a legacy
   *  `- **Status:** ...` bullet line, or null if neither is found (a freeform
   *  doc that doesn't follow the slice.md template). */
  status: string | null;
  /** The whole doc rendered to HTML, with any leading frontmatter block stripped
   *  first (otherwise its `---` fences render as stray <hr>s and the raw
   *  `key: value` lines leak into the body). */
  html: string;
}

const STATUS_LINE = /^-\s*\*\*Status:\*\*\s*(.+?)\s*$/im;

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
  return {
    raw: markdown,
    status,
    html: marked.parse(body, { async: false }) as string,
  };
}
