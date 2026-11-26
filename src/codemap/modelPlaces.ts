// SPDX-License-Identifier: MIT
// GH #529: one model's derived places, for the surfaces that publish them (`em export`,
// `em query`). The single entry point both call, so the two cannot disagree: read the code map
// beside the model (codeMapValidate.ts's `loadCodeMap`), derive every element's place
// (places.ts). `none` for a model with no code map of its own — the caller then publishes
// nothing, so a project whose model and code share one repository gets byte-identical output.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { CodeMap, Place, samePlace } from "./codeMap.js";
import { loadCodeMap } from "./codeMapValidate.js";
import { derivePlaces, ModelPlacement, slicePlaces } from "./places.js";

export type ModelPlaces =
  | { kind: "none" }
  /** `code-map.yaml` exists and is this model's, but cannot be read or parsed. */
  | { kind: "invalid"; diagnostics: Diagnostic[] }
  | {
      kind: "ok";
      map: CodeMap;
      placement: ModelPlacement;
      /** Places per slice, same order/index as `model.slices`. */
      bySlice: Place[][];
      /** Every place the model's elements live in, each once, in first-appearance order. */
      all: Place[];
    };

export function loadModelPlaces(modelFile: string, model: NormalizedModel, refs: RefsResult): ModelPlaces {
  const loaded = loadCodeMap(modelFile);
  if (loaded.kind === "none") return { kind: "none" };
  if (loaded.kind === "invalid") return { kind: "invalid", diagnostics: loaded.diagnostics };
  const placement = derivePlaces(model, refs, loaded.map);
  const bySlice = model.slices.map((_, i) => slicePlaces(model, refs, placement, i));
  const all: Place[] = [];
  for (const places of bySlice) for (const p of places) if (!all.some((q) => samePlace(p, q))) all.push(p);
  return { kind: "ok", map: loaded.map, placement, bySlice, all };
}
