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
}
