// SPDX-License-Identifier: MIT
// GH #527: derive where each element of a model lives from a parsed code map. Pure: no
// filesystem, no git. The routing comes from what the model already says:
//
//   1. An `elements:` override for the element (or, for a later instance of a view or event,
//      for the instance it repeats).
//   2. A `ui` routes by its `@Persona` (`personas:`).
//   3. Everything else routes by context (`contexts:`). Only an event carries a context in the
//      DSL (`@Context` is valid on `event` alone), so the others borrow one:
//        - an event: its own context;
//        - a view: the contexts of the events it reads (`from`);
//        - an automation-band element (processor, translation, …) that reads something
//          (`from "View"`): the contexts of what it reads — a reaction lives with its trigger;
//        - a command, or a reaction fed from outside the model (no `from`): the contexts of
//          the events declared in its own slice — the facts it records.
//      So in an Automation slice the processor follows the to-do list it watches and the command
//      follows the event it records, and the two may land in different repositories.
//      When those contexts all route to one place, that is the element's place. When they route
//      to different places, the model does not say which, and the element is left unplaced with
//      a reason: an `elements:` override settles it. em never picks one.
//   4. The default: the map's `default:`, else the caller's fallback places.
//
// A later instance (`view X again`, a bare repeat of an event) is the same read model or the
// same fact, so it lives where its first instance lives.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Element, NormalizedModel, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { CodeMap, formatPlace, Place, samePlace } from "./codeMap.js";

/** Which rule placed an element. `null` when nothing did. */
export type PlacedBy = "element" | "persona" | "context" | "default" | "fallback";

export interface ElementPlacement {
  /** The element's export ref. */
  ref: string;
  /** Where the element lives. One place from any code-map rule; possibly several from the
   *  caller's fallback (a state file may declare several code roots); `[]` when unplaced. */
  places: Place[];
  placedBy: PlacedBy | null;
  /** Set exactly when `places` is empty: why nothing placed it, as a sentence fragment. */
  unplacedReason: string | null;
}

export interface ModelPlacement {
  /** One entry per element, in `model.elements` order. */
  elements: ElementPlacement[];
  byRef: Map<string, ElementPlacement>;
}

function dedupePlaces(places: Place[]): Place[] {
  const out: Place[] = [];
  for (const p of places) if (!out.some((q) => samePlace(p, q))) out.push(p);
  return out;
}

function samePlaces(a: Place[], b: Place[]): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => samePlace(p, q)));
}

/**
 * Place every element of `model`. `fallback` is what places an element when no rule in the map
 * does and the map has no `default:` — the caller's own default (GH #530 feeds the state file's
 * `Code roots:` here); `[]` for none.
 */
export function derivePlaces(model: NormalizedModel, refs: RefsResult, map: CodeMap, fallback: Place[] = []): ModelPlacement {
  const personaPlace = new Map(map.personas.map((r) => [r.key, r.place]));
  const contextPlace = new Map(map.contexts.map((r) => [r.key, r.place]));
  const elementPlace = new Map(map.elements.map((r) => [r.key, r.place]));
  const refOf = (el: Element): string => refs.refById.get(el.id)!;

  const defaults: { places: Place[]; by: PlacedBy } | null = map.default
    ? { places: [map.default.place], by: "default" }
    : fallback.length > 0
      ? { places: dedupePlaces(fallback), by: "fallback" }
      : null;

  const eventContexts = (events: Element[]): string[] => {
    const out: string[] = [];
    for (const e of events) if (e.context !== undefined && !out.includes(e.context)) out.push(e.context);
    return out;
  };

  /** The contexts of the events a view reads. */
  const viewContexts = (view: Element): string[] => {
    const sources: Element[] = [];
    for (const name of view.from ?? []) {
      for (const candidate of model.byName.get(normalizeName(name)) ?? []) {
        if (candidate.kind === "event") sources.push(candidate);
      }
    }
    return eventContexts(sources);
  };

  /** The contexts a non-ui element routes by (rule 3). */
  const contextsOf = (el: Element): string[] => {
    if (el.kind === "event") return el.context === undefined ? [] : [el.context];
    if (el.kind === "view") return viewContexts(el);
    if (AUTOMATION_KINDS.has(el.kind) && (el.from?.length ?? 0) > 0) {
      const out: string[] = [];
      const add = (c: string): void => {
        if (!out.includes(c)) out.push(c);
      };
      for (const name of el.from ?? []) {
        // A name resolves to its first declaration, same as every other `from` in em.
        const first = (model.byName.get(normalizeName(name)) ?? []).find((c) => c.kind === "view" || c.kind === "event");
        if (first?.kind === "event" && first.context !== undefined) add(first.context);
        else if (first?.kind === "view") viewContexts(first).forEach(add);
      }
      return out;
    }
    return eventContexts(model.slices[el.sliceIndex].elements.filter((e) => e.kind === "event"));
  };

  const placeOne = (el: Element): Omit<ElementPlacement, "ref"> => {
    const own = elementPlace.get(refOf(el));
    if (own) return { places: [own], placedBy: "element", unplacedReason: null };
    if (el.logicalId !== el.id) {
      const first = model.byId.get(el.logicalId);
      if (first) return placeOne(first);
    }

    if (el.kind === "ui") {
      const byPersona = el.persona === undefined ? undefined : personaPlace.get(el.persona);
      if (byPersona) return { places: [byPersona], placedBy: "persona", unplacedReason: null };
    } else {
      const contexts = contextsOf(el);
      if (contexts.some((c) => contextPlace.has(c))) {
        // Each context routes to its mapped place, or to the default when it has none.
        const routed = contexts.map((c) => ({ context: c, places: contextPlace.has(c) ? [contextPlace.get(c)!] : defaults?.places ?? [] }));
        const first = routed[0].places;
        if (first.length > 0 && routed.every((r) => samePlaces(r.places, first))) {
          return { places: first, placedBy: "context", unplacedReason: null };
        }
        const detail = routed
          .map((r) => `${r.context} -> ${r.places.length > 0 ? r.places.map(formatPlace).join(", ") : "no place"}`)
          .join("; ");
        const what =
          el.kind === "view" ? "the events it reads" : AUTOMATION_KINDS.has(el.kind) && (el.from?.length ?? 0) > 0 ? "what it reads" : "the events in its slice";
        return { places: [], placedBy: null, unplacedReason: `${what} sit in contexts that route to different places (${detail})` };
      }
    }

    if (defaults) return { places: defaults.places, placedBy: defaults.by, unplacedReason: null };
    const tried =
      el.kind === "ui"
        ? el.persona === undefined
          ? "it has no persona"
          : `no \`personas:\` entry for "${el.persona}"`
        : "no `contexts:` entry covers it";
    return { places: [], placedBy: null, unplacedReason: `${tried}, and the code map has no \`default:\`` };
  };

  const elements = model.elements.map((el) => ({ ref: refOf(el), ...placeOne(el) }));
  return { elements, byRef: new Map(elements.map((e) => [e.ref, e])) };
}

/** The places a slice's elements live in, each once, in first-appearance order. */
export function slicePlaces(model: NormalizedModel, refs: RefsResult, placement: ModelPlacement, sliceIndex: number): Place[] {
  const all: Place[] = [];
  for (const el of model.slices[sliceIndex].elements) all.push(...(placement.byRef.get(refs.refById.get(el.id)!)?.places ?? []));
  return dedupePlaces(all);
}
