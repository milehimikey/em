// SPDX-License-Identifier: MIT
// GH #487: the per-section signature. `ratifiedHash` (sliceDoc.ts) is ONE hash over the whole
// authored body — it says "something changed", never "what". `em slice ratify` therefore also
// records `ratifiedSections:`, a hash per authored `##` section, so a later reader can tell which
// sections moved since sign-off WITHOUT the old body (a `--no-ref` repo keeps only hashes) and
// class each as prose or behaviour — the input `em slice amend` and the ledger build on.
//
// Additive: `ratifiedHash` keeps its exact meaning, scope and value. The section hashes use the
// same exclusions: the text inside generated regions (`stripGeneratedRegions`) and the `## Open
// Questions` heading with its `deferred to v<n>` items (`withoutDeferrals`), so `em slice sync` and
// `em slice defer` never move one.
//
// Storage — ONE frontmatter line, `ratifiedSections: <label>=<hash>; <label>=<hash>; …`, entries
// sorted by label (code-point order), so the encoding is deterministic and a re-sign shows up as
// a one-line diff. One line because every writer in cli/*.ts is a surgical single-line splice and
// sliceDoc.ts's parser is line-based (no yaml dependency): a nested block or one key per section
// would need a multi-line splice and a parser change. Labels are the exact heading text, with
// `% = ; # " ' \` and control characters percent-escaped so the value survives the parser's
// quote-stripping and any real YAML reader's comment rule. Each hash is the first 16 hex digits
// (64 bits) of sha256 over the section text: the section hashes only CLASSIFY a change, the full
// `ratifiedHash` remains the integrity check, and the shorter value keeps a 10-section line
// readable.
//
// Section model: the body (generated regions emptied) split at column-0 `## ` headings, skipping
// fenced code and multi-line HTML comments; the text before the first heading is the
// `(preamble)` section (title, diagram, story). A section's text is trimmed at both ends. Two
// refinements: a repeated heading's later occurrences are labelled `Heading (2)`, `(3)`; and each
// `- **Consumed by:** …` bullet (with its indented continuation/nested lines) is lifted out of the
// section it sits in into a synthetic `Consumed by` section — it lives under `## Read Model /
// View`, outside the generated region, so it CAN be isolated cleanly. `**Read by:**` (under the
// event section) is NOT lifted: the issue names only "Consumed by", so it stays in its
// behaviour section.

import { createHash } from "node:crypto";
import { splitFrontmatter, stripGeneratedRegions, withoutDeferrals } from "./sliceDoc.js";

export type SectionClass = "prose" | "behaviour";

/** The default prose headings (GH #487). Everything else — including any heading not listed — is
 *  behaviour. `Consumed by` is the synthetic section lifted from the view section's bullets. */
export const DEFAULT_PROSE_HEADINGS: readonly string[] = [
  "Intent",
  "Trigger & Actor",
  "Dependencies & Read Models Affected",
  "Consumed by",
];

export const PREAMBLE_LABEL = "(preamble)";
const OPEN_QUESTIONS_LABEL = "Open Questions";
const CONSUMED_BY_LABEL = "Consumed by";
const CONSUMED_BY_LINE = /^[-*]\s+\*\*Consumed by:?\*\*/i;

export interface SectionStatus {
  heading: string;
  class: SectionClass;
  /** Whether the section's text differs from the sign-off; null when the doc records no section
   *  hashes (ratified before 1.23, or never) — "unknown, treat as behaviour". */
  changed: boolean | null;
}

interface RawSection {
  label: string;
  lines: string[];
}

