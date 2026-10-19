// SPDX-License-Identifier: MIT
// `em storyline suggest <model>` (GH #290): advisory, read-only. Proposes `storyline` blocks (GH #277)
// for a model written before they existed and prints them as a unified diff the user applies by
// hand (`patch -p0`, `git apply`) — it never writes the model.
//
// Grouping, in this order, over the slices not already inside a storyline block:
//  1. one storyline per distinct slice `source "url"` (the slices sharing that URL);
//  2. the remaining slices by the view-instance chains they feed: a read model with at least one
//     `view … again` instance links its originating slice, every `again` slice and the slices
//     declaring the events any instance is built from. A chain that touches exactly one `source`
//     group joins it; otherwise it becomes a storyline of its own;
//  3. a slice that fits neither stays outside every storyline (and keeps the advisory
//     `slice-outside-storyline` warning once any storyline exists).
// A group whose slices are not adjacent in the file becomes several blocks with the same name — the
// grammar's "a repeated name continues the storyline" — `source` only on the first.

import { isAbsolute, relative, resolve, basename, sep } from "node:path";
import { NormalizedModel, normalizeName } from "../model/model.js";

export interface SuggestedStoryline {
  name: string;
  source?: string;
  /** Indexes into `model.slices`, ascending. */
  sliceIndexes: number[];
  basis: "source" | "view-chain";
}

export interface StorylineSuggestion {
  storylines: SuggestedStoryline[];
  /** Slices left outside every storyline. */
  ungrouped: number[];
  /** Unified diff against the model text; "" when nothing is proposed. */
  patch: string;
}

function nameFromUrl(url: string): string {
  const frag = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const last = url.split("#")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const raw = (frag || last).replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").trim();
  if (raw === "") return "Storyline";
  return /^[a-z]/.test(raw) ? raw[0].toUpperCase() + raw.slice(1) : raw;
}

export function suggestStorylines(model: NormalizedModel): { storylines: SuggestedStoryline[]; ungrouped: number[] } {
  const n = model.slices.length;
  const free = (i: number): boolean => model.slices[i].storyline === undefined;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  // View-instance chains.
  for (const origin of model.elements) {
    if (origin.kind !== "view" || origin.again === true) continue;
    const instances = model.elements.filter((e) => e.kind === "view" && e.again === true && e.logicalId === origin.id);
    if (instances.length === 0) continue;
    for (const inst of [origin, ...instances]) {
      union(origin.sliceIndex, inst.sliceIndex);
      for (const evName of inst.from ?? []) {
        for (const ev of model.byName.get(normalizeName(evName)) ?? []) if (ev.kind === "event") union(origin.sliceIndex, ev.sliceIndex);
      }
    }
  }

  const taken = new Set((model.storylines ?? []).map((s) => s.name.toLowerCase()));
  const unique = (base: string): string => {
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base} (${k})`;
    taken.add(name.toLowerCase());
    return name;
  };

  const bySource = new Map<string, SuggestedStoryline>();
  const sourceOf = (i: number): string | undefined => model.slices[i].source;
  const out: SuggestedStoryline[] = [];
  const sourceName = (url: string): string => {
    let g = bySource.get(url);
    if (!g) {
      g = { name: unique(nameFromUrl(url)), source: url, sliceIndexes: [], basis: "source" };
      bySource.set(url, g);
      out.push(g);
    }
    return g.name;
  };

  // Component -> the distinct sources among its free slices.
  const componentSources = new Map<number, Set<string>>();
  for (let i = 0; i < n; i++) {
    const src = sourceOf(i);
    if (!free(i) || src === undefined) continue;
    const set = componentSources.get(find(i)) ?? new Set<string>();
    set.add(src);
    componentSources.set(find(i), set);
  }

  const groupOf = new Map<number, string>(); // slice index -> storyline name
  const chainGroups = new Map<number, SuggestedStoryline>();
  const componentSize = new Map<number, number>();
  for (let i = 0; i < n; i++) if (free(i)) componentSize.set(find(i), (componentSize.get(find(i)) ?? 0) + 1);
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    const src = sourceOf(i);
    if (src !== undefined) {
      groupOf.set(i, sourceName(src));
      continue;
    }
    const srcs = componentSources.get(find(i));
    if (srcs !== undefined && srcs.size === 1) {
      groupOf.set(i, sourceName([...srcs][0]));
      continue;
    }
    if ((componentSize.get(find(i)) ?? 0) > 1) {
      let g = chainGroups.get(find(i));
      if (!g) {
        g = { name: unique(`${model.slices[i].name} journey`), sliceIndexes: [], basis: "view-chain" };
        chainGroups.set(find(i), g);
        out.push(g);
      }
      groupOf.set(i, g.name);
    }
  }
  const byName = new Map(out.map((g) => [g.name, g]));
  for (const [i, name] of [...groupOf].sort((a, b) => a[0] - b[0])) byName.get(name)!.sliceIndexes.push(i);
  const ungrouped: number[] = [];
  for (let i = 0; i < n; i++) if (free(i) && !groupOf.has(i)) ungrouped.push(i);
  return { storylines: out.filter((g) => g.sliceIndexes.length > 0), ungrouped };
}

/** Index (0-based) of the line holding the `}` that closes the block opened on `start`. */
function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    let inStr = false;
    for (let c = 0; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (inStr) {
        if (ch === "\\") c++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "#") break;
      else if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i;
  }
  return lines.length - 1;
}

/** The path used in the diff headers: relative to the cwd, no leading `./`, never absolute (`git apply`
 *  rejects `a/./x.em` and `a//abs/x.em`). A file outside the cwd falls back to its basename. */
