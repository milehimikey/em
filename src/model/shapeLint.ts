// SPDX-License-Identifier: MIT
// Advisory "shape" lints (GH #292): patterns that are legal but usually mean a reaction was
// split by outcome instead of modeled as one slice whose command may record several events.
//   - automation-split-by-outcome: sibling reaction slices fed by the same view whose events
//     differ only by an outcome word (Payment Succeeded / Payment Failed).
//   - retry-slice-of: a slice whose command is `Retry <X>` where `<X>` is another command.
// Name matching is on normalised, tokenised names; the outcome vocabulary is a constant list
// (a future config knob — see the PR Decisions).

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { normalizeName } from "./model.js";
import type { Element, NormalizedModel } from "./model.js";
import type { RefsResult } from "./refs.js";
import { viewSourceNames } from "./continuation.js";
import { semanticEdges } from "./edges.js";
import { afterChain, storylineOfSlice } from "./storylines.js";
import { composedRank } from "./storylines.js";
import { pushDiag } from "./rules.js";
import type { Diagnostic } from "./validate.js";

/** Outcome words that mark a failure-ish or non-success branch on their own, normalised
 *  (`timed out` is a two-token phrase). A constant list; a config knob is future work. */
export const STRONG_OUTCOME_WORDS: ReadonlySet<string> = new Set([
  "succeeded", "failed", "rejected", "retried", "declined",
]);
/** Domain verbs that double as outcome words. They only count as outcome words when the rest
 *  of the name matches a sibling exactly, and never make a group on their own: `Order
 *  Cancelled` beside `Order Completed` is two decisions, not two outcomes of one. */
export const WEAK_OUTCOME_WORDS: ReadonlySet<string> = new Set(["completed", "cancelled", "canceled", "expired"]);
export const OUTCOME_WORDS: ReadonlySet<string> = new Set([...STRONG_OUTCOME_WORDS, ...WEAK_OUTCOME_WORDS]);

/** Outcome verbs and nominals as they appear inside a command name. */
const COMMAND_OUTCOME_TOKENS = new Set([
  "fail", "failure", "retry", "time", "out", "expire", "reject", "decline", "succeed", "record", "mark", "to", "the", "of",
]);

/** Light verb-form normalisation: fulfilled / fulfilment / fulfil share a root, as do
 *  captured / capture. */
function root(word: string): string {
  let w = word;
  for (const suf of ["ization", "ation", "ment", "ed", "ing", "s"]) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      if (suf === "ization") w += "iz";
      break;
    }
  }
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w.replace(/([^aeiou])\1$/, "$1");
}

/** Name tokens (root-normalised) with outcome words and the `timed out` phrase removed. */
function stemTokens(name: string): { tokens: string[]; strong: boolean; weak: boolean } {
  const raw = normalizeName(name).split(" ").filter(Boolean);
  const tokens: string[] = [];
  let strong = false;
  let weak = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "timed" && raw[i + 1] === "out") {
      strong = true;
      i++;
    } else if (STRONG_OUTCOME_WORDS.has(raw[i])) strong = true;
    else if (WEAK_OUTCOME_WORDS.has(raw[i])) weak = true;
    else tokens.push(root(raw[i]));
  }
  return { tokens, strong, weak };
}

const REACTION_KINDS: ReadonlySet<string> = new Set(["automation", "processor", "saga", "translation"]);

interface ReactionSlice {
  index: number;
  reaction: Element;
  command: Element;
  events: Element[];
  feeds: Set<string>;
  context: string;
}

