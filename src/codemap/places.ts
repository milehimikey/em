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
//          (`from "View"`): it takes the PLACE of what it reads, override and all — a reaction
//          lives with its trigger (`placedBy: "reads"`);
//        - a command, or a reaction fed from outside the model (no `from`): the contexts of
//          the events declared in its own slice — the facts it records.
//      So in an Automation slice the processor follows the to-do list it watches and the command
//      follows the event it records, and the two may land in different repositories.
//      When those contexts all route to one place, that is the element's place. When they route
//      to different places, the model does not say which, and the element is left unplaced with
//      a reason: an `elements:` override settles it. em never picks one.
//   4. The default: the map's `default:`, else the caller's fallback places — the state file's
//      `Code roots:`, each a place in `self` (GH #530, codeRoots.ts).
//
// A later instance (`view X again`, a bare repeat of an event) is the same read model or the
// same fact, so it lives where its first instance lives.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Element, NormalizedModel, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { CodeMap, formatPlace, Place, samePlace } from "./codeMap.js";

/** Which rule placed an element. `null` when nothing did. */
export type PlacedBy = "element" | "persona" | "context" | "reads" | "default" | "code-roots";

export interface ElementPlacement {
  /** The element's export ref. */
  ref: string;
  /** Where the element lives. One place from any code-map rule; one per code root when the
   *  state file's `Code roots:` placed it (it may declare several); `[]` when unplaced. */
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
 * does and the map has no `default:`: the state file's `Code roots:` as places
 * (`codeRootPlaces`), reported as `placedBy: "code-roots"`; `[]` for none.
 */
export function derivePlaces(model: NormalizedModel, refs: RefsResult, map: CodeMap, fallback: Place[] = []): ModelPlacement {
  const personaPlace = new Map(map.personas.map((r) => [r.key, r.place]));
  const contextPlace = new Map(map.contexts.map((r) => [r.key, r.place]));
  const elementPlace = new Map(map.elements.map((r) => [r.key, r.place]));
  const refOf = (el: Element): string => refs.refById.get(el.id)!;

  const defaults: { places: Place[]; by: PlacedBy } | null = map.default
    ? { places: [map.default.place], by: "default" }
    : fallback.length > 0
      ? { places: dedupePlaces(fallback), by: "code-roots" }
      : null;

  const eventContexts = (events: Element[]): string[] => {
    const out: string[] = [];
    for (const e of events) if (e.context !== undefined && !out.includes(e.context)) out.push(e.context);
    return out;
  };

  /** The element a `from "Name"` names: its first declaration of one of `kinds`, same as every
   *  other `from` in em — and then that element's first instance on the timeline, so a name
   *  that resolves to a later `again` instance still means the read model itself. */
  const named = (name: string, kinds: readonly Element["kind"][]): Element | undefined => {
    const first = (model.byName.get(normalizeName(name)) ?? []).find((c) => kinds.includes(c.kind));
    return first === undefined ? undefined : model.byId.get(first.logicalId) ?? first;
  };

  /** The contexts a non-ui element routes by (rule 3); a reaction that reads something is
   *  handled before this is asked. */
  const contextsOf = (el: Element): string[] => {
    if (el.kind === "event") return el.context === undefined ? [] : [el.context];
    if (el.kind === "view") {
      return eventContexts((el.from ?? []).map((n) => named(n, ["event"])).filter((e): e is Element => e !== undefined));
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

    // A reaction that reads something lives where what it reads lives — its place, override
    // included, not merely its contexts.
    if (AUTOMATION_KINDS.has(el.kind) && (el.from?.length ?? 0) > 0) {
      const sources = (el.from ?? []).map((n) => named(n, ["view", "event"])).filter((e): e is Element => e !== undefined && e !== el);
      if (sources.length > 0) {
        const placed = sources.map((src) => ({ src, at: placeOne(src) }));
        const first = placed[0].at.places;
        if (first.length > 0 && placed.every((p) => samePlaces(p.at.places, first))) {
          return { places: first, placedBy: "reads", unplacedReason: null };
        }
        const detail = placed
          .map((p) => `${p.src.kind} "${p.src.name}" -> ${p.at.places.length > 0 ? p.at.places.map(formatPlace).join(", ") : "no place"}`)
          .join("; ");
        const why = placed.some((p) => p.at.places.length === 0) ? "what it reads has no place" : "what it reads lives in different places";
        return { places: [], placedBy: null, unplacedReason: `${why} (${detail})` };
      }
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
        const what = el.kind === "view" ? "the events it reads" : "the events in its slice";
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
