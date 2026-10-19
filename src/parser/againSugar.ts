// SPDX-License-Identifier: MIT
// GH #287: continuations without ceremony. Two pure helpers over the parsed slice nodes, shared
// by the parser (auto-naming an unnamed continuation slice) and `normalize` (expanding
// `view X again` written inside a command's own slice into a synthesized continuation column).
// Kept dependency-free of the model layer so the parser can import it.

import { AUTOMATION_KINDS, ElementNode, SliceNode } from "./ast.js";

/** True for a slice whose non-`ui` elements are all `view … again` instances (at least one) —
 *  the AST-level twin of `model/continuation.ts`'s `continuationOf` shape check. */
export function isContinuationShaped(elements: ElementNode[]): boolean {
  const nonUi = elements.filter((el) => el.kind !== "ui");
  return nonUi.length > 0 && nonUi.every((el) => el.kind === "view" && el.again === true);
}

/** The auto-name of a continuation slice: `"<View> View: <Event>"` (several events joined with
 *  ", "; no `from` gives just `"<View> View"`). A slice stacking several `again` views joins
 *  each view's name with " + "; more than two collapse to `"<n> views after <Event>"`. Derived from view + event only, so it is stable under edits
 *  elsewhere in the model. */
export function autoContinuationName(elements: ElementNode[]): string {
  const views = elements.filter((el) => el.kind === "view" && el.again === true);
  if (views.length > 2) {
    // Too many names for a column header: "<n> views after <Event>[, <Event>…]".
    const events = [...new Set(views.flatMap((v) => v.from ?? []))].join(", ");
    return events ? `${views.length} views after ${events}` : `${views.length} views`;
  }
  return views
    .map((v) => {
      const events = (v.from ?? []).join(", ");
      return events ? `${v.name} View: ${events}` : `${v.name} View`;
    })
    .join(" + ");
}

const norm = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

/** A slice node plus, for a synthesized continuation, the index (in the EXPANDED list) of the
 *  slice it was written inside. */
export interface ExpandedSliceNode extends SliceNode {
  synthesizedFrom?: number;
}

/**
 * The `view X again` lines of an ordinary slice that the shorthand lifts out (GH #287), or `[]`
 * when nothing lifts. A line lifts when the slice holds a `command` (or a view) its api cell
 * would otherwise collide with, and it is not a reaction's INPUT: a line a reaction in the same
 * slice reads (`processor … from "View"`) stays in place unless it is fed by an event this slice
 * records (then it is the follow-on update of that view, the to-do-list feedback loop, and lifts).
 * A slice that is already a continuation never lifts (its lines stack in place).
 */
export function liftedAgainViews(elements: ElementNode[]): ElementNode[] {
  if (isContinuationShaped(elements)) return [];
  const read = new Set(elements.filter((el) => AUTOMATION_KINDS.has(el.kind)).flatMap((el) => (el.from ?? []).map(norm)));
  const recorded = new Set(elements.filter((el) => el.kind === "event").map((el) => norm(el.name)));
  const lifted = elements.filter(
    (el) =>
      el.kind === "view" &&
      el.again === true &&
      (!read.has(norm(el.name)) || (el.from ?? []).some((f) => recorded.has(norm(f)))),
  );
  if (lifted.length === 0) return [];
  // Only where the lifted lines would share the api cell: any other host (e.g. an event-only
  // webhook slice) was valid before and keeps its shape.
  const rest = elements.filter((el) => !lifted.includes(el));
  return rest.some((el) => el.kind === "command" || el.kind === "view") ? lifted : [];
}

/**
 * Expands the lifted `view X again` lines of each slice into ONE synthesized continuation slice
 * placed immediately after it, the views stacked in its api cell. The synthesized slice's
 * consumer `ui` is each distinct `shown on "Screen"` named on a line, else a copy of the host
 * slice's first `ui` (same name, same persona).
 */
export function expandAgainSugar(slices: SliceNode[]): ExpandedSliceNode[] {
  // A `shown on` screen takes its persona from its own declaration elsewhere in the model (the
  // parser has already checked one exists).
  const declared = new Map<string, ElementNode>();
  for (const sl of slices)
    for (const el of sl.elements) if (el.kind === "ui" && !declared.has(el.name)) declared.set(el.name, el);

  const out: ExpandedSliceNode[] = [];
  for (const slice of slices) {
    const lifted = liftedAgainViews(slice.elements);
    if (lifted.length === 0) {
      out.push({ ...slice });
      continue;
    }
    const hostElements = slice.elements.filter((el) => !lifted.includes(el));
    const hostIndex = out.length;
    out.push({ ...slice, elements: hostElements });
    const hostUi = hostElements.find((el) => el.kind === "ui");
    const elements: ElementNode[] = [];
    const uis = new Map<string, ElementNode>();
    for (const { shownOn, ...v } of lifted) {
      // Per line: its own `shown on` screen, else the host slice's ui (never another line's screen).
      const uiName = shownOn ?? hostUi?.name;
      if (uiName !== undefined) {
        v.consumer = uiName;
        if (!uis.has(uiName)) {
          const src = shownOn !== undefined ? declared.get(uiName) : hostUi;
          uis.set(uiName, { kind: "ui", name: uiName, persona: src?.persona, line: v.line });
        }
      }
      elements.push(v);
    }
    elements.push(...uis.values());
    out.push({
      name: autoContinuationName(elements),
      storyline: slice.storyline,
      elements,
      line: lifted[0].line,
      synthesizedFrom: hostIndex,
    });
  }
  return out;
}
