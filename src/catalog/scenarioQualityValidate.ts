// SPDX-License-Identifier: MIT
// Scenario-quality advisories (GH #293, was MIL-244): three deterministic warnings over a bound
// slice doc's authored `### Scenario:` blocks (catalog/scenarios.ts), checked against the `.em`
// model. Called from validateDocModelConsistency's per-doc loop, so a MIL-121 cross-covered doc is
// checked once against the UNION of its covered slices. Canon: Dymitruk, "each specification is
// tied to exactly one command or view"; Dilger's GWT shape (Given events / When command / Then
// events or error).
//
//   scenario-when-not-command     a scenario's When names none of the slice's commands (for a
//                                 reaction slice: the triggered command — it is the slice's command).
//   scenario-then-not-outcome     Then names neither one of the slice's events (any alternative or
//                                 shared event counts) nor a rejection/error phrase.
//   invariant-without-scenario    an INV-* declared for the slice (model `invariant` line or the
//                                 doc's Invariants section) is cited by no scenario. Convention:
//                                 a scenario cites the INV ids it exercises, anywhere in its block.
//
// Silent by construction on a doc with no `### Scenario:` blocks (every 1.13 free-prose doc) and,
// for the first two, on a slice with no command (a State View slice has no When). Names compare
// with case, spacing and punctuation stripped, so `OrderPlaced` matches the event "Order Placed".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectModelInvariants, Element, NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { extractInvariantIds, INV_TOKEN_RE } from "../cli/coverage.js";
import { parseScenarios, Scenario } from "./scenarios.js";

const REJECTION_RE =
  /\b(reject\w*|refus\w*|den(?:y|ies|ied)|errors?|fail(?:s|ed|ure)?|invalid|not allowed|forbidden|exceptions?|unauthori[sz]ed|violat\w*|no events?|nothing is (?:recorded|emitted))\b/i;

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function names(els: Element[]): string[] {
  return els.map((e) => squash(e.name)).filter((n) => n !== "");
}

function mentionsAny(text: string, squashedNames: string[]): boolean {
  const t = squash(text);
  return squashedNames.some((n) => t.includes(n));
}

/** 1-based doc-file line of each scenario's heading, or null when it can't be located. */
function scenarioLines(baseDir: string, docPath: string, scenarios: Scenario[]): Map<Scenario, number | null> {
  const out = new Map<Scenario, number | null>();
  let lines: string[] = [];
  try {
    lines = readFileSync(join(baseDir, docPath), "utf8").split(/\r?\n/);
  } catch {
    // unreadable: lines stay null
  }
  let from = 0;
  for (const s of scenarios) {
    let found: number | null = null;
    for (let i = from; i < lines.length; i++) {
      const m = /^###\s+Scenario:\s*(.*?)\s*$/.exec(lines[i]);
      if (m && m[1] === s.title) {
        found = i + 1;
        from = i + 1;
        break;
      }
    }
    out.set(s, found);
  }
  return out;
}

export function checkScenarioQuality(
  diags: Diagnostic[],
  body: string,
  docPath: string,
  sliceIndices: number[],
  ownerKey: string,
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
): void {
  const { scenarios } = parseScenarios(body);
  if (scenarios.length === 0) return;

  const els: Element[] = [];
  for (const i of sliceIndices) els.push(...model.slices[i].elements);
  const commands = els.filter((e) => e.kind === "command");
  const events = els.filter((e) => e.kind === "event");
  const cmdNames = names(commands);
  const evtNames = names(events);
  const where = scenarioLines(baseDir, docPath, scenarios);
  const at = (s: Scenario): string => {
    const l = where.get(s);
    return `${docPath}${l ? `:${l}` : ""} scenario "${s.title}"`;
  };

  if (commands.length > 0) {
    const anchor = commands[0];
    const modelRefs = [refs.sliceKeys[anchor.sliceIndex], refs.refById.get(anchor.id)!];
    const cmdList = commands.map((c) => `"${c.name}"`).join(", ");
    for (const s of scenarios) {
      if (!s.when.some((w) => mentionsAny(w, cmdNames))) {
        pushDiag(diags, "scenario-when-not-command", {
          message: `${at(s)}: When does not name the slice's command (${cmdList}) — a scenario is tied to exactly one command`,
          line: anchor.line,
          refs: modelRefs,
        });
      }
      if (!s.then.some((t) => mentionsAny(t, evtNames) || REJECTION_RE.test(t))) {
        const evtList = events.length > 0 ? events.map((e) => `"${e.name}"`).join(", ") : "none declared";
        pushDiag(diags, "scenario-then-not-outcome", {
          message: `${at(s)}: Then names none of the slice's events (${evtList}) and no rejection/error — state the event(s) recorded, or the rejection`,
          line: anchor.line,
          refs: modelRefs,
        });
      }
    }
  }

  // Declared for the slice: model `invariant` lines on its elements, plus the doc's own section.
  const cited = new Set<string>();
  for (const s of scenarios) {
    for (const text of [s.title, ...s.given, ...s.when, ...s.then]) for (const m of text.matchAll(INV_TOKEN_RE)) cited.add(m[0]);
  }
  const reported = new Set<string>();
  const elIds = new Set(els.map((e) => e.id));
  for (const inv of collectModelInvariants(model)) {
    if (!elIds.has(inv.element.id) || cited.has(inv.id) || reported.has(inv.id)) continue;
    reported.add(inv.id);
    pushDiag(diags, "invariant-without-scenario", {
      message: `invariant ${inv.id} (${inv.element.kind} "${inv.element.name}") is cited by no scenario in ${docPath} — cite the INV id in the scenario that exercises it`,
      line: inv.line,
      refs: [refs.sliceKeys[inv.element.sliceIndex], refs.refById.get(inv.element.id)!],
    });
  }
  const ownerSlice = model.slices[sliceIndices.find((i) => refs.sliceKeys[i] === ownerKey) ?? sliceIndices[0]];
  for (const id of extractInvariantIds(body)) {
    if (cited.has(id) || reported.has(id)) continue;
    reported.add(id);
    pushDiag(diags, "invariant-without-scenario", {
      message: `invariant ${id} (declared in ${docPath}) is cited by no scenario — cite the INV id in the scenario that exercises it`,
      line: ownerSlice.line,
      refs: [ownerKey],
    });
  }
}
