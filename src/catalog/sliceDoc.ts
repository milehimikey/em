// SPDX-License-Identifier: MIT
// Parses a slice design doc (slices/<slice-name>.md, see
// .claude/skills/event-modeling/templates/slice.md) for `em catalog`. `em`
// has never parsed this markdown structurally before — it only checked the
// file exists (cli.ts's warnMissingNotes). This is deliberately shallow: pull
// the one bold-label line the index page needs (`- **Status:** ...`) with a
// regex rather than a full frontmatter parser, and render the whole doc body
// as HTML for the per-slice detail page. Pure — no fs access; the caller
// reads the file and hands us its text.

import { marked } from "marked";

export interface SliceDoc {
  /** The doc's raw markdown, as read from disk. */
  raw: string;
  /** Lowercased value of the doc's `- **Status:** ...` line, or null if no such line is found
   *  (a freeform doc that doesn't follow the slice.md template). */
  status: string | null;
  /** The whole doc rendered to HTML. */
  html: string;
}

const STATUS_LINE = /^-\s*\*\*Status:\*\*\s*(.+?)\s*$/im;

export function parseSliceDoc(markdown: string): SliceDoc {
  const match = markdown.match(STATUS_LINE);
  return {
    raw: markdown,
    status: match ? match[1].trim().toLowerCase() : null,
    html: marked.parse(markdown, { async: false }) as string,
  };
}
