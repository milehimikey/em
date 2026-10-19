// SPDX-License-Identifier: MIT
// GH #290 stage 2: the two `.em`-rewriting `em upgrade` steps.
//   - collapse-alternative-events (GH #278): adjacent slices that repeat ONE command and differ only
//     in the event they record (the column-per-event shape) become one slice recording
//     `event A | B @Ctx` (identical payloads) or `oneof { … }` (per-event payloads/clauses).
//   - fold-continuations (GH #287): hand-named continuation slices (only `view … again` lines plus
//     their `ui`) that directly follow their host command slice become `view X again … [shown on
//     "Screen"]` lines inside the host slice (the synthesized `<host>--again` column).
// Both are TEXT rewrites: the slice blocks are located from the compiled model's line numbers,
// everything outside the touched blocks is copied verbatim, and nothing is written unless the
// rewritten text compiles with no error the original did not have and keeps the facts the rewrite
// must not change (event names; the union of events each read model is built from).

import { compile } from "../pipeline.js";
import { NormalizedModel, Element, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { againInstancesOf, continuationOf } from "../model/continuation.js";
import { blockEnd } from "./storylineSuggest.js";
import { encodeQuoted } from "../parser/lexer.js";

interface SliceBlock {
  index: number;
  start: number; // 0-based header line
  end: number; // 0-based closing-brace line
  elements: Array<{ el: Element; first: number; last: number }>;
}

function splitLines(text: string): { lines: string[]; eol: string; trailing: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const trailing = lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, eol, trailing };
}

function joinLines(lines: string[], eol: string, trailing: boolean): string {
  return lines.join(eol) + (trailing ? eol : "");
}

/** The slice's block and its elements' line spans, or null when the layout is not safely readable
 *  (two elements on one line, an element outside the block). */
function blockOf(model: NormalizedModel, lines: string[], index: number): SliceBlock | null {
  const slice = model.slices[index];
  if (slice.synthesized) return null;
  const start = slice.line - 1;
  const end = blockEnd(lines, start);
  const els = model.elements.filter((e) => e.sliceIndex === index).sort((a, b) => a.line - b.line);
  const out: SliceBlock["elements"] = [];
  for (let k = 0; k < els.length; k++) {
    const first = els[k].line - 1;
    if (first <= start || first >= end) return null;
    if (k > 0 && first === els[k - 1].line - 1) return null;
    let last = (k + 1 < els.length ? els[k + 1].line - 1 : end) - 1;
    while (last > first && lines[last].trim() === "") last--;
    out.push({ el: els[k], first, last });
  }
  return { index, start, end, elements: out };
}

const norm = (ls: string[]): string => ls.map((l) => l.trim()).filter((l) => l !== "").join("\n");
// a `note "…"` binding is compared by hasNote(), not by text: only the first slice may carry one
const spanText = (lines: string[], s: { first: number; last: number }): string => norm(lines.slice(s.first, s.last + 1)).replace(/\s+note\s+"(?:[^"\\]|\\.)*"/g, "");
const hasNote = (b: SliceBlock): boolean => b.elements.some((s) => s.el.note !== undefined || s.el.issue !== undefined || s.el.divergence !== undefined);

function errorCounts(src: string): Map<string, number> | null {
  try {
    const m = new Map<string, number>();
    for (const d of compile(src).diagnostics) if (d.severity === "error") m.set(d.code, (m.get(d.code) ?? 0) + 1);
    return m;
  } catch {
    return null;
  }
}

/** No error code occurs more often in `next` than in `prev`, and `next` parses. */
function noNewErrors(prev: string, next: string): boolean {
  const a = errorCounts(prev);
  const b = errorCounts(next);
  if (a === null || b === null) return false;
  for (const [code, n] of b) if (n > (a.get(code) ?? 0)) return false;
  return true;
}

/** viewName -> the events its originating instance and every `again` instance are built from. */
function viewSourcesUnion(model: NormalizedModel): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const el of model.elements) {
    if (el.kind !== "view" || el.again === true) continue;
    const names = new Set<string>();
    for (const inst of [el, ...againInstancesOf(model, el)]) for (const n of inst.from ?? []) names.add(normalizeName(n));
    out.set(normalizeName(el.name), [...names].sort());
  }
  return out;
}

