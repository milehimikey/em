// SPDX-License-Identifier: MIT
// Computes the "generated" slice-doc frontmatter fields (docs/1.0.0-spec.md §2.2)
// from the .em model. Shared by validateSliceDocs.ts (drift detection) and the
// future `em slice sync` (Phase C) so there's exactly one definition of
// "what these fields should be" — never duplicated between check and write.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { NormalizedModel } from "./model.js";
import { SliceDoc } from "./sliceDoc.js";

export interface DerivedSliceFields {
  commands: string[];
  events: string[];
  readModels: string[];
  contexts: string[];
  personas: string[];
  triggers?: string;
  triggeredBy?: string;
}

/**
 * Derive the generated fields for the slice that `sliceElementId` belongs to.
 * `docIdByElementId` maps every *other* slice doc's linked element id to that
 * doc's frontmatter `id`, so `triggers`/`triggeredBy` (the automation/translation
 * two-slice split) can be resolved without a second .em pass per doc. Returns
 * null if `sliceElementId` doesn't resolve to a real element.
 */
export function deriveGeneratedFields(
  model: NormalizedModel,
  sliceElementId: string,
  docIdByElementId: ReadonlyMap<string, string>,
): DerivedSliceFields | null {
  const element = model.byId.get(sliceElementId);
  if (!element) return null;

  const slice = model.slices[element.sliceIndex];
  const commands = slice.elements.filter((e) => e.kind === "command").map((e) => e.name);
  const events = slice.elements.filter((e) => e.kind === "event").map((e) => e.name);
  const readModels = slice.elements.filter((e) => e.kind === "view").map((e) => e.name);
  const contexts = dedupe(
    slice.elements.filter((e) => e.kind === "event" && e.context).map((e) => e.context!),
  );
  const personas = dedupe(
    slice.elements.filter((e) => e.kind === "ui" && e.persona).map((e) => e.persona!),
  );

  const fields: DerivedSliceFields = { commands, events, readModels, contexts, personas };

  const isReaction = slice.elements.some((e) => AUTOMATION_KINDS.has(e.kind));
  if (isReaction) {
    const nextSlice = model.slices[slice.index + 1];
    const triggeredCommand = nextSlice?.elements.find((e) => e.kind === "command");
    const triggeredDocId = triggeredCommand && docIdByElementId.get(triggeredCommand.id);
    if (triggeredDocId) fields.triggers = triggeredDocId;
  } else if (commands.length > 0) {
    const prevSlice = model.slices[slice.index - 1];
    const reaction = prevSlice?.elements.find((e) => AUTOMATION_KINDS.has(e.kind));
    const triggeringDocId = reaction && docIdByElementId.get(reaction.id);
    if (triggeringDocId) fields.triggeredBy = triggeringDocId;
  }

  return fields;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Map every doc's linked .em element id -> that doc's frontmatter `id`, skipping unusable docs. */
export function buildDocIdByElementId(
  model: NormalizedModel,
  docs: readonly SliceDoc[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const doc of docs) {
    const data = doc.frontmatter;
    if (!data) continue;
    const id = data.id;
    const sliceElement = data.sliceElement;
    if (typeof id === "string" && typeof sliceElement === "string" && model.byId.has(sliceElement)) {
      index.set(sliceElement, id);
    }
  }
  return index;
}
