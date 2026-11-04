// SPDX-License-Identifier: MIT
// Renders ONE storyline alone (`em render --storyline <name>`, GH #277): a subset of the
// normal timeline's columns, not a redrawn pattern shape (that is `--slice`).
//
// The columns are the storyline's own slices and nothing else (owner ruling 2026-11-03: a
// storyline render shows only what is in the storyline — no dimmed "stub" columns borrowed from
// the slices it reads from outside). An element the storyline reads from another storyline has
// no box here, so its arrow is not drawn; the storyline map carries that flow between stories.
// Like render/sliceDiagram.ts this builds a small synthetic NormalizedModel from shallow clones
// of the real Elements (same ids, fields, notes) and runs it through the unmodified
// layout()/emitDot()/composeSvg() pipeline.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Element, NormalizedModel, Slice, Storyline, normalizeName } from "../model/model.js";
import { findStoryline, composedRank } from "../model/storylines.js";
import { Grid, LayoutOptions, layout } from "../layout/grid.js";
import { emitDot } from "../emit/dot.js";

export interface StorylineDiagramResult {
  model: NormalizedModel;
  grid: Grid;
  dot: string;
}

/** The storyline named `name`, or an error message naming the available ones. */
export function resolveStorylineArg(
  model: NormalizedModel,
  name: string,
): { storyline: Storyline } | { error: string } {
  const storylines = model.storylines ?? [];
  const storyline = findStoryline(model, name);
  if (storyline) return { storyline };
  const known = storylines.map((s) => `"${s.name}"`).join(", ");
  return {
    error:
      storylines.length === 0
        ? `em render --storyline: this model declares no storylines`
        : `em render --storyline: no storyline "${name}" (declared: ${known})`,
  };
}

export function buildStorylineDiagram(
  model: NormalizedModel,
  storyline: Storyline,
  opts: LayoutOptions = {},
): StorylineDiagramResult {
  // Left to right on the composed timeline (model/storylines.ts's relationOnTimeline — the
  // ordering validation uses), file order as the fallback: a storyline's blocks stay in the
  // order the whole model reads them.
  const own = [...storyline.sliceIndexes].sort((a, b) => composedRank(model, a) - composedRank(model, b));

  const slices: Slice[] = [];
  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byName = new Map<string, Element[]>();
  for (const i of own) {
    const origin = model.slices[i];
    const index = slices.length;
    const cloned = origin.elements.map((el): Element => ({ ...el, sliceIndex: index }));
    slices.push({
      name: origin.name,
      index,
      source: origin.source,
      storyline: storyline.name,
      elements: cloned,
      line: origin.line,
    });
    for (const el of cloned) {
      elements.push(el);
      byId.set(el.id, el);
      const key = normalizeName(el.name);
      const bucket = byName.get(key);
      if (bucket) bucket.push(el);
      else byName.set(key, [el]);
    }
  }

  const dedupe = (values: (string | undefined)[]): string[] => [...new Set(values.filter((v): v is string => !!v))];
  const synthetic: NormalizedModel = {
    name: `${model.name} — ${storyline.name}`,
    nameDeclared: true,
    personas: dedupe(elements.filter((e) => e.kind === "ui").map((e) => e.persona)),
    contexts: dedupe(elements.filter((e) => e.kind === "event").map((e) => e.context)),
    hasAutomation: elements.some((e) => AUTOMATION_KINDS.has(e.kind)),
    slices,
    storylines: [
      {
        name: storyline.name,
        source: storyline.source,
        after: storyline.after,
        sliceIndexes: slices.map((s) => s.index),
        line: storyline.line,
      },
    ],
    elements,
    byId,
    byName,
    // As in sliceDiagram: explicit `arrow` statements are dropped from a subset extraction.
    arrows: [],
    types: model.types,
    typesByName: model.typesByName,
  };
  const grid = layout(synthetic, opts);
  return { model: synthetic, grid, dot: emitDot(synthetic, grid) };
}