// ---- collapse-alternative-events ----------------------------------------------------------

export interface CollapseGroup {
  /** Slice names, first (kept) first. */
  slices: string[];
  /** Export keys of the slices, first (kept) first. */
  keys: string[];
  events: string[];
  form: "inline" | "oneof";
}

export interface CollapsePlan {
  groups: CollapseGroup[];
  next: string;
}

export function planCollapseAlternativeEvents(model: NormalizedModel, refs: RefsResult, text: string): CollapsePlan | null {
  const { lines, eol, trailing } = splitLines(text);
  const blocks = model.slices.map((_, i) => blockOf(model, lines, i));
  const shape = (b: SliceBlock | null) => {
    if (b === null) return null;
    const cmds = b.elements.filter((s) => s.el.kind === "command");
    const evs = b.elements.filter((s) => s.el.kind === "event");
    const rest = b.elements.filter((s) => s.el.kind !== "command" && s.el.kind !== "event" && s.el.kind !== "ui");
    if (cmds.length !== 1 || evs.length !== 1 || rest.length > 0) return null;
    if (evs[0].el.alternativeGroup !== undefined) return null;
    return { cmd: cmds[0], ev: evs[0], uis: b.elements.filter((s) => s.el.kind === "ui") };
  };
  const mergeable = (a: number, b: number): boolean => {
    const x = blocks[a], y = blocks[b];
    const sa = shape(x), sb = shape(y);
    if (!x || !y || !sa || !sb) return false;
    if (model.slices[b].synthesized || model.slices[a + 1]?.synthesized) return false;
    if (model.slices[a].storyline !== model.slices[b].storyline) return false;
    if (hasNote(y) || (model.slices[b].source !== undefined && model.slices[b].source !== model.slices[a].source)) return false;
    if (spanText(lines, sa.cmd) !== spanText(lines, sb.cmd)) return false;
    if (sa.uis.map((s) => spanText(lines, s)).sort().join("\n") !== sb.uis.map((s) => spanText(lines, s)).sort().join("\n")) return false;
    if (sa.ev.el.context !== sb.ev.el.context) return false;
    for (let k = y.start - 1; k > x.end; k--) if (lines[k].trim() !== "" && !lines[k].trim().startsWith("#")) return false; // a declaration between
    return true;
  };

  const runs: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < model.slices.length; ) {
    let j = i;
    const names = new Set<string>();
    const si = shape(blocks[i]);
    if (si) names.add(normalizeName(si.ev.el.name));
    while (si && j + 1 < model.slices.length && mergeable(i, j + 1)) {
      const nm = normalizeName(shape(blocks[j + 1])!.ev.el.name);
      if (names.has(nm)) break;
      names.add(nm);
      j++;
    }
    if (j > i) runs.push({ first: i, last: j });
    i = j + 1;
  }
  if (runs.length === 0) return null;

  const groups: CollapseGroup[] = [];
  let out = lines.slice();
  for (const run of runs.slice().reverse()) {
    const members = Array.from({ length: run.last - run.first + 1 }, (_, k) => run.first + k);
    const first = blocks[run.first]!;
    const evSpans = members.map((i) => shape(blocks[i])!.ev);
    const names = evSpans.map((s) => s.el.name);
    const normalised = evSpans.map((s, k) => {
      const l = lines.slice(s.first, s.last + 1);
      l[0] = l[0].replace(`event ${names[k]}`, "event §");
      return norm(l);
    });
    const inline = normalised.every((n) => n === normalised[0]);
    const e0 = evSpans[0];
    const indent = /^\s*/.exec(lines[e0.first])![0];
    let replacement: string[];
    if (inline) {
      replacement = lines.slice(e0.first, e0.last + 1);
      replacement[0] = replacement[0].replace(`event ${names[0]}`, `event ${names.join(" | ")}`);
    } else {
      replacement = [`${indent}oneof {`];
      for (const s of evSpans) for (const l of lines.slice(s.first, s.last + 1)) replacement.push(l.trim() === "" ? l : `  ${l}`);
      replacement.push(`${indent}}`);
    }
    const keep: string[] = [];
    for (const m of members.slice(0, -1)) {
      for (let i = blocks[m]!.end + 1; i < blocks[m + 1]!.start; i++) if (lines[i].trim().startsWith("#")) keep.push(lines[i]); // comments between the merged slices stay
    }
    const head = lines.slice(first.start, e0.first).concat(replacement, lines.slice(e0.last + 1, first.end + 1));
    out = out.slice(0, first.start).concat(head, keep, out.slice(blocks[run.last]!.end + 1));
    groups.unshift({
      slices: members.map((i) => model.slices[i].name),
      keys: members.map((i) => refs.sliceKeys[i]),
      events: names,
      form: inline ? "inline" : "oneof",
    });
  }
  const next = joinLines(out, eol, trailing);
  if (!noNewErrors(text, next)) return null;
  // The recorded facts must not change: the same event names, in the same order.
  const before = model.elements.filter((e) => e.kind === "event").map((e) => e.name);
  const after = compile(next).model.elements.filter((e) => e.kind === "event").map((e) => e.name);
  if (before.join("\u0000") !== after.join("\u0000")) return null;
  if (!viewSourcesEqual(model, compile(next).model)) return null;
  return { groups, next };
}