export function diffPath(file: string): string {
  let rel = isAbsolute(file) || file.startsWith(".") ? relative(process.cwd(), resolve(file)) : file;
  if (rel.startsWith("..") || isAbsolute(rel)) rel = basename(file);
  return rel.split(sep).join("/").replace(/^(\.\/)+/, "");
}

type Op = { t: " " | "-" | "+"; text: string };

/** Unified diff of `ops` (every original line appears as " " or "-"), 3 lines of context. */
function unifiedDiff(file: string, ops: Op[]): string {
  const CONTEXT = 3;
  const changed = ops.map((o) => o.t !== " ");
  const hunks: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    const lo = Math.max(0, i - CONTEXT);
    const hi = Math.min(ops.length - 1, i + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = hi;
    else hunks.push([lo, hi]);
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [lo, hi] of hunks) {
    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < lo; i++) {
      if (ops[i].t !== "+") oldStart++;
      if (ops[i].t !== "-") newStart++;
    }
    const slice = ops.slice(lo, hi + 1);
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldLen === 0 ? oldStart - 1 : oldStart},${oldLen} +${newLen === 0 ? newStart - 1 : newStart},${newLen} @@`);
    for (const o of slice) out.push(o.t + o.text);
  }
  return out.join("\n") + "\n";
}

/** `model` compiled from `text` (the file named `file` in the diff headers). */
export function buildStorylineSuggestion(model: NormalizedModel, text: string, file: string): StorylineSuggestion {
  const { storylines, ungrouped } = suggestStorylines(model);
  if (storylines.length === 0) return { storylines, ungrouped, patch: "" };
  const crlf = text.includes("\r\n");
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();

  // A run may only span slices with nothing but blank lines and `#` comments between them: any other
  // top-level line (a `persona`, a `context`...) is not legal inside a storyline block, so it splits
  // the run into two same-name blocks.
  const gapIsClean = (a: number, b: number): boolean => {
    const from = blockEnd(lines, model.slices[a].line - 1) + 1;
    for (let i = from; i < model.slices[b].line - 1; i++) {
      const t = lines[i].trim();
      if (t !== "" && !t.startsWith("#")) return false;
    }
    return true;
  };

  // Contiguous runs (by slice index) per storyline.
  const runs: Array<{ story: SuggestedStoryline; first: number; last: number; continues: boolean }> = [];
  for (const story of storylines) {
    let k = 0;
    while (k < story.sliceIndexes.length) {
      let j = k;
      while (
        j + 1 < story.sliceIndexes.length &&
        story.sliceIndexes[j + 1] === story.sliceIndexes[j] + 1 &&
        gapIsClean(story.sliceIndexes[j], story.sliceIndexes[j + 1])
      )
        j++;
      runs.push({ story, first: story.sliceIndexes[k], last: story.sliceIndexes[j], continues: k > 0 });
      k = j + 1;
    }
  }
  runs.sort((a, b) => a.first - b.first);

  const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const ops: Op[] = [];
  let cursor = 0;
  for (const run of runs) {
    const start = model.slices[run.first].line - 1;
    const end = blockEnd(lines, model.slices[run.last].line - 1);
    for (; cursor < start; cursor++) ops.push({ t: " ", text: lines[cursor] });
    ops.push({ t: "+", text: `storyline ${quote(run.story.name)}${!run.continues && run.story.source !== undefined ? ` source ${quote(run.story.source)}` : ""} {` });
    for (let i = start; i <= end; i++) ops.push({ t: "-", text: lines[i] });
    for (let i = start; i <= end; i++) ops.push({ t: "+", text: lines[i].trim() === "" ? lines[i] : `  ${lines[i]}` });
    ops.push({ t: "+", text: "}" });
    cursor = end + 1;
  }
  for (; cursor < lines.length; cursor++) ops.push({ t: " ", text: lines[cursor] });
  let patch = unifiedDiff(diffPath(file), ops);
  if (crlf) patch = patch.replace(/\n/g, "\r\n");
  return { storylines, ungrouped, patch };
}
