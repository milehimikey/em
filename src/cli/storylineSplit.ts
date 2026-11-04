// SPDX-License-Identifier: MIT
// `em storyline split <root>.em [--storyline <name>] [--dry-run] [--force]` (GH #421): the upgrade
// path from inline `storyline "X" { … }` blocks to storyline model files. For each inline block
// it writes `<slug>/<slug>.em` — a `storyline "X" [source "…"]` header, a blank line, then the
// block's slice lines dedented by the block's own indentation, byte for byte otherwise — and
// replaces the block in the root with the one-line declaration `storyline "X" [after "Y"]` (plus
// `in "…"` only when the file path is not the default). Slice docs stay where they are (step 1
// of #421 keeps `slices/` under the root), so nothing about ratification, hashes or bindings
// moves. A storyline declared in several blocks (a reopened storyline) is refused: moving its
// later slices next to its first block would change the timeline.
//
// Pure planning (`planStorylineSplit`) over the root text; the CLI writes.

import { NormalizedModel } from "../model/model.js";
import { lastIndexOfUnquoted, stripComment } from "../parser/lexer.js";
import { kebabSlug } from "../util/slug.js";

export interface SplitFile {
  /** Posix path relative to the root's directory. */
  path: string;
  content: string;
  storyline: string;
}

export interface SplitPlan {
  files: SplitFile[];
  /** The root text with every split block replaced by its declaration line. */
  rootText: string;
  /** Storylines left alone, with the reason. */
  skipped: { storyline: string; reason: string }[];
}

interface Block {
  name: string;
  start: number; // 0-based line index of the header
  end: number; // 0-based line index of the closing `}`
}

/** Count `{` minus `}` outside quotes/comments on one line. */
function braceDelta(raw: string): number {
  const line = stripComment(raw);
  let delta = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === "\\") i++;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

/** Every inline storyline block in `rootText`, by scanning braces the way the parser nests them. */
function findBlocks(rootText: string): Block[] {
  const lines = rootText.split(/\r?\n/);
  const blocks: Block[] = [];
  let open: { name: string; start: number; depth: number } | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = stripComment(lines[i]).trim();
    if (depth === 0 && /^storyline\b/.test(text) && lastIndexOfUnquoted(text, "{") >= 0) {
      const header = text.slice("storyline".length, lastIndexOfUnquoted(text, "{")).trim();
      open = { name: storylineNameOf(header), start: i, depth };
    }
    depth += braceDelta(lines[i]);
    if (open && depth === open.depth && text.startsWith("}")) {
      blocks.push({ name: open.name, start: open.start, end: i });
      open = null;
    }
  }
  return blocks;
}

/** The storyline name out of a header's text (quoted, or the bare words before the first clause). */
function storylineNameOf(header: string): string {
  if (header.startsWith('"')) {
    const close = header.indexOf('"', 1);
    return close > 0 ? header.slice(1, close) : header;
  }
  const m = /^(.*?)(?:\s+(?:source|after|in)\s+")/.exec(header);
  return (m ? m[1] : header).trim();
}

/** A quoted string literal the parser reads back verbatim. */
const q = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

export function planStorylineSplit(model: NormalizedModel, rootText: string, only?: string): SplitPlan {
  const eol = eolOf(rootText);
  const lines = rootText.split(/\r?\n/);
  const blocks = findBlocks(rootText);
  const files: SplitFile[] = [];
  const skipped: SplitPlan["skipped"] = [];
  const replacements: { start: number; end: number; line: string }[] = [];
  const wanted = only === undefined ? undefined : only.trim().toLowerCase();
  for (const st of model.storylines ?? []) {
    if (wanted !== undefined && st.name.trim().toLowerCase() !== wanted) continue;
    if (st.file !== undefined) {
      skipped.push({ storyline: st.name, reason: `already a storyline model (${st.file})` });
      continue;
    }
    const mine = blocks.filter((b) => b.name.trim().toLowerCase() === st.name.trim().toLowerCase());
    if (mine.length === 0) {
      skipped.push({ storyline: st.name, reason: "its block was not found in the root text" });
      continue;
    }
    if (mine.length > 1) {
      skipped.push({ storyline: st.name, reason: `declared in ${mine.length} blocks (a reopened storyline); moving its later slices next to the first block would change the timeline — merge the blocks by hand first` });
      continue;
    }
    const b = mine[0];
    const body = lines.slice(b.start + 1, b.end);
    const indents = body.filter((l) => l.trim().length > 0).map((l) => /^[ \t]*/.exec(l)![0].length);
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    const dedented = body.map((l) => (l.trim().length > 0 ? l.slice(indent) : l.replace(/^[ \t]+$/, "")));
    const slug = kebabSlug(st.name);
    const path = `${slug}/${slug}.em`;
    const header = `storyline ${q(st.name)}${st.source !== undefined ? ` source ${q(st.source)}` : ""}`;
    files.push({ path, storyline: st.name, content: [header, "", ...dedented].join(eol).replace(/(\r?\n)*$/, "") + eol });
    replacements.push({ start: b.start, end: b.end, line: `storyline ${q(st.name)}${st.after !== undefined ? ` after ${q(st.after)}` : ""}` });
  }
  const out = [...lines];
  for (const r of [...replacements].sort((x, y) => y.start - x.start)) out.splice(r.start, r.end - r.start + 1, r.line);
  return { files, rootText: out.join(eol), skipped };
}