/** Splits an (already region-stripped) body into labelled sections. */
function splitSections(body: string): RawSection[] {
  const sections: RawSection[] = [{ label: PREAMBLE_LABEL, lines: [] }];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  let inComment = false;
  for (const line of body.split("\n")) {
    const text = line.replace(/\r$/, "");
    const open = /^\s*(```+|~~~+)/.exec(text);
    if (!inComment && open) {
      if (fence === null) fence = open[1][0];
      else if (open[1][0] === fence) fence = null;
    }
    if (fence === null && !open) {
      if (!inComment && /<!--/.test(text) && !/--!?>/.test(text.slice(text.indexOf("<!--")))) inComment = true;
      else if (inComment && /--!?>/.test(text)) inComment = false;
    }
    const heading = fence === null && !inComment && !open ? /^##[ \t]+(\S.*?)[ \t]*$/.exec(text) : null;
    if (heading && !heading[1].startsWith("#")) {
      const base = heading[1].replace(/\s+/g, " ");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      sections.push({ label: n === 1 ? base : `${base} (${n})`, lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/** Moves every `- **Consumed by:**` bullet (plus its indented lines) out of its section. */
function liftConsumedBy(sections: RawSection[]): RawSection[] {
  const lifted: string[] = [];
  const out = sections.map((s) => {
    const kept: string[] = [];
    for (let i = 0; i < s.lines.length; i++) {
      if (!CONSUMED_BY_LINE.test(s.lines[i])) {
        kept.push(s.lines[i]);
        continue;
      }
      lifted.push(s.lines[i]);
      while (i + 1 < s.lines.length && /^\s+\S/.test(s.lines[i + 1])) lifted.push(s.lines[++i]);
    }
    return { label: s.label, lines: kept };
  });
  if (lifted.length > 0) out.push({ label: CONSUMED_BY_LABEL, lines: lifted });
  return out;
}

/** The authored sections of a slice-doc BODY with their exclusion-free text, document order (the
 *  synthetic `Consumed by` section last). An empty preamble, and an `## Open Questions` section
 *  with nothing left after the deferral exclusions, are omitted — so deferring the first question
 *  onto a doc that had no such section adds nothing. */
export function authoredSections(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  for (const s of liftConsumedBy(splitSections(stripGeneratedRegions(body)))) {
    const text = (s.label === OPEN_QUESTIONS_LABEL ? withoutDeferrals([`## ${s.label}`, ...s.lines].join("\n")) : s.lines.join("\n")).trim();
    if (text === "" && (s.label === OPEN_QUESTIONS_LABEL || s.label === PREAMBLE_LABEL)) continue;
    out.push({ heading: s.label, text });
  }
  return out;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Heading -> hash for a whole doc (`markdown` includes the frontmatter). */
export function sectionHashesOf(markdown: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of authoredSections(splitFrontmatter(markdown).body)) map.set(s.heading, shortHash(s.text));
  return map;
}

const ESCAPE = /[%=;#"'\\\x00-\x1f\x7f]/g;
const esc = (label: string): string => label.replace(ESCAPE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const unesc = (label: string): string => label.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The `ratifiedSections:` value for a heading -> hash map: sorted, deterministic, one line. */
export function encodeSectionHashes(hashes: Map<string, string>): string {
  return [...hashes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, hash]) => `${esc(label)}=${hash}`)
    .join("; ");
}

/** Decodes a `ratifiedSections:` value; null when it is empty or malformed (read as absent). */
export function decodeSectionHashes(value: string | null | undefined): Map<string, string> | null {
  if (!value) return null;
  const map = new Map<string, string>();
  for (const entry of value.split("; ")) {
    const m = /^(.+)=([0-9a-f]{16})$/.exec(entry);
    if (!m) return null;
    map.set(unesc(m[1]), m[2]);
  }
  return map.size > 0 ? map : null;
}

/** What `em slice ratify` records as `ratifiedSections:` for the doc as it stands. */
export function ratifiedSectionsValue(markdown: string): string {
  return encodeSectionHashes(sectionHashesOf(markdown));
}

/** The section hashes a doc records, or null when it has none. */
export function recordedSectionHashes(markdown: string): Map<string, string> | null {
  return decodeSectionHashes(splitFrontmatter(markdown).fields.get("ratifiedsections"));
}

function normalizeHeading(h: string): string {
  return h.replace(/ \(\d+\)$/, "").trim().toLowerCase();
}

/**
 * Classify every authored section of `markdown` against its recorded sign-off: `{ heading, class,
 * changed }`. `proseHeadings` (default `DEFAULT_PROSE_HEADINGS`, compared case-insensitively) names
 * the prose sections; every other heading is behaviour. `changed` is `null` for every section when
 * the doc records no section hashes. Otherwise: a section whose text differs from the recorded
 * hash, or that is new since sign-off, is changed; a section recorded at sign-off and gone now is
 * listed too, changed (after the current sections, in label order). A reorder alone changes nothing
 * (labels are sorted in storage); `ratifiedHash` still catches it.
 */
export function classifySections(markdown: string, proseHeadings: readonly string[] = DEFAULT_PROSE_HEADINGS): SectionStatus[] {
  const prose = new Set(proseHeadings.map(normalizeHeading));
  const classOf = (heading: string): SectionClass => (prose.has(normalizeHeading(heading)) ? "prose" : "behaviour");
  const current = sectionHashesOf(markdown);
  const recorded = recordedSectionHashes(markdown);
  const out: SectionStatus[] = [...current.entries()].map(([heading, hash]) => ({
    heading,
    class: classOf(heading),
    changed: recorded === null ? null : recorded.get(heading) !== hash,
  }));
  if (recorded !== null) {
    for (const heading of [...recorded.keys()].filter((h) => !current.has(h)).sort()) {
      out.push({ heading, class: classOf(heading), changed: true });
    }
  }
  return out;
}