function viewSourcesEqual(a: NormalizedModel, b: NormalizedModel): boolean {
  const x = viewSourcesUnion(a), y = viewSourcesUnion(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if ((y.get(k) ?? []).join("\u0000") !== v.join("\u0000")) return false;
  return true;
}

// ---- fold-continuations -------------------------------------------------------------------

export interface FoldGroup {
  host: string;
  hostKey: string;
  /** Hand-named continuation slices folded into the host, in file order. */
  folded: string[];
  foldedKeys: string[];
}

export interface FoldPlan {
  groups: FoldGroup[];
  /** Hosts left unfolded, with why. */
  refused: Array<{ host: string; hostKey: string; reason: string }>;
  next: string;
}

const FROM_LIST = /\bfrom\s+"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*/;

export function planFoldContinuations(model: NormalizedModel, refs: RefsResult, text: string): FoldPlan | null {
  const { lines, eol, trailing } = splitLines(text);
  const blocks = model.slices.map((_, i) => blockOf(model, lines, i));
  const groups: FoldGroup[] = [];
  const refused: FoldPlan["refused"] = [];
  const removals: Array<{ from: number; to: number }> = [];
  const insertions = new Map<number, string[]>(); // host block end line -> lines to insert before it
  const folded = new Set<number>();

  const uiDeclaredElsewhere = (name: string, persona: string | undefined, excluding: Set<number>): boolean =>
    model.elements.some((e) => e.kind === "ui" && normalizeName(e.name) === normalizeName(name) && e.persona === persona && !excluding.has(e.sliceIndex));

  for (let h = 0; h < model.slices.length; h++) {
    const hb = blocks[h];
    if (!hb || folded.has(h) || continuationOf(model, refs, h) !== null) continue;
    if (!hb.elements.some((s) => s.el.kind === "command")) continue;
    const hostEvents = new Set(hb.elements.filter((s) => s.el.kind === "event").map((s) => normalizeName(s.el.name)));
    const hostUi = hb.elements.find((s) => s.el.kind === "ui")?.el;
    const members: number[] = [];
    const added: string[] = [];
    let c = h + 1;
    while (c < model.slices.length) {
      if (model.slices[c].synthesized) {
        if (model.slices[c].synthesized!.host === h) {
          c++;
          continue;
        }
        break;
      }
      const cb = blocks[c];
      if (!cb || continuationOf(model, refs, c) === null) break;
      if (model.slices[c].storyline !== model.slices[h].storyline || hasNote(cb)) break;
      const uis = cb.elements.filter((s) => s.el.kind === "ui");
      const views = cb.elements.filter((s) => s.el.kind === "view");
      const trial = new Set([...folded, ...members, c]);
      const out: string[] = [];
      let ok = views.length > 0;
      for (const v of views) {
        const first = lines[v.first];
        const from = v.el.from ?? [];
        if (!from.some((n) => hostEvents.has(normalizeName(n))) || !FROM_LIST.test(first)) {
          ok = false;
          break;
        }
        const span = lines.slice(v.first, v.last + 1);
        const shownOn = /\bshown\s+on\s+"((?:[^"\\]|\\.)*)"/.exec(span.join("\n"));
        if (shownOn) {
          const u = model.elements.find((e) => e.kind === "ui" && e.sliceIndex === c && normalizeName(e.name) === normalizeName(shownOn[1]));
          if (!u || !uiDeclaredElsewhere(u.name, u.persona, trial)) ok = false;
        } else if (uis.length === 1) {
          const u = uis[0].el;
          const sameAsHost = hostUi !== undefined && normalizeName(hostUi.name) === normalizeName(u.name) && hostUi.persona === u.persona;
          if (!sameAsHost) {
            if (!uiDeclaredElsewhere(u.name, u.persona, trial)) ok = false;
            else span[0] = span[0].replace(FROM_LIST, (m) => `${m} shown on "${encodeQuoted(u.name)}"`);
          }
        } else ok = false; // no consumer, or several screens the old wiring cannot be reproduced for
        if (!ok) break;
        out.push(...span);
      }
      if (!ok) break;
      members.push(c);
      added.push(...out);
      c++;
    }
    if (members.length === 0) continue;
    // Continuations of several views would be re-joined to ONE host column, moving another view's
    // instance into the first view's (possibly signed) doc: refuse the host, leave it unfolded.
    const views = new Set(members.flatMap((m) => blocks[m]!.elements.filter((s) => s.el.kind === "view").map((s) => s.el.logicalId)));
    if (views.size > 1) {
      refused.push({ host: model.slices[h].name, hostKey: refs.sliceKeys[h], reason: "continuations of several views — fold by hand or keep the stacked slice" });
      continue;
    }
    for (const m of members) folded.add(m);
    insertions.set(hb.end, added);
    for (const m of members) {
      const b = blocks[m]!;
      removals.push({ from: b.start > 0 && lines[b.start - 1].trim() === "" ? b.start - 1 : b.start, to: b.end });
    }
    groups.push({
      host: model.slices[h].name,
      hostKey: refs.sliceKeys[h],
      folded: members.map((m) => model.slices[m].name),
      foldedKeys: members.map((m) => refs.sliceKeys[m]),
    });
  }
  if (groups.length === 0) return refused.length > 0 ? { groups, refused, next: text } : null; // nothing to fold, but say why

  const drop = new Set<number>();
  for (const r of removals) for (let i = r.from; i <= r.to; i++) drop.add(i);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ins = insertions.get(i);
    if (ins) out.push(...ins);
    if (!drop.has(i)) out.push(lines[i]);
  }
  const next = joinLines(out, eol, trailing);
  if (!noNewErrors(text, next)) return null;
  const nm = compile(next).model;
  if (!viewSourcesEqual(model, nm)) return null;
  return { groups, refused, next };
}

