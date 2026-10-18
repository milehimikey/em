// SPDX-License-Identifier: MIT
// Renders ONE storyline alone (`em render --storyline <name>`, GH #277): a subset of the
// normal timeline's columns, not a redrawn pattern shape (that is `--slice`).
//
// The columns are the storyline's own slices, in order, preceded by dimmed STUB columns: every
// element a slice of the storyline reads from outside it (so each arrow still has a source), and
// for a storyline declared `after "<other>"` the referenced storyline's end state — the latest
// earlier instance of each read model the storyline continues with `again`. A stub column holds
// only the referenced elements of its origin slice, never the whole slice, so the picture can
// never balloon into the rest of the model. Like render/sliceDiagram.ts this builds a small
// synthetic NormalizedModel from shallow clones of the real Elements (same ids, fields, notes)
// and runs it through the unmodified layout()/emitDot()/composeSvg() pipeline.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Element, NormalizedModel, Slice, Storyline, normalizeName } from "../model/model.js";
import { semanticEdges } from "../model/edges.js";
import { afterChain, findStoryline, latestOnTimeline } from "../model/storylines.js";
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
  const own = [...storyline.sliceIndexes].sort((a, b) => a - b);
  const ownSet = new Set(own);
  const stubs = collectStubs(model, storyline, ownSet);

  // Left to right: stubs from the storylines this one comes after (root first), then any other
  // outside source in file order, then the storyline's own slices.
  const chain = afterChain(model, storyline);
  const chainPos = (sliceIndex: number): number => {
    const name = model.slices[sliceIndex].storyline;
    const pos = chain.findIndex((s) => s.name === name);
    return pos; // -1 for a source outside the `after` chain
  };
  // Stubs from the storylines this one comes `after` (their end state) sit on the left, root
  // first. Every other stub keeps its timeline position: a slice between two blocks of this
  // storyline is interleaved with the storyline's own columns in file order, so no arrow in the
  // subset points right-to-left.
  const leftStubs = [...stubs.keys()].filter((i) => chainPos(i) >= 0).sort((a, b) => chainPos(a) - chainPos(b) || a - b);
  const inlineStubs = [...stubs.keys()].filter((i) => chainPos(i) < 0);
  const inline = [
    ...own.map((i) => ({ i, stub: false })),
    ...inlineStubs.map((i) => ({ i, stub: true })),
  ].sort((a, b) => a.i - b.i);

  const slices: Slice[] = [];
  const elements: Element[] = [];
  const byId = new Map<string, Element>();
  const byName = new Map<string, Element[]>();
  const addColumn = (origin: Slice, els: Element[], isStub: boolean): void => {
    const index = slices.length;
    const cloned = els.map((el): Element => ({ ...el, sliceIndex: index }));
    slices.push({
      name: origin.name,
      index,
      source: origin.source,
      storyline: isStub ? undefined : storyline.name,
      stub: isStub || undefined,
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
  };
  for (const i of leftStubs) addColumn(model.slices[i], [...stubs.get(i)!.values()], true);
  for (const { i, stub } of inline) {
    addColumn(model.slices[i], stub ? [...stubs.get(i)!.values()] : model.slices[i].elements, stub);
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
        sliceIndexes: slices.filter((s) => !s.stub).map((s) => s.index),
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

/** origin slice index -> the elements of that slice the storyline needs as stubs. */
function collectStubs(model: NormalizedModel, storyline: Storyline, ownSet: Set<number>): Map<number, Map<string, Element>> {
  const stubs = new Map<number, Map<string, Element>>();
  const add = (el: Element | undefined): void => {
    if (!el || ownSet.has(el.sliceIndex)) return;
    let bucket = stubs.get(el.sliceIndex);
    if (!bucket) stubs.set(el.sliceIndex, (bucket = new Map()));
    bucket.set(el.id, el);
  };
  for (const edge of semanticEdges(model)) {
    const from = model.byId.get(edge.from);
    const to = model.byId.get(edge.to);
    if (!from || !to) continue;
    if (edge.source === "loops-to") {
      if (ownSet.has(from.sliceIndex)) add(to); // the earlier view a loop re-feeds
    } else if (ownSet.has(to.sliceIndex)) {
      add(from); // something the storyline reads
    }
  }
  // The referenced storyline's end state: the latest earlier instance of every read model this
  // storyline continues with `again`.
  for (const i of storyline.sliceIndexes) {
    for (const el of model.slices[i].elements) {
      if (el.kind !== "view" || !el.again) continue;
      const earlier = model.elements.filter((x) => x.kind === "view" && x.logicalId === el.logicalId && x.id !== el.id);
      add(latestOnTimeline(model, earlier, el.sliceIndex, true));
    }
  }
  return stubs;
}