export function shapeDiagnostics(model: NormalizedModel, refs: RefsResult, diags: Diagnostic[]): void {
  const refOf = (id: string): string => refs.refById.get(id)!;

  // --- automation-split-by-outcome ---
  const rs: ReactionSlice[] = [];
  model.slices.forEach((slice, index) => {
    const reaction = slice.elements.find((e) => REACTION_KINDS.has(e.kind) && (e.from?.length ?? 0) > 0);
    const command = slice.elements.find((e) => e.kind === "command");
    const events = slice.elements.filter((e) => e.kind === "event");
    if (!reaction || !command || events.length === 0) return;
    const feeds = new Set<string>();
    for (const src of reaction.from ?? []) {
      const key = normalizeName(src);
      feeds.add(`view:${key}`);
      for (const v of model.byName.get(key)?.filter((e) => e.kind === "view") ?? []) {
        for (const ev of viewSourceNames(model, v)) feeds.add(`event:${normalizeName(ev)}`);
      }
    }
    rs.push({ index, reaction, command, events, feeds, context: events[0].context ?? "" });
  });

    const commandTokens = (c: Element): Set<string> => {
    const out = new Set<string>();
    for (const t of normalizeName(c.name).split(" ")) {
      if (COMMAND_OUTCOME_TOKENS.has(t) || OUTCOME_WORDS.has(t)) continue;
      out.add(root(t));
    }
    return out;
  };
  // Commands share a stem when, minus outcome vocabulary, they overlap on two or more tokens
  // (verb included) or are identical: `Fulfil Order` / `Fail Order Fulfilment`.
  const commandsShareStem = (a: Element, b: Element): boolean => {
    const ta = commandTokens(a);
    const tb = commandTokens(b);
    const shared = [...ta].filter((t) => tb.has(t)).length;
    return shared >= 2 || (shared >= 1 && shared === ta.size && shared === tb.size);
  };
  const siblings = (a: ReactionSlice, b: ReactionSlice): boolean => {
    if (a.context !== b.context) return false;
    if (![...a.feeds].some((f) => b.feeds.has(f))) return false;
    if (!commandsShareStem(a.command, b.command)) return false;
    return a.events.some((ea) =>
      b.events.some((eb) => {
        if (normalizeName(ea.name) === normalizeName(eb.name)) return false;
        const sa = stemTokens(ea.name);
        const sb = stemTokens(eb.name);
        // At least one side carries an unambiguous outcome word; the other may be plain
        // (the success sibling, `Order Fulfilled`) or carry any outcome word.
        return sa.tokens.join(" ") === sb.tokens.join(" ") && (sa.strong || sb.strong);
      }),
    );
  };

  const parent = rs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) if (siblings(rs[i], rs[j])) parent[find(j)] = find(i);
  }
  const groups = new Map<number, ReactionSlice[]>();
  rs.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const eventNames = [...new Set(group.flatMap((g) => g.events.map((e) => e.name)))];
    const sliceNames = group.map((g) => `"${model.slices[g.index].name}"`).join(", ");
    pushDiag(diags, "automation-split-by-outcome", {
      message:
        `slices ${sliceNames} are fed by the same read model and differ only by outcome ` +
        `(${eventNames.join(", ")}); model one Automation slice where ${first.reaction.kind} ` +
        `"${first.reaction.name}" triggers one command recording the outcomes as alternative ` +
        `events (\`event ${eventNames.join(" | ")}\`) instead of one slice per outcome ` +
        `(docs/patterns.md#automation)`,
      line: first.reaction.line,
      refs: [
        ...group.map((g) => refs.sliceKeys[g.index]),
        ...group.flatMap((g) => [refOf(g.reaction.id), refOf(g.command.id)]),
      ],
    });
  }

  // --- retry-slice-of ---
  const commands = model.elements.filter((e) => e.kind === "command");
  for (const cmd of commands) {
    const own = model.slices[cmd.sliceIndex].elements;
    // State Change slices only: no reaction, and this is the slice's sole command.
    if (own.some((e) => AUTOMATION_KINDS.has(e.kind)) || own.filter((e) => e.kind === "command").length !== 1) continue;
    const toks = normalizeName(cmd.name).split(" ");
    if (toks[0] !== "retry" || toks.length < 2) continue;
    const rest = toks.slice(1).join(" ");
    const target = commands.find((c) => c.sliceIndex !== cmd.sliceIndex && normalizeName(c.name) === rest);
    if (!target) continue;
    pushDiag(diags, "retry-slice-of", {
      message:
        `command "${cmd.name}" (slice ${cmd.sliceIndex + 1}) only retries command "${target.name}"; ` +
        `a retry is the same command issued again — model it as another trigger of "${target.name}", ` +
        `not a slice of its own (docs/patterns.md#automation)`,
      line: cmd.line,
      refs: [refOf(cmd.id), refOf(target.id)],
    });
  }

  // --- view-lookup-source (GH #398) ---
  // A view's FIRST source is the one that creates the row this view shows — the generation rule
  // (shared/reference/methodology.md, "views-as-lookups") says every other source should only be
  // read when it changes that same row. The cheap, advisory signal (false positives expected —
  // that's why this never gates): another source E, read from a different @Context than the
  // first source's, where E is itself the FIRST (row-creating) source of some OTHER view — i.e.
  // E really does create rows, just not this view's. A within-context lookup (the same context as
  // the first source) is invisible to this heuristic on purpose; the generation rule covers it.
  const logicalViews = model.elements.filter((e) => e.kind === "view" && e.logicalId === e.id);
  const contextOf = (eventName: string): string | undefined =>
    model.byName.get(normalizeName(eventName))?.find((e) => e.kind === "event")?.context;
  // Every logical view's own first source, keyed by its normalized name, so a candidate lookup
  // can be checked against every view it genuinely creates rows for.
  const rowCreatingFor = new Map<string, Element[]>();
  for (const v of logicalViews) {
    const first = viewSourceNames(model, v)[0];
    if (first === undefined) continue;
    const key = normalizeName(first);
    rowCreatingFor.set(key, [...(rowCreatingFor.get(key) ?? []), v]);
  }
  for (const v of logicalViews) {
    const sources = viewSourceNames(model, v);
    if (sources.length < 2) continue;
    const firstContext = contextOf(sources[0]);
    if (firstContext === undefined) continue;
    for (const src of sources.slice(1)) {
      const srcContext = contextOf(src);
      if (srcContext === undefined || srcContext === firstContext) continue;
      const rowCreators = (rowCreatingFor.get(normalizeName(src)) ?? []).filter((rv) => rv.id !== v.id);
      if (rowCreators.length === 0) continue;
      const srcEvent = model.byName.get(normalizeName(src))?.find((e) => e.kind === "event");
      if (!srcEvent) continue;
      pushDiag(diags, "view-lookup-source", {
        message:
          `view "${v.name}" reads "${src}" (@${srcContext}) only to fill a column onto the row "${sources[0]}" ` +
          `(@${firstContext}) creates here; "${src}" is itself the row-creating source of ` +
          `${rowCreators.map((rv) => `"${rv.name}"`).join(", ")} — carry the field on the event that creates ` +
          `"${v.name}"'s own row instead, or accept a genuine cross-context row change on the shape exit gate ` +
          `(docs/patterns.md#state-view)`,
        line: v.line,
        refs: [refOf(v.id), refOf(srcEvent.id), ...rowCreators.map((rv) => refOf(rv.id))],
      });
    }
  }

  // --- storyline-reads-without-after (GH #420) ---
  // A storyline that reads another storyline's events is, in story terms, after it. The canvas
  // (`em render --map`) shows such reads as dashed connectors; this advisory lint asks for the
  // declaration: one finding per (source storyline, reading storyline) pair whose reading side
  // declares no `after` chain reaching the source. A pair related the other way round (the
  // source comes after the reader) is a backward feed the forward-only rules already report, so
  // it is skipped here. Parallel storylines that read nothing from each other stay quiet.
  const crossings = new Map<string, { from: string; to: string; line: number; sources: Element[]; targets: Element[] }>();
  for (const e of semanticEdges(model)) {
    const src = model.byId.get(e.from);
    const dst = model.byId.get(e.to);
    if (!src || !dst) continue;
    const a = storylineOfSlice(model, src.sliceIndex);
    const b = storylineOfSlice(model, dst.sliceIndex);
    if (!a || !b || a === b) continue;
    if (afterChain(model, b).includes(a) || afterChain(model, a).includes(b)) continue;
    const key = `${a.name}\u0000${b.name}`;
    let c = crossings.get(key);
    if (!c) crossings.set(key, (c = { from: a.name, to: b.name, line: b.line, sources: [], targets: [] }));
    if (!c.sources.some((s) => s.id === src.id)) c.sources.push(src);
    if (!c.targets.some((s) => s.id === dst.id)) c.targets.push(dst);
  }
  const ordered = [...crossings.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
  for (const c of ordered) {
    const names = c.sources.map((s) => `"${s.name}"`).join(", ");
    pushDiag(diags, "storyline-reads-without-after", {
      message:
        `storyline "${c.to}" reads ${names} from storyline "${c.from}" but declares no \`after\` reaching it — ` +
        `a story that reads another comes after it: add \`after "${c.from}"\` to storyline "${c.to}" (or to a ` +
        `storyline between them), or keep them parallel on purpose and accept this on the shape exit gate (docs/storyline.md)`,
      line: c.line,
      refs: [...c.sources.map((s) => refOf(s.id)), ...c.targets.map((s) => refOf(s.id))],
    });
  // --- again-restates-sources (GH #424) ---
  // A `view X again` instance names only the events that changed the view since the previous
  // instance. One that restates a source an earlier instance already read — with that event not
  // recorded again between the two instances — draws the same arrow twice and reads as if the
  // view were rebuilt. Field sources are the union across instances (GH #235), so restating is
  // never needed for completeness. Advisory: one finding per instance, naming the restated events.
  const rankOf = (sliceIndex: number): number => composedRank(model, sliceIndex);
  const recordedAt = new Map<string, number[]>(); // normalized event name -> composed ranks of the slices recording it
  for (const el of model.elements) {
    if (el.kind !== "event") continue;
    const k = normalizeName(el.name);
    recordedAt.set(k, [...(recordedAt.get(k) ?? []), rankOf(el.sliceIndex)]);
  }
  const instancesByLogical = new Map<string, Element[]>();
  for (const el of model.elements) {
    if (el.kind !== "view") continue;
    instancesByLogical.set(el.logicalId, [...(instancesByLogical.get(el.logicalId) ?? []), el]);
  }
  for (const instances of instancesByLogical.values()) {
    const ordered = [...instances].sort((x, y) => rankOf(x.sliceIndex) - rankOf(y.sliceIndex));
    for (let i = 1; i < ordered.length; i++) {
      const v = ordered[i];
      if (!v.again || (v.from ?? []).length === 0) continue;
      const prev = ordered[i - 1];
      const lo = rankOf(prev.sliceIndex);
      const hi = rankOf(v.sliceIndex);
      const readBefore = new Set(ordered.slice(0, i).flatMap((x) => (x.from ?? []).map(normalizeName)));
      const restated: string[] = [];
      for (const name of v.from ?? []) {
        const k = normalizeName(name);
        if (!readBefore.has(k)) continue;
        const recordedBetween = (recordedAt.get(k) ?? []).some((r) => r > lo && r <= hi);
        if (!recordedBetween) restated.push(name);
      }
      if (restated.length === 0) continue;
      const events = restated
        .map((n) => model.byName.get(normalizeName(n))?.find((e) => e.kind === "event"))
        .filter((e): e is Element => e !== undefined);
      pushDiag(diags, "again-restates-sources", {
        message:
          `view "${v.name}" again (slice ${v.sliceIndex + 1}) restates ${restated.map((n) => `"${n}"`).join(", ")} — ` +
          `already read by its instance in slice ${prev.sliceIndex + 1}, and not recorded again between them; ` +
          `a continuation names only the events that changed the view since the previous instance (docs/dsl.md#view--again)`,
        line: v.line,
        refs: [refOf(v.id), refOf(prev.id), ...events.map((e) => refOf(e.id))],
      });
    }
  }
}