// ---- fold-continuations, default form (a): stack consecutive continuations of ONE view ----------

export interface StackGroup {
  /** The kept slice (first of the run): its name and export key stay. */
  kept: string;
  keptKey: string;
  /** The slices whose `view … again` lines moved into the kept slice, and their (now dropped) keys. */
  dropped: string[];
  droppedKeys: string[];
}

export interface StackPlan {
  groups: StackGroup[];
  /** Consecutive continuations left alone because they continue a different view (stacking them
   *  would change which view the slice is a continuation of, i.e. `continuationOf` and the doc join). */
  skipped: Array<{ key: string; reason: string }>;
  next: string;
}

/**
 * Consecutive hand-named continuation slices that continue the SAME read model (the first `view …
 * again` of each names one originating view, and so do all their lines) and show the same `ui`s
 * become ONE continuation slice with stacked `again` lines (GH #287, "several `again` lines in one
 * continuation slice"), keeping the FIRST slice's name and key. Nothing about which view the slice
 * continues changes, so `continuationOf`, the doc join and the kept key's index row are exact;
 * the dropped keys are reported. Continuations of different views are never stacked.
 */
export function planStackContinuations(model: NormalizedModel, refs: RefsResult, text: string): StackPlan | null {
  const { lines, eol, trailing } = splitLines(text);
  const blocks = model.slices.map((_, i) => blockOf(model, lines, i));
  const groups: StackGroup[] = [];
  const skipped: StackPlan["skipped"] = [];
  const removals: Array<{ from: number; to: number }> = [];
  const insertions = new Map<number, string[]>();
  const uiSig = (b: SliceBlock): string => b.elements.filter((s) => s.el.kind === "ui").map((s) => `${normalizeName(s.el.name)}@${s.el.persona}`).sort().join(",");
  const viewIds = (b: SliceBlock): string[] => b.elements.filter((s) => s.el.kind === "view").map((s) => s.el.logicalId);
  const isCont = (i: number): boolean => !model.slices[i].synthesized && blocks[i] !== null && continuationOf(model, refs, i) !== null && !hasNote(blocks[i]!);

  for (let c = 0; c < model.slices.length; c++) {
    if (!isCont(c)) continue;
    const head = blocks[c]!;
    const origin = viewIds(head)[0];
    const run = [c];
    for (let n = c + 1; n < model.slices.length && isCont(n); n++) {
      const b = blocks[n]!;
      if (model.slices[n].storyline !== model.slices[c].storyline) break;
      if (viewIds(head).some((v) => v !== origin) || viewIds(b).some((v) => v !== origin)) {
        skipped.push({ key: refs.sliceKeys[n], reason: "continues a different view" });
        break;
      }
      if (uiSig(b) !== uiSig(head)) break;
      let gapClean = true;
      for (let k = blocks[run[run.length - 1]]!.end + 1; k < b.start; k++) if (lines[k].trim() !== "" && !lines[k].trim().startsWith("#")) gapClean = false;
      if (!gapClean) break;
      run.push(n);
    }
    if (run.length < 2) {
      // a different-view neighbour is reported once, and is not the start of another run
      continue;
    }
    const added: string[] = [];
    for (const n of run.slice(1)) {
      for (const v of blocks[n]!.elements.filter((s) => s.el.kind === "view")) added.push(...lines.slice(v.first, v.last + 1));
      removals.push({ from: blocks[n]!.start > 0 && lines[blocks[n]!.start - 1].trim() === "" ? blocks[n]!.start - 1 : blocks[n]!.start, to: blocks[n]!.end });
    }
    insertions.set(head.end, added);
    groups.push({
      kept: model.slices[c].name,
      keptKey: refs.sliceKeys[c],
      dropped: run.slice(1).map((n) => model.slices[n].name),
      droppedKeys: run.slice(1).map((n) => refs.sliceKeys[n]),
    });
    c = run[run.length - 1];
  }
  if (groups.length === 0) return null;
  const drop = new Set<number>();
  for (const r of removals) for (let i = r.from; i <= r.to; i++) drop.add(i);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ins = insertions.get(i);
    if (ins) out.push(...ins);
    if (!drop.has(i)) out.push(lines[i]);
  }
  const next = joinLines(out, eol, trailing);
  if (!noNewErrors(text, next)) return null;
  const after = compile(next);
  if (!viewSourcesEqual(model, after.model)) return null;
  // The kept slices must still be continuations of the same originating slice.
  for (const g of groups) {
    const before = model.slices.findIndex((_, i) => refs.sliceKeys[i] === g.keptKey);
    const idx = after.refs.sliceKeys.indexOf(g.keptKey);
    const was = continuationOf(model, refs, before);
    const now = idx === -1 ? null : continuationOf(after.model, after.refs, idx);
    if (!was || !now || was.sliceKey !== now.sliceKey) return null;
  }
  return { groups, skipped, next };
}
